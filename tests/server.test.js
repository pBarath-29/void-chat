import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { genCode, sanitizeName, checkRate, MSG_PER_MIN } from '../lib/rooms.js';

// ─── Pure function unit tests ────────────────────────────────────────────────

describe('genCode', () => {
  it('returns an 8-character uppercase hex string', () => {
    const code = genCode();
    expect(code).toMatch(/^[A-F0-9]{8}$/);
  });

  it('produces no duplicates across 1000 runs', () => {
    const codes = new Set(Array.from({ length: 1000 }, genCode));
    expect(codes.size).toBe(1000);
  });
});

describe('sanitizeName', () => {
  it('falls back to voidmous for empty string', () => {
    expect(sanitizeName('')).toBe('voidmous');
  });

  it('falls back to voidmous for null', () => {
    expect(sanitizeName(null)).toBe('voidmous');
  });

  it('falls back to voidmous for undefined', () => {
    expect(sanitizeName(undefined)).toBe('voidmous');
  });

  it('falls back to voidmous for whitespace-only input', () => {
    expect(sanitizeName('   ')).toBe('voidmous');
  });

  it('trims leading and trailing whitespace', () => {
    expect(sanitizeName('  alice  ')).toBe('alice');
  });

  it('truncates at 20 characters', () => {
    expect(sanitizeName('a'.repeat(30))).toBe('a'.repeat(20));
  });

  it('preserves a valid name unchanged', () => {
    expect(sanitizeName('bob')).toBe('bob');
  });
});

describe('checkRate', () => {
  it('allows up to MSG_PER_MIN messages', () => {
    const map = new Map();
    for (let i = 0; i < MSG_PER_MIN; i++) {
      expect(checkRate('sock1', map)).toBe(true);
    }
  });

  it('blocks the message beyond the limit', () => {
    const map = new Map();
    for (let i = 0; i < MSG_PER_MIN; i++) checkRate('sock1', map);
    expect(checkRate('sock1', map)).toBe(false);
  });

  it('resets after the time window expires', () => {
    const map = new Map();
    for (let i = 0; i < MSG_PER_MIN; i++) checkRate('sock1', map);
    expect(checkRate('sock1', map)).toBe(false);

    // Expire the window by backdating the resetAt timestamp
    map.get('sock1').resetAt = Date.now() - 1;

    expect(checkRate('sock1', map)).toBe(true);
  });

  it('tracks different socket IDs independently', () => {
    const map = new Map();
    for (let i = 0; i < MSG_PER_MIN; i++) checkRate('sockA', map);
    expect(checkRate('sockA', map)).toBe(false);
    expect(checkRate('sockB', map)).toBe(true);
  });

  it('respects a custom limit', () => {
    const map = new Map();
    expect(checkRate('sock1', map, 3)).toBe(true);
    expect(checkRate('sock1', map, 3)).toBe(true);
    expect(checkRate('sock1', map, 3)).toBe(true);
    expect(checkRate('sock1', map, 3)).toBe(false);
  });
});

// ─── HTTP route integration tests ────────────────────────────────────────────

// Node 18: dynamic import of CJS only exposes { default: module.exports }.
// Node 20: named exports are also extracted. This helper handles both.
async function importServer() {
  const mod = await import('../server.js');
  return mod.app ? mod : mod.default;
}

describe('POST /api/rooms', () => {
  let app;

  beforeAll(async () => {
    ({ app } = await importServer());
  });

  it('creates a room and returns an 8-char hex code', async () => {
    const res = await request(app).post('/api/rooms');
    expect(res.status).toBe(200);
    expect(res.body.code).toMatch(/^[A-F0-9]{8}$/);
  });

  it('creates rooms with unique codes', async () => {
    const [r1, r2] = await Promise.all([
      request(app).post('/api/rooms'),
      request(app).post('/api/rooms')
    ]);
    expect(r1.body.code).not.toBe(r2.body.code);
  });
});

describe('GET /api/rooms/:code', () => {
  let app;

  beforeAll(async () => {
    ({ app } = await importServer());
  });

  it('returns 404 for a non-existent room', async () => {
    const res = await request(app).get('/api/rooms/00000000');
    expect(res.status).toBe(404);
    expect(res.body.error).toBeTruthy();
  });

  it('returns room info for an existing room', async () => {
    const create = await request(app).post('/api/rooms');
    const code = create.body.code;
    const res = await request(app).get(`/api/rooms/${code}`);
    expect(res.status).toBe(200);
    expect(res.body.users).toBe(0);
    expect(res.body.expiresAt).toBeNull();
  });

  it('is case-insensitive', async () => {
    const create = await request(app).post('/api/rooms');
    const code = create.body.code.toLowerCase();
    const res = await request(app).get(`/api/rooms/${code}`);
    expect(res.status).toBe(200);
  });
});

describe('GET /health', () => {
  let app;

  beforeAll(async () => {
    ({ app } = await importServer());
  });

  it('returns status ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(typeof res.body.uptime).toBe('number');
    expect(typeof res.body.rooms).toBe('number');
  });
});
