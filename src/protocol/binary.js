'use strict';

function readString(buf, offset) {
  const len = buf.readUInt16BE(offset);
  return { value: buf.slice(offset + 2, offset + 2 + len).toString('utf8'), size: 2 + len };
}

function writeString(buf, offset, str) {
  const bytes = Buffer.from(str, 'utf8');
  buf.writeUInt16BE(bytes.length, offset);
  bytes.copy(buf, offset + 2);
  return 2 + bytes.length;
}

function randomUUID() {
  const b = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) b[i] = (Math.random() * 256) | 0;
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  return b;
}

module.exports = { readString, writeString, randomUUID };
