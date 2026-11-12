'use strict';
const express = require('express');
const { db } = require('../db');
const A = require('../auth');
const q = require('../quota');

const r = express.Router();

r.post('/register', (req, res) => {
  const { username, email, password } = req.body || {};
  if (!username || !email || !password) return res.status(400).json({ error: 'كل الحقول مطلوبة' });
  if (String(password).length < 6) return res.status(400).json({ error: 'كلمة المرور 6 أحرف على الأقل' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'بريد غير صالح' });
  if (db.prepare('SELECT id FROM users WHERE lower(email)=lower(?)').get(email))
    return res.status(409).json({ error: 'البريد مسجّل مسبقاً' });

  const info = db.prepare('INSERT INTO users (username,email,password_hash) VALUES (?,?,?)')
    .run(String(username).slice(0, 40), email, A.hash(password));
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(info.lastInsertRowid);
  db.prepare('INSERT INTO notifications (user_id,title,body,kind) VALUES (?,?,?,?)')
    .run(user.id, 'مرحباً بك في MeloVerse', 'ابدأ بإضافة أعمال إلى المفضلة وسجّل قراءتك تلقائياً.', 'system');
  res.json({ token: A.sign(user), user: { ...A.publicUser(user), quota: q.state(user) } });
});

r.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE lower(email)=lower(?)').get(String(email || ''));
  if (!user || !A.verify(String(password || ''), user.password_hash))
    return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });
  if (user.status === 'banned') {
    if (user.ban_until && new Date(user.ban_until) < new Date()) {
      db.prepare("UPDATE users SET status='active', ban_until=NULL WHERE id=?").run(user.id);
    } else {
      return res.status(403).json({
        error: user.ban_until ? `حسابك محظور حتى ${user.ban_until}` : 'حسابك محظور نهائياً'
      });
    }
  }
  const fresh = db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
  res.json({ token: A.sign(fresh), user: { ...A.publicUser(fresh), quota: q.state(fresh) } });
});

r.get('/me', A.required, (req, res) => {
  res.json({ user: { ...A.publicUser(req.user), quota: q.state(req.user) } });
});

r.patch('/me', A.required, (req, res) => {
  const { username, avatar, password, current_password } = req.body || {};
  if (username) db.prepare('UPDATE users SET username=? WHERE id=?').run(String(username).slice(0, 40), req.user.id);
  if (avatar !== undefined) db.prepare('UPDATE users SET avatar=? WHERE id=?').run(String(avatar).slice(0, 500), req.user.id);
  if (password) {
    if (!A.verify(String(current_password || ''), req.user.password_hash))
      return res.status(400).json({ error: 'كلمة المرور الحالية غير صحيحة' });
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(A.hash(password), req.user.id);
  }
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  res.json({ user: { ...A.publicUser(u), quota: q.state(u) } });
});

module.exports = r;
