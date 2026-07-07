/* UNFOLD shared helpers */

const STAGE_CLEAR_COUNTS = [0, 6, 12, 16];
const STAGE_LABELS = ['Frosted', 'First glimpse', 'Voice unlocked', 'Fully revealed'];

// Per-tab session token: sessionStorage is scoped to the tab, so two accounts
// can run side-by-side in two tabs of the same browser (cookie stays as a
// fallback for a single-tab flow).
function sessionToken() { try { return sessionStorage.getItem('unfold_sid') || ''; } catch { return ''; } }
function setSessionToken(t) { try { t ? sessionStorage.setItem('unfold_sid', t) : sessionStorage.removeItem('unfold_sid'); } catch {} }

async function api(path, opts = {}) {
  const headers = opts.body ? { 'Content-Type': 'application/json' } : {};
  const tok = sessionToken();
  if (tok) headers['X-Session-Token'] = tok;
  const res = await fetch(path, {
    headers,
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch {}
  if (res.status === 401 && !opts.noRedirect) {
    location.href = '/login.html';
    throw new Error('unauthenticated');
  }
  if (!res.ok) {
    const err = new Error((data && data.message) || 'Something went wrong');
    err.code = data && data.error;
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function toast(msg, ms = 2600) {
  let root = document.getElementById('toast-root');
  if (!root) { root = document.createElement('div'); root.id = 'toast-root'; document.body.appendChild(root); }
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  root.appendChild(el);
  setTimeout(() => { el.classList.add('fading'); setTimeout(() => el.remove(), 450); }, ms);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function photoUrl(photo, stage) {
  const tok = sessionToken();
  return `/api/photos/${photo.id}/image?stage=${stage}` + (tok ? `&sid=${encodeURIComponent(tok)}` : '');
}

const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Glass puzzle overlay over the face box of a photo.
 * mount(container, photo, stage) -> controller with setStage(newStage).
 * `photo` = { id, faceBox: {x,y,w,h fractions}, tileOrder: [16 indices] }.
 */
function GlassReveal(container, photo, stage, opts = {}) {
  container.classList.add('photo-frame');
  const img = document.createElement('img');
  img.alt = '';
  img.draggable = false;
  img.src = opts.staticSrc || photoUrl(photo, Math.min(stage, 3));
  container.appendChild(img);

  const fb = photo.faceBox;
  const overlay = document.createElement('div');
  overlay.className = 'glass-overlay';
  container.appendChild(overlay);

  // The face box is in IMAGE space, but object-fit: cover crops the image to
  // the frame — translate the box into displayed (frame) space so the tiles
  // always sit exactly on the face, whatever the frame's aspect ratio.
  function positionOverlay() {
    let x = fb.x, y = fb.y, w = fb.w, h = fb.h;
    const cw = container.clientWidth, ch = container.clientHeight;
    if (cw && ch && photo.width && photo.height) {
      const ri = photo.width / photo.height, rc = cw / ch;
      if (ri > rc) { // image wider than frame — sides cropped
        const vis = rc / ri;
        x = (fb.x - (1 - vis) / 2) / vis; w = fb.w / vis;
      } else {       // image taller — top/bottom cropped
        const vis = ri / rc;
        y = (fb.y - (1 - vis) / 2) / vis; h = fb.h / vis;
      }
    }
    overlay.style.left = x * 100 + '%';
    overlay.style.top = y * 100 + '%';
    overlay.style.width = w * 100 + '%';
    overlay.style.height = h * 100 + '%';
  }
  positionOverlay();
  if (window.ResizeObserver) new ResizeObserver(positionOverlay).observe(container);

  const tiles = [];
  for (let i = 0; i < 16; i++) {
    const t = document.createElement('div');
    t.className = 'glass-tile';
    overlay.appendChild(t);
    tiles.push(t);
  }

  let current = -1;
  let destroyed = false;

  function clearedSet(st) {
    return new Set(photo.tileOrder.slice(0, STAGE_CLEAR_COUNTS[Math.min(st, 3)]));
  }

  function swapImage(st) {
    return new Promise((resolve) => {
      if (opts.staticSrc) return resolve();
      const next = new Image();
      next.onload = () => { img.src = next.src; resolve(); };
      next.onerror = () => resolve();
      next.src = photoUrl(photo, st);
    });
  }

  function shatter() {
    if (destroyed) return;
    const rect = overlay.getBoundingClientRect();
    const cx = rect.width / 2, cy = rect.height / 2;
    if (!REDUCED_MOTION) {
      const flash = document.createElement('div');
      flash.className = 'shatter-flash';
      overlay.appendChild(flash);
      for (let s = 0; s < 10; s++) {
        const sp = document.createElement('div');
        sp.className = 'sparkle';
        sp.style.left = cx + 'px'; sp.style.top = cy + 'px';
        const a = Math.random() * Math.PI * 2, d = 40 + Math.random() * 90;
        sp.style.setProperty('--fly-x', Math.cos(a) * d + 'px');
        sp.style.setProperty('--fly-y', Math.sin(a) * d + 'px');
        overlay.appendChild(sp);
      }
    }
    tiles.forEach((t, i) => {
      const col = i % 4, row = Math.floor(i / 4);
      const tx = (col + 0.5) * rect.width / 4 - cx;
      const ty = (row + 0.5) * rect.height / 4 - cy;
      const mag = 1.6 + Math.random() * 1.2;
      t.style.setProperty('--fly-x', tx * mag + (Math.random() - 0.5) * 40 + 'px');
      t.style.setProperty('--fly-y', ty * mag + (Math.random() - 0.5) * 40 - 25 + 'px');
      t.style.setProperty('--fly-r', (Math.random() - 0.5) * 240 + 'deg');
      setTimeout(() => t.classList.add('shattering'), REDUCED_MOTION ? 0 : i * 40);
    });
    setTimeout(() => { if (!destroyed) overlay.remove(); destroyed = true; }, REDUCED_MOTION ? 100 : 1600);
  }

  async function setStage(st, { animate = true } = {}) {
    st = Math.min(3, Math.max(0, st));
    if (st === current || destroyed) { current = Math.max(current, st); return; }
    const isInitial = current < 0;
    const prevCleared = isInitial ? new Set() : clearedSet(current);
    current = st;
    await swapImage(st);
    if (st === 3 && (isInitial || !animate)) {
      // already revealed — no ceremony, just the bare photo
      overlay.remove();
      destroyed = true;
      return;
    }
    if (st === 3) {
      // clear the last tiles, then shatter everything
      const newly = photo.tileOrder.slice(STAGE_CLEAR_COUNTS[2]);
      newly.forEach((i, k) => setTimeout(() => tiles[i].classList.add('clear'), animate && !REDUCED_MOTION ? k * 90 : 0));
      setTimeout(shatter, animate && !REDUCED_MOTION ? newly.length * 90 + 350 : 0);
      return;
    }
    const cleared = clearedSet(st);
    let k = 0;
    photo.tileOrder.forEach((i) => {
      if (cleared.has(i) && !prevCleared.has(i)) {
        setTimeout(() => tiles[i].classList.add('clear'), animate && !REDUCED_MOTION ? k * 130 : 0);
        k++;
      }
    });
  }

  setStage(stage, { animate: false });
  return { setStage, get stage() { return current; }, img, overlay };
}

function ladderHtml(stage, mini = false) {
  const segs = [1, 2, 3].map((s) => `<span class="seg ${stage >= s ? 'on' : ''}"></span>`).join('');
  return `<span class="ladder ${mini ? 'mini' : ''}"><span class="seg on"></span>${segs}</span>`;
}

function timeAgo(iso) {
  const t = new Date(String(iso).replace(' ', 'T') + (String(iso).endsWith('Z') ? '' : 'Z')).getTime();
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  return Math.floor(s / 86400) + 'd';
}
