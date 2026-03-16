'use strict';

/**
 * Draconium — Discord Bot Controller
 *
 * Setup:
 *   npm install discord.js
 *   DISCORD_TOKEN=your_token node discord-bot.js
 *
 * Required Discord intents: Guilds, GuildMessages, MessageContent
 */

const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');

const { Bot } = require('draconium');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'BOT TOKEN HERE';
const PREFIX        = process.env.PREFIX || '.';
const VERSION       = '0.14.3';
const BOT_DELAY     = 4000;   // ms between staggered bot connects
const MAX_RETRY     = 3;
const OFFLINE_MS    = 20000;  // ms before declaring server unresponsive
const MAX_LOGS      = 200;    // max log lines kept per bot

if (!DISCORD_TOKEN) {
  console.error('[Discord] DISCORD_TOKEN environment variable is not set.');
  console.error('          Run: DISCORD_TOKEN=your_token node discord-bot.js');
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
  registerMode: 'single', // 'single' = /register <pw>  |  'double' = /register <pw> <pw>
  joinMsg1:     '',
  joinMsg2:     '',
};

const AUTH_DELAY = 2500; // ms between auth commands — prevents anti-spam kicks

const registry = new Map();

const chatBridges = new Map();

function ts() {
  return new Date().toLocaleTimeString('en-US', { hour12: false });
}

function pushLog(username, line) {
  const e = registry.get(username.toLowerCase());
  if (!e) return;
  e.logs.push(`\`[${ts()}]\` ${line}`);
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

function statusDot(s) {
  return { online: 'Online', connecting: 'Connecting', offline: 'Offline', error: 'Error' }[s] ?? 'Unknown';
}

function foot() {
  return { text: 'Draconium  |  MCPE AFK Bot' };
}

function paginateLogs(lines, max = 1900) {
  const pages = [];
  let cur = '';
  for (const l of lines) {
    if ((cur + '\n' + l).length > max) { pages.push(cur); cur = l; }
    else cur = cur ? cur + '\n' + l : l;
  }
  if (cur) pages.push(cur);
  return pages.length ? pages : ['*(no logs yet)*'];
}

function configSummary() {
  const none = '*(not set)*';
  return [
    `**Register:** ${globalConfig.register     || none}`,
    `**Register Mode:** ${globalConfig.registerMode || 'single'}`,
    `**Login:** ${globalConfig.login           || none}`,
    `**Join Msg 1:** ${globalConfig.joinMsg1   || none}`,
    `**Join Msg 2:** ${globalConfig.joinMsg2   || none}`,
  ].join('\n');
}

function stripColor(str) {
  return str.replace(/\u00a7./g, '');
}

async function bridgeMcToDiscord(username, source, message) {
  const bridge = chatBridges.get(username.toLowerCase());
  if (!bridge || !bridge.enabled) return;
  try {
    const channel = await client.channels.fetch(bridge.channelId);
    if (!channel) return;
    const entry = registry.get(username.toLowerCase());
    await channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor(C.BRIDGE)
          .setAuthor({ name: source ? `${source}  (via ${username})` : `Server  (via ${username})` })
          .setDescription(stripColor(message))
          .setFooter({ text: entry?.server ?? '' })
          .setTimestamp(),
      ],
    });
  } catch (e) {
    console.error('[Bridge] MC->Discord failed:', e.message);
  }
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

  const entry = {
    bot:      null,
    username,
    server,
    status:   'connecting',
    logs:     [],
    joinedAt: null,
  };
  registry.set(key, entry);

  const log = (line) => {
    pushLog(username, line);
    onEvent('log', username, line);
  };

  log(attempt > 1
    ? `Retry attempt ${attempt}/${MAX_RETRY} — connecting to \`${server}\``
    : `Connecting to \`${server}\``
  );

  const bot = new Bot({ host, port, username, version: VERSION });
  entry.bot = bot;

  let joined   = false;
  let givingUp = false;

  const offlineTimer = setTimeout(() => {
    if (joined) return;
    givingUp = true;
    log(`No response from \`${server}\` after ${OFFLINE_MS / 1000}s — server may be offline`);
    onEvent('timeout', username);
    registry.delete(key);
    bot.disconnect('no-response');
  }, OFFLINE_MS);

  // Auth state machine — responds to server prompts with appropriate delay
  // to avoid anti-spam kicks. Never sends both register and login at once.
  let authState    = 'none';   // 'none' | 'registered' | 'done'
  let lastAuthSent = 0;
  let authTimer    = null;

  function sendAuth(cmd) {
    if (authTimer) { clearTimeout(authTimer); authTimer = null; }
    const wait = AUTH_DELAY - (Date.now() - lastAuthSent);
    if (wait <= 0) {
      lastAuthSent = Date.now();
      bot.chat(cmd);
      log(`Auth: ${cmd}`);
    } else {
      authTimer = setTimeout(() => {
        lastAuthSent = Date.now();
        bot.chat(cmd);
        log(`Auth: ${cmd}`);
        authTimer = null;
      }, wait);
    }
  }

  function buildRegister() {
    return globalConfig.registerMode === 'double'
      ? `/register ${globalConfig.register} ${globalConfig.register}`
      : `/register ${globalConfig.register}`;
  }

  bot.on('spawn', () => {
    log(`Spawned on \`${server}\` — waiting for server auth prompt`);
    // Do NOT send auth here — wait for the server to ask.
    // Sending immediately triggers anti-spam on most servers.
  });

  bot.on('ready', () => {
    joined          = true;
    entry.status    = 'online';
    entry.joinedAt  = new Date();
    clearTimeout(offlineTimer);
    log(`**${username}** is in-game on \`${server}\``);
    if (globalConfig.joinMsg1) { bot.chat(globalConfig.joinMsg1); log(`Sent: ${globalConfig.joinMsg1}`); }
    if (globalConfig.joinMsg2) { bot.chat(globalConfig.joinMsg2); log(`Sent: ${globalConfig.joinMsg2}`); }
    onEvent('ready', username);
  });

  bot.on('chat', ({ source, message }) => {
    const clean = stripColor(message);
    const src   = source ? `<${source}> ` : '';
    log(`${src}${clean}`);

    // Auth: only respond to server messages (empty source), only before joined,
    // and only for one command per trigger (not both at once).
    if (!joined && !source) {
      const lower = clean.toLowerCase();

      if (lower.includes('register') && authState === 'none' && globalConfig.register) {
        authState = 'registered';
        sendAuth(buildRegister());
      } else if (lower.includes('login') && authState !== 'done' && globalConfig.login) {
        authState = 'done';
        sendAuth(`/login ${globalConfig.login}`);
      } else {
        // Common registration-success patterns — follow up with login
        const regOk = lower.includes('registrado') || lower.includes('registered') ||
                      lower.includes('successfully') || lower.includes('contraseña') ||
                      lower.includes('password set');
        if (regOk && authState === 'none' && globalConfig.login) {
          authState = 'done';
          sendAuth(`/login ${globalConfig.login}`);
        }
      }
    }

        if (joined || source) {
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

    if (givingUp || intentional) {
      registry.delete(key);
      return;
    }

    if (!joined) {
      const noRetry = [
        'another location', 'already connected', 'duplicate',
        'ya hay alguien', 'nombre', 'username taken', 'name is taken',
        'ya existe', 'already exists',
      ];
      if (noRetry.some(r => reason.toLowerCase().includes(r))) {
        log(`Kicked (duplicate connection) — not retrying`);
        onEvent('duplicate', username, reason);
        registry.delete(key);
        return;
      }
      if (attempt < MAX_RETRY) {
        log(`Failed to join (\`${reason}\`) — retrying in 5s (${attempt}/${MAX_RETRY})`);
        registry.delete(key);
        setTimeout(() => spawnBot({ ...opts, attempt: attempt + 1 }), 5000);
      } else {
        log(`Could not join after ${MAX_RETRY} attempts`);
        onEvent('failed', username, reason);
        registry.delete(key);
      }
    } else {
      log(`Disconnected: \`${reason}\``);
      onEvent('disconnect', username, reason);
      registry.delete(key);
    }
  });

  bot.on('error', (err) => {
    clearTimeout(offlineTimer);
    if (authTimer) { clearTimeout(authTimer); authTimer = null; }
    if (givingUp) return;
    const m          = err.message || String(err);
    const isOffline  = m.includes('ECONNREFUSED') || m.includes('ETIMEDOUT') || m.includes('timeout');

    if (isOffline) {
      log(`Server unreachable: \`${m}\``);
      onEvent('offline', username, m);
      registry.delete(key);
    } else if (!joined && attempt < MAX_RETRY) {
      log(`Error: \`${m}\` — retrying in 5s`);
      registry.delete(key);
      setTimeout(() => spawnBot({ ...opts, attempt: attempt + 1 }), 5000);
    } else {
      log(`Error: \`${m}\``);
      onEvent('error', username, m);
      registry.delete(key);
    }
  });

  bot.connect();
}

const commands = {

  // .help
  async help(msg) {
    const p = PREFIX;
    await msg.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(C.PRIMARY)
          .setTitle('Draconium  —  Command Reference')
          .setDescription('AFK bot controller for MCPE 0.14.x / PocketMine-MP')
          .addFields(
            {
              name: 'Setup',
              value: [
                `\`${p}configure\`  — Interactive wizard: set register password, login password, and join messages.`,
                `\`${p}config\`  — View the current global config.`,
              ].join('\n'),
            },
            {
              name: 'Connection',
              value: [
                `\`${p}join <ip:port> <bot1,bot2,...>\`  — Connect one or more bots.`,
                `\`${p}leave <username|*>\`  — Disconnect a bot, or \`*\` to disconnect all.`,
              ].join('\n'),
            },
            {
              name: 'Chat',
              value: [
                `\`${p}chat * <message>\`  — Broadcast from all online bots.`,
                `\`${p}chat <username> <message>\`  — Send from a specific bot.`,
              ].join('\n'),
            },
            {
              name: 'Chat Bridge',
              value: [
                `\`${p}chatarea <username> #channel on\`  — Bridge bot MC chat to a Discord channel (bidirectional).`,
                `\`${p}chatarea <username> #channel off\`  — Disable a bridge.`,
                `\`${p}chatarea list\`  — List all configured bridges.`,
              ].join('\n'),
            },
            {
              name: 'Info',
              value: [
                `\`${p}list\`  — All active bots and their status.`,
                `\`${p}info <username>\`  — Detailed info for a specific bot.`,
                `\`${p}logs <username>\`  — Paginated log viewer.`,
                `\`${p}credits\`  — About.`,
              ].join('\n'),
            },
            {
              name: 'Example',
              value: '```\n' +
                `${p}configure\n` +
                `${p}join play.example.com:19132 AFK1,AFK2\n` +
                `${p}chatarea AFK1 #minecraft-chat on\n` +
                `${p}chat * Hello everyone!\n` +
                `${p}leave *\n` +
                '```',
            },
          )
          .setFooter(foot())
          .setTimestamp(),
      ],
    });
  },

  // .configure  — interactive step-by-step wizard
  async configure(msg) {
    const steps = [
      { key: 'register',     label: 'Register Password', desc: 'The password sent with /register.' },
      { key: 'registerMode', label: 'Register Mode',     desc: 'Type `single` for /register <pw>  OR  `double` for /register <pw> <pw>' },
      { key: 'login',    label: 'Login Password',    desc: 'Used as: `/login <password>`' },
      { key: 'joinMsg1', label: 'Join Message 1',    desc: 'Sent in-game when the bot is ready. Leave blank to skip.' },
      { key: 'joinMsg2', label: 'Join Message 2',    desc: 'Second message sent after Join Message 1. Leave blank to skip.' },
    ];

    const collected = {};
    let stepIndex   = 0;

    const makeStepEmbed = () => {
      const step    = steps[stepIndex];
      const current = globalConfig[step.key];
      return new EmbedBuilder()
        .setColor(C.INFO)
        .setTitle(`Configure  —  Step ${stepIndex + 1} of ${steps.length}`)
        .setDescription(
          `**${step.label}**\n${step.desc}\n\n` +
          `Current value: ${current ? `\`${current}\`` : '*(not set)*'}\n\n` +
          'Type a new value, or click **Skip** to keep the current value.\n' +
          'Click **Cancel** to abort without saving.'
        )
        .setFooter(foot());
    };

    const makeRow = () => new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('cfg_skip').setLabel('Skip').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('cfg_cancel').setLabel('Cancel').setStyle(ButtonStyle.Danger),
    );

    const promptMsg = await msg.reply({ embeds: [makeStepEmbed()], components: [makeRow()] });

    const runStep = async (promptRef) => {
      if (stepIndex >= steps.length) {
        for (const [k, v] of Object.entries(collected)) globalConfig[k] = v;
        await promptRef.edit({
          embeds: [
            new EmbedBuilder()
              .setColor(C.SUCCESS)
              .setTitle('Config Saved')
              .setDescription(configSummary())
              .setFooter(foot())
              .setTimestamp(),
          ],
          components: [],
        });
        return;
      }

      const step         = steps[stepIndex];
      const btnCollector = promptRef.createMessageComponentCollector({ time: 60_000, max: 1 });
      const msgCollector = msg.channel.createMessageCollector({
        filter: m => m.author.id === msg.author.id,
        time:   60_000,
        max:    1,
      });
      const cleanup = () => { btnCollector.stop(); msgCollector.stop(); };

      btnCollector.on('collect', async (interaction) => {
        if (interaction.user.id !== msg.author.id) {
          return interaction.reply({ content: 'This configuration wizard belongs to someone else.', ephemeral: true });
        }
        cleanup();
        if (interaction.customId === 'cfg_cancel') {
          await interaction.update({
            embeds: [new EmbedBuilder().setColor(C.MUTED).setDescription('Configuration cancelled. No changes were saved.').setFooter(foot())],
            components: [],
          });
          return;
        }
        // Skip — keep current value
        collected[step.key] = globalConfig[step.key];
        stepIndex++;
        await interaction.update({ embeds: [makeStepEmbed()], components: stepIndex < steps.length ? [makeRow()] : [] });
        await runStep(promptRef);
      });

      msgCollector.on('collect', async (reply) => {
        cleanup();
        reply.delete().catch(() => {});
        collected[step.key] = reply.content.trim();
        stepIndex++;
        await promptRef.edit({ embeds: [makeStepEmbed()], components: stepIndex < steps.length ? [makeRow()] : [] });
        await runStep(promptRef);
      });

      btnCollector.on('end', (_, reason) => {
        if (reason === 'time') {
          promptRef.edit({
            embeds: [new EmbedBuilder().setColor(C.WARN).setDescription('Configuration timed out. No changes were saved.').setFooter(foot())],
            components: [],
          }).catch(() => {});
          msgCollector.stop();
        }
      });
    };

    await runStep(promptMsg);
  },

  // .config
  async config(msg) {
    await msg.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(C.PRIMARY)
          .setTitle('Global Config')
          .setDescription(configSummary())
          .addFields({ name: 'Note', value: `Use \`${PREFIX}configure\` to change these values.` })
          .setFooter(foot())
          .setTimestamp(),
      ],
    });
  },

  // .join <ip:port> <bot1,bot2,...>
  async join(msg, args) {
    if (args.length < 2) {
      return msg.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(C.WARN)
            .setTitle('Usage')
            .setDescription(`\`${PREFIX}join <ip:port> <bot1,bot2,...>\``)
            .addFields({ name: 'Example', value: `\`${PREFIX}join play.example.com:19132 AFK1,AFK2\`` })
            .setFooter(foot()),
        ],
      });
    }

    const [serverArg, usersArg] = args;
    const [host, portStr = '19132'] = serverArg.includes(':') ? serverArg.split(':') : [serverArg, '19132'];
    const port      = parseInt(portStr, 10) || 19132;
    const usernames = usersArg.split(',').map(u => u.trim()).filter(Boolean);

    if (!usernames.length) {
      return msg.reply({
        embeds: [new EmbedBuilder().setColor(C.DANGER).setDescription('No valid usernames provided.').setFooter(foot())],
      });
    }

    const cfgLines = [
      globalConfig.register ? `Register: \`${globalConfig.register}\`` : 'Register: *(not set)*',
      globalConfig.login    ? `Login: \`${globalConfig.login}\``       : 'Login: *(not set)*',
    ].join('\n');

    const statusMsg = await msg.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(C.INFO)
          .setTitle('Connecting...')
          .addFields(
            { name: 'Server', value: `\`${host}:${port}\``,                     inline: true },
            { name: 'Bots',   value: usernames.map(u => `\`${u}\``).join(', '), inline: true },
            { name: 'Config', value: cfgLines },
          )
          .setFooter(foot())
          .setTimestamp(),
      ],
    });

    const results  = {};
    const statuses = {};
    for (const u of usernames) statuses[u] = '⏳ queued';

    const statusLabels = {
      ready:     (u) => `✅ \`${u}\`  joined`,
      exists:    (u) => `✅ \`${u}\`  already connected`,
      timeout:   (u) => `❌ \`${u}\`  timed out`,
      offline:   (u) => `❌ \`${u}\`  server offline`,
      duplicate: (u) => `⚠️ \`${u}\`  duplicate, skipped`,
      failed:    (u) => `❌ \`${u}\`  failed after ${MAX_RETRY} attempts`,
      connecting:(u) => `🔄 \`${u}\`  connecting...`,
    };

    async function updateEmbed(final = false) {
      const lines = usernames.map(u => {
        if (results[u]) return (statusLabels[results[u]] ?? ((u) => `❓ \`${u}\`  unknown`))(u);
        return statuses[u] || statusLabels.connecting(u);
      });
      const allOk = final && usernames.every(u => ['ready','exists'].includes(results[u]));
      await statusMsg.edit({
        embeds: [
          new EmbedBuilder()
            .setColor(final ? (allOk ? C.SUCCESS : C.WARN) : C.INFO)
            .setTitle(final ? (allOk ? 'All Bots Connected' : 'Connection Results') : 'Connecting...')
            .setDescription(lines.join('\n'))
            .addFields({ name: 'Server', value: `\`${host}:${port}\``, inline: true })
            .setFooter(foot())
            .setTimestamp(),
        ],
      }).catch(() => {});
    }

    await Promise.all(usernames.map((username, i) =>
      new Promise((resolve) => {
        const startDelay = i * BOT_DELAY;
        statuses[username] = `⏳ \`${username}\`  starts in ${Math.round(startDelay/1000)}s`;
        setTimeout(async () => {
          statuses[username] = statusLabels.connecting(username);
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
              const terminal = ['ready', 'exists', 'timeout', 'offline', 'duplicate', 'failed'];
              if (terminal.includes(event)) done(event);
            },
          });

          setTimeout(() => done('timeout'), OFFLINE_MS + 5000);
        }, startDelay);
      })
    ));

    await updateEmbed(true);
  },

  // .leave <username|*>
  async leave(msg, args) {
    const target = args[0];
    if (!target) {
      return msg.reply({
        embeds: [new EmbedBuilder().setColor(C.WARN).setDescription(`Usage: \`${PREFIX}leave <username|*>\``).setFooter(foot())],
      });
    }

    if (target === '*') {
      const count = registry.size;
      if (!count) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(C.MUTED).setDescription('No bots are currently connected.').setFooter(foot())],
        });
      }
      for (const [, e] of registry) {
        try { e.bot.disconnect('Discord: leave *'); } catch (_) {}
      }
      registry.clear();
      return msg.reply({
        embeds: [new EmbedBuilder().setColor(C.SUCCESS).setDescription(`Disconnected ${count} bot(s).`).setFooter(foot())],
      });
    }

    const entry = registry.get(target.toLowerCase());
    if (!entry) {
      return msg.reply({
        embeds: [new EmbedBuilder().setColor(C.DANGER).setDescription(`No active bot named \`${target}\`.`).setFooter(foot())],
      });
    }

        entry.bot.disconnect('Discord: leave');
        return msg.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(C.SUCCESS)
          .setDescription(`\`${entry.username}\` disconnected from \`${entry.server}\`.`)
          .setFooter(foot()),
      ],
    });
  },

  // .list
  async list(msg) {
    if (!registry.size) {
      return msg.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(C.MUTED)
            .setTitle('Active Bots')
            .setDescription(`No bots connected. Use \`${PREFIX}join\` to connect one.`)
            .setFooter(foot()),
        ],
      });
    }

    const rows = [];
    for (const [, e] of registry) {
      const uptime    = e.joinedAt ? fmtDuration(Date.now() - e.joinedAt.getTime()) : '—';
      const bridge    = chatBridges.get(e.username.toLowerCase());
      const bridgeTag = bridge?.enabled ? '  [bridge]' : '';
      rows.push(`**${e.username}**${bridgeTag}  |  ${statusDot(e.status)}  |  \`${e.server}\`  |  ${uptime}`);
    }

    await msg.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(C.PRIMARY)
          .setTitle(`Active Bots (${registry.size})`)
          .setDescription(rows.join('\n'))
          .setFooter(foot())
          .setTimestamp(),
      ],
    });
  },

  // .info <username>
  async info(msg, args) {
    const username = args[0];
    if (!username) {
      return msg.reply({
        embeds: [new EmbedBuilder().setColor(C.WARN).setDescription(`Usage: \`${PREFIX}info <username>\``).setFooter(foot())],
      });
    }

    const e = registry.get(username.toLowerCase());
    if (!e) {
      return msg.reply({
        embeds: [new EmbedBuilder().setColor(C.DANGER).setDescription(`No active bot named \`${username}\`.`).setFooter(foot())],
      });
    }

    const uptime   = e.joinedAt ? fmtDuration(Date.now() - e.joinedAt.getTime()) : '—';
    const joinedAt = e.joinedAt ? `<t:${Math.floor(e.joinedAt.getTime() / 1000)}:R>` : '—';
    const bridge   = chatBridges.get(username.toLowerCase());

    const { x, y, z } = e.bot.position ?? {};
    const posStr = (x != null) ? `${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)}` : '—';

    await msg.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(e.status === 'online' ? C.SUCCESS : C.WARN)
          .setTitle(`Bot Info  —  ${e.username}`)
          .addFields(
            { name: 'Server',    value: `\`${e.server}\``,             inline: true },
            { name: 'Status',    value: statusDot(e.status),            inline: true },
            { name: 'Uptime',    value: uptime,                         inline: true },
            { name: 'Joined',    value: joinedAt,                       inline: true },
            { name: 'Health',    value: `${e.bot.health ?? '—'}/20`,   inline: true },
            { name: 'Position',  value: posStr,                         inline: true },
            { name: 'Log Lines', value: `${e.logs.length}`,            inline: true },
            { name: 'Bridge',    value: bridge?.enabled ? `<#${bridge.channelId}>` : 'Off', inline: true },
          )
          .setFooter(foot())
          .setTimestamp(),
      ],
    });
  },

  // .chat * <message>  |  .chat <username> <message>
  async chat(msg, args) {
    if (args.length < 2) {
      return msg.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(C.WARN)
            .setTitle('Usage')
            .addFields(
              { name: 'All bots',     value: `\`${PREFIX}chat * <message>\`` },
              { name: 'Specific bot', value: `\`${PREFIX}chat <username> <message>\`` },
            )
            .setFooter(foot()),
        ],
      });
    }

    const [target, ...rest] = args;
    const message = rest.join(' ');

    if (target === '*') {
      if (!registry.size) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(C.DANGER).setDescription('No bots connected.').setFooter(foot())],
        });
      }
      const sent    = [];
      const skipped = [];
      for (const [, e] of registry) {
        if (e.status === 'online' || (e.bot && e.bot.connected)) { e.bot.chat(message); sent.push(e.username); }
        else skipped.push(e.username);
      }
      const fields = [{ name: 'Message', value: message }];
      if (sent.length)    fields.push({ name: 'Sent by',  value: sent.map(u => `\`${u}\``).join(', '),    inline: true });
      if (skipped.length) fields.push({ name: 'Skipped',  value: skipped.map(u => `\`${u}\``).join(', '), inline: true });
      return msg.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(sent.length ? C.SUCCESS : C.WARN)
            .setTitle('Broadcast')
            .addFields(...fields)
            .setFooter(foot())
            .setTimestamp(),
        ],
      });
    }

    const entry = registry.get(target.toLowerCase());
    if (!entry) {
      return msg.reply({
        embeds: [new EmbedBuilder().setColor(C.DANGER).setDescription(`No active bot named \`${target}\`. Use \`${PREFIX}list\` to see connected bots.`).setFooter(foot())],
      });
    }
    if (entry.status !== 'online') {
      return msg.reply({
        embeds: [new EmbedBuilder().setColor(C.WARN).setDescription(`\`${entry.username}\` is not in-game yet (status: ${statusDot(entry.status)}).`).setFooter(foot())],
      });
    }

    entry.bot.chat(message);
    return msg.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(C.SUCCESS)
          .setTitle('Message Sent')
          .addFields(
            { name: 'Message', value: message },
            { name: 'From',    value: `\`${entry.username}\``, inline: true },
            { name: 'Server',  value: `\`${entry.server}\``,   inline: true },
          )
          .setFooter(foot())
          .setTimestamp(),
      ],
    });
  },

  // .chatarea <username> #channel <on|off>  |  .chatarea list
  async chatarea(msg, args) {
    if (args[0] === 'list') {
      if (!chatBridges.size) {
        return msg.reply({
          embeds: [new EmbedBuilder().setColor(C.MUTED).setTitle('Chat Bridges').setDescription('No bridges configured.').setFooter(foot())],
        });
      }
      const rows = [];
      for (const [username, b] of chatBridges) {
        rows.push(`**${username}**  ->  <#${b.channelId}>  |  ${b.enabled ? 'Enabled' : 'Disabled'}`);
      }
      return msg.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(C.BRIDGE)
            .setTitle('Chat Bridges')
            .setDescription(rows.join('\n'))
            .setFooter(foot())
            .setTimestamp(),
        ],
      });
    }

    if (args.length < 3) {
      return msg.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(C.WARN)
            .setTitle('Usage')
            .addFields(
              { name: 'Enable',  value: `\`${PREFIX}chatarea <username> #channel on\`` },
              { name: 'Disable', value: `\`${PREFIX}chatarea <username> #channel off\`` },
              { name: 'List',    value: `\`${PREFIX}chatarea list\`` },
            )
            .setFooter(foot()),
        ],
      });
    }

    const [username, channelMention, toggle] = args;
    const channelId = channelMention.replace(/[<#>]/g, '');
    const enabled   = toggle?.toLowerCase() === 'on';

    let channel;
    try { channel = await client.channels.fetch(channelId); } catch (_) {}
    if (!channel) {
      return msg.reply({
        embeds: [new EmbedBuilder().setColor(C.DANGER).setDescription('Could not find that channel. Make sure you mention it with #.').setFooter(foot())],
      });
    }

    const key = username.toLowerCase();
    chatBridges.set(key, { channelId, enabled });
    const entry = registry.get(key);

    await msg.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(enabled ? C.BRIDGE : C.MUTED)
          .setTitle(`Chat Bridge ${enabled ? 'Enabled' : 'Disabled'}`)
          .setDescription(enabled
            ? `MC chat from **${username}** will appear in <#${channelId}>.\nMessages sent in <#${channelId}> will be forwarded to MC via **${username}**.`
            : `Bridge for **${username}** has been disabled.`
          )
          .addFields(
            { name: 'Bot',     value: `\`${username}\``, inline: true },
            { name: 'Channel', value: `<#${channelId}>`, inline: true },
            { name: 'Status',  value: entry ? statusDot(entry.status) : 'Bot not connected', inline: true },
          )
          .setFooter(foot())
          .setTimestamp(),
      ],
    });
  },

  // .logs <username>
  async logs(msg, args) {
    const username = args[0];
    if (!username) {
      return msg.reply({
        embeds: [new EmbedBuilder().setColor(C.WARN).setDescription(`Usage: \`${PREFIX}logs <username>\``).setFooter(foot())],
      });
    }

    const entry = registry.get(username.toLowerCase());
    if (!entry) {
      return msg.reply({
        embeds: [new EmbedBuilder().setColor(C.DANGER).setDescription(`No active bot named \`${username}\`.`).setFooter(foot())],
      });
    }

    const pages = paginateLogs(entry.logs.slice(-50));
    let pi = 0;

    const makeEmbed = (i) =>
      new EmbedBuilder()
        .setColor(C.DARK)
        .setTitle(`Logs  —  ${entry.username}`)
        .setDescription(pages[i] || '*(empty)*')
        .setFooter({ text: `Page ${i + 1}/${pages.length}  |  ${entry.server}  |  Draconium` })
        .setTimestamp();

    const makeRow = (i) =>
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('lp').setLabel('Prev').setStyle(ButtonStyle.Secondary).setDisabled(i === 0),
        new ButtonBuilder().setCustomId('ln').setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(i >= pages.length - 1),
      );

    const reply = await msg.reply({
      embeds:     [makeEmbed(pi)],
      components: pages.length > 1 ? [makeRow(pi)] : [],
    });

    if (pages.length <= 1) return;

    const col = reply.createMessageComponentCollector({ time: 120_000 });
    col.on('collect', async (interaction) => {
      if (interaction.user.id !== msg.author.id) {
        return interaction.reply({ content: 'This log viewer belongs to someone else.', ephemeral: true });
      }
      if (interaction.customId === 'lp' && pi > 0)               pi--;
      if (interaction.customId === 'ln' && pi < pages.length - 1) pi++;
      await interaction.update({ embeds: [makeEmbed(pi)], components: [makeRow(pi)] });
    });
    col.on('end', () => reply.edit({ components: [] }).catch(() => {}));
  },

  // .credits
  async credits(msg) {
    await msg.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(C.PRIMARY)
          .setTitle('Draconium')
          .setDescription('AFK Bot for MCPE 0.14.x / PocketMine-MP\nCustom RakNet implementation — no game-protocol dependencies.')
          .addFields(
            { name: 'Stack',    value: 'Node.js  |  discord.js v14  |  draconium', inline: false },
            { name: 'Protocol', value: 'MCPE Protocol 70 (v0.14.x)',                inline: true  },
            { name: 'License',  value: 'GNU',                                       inline: true  },
          )
          .setFooter(foot())
          .setTimestamp(),
      ],
    });
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
      // Prefix the message with the Discord username so it's identifiable in MC
      entry.bot.chat(msg.content);
    }
    return;
  }

  const [rawCmd, ...args] = msg.content.slice(PREFIX.length).trim().split(/\s+/);
  const cmd = rawCmd.toLowerCase();
  if (!commands[cmd]) return;

  try {
    await commands[cmd](msg, args);
  } catch (err) {
    console.error('[Discord] Command error:', err);
    await msg.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(C.DANGER)
          .setTitle('Internal Error')
          .setDescription('```' + (err.message || String(err)) + '```')
          .setFooter(foot()),
      ],
    }).catch(() => {});
  }
});

client.once('clientReady', () => {
  console.log(`[Discord] Online as ${client.user.tag}`);
  client.user.setActivity(`${PREFIX}help  |  Draconium`);
});

client.login(DISCORD_TOKEN).catch((err) => {
  console.error('[Discord] Login failed:', err.message);
  process.exit(1);
});

process.on('SIGINT', () => {
  console.log('[Draconium] Shutting down...');
  for (const [, e] of registry) {
    try { e.bot.disconnect('shutdown'); } catch (_) {}
  }
  client.destroy();
  setTimeout(() => process.exit(0), 500);
});