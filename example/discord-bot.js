'use strict';

const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  MessageFlags,
} = require('discord.js');

const { Bot } = require('../index');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'BOT TOKEN HERE';
const PREFIX        = process.env.PREFIX || '.';
const VERSION       = '0.14.3';
const BOT_DELAY     = 4000;
const MAX_RETRY     = 3;
const OFFLINE_MS    = 20000;
const MAX_LOGS      = 200;
const AUTH_DELAY    = 2500;

if (!DISCORD_TOKEN || DISCORD_TOKEN === 'BOT TOKEN HERE') {
  process.stderr.write('DISCORD_TOKEN is not set.\nRun: DISCORD_TOKEN=your_token node discord-bot.js\n');
  process.exit(1);
}

const C = {
  PRIMARY: 0x5865F2,
  SUCCESS: 0x57F287,
  DANGER:  0xED4245,
  WARN:    0xFEE75C,
  INFO:    0x00B0F4,
  MUTED:   0x4F545C,
  DARK:    0x2B2D31,
  BRIDGE:  0x00CED1,
};

const globalConfig = {
  register:     '',
  login:        '',
  registerMode: 'single',
  joinMsg1:     '',
  joinMsg2:     '',
};

const registry    = new Map();
const chatBridges = new Map();

function ts() {
  return new Date().toLocaleTimeString('en-US', { hour12: false });
}

function pushLog(username, line) {
  const e = registry.get(username.toLowerCase());
  if (!e) return;
  e.logs.push(`[${ts()}] ${line}`);
  if (e.logs.length > MAX_LOGS) e.logs.shift();
}

function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function statusLabel(s) {
  return { online: 'Online', connecting: 'Connecting', offline: 'Offline', error: 'Error' }[s] ?? 'Unknown';
}

function stripColor(str) {
  return str.replace(/\u00a7./g, '');
}

function configSummary() {
  const none = 'not set';
  return [
    `Register       ${globalConfig.register     || none}`,
    `Register Mode  ${globalConfig.registerMode || 'single'}`,
    `Login          ${globalConfig.login        || none}`,
    `Join Msg 1     ${globalConfig.joinMsg1     || none}`,
    `Join Msg 2     ${globalConfig.joinMsg2     || none}`,
  ].join('\n');
}

function paginateLogs(lines, max = 1800) {
  const pages = [];
  let cur = '';
  for (const l of lines) {
    const next = cur ? cur + '\n' + l : l;
    if (next.length > max) { pages.push(cur); cur = l; }
    else cur = next;
  }
  if (cur) pages.push(cur);
  return pages.length ? pages : ['(no logs yet)'];
}

function cv2(components, flags = 0) {
  return { components, flags: MessageFlags.IsComponentsV2 | flags };
}

function container(color, ...textLines) {
  const c = new ContainerBuilder().setAccentColor(color);
  for (const line of textLines) {
    c.addTextDisplayComponents(new TextDisplayBuilder().setContent(line));
  }
  return c;
}

function sep() {
  return new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true);
}

async function bridgeMcToDiscord(username, source, message) {
  const bridge = chatBridges.get(username.toLowerCase());
  if (!bridge?.enabled) return;
  if (!source && !bridge.relayServerMessages) return;
  try {
    const channel = await client.channels.fetch(bridge.channelId);
    if (!channel) return;
    const entry = registry.get(username.toLowerCase());
    const label = source ? `${source}  (via ${username})` : `Server  (via ${username})`;
    await channel.send(cv2([
      container(C.BRIDGE,
        `**${label}**`,
        stripColor(message),
        `-# ${entry?.server ?? ''}`,
      ),
    ]));
  } catch (_) {}
}

function spawnBot(opts) {
  const { host, port, username, onEvent } = opts;
  const attempt = opts.attempt || 1;
  const key     = username.toLowerCase();
  const server  = `${host}:${port}`;

  if (registry.has(key)) {
    onEvent('exists', username);
    return;
  }

  const entry = { bot: null, username, server, status: 'connecting', logs: [], joinedAt: null };
  registry.set(key, entry);

  const log = (line) => { pushLog(username, line); onEvent('log', username, line); };

  log(attempt > 1
    ? `Retry ${attempt}/${MAX_RETRY} — connecting to ${server}`
    : `Connecting to ${server}`
  );

  const bot    = new Bot({ host, port, username, version: VERSION });
  entry.bot    = bot;

  let joined   = false;
  let givingUp = false;

  const offlineTimer = setTimeout(() => {
    if (joined) return;
    givingUp = true;
    log(`No response from ${server} after ${OFFLINE_MS / 1000}s`);
    onEvent('timeout', username);
    registry.delete(key);
    bot.disconnect('no-response');
  }, OFFLINE_MS);

  let authState    = 'none';
  let lastAuthSent = 0;
  let authTimer    = null;

  function sendAuth(cmd) {
    if (authTimer) { clearTimeout(authTimer); authTimer = null; }
    const wait = AUTH_DELAY - (Date.now() - lastAuthSent);
    const fire = () => { lastAuthSent = Date.now(); bot.chat(cmd); log(`Auth: ${cmd}`); authTimer = null; };
    if (wait <= 0) fire();
    else authTimer = setTimeout(fire, wait);
  }

  function buildRegister() {
    return globalConfig.registerMode === 'double'
      ? `/register ${globalConfig.register} ${globalConfig.register}`
      : `/register ${globalConfig.register}`;
  }

  bot.on('ready', () => {
    joined         = true;
    entry.status   = 'online';
    entry.joinedAt = new Date();
    clearTimeout(offlineTimer);
    log(`${username} is in-game on ${server}`);
    if (globalConfig.joinMsg1) { bot.chat(globalConfig.joinMsg1); log(`Sent: ${globalConfig.joinMsg1}`); }
    if (globalConfig.joinMsg2) { bot.chat(globalConfig.joinMsg2); log(`Sent: ${globalConfig.joinMsg2}`); }
    onEvent('ready', username);
  });

  bot.on('chat', ({ source, message }) => {
    const clean = stripColor(message);
    log(source ? `<${source}> ${clean}` : clean);

    if (!joined && !source) {
      const lower = clean.toLowerCase();

      if (lower.includes('register') && authState === 'none' && globalConfig.register) {
        authState = 'registered';
        sendAuth(buildRegister());
      } else if (lower.includes('login') && authState !== 'done' && globalConfig.login) {
        authState = 'done';
        sendAuth(`/login ${globalConfig.login}`);
      } else {
        const regOk = ['registrado','registered','successfully','contraseña','password set']
          .some(p => lower.includes(p));
        if (regOk && authState === 'none' && globalConfig.login) {
          authState = 'done';
          sendAuth(`/login ${globalConfig.login}`);
        }
      }
    }

    if (joined && source !== username) {
      bridgeMcToDiscord(username, source, message);
    }
  });

  bot.on('health', (hp) => {
    log(`Health: ${hp}/20`);
    if (hp <= 0) {
      log('Died — respawning in 1s');
      setTimeout(() => { if (bot.connected) bot.respawn(); }, 1000);
    }
  });

  bot.on('disconnect', (reason, intentional) => {
    clearTimeout(offlineTimer);
    if (authTimer) { clearTimeout(authTimer); authTimer = null; }
    entry.status = 'offline';

    if (givingUp || intentional) { registry.delete(key); return; }

    if (!joined) {
      const noRetry = [
        'another location','already connected','duplicate',
        'ya hay alguien','nombre','username taken','name is taken',
        'ya existe','already exists',
      ];
      if (noRetry.some(r => reason.toLowerCase().includes(r))) {
        log(`Duplicate connection — not retrying`);
        onEvent('duplicate', username, reason);
        registry.delete(key);
        return;
      }
      if (attempt < MAX_RETRY) {
        log(`Failed (${reason}) — retrying in 5s`);
        registry.delete(key);
        setTimeout(() => spawnBot({ ...opts, attempt: attempt + 1 }), 5000);
      } else {
        log(`Could not join after ${MAX_RETRY} attempts`);
        onEvent('failed', username, reason);
        registry.delete(key);
      }
    } else {
      log(`Disconnected: ${reason}`);
      onEvent('disconnect', username, reason);
      registry.delete(key);
    }
  });

  bot.on('error', (err) => {
    clearTimeout(offlineTimer);
    if (authTimer) { clearTimeout(authTimer); authTimer = null; }
    if (givingUp) return;
    const m         = err.message || String(err);
    const isOffline = m.includes('ECONNREFUSED') || m.includes('ETIMEDOUT') || m.includes('timeout');

    if (isOffline) {
      log(`Server unreachable: ${m}`);
      onEvent('offline', username, m);
      registry.delete(key);
    } else if (!joined && attempt < MAX_RETRY) {
      log(`Error: ${m} — retrying in 5s`);
      registry.delete(key);
      setTimeout(() => spawnBot({ ...opts, attempt: attempt + 1 }), 5000);
    } else {
      log(`Error: ${m}`);
      onEvent('error', username, m);
      registry.delete(key);
    }
  });

  bot.connect();
}

const commands = {

  async help(msg) {
    const p = PREFIX;
    await msg.reply(cv2([
      container(C.PRIMARY,
        '## Draconium — Command Reference',
        'AFK bot controller for MCPE 0.14.x / PocketMine-MP',
      ),
      sep(),
      container(C.MUTED,
        '**Setup**',
        `\`${p}configure\` — Interactive wizard: register password, login password, join messages`,
        `\`${p}config\` — View current global config`,
      ),
      sep(),
      container(C.MUTED,
        '**Connection**',
        `\`${p}join <ip:port> <bot1,bot2,...>\` — Connect one or more bots`,
        `\`${p}leave <username|*>\` — Disconnect a bot or all bots`,
      ),
      sep(),
      container(C.MUTED,
        '**Chat**',
        `\`${p}chat * <message>\` — Broadcast from all online bots`,
        `\`${p}chat <username> <message>\` — Send from a specific bot`,
      ),
      sep(),
      container(C.MUTED,
        '**Chat Bridge**',
        `\`${p}chatarea <username> #channel on\` — Bridge MC chat to a Discord channel`,
        `\`${p}chatarea <username> #channel off\` — Disable a bridge`,
        `\`${p}chatarea list\` — List all configured bridges`,
      ),
      sep(),
      container(C.MUTED,
        '**Info**',
        `\`${p}list\` — All active bots`,
        `\`${p}info <username>\` — Detailed bot info`,
        `\`${p}logs <username>\` — Paginated log viewer`,
        `\`${p}credits\` — About`,
      ),
      sep(),
      container(C.DARK,
        '**Example**',
        `\`\`\`\n${p}configure\n${p}join play.example.com:19132 AFK1,AFK2\n${p}chatarea AFK1 #minecraft-chat on\n${p}chat * Hello!\n${p}leave *\`\`\``,
      ),
    ]));
  },

  async configure(msg) {
    const steps = [
      { key: 'register',     label: 'Register Password', desc: 'Sent with /register.' },
      { key: 'registerMode', label: 'Register Mode',     desc: 'Type `single` for /register <pw>  or  `double` for /register <pw> <pw>' },
      { key: 'login',        label: 'Login Password',    desc: 'Used as /login <password>' },
      { key: 'joinMsg1',     label: 'Join Message 1',    desc: 'Sent in-game when the bot is ready. Leave blank to skip.' },
      { key: 'joinMsg2',     label: 'Join Message 2',    desc: 'Second message after Join Message 1. Leave blank to skip.' },
    ];

    const collected = {};
    let stepIndex   = 0;

    const makeComponents = () => {
      const step    = steps[stepIndex];
      const current = globalConfig[step.key];
      return [
        container(C.INFO,
          `## Configure — Step ${stepIndex + 1} of ${steps.length}`,
          `**${step.label}**`,
          step.desc,
          `Current: ${current ? `\`${current}\`` : 'not set'}`,
          'Type a new value, or click **Skip** to keep the current value.',
        ),
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('cfg_skip').setLabel('Skip').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId('cfg_cancel').setLabel('Cancel').setStyle(ButtonStyle.Danger),
        ),
      ];
    };

    const promptMsg = await msg.reply(cv2(makeComponents()));

    const runStep = async (ref) => {
      if (stepIndex >= steps.length) {
        for (const [k, v] of Object.entries(collected)) globalConfig[k] = v;
        await ref.edit(cv2([
          container(C.SUCCESS,
            '## Config Saved',
            '```\n' + configSummary() + '\n```',
          ),
        ]));
        return;
      }

      const step         = steps[stepIndex];
      const btnCollector = ref.createMessageComponentCollector({ time: 60_000, max: 1 });
      const msgCollector = msg.channel.createMessageCollector({
        filter: m => m.author.id === msg.author.id,
        time:   60_000,
        max:    1,
      });
      const cleanup = () => { btnCollector.stop(); msgCollector.stop(); };

      btnCollector.on('collect', async (interaction) => {
        if (interaction.user.id !== msg.author.id) {
          return interaction.reply({ content: 'This wizard belongs to someone else.', ephemeral: true });
        }
        cleanup();
        if (interaction.customId === 'cfg_cancel') {
          await interaction.update(cv2([container(C.MUTED, 'Configuration cancelled. No changes saved.')]));
          return;
        }
        collected[step.key] = globalConfig[step.key];
        stepIndex++;
        const next = makeComponents();
        await interaction.update(cv2(next));
        await runStep(ref);
      });

      msgCollector.on('collect', async (reply) => {
        cleanup();
        reply.delete().catch(() => {});
        collected[step.key] = reply.content.trim();
        stepIndex++;
        await ref.edit(cv2(makeComponents()));
        await runStep(ref);
      });

      btnCollector.on('end', (_, reason) => {
        if (reason === 'time') {
          ref.edit(cv2([container(C.WARN, 'Configuration timed out. No changes saved.')])).catch(() => {});
          msgCollector.stop();
        }
      });
    };

    await runStep(promptMsg);
  },

  async config(msg) {
    await msg.reply(cv2([
      container(C.PRIMARY,
        '## Global Config',
        '```\n' + configSummary() + '\n```',
        `-# Use \`${PREFIX}configure\` to change these values.`,
      ),
    ]));
  },

  async join(msg, args) {
    if (args.length < 2) {
      return msg.reply(cv2([
        container(C.WARN,
          '## Usage',
          `\`${PREFIX}join <ip:port> <bot1,bot2,...>\``,
          `Example: \`${PREFIX}join play.example.com:19132 AFK1,AFK2\``,
        ),
      ]));
    }

    const [serverArg, usersArg] = args;
    const [host, portStr = '19132'] = serverArg.includes(':') ? serverArg.split(':') : [serverArg, '19132'];
    const port      = parseInt(portStr, 10) || 19132;
    const usernames = usersArg.split(',').map(u => u.trim()).filter(Boolean);

    if (!usernames.length) {
      return msg.reply(cv2([container(C.DANGER, 'No valid usernames provided.')]));
    }

    const cfgLines = [
      `Register  ${globalConfig.register || 'not set'}`,
      `Login     ${globalConfig.login    || 'not set'}`,
    ].join('\n');

    const statusMsg = await msg.reply(cv2([
      container(C.INFO,
        '## Connecting...',
        `Server  \`${host}:${port}\``,
        `Bots    ${usernames.map(u => `\`${u}\``).join(', ')}`,
        '```\n' + cfgLines + '\n```',
      ),
    ]));

    const results  = {};
    const statuses = {};
    for (const u of usernames) statuses[u] = 'queued';

    const statusLine = {
      ready:      u => `+ ${u}  joined`,
      exists:     u => `+ ${u}  already connected`,
      timeout:    u => `x ${u}  timed out`,
      offline:    u => `x ${u}  server offline`,
      duplicate:  u => `! ${u}  duplicate, skipped`,
      failed:     u => `x ${u}  failed after ${MAX_RETRY} attempts`,
      connecting: u => `~ ${u}  connecting...`,
      queued:     u => `  ${u}  queued`,
    };

    async function updateEmbed(final = false) {
      const lines = usernames.map(u => (statusLine[results[u] ?? statuses[u]] ?? statusLine.queued)(u));
      const allOk = final && usernames.every(u => ['ready','exists'].includes(results[u]));
      await statusMsg.edit(cv2([
        container(
          final ? (allOk ? C.SUCCESS : C.WARN) : C.INFO,
          final ? (allOk ? '## All Bots Connected' : '## Connection Results') : '## Connecting...',
          '```diff\n' + lines.join('\n') + '\n```',
          `Server  \`${host}:${port}\``,
        ),
      ])).catch(() => {});
    }

    await Promise.all(usernames.map((username, i) =>
      new Promise(resolve => {
        const delay = i * BOT_DELAY;
        statuses[username] = 'queued';
        setTimeout(async () => {
          statuses[username] = 'connecting';
          await updateEmbed();

          const done = async (outcome) => {
            if (results[username]) return;
            results[username] = outcome;
            await updateEmbed();
            resolve();
          };

          spawnBot({
            host, port, username, attempt: 1,
            onEvent: (event, u) => {
              if (u !== username) return;
              const terminal = ['ready','exists','timeout','offline','duplicate','failed'];
              if (terminal.includes(event)) done(event);
            },
          });

          setTimeout(() => done('timeout'), OFFLINE_MS + 5000);
        }, delay);
      })
    ));

    await updateEmbed(true);
  },

  async leave(msg, args) {
    const target = args[0];
    if (!target) {
      return msg.reply(cv2([container(C.WARN, `Usage: \`${PREFIX}leave <username|*>\``)]));
    }

    if (target === '*') {
      const count = registry.size;
      if (!count) {
        return msg.reply(cv2([container(C.MUTED, 'No bots are currently connected.')]));
      }
      for (const [, e] of registry) try { e.bot.disconnect('Discord: leave *'); } catch (_) {}
      registry.clear();
      return msg.reply(cv2([container(C.SUCCESS, `Disconnected ${count} bot(s).`)]));
    }

    const entry = registry.get(target.toLowerCase());
    if (!entry) {
      return msg.reply(cv2([container(C.DANGER, `No active bot named \`${target}\`.`)]));
    }

    entry.bot.disconnect('Discord: leave');
    return msg.reply(cv2([
      container(C.SUCCESS, `\`${entry.username}\` disconnected from \`${entry.server}\`.`),
    ]));
  },

  async list(msg) {
    if (!registry.size) {
      return msg.reply(cv2([
        container(C.MUTED,
          '## Active Bots',
          `No bots connected. Use \`${PREFIX}join\` to connect one.`,
        ),
      ]));
    }

    const rows = [];
    for (const [, e] of registry) {
      const uptime    = e.joinedAt ? fmtDuration(Date.now() - e.joinedAt.getTime()) : '—';
      const bridge    = chatBridges.get(e.username.toLowerCase());
      const bridgeTag = bridge?.enabled ? '  [bridge]' : '';
      rows.push(`${e.username}${bridgeTag}  |  ${statusLabel(e.status)}  |  ${e.server}  |  ${uptime}`);
    }

    await msg.reply(cv2([
      container(C.PRIMARY,
        `## Active Bots (${registry.size})`,
        '```\n' + rows.join('\n') + '\n```',
      ),
    ]));
  },

  async info(msg, args) {
    const username = args[0];
    if (!username) {
      return msg.reply(cv2([container(C.WARN, `Usage: \`${PREFIX}info <username>\``)]));
    }

    const e = registry.get(username.toLowerCase());
    if (!e) {
      return msg.reply(cv2([container(C.DANGER, `No active bot named \`${username}\`.`)]));
    }

    const uptime   = e.joinedAt ? fmtDuration(Date.now() - e.joinedAt.getTime()) : '—';
    const joinedAt = e.joinedAt ? `<t:${Math.floor(e.joinedAt.getTime() / 1000)}:R>` : '—';
    const bridge   = chatBridges.get(username.toLowerCase());
    const { x, y, z } = e.bot.position ?? {};
    const posStr   = x != null ? `${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)}` : '—';

    await msg.reply(cv2([
      container(e.status === 'online' ? C.SUCCESS : C.WARN,
        `## ${e.username}`,
        '```\n' + [
          `Server    ${e.server}`,
          `Status    ${statusLabel(e.status)}`,
          `Uptime    ${uptime}`,
          `Joined    ${joinedAt}`,
          `Health    ${e.bot.health ?? '—'}/20`,
          `Position  ${posStr}`,
          `Logs      ${e.logs.length} lines`,
          `Bridge    ${bridge?.enabled ? `#${bridge.channelId}` : 'off'}`,
        ].join('\n') + '\n```',
      ),
    ]));
  },

  async chat(msg, args) {
    if (args.length < 2) {
      return msg.reply(cv2([
        container(C.WARN,
          '## Usage',
          `All bots     \`${PREFIX}chat * <message>\``,
          `Specific bot \`${PREFIX}chat <username> <message>\``,
        ),
      ]));
    }

    const [target, ...rest] = args;
    const message = rest.join(' ');

    if (target === '*') {
      if (!registry.size) {
        return msg.reply(cv2([container(C.DANGER, 'No bots connected.')]));
      }
      const sent = [], skipped = [];
      for (const [, e] of registry) {
        if (e.status === 'online' || e.bot?.connected) { e.bot.chat(message); sent.push(e.username); }
        else skipped.push(e.username);
      }
      return msg.reply(cv2([
        container(sent.length ? C.SUCCESS : C.WARN,
          '## Broadcast',
          `Message  ${message}`,
          sent.length    ? `Sent by  ${sent.join(', ')}`    : '',
          skipped.length ? `Skipped  ${skipped.join(', ')}` : '',
        ),
      ]));
    }

    const entry = registry.get(target.toLowerCase());
    if (!entry) {
      return msg.reply(cv2([container(C.DANGER, `No active bot named \`${target}\`.`)]));
    }
    if (entry.status !== 'online') {
      return msg.reply(cv2([container(C.WARN, `\`${entry.username}\` is not in-game yet (${statusLabel(entry.status)}).`)]));
    }

    entry.bot.chat(message);
    return msg.reply(cv2([
      container(C.SUCCESS,
        '## Message Sent',
        `From    \`${entry.username}\``,
        `Server  \`${entry.server}\``,
        `> ${message}`,
      ),
    ]));
  },

  async chatarea(msg, args) {
    if (args[0] === 'list') {
      if (!chatBridges.size) {
        return msg.reply(cv2([container(C.MUTED, '## Chat Bridges', 'No bridges configured.')]));
      }
      const rows = [];
      for (const [username, b] of chatBridges) {
        rows.push(`${username}  ->  #${b.channelId}  |  ${b.enabled ? 'Enabled' : 'Disabled'}`);
      }
      return msg.reply(cv2([
        container(C.BRIDGE, '## Chat Bridges', '```\n' + rows.join('\n') + '\n```'),
      ]));
    }

    if (args.length < 3) {
      return msg.reply(cv2([
        container(C.WARN,
          '## Usage',
          `Enable   \`${PREFIX}chatarea <username> #channel on\``,
          `Disable  \`${PREFIX}chatarea <username> #channel off\``,
          `List     \`${PREFIX}chatarea list\``,
        ),
      ]));
    }

    const [username, channelMention, toggle] = args;
    const channelId = channelMention.replace(/[<#>]/g, '');
    const enabled   = toggle?.toLowerCase() === 'on';

    let channel;
    try { channel = await client.channels.fetch(channelId); } catch (_) {}
    if (!channel) {
      return msg.reply(cv2([container(C.DANGER, 'Could not find that channel. Mention it with #.')]));
    }

    chatBridges.set(username.toLowerCase(), { channelId, enabled });
    const entry = registry.get(username.toLowerCase());

    await msg.reply(cv2([
      container(enabled ? C.BRIDGE : C.MUTED,
        `## Chat Bridge ${enabled ? 'Enabled' : 'Disabled'}`,
        enabled
          ? `MC chat from **${username}** will appear in <#${channelId}>.\nMessages in <#${channelId}> will be forwarded via **${username}**.`
          : `Bridge for **${username}** has been disabled.`,
        '```\n' + [
          `Bot      ${username}`,
          `Channel  #${channelId}`,
          `Status   ${entry ? statusLabel(entry.status) : 'Bot not connected'}`,
        ].join('\n') + '\n```',
      ),
    ]));
  },

  async logs(msg, args) {
    const username = args[0];
    if (!username) {
      return msg.reply(cv2([container(C.WARN, `Usage: \`${PREFIX}logs <username>\``)]));
    }

    const entry = registry.get(username.toLowerCase());
    if (!entry) {
      return msg.reply(cv2([container(C.DANGER, `No active bot named \`${username}\`.`)]));
    }

    const pages = paginateLogs(entry.logs.slice(-50));
    let pi = 0;

    const makeComponents = (i) => [
      container(C.DARK,
        `## Logs — ${entry.username}`,
        '```\n' + (pages[i] || '(empty)') + '\n```',
        `-# Page ${i + 1}/${pages.length}  |  ${entry.server}`,
      ),
      ...(pages.length > 1 ? [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('lp').setLabel('Prev').setStyle(ButtonStyle.Secondary).setDisabled(i === 0),
          new ButtonBuilder().setCustomId('ln').setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(i >= pages.length - 1),
        ),
      ] : []),
    ];

    const reply = await msg.reply(cv2(makeComponents(pi)));
    if (pages.length <= 1) return;

    const col = reply.createMessageComponentCollector({ time: 120_000 });
    col.on('collect', async (interaction) => {
      if (interaction.user.id !== msg.author.id) {
        return interaction.reply({ content: 'This log viewer belongs to someone else.', ephemeral: true });
      }
      if (interaction.customId === 'lp' && pi > 0)               pi--;
      if (interaction.customId === 'ln' && pi < pages.length - 1) pi++;
      await interaction.update(cv2(makeComponents(pi)));
    });
    col.on('end', () => reply.edit(cv2(makeComponents(pi))).catch(() => {}));
  },

  async credits(msg) {
    await msg.reply(cv2([
      container(C.PRIMARY,
        '## Draconium',
        'AFK Bot for MCPE 0.14.x / PocketMine-MP',
        'Custom RakNet implementation — no game-protocol dependencies.',
        '```\n' + [
          'Stack     Node.js  |  discord.js v14  |  draconium',
          'Protocol  MCPE Protocol 70 (v0.14.x)',
          'License   GPL-3.0',
        ].join('\n') + '\n```',
      ),
    ]));
  },
};

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.on('messageCreate', async (msg) => {
  if (msg.author.bot) return;

  if (!msg.content.startsWith(PREFIX)) {
    for (const [username, bridge] of chatBridges) {
      if (!bridge.enabled || bridge.channelId !== msg.channelId) continue;
      const entry = registry.get(username);
      if (!entry || entry.status !== 'online') continue;
      entry.bot.chat(`${msg.author.username}: ${msg.content}`);
    }
    return;
  }

  const [rawCmd, ...args] = msg.content.slice(PREFIX.length).trim().split(/\s+/);
  const cmd = rawCmd.toLowerCase();
  if (!commands[cmd]) return;

  try {
    await commands[cmd](msg, args);
  } catch (err) {
    await msg.reply(cv2([
      container(C.DANGER,
        '## Error',
        '```\n' + (err.message || String(err)) + '\n```',
      ),
    ])).catch(() => {});
  }
});

client.once('clientReady', () => {
  process.stdout.write(`[Draconium] Online as ${client.user.tag}\n`);
  client.user.setActivity(`${PREFIX}help  |  Draconium`);
});

client.login(DISCORD_TOKEN).catch(err => {
  process.stderr.write(`[Draconium] Login failed: ${err.message}\n`);
  process.exit(1);
});

function gracefulShutdown() {
  process.stdout.write('[Draconium] Shutting down...\n');
  const bots = [...registry.values()];
  if (!bots.length) { client.destroy(); process.exit(0); return; }

  let remaining = bots.length;
  const done = () => { if (--remaining <= 0) { client.destroy(); process.exit(0); } };

  for (const e of bots) {
    try {
      e.bot.once('disconnect', done);
      e.bot.disconnect('shutdown');
    } catch (_) { done(); }
  }

  setTimeout(() => { client.destroy(); process.exit(0); }, 5000);
}

process.on('SIGINT',  gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
