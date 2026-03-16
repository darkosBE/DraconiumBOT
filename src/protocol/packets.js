'use strict';

const zlib = require('zlib');
const { PKT, PLAY_STATUS, MOVE_MODE, TEXT_TYPE, PROTOCOL_VERSION } = require('./ids');
const { readString, writeString, randomUUID } = require('./binary');
const { STEVE_SKIN } = require('./skin');

function decodeBatch(data, onPacket) {
  if (data.length < 4) return;

  const compLen    = data.readUInt32BE(0);
  const compressed = data.slice(4, 4 + compLen);

  const tryInflate = (buf, cb) => {
    zlib.inflate(buf, (e, r) => {
      if (!e) return cb(r);
      zlib.inflateRaw(buf, (e2, r2) => cb(e2 ? null : r2));
    });
  };

  tryInflate(compressed, (inflated) => {
    if (!inflated) {
      tryInflate(data, (inflated2) => {
        if (inflated2) parseBatchPayload(inflated2, onPacket);
      });
      return;
    }
    parseBatchPayload(inflated, onPacket);
  });
}

function parseBatchPayload(buf, onPacket) {
  let o = 0;
  while (o + 4 <= buf.length) {
    const pkLen = buf.readUInt32BE(o); o += 4;
    if (!pkLen || o + pkLen > buf.length) break;
    const pkt = buf.slice(o, o + pkLen); o += pkLen;
    onPacket(pkt);
  }
}

function encodeBatch(mcpePayload, cb) {
  const inner = Buffer.alloc(4 + 1 + mcpePayload.length);
  inner.writeInt32BE(1 + mcpePayload.length, 0);
  inner.writeUInt8(0x8e, 4);
  mcpePayload.copy(inner, 5);

  zlib.deflate(inner, { level: 7 }, (err, compressed) => {
    if (err) return;
    const batch = Buffer.alloc(2 + 4 + compressed.length);
    batch.writeUInt8(0x8e, 0);
    batch.writeUInt8(PKT.BATCH, 1);
    batch.writeInt32BE(compressed.length, 2);
    compressed.copy(batch, 6);
    cb(batch);
  });
}

function encodeLogin(username, host) {
  const buf = Buffer.alloc(9000);
  let o = 0;

  buf.writeUInt8(PKT.LOGIN, o++);
  o += writeString(buf, o, username);
  buf.writeInt32BE(PROTOCOL_VERSION, o); o += 4;
  buf.writeInt32BE(PROTOCOL_VERSION, o); o += 4; 
  buf.writeBigInt64BE(BigInt((Math.random() * 0xFFFFFFFF) | 0), o); o += 8;  
  randomUUID().copy(buf, o); o += 16;             
  o += writeString(buf, o, host);                 
  o += writeString(buf, o, '');                    
  o += writeString(buf, o, STEVE_SKIN.length === 8192 ? 'Standard' : 'Custom');
  buf.writeUInt16BE(STEVE_SKIN.length, o); o += 2;
  STEVE_SKIN.copy(buf, o); o += STEVE_SKIN.length;

  return buf.slice(0, o);
}

function decodeStartGame(data) {
  if (data.length < 45) return null;
  try {
    return {
      eid:    Number(data.readBigInt64BE(13)),
      spawnX: data.readInt32BE(21),
      spawnY: data.readInt32BE(25),
      spawnZ: data.readInt32BE(29),
      x:      data.readFloatBE(33),
      y:      data.readFloatBE(37),  
      z:      data.readFloatBE(41),
    };
  } catch (_) { return null; }
}

const EYE_HEIGHT = 1.62;

function decodeMovePlayer(data) {
  if (data.length < 34) return null;
  try {
    let o     = 0;
    const eid  = Number(data.readBigInt64BE(o)); o += 8;
    const x    = data.readFloatBE(o); o += 4;
    const eyeY = data.readFloatBE(o); o += 4;
    const z    = data.readFloatBE(o); o += 4;
    o += 12;
    const mode     = data.length > o ? data.readUInt8(o++) : MOVE_MODE.NORMAL;
    const onGround = data.length > o ? data.readUInt8(o)   : 1;
    return { eid, x, feetY: eyeY - EYE_HEIGHT, z, mode, onGround: onGround > 0 };
  } catch (_) { return null; }
}

function encodeMovePlayer(eid, x, y, z, onGround) {
  const buf = Buffer.alloc(1 + 8 + 4*6 + 2);
  let o = 0;
  buf.writeUInt8(PKT.MOVE_PLAYER, o++);
  buf.writeBigInt64BE(BigInt(eid), o); o += 8;
  buf.writeFloatBE(x,            o); o += 4;
  buf.writeFloatBE(y + EYE_HEIGHT, o); o += 4;
  buf.writeFloatBE(z,            o); o += 4;
  buf.writeFloatBE(0,            o); o += 4;  
  buf.writeFloatBE(0,            o); o += 4;  
  buf.writeFloatBE(0,            o); o += 4;  
  buf.writeUInt8(MOVE_MODE.NORMAL,   o++);
  buf.writeUInt8(onGround ? 1 : 0,   o);
  return buf;
}

function decodeText(data) {
  try {
    let o    = 0;
    const type = data.readUInt8(o++);
    let source = '', message = '';

    if (type === TEXT_TYPE.CHAT || type === TEXT_TYPE.POPUP) {
      const s = readString(data, o); o += s.size; source = s.value;
      const m = readString(data, o); o += m.size; message = m.value;
    } else if (type === TEXT_TYPE.RAW || type === TEXT_TYPE.TIP || type === TEXT_TYPE.SYSTEM) {
      const m = readString(data, o); o += m.size; message = m.value;
    } else if (type === TEXT_TYPE.TRANSLATION) {
      const m    = readString(data, o); o += m.size; message = m.value;
      const cnt  = data.length > o ? data.readUInt8(o++) : 0;
      const params = [];
      for (let i = 0; i < cnt && o + 2 <= data.length; i++) {
        const p = readString(data, o); o += p.size; params.push(p.value);
      }
      if (params.length) message += ' ' + params.join(' ');
    }

    return { source, message };
  } catch (_) { return null; }
}

function encodeChat(username, message) {
  const uLen = Buffer.byteLength(username, 'utf8');
  const mLen = Buffer.byteLength(message,  'utf8');
  const buf  = Buffer.alloc(1 + 1 + 2 + uLen + 2 + mLen);
  let o = 0;
  buf.writeUInt8(PKT.TEXT, o++);
  buf.writeUInt8(TEXT_TYPE.CHAT, o++);
  o += writeString(buf, o, username);
  o += writeString(buf, o, message);
  return buf;
}

function decodeSetHealth(data) {
  return data.length >= 4 ? data.readInt32BE(0) : null;
}

function decodeSetSpawnPosition(data) {
  if (data.length < 12) return null;
  return { x: data.readInt32BE(0), y: data.readInt32BE(4), z: data.readInt32BE(8) };
}

function decodeRespawn(data) {
  if (data.length < 12) return null;
  return { x: data.readFloatBE(0), y: data.readFloatBE(4), z: data.readFloatBE(8) };
}

function encodeRespawn() {
  return Buffer.from([PKT.RESPAWN]);
}

function decodeSetEntityMotion(data) {
  if (data.length < 4) return [];
  try {
    let o     = 0;
    const cnt = data.readInt32BE(o); o += 4;
    const out = [];
    for (let i = 0; i < cnt && o + 20 <= data.length; i++) {
      const eid = Number(data.readBigInt64BE(o)); o += 8;
      const vx  = data.readFloatBE(o); o += 4;
      const vy  = data.readFloatBE(o); o += 4;
      const vz  = data.readFloatBE(o); o += 4;
      out.push({ eid, vx, vy, vz });
    }
    return out;
  } catch (_) { return []; }
}

function decodePlayStatus(data) {
  return data.length >= 4 ? data.readInt32BE(0) : null;
}

function decodeDisconnect(data) {
  try {
    if (data.length >= 2) {
      const len = data.readUInt16BE(0);
      return data.slice(2, 2 + len).toString('utf8');
    }
  } catch (_) {}
  return 'disconnected';
}

function encodeRequestChunkRadius(radius = 8) {
  const buf = Buffer.alloc(5);
  buf.writeUInt8(PKT.REQUEST_CHUNK_RADIUS, 0);
  buf.writeInt32BE(radius, 1);
  return buf;
}

module.exports = {
  decodeBatch,
  encodeBatch,
  encodeLogin,
  decodeStartGame,
  decodeMovePlayer,
  encodeMovePlayer,
  decodeText,
  encodeChat,
  decodeSetHealth,
  decodeSetSpawnPosition,
  decodeRespawn,
  encodeRespawn,
  decodeSetEntityMotion,
  decodePlayStatus,
  decodeDisconnect,
  encodeRequestChunkRadius,
  EYE_HEIGHT,
};