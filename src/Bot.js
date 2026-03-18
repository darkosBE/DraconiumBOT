'use strict';

const EventEmitter = require('events');
const RakNet       = require('./network/RakNet');
const { Physics }  = require('./physics/Physics');
const packets      = require('./protocol/packets');
const { PKT, PLAY_STATUS, MOVE_MODE } = require('./protocol/ids');

function reactionDelay(base, variance) {
  return base + Math.floor(Math.random() * variance);
}

class Bot extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.options = {
      host:     opts.host     || '127.0.0.1',
      port:     opts.port     || 19132,
      username: opts.username || 'DraconiumBot',
      version:  opts.version  || '0.14.3',
    };
    this.connected  = false;
    this.spawned    = false;
    this.entity     = null;
    this.health     = 20;
    this._physics   = new Physics((x, y, z) => this._sendMove(x, y, z));
    this._raknet    = null;
    this._loginSent = false;
  }

  get position() { return { ...this._physics.pos }; }
  get onGround()  { return this._physics.onGround; }

  async connect() {
    this._raknet = new RakNet({ host: this.options.host, port: this.options.port, mtuSize: 1400 });
    this._raknet.on('connect',      ()    => { this.connected = true; this._onRakConnected(); });
    this._raknet.on('encapsulated', p     => this._onPayload(p));
    this._raknet.on('disconnect',   r     => this._onServerDisconnect(r));
    this._raknet.on('error',        err   => this.emit('error', err));
    try { await this._raknet.connect(); } catch (err) { this.emit('error', err); }
  }

  chat(msg)        { if (this.connected) this._send(packets.encodeChat(this.options.username, msg)); }
  teleport(x, y, z) { this._physics.setPos(x, y, z); this._sendMove(x, y, z); this.emit('move', { x, y, z }); }
  jump()           { if (this._physics.jump()) this.emit('jump'); }
  respawn()        { this._send(packets.encodeRespawn()); this.emit('respawn'); }

  disconnect(reason = 'Disconnecting') {
    this._cleanup();
    if (this._raknet) { this._raknet.close(); this._raknet = null; }
    this.emit('disconnect', reason, true);
  }

  _onRakConnected() {
    if (this._loginSent) return;
    this._loginSent = true;
    setTimeout(() => {
      this._send(packets.encodeLogin(this.options.username, this.options.host));
    }, reactionDelay(80, 120));
  }

  _sendMove(x, y, z) {
    if (!this.connected || !this._raknet) return;
    this._send(packets.encodeMovePlayer(this.entity || 1, x, y, z, this._physics.onGround));
  }

  _send(buf) {
    if (!this._raknet) return;
    packets.encodeBatch(buf, batch => { if (this._raknet) this._raknet.sendEncapsulated(batch); });
  }

  _onPayload(payload) {
    if (!payload || payload.length < 2) return;
    if (payload[0] === 0x8e) payload = payload.slice(1);
    const id = payload[0], data = payload.slice(1);
    switch (id) {
      case PKT.BATCH:       return packets.decodeBatch(data, p => this._onPayload(p));
      case PKT.PLAY_STATUS: return this._onPlayStatus(data);
      case PKT.DISCONNECT:
      case 0x8e:            return this._onServerDisconnect(packets.decodeDisconnect(data));
      default:              return this._onGamePacket(id, data);
    }
  }

  _onPlayStatus(data) {
    const s = packets.decodePlayStatus(data);
    if (s === null) return;

    if (s === PLAY_STATUS.LOGIN_SUCCESS) {
      this.entity = 1;
      setTimeout(() => {
        this._send(packets.encodeRequestChunkRadius(8));
      }, reactionDelay(60, 80));
      this.emit('login');

    } else if (s === PLAY_STATUS.LOGIN_FAILED_CLIENT) {
      this._onServerDisconnect('outdated client');
    } else if (s === PLAY_STATUS.LOGIN_FAILED_SERVER) {
      this._onServerDisconnect('outdated server');

    } else if (s === PLAY_STATUS.PLAYER_SPAWN && !this.spawned) {
      this.spawned = true;
      if (this._physics.groundY === null) this._physics.groundY = this._physics.pos.y;
      this._physics.vel      = { x: 0, y: 0, z: 0 };
      this._physics.onGround = true;
      this._physics.start();
      this.emit('spawn', { entityId: this.entity });
      this.emit('ready');
    }
  }

  _onGamePacket(id, data) {
    switch (id) {
      case PKT.START_GAME:          return this._onStartGame(data);
      case PKT.MOVE_PLAYER:         return this._onMovePlayer(data);
      case PKT.TEXT:                return this._onText(data);
      case PKT.SET_HEALTH:          return this._onSetHealth(data);
      case PKT.SET_SPAWN_POSITION:  return this._onSetSpawnPosition(data);
      case PKT.RESPAWN:             return this._onRespawnPacket(data);
      case PKT.SET_ENTITY_MOTION:   return this._onEntityMotion(data);
      case PKT.CHUNK_RADIUS_UPDATE: return this._onChunkRadiusUpdate();
      case PKT.ADVENTURE_SETTINGS:  return this._onAdventureSettings();
    }
  }

  _onStartGame(data) {
    const sg = packets.decodeStartGame(data);
    if (!sg) return;
    this.entity       = sg.eid;
    this._physics.pos = { x: sg.x, y: sg.y, z: sg.z };
  }

  _onAdventureSettings() {
    setTimeout(() => {
      this._send(packets.encodeAdventureSettings());
    }, reactionDelay(40, 60));
  }

  _onChunkRadiusUpdate() {
    if (this._physics.chunksReady) return;
    this._physics.chunksReady = true;
    this._physics.onGround    = false;
    this._physics.vel.y       = 0;
  }

  _onMovePlayer(data) {
    const mp = packets.decodeMovePlayer(data);
    if (!mp) return;
    if (mp.mode === MOVE_MODE.RESET || mp.mode === MOVE_MODE.TELEPORT) {
      this._physics.land(mp.x, mp.feetY, mp.z, true);
    } else if (mp.onGround) {
      this._physics.land(mp.x, mp.feetY, mp.z, false);
    } else {
      if (mp.feetY > 0) this._physics.groundY = Math.min(this._physics.groundY ?? mp.feetY, mp.feetY);
    }
  }

  _onText(data)             { const t  = packets.decodeText(data);       if (t)           this.emit('chat', t); }
  _onSetHealth(data)        { const hp = packets.decodeSetHealth(data);  if (hp !== null) { this.health = hp; this.emit('health', hp); } }
  _onSetSpawnPosition(data) { const sp = packets.decodeSetSpawnPosition(data); if (sp && this._physics.groundY === null) this._physics.groundY = sp.y; }

  _onRespawnPacket(data) {
    const rp = packets.decodeRespawn(data);
    if (!rp) return;
    this._physics.pos      = { x: rp.x, y: rp.y, z: rp.z };
    this._physics.groundY  = rp.y;
    this._physics.vel      = { x: 0, y: 0, z: 0 };
    this._physics.onGround = false;
  }

  _onEntityMotion(data) {
    for (const m of packets.decodeSetEntityMotion(data))
      if (m.eid === this.entity) this._physics.applyMotion(m.vx, m.vy, m.vz);
  }

  _onServerDisconnect(reason) {
    if (!this.connected && !this.spawned) return;
    this._cleanup();
    if (this._raknet) { this._raknet.close(); this._raknet = null; }
    this.emit('disconnect', reason, false);
  }

  _cleanup() {
    this._physics.stop();
    this.connected = this.spawned = this._loginSent = false;
    this._physics.chunksReady = false;
  }
}

module.exports = { Bot };
