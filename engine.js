'use strict';
/**
 * Scraper engine — turns any registered source into DB rows.
 * Guarantees: user data is never touched here (different tables), so deleting
 * or re-syncing a source cannot break accounts, libraries or history.
 */
const { db, log } = require('../db');
const { resolveAdapter, generic } = require('./adapters');

const upsertSeries = db.prepare(`
  INSERT INTO series (source_id, source_ref, title, cover, description, category, type, status, updated_at)
  VALUES (@source_id, @source_ref, @title, @cover, @description, @category, @type, @status, datetime('now'))
  ON CONFLICT(source_id, source_ref) DO UPDATE SET
    title       = CASE WHEN excluded.title <> '' THEN excluded.title ELSE series.title END,
    cover       = CASE WHEN excluded.cover <> '' THEN excluded.cover ELSE series.cover END,
    description = CASE WHEN length(excluded.description) > length(series.description) THEN excluded.description ELSE series.description END,
    category    = CASE WHEN excluded.category <> '' THEN excluded.category ELSE series.category END,
    status      = excluded.status,
    updated_at  = datetime('now')
`);
const findSeries = db.prepare('SELECT * FROM series WHERE source_id=? AND source_ref=?');
const insertChapter = db.prepare(`
  INSERT OR IGNORE INTO chapters (series_id, number, title, url, published_at)
  VALUES (?,?,?,?, datetime('now'))
`);
const maxChapter = db.prepare('SELECT MAX(number) m FROM chapters WHERE series_id=?');

function saveSeries(source, item) {
  const row = {
    source_id: source.id,
    source_ref: String(item.ref),
    title: (item.title || '').slice(0, 300) || 'بدون عنوان',
    cover: item.cover || '',
    description: (item.description || '').slice(0, 8000),
    category: (item.category || '').slice(0, 300),
    type: item.type || source.type || 'manga',
    status: item.status === 'completed' ? 'completed' : 'ongoing'
  };
  upsertSeries.run(row);
  return findSeries.get(source.id, row.source_ref);
}

function saveChapters(seriesId, list) {
  let added = 0;
  const tx = db.transaction((rows) => {
    for (const c of rows) {
      const r = insertChapter.run(seriesId, Number(c.number) || 0, (c.title || '').slice(0, 200), c.url || '');
      if (r.changes) added++;
    }
  });
  tx(list);
  const m = maxChapter.get(seriesId).m || 0;
  db.prepare('UPDATE series SET latest_chapter=?, updated_at=datetime(\'now\') WHERE id=?').run(m, seriesId);
  return added;
}

/** Pull `count` series (cover, description, category, all chapters) from one source. */
async function pullSource(sourceId, count, opts = {}, onProgress = () => {}) {
  const source = db.prepare('SELECT * FROM sources WHERE id=?').get(sourceId);
  if (!source || !source.enabled) throw new Error('المصدر غير موجود أو معطّل');
  const adapter = resolveAdapter(source);
  const cfg = safeJson(source.config);
  const perRequest = Math.min(100, Math.max(1, Number(cfg.per_page || 100)));
  const stats = { source: source.name, adapter: adapter.id, series: 0, chapters: 0, errors: [] };

  for (let offset = 0; offset < count; offset += perRequest) {
    const want = Math.min(perRequest, count - offset);
    let items = [];
    try {
      items = await adapter.listSeries(source, { limit: want, offset, page: Math.floor(offset / 20) + 1 });
    } catch (e) {
      stats.errors.push(`${adapter.id}: ${e.message}`);
      break;
    }
    if (!items.length) break;

    for (const item of items) {
      try {
        // Enrich with detail page when the adapter exposes it (title/cover/desc/genres)
        let enriched = item;
        if (adapter.detail && (!item.cover || !item.description)) {
          try { enriched = { ...item, ...(await adapter.detail(source, item.ref)) }; } catch (_) {}
        }
        const series = saveSeries(source, enriched);
        let added = 0;
        if (opts.withChapters !== false) {
          let chapters = [];
          try { chapters = await adapter.listChapters(source, item.ref); } catch (_) {}
          if (!chapters.length && adapter === generic) chapters = [];
          added = saveChapters(series.id, chapters);
        }
        stats.series++;
        stats.chapters += added;
        onProgress({ done: stats.series, total: count, message: `${series.title} (+${added})` });
        await new Promise((r) => setTimeout(r, Number(cfg.delay_ms || 60))); // be gentle on sources
      } catch (e) {
        stats.errors.push(`${item.ref}: ${e.message}`);
      }
    }
    if (items.length < want) break;
  }
  db.prepare("UPDATE sources SET last_sync=datetime('now') WHERE id=?").run(sourceId);
  log(null, 'scrape.pull', JSON.stringify({ source: source.name, ...stats }).slice(0, 900));
  return stats;
}

/** Ongoing tracking: fetch chapter list for one series and store the new ones. */
async function trackSeries(seriesId) {
  const series = db.prepare('SELECT s.*, src.base_url, src.adapter, src.config, src.type stype, src.enabled senabled FROM series s JOIN sources src ON src.id=s.source_id WHERE s.id=?').get(seriesId);
  if (!series || !series.senabled || !series.source_ref) return { added: 0 };
  const source = {
    id: series.source_id, base_url: series.base_url, adapter: series.adapter,
    config: series.config, type: series.stype
  };
  const adapter = resolveAdapter(source);
  let list = [];
  try { list = await adapter.listChapters(source, series.source_ref); } catch (e) { return { added: 0, error: e.message }; }
  const before = (maxChapter.get(seriesId).m || 0);
  const added = saveChapters(seriesId, list);
  if (added > 0) {
    const newest = (maxChapter.get(seriesId).m || 0);
    // notify only the users who actually track this series
    const users = db.prepare("SELECT user_id FROM library WHERE series_id=? AND list IN ('favorite','reading')").all(seriesId);
    const ins = db.prepare('INSERT INTO notifications (user_id,title,body,kind) VALUES (?,?,?,?)');
    for (const u of users) {
      ins.run(u.user_id, `فصل جديد: ${series.title}`, `تمت إضافة الفصل ${newest}`, 'chapter');
    }
    return { added, before, newest };
  }
  return { added: 0 };
}

async function chapterPages(chapterId) {
  const ch = db.prepare(`SELECT c.*, s.source_id, s.source_ref, src.base_url, src.adapter, src.config, src.type stype, src.enabled senabled
     FROM chapters c JOIN series s ON s.id=c.series_id JOIN sources src ON src.id=s.source_id WHERE c.id=?`).get(chapterId);
  if (!ch) throw new Error('الفصل غير موجود');
  const source = { id: ch.source_id, base_url: ch.base_url, adapter: ch.adapter, config: ch.config, type: ch.stype };
  const adapter = resolveAdapter(source);
  const pages = await adapter.pages(source, { url: ch.url, number: ch.number });
  return pages.filter(Boolean);
}

function safeJson(s) { try { return JSON.parse(s || '{}'); } catch { return {}; } }

module.exports = { pullSource, trackSeries, chapterPages, saveSeries, saveChapters };
