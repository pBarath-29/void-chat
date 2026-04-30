# void

Ephemeral chat rooms. No accounts. No logs. Vanishes when you leave.

## Features

- **Temporary rooms** — auto-delete after 24 hours or when everyone leaves
- **No login** — share a link, that's it
- **Real-time** — typing indicators, live 24h countdown, instant messages
- **Optional names** — choose a name or stay as `voidmous`
- **Rate limited** — 10 rooms/hour per IP, 30 messages/minute per user

## Requirements

- [Node.js](https://nodejs.org) v18 or later (download the LTS version)

## Setup

```bash
cd void-chat
npm install
npm start
```

Open `http://localhost:3000` in your browser.

For development with auto-restart on file changes:

```bash
npm run dev
```

## How it works

1. Open the site and optionally enter your name
2. Click **create room** — a unique 8-character code is generated
3. Share the link with one other person
4. Chat in real time
5. Room is gone when both of you leave (or after 24h)

Nothing is written to disk. All rooms live in memory only.

## Project structure

```
void-chat/
├── server.js          # Express + Socket.io server
├── package.json
└── public/
    ├── index.html     # Landing page
    ├── room.html      # Chat room
    ├── style.css      # Dark terminal UI
    ├── app.js         # Landing page logic
    └── room.js        # Room logic (socket events, UI)
```

## Environment variables

| Variable | Default | Description          |
|----------|---------|----------------------|
| `PORT`   | `3000`  | Port to listen on    |

## Deploying

Works on any Node.js host (Railway, Render, Fly.io, etc.). Set the `PORT` environment variable if required by the platform. No database needed.
