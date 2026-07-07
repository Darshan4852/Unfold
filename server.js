const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { db, getConfig, setConfig, ensureConfigDefaults, today, CONFIG_DEFAULTS } = require('./lib/db');
const { processUpload, variantPath, deletePhotoFiles, DEFAULT_FACE_BOX, UPLOAD_DIR } = require('./lib/images');
const { isMeaningful, computeStage, progressToNext, MSGS_PER_STAGE } = require('./lib/reveal');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'unfold-admin';
if (!process.env.ADMIN_PASSWORD) {
  console.warn('[unfold] ADMIN_PASSWORD not set — using default "unfold-admin" (dev only)');
}

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- sessions ----------

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function createSession(res, userId, isAdmin) {
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id, is_admin) VALUES (?, ?, ?)')
    .run(token, userId, isAdmin ? 1 : 0);
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=86400`);
  return token;
}

app.use((req, res, next) => {
  // Token priority: per-tab header (lets two accounts live in two tabs of one
  // browser), then query param (for <img> requests that can't set headers),
  // then the shared cookie as a fallback.
  const sid = req.headers['x-session-token']
    || (typeof req.query.sid === 'string' ? req.query.sid : null)
    || parseCookies(req).sid;
  req.session = null;
  req.user = null;
  if (sid) {
    const s = db.prepare('SELECT * FROM sessions WHERE token = ?').get(sid);
    if (s) {
      req.session = s;
      if (s.user_id) {
        req.user = db.prepare('SELECT * FROM users WHERE id = ?').get(s.user_id);
        if (!req.user) req.session = null; // user was removed by admin
      }
    }
  }
  next();
});

function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'UNAUTHENTICATED' });
  next();
}
function requireAdmin(req, res, next) {
  if (!req.session || !req.session.is_admin) return res.status(401).json({ error: 'ADMIN_ONLY' });
  next();
}

// ---------- helpers ----------

function photoMeta(row) {
  return {
    id: row.id,
    width: row.width,
    height: row.height,
    faceBox: { x: row.face_x, y: row.face_y, w: row.face_w, h: row.face_h },
    tileOrder: JSON.parse(row.tile_order),
  };
}

function userPhotos(userId) {
  return db.prepare('SELECT * FROM photos WHERE user_id = ? ORDER BY idx, id').all(userId).map(photoMeta);
}

// Status of the day: one text-only status per user, alive for 24 hours.
const STATUS_HOURS = 24;
const STATUS_TYPES = {
  mood: '🌤 Mood',
  song: '🎵 Song',
  thought: '💭 Thought',
  today: '📍 Today',
};

function activeStatus(userId) {
  const row = db.prepare('SELECT * FROM statuses WHERE user_id = ?').get(userId);
  if (!row) return null;
  const created = new Date(row.created_at.replace(' ', 'T') + 'Z').getTime();
  const ageMs = Date.now() - created;
  if (ageMs > STATUS_HOURS * 3600 * 1000) return null; // expired
  const leftMin = Math.max(0, Math.round((STATUS_HOURS * 3600 * 1000 - ageMs) / 60000));
  return {
    type: STATUS_TYPES[row.type] ? row.type : 'thought',
    label: STATUS_TYPES[row.type] || STATUS_TYPES.thought,
    text: row.text,
    expiresInMin: leftMin,
    at: row.created_at,
  };
}

// Curious, personality-first prompt pool. Users pick 3.
const PROMPT_POOL = [
  'Top 3 movies or songs',
  'My simple pleasure',
  "We'll get along if",
  'The hill I will die on',
  'A weirdly specific thing that makes me happy',
  "What I'm secretly competitive about",
  "The most spontaneous thing I've ever done",
  'A belief I changed my mind about',
  'My most controversial food opinion',
  'What my friends roast me for',
  'A free Tuesday and zero guilt — I would',
  'The question I wish people asked me',
];

// Before a match, only the first two photos exist for the other person —
// the rest are part of the "full profile" a mutual match unlocks.
function publicProfile(u, { allPhotos = false } = {}) {
  const photos = userPhotos(u.id);
  return {
    id: u.id, firstName: u.first_name, age: u.age, gender: u.gender,
    height: u.height, job: u.job, education: u.education,
    about: u.about || '',
    prompts: [
      { q: u.prompt1_q || 'Top 3 movies or songs', a: u.prompt1 },
      { q: u.prompt2_q || 'My simple pleasure', a: u.prompt2 },
      { q: u.prompt3_q || "We'll get along if", a: u.prompt3 },
    ],
    photos: allPhotos ? photos : photos.slice(0, 2),
    photoCount: photos.length,
    status: activeStatus(u.id),
  };
}

function convBetween(a, b) {
  return db.prepare(
    'SELECT * FROM conversations WHERE (user_a = ? AND user_b = ?) OR (user_a = ? AND user_b = ?)'
  ).get(a, b, b, a);
}

function isExpired(conv, cfg) {
  if (!cfg.expiryEnabled) return false;
  const last = new Date(conv.last_msg_at.replace(' ', 'T') + 'Z').getTime();
  return Date.now() - last > cfg.expiryHours * 3600 * 1000;
}

function convState(conv) {
  const meaningfulCount = db.prepare(
    'SELECT COUNT(*) AS n FROM messages WHERE conv_id = ? AND meaningful = 1'
  ).get(conv.id).n;
  const senders = db.prepare(
    'SELECT COUNT(DISTINCT sender_id) AS n FROM messages WHERE conv_id = ?'
  ).get(conv.id).n;
  const bothSent = senders >= 2;
  const { stage, toNext } = progressToNext({ bothSent, meaningfulCount });
  return { meaningfulCount, bothSent, stage, toNext };
}

function refreshStage(conv) {
  const st = convState(conv);
  if (st.stage !== conv.stage) {
    db.prepare('UPDATE conversations SET stage = ? WHERE id = ?').run(st.stage, conv.id);
    conv.stage = st.stage;
  }
  return st;
}

// ---- concurrency model ----
// A conversation is PENDING until the recipient replies (both sides sent ≥1).
// Once both have sent, it's ACTIVE — a "proper conversation". Each user gets
// ONE free active slot (their oldest active thread = their "primary"). Any
// additional active thread is LOCKED for that user until they either pay to run
// it in parallel (parallel flag for their side) or softly close another. Soft
// close preserves the thread and frees the slot.

function sideOf(conv, userId) { return conv.user_a === userId ? 'a' : 'b'; }
function hasParallel(conv, userId) { return sideOf(conv, userId) === 'a' ? !!conv.parallel_a : !!conv.parallel_b; }
function isMatched(conv) { return conv.match_a === 1 && conv.match_b === 1; }
function myMatch(conv, userId) {
  const v = sideOf(conv, userId) === 'a' ? conv.match_a : conv.match_b;
  return v === 1 ? 'yes' : v === 0 ? 'no' : null;
}
function theirMatch(conv, userId) {
  const v = sideOf(conv, userId) === 'a' ? conv.match_b : conv.match_a;
  return v === 1 ? 'yes' : v === 0 ? 'no' : null;
}
function convStatus(conv, userId, st, locked) {
  if (conv.closed) return conv.closed_kind === 'soft' ? 'ended' : 'closed';
  if (isMatched(conv)) return 'matched';
  if (!st.bothSent) return 'pending';
  return locked ? 'locked' : 'active';
}

// All non-closed conversations for a user, with computed activity flags.
function userConversations(userId) {
  return db.prepare(
    'SELECT * FROM conversations WHERE (user_a = ? OR user_b = ?) ORDER BY id'
  ).all(userId, userId);
}

// The user's free primary slot = their oldest active conversation that they
// have NOT paid to run in parallel. Parallel-unlocked threads occupy their own
// paid slots, so they don't consume the free one.
function primaryActiveId(userId) {
  const active = userConversations(userId)
    .filter((c) => !c.closed && !hasParallel(c, userId) && convState(c).bothSent)
    .sort((x, y) => {
      const ax = x.activated_at || x.last_msg_at, ay = y.activated_at || y.last_msg_at;
      return ax < ay ? -1 : ax > ay ? 1 : x.id - y.id;
    });
  return active.length ? active[0].id : null;
}

// Is this conversation LOCKED for the given user right now?
function isLockedFor(conv, userId) {
  if (conv.closed) return false;
  if (!convState(conv).bothSent) return false;       // pending, not locked
  if (hasParallel(conv, userId)) return false;        // paid to go parallel
  const primary = primaryActiveId(userId);
  return primary !== null && primary !== conv.id;     // an older active thread holds the slot
}

// Mark a conversation active the moment the second distinct sender posts.
function maybeActivate(conv) {
  if (!conv.activated_at && convState(conv).bothSent) {
    db.prepare("UPDATE conversations SET activated_at = datetime('now') WHERE id = ?").run(conv.id);
    conv.activated_at = new Date().toISOString();
  }
}

function counters(userId, cfg) {
  const d = today();
  const openersUsed = db.prepare(
    "SELECT COUNT(*) AS n FROM conversations WHERE user_a = ? AND date(created_at) = ?"
  ).get(userId, d).n;
  const servedToday = db.prepare(
    'SELECT COUNT(*) AS n FROM served WHERE user_id = ? AND day = ?'
  ).get(userId, d).n;
  return {
    openersLeft: Math.max(0, cfg.openersPerDay - openersUsed),
    openersPerDay: cfg.openersPerDay,
    profilesSeenToday: servedToday,
    profilesPerDay: cfg.profilesPerDay,
  };
}

const clean = (v, max = 200) => String(v ?? '').trim().slice(0, max);

// ---------- auth ----------

app.post('/api/register', (req, res) => {
  const b = req.body || {};
  const username = clean(b.username, 30).toLowerCase();
  const password = String(b.password || '');
  const firstName = clean(b.firstName, 40);
  const age = parseInt(b.age, 10);
  const gender = b.gender === 'woman' ? 'woman' : b.gender === 'man' ? 'man' : null;
  const height = clean(b.height, 20);
  const job = clean(b.job, 60);
  const education = clean(b.education, 60);
  // prompts: [{q, a} x3] with q from PROMPT_POOL (plain strings = legacy default questions)
  const DEFAULT_QS = ['Top 3 movies or songs', 'My simple pleasure', "We'll get along if"];
  const promptsRaw = Array.isArray(b.prompts) ? b.prompts : [];
  const prompts = promptsRaw.map((p, i) => (typeof p === 'string'
    ? { q: DEFAULT_QS[i] || DEFAULT_QS[0], a: clean(p, 240) }
    : { q: clean(p && p.q, 80), a: clean(p && p.a, 240) }));
  const about = clean(b.about, 400);
  // photos may be [dataUrl, ...] (legacy) or [{ dataUrl, faceBox }, ...]
  const photosRaw = Array.isArray(b.photos) ? b.photos : [];

  if (!/^[a-z0-9_.]{3,30}$/.test(username)) return res.status(400).json({ error: 'BAD_USERNAME', message: 'Username: 3–30 chars, letters/numbers/_/.' });
  if (username === 'admin') return res.status(400).json({ error: 'BAD_USERNAME', message: 'That username is reserved.' });
  if (password.length < 4) return res.status(400).json({ error: 'BAD_PASSWORD', message: 'Password needs at least 4 characters.' });
  if (!firstName) return res.status(400).json({ error: 'MISSING', message: 'First name is required.' });
  if (!(age >= 18 && age <= 99)) return res.status(400).json({ error: 'BAD_AGE', message: 'Age must be 18–99.' });
  if (!gender) return res.status(400).json({ error: 'MISSING', message: 'Please pick a gender.' });
  if (!height || !job || !education) return res.status(400).json({ error: 'MISSING', message: 'Height, job and education are required.' });
  if (prompts.length !== 3 || prompts.some((p) => !p.a)) return res.status(400).json({ error: 'MISSING', message: 'Please answer all three prompts.' });
  if (prompts.some((p) => !PROMPT_POOL.includes(p.q))) return res.status(400).json({ error: 'BAD_PROMPT', message: 'Pick prompts from the list.' });
  if (new Set(prompts.map((p) => p.q)).size !== 3) return res.status(400).json({ error: 'BAD_PROMPT', message: 'Pick three different prompts.' });
  if (photosRaw.length !== 2) return res.status(400).json({ error: 'MISSING', message: 'Please add both photos.' });

  const normFaceBox = (fb) => {
    if (!fb || typeof fb !== 'object') return null;
    const n = (v) => (typeof v === 'number' && v >= 0 && v <= 1 ? v : null);
    const x = n(fb.x), y = n(fb.y), w = n(fb.w), h = n(fb.h);
    if (x === null || y === null || w === null || h === null) return null;
    if (w < 0.05 || h < 0.05 || x + w > 1.001 || y + h > 1.001) return null;
    return { x, y, w, h };
  };
  const photos = photosRaw.map((p) => (typeof p === 'string'
    ? { dataUrl: p, faceBox: null }
    : { dataUrl: p && p.dataUrl, faceBox: normFaceBox(p && p.faceBox) }));
  if (photos.some((p) => !p.dataUrl)) return res.status(400).json({ error: 'MISSING', message: 'Please add both photos.' });

  if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) {
    return res.status(409).json({ error: 'USERNAME_TAKEN', message: 'That username is taken.' });
  }

  const hash = bcrypt.hashSync(password, 8);
  const info = db.prepare(`
    INSERT INTO users (username, password_hash, first_name, age, gender, height, job, education,
                       prompt1, prompt2, prompt3, prompt1_q, prompt2_q, prompt3_q, about)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(username, hash, firstName, age, gender, height, job, education,
    prompts[0].a, prompts[1].a, prompts[2].a, prompts[0].q, prompts[1].q, prompts[2].q, about);
  const userId = Number(info.lastInsertRowid);

  try {
    photos.forEach((photo, idx) => {
      const pInfo = db.prepare(`
        INSERT INTO photos (user_id, idx, width, height, face_x, face_y, face_w, face_h, tile_order)
        VALUES (?, ?, 0, 0, 0, 0, 0, 0, '[]')
      `).run(userId, idx);
      const photoId = Number(pInfo.lastInsertRowid);
      const meta = processUpload(photoId, photo.dataUrl, photo.faceBox || DEFAULT_FACE_BOX);
      db.prepare(`
        UPDATE photos SET width = ?, height = ?, face_x = ?, face_y = ?, face_w = ?, face_h = ?, tile_order = ?
        WHERE id = ?
      `).run(meta.width, meta.height, meta.faceBox.x, meta.faceBox.y, meta.faceBox.w, meta.faceBox.h,
        JSON.stringify(meta.tileOrder), photoId);
    });
  } catch (e) {
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    return res.status(400).json({ error: 'BAD_PHOTO', message: 'Could not process a photo — please retake and try again.' });
  }

  const token = createSession(res, userId, false);
  res.json({ ok: true, userId, token });
});

app.post('/api/login', (req, res) => {
  const username = clean(req.body?.username, 30).toLowerCase();
  const password = String(req.body?.password || '');

  if (username === 'admin') {
    if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'BAD_LOGIN', message: 'Wrong admin password.' });
    const token = createSession(res, null, true);
    return res.json({ ok: true, admin: true, token });
  }

  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!u || !bcrypt.compareSync(password, u.password_hash)) {
    return res.status(401).json({ error: 'BAD_LOGIN', message: 'Wrong username or password.' });
  }
  const token = createSession(res, u.id, false);
  res.json({ ok: true, token });
});

app.post('/api/logout', (req, res) => {
  if (req.session) db.prepare('DELETE FROM sessions WHERE token = ?').run(req.session.token);
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/me', requireUser, (req, res) => {
  const cfg = getConfig();
  res.json({
    profile: publicProfile(req.user, { allPhotos: true }),
    username: req.user.username,
    matchingOpen: cfg.matchingOpen,
    counters: counters(req.user.id, cfg),
    promptPool: PROMPT_POOL,
    maxPhotos: 6,
    statusTypes: STATUS_TYPES,
    statusHours: STATUS_HOURS,
    status: activeStatus(req.user.id),
  });
});

// ---------- status of the day (text-only, 24h) ----------

app.put('/api/status', requireUser, (req, res) => {
  const type = STATUS_TYPES[req.body?.type] ? req.body.type : null;
  const text = clean(req.body?.text, 140);
  if (!type) return res.status(400).json({ error: 'BAD_TYPE', message: 'Pick mood, song, thought or today.' });
  if (!text) return res.status(400).json({ error: 'MISSING', message: 'Write your status first.' });
  db.prepare(`
    INSERT INTO statuses (user_id, type, text, created_at) VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET type = excluded.type, text = excluded.text, created_at = excluded.created_at
  `).run(req.user.id, type, text);
  res.json({ ok: true, status: activeStatus(req.user.id) });
});

app.delete('/api/status', requireUser, (req, res) => {
  db.prepare('DELETE FROM statuses WHERE user_id = ?').run(req.user.id);
  res.json({ ok: true });
});

// The room's mood — active statuses from the opposite gender, newest first.
app.get('/api/statuses', requireUser, (req, res) => {
  const opposite = req.user.gender === 'woman' ? 'man' : 'woman';
  const rows = db.prepare(`
    SELECT s.*, u.first_name, u.age FROM statuses s
    JOIN users u ON u.id = s.user_id
    WHERE u.gender = ? ORDER BY s.created_at DESC
  `).all(opposite);
  const out = [];
  for (const r of rows) {
    const st = activeStatus(r.user_id);
    if (st) out.push({ userId: r.user_id, firstName: r.first_name, age: r.age, type: st.type, label: st.label, text: st.text, expiresInMin: st.expiresInMin });
  }
  res.json({ statuses: out.slice(0, 20) });
});

// Edit your own About + prompts (question + answer).
app.put('/api/profile', requireUser, (req, res) => {
  const b = req.body || {};
  const about = clean(b.about, 400);
  let prompts = null;
  if (Array.isArray(b.prompts)) {
    prompts = b.prompts.map((p) => (typeof p === 'string'
      ? { q: null, a: clean(p, 240) }
      : { q: clean(p && p.q, 80), a: clean(p && p.a, 240) }));
    if (prompts.length !== 3 || prompts.some((p) => !p.a)) {
      return res.status(400).json({ error: 'MISSING', message: 'Please keep all three prompts answered.' });
    }
    if (prompts.some((p) => p.q && !PROMPT_POOL.includes(p.q))) {
      return res.status(400).json({ error: 'BAD_PROMPT', message: 'Pick prompts from the list.' });
    }
    const qs = prompts.map((p) => p.q).filter(Boolean);
    if (new Set(qs).size !== qs.length) {
      return res.status(400).json({ error: 'BAD_PROMPT', message: 'Pick three different prompts.' });
    }
  }
  if (prompts) {
    db.prepare(`UPDATE users SET about = ?, prompt1 = ?, prompt2 = ?, prompt3 = ?,
      prompt1_q = COALESCE(?, prompt1_q), prompt2_q = COALESCE(?, prompt2_q), prompt3_q = COALESCE(?, prompt3_q)
      WHERE id = ?`)
      .run(about, prompts[0].a, prompts[1].a, prompts[2].a,
        prompts[0].q, prompts[1].q, prompts[2].q, req.user.id);
  } else {
    db.prepare('UPDATE users SET about = ? WHERE id = ?').run(about, req.user.id);
  }
  const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json({ ok: true, profile: publicProfile(fresh, { allPhotos: true }) });
});

// Add a photo (up to 6 total; first two are the public "glassed" ones,
// the rest unlock only on a mutual match).
app.post('/api/profile/photos', requireUser, (req, res) => {
  const existing = db.prepare('SELECT COUNT(*) AS n, COALESCE(MAX(idx), -1) AS mx FROM photos WHERE user_id = ?').get(req.user.id);
  if (existing.n >= 6) return res.status(400).json({ error: 'PHOTO_LIMIT', message: 'Six photos is the limit.' });
  const dataUrl = req.body && req.body.dataUrl;
  const fb = req.body && req.body.faceBox;
  const n = (v) => (typeof v === 'number' && v >= 0 && v <= 1 ? v : null);
  const faceBox = fb && n(fb.x) !== null && n(fb.y) !== null && n(fb.w) !== null && n(fb.h) !== null
    && fb.w >= 0.05 && fb.h >= 0.05 ? { x: fb.x, y: fb.y, w: fb.w, h: fb.h } : null;
  if (!dataUrl) return res.status(400).json({ error: 'BAD_REQUEST', message: 'No photo received.' });
  try {
    const pInfo = db.prepare(`
      INSERT INTO photos (user_id, idx, width, height, face_x, face_y, face_w, face_h, tile_order)
      VALUES (?, ?, 0, 0, 0, 0, 0, 0, '[]')
    `).run(req.user.id, existing.mx + 1);
    const photoId = Number(pInfo.lastInsertRowid);
    const meta = processUpload(photoId, dataUrl, faceBox || DEFAULT_FACE_BOX);
    db.prepare(`UPDATE photos SET width = ?, height = ?, face_x = ?, face_y = ?, face_w = ?, face_h = ?, tile_order = ? WHERE id = ?`)
      .run(meta.width, meta.height, meta.faceBox.x, meta.faceBox.y, meta.faceBox.w, meta.faceBox.h,
        JSON.stringify(meta.tileOrder), photoId);
    res.json({ ok: true, photos: userPhotos(req.user.id) });
  } catch (e) {
    return res.status(400).json({ error: 'BAD_PHOTO', message: 'Could not process that photo — try another.' });
  }
});

app.delete('/api/profile/photos/:photoId', requireUser, (req, res) => {
  const photo = db.prepare('SELECT * FROM photos WHERE id = ? AND user_id = ?').get(parseInt(req.params.photoId, 10), req.user.id);
  if (!photo) return res.status(404).json({ error: 'NOT_FOUND' });
  const count = db.prepare('SELECT COUNT(*) AS n FROM photos WHERE user_id = ?').get(req.user.id).n;
  if (count <= 2) return res.status(400).json({ error: 'PHOTO_MIN', message: 'Keep at least two photos.' });
  db.prepare('DELETE FROM photos WHERE id = ?').run(photo.id);
  deletePhotoFiles(photo.id);
  // keep the first two slots meaningful: re-pack idx order
  const rest = db.prepare('SELECT id FROM photos WHERE user_id = ? ORDER BY idx, id').all(req.user.id);
  rest.forEach((r, i) => db.prepare('UPDATE photos SET idx = ? WHERE id = ?').run(i, r.id));
  res.json({ ok: true, photos: userPhotos(req.user.id) });
});

// Lobby poll (also used app-wide to detect pause).
app.get('/api/state', requireUser, (req, res) => {
  res.json({ matchingOpen: getConfig().matchingOpen });
});

// ---------- discover ----------

app.get('/api/discover', requireUser, (req, res) => {
  const cfg = getConfig();
  if (!cfg.matchingOpen) return res.status(403).json({ error: 'MATCHING_CLOSED' });

  const me = req.user;
  const d = today();
  const opposite = me.gender === 'woman' ? 'man' : 'woman';

  const candidate = db.prepare(`
    SELECT u.* FROM users u
    WHERE u.gender = ? AND u.id != ?
      AND NOT EXISTS (SELECT 1 FROM skips s WHERE s.user_id = ? AND s.target_id = u.id)
      AND NOT EXISTS (SELECT 1 FROM conversations c
                      WHERE (c.user_a = ? AND c.user_b = u.id) OR (c.user_a = u.id AND c.user_b = ?))
    ORDER BY EXISTS (SELECT 1 FROM served sv WHERE sv.user_id = ? AND sv.target_id = u.id AND sv.day = ?) DESC,
             u.id
    LIMIT 1
  `).get(opposite, me.id, me.id, me.id, me.id, me.id, d);

  const cnt = counters(me.id, cfg);
  if (!candidate) return res.json({ done: true, reason: 'POOL_EMPTY', counters: cnt });

  const alreadyServed = db.prepare(
    'SELECT 1 FROM served WHERE user_id = ? AND target_id = ? AND day = ?'
  ).get(me.id, candidate.id, d);
  if (!alreadyServed) {
    if (cnt.profilesSeenToday >= cfg.profilesPerDay) {
      return res.json({ done: true, reason: 'DAILY_CAP', counters: cnt });
    }
    db.prepare('INSERT INTO served (user_id, target_id, day) VALUES (?, ?, ?)').run(me.id, candidate.id, d);
    cnt.profilesSeenToday += 1;
  }

  res.json({ profile: publicProfile(candidate), position: cnt.profilesSeenToday, counters: cnt });
});

app.post('/api/discover/skip', requireUser, (req, res) => {
  const targetId = parseInt(req.body?.targetId, 10);
  if (!targetId) return res.status(400).json({ error: 'BAD_REQUEST' });
  db.prepare('INSERT OR IGNORE INTO skips (user_id, target_id) VALUES (?, ?)').run(req.user.id, targetId);
  res.json({ ok: true });
});

app.post('/api/opener', requireUser, (req, res) => {
  const cfg = getConfig();
  if (!cfg.matchingOpen) return res.status(403).json({ error: 'MATCHING_CLOSED' });

  const me = req.user;
  const targetId = parseInt(req.body?.targetId, 10);
  const text = clean(req.body?.text, 1000);
  if (!targetId || !text) return res.status(400).json({ error: 'BAD_REQUEST', message: 'Write an opener first.' });

  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
  if (!target || target.gender === me.gender || target.id === me.id) {
    return res.status(400).json({ error: 'BAD_TARGET' });
  }
  if (convBetween(me.id, target.id)) return res.status(409).json({ error: 'ALREADY_EXISTS' });

  const d = today();
  const openersUsed = db.prepare(
    'SELECT COUNT(*) AS n FROM conversations WHERE user_a = ? AND date(created_at) = ?'
  ).get(me.id, d).n;
  if (openersUsed >= cfg.openersPerDay) {
    return res.status(429).json({ error: 'OPENERS_EXHAUSTED', message: 'No openers left today. Scarcity is the point 😉' });
  }

  // The Inbox Cap — Strong-Vibe Override (simulated payment) lifts it.
  const incomingToday = db.prepare(
    'SELECT COUNT(*) AS n FROM conversations WHERE user_b = ? AND date(created_at) = ?'
  ).get(target.id, d).n;
  if (incomingToday >= cfg.inboxCapPerDay && !req.body?.vibeOverride) {
    return res.status(409).json({ error: 'INBOX_FULL', message: `${target.first_name}'s inbox is full today.` });
  }

  // Openers are free (up to the daily cap) — you may have several conversations
  // pending at once. The concurrency limit only bites once a SECOND one gets a
  // reply (see the locked-conversation logic), not at opener time.
  const info = db.prepare('INSERT INTO conversations (user_a, user_b) VALUES (?, ?)').run(me.id, target.id);
  const convId = Number(info.lastInsertRowid);
  db.prepare('INSERT INTO messages (conv_id, sender_id, text, meaningful) VALUES (?, ?, ?, ?)')
    .run(convId, me.id, text, isMeaningful(text) ? 1 : 0);

  res.json({ ok: true, convId, meaningful: isMeaningful(text), counters: counters(me.id, cfg) });
});

// ---------- chats ----------

function requireMember(req, res, next) {
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!conv || (conv.user_a !== req.user.id && conv.user_b !== req.user.id)) {
    return res.status(404).json({ error: 'NOT_FOUND' });
  }
  req.conv = conv;
  next();
}

app.get('/api/chats', requireUser, (req, res) => {
  const cfg = getConfig();
  const me = req.user;
  const convs = db.prepare(
    'SELECT * FROM conversations WHERE user_a = ? OR user_b = ? ORDER BY last_msg_at DESC'
  ).all(me.id, me.id);

  const primaryId = primaryActiveId(me.id);

  const out = convs.map((conv) => {
    const st = refreshStage(conv);
    const partnerId = conv.user_a === me.id ? conv.user_b : conv.user_a;
    const partner = db.prepare('SELECT * FROM users WHERE id = ?').get(partnerId);
    if (!partner) return null;
    const last = db.prepare(
      'SELECT * FROM messages WHERE conv_id = ? ORDER BY id DESC LIMIT 1'
    ).get(conv.id);
    const photo = db.prepare('SELECT * FROM photos WHERE user_id = ? ORDER BY idx, id LIMIT 1').get(partnerId);
    const locked = isLockedFor(conv, me.id);
    const status = convStatus(conv, me.id, st, locked);
    return {
      id: conv.id,
      partner: { id: partner.id, firstName: partner.first_name, age: partner.age, job: partner.job },
      photo: photo ? photoMeta(photo) : null,
      stage: st.stage, toNext: st.toNext, bothSent: st.bothSent, meaningfulCount: st.meaningfulCount,
      lastText: last ? (last.kind === 'voice' ? '🎙 voice note' : last.text) : '',
      lastAt: last ? last.created_at : conv.created_at,
      awaitingThem: !!last && last.sender_id === me.id,
      expired: isExpired(conv, cfg),
      status,
      locked,
      isPrimary: conv.id === primaryId,
      parallel: hasParallel(conv, me.id),
      awaitingMatch: status !== 'ended' && !conv.closed && st.stage >= 3 && !isMatched(conv) && myMatch(conv, me.id) === null,
    };
  }).filter(Boolean);

  // Notifications: locked threads waiting on you + match decisions waiting on you.
  const notifications = out.filter((c) => c.status === 'locked' || c.awaitingMatch).length;
  res.json({ chats: out, notifications });
});

app.get('/api/chats/:id', requireUser, requireMember, (req, res) => {
  const cfg = getConfig();
  const conv = req.conv;
  const st = refreshStage(conv);
  const me = req.user;
  const partnerId = conv.user_a === me.id ? conv.user_b : conv.user_a;
  const partner = db.prepare('SELECT * FROM users WHERE id = ?').get(partnerId);
  if (!partner) return res.status(404).json({ error: 'NOT_FOUND' });

  const messages = db.prepare(
    'SELECT id, sender_id, text, meaningful, kind, created_at FROM messages WHERE conv_id = ? ORDER BY id'
  ).all(conv.id).map((m) => ({
    id: m.id, mine: m.sender_id === me.id, text: m.text, kind: m.kind || 'text',
    meaningful: !!m.meaningful, at: m.created_at,
  }));

  const d = today();
  const myMsgsToday = db.prepare(
    'SELECT COUNT(*) AS n FROM messages WHERE conv_id = ? AND sender_id = ? AND date(created_at) = ?'
  ).get(conv.id, me.id, d).n;

  const locked = isLockedFor(conv, me.id);
  const primaryId = primaryActiveId(me.id);
  let primaryPartner = null;
  if (locked && primaryId) {
    const pc = db.prepare('SELECT * FROM conversations WHERE id = ?').get(primaryId);
    const ppId = pc.user_a === me.id ? pc.user_b : pc.user_a;
    const pp = db.prepare('SELECT first_name FROM users WHERE id = ?').get(ppId);
    if (pp) primaryPartner = { id: primaryId, firstName: pp.first_name };
  }

  const matched = isMatched(conv);
  res.json({
    id: conv.id,
    partner: publicProfile(partner, { allPhotos: matched }),
    stage: st.stage, toNext: st.toNext, bothSent: st.bothSent, meaningfulCount: st.meaningfulCount,
    msgsPerStage: MSGS_PER_STAGE,
    messages,
    myMsgsToday, msgsPerChatPerDay: cfg.msgsPerChatPerDay,
    expired: isExpired(conv, cfg),
    status: convStatus(conv, me.id, st, locked),
    locked,
    closed: !!conv.closed,
    closedByMe: conv.closed_by === me.id,
    closedKind: conv.closed ? conv.closed_kind : null,
    parallel: hasParallel(conv, me.id),
    primaryPartner,
    matched,
    myMatch: myMatch(conv, me.id),
    theirMatchYes: theirMatch(conv, me.id) === 'yes',
    voiceUnlocked: st.stage >= 2,
  });
});

// The match decision — offered once the glass has fully shattered.
// Both yes → matched (full profiles unlock). A "no" ends the story softly.
app.post('/api/chats/:id/match', requireUser, requireMember, (req, res) => {
  const conv = req.conv;
  const st = convState(conv);
  if (st.stage < 3) return res.status(409).json({ error: 'NOT_REVEALED', message: 'The glass has to fall first.' });
  if (conv.closed) return res.status(409).json({ error: 'CLOSED' });
  const decision = req.body?.decision === 'yes' ? 1 : req.body?.decision === 'no' ? 0 : null;
  if (decision === null) return res.status(400).json({ error: 'BAD_REQUEST' });

  const col = sideOf(conv, req.user.id) === 'a' ? 'match_a' : 'match_b';
  db.prepare(`UPDATE conversations SET ${col} = ? WHERE id = ?`).run(decision, conv.id);

  if (decision === 0) {
    // A gentle no: end softly, no blame, thread preserved but final.
    db.prepare("UPDATE conversations SET closed = 1, closed_by = ?, closed_at = datetime('now'), closed_kind = 'soft' WHERE id = ?")
      .run(req.user.id, conv.id);
    return res.json({ ok: true, matched: false, ended: true });
  }
  const fresh = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conv.id);
  res.json({ ok: true, matched: isMatched(fresh), ended: false });
});

app.post('/api/chats/:id/messages', requireUser, requireMember, (req, res) => {
  const cfg = getConfig();
  const conv = req.conv;
  if (conv.closed) return res.status(409).json({ error: 'CLOSED', message: 'This conversation was closed. Reopen it to keep talking.' });
  if (isExpired(conv, cfg)) return res.status(410).json({ error: 'EXPIRED', message: 'This thread dissolved after 24 quiet hours.' });
  if (isLockedFor(conv, req.user.id)) {
    return res.status(409).json({ error: 'LOCKED', message: "You're mid-story with someone else. Go parallel or gently close it first." });
  }

  const text = clean(req.body?.text, 1000);
  if (!text) return res.status(400).json({ error: 'BAD_REQUEST' });

  const d = today();
  const myMsgsToday = db.prepare(
    'SELECT COUNT(*) AS n FROM messages WHERE conv_id = ? AND sender_id = ? AND date(created_at) = ?'
  ).get(conv.id, req.user.id, d).n;
  if (myMsgsToday >= cfg.msgsPerChatPerDay) {
    return res.status(429).json({ error: 'MSG_CAP', message: 'Daily message limit for this chat reached. Depth over volume 🌱' });
  }

  const prevStage = convState(conv).stage;
  const meaningful = isMeaningful(text);
  db.prepare('INSERT INTO messages (conv_id, sender_id, text, meaningful) VALUES (?, ?, ?, ?)')
    .run(conv.id, req.user.id, text, meaningful ? 1 : 0);
  db.prepare("UPDATE conversations SET last_msg_at = datetime('now') WHERE id = ?").run(conv.id);
  maybeActivate(conv); // this reply may make it a "proper conversation"

  const st = refreshStage(conv);
  res.json({
    ok: true, meaningful,
    stage: st.stage, toNext: st.toNext, bothSent: st.bothSent, meaningfulCount: st.meaningfulCount,
    stageChanged: st.stage !== prevStage,
    myMsgsToday: myMsgsToday + 1,
  });
});

// Close a conversation. kind 'pause' = reopenable breather (default);
// kind 'soft' = a gentle, final exit — thread preserved, no reopening.
app.post('/api/chats/:id/close', requireUser, requireMember, (req, res) => {
  const conv = req.conv;
  const kind = req.body?.kind === 'soft' ? 'soft' : 'pause';
  db.prepare("UPDATE conversations SET closed = 1, closed_by = ?, closed_at = datetime('now'), closed_kind = ? WHERE id = ?")
    .run(req.user.id, kind, conv.id);
  res.json({ ok: true, kind });
});

app.post('/api/chats/:id/reopen', requireUser, requireMember, (req, res) => {
  const conv = req.conv;
  if (conv.closed && conv.closed_kind === 'soft') {
    return res.status(409).json({ error: 'ENDED', message: 'This story closed gently — it stays closed.' });
  }
  db.prepare('UPDATE conversations SET closed = 0, closed_by = NULL, closed_at = NULL WHERE id = ?').run(conv.id);
  res.json({ ok: true, locked: isLockedFor(db.prepare('SELECT * FROM conversations WHERE id = ?').get(conv.id), req.user.id) });
});

// ---------- voice notes (unlocked at stage 2) ----------

app.post('/api/chats/:id/voice', requireUser, requireMember, (req, res) => {
  const cfg = getConfig();
  const conv = req.conv;
  if (conv.closed) return res.status(409).json({ error: 'CLOSED', message: 'This conversation is closed.' });
  if (isExpired(conv, cfg)) return res.status(410).json({ error: 'EXPIRED' });
  if (isLockedFor(conv, req.user.id)) return res.status(409).json({ error: 'LOCKED', message: "You're mid-story with someone else." });
  const st = convState(conv);
  if (st.stage < 2) return res.status(409).json({ error: 'VOICE_LOCKED', message: 'Voice unlocks at the second reveal — keep talking.' });

  const m = /^data:audio\/(webm|ogg|mp4|mpeg|wav)(;codecs=[^;]+)?;base64,(.+)$/.exec(String(req.body?.audio || ''));
  if (!m) return res.status(400).json({ error: 'BAD_AUDIO', message: 'Could not read that recording.' });
  const buf = Buffer.from(m[3], 'base64');
  if (buf.length < 200) return res.status(400).json({ error: 'BAD_AUDIO', message: 'That recording was empty.' });
  if (buf.length > 2.5 * 1024 * 1024) return res.status(400).json({ error: 'BAD_AUDIO', message: 'Keep voice notes under a minute.' });

  const d = today();
  const myMsgsToday = db.prepare(
    'SELECT COUNT(*) AS n FROM messages WHERE conv_id = ? AND sender_id = ? AND date(created_at) = ?'
  ).get(conv.id, req.user.id, d).n;
  if (myMsgsToday >= cfg.msgsPerChatPerDay) {
    return res.status(429).json({ error: 'MSG_CAP', message: 'Daily message limit for this chat reached.' });
  }

  const prevStage = st.stage;
  const info = db.prepare("INSERT INTO messages (conv_id, sender_id, text, meaningful, kind) VALUES (?, ?, '', 1, 'voice')")
    .run(conv.id, req.user.id);
  const msgId = Number(info.lastInsertRowid);
  fs.writeFileSync(path.join(UPLOAD_DIR, `voice_${msgId}.${m[1]}`), buf);
  db.prepare("UPDATE conversations SET last_msg_at = datetime('now') WHERE id = ?").run(conv.id);
  maybeActivate(conv);

  const st2 = refreshStage(conv);
  res.json({ ok: true, msgId, stage: st2.stage, stageChanged: st2.stage !== prevStage, toNext: st2.toNext, myMsgsToday: myMsgsToday + 1 });
});

app.get('/api/chats/:id/voice/:msgId', requireUser, requireMember, (req, res) => {
  const msg = db.prepare("SELECT * FROM messages WHERE id = ? AND conv_id = ? AND kind = 'voice'")
    .get(parseInt(req.params.msgId, 10), req.conv.id);
  if (!msg) return res.status(404).end();
  for (const ext of ['webm', 'ogg', 'mp4', 'mpeg', 'wav']) {
    const file = path.join(UPLOAD_DIR, `voice_${msg.id}.${ext}`);
    if (fs.existsSync(file)) {
      res.setHeader('Content-Type', ext === 'mpeg' ? 'audio/mpeg' : `audio/${ext}`);
      res.setHeader('Cache-Control', 'private, max-age=3600');
      return fs.createReadStream(file).pipe(res);
    }
  }
  res.status(404).end();
});

// The Concurrency Key (simulated payment): unlock THIS conversation to run in
// parallel with your primary, instead of closing anything.
app.post('/api/chats/:id/parallel', requireUser, requireMember, (req, res) => {
  const conv = req.conv;
  const col = sideOf(conv, req.user.id) === 'a' ? 'parallel_a' : 'parallel_b';
  db.prepare(`UPDATE conversations SET ${col} = 1 WHERE id = ?`).run(conv.id);
  res.json({ ok: true });
});

// ---------- photos (stage-enforced) ----------

app.get('/api/photos/:id/image', (req, res) => {
  if (!req.session) return res.status(401).end();
  const photo = db.prepare('SELECT * FROM photos WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!photo) return res.status(404).end();

  const requested = Math.min(3, Math.max(0, parseInt(req.query.stage, 10) || 0));
  let allowed = 0;
  let conv = null;
  if (req.session.is_admin) {
    allowed = 3;
  } else if (req.user && photo.user_id === req.user.id) {
    allowed = 3; // your own photo
  } else if (req.user) {
    conv = convBetween(req.user.id, photo.user_id);
    allowed = conv ? refreshStage(conv).stage : 0;
    // photos beyond the first two belong to the full profile — matched only
    if (photo.idx >= 2 && !(conv && isMatched(conv))) return res.status(403).end();
  }
  if (requested > allowed) return res.status(403).end();

  const file = variantPath(photo.id, requested);
  if (!fs.existsSync(file)) return res.status(404).end();
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'private, max-age=600');
  fs.createReadStream(file).pipe(res);
});

// ---------- feedback ----------

app.post('/api/feedback', requireUser, (req, res) => {
  const rating = parseInt(req.body?.rating, 10);
  const wouldJoin = ['yes', 'maybe', 'no'].includes(req.body?.wouldJoin) ? req.body.wouldJoin : null;
  if (!(rating >= 1 && rating <= 5) || !wouldJoin) return res.status(400).json({ error: 'BAD_REQUEST', message: 'Pick a rating and an answer.' });
  db.prepare(`
    INSERT INTO feedback (user_id, rating, would_join, best_moment, change_text, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET rating = excluded.rating, would_join = excluded.would_join,
      best_moment = excluded.best_moment, change_text = excluded.change_text, updated_at = excluded.updated_at
  `).run(req.user.id, rating, wouldJoin, clean(req.body?.bestMoment, 500), clean(req.body?.changeText, 500));
  res.json({ ok: true });
});

app.get('/api/feedback', requireUser, (req, res) => {
  const f = db.prepare('SELECT * FROM feedback WHERE user_id = ?').get(req.user.id);
  res.json({ feedback: f ? { rating: f.rating, wouldJoin: f.would_join, bestMoment: f.best_moment, changeText: f.change_text } : null });
});

// ---------- admin ----------

app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const cfg = getConfig();
  const count = (sql, ...args) => db.prepare(sql).get(...args).n;
  res.json({
    registered: count('SELECT COUNT(*) AS n FROM users'),
    women: count("SELECT COUNT(*) AS n FROM users WHERE gender = 'woman'"),
    men: count("SELECT COUNT(*) AS n FROM users WHERE gender = 'man'"),
    conversations: count('SELECT COUNT(*) AS n FROM conversations'),
    messages: count('SELECT COUNT(*) AS n FROM messages'),
    feedbackCount: count('SELECT COUNT(*) AS n FROM feedback'),
    config: cfg,
  });
});

app.post('/api/admin/config', requireAdmin, (req, res) => {
  const b = req.body || {};
  const num = (v, lo, hi) => Math.min(hi, Math.max(lo, parseInt(v, 10)));
  if (b.matchingOpen !== undefined) setConfig('matching_open', b.matchingOpen ? '1' : '0');
  if (b.profilesPerDay !== undefined) setConfig('profiles_per_day', num(b.profilesPerDay, 1, 500));
  if (b.openersPerDay !== undefined) setConfig('openers_per_day', num(b.openersPerDay, 1, 100));
  if (b.msgsPerChatPerDay !== undefined) setConfig('msgs_per_chat_per_day', num(b.msgsPerChatPerDay, 1, 1000));
  if (b.inboxCapPerDay !== undefined) setConfig('inbox_cap_per_day', num(b.inboxCapPerDay, 1, 100));
  if (b.expiryEnabled !== undefined) setConfig('expiry_enabled', b.expiryEnabled ? '1' : '0');
  if (b.expiryHours !== undefined) setConfig('expiry_hours', num(b.expiryHours, 1, 168));
  res.json({ ok: true, config: getConfig() });
});

app.get('/api/admin/users', requireAdmin, (req, res) => {
  const users = db.prepare('SELECT * FROM users ORDER BY id').all().map((u) => ({
    id: u.id, username: u.username, firstName: u.first_name, age: u.age,
    gender: u.gender, job: u.job, createdAt: u.created_at,
    photos: userPhotos(u.id),
  }));
  res.json({ users });
});

app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const photos = db.prepare('SELECT id FROM photos WHERE user_id = ?').all(id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  photos.forEach((p) => deletePhotoFiles(p.id));
  res.json({ ok: true });
});

app.get('/api/admin/feedback', requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT f.*, u.first_name, u.username, u.gender FROM feedback f
    JOIN users u ON u.id = f.user_id ORDER BY f.updated_at DESC
  `).all();
  const breakdown = { yes: 0, maybe: 0, no: 0 };
  let ratingSum = 0;
  rows.forEach((r) => { breakdown[r.would_join] = (breakdown[r.would_join] || 0) + 1; ratingSum += r.rating; });
  res.json({
    feedback: rows.map((r) => ({
      firstName: r.first_name, username: r.username, gender: r.gender,
      rating: r.rating, wouldJoin: r.would_join,
      bestMoment: r.best_moment, changeText: r.change_text, at: r.updated_at,
    })),
    breakdown,
    avgRating: rows.length ? +(ratingSum / rows.length).toFixed(2) : 0,
  });
});

app.post('/api/admin/reset', requireAdmin, (req, res) => {
  const photos = db.prepare('SELECT id FROM photos').all();
  db.exec('DELETE FROM messages; DELETE FROM conversations; DELETE FROM skips; DELETE FROM served; DELETE FROM feedback; DELETE FROM statuses; DELETE FROM photos; DELETE FROM users;');
  db.prepare('DELETE FROM sessions WHERE is_admin = 0').run();
  db.exec('DELETE FROM config;');
  ensureConfigDefaults();
  photos.forEach((p) => deletePhotoFiles(p.id));
  res.json({ ok: true });
});

// ---------- boot ----------

app.listen(PORT, () => {
  console.log(`[unfold] listening on http://localhost:${PORT}`);
});
