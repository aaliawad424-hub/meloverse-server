'use strict';
const express = require('express');
const { db, getSettings } = require('../db');
const A = require('../auth');
const q = require('../quota');
const engine = require('../scraper/engine');

const r = express.Router();
const LISTS = ['favorite', 'reading', 'later', 'read'];
const SERIES_COLS = `s.id, s.title, s.cover, s.description, s.category, s.type, s.status,
  s.latest_chapter, s.updated_at, s.source_id, src.name AS source_name,
  (SELECT COUNT(*) FROM chapters c WHERE c.series_id=s.id AND c.hidden=0) AS chapters_count`;

function listOf(userId, list) {
  return db.prepare(`SELECT ${SERIES_COLS}, l.added_at FROM library l JOIN series s ON s.id=l.series_id
    LEFT JOIN sources src ON src.id=s.source_id
    WHERE l.user_id=? AND l.list=? AND s.hidden=0 ORDER BY l.added_at DESC`).all(userId, list);
}

r.get('/library', A.required, (req, res) => {
  const out = {};
  for (const l of LISTS) out[l] = listOf(req.user.id, l);
  res.json(out);
});

r.get('/library/:list', A.required, (req, res) => {
  if (!LISTS.includes(req.params.list)) return res.status(400).json({ error: 'قائمة غير معروفة' });
  res.json({ items: listOf(req.user.id, req.params.list) });
});

r.post('/library', A.required, (req, res) => {
  const { seriesId, list = 'favorite' } = req.body || {};
  if (!LISTS.includes(list)) return res.status(400).json({ error: 'قائمة غير معروفة' });
  if (!db.prepare('SELECT id FROM series WHERE id=?').get(seriesId)) return res.status(404).json({ error: 'العمل غير موجود' });
  db.prepare('INSERT OR IGNORE INTO library (user_id,series_id,list) VALUES (?,?,?)').run(req.user.id, seriesId, list);
  res.json({ ok: true, lists: db.prepare('SELECT list FROM library WHERE user_id=? AND series_id=?').all(req.user.id, seriesId).map((x) => x.list) });
});

r.post('/library/toggle', A.required, (req, res) => {
  const { seriesId, list = 'favorite' } = req.body || {};
  if (!LISTS.includes(list)) return res.status(400).json({ error: 'قائمة غير معروفة' });
  const has = db.prepare('SELECT 1 FROM library WHERE user_id=? AND series_id=? AND list=?').get(req.user.id, seriesId, list);
  if (has) db.prepare('DELETE FROM library WHERE user_id=? AND series_id=? AND list=?').run(req.user.id, seriesId, list);
  else db.prepare('INSERT INTO library (user_id,series_id,list) VALUES (?,?,?)').run(req.user.id, seriesId, list);
  res.json({ ok: true, active: !has });
});

r.delete('/library/:list/:seriesId', A.required, (req, res) => {
  db.prepare('DELETE FROM library WHERE user_id=? AND series_id=? AND list=?').run(req.user.id, req.params.seriesId, req.params.list);
  res.json({ ok: true });
});

/* ------------------------- downloads ------------------------- */
r.get('/downloads', A.required, (req, res) => {
  const items = db.prepare(`SELECT d.chapter_id, d.created_at, c.number, c.title, s.id AS series_id, s.title AS series_title, s.cover
    FROM downloads d JOIN chapters c ON c.id=d.chapter_id JOIN series s ON s.id=d.series_id
    WHERE d.user_id=? ORDER BY d.created_at DESC`).all(req.user.id);
  res.json({ items, quota: q.state(req.user) });
});

r.post('/downloads/:chapterId', A.required, async (req, res) => {
  const ch = db.prepare('SELECT * FROM chapters WHERE id=?').get(req.params.chapterId);
  if (!ch) return res.status(404).json({ error: 'الفصل غير موجود' });
  const already = db.prepare('SELECT 1 FROM downloads WHERE user_id=? AND chapter_id=?').get(req.user.id, ch.id);
  if (!already) {
    const c = q.consume(req.user.id, 'download');
    if (!c.ok) return res.status(402).json({ error: 'وصلت لحد التحميل اليومي', code: 'LIMIT', quota: q.state(req.user) });
    db.prepare('INSERT OR IGNORE INTO downloads (user_id,chapter_id,series_id) VALUES (?,?,?)').run(req.user.id, ch.id, ch.series_id);
  }
  let pages = [];
  try { pages = await engine.chapterPages(ch.id); } catch (_) {}
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  res.json({ ok: true, pages, quota: q.state(u) });
});

r.delete('/downloads/:chapterId', A.required, (req, res) => {
  db.prepare('DELETE FROM downloads WHERE user_id=? AND chapter_id=?').run(req.user.id, req.params.chapterId);
  res.json({ ok: true });
});

/* --------------------- notifications / ads -------------------- */
r.get('/notifications', A.required, (req, res) => {
  const items = db.prepare(`SELECT * FROM notifications WHERE user_id IS NULL OR user_id=? ORDER BY id DESC LIMIT 80`).all(req.user.id);
  res.json({ items, unread: items.filter((n) => !n.read_at).length });
});

r.post('/notifications/read', A.required, (req, res) => {
  const ids = (req.body && req.body.ids) || null;
  if (Array.isArray(ids) && ids.length) {
    const st = db.prepare("UPDATE notifications SET read_at=datetime('now') WHERE id=? AND (user_id IS NULL OR user_id=?)");
    for (const id of ids) st.run(id, req.user.id);
  } else {
    db.prepare("UPDATE notifications SET read_at=datetime('now') WHERE user_id=? AND read_at IS NULL").run(req.user.id);
  }
  res.json({ ok: true });
});

r.get('/limits', A.required, (req, res) => res.json({ quota: q.state(req.user), settings: pickSettings() }));

function pickSettings() {
  const s = getSettings();
  return { site_name: s.site_name, ads_enabled: s.ads_enabled === '1', privacy_policy: s.privacy_policy };
}

/** Rewarded ad -> extra daily balance. Swap the client view for AdMob/StartApp later. */
r.post('/ads/reward', A.required, (req, res) => {
  const kind = req.body && req.body.kind === 'download' ? 'download' : 'read';
  const s = getSettings();
  if (s.ads_enabled !== '1') return res.status(400).json({ error: 'الإعلانات غير مفعّلة' });
  res.json(q.reward(req.user.id, kind));
});

module.exports = r;
