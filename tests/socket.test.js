import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { io as SocketClient } from 'socket.io-client';

let serverUrl;
let serverInstance;
let ioInstance;

function connect(opts = {}) {
  return new Promise((resolve) => {
    const socket = SocketClient(serverUrl, { forceNew: true, ...opts });
    socket.on('connect', () => resolve(socket));
  });
}

function nextEvent(socket, event) {
  return new Promise((resolve) => socket.once(event, resolve));
}

beforeAll(async () => {
  const { server, io } = await import('../server.js');
  serverInstance = server;
  ioInstance = io;
  await new Promise((resolve) => server.listen(0, resolve));
  serverUrl = `http://localhost:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => ioInstance.close(() => serverInstance.close(resolve)));
});

// ─── Room join flow ───────────────────────────────────────────────────────────

describe('room join flow', () => {
  let codeA;

  beforeAll(async () => {
    const res = await fetch(`${serverUrl}/api/rooms`, { method: 'POST' });
    ({ code: codeA } = await res.json());
  });

  it('both clients receive room:peer_joined when a second user joins', async () => {
    const [sockA, sockB] = await Promise.all([connect(), connect()]);

    const peerJoinedA = nextEvent(sockA, 'room:peer_joined');
    sockA.emit('room:join', { code: codeA, name: 'alice' });
    await nextEvent(sockA, 'room:you');

    const peerJoinedB = nextEvent(sockB, 'room:peer_joined');
    sockB.emit('room:join', { code: codeA, name: 'bob' });

    const [evA, evB] = await Promise.all([peerJoinedA, peerJoinedB]);
    expect(evA.peerName).toBe('bob');
    expect(evB.peerName).toBe('alice');
    expect(typeof evA.expiresAt).toBe('number');

    sockA.disconnect();
    sockB.disconnect();
  });

  it('emits an error when a third user tries to join a full room', async () => {
    const res = await fetch(`${serverUrl}/api/rooms`, { method: 'POST' });
    const { code } = await res.json();

    const [s1, s2, s3] = await Promise.all([connect(), connect(), connect()]);
    s1.emit('room:join', { code, name: 'a' });
    await nextEvent(s1, 'room:you');
    s2.emit('room:join', { code, name: 'b' });
    await nextEvent(s2, 'room:you');

    const err = nextEvent(s3, 'error');
    s3.emit('room:join', { code, name: 'c' });
    const { message } = await err;
    expect(message).toMatch(/full/i);

    s1.disconnect();
    s2.disconnect();
    s3.disconnect();
  });
});

// ─── Key exchange relay ───────────────────────────────────────────────────────

describe('key:exchange relay', () => {
  it('forwards the public key from one peer to the other', async () => {
    const res = await fetch(`${serverUrl}/api/rooms`, { method: 'POST' });
    const { code } = await res.json();

    const [sockA, sockB] = await Promise.all([connect(), connect()]);

    sockA.emit('room:join', { code, name: 'alice' });
    await nextEvent(sockA, 'room:you');
    sockB.emit('room:join', { code, name: 'bob' });
    await Promise.all([nextEvent(sockA, 'room:peer_joined'), nextEvent(sockB, 'room:peer_joined')]);

    const received = nextEvent(sockB, 'key:receive');
    sockA.emit('key:exchange', { publicKey: 'FAKE_PUBLIC_KEY_DATA' });
    const { publicKey } = await received;
    expect(publicKey).toBe('FAKE_PUBLIC_KEY_DATA');

    sockA.disconnect();
    sockB.disconnect();
  });
});

// ─── Message rate limiting ────────────────────────────────────────────────────

describe('message:send rate limiting', () => {
  it('blocks messages beyond 30 per minute from a single socket', async () => {
    const res = await fetch(`${serverUrl}/api/rooms`, { method: 'POST' });
    const { code } = await res.json();

    const [sockA, sockB] = await Promise.all([connect(), connect()]);
    sockA.emit('room:join', { code, name: 'spammer' });
    await nextEvent(sockA, 'room:you');
    sockB.emit('room:join', { code, name: 'victim' });
    await Promise.all([nextEvent(sockA, 'room:peer_joined'), nextEvent(sockB, 'room:peer_joined')]);

    // Send 30 messages (within limit)
    for (let i = 0; i < 30; i++) {
      sockA.emit('message:send', { iv: 'iv'.padEnd(12, '0'), ciphertext: 'x' });
    }

    const rateLimitErr = nextEvent(sockA, 'error');
    sockA.emit('message:send', { iv: 'iv'.padEnd(12, '0'), ciphertext: 'x' });
    const { message } = await rateLimitErr;
    expect(message).toMatch(/rate limit|slow down/i);

    sockA.disconnect();
    sockB.disconnect();
  });
});

// ─── Disconnect cleanup ───────────────────────────────────────────────────────

describe('disconnect cleanup', () => {
  it('notifies the remaining peer when one user disconnects', async () => {
    const res = await fetch(`${serverUrl}/api/rooms`, { method: 'POST' });
    const { code } = await res.json();

    const [sockA, sockB] = await Promise.all([connect(), connect()]);
    sockA.emit('room:join', { code, name: 'alice' });
    await nextEvent(sockA, 'room:you');
    sockB.emit('room:join', { code, name: 'bob' });
    await Promise.all([nextEvent(sockA, 'room:peer_joined'), nextEvent(sockB, 'room:peer_joined')]);

    const peerLeft = nextEvent(sockB, 'room:peer_left');
    sockA.disconnect();
    const { peerName } = await peerLeft;
    expect(peerName).toBe('alice');

    sockB.disconnect();
  });

  it('deletes the room when the last user disconnects', async () => {
    const res = await fetch(`${serverUrl}/api/rooms`, { method: 'POST' });
    const { code } = await res.json();

    const sock = await connect();
    sock.emit('room:join', { code, name: 'solo' });
    await nextEvent(sock, 'room:you');
    sock.disconnect();

    // Give the server time to process the disconnect
    await new Promise(r => setTimeout(r, 50));

    const lookup = await fetch(`${serverUrl}/api/rooms/${code}`);
    expect(lookup.status).toBe(404);
  });
});
