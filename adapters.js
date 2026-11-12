'use strict';
/**
 * Source adapters.
 * Every adapter exposes:
 *   detect(url)                     -> boolean
 *   listSeries(source, {limit,page})-> [{ref,title,cover,description,category,type,status,latest}]
 *   listChapters(source, ref)       -> [{number,title,url}]
 *   pages(source, chapter)          -> [imageUrl]
 * Adding a new API = adding one object here. Admin only needs name + link.
 */
const cheerio = require('cheerio');

const UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Mobile Safari/537.36';
// MangaDex' anti-bot layer rejects browser-like UAs from servers; a plain API UA passes.
const UA_API = 'MeloVerse/1.0 (+https://meloverse.app)';

async function get(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: '*/*', ...(opts.headers || {}) },
    redirect: 'follow',
    signal: AbortSignal.timeout(opts.timeout || 20000)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return opts.json ? res.json() : res.text();
}
const abs = (base, u) => { try { return new URL(u, base).toString(); } catch { return u; } };
const num = (s) => {
  const m = String(s || '').replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : 0;
};

/* ------------------------------------------------------------------ */
/* 1. MangaDex — official public JSON API                              */
/* ------------------------------------------------------------------ */
const mangadex = {
  id: 'mangadex',
  detect: (u) => /mangadex\.org/i.test(u),
  normalizeBase(u) { try { return new URL(u).origin + '/'; } catch { return u; } },
  async listSeries(source, { limit = 100, offset = 0 } = {}) {
    const base = 'https://api.mangadex.org';
    const lang = []; // all languages; title picking below prefers en/ar/ja
    const url = `${base}/manga?limit=${Math.min(limit, 100)}&offset=${offset}` +
      `&includes[]=cover_art&order[latestUploadedChapter]=desc` +
      `&contentRating[]=safe&contentRating[]=suggestive`;
    const j = await get(url, { json: true, headers: { 'user-agent': UA_API } });
    return (j.data || []).map((m) => {
      const a = m.attributes || {};
      const t = a.title || {};
      const d = a.description || {};
      const cover = (m.relationships || []).find((r) => r.type === 'cover_art');
      const file = cover && cover.attributes && cover.attributes.fileName;
      const tags = (a.tags || []).map((x) => x.attributes?.name?.en).filter(Boolean);
      return {
        ref: m.id,
        title: t.en || t.ar || t.ja || t['ja-ro'] || Object.values(t)[0] || 'بدون عنوان',
        cover: file ? `https://uploads.mangadex.org/covers/${m.id}/${file}.512.jpg` : '',
        description: d.en || d.ar || '',
        category: tags.slice(0, 3).join(', '),
        type: 'manga',
        status: a.status === 'completed' ? 'completed' : 'ongoing',
        latest: 0
      };
    });
  },
  async listChapters(source, ref) {
    const out = [];
    let offset = 0;
    for (let i = 0; i < 10; i++) {
      const j = await get(`https://api.mangadex.org/manga/${ref}/feed?limit=500&offset=${offset}` +
        `&order[chapter]=asc&includes[]=scanlation_group&contentRating[]=safe&contentRating[]=suggestive`, { json: true, headers: { 'user-agent': UA_API } });
      const rows = j.data || [];
      for (const c of rows) {
        out.push({
          number: num(c.attributes?.chapter) || (out.length + 1),
          title: c.attributes?.title || '',
          url: c.id
        });
      }
      offset += 500;
      if (rows.length < 500) break;
    }
    return out;
  },
  async pages(source, chapter) {
    const j = await get(`https://api.mangadex.org/at-home/server/${chapter.url}`, { json: true, headers: { 'user-agent': UA_API } });
    const b = j.baseUrl, h = j.chapter.hash, data = j.chapter.data || [];
    return data.map((f) => `${b}/data/${h}/${f}`);
  }
};

/* ------------------------------------------------------------------ */
/* 2. Madara (WordPress manga theme) — used by most manga sites       */
/* ------------------------------------------------------------------ */
const madara = {
  id: 'madara',
  detect: (u) => /wp-manga|manga|manhwa|manhua/i.test(u),
  normalizeBase(u) { try { const x = new URL(u); return x.origin; } catch { return u; } },
  async listSeries(source, { limit = 100, page = 1 } = {}) {
    const base = (source.config && JSON.parse(source.config || '{}').list_path) || '/manga/';
    const perPage = 20;
    const out = [];
    let p = page;
    while (out.length < limit && p < page + Math.ceil(limit / perPage) + 5) {
      const html = await get(`${source.base_url.replace(/\/$/, '')}${base}${base.includes('?') ? '&' : '?'}page=${p}&m_orderby=latest`);
      const $ = cheerio.load(html);
      const items = $('.manga__item, .page-item-detail, .c-tabs-item__content, .manga-item');
      if (!items.length) break;
      items.each((_, el) => {
        const $el = $(el);
        const a = $el.find('.post-title h3 a, h3 a, .manga__item_title a').first();
        const href = a.attr('href') || '';
        if (!href) return;
        const img = $el.find('img').first();
        out.push({
          ref: href,
          title: (a.text() || img.attr('alt') || '').trim(),
          cover: abs(source.base_url, img.attr('data-src') || img.attr('src') || ''),
          description: ($el.find('.post-content_item .summary-content, .manga__item_excerpt').text() || '').trim(),
          category: $el.find('.genres-content a, .manga__item_genres a').map((i, e) => $(e).text().trim()).get().slice(0, 3).join(', '),
          type: source.type || 'manga',
          status: /completed|مكتمل/i.test($el.text()) ? 'completed' : 'ongoing',
          latest: num($el.find('.chapter-item .chapter a, .latest-chapter a').first().text())
        });
      });
      p++;
      if (out.length >= limit) break;
    }
    return out.slice(0, limit);
  },
  async listChapters(source, ref) {
    const html = await get(abs(source.base_url, ref));
    const $ = cheerio.load(html);
    const out = [];
    $('.wp-manga-chapter a, .listing-chapters_wrap li a, .chapter-list a').each((i, el) => {
      const href = $(el).attr('href');
      if (!href) return;
      const text = $(el).text().trim();
      out.push({ number: num(text) || (i + 1), title: text, url: abs(source.base_url, href) });
    });
    // rich meta available on the detail page
    return out;
  },
  async detail(source, ref) {
    const html = await get(abs(source.base_url, ref));
    const $ = cheerio.load(html);
    return {
      title: $('.post-title h1, h1.entry-title').first().text().trim(),
      cover: abs(source.base_url, $('.summary_image img').attr('data-src') || $('.summary_image img').attr('src') || ''),
      description: $('.description-summary, .summary__content').text().trim().replace(/\s+/g, ' '),
      category: $('.genres-content a').map((i, e) => $(e).text().trim()).get().slice(0, 4).join(', '),
      status: /completed|مكتمل/i.test($('.post-status').text()) ? 'completed' : 'ongoing'
    };
  },
  async pages(source, chapter) {
    const html = await get(abs(source.base_url, chapter.url), { headers: { referer: source.base_url } });
    const $ = cheerio.load(html);
    const out = [];
    $('.reading-content img, .page-break img').each((_, el) => {
      const s = $(el).attr('data-src') || $(el).attr('src') || '';
      if (s && !/logo|banner|avatar/i.test(s)) out.push(abs(source.base_url, s.trim()));
    });
    return out;
  }
};

/* ------------------------------------------------------------------ */
/* 3. Generic — OpenGraph + sitemap best effort                       */
/* ------------------------------------------------------------------ */
const generic = {
  id: 'generic',
  detect: () => true,
  normalizeBase(u) { try { const x = new URL(u); return x.origin; } catch { return u; } },
  async listSeries(source, { limit = 50 } = {}) {
    const out = [];
    const tried = [];
    for (const p of ['/sitemap.xml', '/sitemap_index.xml', '/manga-sitemap.xml']) {
      try {
        const xml = await get(`${source.base_url.replace(/\/$/, '')}${p}`);
        const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
        const urls = locs.filter((l) => !/\.(jpg|png|webp|jpeg)$/i.test(l)).slice(0, limit);
        tried.push(...urls);
        if (urls.length) break;
      } catch (_) { /* next */ }
    }
    for (const u of tried.slice(0, limit)) {
      try {
        const d = await generic.detail(source, u);
        if (d && d.title && d.description) out.push({ ref: u, ...d, latest: 0 });
      } catch (_) { /* skip */ }
    }
    return out;
  },
  async detail(source, ref) {
    const html = await get(abs(source.base_url, ref));
    const $ = cheerio.load(html);
    const meta = (n) => $(`meta[property="${n}"], meta[name="${n}"]`).attr('content') || '';
    return {
      title: (meta('og:title') || $('h1').first().text() || '').trim(),
      cover: abs(source.base_url, meta('og:image')),
      description: (meta('og:description') || meta('description') || '').trim(),
      category: (meta('article:section') || '').trim(),
      status: 'ongoing'
    };
  },
  async listChapters(source, ref) {
    const html = await get(abs(source.base_url, ref));
    const $ = cheerio.load(html);
    const out = [];
    $('a').each((i, el) => {
      const href = $(el).attr('href') || '';
      const text = $(el).text().trim();
      if (/chapter|chap|فصل|ch[-_]/i.test(href + ' ' + text) && text.length < 60) {
        out.push({ number: num(text) || (i + 1), title: text, url: abs(source.base_url, href) });
      }
    });
    const seen = new Set();
    return out.filter((c) => (seen.has(c.url) ? false : seen.add(c.url)));
  },
  async pages(source, chapter) {
    const html = await get(abs(source.base_url, chapter.url), { headers: { referer: source.base_url } });
    const $ = cheerio.load(html);
    const out = [];
    $('img').each((_, el) => {
      const s = $(el).attr('data-src') || $(el).attr('data-lazy-src') || $(el).attr('src') || '';
      if (!s) return;
      const big = Number($(el).attr('width') || 0) > 400;
      if (!/logo|icon|avatar|banner|ads?|emoji/i.test(s) && (big || /chapter|page|manga|uploads/i.test(s))) {
        out.push(abs(source.base_url, s.trim()));
      }
    });
    return out;
  }
};

const ADAPTERS = { mangadex, madara, generic };

function resolveAdapter(source) {
  if (source.adapter && ADAPTERS[source.adapter] && source.adapter !== 'auto') return ADAPTERS[source.adapter];
  if (mangadex.detect(source.base_url)) return mangadex;
  return madara; // default for manga sites; falls back to generic inside orchestrator
}

module.exports = { ADAPTERS, resolveAdapter, generic, madara, mangadex, get, abs, num };
