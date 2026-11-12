'use strict';
/** Daily limits (free reads / downloads) + ad rewards. */
const { db, getSettings } = require('./db');

const today = () => new Date().toISOString().slice(0, 10);

function refresh(u) {
  if (!u) return u;
  if (u.quota_date !== today()) {
    db.prepare('UPDATE users SET quota_date=?, read_today=0, dl_today=0 WHERE id=?').run(today(), u.id);
    u.quota_date = today(); u.read_today = 0; u.dl_today = 0;
  }
  return u;
}

function state(u) {
  refresh(u);
  const s = getSettings();
  return {
    read_limit: Number(s.free_read_day), read_used: u.read_today, read_bonus: u.ad_credits,
    dl_limit: Number(s.free_download_day), dl_used: u.dl_today, dl_bonus: u.dl_bonus,
    ads_enabled: s.ads_enabled === '1'
  };
}

/** kind: 'read' | 'download'. Returns {ok, needsAd}. */
function consume(userId, kind) {
  const u = refresh(db.prepare('SELECT * FROM users WHERE id=?').get(userId));
  const s = getSettings();
  const limit = Number(kind === 'read' ? s.free_read_day : s.free_download_day);
  const usedCol = kind === 'read' ? 'read_today' : 'dl_today';
  const bonusCol = kind === 'read' ? 'ad_credits' : 'dl_bonus';
  const used = u[usedCol], bonus = u[bonusCol];

  if (used < limit) {
    db.prepare(`UPDATE users SET ${usedCol}=${usedCol}+1 WHERE id=?`).run(userId);
    return { ok: true, source: 'free', remaining: limit - used - 1, bonus };
  }
  if (bonus > 0) {
    db.prepare(`UPDATE users SET ${bonusCol}=${bonusCol}-1, ${usedCol}=${usedCol}+1 WHERE id=?`).run(userId);
    return { ok: true, source: 'ad', remaining: 0, bonus: bonus - 1 };
  }
  return { ok: false, needsAd: s.ads_enabled === '1', limit, used, bonus: 0 };
}

function reward(userId, kind) {
  const s = getSettings();
  const col = kind === 'download' ? 'dl_bonus' : 'ad_credits';
  const amount = Number(kind === 'download' ? s.ad_download_reward : s.ad_read_reward);
  db.prepare(`UPDATE users SET ${col}=${col}+? WHERE id=?`).run(amount, userId);
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
  return { ok: true, added: amount, state: state(u) };
}

module.exports = { state, consume, reward, refresh, today };
