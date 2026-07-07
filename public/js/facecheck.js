/* UNFOLD — real face detection & validation (client-side, face-api.js).
   Detects the actual face in an uploaded photo so the glass covers ONLY the
   face, and rejects photos with no real human face. This is face *presence +
   geometry* validation (score + 68-landmark sanity), not deepfake/liveness
   detection — that's beyond a browser demo. */

let _loading = null;
let _available = false;

async function loadFaceModels() {
  if (_loading) return _loading;
  _loading = (async () => {
    if (typeof faceapi === 'undefined') { _available = false; return false; }
    try {
      await faceapi.nets.tinyFaceDetector.loadFromUri('/models');
      await faceapi.nets.faceLandmark68Net.loadFromUri('/models');
      _available = true;
    } catch (e) {
      console.warn('[unfold] face models failed to load:', e);
      _available = false;
    }
    return _available;
  })();
  return _loading;
}

function faceDetectionAvailable() { return _available; }

// Returns { ok: true, faceBox } or { ok: false, reason }.
// faceBox is normalized {x,y,w,h} in [0,1], padded to cover hair/forehead/chin.
async function detectFace(imgEl) {
  const ready = await loadFaceModels();
  if (!ready) {
    // Graceful fallback: detector unavailable → accept with a centred box so
    // registration never hard-breaks, but the caller is told it's unverified.
    return { ok: true, unverified: true, faceBox: { x: 0.22, y: 0.10, w: 0.56, h: 0.50 } };
  }

  // Two passes: a normal one, then a more sensitive one (bigger input, lower
  // threshold) so real faces with spectacles/sunglasses, beards, dim light or
  // partial angles still register.
  let results = await faceapi
    .detectAllFaces(imgEl, new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.35 }))
    .withFaceLandmarks();
  if (!results.length) {
    results = await faceapi
      .detectAllFaces(imgEl, new faceapi.TinyFaceDetectorOptions({ inputSize: 608, scoreThreshold: 0.2 }))
      .withFaceLandmarks();
  }

  const W = imgEl.naturalWidth || imgEl.width;
  const H = imgEl.naturalHeight || imgEl.height;
  if (!results.length) return { ok: false, reason: "We couldn't find a face in this photo. Use a clear photo of you." };

  // Pick the highest-confidence, largest face.
  results.sort((a, b) => (b.detection.score * b.detection.box.area) - (a.detection.score * a.detection.box.area));
  const best = results[0];
  const box = best.detection.box;
  const score = best.detection.score;
  const areaFrac = (box.width * box.height) / (W * H);

  if (score < 0.28) return { ok: false, reason: "That doesn't read as a real face. Try a clearer, front-facing photo." };
  if (areaFrac < 0.01) return { ok: false, reason: 'Your face is too small in the frame — move closer.' };
  if (areaFrac > 0.98) return { ok: false, reason: 'Photo is too tight on the face — include a little more.' };

  // Landmark geometry sanity: eyes above mouth, plausible interocular distance.
  const pts = best.landmarks;
  const mean = (arr) => arr.reduce((s, p) => ({ x: s.x + p.x, y: s.y + p.y }), { x: 0, y: 0 });
  const avg = (arr) => { const m = mean(arr); return { x: m.x / arr.length, y: m.y / arr.length }; };
  const le = avg(pts.getLeftEye()), re = avg(pts.getRightEye()), mo = avg(pts.getMouth());
  const eyeY = (le.y + re.y) / 2;
  const interocular = Math.hypot(re.x - le.x, re.y - le.y);
  if (!(eyeY < mo.y) || interocular < W * 0.03) {
    return { ok: false, reason: "That doesn't read as a real face. Try a clearer, front-facing photo." };
  }

  // Build a padded box around the real face (landmarks are tight; add hair/chin).
  const padTop = box.height * 0.55;   // forehead + hair
  const padBottom = box.height * 0.14; // chin
  const padX = box.width * 0.16;
  let x = (box.x - padX) / W;
  let y = (box.y - padTop) / H;
  let w = (box.width + padX * 2) / W;
  let h = (box.height + padTop + padBottom) / H;
  // clamp to image
  x = Math.max(0, x); y = Math.max(0, y);
  w = Math.min(1 - x, w); h = Math.min(1 - y, h);

  return { ok: true, faceBox: { x: +x.toFixed(4), y: +y.toFixed(4), w: +w.toFixed(4), h: +h.toFixed(4) }, score: +score.toFixed(2) };
}
