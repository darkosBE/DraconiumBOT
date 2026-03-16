'use strict';

const { Bot } = require('draconium');

const bot = new Bot({
  host:     process.env.MCPE_HOST     || '127.0.0.1',
  port:     parseInt(process.env.MCPE_PORT) || 19132,
  username: process.env.MCPE_USERNAME || 'DraconiumBot_' + (Math.random() * 1000 | 0),
  version:  '0.14.3',
});

console.log(`[bot] connecting to ${bot.options.host}:${bot.options.port} as ${bot.options.username}`);

let afkTimer  = null;
let jumpTimer = null;

bot.on('ready', () => {
  const { x, y, z } = bot.position;
  console.log(`[bot] ready — pos=(${x.toFixed(1)},${y.toFixed(1)},${z.toFixed(1)})`);
  setTimeout(() => bot.chat('AFK bot online.'), 2000);
  startAfk();
});

bot.on('chat', ({ source, message }) => {
  if (source) console.log(`[chat] <${source}> ${message}`);
  if (!message.startsWith('!')) return;

  const [cmd, ...args] = message.slice(1).trim().split(' ');
  switch (cmd.toLowerCase()) {
    case 'ping':
      bot.chat('pong!');
      break;
    case 'pos': {
      const { x, y, z } = bot.position;
      bot.chat(`pos: ${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)}`);
      break;
    }
    case 'hp':
      bot.chat(`health: ${bot.health}/20`);
      break;
    case 'jump':
      bot.jump();
      bot.chat('boing!');
      break;
    case 'tp':
      if (args.length >= 3) {
        const [x, y, z] = args.map(parseFloat);
        bot.teleport(x, y, z);
        bot.chat(`teleported to ${x}, ${y}, ${z}`);
      }
      break;
    case 'stop':
      stopAfk();
      bot.chat('afk stopped.');
      break;
    case 'start':
      startAfk();
      bot.chat('afk started.');
      break;
    case 'help':
      bot.chat('commands: !ping !pos !hp !jump !tp x y z !stop !start');
      break;
  }
});

bot.on('health', (hp) => {
  console.log(`[bot] health: ${hp}/20`);
  if (hp <= 0) setTimeout(() => bot.respawn(), 1000);
});

bot.on('disconnect', (reason, intentional) => {
  console.log(`[bot] disconnected: ${reason}`);
  stopAfk();
  if (!intentional) process.exit(1);
  process.exit(0);
});

bot.on('error', (err) => console.error('[bot] error:', err.message));

function startAfk() {
  stopAfk();
  let dir  = 1;
  let tick = 0;

  afkTimer = setInterval(() => {
    if (!bot.connected) return;
    tick++;
    if (tick % 40 === 0) dir *= -1;
    const { x, y, z } = bot.position;
    bot.teleport(x + 0.03 * dir, y, z);
  }, 100);

  jumpTimer = setInterval(() => {
    if (bot.connected) bot.jump();
  }, 4000);

  console.log('[bot] afk loop started');
}

function stopAfk() {
  clearInterval(afkTimer);
  clearInterval(jumpTimer);
  afkTimer  = null;
  jumpTimer = null;
}

process.on('SIGINT', () => {
  console.log('\n[bot] shutting down...');
  stopAfk();
  bot.disconnect('quit');
  setTimeout(() => process.exit(0), 500);
});

bot.connect();
