'use strict';
const crypto = require('crypto');

const MSG_PER_MIN = 30;
const ROOM_TTL = 24 * 60 * 60 * 1000;
const MAX_USERS = 2;
const MAX_CIPHER_LEN = 9000;

function genCode() {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

function sanitizeName(raw) {
  const s = String(raw || '').trim().slice(0, 20);
  return s || 'voidmous';
}

// msgRates: Map<socketId, { count: number, resetAt: number }>
function checkRate(socketId, msgRates, limit = MSG_PER_MIN) {
  const now = Date.now();
  let r = msgRates.get(socketId);
  if (!r || now > r.resetAt) {
    r = { count: 0, resetAt: now + 60000 };
    msgRates.set(socketId, r);
  }
  r.count++;
  return r.count <= limit;
}

module.exports = { genCode, sanitizeName, checkRate, MSG_PER_MIN, ROOM_TTL, MAX_USERS, MAX_CIPHER_LEN };
