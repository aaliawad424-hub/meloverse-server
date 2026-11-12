'use strict';
const path = require('path');
const express = require('express');
const cors = require('cors');
const { db } = require('./db');
const jobs = require('./jobs');
const seed = require('./seed');

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '1mb' }));

/* ---------------------------- API ---------------------------- */
app.get('/api/health', (_req, res) => res.json({ ok: true, name: 'MeloVerse', time: new Date().toISOString() }));
const A = require('./auth');
app.use('/api', A.optional);            // resolves req.user once for every route
app.use('/api/auth', require('./routes/auth'));
app.use('/api', require('./routes/catalog'));
app.use('/api', require('./routes/user'));
app.use('/api', require('./routes/social'));
app.use('/api/admin', require('./routes/admin'));

/* --------------- image proxy (referer / hotlink fix) --------------- */
app.get('/api/img', async (req, res) => {
  const u = String(req.query.u || '');
  if (!/^https?:\/\//i.test(u)) return res.status(400).end();
  try {
    const origin = new URL(u).origin;
    const plain = 'MeloVerse/1.0 (+https://meloverse.app)';
    const browser = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Mobile Safari/537.36';
    // Some CDNs (Cloudflare bot-check) reject browser UAs from datacenters but accept a plain UA,
    // while hotlink-protected sites need a browser UA + referer. Try both.
    let r = null;
    for (const headers of [{ 'user-agent': plain, accept: 'image/*,*/*' },
                           { 'user-agent': browser, referer: origin + '/', accept: 'image/avif,image/webp,image/*,*/*' }]) {
      r = await fetch(u, { headers, signal: AbortSignal.timeout(20000) });
      if (r.ok) break;
    }
    if (!r || !r.ok) return res.status(502).end();
    const type = r.headers.get('content-type') || 'image/jpeg';
    if (!type.startsWith('image/')) return res.status(415).end();
    res.set('content-type', type);
    res.set('cache-control', 'public, max-age=86400');
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 12 * 1024 * 1024) return res.status(413).end();
    res.end(buf);
  } catch (_) { res.status(502).end(); }
});

/* ------------------------- web (SPA) ------------------------- */
const WEB = path.join(__dirname, '..', '..', 'web');
app.use(express.static(WEB, { maxAge: '1h', index: 'index.html' }));
app.get(/^\/(?!api).*/, (_req, res) => res.sendFile(path.join(WEB, 'index.html')));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'خطأ في السيرفر', detail: err.message });
});

/* ------------------------ bootstrap ------------------------ */
seed.ensureAdmin();
jobs.recover();
jobs.startScheduler();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[MeloVerse] http://localhost:${PORT}`));
