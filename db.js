'use strict';
/**
 * MeloVerse — database layer
 * SQLite (file based, WAL). Zero external services => free tier friendly and
 * stable for years. All user data lives in independable tables, so admins can
 * delete sources / series / chapters without touching accounts or libraries.
 */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'meloverse.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL,
  email         TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  avatar        TEXT    DEFAULT '',
  role          TEXT    NOT NULL DEFAULT 'user',      -- user | moderator | admin
  verified      INTEGER NOT NULL DEFAULT 0,
  status        TEXT    NOT NULL DEFAULT 'active',    -- active | banned
  ban_until     TEXT,                                 -- NULL + banned = permanent
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  quota_date    TEXT    DEFAULT '',
  read_today    INTEGER NOT NULL DEFAULT 0,
  dl_today      INTEGER NOT NULL DEFAULT 0,
  ad_credits    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sources (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  base_url   TEXT    NOT NULL,
  adapter    TEXT    NOT NULL DEFAULT 'auto',         -- auto | mangadex | madara | generic
  type       TEXT    NOT NULL DEFAULT 'manga',        -- manga | manhwa | manhua
  enabled    INTEGER NOT NULL DEFAULT 1,
  config     TEXT    NOT NULL DEFAULT '{}',
  last_sync  TEXT,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS series (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id      INTEGER REFERENCES sources(id) ON DELETE SET NULL,
  source_ref     TEXT,
  title          TEXT    NOT NULL,
  cover          TEXT    DEFAULT '',
  description    TEXT    DEFAULT '',
  category       TEXT    DEFAULT '',
  type           TEXT    DEFAULT 'manga',
  status         TEXT    DEFAULT 'ongoing',           -- ongoing | completed
  hidden         INTEGER NOT NULL DEFAULT 0,
  latest_chapter REAL    NOT NULL DEFAULT 0,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_series_src ON series(source_id, source_ref);
CREATE INDEX IF NOT EXISTS idx_series_upd ON series(updated_at DESC);

CREATE TABLE IF NOT EXISTS chapters (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  series_id    INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  number       REAL    NOT NULL,
  title        TEXT    DEFAULT '',
  url          TEXT    DEFAULT '',
  hidden       INTEGER NOT NULL DEFAULT 0,
  published_at TEXT    DEFAULT (datetime('now')),
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_chapter_uniq ON chapters(series_id, number);

CREATE TABLE IF NOT EXISTS library (
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  series_id INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  list     TEXT    NOT NULL,                          -- favorite | reading | later | read
  added_at TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, series_id, list)
);

CREATE TABLE IF NOT EXISTS history (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  series_id  INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  chapter_id INTEGER,
  progress   INTEGER NOT NULL DEFAULT 0,              -- last page index
  read_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, series_id)
);

CREATE TABLE IF NOT EXISTS downloads (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chapter_id INTEGER NOT NULL,
  series_id  INTEGER NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, chapter_id)
);

CREATE TABLE IF NOT EXISTS comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  series_id  INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  chapter_id INTEGER,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id  INTEGER,
  body       TEXT    NOT NULL,
  spoiler    INTEGER NOT NULL DEFAULT 0,
  hidden     INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_comments_series ON comments(series_id, chapter_id);

CREATE TABLE IF NOT EXISTS reports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type TEXT    NOT NULL,                       -- comment | series | chapter | source
  target_id   INTEGER NOT NULL,
  user_id     INTEGER,
  reason      TEXT    DEFAULT '',
  status      TEXT    NOT NULL DEFAULT 'open',        -- open | resolved | dismissed
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER,                                 -- NULL = broadcast
  title      TEXT    NOT NULL,
  body       TEXT    DEFAULT '',
  kind       TEXT    DEFAULT 'system',
  read_at    TEXT,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS jobs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT    NOT NULL,                        -- pull | track | daily
  source_id  INTEGER,
  status     TEXT    NOT NULL DEFAULT 'queued',       -- queued | running | done | error
  total      INTEGER NOT NULL DEFAULT 0,
  done       INTEGER NOT NULL DEFAULT 0,
  message    TEXT    DEFAULT '',
  payload    TEXT    DEFAULT '{}',
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id   INTEGER,
  action     TEXT NOT NULL,
  detail     TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

/* --- lightweight migrations (safe to run on every boot) --- */
for (const stmt of [
  "ALTER TABLE users ADD COLUMN dl_bonus INTEGER NOT NULL DEFAULT 0"
]) {
  try { db.exec(stmt); } catch (_) { /* column already exists */ }
}

const DEFAULT_SETTINGS = {
  free_read_day: '100',
  free_download_day: '5',
  ad_read_reward: '10',
  ad_download_reward: '1',
  ongoing_interval_min: '30',
  daily_sync_count: '100',
  daily_sync_hour: '3',
  ads_enabled: '1',
  site_name: 'MeloVerse',
  privacy_policy: 'MeloVerse لا يجمع بيانات أكثر من اللازم: نحفظ البريد الإلكتروني وكلمة المرور المشفرة وقوائمك وسجل قراءتك فقط، ولا نبيعها لأي طرف ثالث. يمكنك طلب حذف حسابك في أي وقت من صفحة الإعدادات.'
};

const settingStmt = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) settingStmt.run(k, v);

function getSettings() {
  const out = {};
  for (const row of db.prepare('SELECT key, value FROM settings').all()) out[row.key] = row.value;
  return out;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, String(value));
}
function log(actorId, action, detail = '') {
  db.prepare('INSERT INTO logs (actor_id, action, detail) VALUES (?,?,?)').run(actorId, action, detail);
}

module.exports = { db, getSettings, setSetting, log, DATA_DIR };
