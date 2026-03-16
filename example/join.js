'use strict';

const { Bot } = require('draconium');

// ── Config ─────────────────────────────────────────────────────────────────────
const HOST      = 'AlphaMP.ddns.net';
const PORT      = 19824;
const USERNAMES = 'Zyro,Kova,Ryzen,Axel,VyroZyro,Kova,Ryzen,Axel,Vyro,Nyxen,Tarek,Zevo,Lyric';
const VERSION   = '0.14.3';
const REGISTER  = 'yourpassword';  // sent as: /register <pw> <pw>
const LOGIN     = 'yourpassword';  // sent as: /login <pw>
const JOIN_MSG  = '';              // optional chat message after spawning (leave empty to disable)
const BOT_DELAY = 4000;            // ms to wait between each bot connecting
const MAX_RETRY = 3;               // max join attempts before giving up
const TIMEOUT   = 20000;           // ms of silence before declaring server offline
// ──────────────────────────────────────────────────────────────────────────────

const usernames = USERNAMES.split(',').map(u => u.trim()).filter(Boolean);

if (!usernames.length) {
  console.error('[join] no usernames configured');
  process.exit(1);
}

console.log(`[join] server  : ${HOST}:${PORT}`);
console.log(`[join] bots    : ${usernames.join(', ')}`);
console.log(`[join] total   : ${usernames.length}`);

const activeBots = new Set();

function spawnBot(username, attempt = 1) {
  const bot = new Bot({ host: HOST, port: PORT, username, version: VERSION });
  activeBots.add(bot);

  if (attempt === 1) console.log(`[${username}] connecting...`);
  else               console.log(`[${username}] attempt ${attempt}/${MAX_RETRY}...`);

  let joined   = false;
  let givingUp = false;

  const offlineTimer = setTimeout(() => {
    if (joined) return;
    givingUp = true;
    activeBots.delete(bot);
    console.log(`[${username}] no response from server (${TIMEOUT}ms) — server may be offline`);
    bot.disconnect('timeout');
  }, TIMEOUT);

  bot.on('spawn', () => {
    if (REGISTER) bot.chat(`/register ${REGISTER} ${REGISTER}`);
    if (LOGIN)    bot.chat(`/login ${LOGIN}`);
  });

  bot.on('ready', () => {
    joined = true;
    clearTimeout(offlineTimer);
    console.log(`[${username}] in-game`);
    if (JOIN_MSG) bot.chat(JOIN_MSG);
  });

  bot.on('chat', ({ source, message }) => {
    const clean = message.replace(/\u00a7./g, '');
    const src   = source ? `<${source}> ` : '';
    console.log(`[${username}] ${src}${clean}`);

    if (!joined && !source) {
      const lower = clean.toLowerCase();
      if (lower.includes('register') || lower.includes('login')) {
        if (REGISTER) bot.chat(`/register ${REGISTER} ${REGISTER}`);
        if (LOGIN)    bot.chat(`/login ${LOGIN}`);
      }
    }
  });

  bot.on('health', (hp) => {
    if (hp <= 0) setTimeout(() => bot.respawn(), 1000);
  });

  bot.on('disconnect', (reason, intentional) => {
    clearTimeout(offlineTimer);
    activeBots.delete(bot);
    if (givingUp || intentional) return;

    if (!joined) {
      const noRetry = ['another location', 'already connected', 'duplicate'];
      if (noRetry.some(r => reason.toLowerCase().includes(r))) {
        console.log(`[${username}] kicked (${reason}) — not retrying`);
        return;
      }
      if (attempt < MAX_RETRY) {
        console.log(`[${username}] failed to join (${reason}) — retrying in 5s`);
        setTimeout(() => spawnBot(username, attempt + 1), 5000);
      } else {
        console.log(`[${username}] gave up after ${MAX_RETRY} attempts (last reason: ${reason})`);
      }
    } else {
      console.log(`[${username}] disconnected: ${reason}`);
    }
  });

  bot.on('error', (err) => {
    clearTimeout(offlineTimer);
    activeBots.delete(bot);
    if (givingUp) return;

    const msg = err.message || String(err);
    const isOffline = msg.includes('ECONNREFUSED') || msg.includes('ETIMEDOUT') || msg.includes('timeout');

    if (isOffline) {
      console.log(`[${username}] server unreachable: ${msg}`);
      return;
    }

    if (!joined && attempt < MAX_RETRY) {
      console.log(`[${username}] error: ${msg} — retrying in 5s`);
      setTimeout(() => spawnBot(username, attempt + 1), 5000);
    } else {
      console.error(`[${username}] error: ${msg}`);
    }
  });

  bot.connect();
}

usernames.forEach((username, i) => {
  setTimeout(() => spawnBot(username), i * BOT_DELAY);
});

process.on('SIGINT', () => {
  console.log('\n[join] shutting down all bots...');
  for (const bot of activeBots) {
    try { bot.disconnect('shutting down'); } catch (_) {}
  }
  activeBots.clear();
  setTimeout(() => process.exit(0), 500);
});
