// SQLite via Node's built-in node:sqlite — no native deps to build.
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(process.env.DATABASE_URL || path.join(DATA_DIR, 'unfold.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    first_name TEXT NOT NULL,
    age INTEGER NOT NULL,
    gender TEXT NOT NULL CHECK (gender IN ('woman','man')),
    height TEXT NOT NULL,
    job TEXT NOT NULL,
    education TEXT NOT NULL,
    prompt1 TEXT NOT NULL,
    prompt2 TEXT NOT NULL,
    prompt3 TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    face_x REAL NOT NULL, face_y REAL NOT NULL,
    face_w REAL NOT NULL, face_h REAL NOT NULL,
    tile_order TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER,            -- NULL for admin sessions
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS skips (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, target_id)
  );

  CREATE TABLE IF NOT EXISTS served (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    PRIMARY KEY (user_id, target_id, day)
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_a INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, -- initiator
    user_b INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    stage INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_msg_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conv_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    meaningful INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS feedback (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    rating INTEGER NOT NULL,
    would_join TEXT NOT NULL,
    best_moment TEXT NOT NULL DEFAULT '',
    change_text TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- One active "status of the day" per user; text-only, expires 24h after posting.
  CREATE TABLE IF NOT EXISTS statuses (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// ---- lightweight migrations (add columns to existing DBs) ----
function ensureColumn(table, column, decl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
}
ensureColumn('users', 'about', "TEXT NOT NULL DEFAULT ''");
ensureColumn('users', 'prompt1_q', "TEXT NOT NULL DEFAULT 'Top 3 movies or songs'");
ensureColumn('users', 'prompt2_q', "TEXT NOT NULL DEFAULT 'My simple pleasure'");
ensureColumn('users', 'prompt3_q', "TEXT NOT NULL DEFAULT 'We''ll get along if'");
ensureColumn('conversations', 'closed', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('conversations', 'closed_by', 'INTEGER');
ensureColumn('conversations', 'closed_at', 'TEXT');
ensureColumn('conversations', 'closed_kind', "TEXT NOT NULL DEFAULT 'pause'"); // pause (reopenable) | soft (kind, final)
ensureColumn('conversations', 'activated_at', 'TEXT');
ensureColumn('conversations', 'parallel_a', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('conversations', 'parallel_b', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('conversations', 'match_a', 'INTEGER'); // NULL undecided · 1 yes · 0 no
ensureColumn('conversations', 'match_b', 'INTEGER');
ensureColumn('messages', 'kind', "TEXT NOT NULL DEFAULT 'text'"); // text | voice

const CONFIG_DEFAULTS = {
  matching_open: '0',
  profiles_per_day: '10',
  openers_per_day: '3',
  msgs_per_chat_per_day: '30',
  inbox_cap_per_day: '5',
  expiry_enabled: '0',
  expiry_hours: '24',
};

function ensureConfigDefaults() {
  const ins = db.prepare('INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(CONFIG_DEFAULTS)) ins.run(k, v);
}
ensureConfigDefaults();

function getConfig() {
  const rows = db.prepare('SELECT key, value FROM config').all();
  const cfg = {};
  for (const r of rows) cfg[r.key] = r.value;
  return {
    matchingOpen: cfg.matching_open === '1',
    profilesPerDay: parseInt(cfg.profiles_per_day, 10),
    openersPerDay: parseInt(cfg.openers_per_day, 10),
    msgsPerChatPerDay: parseInt(cfg.msgs_per_chat_per_day, 10),
    inboxCapPerDay: parseInt(cfg.inbox_cap_per_day, 10),
    expiryEnabled: cfg.expiry_enabled === '1',
    expiryHours: parseInt(cfg.expiry_hours, 10),
  };
}

function setConfig(key, value) {
  db.prepare('INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

module.exports = { db, getConfig, setConfig, ensureConfigDefaults, today, CONFIG_DEFAULTS };
