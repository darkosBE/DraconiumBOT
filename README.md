# Draconium

AFK bot for Minecraft Pocket Edition 0.14.x / PocketMine-MP servers.
Custom RakNet UDP client — no external game-protocol dependencies.

---

## Installation

```bash
npm install draconium
```

For the Discord bot:

```bash
npm install draconium discord.js
```

---

## Quick Start

```js
const { Bot } = require('draconium');

const bot = new Bot({
  host:     'play.example.com',
  port:     19132,
  username: 'MyBot',
});

bot.on('ready',  () => bot.chat('Online.'));
bot.on('chat',   ({ source, message }) => console.log(`<${source}> ${message}`));
bot.on('health', (hp) => { if (hp <= 0) setTimeout(() => bot.respawn(), 1000); });

bot.connect();
```

---

---

## API

### Constructor

```js
new Bot(options)
```

| Option     | Type   | Default          | Description           |
|------------|--------|------------------|-----------------------|
| `host`     | string | `'127.0.0.1'`    | Server IP or hostname |
| `port`     | number | `19132`          | Server UDP port       |
| `username` | string | `'DraconiumBot'` | In-game display name  |
| `version`  | string | `'0.14.3'`       | MCPE version string   |

### Methods

| Method                   | Description                       |
|--------------------------|-----------------------------------|
| `bot.connect()`          | Connect to the server             |
| `bot.chat(message)`      | Send a chat message               |
| `bot.teleport(x, y, z)` | Move the bot to coordinates       |
| `bot.jump()`             | Jump (only when on the ground)    |
| `bot.respawn()`          | Respawn after death               |
| `bot.disconnect(reason)` | Clean disconnect                  |

### Events

| Event        | Arguments             | Description                                                   |
|--------------|-----------------------|---------------------------------------------------------------|
| `ready`      | —                     | Bot is in-game                                                |
| `spawn`      | `{ entityId }`        | Spawn received                                                |
| `chat`       | `{ source, message }` | Chat message. `source` empty = server message                 |
| `health`     | `hp`                  | Health changed (0–20)                                         |
| `move`       | `{ x, y, z }`        | Position updated via teleport                                 |
| `jump`       | —                     | Bot jumped                                                    |
| `respawn`    | —                     | Respawn sent                                                  |
| `disconnect` | `reason, intentional` | `intentional=true` when you called `disconnect()`             |
| `error`      | `Error`               | Connection error                                              |

### Properties

| Property        | Type       | Description                     |
|-----------------|------------|---------------------------------|
| `bot.connected` | boolean    | RakNet connection live          |
| `bot.spawned`   | boolean    | Bot has spawned in-game         |
| `bot.entity`    | number     | Entity ID from server           |
| `bot.health`    | number     | Current health (0–20)           |
| `bot.position`  | {x, y, z} | Current feet position           |
| `bot.onGround`  | boolean    | Whether the bot is on the ground|

---

## Multiple Bots

```js
const { Bot } = require('draconium');

['AFK1', 'AFK2', 'AFK3'].forEach((username, i) => {
  setTimeout(() => {
    const bot = new Bot({ host: 'play.example.com', port: 19132, username });
    bot.on('ready', () => bot.chat('Online.'));
    bot.connect();
  }, i * 4000);
});
```

---

## Discord Bot

Requires `discord.js` v14.

Discord bot src link
[Discord bot Version](https://github.com/darkosBE/DraconiumBOT/blob/main/example/discord-bot.js)

**I have create a discord bot version so u dont have too.**

**Everythings currently on beta**

**Please expect some bugs. I u find any bugs please do create an issue. i usually check daily.**

**Setup:**
1. Create a bot at https://discord.com/developers/applications
2. Enable **Message Content Intent** under Bot > Privileged Gateway Intents
3. Invite with Send Messages, Read Message History, View Channels permissions
4. Run:

```bash
const DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'BOT TOKEN HERE';
```

**Commands:**

| Command                              | Description                        |
|--------------------------------------|------------------------------------|
| `.help`                              | Command reference                  |
| `.configure`                         | Set password and join messages     |
| `.config`                            | View current config                |
| `.join <ip:port> <bot1,bot2,...>`    | Connect bots                       |
| `.leave <username\|*>`              | Disconnect a bot or all bots       |
| `.list`                              | All active bots                    |
| `.info <username>`                   | Health, position, uptime           |
| `.chat * <message>`                  | Broadcast from all bots            |
| `.chat <username> <message>`         | Send from a specific bot           |
| `.chatarea <username> #channel on`   | Bridge MC chat to Discord          |
| `.chatarea <username> #channel off`  | Disable bridge                     |
| `.chatarea list`                     | List bridges                       |
| `.logs <username>`                   | Paginated log viewer               |

---

## License

GPL-3.0
