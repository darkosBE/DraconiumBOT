'use strict';

const dgram        = require('dgram');
const dns          = require('dns').promises;
const crypto       = require('crypto');
const EventEmitter = require('events');

const MAGIC = Buffer.from([
  0x00,0xff,0xff,0x00,0xfe,0xfe,0xfe,0xfe,
  0xfd,0xfd,0xfd,0xfd,0x12,0x34,0x56,0x78,
]);

const RAKLIB_PROTOCOL = 6;

function encodeAddress(ip, port) {
  const parts = ip.split('.').map(Number);
  const buf   = Buffer.alloc(7);
  buf.writeUInt8(4, 0);
  buf.writeUInt8((~parts[0]) & 0xff, 1);
  buf.writeUInt8((~parts[1]) & 0xff, 2);
  buf.writeUInt8((~parts[2]) & 0xff, 3);
  buf.writeUInt8((~parts[3]) & 0xff, 4);
  buf.writeUInt16BE(port, 5);
  return buf;
}

function randomGuid() {
  const bytes = crypto.randomBytes(8);
  return bytes.readBigUInt64BE(0);
}

function humanDelay(base, variance) {
  return base + Math.floor(Math.random() * variance);
}

class RakNet extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.host = opts.host    || '127.0.0.1';
    this.port = opts.port    || 19132;
    this.mtu  = opts.mtuSize || 1400;
    this.guid = randomGuid();

    this.socket        = null;
    this.state         = 'DISCONNECTED';
    this._resolvedHost = null;

    this.sendSeq       = 0;
    this.msgIdx        = 0;
    this.chanIdx       = new Array(32).fill(0);
    this._splitId      = 0;
    this.recoveryQueue = {};

    this.lastSeqNum     = -1;
    this.windowStart    = -1;
    this.windowEnd      = 2048;
    this.receivedWindow = {};

    this.lastReliableIdx  = -1;
    this.reliableWinStart = 0;
    this.reliableWinEnd   = 2048;
    this.reliableWindow   = {};

    this.splitPackets = {};
    this._keepAlive   = null;
    this._retryTimer  = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      dns.lookup(this.host).then(({ address }) => {
        this._resolvedHost = address;
        this._openSocket(resolve, reject);
      }).catch(reject);
    });
  }

  _openSocket(resolve, reject) {
    this.socket = dgram.createSocket('udp4');
    this.socket.on('error', err => { this.emit('error', err); reject(err); });
    this.socket.on('message', buf => this._onMessage(buf));

    const MTU_SIZES = [1400, 1200, 1000, 576];
    let mtuIndex    = 0;
    let ocr1Count   = 0;

    this.socket.bind(0, () => {
      this.state = 'PING';

      this._sendPing();

      const initialDelay = humanDelay(200, 150);
      this._retryTimer = setTimeout(() => {
        if (this.state === 'PING') {
          this.state = 'HANDSHAKE1';
          this._sendOCR1();
        }
        this._scheduleRetry(MTU_SIZES, mtuIndex, ocr1Count);
      }, initialDelay);

      const timeout = setTimeout(() => {
        if (this.state !== 'CONNECTED') {
          clearTimeout(this._retryTimer);
          this.close();
          reject(new Error('RakNet connection timed out'));
        }
      }, 20000);

      this.once('connect', () => {
        clearTimeout(timeout);
        clearTimeout(this._retryTimer);
        resolve();
      });
    });
  }

  _scheduleRetry(MTU_SIZES, mtuIndex, ocr1Count) {
    let delay;
    if (this.state === 'HANDSHAKE1' || this.state === 'PING') {
      delay = humanDelay(1400, 600);
    } else if (this.state === 'HANDSHAKE2') {
      delay = humanDelay(1100, 400);
    } else {
      delay = humanDelay(1200, 500);
    }

    this._retryTimer = setTimeout(() => {
      if (this.state === 'DISCONNECTED' || this.state === 'CONNECTED') return;

      if (this.state === 'PING' || this.state === 'HANDSHAKE1') {
        ocr1Count++;
        if (ocr1Count % 2 === 0) {
          mtuIndex = Math.min(mtuIndex + 1, MTU_SIZES.length - 1);
          this.mtu = MTU_SIZES[mtuIndex];
        }
        if (this.state === 'PING') {
          this._sendPing();
          setTimeout(() => this._sendOCR1(), humanDelay(100, 80));
        } else {
          this._sendOCR1();
        }
      } else if (this.state === 'HANDSHAKE2') {
        this._sendOCR2();
      }

      this._scheduleRetry(MTU_SIZES, mtuIndex, ocr1Count);
    }, delay);
  }

  sendEncapsulated(payload) {
    if (this.state !== 'CONNECTED') return;
    if (payload.length > this.mtu - 34)
      this._sendFragmented(payload);
    else
      this._sendReliableOrdered(payload);
  }

  close() {
    clearTimeout(this._keepAlive);
    clearTimeout(this._retryTimer);
    if (this.socket) { try { this.socket.close(); } catch (_) {} this.socket = null; }
    for (const entry of Object.values(this.splitPackets)) {
      if (entry._timer) clearTimeout(entry._timer);
    }
    this.splitPackets  = {};
    this.recoveryQueue = {};
    this.state         = 'DISCONNECTED';
  }

  _sendPing() {
    const buf = Buffer.alloc(33);
    buf.writeUInt8(0x01, 0);
    buf.writeBigUInt64BE(BigInt(Date.now()), 1);
    MAGIC.copy(buf, 9);
    buf.writeBigUInt64BE(this.guid, 25);
    this._rawSend(buf);
  }

  _sendOCR1() {
    const buf = Buffer.alloc(this.mtu);
    buf.fill(0);
    buf.writeUInt8(0x05, 0);
    MAGIC.copy(buf, 1);
    buf.writeUInt8(RAKLIB_PROTOCOL, 17);
    this._rawSend(buf);
  }

  _sendOCR2() {
    const buf = Buffer.alloc(34);
    let o = 0;
    buf.writeUInt8(0x07, o++);
    MAGIC.copy(buf, o); o += 16;
    encodeAddress(this._resolvedHost, this.port).copy(buf, o); o += 7;
    buf.writeUInt16BE(this.mtu, o); o += 2;
    buf.writeBigUInt64BE(this.guid, o);
    this._rawSend(buf);
  }

  _sendClientConnect() {
    const buf = Buffer.alloc(18);
    let o = 0;
    buf.writeUInt8(0x09, o++);
    buf.writeBigUInt64BE(this.guid, o); o += 8;
    buf.writeBigInt64BE(BigInt(Date.now()), o); o += 8;
    buf.writeUInt8(0, o);
    this._sendReliableOrdered(buf);
  }

  _sendClientHandshake(sendPing) {
    const nullAddr = encodeAddress('0.0.0.0', 0);
    const srvAddr  = encodeAddress(this._resolvedHost, this.port);
    const buf      = Buffer.alloc(96);
    let o = 0;
    buf.writeUInt8(0x13, o++);
    srvAddr.copy(buf, o); o += 7;
    buf.writeUInt16BE(0, o); o += 2;
    for (let i = 0; i < 10; i++) { nullAddr.copy(buf, o); o += 7; }
    buf.writeBigInt64BE(sendPing, o); o += 8;
    buf.writeBigInt64BE(sendPing + 1000n, o);
    this._sendReliableOrdered(buf);
  }

  _onMessage(buf) {
    if (!buf.length) return;
    const id = buf.readUInt8(0);

    if      (id === 0x1c)               this._onUnconnectedPong(buf);
    else if (id === 0x06)               this._onOCReply1(buf);
    else if (id === 0x08)               this._onOCReply2(buf);
    else if (id === 0xc0)               this._onAck(buf);
    else if (id === 0xa0)               this._onNack(buf);
    else if (id >= 0x80 && id <= 0x8f) this._onDataPacket(buf);
    else if (id === 0x19) this.emit('error', new Error('incompatible protocol version'));
    else if (id === 0x17) this.emit('error', new Error('already connected'));
    else if (id === 0x14) this.emit('error', new Error('server full'));
    else if (id === 0x1a) this.emit('error', new Error('ip banned'));
  }

  _onUnconnectedPong(buf) {
    if (this.state === 'PING') {
      clearTimeout(this._retryTimer);
      this.state = 'HANDSHAKE1';
      setTimeout(() => {
        this._sendOCR1();
        this._scheduleRetry([1400, 1200, 1000, 576], 0, 0);
      }, humanDelay(50, 40));
    }
  }

  _onOCReply1(buf) {
    if (this.state !== 'HANDSHAKE1') return;
    if (buf.length >= 28) {
      const serverMtu = buf.readUInt16BE(26);
      this.mtu = Math.min(this.mtu, serverMtu);
    }
    this.state = 'HANDSHAKE2';
    this._sendOCR2();
  }

  _onOCReply2(buf) {
    if (this.state !== 'HANDSHAKE2') return;
    this.state = 'CONNECTING';
    this._sendClientConnect();
  }

  _onAck(buf) {
    if (buf.length < 4) return;
    try {
      const count = buf.readUInt16BE(1);
      let o = 3;
      for (let i = 0; i < count && o < buf.length; i++) {
        const single = buf.readUInt8(o++);
        if (single) {
          delete this.recoveryQueue[buf.readUIntLE(o, 3)]; o += 3;
        } else {
          const start = buf.readUIntLE(o, 3); o += 3;
          const end   = buf.readUIntLE(o, 3); o += 3;
          for (let s = start; s <= end; s++) delete this.recoveryQueue[s];
        }
      }
    } catch (_) {}
  }

  _onNack(buf) {
    if (buf.length < 4) return;
    try {
      const count = buf.readUInt16BE(1);
      let o = 3;
      for (let i = 0; i < count && o < buf.length; i++) {
        const single = buf.readUInt8(o++);
        if (single) {
          const seq = buf.readUIntLE(o, 3); o += 3;
          if (this.recoveryQueue[seq]) this._rawSend(this.recoveryQueue[seq]);
        } else {
          const start = buf.readUIntLE(o, 3); o += 3;
          const end   = buf.readUIntLE(o, 3); o += 3;
          for (let s = start; s <= end; s++) {
            if (this.recoveryQueue[s]) this._rawSend(this.recoveryQueue[s]);
          }
        }
      }
    } catch (_) {}
  }

  _onDataPacket(buf) {
    if (buf.length < 4) return;
    const seqNum = buf.readUIntLE(1, 3);

    if (seqNum < this.windowStart || seqNum > this.windowEnd) return;
    if (this.receivedWindow[seqNum]) return;

    this._sendAck(seqNum);
    this.receivedWindow[seqNum] = true;

    if (seqNum > this.lastSeqNum + 1) {
      for (let m = this.lastSeqNum + 1; m < seqNum; m++) {
        if (!this.receivedWindow[m]) this._sendNack(m);
      }
    }

    if (seqNum > this.lastSeqNum) this.lastSeqNum = seqNum;

    while (this.receivedWindow[this.windowStart + 1]) {
      delete this.receivedWindow[this.windowStart];
      this.windowStart++;
      this.windowEnd++;
    }
    if (this.lastSeqNum > this.windowStart) {
      for (let s = this.windowStart; s < this.lastSeqNum; s++) delete this.receivedWindow[s];
      this.windowStart = this.lastSeqNum;
      this.windowEnd   = this.lastSeqNum + 2048;
    }

    let offset = 4;
    while (offset < buf.length) {
      const r = this._parseEncapsulated(buf, offset);
      if (!r) break;
      offset = r.next;
      if (r.pkt) this._handleEncapsulated(r.pkt);
    }
  }

  _parseEncapsulated(buf, offset) {
    if (offset + 3 > buf.length) return null;

    const flags       = buf.readUInt8(offset++);
    const reliability = (flags & 0xe0) >> 5;
    const hasSplit    = !!(flags & 0x10);
    const lengthBits  = buf.readUInt16BE(offset); offset += 2;
    const length      = Math.ceil(lengthBits / 8);

    let msgIdx = null;
    if ([2,3,4,6,7].includes(reliability)) {
      msgIdx = buf.readUIntLE(offset, 3); offset += 3;
    }

    let orderIdx = null, orderChan = 0;
    if (reliability === 3 || reliability === 7) {
      orderIdx  = buf.readUIntLE(offset, 3); offset += 3;
      orderChan = buf.readUInt8(offset++);
    }

    let splitCount = 0, splitId = 0, splitIdx = 0;
    if (hasSplit) {
      splitCount = buf.readInt32BE(offset);  offset += 4;
      splitId    = buf.readUInt16BE(offset); offset += 2;
      splitIdx   = buf.readInt32BE(offset);  offset += 4;
    }

    if (offset + length > buf.length) return null;
    const payload = buf.slice(offset, offset + length);

    return {
      next: offset + length,
      pkt:  { reliability, msgIdx, orderIdx, orderChan, hasSplit, splitCount, splitId, splitIdx, payload }
    };
  }

  _handleEncapsulated(pkt) {
    if (pkt.hasSplit) {
      if (this.state === 'CONNECTED') this._handleSplit(pkt);
      return;
    }

    if (pkt.msgIdx !== null) {
      if (pkt.msgIdx < this.reliableWinStart || pkt.msgIdx > this.reliableWinEnd) return;

      if (pkt.msgIdx - this.lastReliableIdx === 1) {
        this.lastReliableIdx++;
        this.reliableWinStart++;
        this.reliableWinEnd++;
        this._routePayload(pkt.payload);

        const sorted = Object.keys(this.reliableWindow).map(Number).sort((a, b) => a - b);
        for (const idx of sorted) {
          if (idx - this.lastReliableIdx !== 1) break;
          this.lastReliableIdx++;
          this.reliableWinStart++;
          this.reliableWinEnd++;
          this._routePayload(this.reliableWindow[idx].payload);
          delete this.reliableWindow[idx];
        }
        for (const idx of Object.keys(this.reliableWindow).map(Number)) {
          if (idx < this.reliableWinStart) delete this.reliableWindow[idx];
        }
      } else {
        this.reliableWindow[pkt.msgIdx] = pkt;
      }
    } else {
      this._routePayload(pkt.payload);
    }
  }

  _handleSplit(pkt) {
    const { splitId, splitIdx, splitCount, payload } = pkt;
    if (splitCount > 128 || splitIdx >= 128 || splitIdx < 0) return;

    if (!this.splitPackets[splitId]) {
      if (Object.keys(this.splitPackets).length >= 4) return;
      this.splitPackets[splitId] = { parts: {}, count: splitCount };
      this.splitPackets[splitId]._timer = setTimeout(() => {
        delete this.splitPackets[splitId];
      }, 10_000);
    }

    this.splitPackets[splitId].parts[splitIdx] = payload;

    if (Object.keys(this.splitPackets[splitId].parts).length === splitCount) {
      clearTimeout(this.splitPackets[splitId]._timer);
      const parts = [];
      for (let i = 0; i < splitCount; i++) parts.push(this.splitPackets[splitId].parts[i]);
      delete this.splitPackets[splitId];
      this._routePayload(Buffer.concat(parts));
    }
  }

  _routePayload(payload) {
    if (!payload || !payload.length) return;
    const id = payload.readUInt8(0);

    if (id === 0x10) {
      try {
        const sendPing = payload.readBigInt64BE(1 + 7 + 2 + 70);
        this._sendClientHandshake(sendPing);
      } catch (_) {
        this._sendClientHandshake(BigInt(Date.now()));
      }
      this.state = 'CONNECTED';
      this._startKeepAlive();
      this.emit('connect');
    } else if (id === 0x00) {
      if (payload.length >= 9) {
        const pong = Buffer.alloc(9);
        pong.writeUInt8(0x03, 0);
        payload.copy(pong, 1, 1, 9);
        this._sendUnreliable(pong);
      }
    } else if (id === 0x15) {
      this.state = 'DISCONNECTED';
      this.emit('disconnect', 'server disconnected');
    } else if (id !== 0x03 && id !== 0x13) {
      if (this.state === 'CONNECTED') this.emit('encapsulated', payload);
    }
  }

  _sendAck(seqNum) {
    const buf = Buffer.alloc(7);
    buf.writeUInt8(0xc0, 0);
    buf.writeUInt16BE(1, 1);
    buf.writeUInt8(1, 3);
    buf.writeUIntLE(seqNum, 4, 3);
    this._rawSend(buf);
  }

  _sendNack(seqNum) {
    const buf = Buffer.alloc(7);
    buf.writeUInt8(0xa0, 0);
    buf.writeUInt16BE(1, 1);
    buf.writeUInt8(1, 3);
    buf.writeUIntLE(seqNum, 4, 3);
    this._rawSend(buf);
  }

  _sendReliableOrdered(payload) {
    const buf = Buffer.alloc(4 + 1 + 2 + 3 + 3 + 1 + payload.length);
    let o = 0;
    buf.writeUInt8(0x84, o++);
    buf.writeUIntLE(this.sendSeq, o, 3); o += 3;
    buf.writeUInt8(0x60, o++);
    buf.writeUInt16BE(payload.length * 8, o); o += 2;
    buf.writeUIntLE(this.msgIdx, o, 3); o += 3;
    buf.writeUIntLE(this.chanIdx[0], o, 3); o += 3;
    buf.writeUInt8(0, o++);
    payload.copy(buf, o);

    this.recoveryQueue[this.sendSeq] = buf;
    const oldest = this.sendSeq - 2048;
    if (oldest >= 0) delete this.recoveryQueue[oldest];
    this.sendSeq++;
    this.msgIdx++;
    this.chanIdx[0]++;
    this._rawSend(buf);
  }

  _sendUnreliable(payload) {
    const buf = Buffer.alloc(4 + 1 + 2 + payload.length);
    let o = 0;
    buf.writeUInt8(0x80, o++);
    buf.writeUIntLE(this.sendSeq, o, 3); o += 3;
    buf.writeUInt8(0x00, o++);
    buf.writeUInt16BE(payload.length * 8, o); o += 2;
    payload.copy(buf, o);
    this.sendSeq++;
    this._rawSend(buf);
  }

  _sendFragmented(payload) {
    const maxChunk = this.mtu - 34;
    const total    = Math.ceil(payload.length / maxChunk);
    const splitId  = ++this._splitId & 0xffff;
    const orderIdx = this.chanIdx[0]++;

    for (let i = 0; i < total; i++) {
      const chunk = payload.slice(i * maxChunk, (i + 1) * maxChunk);
      const buf   = Buffer.alloc(4 + 1 + 2 + 3 + 3 + 1 + 10 + chunk.length);
      let o = 0;
      buf.writeUInt8(0x84, o++);
      buf.writeUIntLE(this.sendSeq, o, 3); o += 3;
      buf.writeUInt8(0x70, o++);
      buf.writeUInt16BE(chunk.length * 8, o); o += 2;
      buf.writeUIntLE(this.msgIdx++, o, 3); o += 3;
      buf.writeUIntLE(orderIdx, o, 3); o += 3;
      buf.writeUInt8(0, o++);
      buf.writeInt32BE(total, o); o += 4;
      buf.writeUInt16BE(splitId, o); o += 2;
      buf.writeInt32BE(i, o); o += 4;
      chunk.copy(buf, o);

      this.recoveryQueue[this.sendSeq] = buf;
      const oldest = this.sendSeq - 2048;
      if (oldest >= 0) delete this.recoveryQueue[oldest];
      this.sendSeq++;
      this._rawSend(buf);
    }
  }

  _startKeepAlive() {
    const scheduleNext = () => {
      this._keepAlive = setTimeout(() => {
        if (this.state !== 'CONNECTED') return;
        const ping = Buffer.alloc(9);
        ping.writeUInt8(0x00, 0);
        ping.writeBigInt64BE(BigInt(Date.now()), 1);
        this._sendUnreliable(ping);
        scheduleNext();
      }, humanDelay(4800, 1200));
    };
    scheduleNext();
  }

  _rawSend(buf) {
    if (!this.socket) return;
    const dest = this._resolvedHost || this.host;
    this.socket.send(buf, 0, buf.length, this.port, dest, err => {
      if (err) this.emit('error', err);
    });
  }
}

module.exports = RakNet;
