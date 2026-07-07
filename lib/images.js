// Pure-JS image pipeline (jpeg-js). At upload time we bake one JPEG per reveal
// stage: the face box is heavily blurred, and for stages 1/2 the tiles that are
// "cleared" get their original pixels composited back. Clients are only ever
// served the variant for their conversation's current stage, so the real face
// cannot be scraped before stage 3.
const jpeg = require('jpeg-js');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const GRID = 4; // 4x4 = 16 tiles
const STAGE_CLEAR_COUNTS = [0, 6, 12, 16]; // cumulative cleared tiles per stage

// Heuristic face box for user uploads (fractions of image size).
const DEFAULT_FACE_BOX = { x: 0.18, y: 0.07, w: 0.64, h: 0.56 };

function decodeDataUrl(dataUrl) {
  const m = /^data:image\/jpeg;base64,(.+)$/.exec(dataUrl);
  if (!m) throw new Error('Expected a JPEG data URL');
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length > 4 * 1024 * 1024) throw new Error('Image too large');
  return jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 64 });
}

// Three-pass box blur over a rect of an RGBA buffer ≈ gaussian. Radius scales
// with face size so small images still end up unrecognizable.
function blurRegion(data, imgW, imgH, rx, ry, rw, rh, radius) {
  const passes = 3;
  const x0 = Math.max(0, rx), y0 = Math.max(0, ry);
  const x1 = Math.min(imgW, rx + rw), y1 = Math.min(imgH, ry + rh);
  const w = x1 - x0, h = y1 - y0;
  if (w <= 0 || h <= 0) return;

  const region = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const src = ((y0 + y) * imgW + (x0 + x)) * 4;
      const dst = (y * w + x) * 3;
      region[dst] = data[src]; region[dst + 1] = data[src + 1]; region[dst + 2] = data[src + 2];
    }
  }
  const tmp = new Float32Array(region.length);
  for (let p = 0; p < passes; p++) {
    // horizontal
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let r = 0, g = 0, b = 0, n = 0;
        for (let k = -radius; k <= radius; k++) {
          const xx = Math.min(w - 1, Math.max(0, x + k));
          const i = (y * w + xx) * 3;
          r += region[i]; g += region[i + 1]; b += region[i + 2]; n++;
        }
        const o = (y * w + x) * 3;
        tmp[o] = r / n; tmp[o + 1] = g / n; tmp[o + 2] = b / n;
      }
    }
    // vertical
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let r = 0, g = 0, b = 0, n = 0;
        for (let k = -radius; k <= radius; k++) {
          const yy = Math.min(h - 1, Math.max(0, y + k));
          const i = (yy * w + x) * 3;
          r += tmp[i]; g += tmp[i + 1]; b += tmp[i + 2]; n++;
        }
        const o = (y * w + x) * 3;
        region[o] = r / n; region[o + 1] = g / n; region[o + 2] = b / n;
      }
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dst = ((y0 + y) * imgW + (x0 + x)) * 4;
      const src = (y * w + x) * 3;
      data[dst] = region[src]; data[dst + 1] = region[src + 1]; data[dst + 2] = region[src + 2];
    }
  }
}

function copyRegion(fromData, toData, imgW, imgH, rx, ry, rw, rh) {
  const x0 = Math.max(0, rx), y0 = Math.max(0, ry);
  const x1 = Math.min(imgW, rx + rw), y1 = Math.min(imgH, ry + rh);
  for (let y = y0; y < y1; y++) {
    const rowStart = (y * imgW + x0) * 4;
    const rowEnd = (y * imgW + x1) * 4;
    toData.set(fromData.subarray(rowStart, rowEnd), rowStart);
  }
}

function shuffledTileOrder() {
  const order = Array.from({ length: GRID * GRID }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

function tileRect(faceBoxPx, tileIndex) {
  const col = tileIndex % GRID, row = Math.floor(tileIndex / GRID);
  const tw = faceBoxPx.w / GRID, th = faceBoxPx.h / GRID;
  return {
    x: Math.round(faceBoxPx.x + col * tw),
    y: Math.round(faceBoxPx.y + row * th),
    w: Math.ceil(tw),
    h: Math.ceil(th),
  };
}

function variantPath(photoId, stage) {
  return path.join(UPLOAD_DIR, `photo_${photoId}_s${stage}.jpg`);
}

/**
 * Decode an uploaded JPEG data URL, generate the 4 stage variants and write
 * them to disk. Returns { width, height, faceBox, tileOrder }.
 */
function processUpload(photoId, dataUrl, faceBox = DEFAULT_FACE_BOX) {
  const img = decodeDataUrl(dataUrl);
  const { width, height } = img;
  if (width < 40 || height < 40) throw new Error('Image too small');

  const facePx = {
    x: Math.round(faceBox.x * width),
    y: Math.round(faceBox.y * height),
    w: Math.round(faceBox.w * width),
    h: Math.round(faceBox.h * height),
  };
  const tileOrder = shuffledTileOrder();

  const original = new Uint8Array(img.data); // keep a pristine copy
  const blurred = new Uint8Array(img.data);
  blurRegion(blurred, width, height, facePx.x, facePx.y, facePx.w, facePx.h,
    Math.max(8, Math.round(facePx.w / 9)));

  for (let stage = 0; stage <= 3; stage++) {
    let frame;
    if (stage === 3) {
      frame = original;
    } else {
      frame = new Uint8Array(blurred);
      for (let i = 0; i < STAGE_CLEAR_COUNTS[stage]; i++) {
        const t = tileRect(facePx, tileOrder[i]);
        copyRegion(original, frame, width, height, t.x, t.y, t.w, t.h);
      }
    }
    const encoded = jpeg.encode({ data: Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength), width, height }, 82);
    fs.writeFileSync(variantPath(photoId, stage), encoded.data);
  }

  return { width, height, faceBox, tileOrder };
}

function deletePhotoFiles(photoId) {
  for (let s = 0; s <= 3; s++) {
    try { fs.unlinkSync(variantPath(photoId, s)); } catch {}
  }
}

module.exports = {
  processUpload, variantPath, deletePhotoFiles,
  DEFAULT_FACE_BOX, GRID, STAGE_CLEAR_COUNTS, UPLOAD_DIR,
};
