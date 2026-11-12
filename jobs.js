'use strict';
/**
 * In-process job queue + scheduler.
 * No Redis / no worker dyno => runs on the smallest free container.
 * Jobs survive restarts because every job row lives in SQLite.
 */
const { db, getSettings, setSetting, log } = require('./db');
const engine = require('./scraper/engine');

let running = false;

function enqueue(kind, payload = {}) {
  const info = db.prepare("INSERT INTO jobs (kind, source_id, payload, message) VALUES (?,?,?,?)")
    .run(kind, payload.sourceId || null, JSON.stringify(payload), 'في الانتظار');
  setImmediate(processQueue);
  return db.prepare('SELECT * FROM jobs WHERE id=?').get(info.lastInsertRowid);
}

const upd = db.prepare('UPDATE jobs SET status=?, total=?, done=?, message=?, finished_at=? WHERE id=?');

async function processQueue() {
  if (running) return;
  running = true;
  try {
    for (;;) {
      const job = db.prepare("SELECT * FROM jobs WHERE status='queued' ORDER BY id LIMIT 1").get();
      if (!job) break;
      const payload = JSON.parse(job.payload || '{}');
      upd.run('running', 0, 0, 'جارٍ التنفيذ', null, job.id);
      try {
        if (job.kind === 'pull' || job.kind === 'daily') {
          const count = Number(payload.count || 100);
          const ids = payload.sourceId
            ? [payload.sourceId]
            : db.prepare('SELECT id FROM sources WHERE enabled=1').all().map((r) => r.id);
          let total = count * ids.length;
          let doneSum = 0;
          const parts = [];
          for (const sid of ids) {
            const s = await engine.pullSource(sid, count, { withChapters: payload.withChapters !== false }, (p) => {
              upd.run('running', total, doneSum + p.done, p.message, null, job.id);
            });
            doneSum += s.series;
            parts.push(`${s.source}: ${s.series} عمل / ${s.chapters} فصل`);
            if (s.errors && s.errors.length) parts.push(`تنبيه: ${s.errors[0]}`);
          }
          upd.run('done', total, doneSum, parts.join(' • ') || 'لا نتائج', new Date().toISOString(), job.id);
        } else if (job.kind === 'track') {
          let ids;
          if (payload.seriesId) ids = [payload.seriesId];
          else {
            ids = db.prepare(`SELECT s.id FROM series s JOIN sources src ON src.id=s.source_id
                              WHERE src.enabled=1 AND s.hidden=0 AND s.status='ongoing'
                              ORDER BY s.updated_at ASC LIMIT ?`).all(Number(payload.limit || 25)).map((r) => r.id);
          }
          let added = 0, i = 0;
          for (const sid of ids) {
            const r = await engine.trackSeries(sid);
            added += r.added || 0; i++;
            upd.run('running', ids.length, i, `فحص ${i}/${ids.length} — ${added} فصل جديد`, null, job.id);
          }
          upd.run('done', ids.length, i, `${added} فصل جديد`, new Date().toISOString(), job.id);
        } else if (job.kind === 'source-test') {
          const src = db.prepare('SELECT * FROM sources WHERE id=?').get(payload.sourceId);
          const { resolveAdapter } = require('./scraper/adapters');
          const a = resolveAdapter(src);
          const items = await a.listSeries(src, { limit: 3 });
          upd.run('done', 3, items.length, `المحرك: ${a.id} — ${items.map((x) => x.title).join(' | ').slice(0, 300)}`,
            new Date().toISOString(), job.id);
        } else {
          upd.run('error', 0, 0, 'نوع مهمة غير معروف', new Date().toISOString(), job.id);
        }
      } catch (e) {
        upd.run('error', 0, 0, String(e.message || e).slice(0, 400), new Date().toISOString(), job.id);
        log(null, 'job.error', `${job.kind}: ${e.message}`);
      }
    }
  } finally {
    running = false;
  }
}

/** Background scheduler: ongoing tracking + daily pull. */
function startScheduler() {
  setInterval(async () => {
    const s = getSettings();
    const now = Date.now();

    // 1) ongoing tracking
    const lastTrack = Number(s._last_track || 0);
    if (now - lastTrack >= Number(s.ongoing_interval_min || 30) * 60 * 1000) {
      setSetting('_last_track', String(now));
      const busy = db.prepare("SELECT COUNT(*) c FROM jobs WHERE status IN ('queued','running')").get().c;
      if (!busy) enqueue('track', { limit: 40 });
    }

    // 2) daily pull
    const hour = new Date().getHours();
    const today = new Date().toISOString().slice(0, 10);
    if (hour === Number(s.daily_sync_hour || 3) && s._last_daily !== today) {
      setSetting('_last_daily', today);
      const busy = db.prepare("SELECT COUNT(*) c FROM jobs WHERE status IN ('queued','running')").get().c;
      if (!busy) enqueue('daily', { count: Number(s.daily_sync_count || 100) });
    }
  }, 60 * 1000).unref?.();
}

/** Reset jobs stuck in "running" after a redeploy. */
function recover() {
  db.prepare("UPDATE jobs SET status='error', message='توقف السيرفر أثناء التنفيذ' WHERE status='running'").run();
}

module.exports = { enqueue, processQueue, startScheduler, recover };
