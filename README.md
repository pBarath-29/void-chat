# void

![CI](https://github.com/YOUR_USERNAME/void-chat/actions/workflows/ci.yml/badge.svg)

Ephemeral anonymous chat rooms with end-to-end encryption. No accounts. No logs. Vanishes when you leave.

## Features

- **End-to-end encrypted** — ECDH P-256 key exchange + HKDF + AES-GCM-256. The server never sees plaintext.
- **MITM protection** — fingerprint verification modal blocks man-in-the-middle attacks
- **Temporary rooms** — auto-delete after 24 hours or when everyone leaves
- **No login** — share a link, join instantly
- **Real-time** — typing indicators, live 24h countdown, instant messages
- **Rate limited** — 10 rooms/hour per IP, 30 messages/minute per user

## Setup

```bash
npm install
npm start          # http://localhost:3000
npm run dev        # with auto-restart (nodemon)
npm test           # run all tests
npm run lint       # ESLint
```

## How it works

1. Open the site and optionally enter your name
2. Click **create room** — a unique 8-character code is generated
3. Share the full URL (including the `#secret` fragment) with your peer
4. Both users verify the fingerprint out-of-band
5. Chat securely — room is gone when you both leave (or after 24h)

Nothing is written to disk. All rooms live in memory only.

## Security model

```
Browser A                       Server                     Browser B
   │                               │                           │
   ├─ POST /api/rooms ─────────────►│                           │
   │◄── { code } ──────────────────┤                           │
   │                               │                           │
   ├─ socket: room:join ───────────►│◄── socket: room:join ─────┤
   │◄── room:peer_joined ──────────┤──► room:peer_joined ───────►│
   │                               │                           │
   ├─ key:exchange ────────────────►│──► key:receive ────────────►│
   │◄── key:receive ───────────────┤◄── key:exchange ────────────┤
   │                               │                           │
   │  [ECDH + HKDF on both sides]  │  [server sees only JWKs]  │
   │  sharedKey = AES-GCM-256      │                           │
   │                               │                           │
   ├──[fingerprint modal]──── out of band ────[fingerprint modal]─┤
   │                               │                           │
   ├─ message:send(iv, ciphertext)─►│──► message:receive ────────►│
   │                               │  (server sees only bytes) │
```

**What the server never sees:** plaintext messages, ECDH private keys, or the room secret.

**Room secret:** Stored in the URL fragment (`#secret`). The HTTP spec says fragment identifiers are never sent to the server, so the room secret is browser-only. It binds the AES key to the specific room via HKDF — two rooms sharing the same ECDH key pairs still can't decrypt each other's messages.

**Why each primitive:**
- **ECDH P-256** — key exchange that generates a shared secret without transmitting it
- **HKDF** — derives a domain-separated AES key from the ECDH shared secret + room secret
- **AES-GCM-256** — authenticated encryption: decryption fails if the ciphertext was tampered with
- **Fingerprint verification** — SHA-256 of both public keys (order-independent); both peers see the same value, so a server swapping keys is detectable

**What this does NOT protect against:**
- No perfect forward secrecy across sessions (no double-ratchet protocol)
- A compromised server can relay malicious JS to the browser before the key exchange
- Room codes are 32-bit (8 hex chars) — adequate at realistic scale but not cryptographically large
- No deniability; message timestamps are server-generated

## Project structure

```
void-chat/
├── server.js              # Express + Socket.io server
├── lib/
│   └── rooms.js           # Pure room logic (genCode, sanitizeName, checkRate)
├── tests/
│   ├── server.test.js     # Unit + HTTP integration tests
│   ├── socket.test.js     # Socket.io integration tests
│   └── crypto.test.js     # E2EE round-trip + fingerprint tests
└── public/
    ├── index.html         # Landing page
    ├── room.html          # Chat room
    ├── style.css          # Dark terminal UI
    ├── app.js             # Landing page logic
    ├── crypto.js          # E2EE utilities (bufToBase64url, deriveSharedKey, etc.)
    └── room.js            # Room logic (socket events, UI)
```

## Environment variables

| Variable | Default | Description       |
|----------|---------|-------------------|
| `PORT`   | `3000`  | Port to listen on |

## Endpoints

| Method | Path             | Description                        |
|--------|------------------|------------------------------------|
| POST   | `/api/rooms`     | Create a room (rate limited)       |
| GET    | `/api/rooms/:code` | Look up a room (rate limited)    |
| GET    | `/health`        | Health check (`{ status, rooms, uptime }`) |

## Deploying

Works on any Node.js host (Railway, Render, Fly.io, etc.). Set the `PORT` environment variable if required by the platform. No database needed.

For Railway: connect the GitHub repo — it auto-detects Node.js and uses the `PORT` env var automatically.

For Docker:
```bash
docker build -t void-chat .
docker run -p 3000:3000 void-chat
```

## Scaling notes

Room state is in-process memory. Horizontal scaling requires sticky sessions (Socket.io session affinity) or a Redis adapter for the Socket.io cluster. By design, if the server restarts all rooms are lost — this is a privacy feature, not a bug.
