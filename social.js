'use strict';
const express = require('express');
const { db } = require('../db');
const A = require('../auth');

const r = express.Router();

const AUTHOR = `u.id AS user_id, u.username, u.avatar, u.role, u.verified`;

r.get('/series/:id/comments', A.optional, (req, res) => {
  const chapterId = req.query.chapterId ? Number(req.query.chapterId) : null;
  const rows = db.prepare(`SELECT c.*, ${AUTHOR} FROM comments c JOIN users u ON u.id=c.user_id
    WHERE c.series_id=? AND ${chapterId ? 'c.chapter_id=?' : 'c.chapter_id IS NULL'} AND c.hidden=0
    ORDER BY c.id DESC LIMIT 300`).all(...(chapterId ? [req.params.id, chapterId] : [req.params.id]));
  const roots = rows.filter((c) => !c.parent_id);
  const map = new Map(roots.map((c) => [c.id, { ...shape(c), replies: [] }]));
  for (const c of rows) if (c.parent_id && map.has(c.parent_id)) map.get(c.parent_id).replies.push(shape(c));
  res.json({ items: [...map.values()] });
});

function shape(c) {
  return {
    id: c.id, body: c.body, spoiler: !!c.spoiler, created_at: c.created_at, parent_id: c.parent_id,
    user: { id: c.user_id, username: c.username, avatar: c.avatar, role: c.role, verified: !!c.verified }
  };
}

r.post('/comments', A.required, (req, res) => {
  const { seriesId, chapterId = null, body, spoiler = false, parentId = null } = req.body || {};
  const text = String(body || '').trim();
  if (!text) return res.status(400).json({ error: 'التعليق فارغ' });
  if (text.length > 2000) return res.status(400).json({ error: 'التعليق طويل جداً' });
  if (!db.prepare('SELECT id FROM series WHERE id=?').get(seriesId)) return res.status(404).json({ error: 'العمل غير موجود' });
  const info = db.prepare(`INSERT INTO comments (series_id,chapter_id,user_id,parent_id,body,spoiler)
    VALUES (?,?,?,?,?,?)`).run(seriesId, chapterId, req.user.id, parentId, text, spoiler ? 1 : 0);
  const row = db.prepare(`SELECT c.*, ${AUTHOR} FROM comments c JOIN users u ON u.id=c.user_id WHERE c.id=?`).get(info.lastInsertRowid);
  res.json({ comment: shape(row) });
});

r.delete('/comments/:id', A.required, (req, res) => {
  const c = db.prepare('SELECT * FROM comments WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'غير موجود' });
  if (c.user_id !== req.user.id && !['admin', 'moderator'].includes(req.user.role))
    return res.status(403).json({ error: 'لا تملك الصلاحية' });
  db.prepare('DELETE FROM comments WHERE id=? OR parent_id=?').run(c.id, c.id);
  res.json({ ok: true });
});

r.post('/reports', A.required, (req, res) => {
  const { targetType, targetId, reason = '' } = req.body || {};
  if (!['comment', 'series', 'chapter', 'source'].includes(targetType))
    return res.status(400).json({ error: 'نوع بلاغ غير صالح' });
  db.prepare('INSERT INTO reports (target_type,target_id,user_id,reason) VALUES (?,?,?,?)')
    .run(targetType, targetId, req.user.id, String(reason).slice(0, 500));
  res.json({ ok: true, message: 'تم إرسال البلاغ للمراجعة' });
});

r.get('/me/comments', A.required, (req, res) => {
  const rows = db.prepare(`SELECT c.*, s.title AS series_title FROM comments c JOIN series s ON s.id=c.series_id
    WHERE c.user_id=? ORDER BY c.id DESC LIMIT 100`).all(req.user.id);
  res.json({ items: rows });
});

module.exports = r;
