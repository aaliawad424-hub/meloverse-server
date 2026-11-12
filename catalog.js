'use strict';
const express = require('express');
const { db, getSettings } = require('../db');
const A = require('../auth');
const q = require('../quota');
const engine = require('../scraper/engine');

const r = express.Router();

const SERIES_COLS = `s.id, s.title, s.cover, s.description, s.category, s.type, s.status,
  s.latest_chapter, s.updated_at, s.source_id, src.name AS source_name,
  (SELECT COUNT(*) FROM chapters c WHERE c.series_id=s.id AND c.hidden=0) AS chapters_count`;

function listSeries(where, params, order, limit, offset) {
  return db.prepare(`SELECT ${SERIES_COLS} FROM series s
    LEFT JOIN sources src ON src.id=s.source_id
    WHERE s.hidden=0 ${where ? 'AND ' + where : ''}
    ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params, limit, offset);
}
const clamp = (v, a, b, d) => Math.min(b, Math.max(a, Number(v) || d));

r.get('/home', A.optional, (req, res) => {
  const latest = listSeries('', [], 's.updated_at DESC', 18, 0);
  const fresh = listSeries('', [], 's.created_at DESC, s.id DESC', 18, 0);
  const popular = db.prepare(`SELECT ${SERIES_COLS}, COUNT(l.user_id) AS saves FROM series s
    LEFT JOIN sources src ON src.id=s.source_id
    LEFT JOIN library l ON l.series_id=s.id
    WHERE s.hidden=0 GROUP BY s.id ORDER BY saves DESC, s.latest_chapter DESC LIMIT 12`).all();
  let continueReading = [];
  if (req.user) {
    continueReading = db.prepare(`SELECT ${SERIES_COLS}, h.chapter_id, h.read_at, ch.number AS chapter_number
      FROM history h JOIN series s ON s.id=h.series_id LEFT JOIN chapters ch ON ch.id=h.chapter_id
      LEFT JOIN sources src ON src.id=s.source_id
      WHERE h.user_id=? AND s.hidden=0 ORDER BY h.read_at DESC LIMIT 10`).all(req.user.id);
  }
  res.json({ featured: popular.slice(0, 5), latest, fresh, popular, continueReading });
});

r.get('/series', A.optional, (req, res) => {
  const { query = '', type = '', category = '', sort = 'latest' } = req.query;
  const page = clamp(req.query.page, 1, 500, 1), per = clamp(req.query.per, 1, 60, 24);
  const w = []; const p = [];
  if (query) { w.push('(s.title LIKE ? OR s.description LIKE ? OR s.category LIKE ?)'); p.push(`%${query}%`, `%${query}%`, `%${query}%`); }
  if (type) { w.push('s.type = ?'); p.push(type); }
  if (category) { w.push('s.category LIKE ?'); p.push(`%${category}%`); }
  const order = { latest: 's.updated_at DESC', newest: 's.created_at DESC', popular: 'chapters_count DESC', title: 's.title ASC' }[sort] || 's.updated_at DESC';
  const where = w.join(' AND ');
  const rows = listSeries(where, p, order, per, (page - 1) * per);
  const total = db.prepare(`SELECT COUNT(*) c FROM series s WHERE s.hidden=0 ${where ? 'AND ' + where : ''}`).get(...p).c;
  res.json({ items: rows, total, page, per, pages: Math.ceil(total / per) });
});

r.get('/site', (_req, res) => {
  const s = getSettings();
  res.json({ settings: { site_name: s.site_name, privacy_policy: s.privacy_policy, ads_enabled: s.ads_enabled === '1' } });
});

r.get('/categories', (_req, res) => {
  const rows = db.prepare("SELECT category FROM series WHERE hidden=0 AND category<>'' LIMIT 4000").all();
  const map = new Map();
  for (const row of rows) for (const c of String(row.category).split(',').map((x) => x.trim()).filter(Boolean))
    map.set(c, (map.get(c) || 0) + 1);
  res.json({ items: [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([name, count]) => ({ name, count })) });
});

r.get('/series/:id', A.optional, (req, res) => {
  const s = db.prepare(`SELECT ${SERIES_COLS}, s.source_ref FROM series s LEFT JOIN sources src ON src.id=s.source_id WHERE s.id=?`).get(req.params.id);
  if (!s) return res.status(404).json({ error: 'العمل غير موجود' });
  if (!req.user || req.user.role === 'user') {
    const row = db.prepare('SELECT hidden FROM series WHERE id=?').get(s.id);
    if (row.hidden) return res.status(404).json({ error: 'العمل غير متاح' });
  }
  const chapters = db.prepare('SELECT id, number, title, published_at FROM chapters WHERE series_id=? AND hidden=0 ORDER BY number DESC').all(s.id);
  let mine = { lists: [], progress: null };
  if (req.user) {
    mine.lists = db.prepare('SELECT list FROM library WHERE user_id=? AND series_id=?').all(req.user.id, s.id).map((x) => x.list);
    mine.progress = db.prepare('SELECT chapter_id, progress FROM history WHERE user_id=? AND series_id=?').get(req.user.id, s.id) || null;
  }
  const comments = db.prepare("SELECT COUNT(*) c FROM comments WHERE series_id=? AND hidden=0").get(s.id).c;
  res.json({ series: s, chapters, mine, comments });
});

r.get('/recommendations', A.optional, (req, res) => {
  if (!req.user) return res.json({ items: listSeries('', [], 's.latest_chapter DESC, s.updated_at DESC', 18, 0), reason: 'الأكثر فصولاً' });
  const cats = db.prepare(`SELECT s.category FROM library l JOIN series s ON s.id=l.series_id WHERE l.user_id=? AND s.category<>'' LIMIT 20`).all(req.user.id);
  const terms = [...new Set(cats.flatMap((c) => String(c.category).split(',').map((x) => x.trim())).filter(Boolean))].slice(0, 6);
  if (!terms.length) return res.json({ items: listSeries('', [], 's.updated_at DESC', 18, 0), reason: 'الأحدث' });
  const where = terms.map(() => 's.category LIKE ?').join(' OR ');
  const items = listSeries(`(${where})`, terms.map((t) => `%${t}%`), 's.updated_at DESC', 18, 0);
  res.json({ items, reason: terms.join('، ') });
});

r.get('/chapters/:id', A.optional, (req, res) => {
  const ch = db.prepare(`SELECT c.id, c.series_id, c.number, c.title, c.published_at, s.title AS series_title, s.cover
    FROM chapters c JOIN series s ON s.id=c.series_id WHERE c.id=?`).get(req.params.id);
  if (!ch) return res.status(404).json({ error: 'الفصل غير موجود' });
  const nav = db.prepare('SELECT id, number FROM chapters WHERE series_id=? AND hidden=0 ORDER BY number ASC').all(ch.series_id);
  const i = nav.findIndex((x) => x.id === ch.id);
  res.json({ chapter: ch, prev: nav[i - 1] || null, next: nav[i + 1] || null, quota: req.user ? q.state(req.user) : null });
});

/** Reading a chapter consumes the daily quota (100/day by default). */
r.post('/chapters/:id/read', A.required, async (req, res) => {
  const ch = db.prepare(`SELECT c.*, s.hidden shidden FROM chapters c JOIN series s ON s.id=c.series_id WHERE c.id=?`).get(req.params.id);
  if (!ch || ch.hidden || ch.shidden) return res.status(404).json({ error: 'الفصل غير متاح' });

  const seen = db.prepare('SELECT 1 FROM history WHERE user_id=? AND chapter_id=?').get(req.user.id, ch.id);
  const quota = q.consume(req.user.id, 'read');
  if (!quota.ok && !seen) return res.status(402).json({ error: 'وصلت للحد اليومي', code: 'LIMIT', quota });

  db.prepare(`INSERT INTO history (user_id, series_id, chapter_id, progress, read_at) VALUES (?,?,?,0,datetime('now'))
    ON CONFLICT(user_id,series_id) DO UPDATE SET chapter_id=excluded.chapter_id, read_at=datetime('now')`)
    .run(req.user.id, ch.series_id, ch.id);
  db.prepare("INSERT OR IGNORE INTO library (user_id,series_id,list) VALUES (?,?,'reading')").run(req.user.id, ch.series_id);

  try {
    const pages = await engine.chapterPages(ch.id);
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
    res.json({ pages, quota: q.state(u), images_cached: pages.length });
  } catch (e) {
    res.status(502).json({ error: 'تعذّر جلب صفحات الفصل من المصدر', detail: e.message });
  }
});

r.get('/history', A.required, (req, res) => {
  const rows = db.prepare(`SELECT ${SERIES_COLS}, h.chapter_id, h.read_at, ch.number AS chapter_number
    FROM history h JOIN series s ON s.id=h.series_id LEFT JOIN chapters ch ON ch.id=h.chapter_id
    LEFT JOIN sources src ON src.id=s.source_id
    WHERE h.user_id=? ORDER BY h.read_at DESC LIMIT 200`).all(req.user.id);
  res.json({ items: rows });
});

module.exports = r;
