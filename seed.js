'use strict';
/** Creates the first admin (and a demo moderator) only once. Safe to run on every boot. */
const { db } = require('./db');
const A = require('./auth');

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@meloverse.app';
const ADMIN_PASS = process.env.ADMIN_PASS || 'MeloVerse#Admin2026';
const MOD_EMAIL = process.env.MOD_EMAIL || 'mod@meloverse.app';
const MOD_PASS = process.env.MOD_PASS || 'MeloVerse#Mod2026';

function ensureAdmin() {
  const existing = db.prepare('SELECT id FROM users WHERE role=\'admin\' LIMIT 1').get();
  if (!existing) {
    db.prepare(`INSERT INTO users (username,email,password_hash,role,verified)
      VALUES (?,?,?,'admin',1)`).run('MeloVerse Admin', ADMIN_EMAIL, A.hash(ADMIN_PASS));
    console.log(`[seed] admin created -> ${ADMIN_EMAIL} / ${ADMIN_PASS}`);
  }
  if (!db.prepare('SELECT id FROM users WHERE email=?').get(MOD_EMAIL)) {
    db.prepare(`INSERT INTO users (username,email,password_hash,role,verified)
      VALUES (?,?,?,'moderator',1)`).run('MeloVerse Mod', MOD_EMAIL, A.hash(MOD_PASS));
    console.log(`[seed] moderator created -> ${MOD_EMAIL} / ${MOD_PASS}`);
  }
  // One legal, official-API source so the room is never empty on first boot.
  if (!db.prepare('SELECT id FROM sources LIMIT 1').get()) {
    db.prepare(`INSERT INTO sources (name,base_url,adapter,type,enabled,config)
      VALUES ('MangaDex (Open API)','https://api.mangadex.org','mangadex','manga',1,'{"per_page":100}')`).run();
    console.log('[seed] demo source added: MangaDex');
  }
}

module.exports = { ensureAdmin, ADMIN_EMAIL, ADMIN_PASS, MOD_EMAIL, MOD_PASS };
if (require.main === module) { ensureAdmin(); console.log('seed done'); }
