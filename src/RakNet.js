'use strict';

// RakNet client built against pmmp/RakLib source (pocketmine_src/raklib/).
// Packet structures verified against:
//   - raklib/protocol/*.php
//   - raklib/server/Session.php
//   - raklib/protocol/EncapsulatedPacket.php

const dgram        = require('dgram');
const dns          = require('dns').promises;
const EventEmitter = require('events');

// MAGIC from RakLib.php
const MAGIC = Buffer.from([
  0x00,0xff,0xff,0x00,0xfe,0xfe,0xfe,0xfe,
  0xfd,0xfd,0xfd,0xfd,0x12,0x34,0x56,0x78,
]);

const RAKLIB_PROTOCOL = 6; // RakLib::PROTOCOL

// Packet.php: putAddress() = putByte(4) + ~b0 + ~b1 + ~b2 + ~b3 + putShort(port BE)
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
  return (
    BigInt(Math.floor(Math.random() * 0xFFFFFFFF)) * BigInt(0x100000000) +
    BigInt(Math.floor(Math.random() * 0xFFFFFFFF))
  );
}

class RakNet extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.host = opts.host    || '127.0.0.1';
    this.port = opts.port    || 19132;
    this.mtu  = opts.mtuSize || 1400;
    this.guid = randomGuid();

    this.socket = null;
    this.state  = 'DISCONNECTED';

    // Send state
    this.sendSeq      = 0;
    this.msgIdx       = 0;
    this.chanIdx      = new Array(32).fill(0);
    this._splitId     = 0;
    this.recoveryQueue = {};

    // Receive state — mirrors Session.php window tracking
    this.lastSeqNum      = -1;
    this.windowStart     = -1;
    this.windowEnd       = 2048;
    this.receivedWindow  = {};

    this.lastReliableIdx  = -1;
    this.reliableWinStart = 0;
    this.reliableWinEnd   = 2048;
    this.reliableWindow   = {};

    this.splitPackets = {};
    this._keepAlive   = null;
    this._retryTimer  = null;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  connect() {
    return new Promise((resolve, reject) => {
      // Resolve hostname to IP first — encodeAddress only handles dotted-decimal IPv4.
      // dns.lookup returns the first A record and handles numeric IPs as a no-op.
      dns.lookup(this.host).then(({ address }) => {
        this._resolvedHost = address;
        this._openSocket(resolve, reject);
      }).catch(reject);
    });
  }

  _openSocket(resolve, reject) {
    this.socket = dgram.createSocket('udp4');
    this.socket.on('error', (err) => { this.emit('error', err); reject(err); });
    this.socket.on('message', (buf) => this._onMessage(buf));

    // MTU sizes to try in order — some firewalls silently drop large UDP packets.
    // OCR1 is padded to exactly mtu bytes so the server can detect max packet size.
    // If a server doesn't reply to 1400, try progressively smaller sizes.
    const MTU_SIZES = [1400, 1200, 1000, 576];
    let mtuIndex = 0;

    this.socket.bind(0, () => {
      this.state = 'HANDSHAKE1';
      this._sendOCR1();

      this._retryTimer = setInterval(() => {
        if (this.state === 'HANDSHAKE1') {
          // Cycle through MTU sizes every 2 retries (1s each = 2s per MTU)
          mtuIndex = Math.min(mtuIndex + 1, MTU_SIZES.length - 1);
          this.mtu = MTU_SIZES[mtuIndex];
          this._sendOCR1();
        } else if (this.state === 'HANDSHAKE2') {
          this._sendOCR2();
        }
      }, 1000);

      const timeout = setTimeout(() => {
        if (this.state !== 'CONNECTED') {
          clearInterval(this._retryTimer);
          reject(new Error('RakNet connection timed out'));
        }
      }, 15000);

      this.once('connect', () => {
        clearTimeout(timeout);
        clearInterval(this._retryTimer);
        resolve();
      });
    });
  }

  sendEncapsulated(payload) {
    if (this.state !== 'CONNECTED') return;
    if (payload.length > this.mtu - 34)
      this._sendFragmented(payload);
    else
      this._sendReliableOrdered(payload);
  }

  close() {
    clearInterval(this._keepAlive);
    clearInterval(this._retryTimer);
    if (this.socket) { try { this.socket.close(); } catch (_) {} this.socket = null; }
    // Clear split packet expiry timers
    for (const entry of Object.values(this.splitPackets)) {
      if (entry._timer) clearTimeout(entry._timer);
    }
    this.splitPackets  = {};
    this.recoveryQueue = {};   // release buffer references
    this.state = 'DISCONNECTED';
  }

  // ── Handshake ────────────────────────────────────────────────────────────────

  _sendPing() {
    // UNCONNECTED_PING (0x01): id(1) + time(8) + magic(16) + guid(8)
    const buf = Buffer.alloc(33);
    buf.writeUInt8(0x01, 0);
    buf.writeBigUInt64BE(BigInt(Date.now()), 1);
    MAGIC.copy(buf, 9);
    buf.writeBigUInt64BE(this.guid, 25);
    this._rawSend(buf);
  }

  _sendOCR1() {
    // OPEN_CONNECTION_REQUEST_1 (0x05): id(1) + magic(16) + protocol(1) + zeros(mtu-18)
    const buf = Buffer.alloc(this.mtu);
    buf.writeUInt8(0x05, 0);
    MAGIC.copy(buf, 1);
    buf.writeUInt8(RAKLIB_PROTOCOL, 17);
    this._rawSend(buf);
  }

  _sendOCR2() {
    // OPEN_CONNECTION_REQUEST_2 (0x07): id(1) + magic(16) + address(7) + mtu(2) + guid(8)
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
    // CLIENT_CONNECT (0x09): id(1) + clientId(8) + sendPing(8) + security(1)
    const buf = Buffer.alloc(18);
    let o = 0;
    buf.writeUInt8(0x09, o++);
    buf.writeBigUInt64BE(this.guid, o); o += 8;
    buf.writeBigInt64BE(BigInt(Date.now()), o); o += 8;
    buf.writeUInt8(0, o); // useSecurity = false
    this._sendReliableOrdered(buf);
  }

  _sendClientHandshake(sendPing) {
    // CLIENT_HANDSHAKE (0x13): id(1) + serverAddr(7) + short(2) + 10*nullAddr(70) + sendPing(8) + sendPong(8)
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

  // ── Receive ─────────────────────────────────────────────────────────────────

  _onMessage(buf) {
    if (!buf.length) return;
    const id = buf.readUInt8(0);

    if      (id === 0x1c)               this._onUnconnectedPong(buf);
    else if (id === 0x06)               this._onOCReply1(buf);
    else if (id === 0x08)               this._onOCReply2(buf);
    else if (id === 0xc0)               this._onAck(buf);
    else if (id === 0xa0)               this._onNack(buf);
    else if (id >= 0x80 && id <= 0x8f) this._onDataPacket(buf);
    // Rejection codes — emit error so join.js can handle immediately
    else if (id === 0x19) this.emit('error', new Error('incompatible protocol version'));
    else if (id === 0x17) this.emit('error', new Error('already connected'));
    else if (id === 0x14) this.emit('error', new Error('server full'));
    else if (id === 0x1a) this.emit('error', new Error('ip banned'));
  }

  _onUnconnectedPong(buf) {
    // Some servers send pong — use it to advance if we're still in HANDSHAKE1,
    // otherwise ignore (we go straight to OCR1 without waiting for pong).
    if (this.state === 'PINGING' || this.state === 'HANDSHAKE1') {
      this.state = 'HANDSHAKE1';
      this._sendOCR1();
    }
  }

  _onOCReply1(buf) {
    if (this.state !== 'HANDSHAKE1') return;
    // OPEN_CONNECTION_REPLY_1: id(1) + magic(16) + serverId(8) + security(1) + mtuSize(2)
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

    // NACK gaps
    if (seqNum > this.lastSeqNum + 1) {
      for (let m = this.lastSeqNum + 1; m < seqNum; m++) {
        if (!this.receivedWindow[m]) this._sendNack(m);
      }
    }

    if (seqNum > this.lastSeqNum) this.lastSeqNum = seqNum;

    // Slide window and prune old entries from receivedWindow to prevent memory leak
    while (this.receivedWindow[this.windowStart + 1]) {
      delete this.receivedWindow[this.windowStart];
      this.windowStart++;
      this.windowEnd++;
    }
    if (this.lastSeqNum > this.windowStart) {
      // Jump window forward, prune everything below new start
      for (let s = this.windowStart; s < this.lastSeqNum; s++) delete this.receivedWindow[s];
      this.windowStart = this.lastSeqNum;
      this.windowEnd   = this.lastSeqNum + 2048;
    }

    // Parse encapsulated packets from this datagram
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

        // Drain buffered in-order packets and prune as we go
        const sorted = Object.keys(this.reliableWindow).map(Number).sort((a, b) => a - b);
        for (const idx of sorted) {
          if (idx - this.lastReliableIdx !== 1) break;
          this.lastReliableIdx++;
          this.reliableWinStart++;
          this.reliableWinEnd++;
          this._routePayload(this.reliableWindow[idx].payload);
          delete this.reliableWindow[idx];
        }
        // Prune any entries that have fallen behind the window start
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
      // Drop incomplete splits after 10 s to prevent the 4-slot cap from filling permanently
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
      // SERVER_HANDSHAKE — send CLIENT_HANDSHAKE then mark connected
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
      // PING — reply with PONG
      if (payload.length >= 9) {
        const pong = Buffer.alloc(9);
        pong.writeUInt8(0x03, 0);
        payload.copy(pong, 1, 1, 9);
        this._sendReliableOrdered(pong);
      }
    } else if (id === 0x15) {
      // DISCONNECT
      this.state = 'DISCONNECTED';
      this.emit('disconnect', 'server disconnected');
    } else if (id !== 0x03 && id !== 0x13) {
      // MCPE game packet
      if (this.state === 'CONNECTED') this.emit('encapsulated', payload);
    }
  }

  // ── Send helpers ─────────────────────────────────────────────────────────────

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

  // reliability=3 (RELIABLE_ORDERED), channel 0
  _sendReliableOrdered(payload) {
    // Datagram: id(1) + seqNum(3)
    // Encap:    flags(1) + lengthBits(2) + msgIdx(3) + orderIdx(3) + orderChan(1)
    const buf = Buffer.alloc(4 + 1 + 2 + 3 + 3 + 1 + payload.length);
    let o = 0;
    buf.writeUInt8(0x84, o++);
    buf.writeUIntLE(this.sendSeq, o, 3); o += 3;
    buf.writeUInt8(0x60, o++);  // flags: reliability=3, no split
    buf.writeUInt16BE(payload.length * 8, o); o += 2;
    buf.writeUIntLE(this.msgIdx, o, 3); o += 3;
    buf.writeUIntLE(this.chanIdx[0], o, 3); o += 3;
    buf.writeUInt8(0, o++);
    payload.copy(buf, o);

    this.recoveryQueue[this.sendSeq] = buf;
    // Cap recovery queue — entries older than 2048 slots behind current will never be NACKed
    const oldest = this.sendSeq - 2048;
    if (oldest >= 0) delete this.recoveryQueue[oldest];
    this.sendSeq++;
    this.msgIdx++;
    this.chanIdx[0]++;
    this._rawSend(buf);
  }

  _sendFragmented(payload) {
    const maxChunk = this.mtu - 34;
    const total    = Math.ceil(payload.length / maxChunk);
    const splitId  = ++this._splitId & 0xffff;
    const orderIdx = this.chanIdx[0]++;

    for (let i = 0; i < total; i++) {
      const chunk = payload.slice(i * maxChunk, (i + 1) * maxChunk);
      // Datagram(4) + flags(1) + lenBits(2) + msgIdx(3) + orderIdx(3) + orderChan(1) + splitInfo(10)
      const buf = Buffer.alloc(4 + 1 + 2 + 3 + 3 + 1 + 10 + chunk.length);
      let o = 0;
      buf.writeUInt8(0x84, o++);
      buf.writeUIntLE(this.sendSeq, o, 3); o += 3;
      buf.writeUInt8(0x70, o++);  // flags: reliability=3, hasSplit=true
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
    this._keepAlive = setInterval(() => {
      if (this.state !== 'CONNECTED') return;
      const ping = Buffer.alloc(9);
      ping.writeUInt8(0x00, 0);
      ping.writeBigInt64BE(BigInt(Date.now()), 1);
      this._sendReliableOrdered(ping);
    }, 5000);
  }

  _rawSend(buf) {
    if (!this.socket) return;
    this.socket.send(buf, 0, buf.length, this.port, this.host, (err) => {
      if (err) this.emit('error', err);
    });
  }
}

module.exports = RakNet;