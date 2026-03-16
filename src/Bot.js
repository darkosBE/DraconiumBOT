'use strict';

const EventEmitter = require('events');
const RakNet       = require('./RakNet');
const { Physics }  = require('./physics/Physics');
const packets      = require('./protocol/packets');
const { PKT, PLAY_STATUS, MOVE_MODE } = require('./protocol/ids');

class Bot extends EventEmitter {
  constructor(opts = {}) {
    super();

    this.options = {
      host:     opts.host     || '127.0.0.1',
      port:     opts.port     || 19132,
      username: opts.username || 'DraconiumBot',
      version:  opts.version  || '0.14.3',
    };

    this.connected = false;
    this.spawned   = false;
    this.entity    = null;
    this.health    = 20;

    this._physics   = new Physics((x, y, z) => this._sendMove(x, y, z));
    this._raknet    = null;
    this._loginSent = false;
    this._keepAlive = null;
    this._heartbeat = null;
  }

  get position() { return { ...this._physics.pos }; }
  get onGround()  { return this._physics.onGround; }

  async connect() {
    this._raknet = new RakNet({ host: this.options.host, port: this.options.port, mtuSize: 1400 });
    this._raknet.on('connect',      ()        => { this.connected = true; setTimeout(() => this._sendLogin(), 200); });
    this._raknet.on('encapsulated', (payload) => this._onPayload(payload));
    this._raknet.on('disconnect',   (reason)  => this._onServerDisconnect(reason));
    this._raknet.on('error',        (err)     => this.emit('error', err));
    try { await this._raknet.connect(); } catch (err) { this.emit('error', err); }
  }

  chat(message) {
    if (!this.connected) return;
    this._send(packets.encodeChat(this.options.username, message));
  }

  teleport(x, y, z) {
    this._physics.setPos(x, y, z);
    this._sendMove(x, y, z);
    this.emit('move', { x, y, z });
  }

  jump() {
    if (this._physics.jump()) this.emit('jump');
  }

  respawn() {
    this._send(packets.encodeRespawn());
    this.emit('respawn');
  }

  disconnect(reason = 'Disconnecting') {
    this._cleanup();
    if (this._raknet) { this._raknet.close(); this._raknet = null; }
    this.emit('disconnect', reason, true);
  }

  _sendLogin() {
    if (this._loginSent) return;
    this._loginSent = true;
    this._send(packets.encodeLogin(this.options.username, this.options.host));
  }

  _sendMove(x, y, z) {
    if (!this.connected || !this._raknet) return;
    this._send(packets.encodeMovePlayer(this.entity || 1, x, y, z, this._physics.onGround));
  }

  _send(buf) {
    if (!this._raknet) return;
    packets.encodeBatch(buf, (batch) => {
      if (this._raknet) this._raknet.sendEncapsulated(batch);
    });
  }

  // keep newPosition fresh on server so processMovement doesn't accumulate stale deltas
  _startHeartbeat() {
    if (this._heartbeat) return;
    this._heartbeat = setInterval(() => {
      if (!this.connected || !this.spawned) return;
      if (this._physics.onGround) {
        const { x, y, z } = this._physics.pos;
        this._sendMove(x, y, z);
      }
    }, 1000);
  }

  _stopHeartbeat() {
    if (this._heartbeat) { clearInterval(this._heartbeat); this._heartbeat = null; }
  }

  _onPayload(payload) {
    if (!payload || payload.length < 2) return;
    if (payload[0] === 0x8e) payload = payload.slice(1);
    const id   = payload[0];
    const data = payload.slice(1);
    switch (id) {
      case PKT.BATCH:        return packets.decodeBatch(data, (pkt) => this._onPayload(pkt));
      case PKT.PLAY_STATUS:  return this._onPlayStatus(data);
      case PKT.DISCONNECT:
      case 0x8e:             return this._onServerDisconnect(packets.decodeDisconnect(data));
      default:               return this._onGamePacket(id, data);
    }
  }

  _onPlayStatus(data) {
    const status = packets.decodePlayStatus(data);
    if (status === null) return;
    switch (status) {
      case PLAY_STATUS.LOGIN_SUCCESS:
        this.entity     = 1;
        this._keepAlive = setInterval(() => {}, 5000);
        this._send(packets.encodeRequestChunkRadius(8));
        this.emit('login');
        break;
      case PLAY_STATUS.LOGIN_FAILED_CLIENT:
        this._onServerDisconnect('outdated client'); break;
      case PLAY_STATUS.LOGIN_FAILED_SERVER:
        this._onServerDisconnect('outdated server'); break;
      case PLAY_STATUS.PLAYER_SPAWN:
        if (this.spawned) break;
        this.spawned = true;
        if (this._physics.groundY === null) this._physics.groundY = this._physics.pos.y;
        this._physics.vel      = { x: 0, y: 0, z: 0 };
        this._physics.onGround = true;
        this._physics.start();
        this._startHeartbeat();
        this.emit('spawn', { entityId: this.entity });
        this.emit('ready');
        break;
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
    }
  }

  _onStartGame(data) {
    const sg = packets.decodeStartGame(data);
    if (!sg) return;
    this.entity = sg.eid;
    this._physics.pos = { x: sg.x, y: sg.y, z: sg.z };
    if (this._physics.groundY === null) this._physics.groundY = sg.y;
  }

  _onChunkRadiusUpdate() {
    if (this._physics.chunksReady) return;
    this._physics.chunksReady  = true;
    this._physics.onGround     = false;
    this._physics.vel.y        = 0;
  }

  _onMovePlayer(data) {
    const mp = packets.decodeMovePlayer(data);
    if (!mp) return;
    if (mp.mode === MOVE_MODE.TELEPORT || mp.mode === MOVE_MODE.RESET) {
      this._physics.land(mp.x, mp.feetY, mp.z, true);
    } else if (mp.onGround) {
      this._physics.land(mp.x, mp.feetY, mp.z, false);
    }
  }

  _onText(data) {
    const txt = packets.decodeText(data);
    if (txt) this.emit('chat', txt);
  }

  _onSetHealth(data) {
    const hp = packets.decodeSetHealth(data);
    if (hp !== null) { this.health = hp; this.emit('health', hp); }
  }

  _onSetSpawnPosition(data) {
    const sp = packets.decodeSetSpawnPosition(data);
    if (sp && this._physics.groundY === null) this._physics.groundY = sp.y;
  }

  _onRespawnPacket(data) {
    const rp = packets.decodeRespawn(data);
    if (!rp) return;
    this._physics.pos      = { x: rp.x, y: rp.y, z: rp.z };
    this._physics.groundY  = rp.y;
    this._physics.vel      = { x: 0, y: 0, z: 0 };
    this._physics.onGround = false;
  }

  _onEntityMotion(data) {
    const motions = packets.decodeSetEntityMotion(data);
    for (const m of motions) {
      if (m.eid === this.entity) this._physics.applyMotion(m.vx, m.vy, m.vz);
    }
  }

  _onServerDisconnect(reason) {
    if (!this.connected && !this.spawned) return;
    this._cleanup();
    if (this._raknet) { this._raknet.close(); this._raknet = null; }
    this.emit('disconnect', reason, false);
  }

  _cleanup() {
    this._physics.stop();
    this._stopHeartbeat();
    if (this._keepAlive) { clearInterval(this._keepAlive); this._keepAlive = null; }
    this.connected            = false;
    this.spawned              = false;
    this._loginSent           = false;
    this._physics.chunksReady = false;
  }
}

module.exports = { Bot };