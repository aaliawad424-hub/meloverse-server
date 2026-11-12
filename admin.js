'use strict';
const express = require('express');
const path = require('path');
const { db, getSettings, setSetting, log, DATA_DIR } = require('../db');
const A = require('../auth');
const jobs = require('../jobs');

const r = express.Router();
const admin = A.adminOnly;
const staff = A.staff;

r.use(A.required, staff);

/* ----------------------------- stats ----------------------------- */
r.get('/stats', (_req, res) => {
  const c = (sql) => db.prepare(sql).get().c;
  const byRole = db.prepare('SELECT role, COUNT(*) c FROM users GROUP BY role').all();
  res.json({
    users: c('SELECT COUNT(*) c FROM users'),
    moderators: c("SELECT COUNT(*) c FROM users WHERE role='moderator'"),
    series: c('SELECT COUNT(*) c FROM series'),
    chapters: c('SELECT COUNT(*) c FROM chapters'),
    comments: c('SELECT COUNT(*) c FROM comments WHERE hidden=0'),
    open_reports: c("SELECT COUNT(*) c FROM reports WHERE status='open'"),
    sources: c('SELECT COUNT(*) c FROM sources'),
    active_sources: c('SELECT COUNT(*) c FROM sources WHERE enabled=1'),
    downloads: c('SELECT COUNT(*) c FROM downloads'),
    byRole,
    settings: getSettings(),
    jobs: db.prepare('SELECT * FROM jobs ORDER BY id DESC LIMIT 8').all()
  });
});

/* ----------------------------- users ----------------------------- */
r.get('/users', (req, res) => {
  const q = `%${req.query.q || ''}%`;
  const rows = db.prepare(`SELECT id,username,email,role,verified,status,ban_until,created_at,read_today,dl_today
    FROM users WHERE username LIKE ? OR email LIKE ? ORDER BY id DESC LIMIT 200`).all(q, q);
  res.json({ items: rows });
});

r.post('/users/:id/role', admin, (req, res) => {
  const { role, verified } = req.body || {};
  if (!['user', 'moderator', 'admin'].includes(role)) return res.status(400).json({ error: 'دور غير صالح' });
  db.prepare('UPDATE users SET role=?, verified=? WHERE id=?').run(role, verified ? 1 : 0, req.params.id);
  if (role !== 'user' && !verified) db.prepare('UPDATE users SET verified=1 WHERE id=?').run(req.params.id);
  log(req.user.id, 'user.role', `${req.params.id} -> ${role}`);
  res.json({ ok: true });
});

r.post('/users/:id/ban', staff, (req, res) => {
  const days = Number(req.body && req.body.days) || 0;
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'المستخدم غير موجود' });
  if (user.role === 'admin') return res.status(400).json({ error: 'لا يمكن حظر أدمن' });
  const until = days > 0 ? new Date(Date.now() + days * 864e5).toISOString() : null;
  db.prepare("UPDATE users SET status='banned', ban_until=? WHERE id=?").run(until, user.id);
  log(req.user.id, 'user.ban', `${user.email} ${days ? days + 'd' : 'forever'}`);
  res.json({ ok: true, ban_until: until });
});

r.post('/users/:id/unban', staff, (req, res) => {
  db.prepare("UPDATE users SET status='active', ban_until=NULL WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

/* ---------------------------- sources ---------------------------- */
r.get('/sources', (_req, res) => {
  const items = db.prepare(`SELECT s.*, (SELECT COUNT(*) FROM series x WHERE x.source_id=s.id) AS series_count
    FROM sources s ORDER BY s.id DESC`).all();
  res.json({ items });
});

r.post('/sources', admin, (req, res) => {
  const { name, base_url, adapter = 'auto', type = 'manga', config } = req.body || {};
  if (!name || !base_url) return res.status(400).json({ error: 'اسم المصدر والرابط مطلوبان' });
  if (!/^https?:\/\//i.test(base_url)) return res.status(400).json({ error: 'الرابط يجب أن يبدأ بـ http(s)' });
  const info = db.prepare('INSERT INTO sources (name,base_url,adapter,type,config) VALUES (?,?,?,?,?)')
    .run(String(name).slice(0, 100), base_url.replace(/\/$/, ''), adapter, type, JSON.stringify(config || {}));
  log(req.user.id, 'source.add', `${name} ${base_url}`);
  res.json({ source: db.prepare('SELECT * FROM sources WHERE id=?').get(info.lastInsertRowid) });
});

r.patch('/sources/:id', admin, (req, res) => {
  const s = db.prepare('SELECT * FROM sources WHERE id=?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'المصدر غير موجود' });
  const { name = s.name, base_url = s.base_url, adapter = s.adapter, type = s.type, enabled = s.enabled,
    config = JSON.parse(s.config || '{}') } = req.body || {};
  db.prepare('UPDATE sources SET name=?,base_url=?,adapter=?,type=?,enabled=?,config=? WHERE id=?')
    .run(name, base_url, adapter, type, enabled ? 1 : 0, JSON.stringify(config), s.id);
  res.json({ ok: true });
});

r.delete('/sources/:id', admin, (req, res) => {
  db.prepare('DELETE FROM sources WHERE id=?').run(req.params.id);
  log(req.user.id, 'source.delete', String(req.params.id));
  res.json({ ok: true, note: 'حُذف المصدر وأعماله، بيانات المستخدمين وقوائمهم لم تتأثر' });
});

r.post('/sources/:id/test', admin, (req, res) => res.json({ job: jobs.enqueue('source-test', { sourceId: Number(req.params.id) }) }));

/* ------------------------- scraping jobs ------------------------- */
r.post('/scrape', admin, (req, res) => {
  const { sourceId = null, count = 100, withChapters = true } = req.body || {};
  const allowed = [10, 50, 100, 500, 1000];
  const n = allowed.includes(Number(count)) ? Number(count) : 100;
  res.json({ job: jobs.enqueue('pull', { sourceId, count: n, withChapters }) });
});

r.post('/track', admin, (req, res) => {
  const { seriesId = null, limit = 40 } = req.body || {};
  res.json({ job: jobs.enqueue('track', { seriesId, limit }) });
});

r.get('/jobs', (_req, res) => res.json({ items: db.prepare('SELECT * FROM jobs ORDER BY id DESC LIMIT 40').all() }));

/* ------------------------ content control ------------------------ */
r.get('/series', (req, res) => {
  const q = `%${req.query.q || ''}%`;
  res.json({
    items: db.prepare(`SELECT s.id,s.title,s.cover,s.hidden,s.status,s.latest_chapter,src.name AS source_name,
      (SELECT COUNT(*) FROM chapters c WHERE c.series_id=s.id) AS chapters_count
      FROM series s LEFT JOIN sources src ON src.id=s.source_id
      WHERE s.title LIKE ? ORDER BY s.id DESC LIMIT 200`).all(q)
  });
});

r.post('/series/:id/hide', staff, (req, res) => {
  const hidden = req.body && req.body.hidden ? 1 : 0;
  db.prepare('UPDATE series SET hidden=? WHERE id=?').run(hidden, req.params.id);
  log(req.user.id, 'series.hide', `${req.params.id}=${hidden}`);
  res.json({ ok: true });
});

r.patch('/series/:id', staff, (req, res) => {
  const s = db.prepare('SELECT * FROM series WHERE id=?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'غير موجود' });
  const { title = s.title, description = s.description, category = s.category, type = s.type, status = s.status, cover = s.cover } = req.body || {};
  db.prepare('UPDATE series SET title=?,description=?,category=?,type=?,status=?,cover=? WHERE id=?')
    .run(title, description, category, type, status, cover, s.id);
  res.json({ ok: true });
});

r.delete('/series/:id', admin, (req, res) => {
  db.prepare('DELETE FROM series WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

r.get('/series/:id/chapters', staff, (req, res) => {
  res.json({ items: db.prepare('SELECT id,number,title,hidden,published_at FROM chapters WHERE series_id=? ORDER BY number DESC').all(req.params.id) });
});

r.post('/chapters/:id/hide', staff, (req, res) => {
  db.prepare('UPDATE chapters SET hidden=? WHERE id=?').run(req.body && req.body.hidden ? 1 : 0, req.params.id);
  res.json({ ok: true });
});

/* --------------------- comments & reports --------------------- */
r.get('/comments', (req, res) => {
  const filter = req.query.filter || 'all';
  const where = filter === 'reported' ? 'c.hidden=0 AND EXISTS (SELECT 1 FROM reports rp WHERE rp.target_type=\'comment\' AND rp.target_id=c.id AND rp.status=\'open\')'
    : filter === 'hidden' ? 'c.hidden=1' : '1=1';
  res.json({
    items: db.prepare(`SELECT c.*, u.username, u.verified, u.role, s.title AS series_title
      FROM comments c JOIN users u ON u.id=c.user_id LEFT JOIN series s ON s.id=c.series_id
      WHERE ${where} ORDER BY c.id DESC LIMIT 200`).all()
  });
});

r.post('/comments/:id/hide', staff, (req, res) => {
  db.prepare('UPDATE comments SET hidden=? WHERE id=?').run(req.body && req.body.hidden ? 1 : 0, req.params.id);
  res.json({ ok: true });
});

r.delete('/comments/:id', staff, (req, res) => {
  db.prepare('DELETE FROM comments WHERE id=? OR parent_id=?').run(req.params.id, req.params.id);
  res.json({ ok: true });
});

r.get('/reports', (_req, res) => {
  const items = db.prepare(`SELECT rp.*, u.username AS reporter,
      CASE rp.target_type WHEN 'comment' THEN (SELECT body FROM comments WHERE id=rp.target_id)
                          WHEN 'series'  THEN (SELECT title FROM series WHERE id=rp.target_id)
                          ELSE '' END AS preview
    FROM reports rp LEFT JOIN users u ON u.id=rp.user_id ORDER BY rp.id DESC LIMIT 200`).all();
  res.json({ items });
});

r.post('/reports/:id', staff, (req, res) => {
  const status = req.body && req.body.status === 'dismissed' ? 'dismissed' : 'resolved';
  db.prepare('UPDATE reports SET status=? WHERE id=?').run(status, req.params.id);
  res.json({ ok: true });
});

/* --------------------- settings & broadcast --------------------- */
r.get('/settings', staff, (_req, res) => res.json({ settings: getSettings() }));

r.put('/settings', admin, (req, res) => {
  const allowed = ['free_read_day', 'free_download_day', 'ad_read_reward', 'ad_download_reward',
    'ongoing_interval_min', 'daily_sync_count', 'daily_sync_hour', 'ads_enabled', 'site_name', 'privacy_policy'];
  for (const [k, v] of Object.entries(req.body || {})) if (allowed.includes(k)) setSetting(k, v);
  log(req.user.id, 'settings.update', JSON.stringify(req.body).slice(0, 400));
  res.json({ settings: getSettings() });
});

r.post('/broadcast', admin, (req, res) => {
  const { title, body = '', kind = 'system' } = req.body || {};
  if (!title) return res.status(400).json({ error: 'العنوان مطلوب' });
  db.prepare('INSERT INTO notifications (user_id,title,body,kind) VALUES (NULL,?,?,?)').run(String(title).slice(0, 200), String(body).slice(0, 2000), kind);
  log(req.user.id, 'broadcast', title);
  res.json({ ok: true });
});

r.get('/backup', admin, (req, res) => {
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (_) {}
  log(req.user.id, 'backup', 'download');
  res.download(path.join(DATA_DIR, 'meloverse.db'), `meloverse-backup-${new Date().toISOString().slice(0, 10)}.db`);
});

r.get('/logs', admin, (_req, res) => res.json({ items: db.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT 200').all() }));

module.exports = r;
