const code = window.location.pathname.replace('/r/', '').toUpperCase();
if (!code) { window.location.href = '/'; }

// ── E2EE helpers ─────────────────────────────────────────────
function bufToBase64url(u8) {
  let bin = '';
  for (let i = 0; i < u8.length; i += 1024)
    bin += String.fromCharCode(...u8.subarray(i, i + 1024));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
function base64urlToBuf(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

// ── E2EE state ────────────────────────────────────────────────
const e2ee = { keyPair: null, sharedKey: null, fingerprint: null, selfReady: false, peerReady: false };
let kxTimeout = null;

async function initE2EE() {
  e2ee.keyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']
  );
}

async function broadcastPublicKey() {
  const jwk = await crypto.subtle.exportKey('jwk', e2ee.keyPair.publicKey);
  socket.emit('key:exchange', { publicKey: JSON.stringify(jwk) });
}

async function computeFingerprint(peerJWK) {
  const ownJWK = await crypto.subtle.exportKey('jwk', e2ee.keyPair.publicKey);
  const parts = [ownJWK.x + ownJWK.y, peerJWK.x + peerJWK.y].sort();
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(parts.join('|')));
  const hex = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  return hex.slice(0, 20).match(/.{1,4}/g).join(' ');
}

function setE2EEBadge(state, fingerprint) {
  const badge = document.getElementById('e2ee-badge');
  const label = document.getElementById('e2ee-label');
  if (!badge) return;
  badge.className = 'e2ee-badge e2ee-' + state;
  if (state === 'secured') {
    label.textContent = '🔒 e2ee';
    badge.title = 'End-to-end encrypted\nFingerprint: ' + fingerprint + '\nAsk peer to confirm.';
  } else if (state === 'failed') {
    label.textContent = '⚠ not secure';
    badge.title = 'Encryption failed — chat is locked.';
  } else {
    label.textContent = '🔓 securing...';
    badge.title = 'Establishing secure channel...';
  }
}

function checkBothReady() {
  if (e2ee.selfReady && e2ee.peerReady) {
    clearTimeout(kxTimeout);
    unlockInput();
    setE2EEBadge('secured', e2ee.fingerprint);
    addSystem('secure channel established.', 'ok');
  }
}

document.title = `${code} · void`;
document.getElementById('room-code').textContent = code;

const messagesEl      = document.getElementById('messages');
const inputEl         = document.getElementById('msg-input');
const sendBtn         = document.getElementById('send-btn');
const statusEl        = document.getElementById('status');
const copyBtn         = document.getElementById('copy-btn');
const typingEl        = document.getElementById('typing-indicator');
const youNameEl       = document.getElementById('you-name');

let mySocketId    = null;
let typingTimeout = null;
let peerConnected = false;
let peerName      = 'voidmous';

let myName    = localStorage.getItem('void_name') || '';
let nameReady = Boolean(localStorage.getItem('void_name'));

// ── socket ──────────────────────────────────────────────────

const socket = io();

if (!nameReady) {
  const gateEl    = document.getElementById('name-gate');
  const gateInput = document.getElementById('gate-name');
  const gateBtn   = document.getElementById('gate-btn');
  document.getElementById('gate-room-code').textContent = code;
  gateEl.classList.add('visible');
  setTimeout(() => gateInput.focus(), 50);

  function submitGate() {
    myName = gateInput.value.trim();
    localStorage.setItem('void_name', myName);
    gateEl.classList.remove('visible');
    nameReady = true;
    if (socket.connected) socket.emit('room:join', { code, name: myName });
  }

  gateBtn.addEventListener('click', submitGate);
  gateInput.addEventListener('keydown', e => { if (e.key === 'Enter') submitGate(); });
}

socket.on('connect', () => {
  mySocketId = socket.id;
  if (nameReady) socket.emit('room:join', { code, name: myName });
});

socket.on('room:you', ({ name }) => {
  youNameEl.textContent = name;
});

socket.on('disconnect', () => {
  setStatus('disconnected', 'connection lost');
  addSystem('disconnected from server.', 'error');
  lockInput();
});

socket.on('error', ({ message }) => {
  addSystem(message, 'error');
  lockInput();
  setTimeout(() => { window.location.href = '/'; }, 3000);
});

socket.on('room:update', ({ users }) => {
  if (users === 1) {
    setStatus('waiting', 'waiting...');
    peerConnected = false;
  } else if (users === 2) {
    setStatus('connected', 'connected');
    peerConnected = true;
  }
});

socket.on('room:peer_joined', async ({ peerName: name, expiresAt }) => {
  peerName = name;
  startTimer(expiresAt);
  addSystem(`${name} joined. establishing secure channel...`, 'ok');
  setE2EEBadge('pending');

  kxTimeout = setTimeout(() => {
    if (!e2ee.selfReady || !e2ee.peerReady) {
      setE2EEBadge('failed');
      addSystem('secure channel failed. refresh to retry.', 'error');
    }
  }, 10000);

  await initE2EE();
  await broadcastPublicKey();
});

socket.on('room:peer_left', ({ peerName: name }) => {
  peerConnected = false;
  e2ee.keyPair = null; e2ee.sharedKey = null; e2ee.fingerprint = null;
  e2ee.selfReady = false; e2ee.peerReady = false;
  clearTimeout(kxTimeout);
  setStatus('waiting', 'waiting...');
  setE2EEBadge('pending');
  addSystem(`${name} left the room.`, 'warn');
  clearTyping();
  lockInput();
});

socket.on('key:receive', async ({ publicKey }) => {
  let peerJWK;
  try { peerJWK = JSON.parse(publicKey); } catch { setE2EEBadge('failed'); return; }

  let peerKey;
  try {
    peerKey = await crypto.subtle.importKey(
      'jwk', peerJWK, { name: 'ECDH', namedCurve: 'P-256' }, false, []
    );
  } catch { setE2EEBadge('failed'); return; }

  try {
    e2ee.sharedKey = await crypto.subtle.deriveKey(
      { name: 'ECDH', public: peerKey },
      e2ee.keyPair.privateKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  } catch { setE2EEBadge('failed'); return; }

  e2ee.fingerprint = await computeFingerprint(peerJWK);
  e2ee.selfReady = true;
  socket.emit('key:ready');
  checkBothReady();
});

socket.on('key:peer_ready', () => {
  e2ee.peerReady = true;
  checkBothReady();
});

socket.on('room:deleted', ({ reason }) => {
  const msg = reason === 'expired' ? 'room expired after 24h.' : 'room closed — everyone left.';
  addSystem(msg, 'error');
  lockInput();
  setTimeout(() => { window.location.href = '/'; }, 3000);
});

socket.on('message:receive', async ({ iv, ciphertext, socketId, ts }) => {
  const isSelf = socketId === mySocketId;
  if (isSelf) return; // displayed locally in send()

  if (!e2ee.sharedKey) return;

  let plaintext;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64urlToBuf(iv) },
      e2ee.sharedKey,
      base64urlToBuf(ciphertext)
    );
    plaintext = new TextDecoder().decode(plain);
  } catch {
    addMessage('[message could not be decrypted]', false, ts);
    clearTyping();
    return;
  }

  addMessage(plaintext, false, ts);
  clearTyping();
});

socket.on('typing:start', () => {
  typingEl.textContent = `${peerName} is typing...`;
});

socket.on('typing:stop', () => {
  clearTyping();
});

// ── send ─────────────────────────────────────────────────────

async function send() {
  const text = inputEl.value.trim();
  if (!text || inputEl.disabled || !e2ee.sharedKey) return;

  const encoded = new TextEncoder().encode(text);
  if (encoded.length > 6000) {
    addSystem('message too long.', 'error');
    return;
  }

  const iv = crypto.getRandomValues(new Uint8Array(12));
  let cipherBuf;
  try {
    cipherBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, e2ee.sharedKey, encoded);
  } catch {
    addSystem('encryption failed — message not sent.', 'error');
    return;
  }

  socket.emit('message:send', {
    iv: bufToBase64url(iv),
    ciphertext: bufToBase64url(new Uint8Array(cipherBuf))
  });
  socket.emit('typing:stop');
  clearTimeout(typingTimeout);
  addMessage(text, true, Date.now());
  inputEl.value = '';
}

sendBtn.addEventListener('click', send);

inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

// typing indicator
inputEl.addEventListener('input', () => {
  if (!inputEl.value.trim()) {
    socket.emit('typing:stop');
    clearTimeout(typingTimeout);
    return;
  }
  socket.emit('typing:start');
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => socket.emit('typing:stop'), 2500);
});

// ── copy link ────────────────────────────────────────────────

copyBtn.addEventListener('click', () => {
  navigator.clipboard.writeText(window.location.href).then(() => {
    copyBtn.textContent = 'copied!';
    setTimeout(() => { copyBtn.textContent = 'copy link'; }, 2000);
  });
});

// ── DOM helpers ───────────────────────────────────────────────

function addMessage(text, isSelf, ts) {
  const wrap = document.createElement('div');
  wrap.className = `message ${isSelf ? 'self' : 'other'}`;

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;

  const time = document.createElement('span');
  time.className = 'timestamp';
  time.textContent = formatTime(ts);

  wrap.appendChild(bubble);
  wrap.appendChild(time);
  messagesEl.appendChild(wrap);
  scrollBottom();
}

function addSystem(text, type = '') {
  const div = document.createElement('div');
  div.className = `system-msg ${type}`;
  div.textContent = text;
  messagesEl.appendChild(div);
  scrollBottom();
}

function setStatus(cls, label) {
  statusEl.className = `status ${cls}`;
  statusEl.textContent = label;
}

function lockInput() {
  inputEl.disabled = true;
  sendBtn.disabled = true;
}

function unlockInput() {
  inputEl.disabled = false;
  sendBtn.disabled = false;
  inputEl.focus();
}

function clearTyping() {
  typingEl.textContent = '';
}

function scrollBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

window.addEventListener('beforeunload', () => {
  localStorage.removeItem('void_name');
});

// ── timer ─────────────────────────────────────────────────────

function startTimer(expiresAt) {
  const el = document.getElementById('timer');

  function tick() {
    const ms = expiresAt - Date.now();
    if (ms <= 0) {
      el.textContent = '00:00:00';
      el.className = 'timer danger';
      return;
    }

    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    const s = Math.floor((ms % 60_000) / 1_000);
    el.textContent = [h, m, s].map(n => String(n).padStart(2, '0')).join(':');

    if (ms < 10 * 60_000) {
      el.className = 'timer danger';
    } else if (ms < 60 * 60_000) {
      el.className = 'timer warn';
    }

    setTimeout(tick, 1000);
  }

  tick();
}

// ── init ──────────────────────────────────────────────────────

fetch(`/api/rooms/${code}`)
  .then(res => {
    if (!res.ok) {
      addSystem('room not found or expired.', 'error');
      setTimeout(() => { window.location.href = '/'; }, 2000);
      return;
    }
    return res.json();
  })
  .then(data => {
    if (!data) return;
    // Only start timer here if conversation already began (e.g. page refresh mid-session)
    if (data.expiresAt) startTimer(data.expiresAt);
    addSystem(`room ${code} · expires in 24h or when empty`);
  })
  .catch(() => {
    addSystem(`room ${code} · expires in 24h or when empty`);
  });
