'use strict';
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const rateLimit = require('express-rate-limit');
const path = require('path');
const crypto = require('crypto');
const { genCode, sanitizeName, checkRate, ROOM_TTL, MAX_USERS, MAX_CIPHER_LEN } = require('./lib/rooms');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const rooms = new Map(); // code -> { users: Set<socketId>, timer, createdAt, startedAt }

const createRoomLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many rooms from this IP. Try again in an hour.' }
});

const lookupRoomLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many lookups. Slow down.' }
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', rooms: rooms.size, uptime: process.uptime() });
});

app.get('/r/:code', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'room.html'));
});

app.get('/privacy', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'privacy.html'));
});

app.get('/terms', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'terms.html'));
});

function deleteRoom(code, reason = 'empty') {
  const room = rooms.get(code);
  if (!room) return;
  clearTimeout(room.timer);
  io.to(code).emit('room:deleted', { reason });
  rooms.delete(code);
  console.log(`[room] deleted ${code} (${reason})`);
}

app.post('/api/rooms', createRoomLimiter, (_req, res) => {
  let code;
  do { code = genCode(); } while (rooms.has(code));

  const timer = setTimeout(() => deleteRoom(code, 'expired'), ROOM_TTL);
  rooms.set(code, { users: new Set(), timer, createdAt: Date.now(), startedAt: null });
  console.log(`[room] created ${code}`);
  res.json({ code });
});

app.get('/api/rooms/:code', lookupRoomLimiter, (req, res) => {
  const room = rooms.get(req.params.code.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Room not found or expired' });
  const expiresAt = room.startedAt ? room.startedAt + ROOM_TTL : null;
  res.json({ users: room.users.size, expiresAt });
});

const msgRates    = new Map(); // socketId -> { count, resetAt }
const socketNames = new Map(); // socketId -> name

io.on('connection', (socket) => {
  let roomCode = null;

  socket.on('room:join', ({ code, name }) => {
    if (roomCode) return;
    const key = String(code || '').toUpperCase().slice(0, 16);
    const room = rooms.get(key);

    if (!room) {
      socket.emit('error', { message: 'Room not found or has expired.' });
      return;
    }
    if (room.users.size >= MAX_USERS) {
      socket.emit('error', { message: 'Room is full. Max 2 people.' });
      return;
    }

    const myName = sanitizeName(name);
    socketNames.set(socket.id, myName);
    socket.emit('room:you', { name: myName });

    roomCode = key;
    room.users.add(socket.id);
    socket.join(key);

    io.to(key).emit('room:update', { users: room.users.size });

    if (room.users.size === MAX_USERS) {
      const [peerId] = [...room.users].filter(id => id !== socket.id);
      const peerName = socketNames.get(peerId) || 'voidmous';

      // Start the 24h clock when both users are present — reconnects don't reset it
      if (!room.startedAt) {
        room.startedAt = Date.now();
        clearTimeout(room.timer);
        room.timer = setTimeout(() => deleteRoom(key, 'expired'), ROOM_TTL);
      }

      const expiresAt = room.startedAt + ROOM_TTL;
      socket.emit('room:peer_joined', { peerName, expiresAt });
      socket.to(key).emit('room:peer_joined', { peerName: myName, expiresAt });
    }
  });

  socket.on('message:send', ({ iv, ciphertext }) => {
    if (!roomCode) return;

    if (!checkRate(socket.id, msgRates)) {
      socket.emit('error', { message: 'Slow down. Rate limit exceeded.' });
      return;
    }

    if (typeof iv !== 'string' || iv.length > 24) return;
    if (typeof ciphertext !== 'string' || ciphertext.length > MAX_CIPHER_LEN) return;

    io.to(roomCode).emit('message:receive', {
      id: crypto.randomBytes(4).toString('hex'),
      iv,
      ciphertext,
      socketId: socket.id,
      ts: Date.now()
    });
  });

  socket.on('key:exchange', ({ publicKey }) => {
    if (!roomCode) return;
    if (typeof publicKey !== 'string' || publicKey.length > 1000) return;
    socket.to(roomCode).emit('key:receive', { publicKey });
  });

  socket.on('key:ready', () => {
    if (!roomCode) return;
    socket.to(roomCode).emit('key:peer_ready');
  });

  socket.on('typing:start', () => {
    if (!roomCode) return;
    socket.to(roomCode).emit('typing:start');
  });

  socket.on('typing:stop', () => {
    if (!roomCode) return;
    socket.to(roomCode).emit('typing:stop');
  });


  socket.on('disconnect', () => {
    if (!roomCode) return;
    const room = rooms.get(roomCode);
    if (!room) return;

    const myName = socketNames.get(socket.id) || 'voidmous';
    room.users.delete(socket.id);
    msgRates.delete(socket.id);
    socketNames.delete(socket.id);

    if (room.users.size === 0) {
      deleteRoom(roomCode, 'empty');
    } else {
      io.to(roomCode).emit('room:update', { users: room.users.size });
      io.to(roomCode).emit('room:peer_left', { peerName: myName });
    }
  });
});

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => console.log(`void · http://localhost:${PORT}`));
}

module.exports = { app, server, io, rooms };
