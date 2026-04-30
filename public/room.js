const code = window.location.pathname.replace('/r/', '').toUpperCase();
if (!code) { window.location.href = '/'; }

const roomSecret = window.location.hash.slice(1); // never sent to server

// ── E2EE state ────────────────────────────────────────────────
const e2ee = { keyPair: null, sharedKey: null, fingerprint: null, selfReady: false, peerReady: false, ready: null };
let kxTimeout = null;

async function initE2EE() {
  e2ee.keyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']
  );
}

async function broadcastPublicKey() {
  const jwk = await crypto.subtle.exportKey('jwk', e2ee.keyPair.publicKey);
  socket.emit('key:exchange', { publicKey: JSON.stringify(jwk) });
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
    showFingerprintModal(e2ee.fingerprint);
  }
}

function showFingerprintModal(fp) {
  const gate = document.getElementById('fp-gate');
  document.getElementById('fp-value').textContent = fp;
  gate.classList.add('visible');

  document.getElementById('fp-match-btn').onclick = () => {
    gate.classList.remove('visible');
    unlockInput();
    setE2EEBadge('secured', fp);
    addSystem('secure channel established. fingerprints verified.', 'ok');
  };
  document.getElementById('fp-mismatch-btn').onclick = () => {
    gate.classList.remove('visible');
    setE2EEBadge('failed');
    addSystem('fingerprint mismatch — possible interception. do not send messages.', 'error');
    lockInput();
    socket.disconnect();
  };
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

  const submitGate = () => {
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
  setStatus('disconnected', 'reconnecting...');
  addSystem('connection lost — reconnecting...', 'warn');
  lockInput();
});

socket.on('reconnect', () => {
  addSystem('reconnected — rejoining room...', 'ok');
  socket.emit('room:join', { code, name: myName });
});

socket.on('reconnect_failed', () => {
  setStatus('disconnected', 'connection lost');
  addSystem('could not reconnect. please refresh.', 'error');
});

socket.on('error', ({ message }) => {
  addSystem(message, 'error');
  lockInput();
  setTimeout(() => { window.location.href = '/'; }, 3000);
});

socket.on('room:update', ({ users }) => {
  if (users === 1) {
    setStatus('waiting', 'waiting...');
  } else if (users === 2) {
    setStatus('connected', 'connected');
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

  e2ee.ready = initE2EE().then(broadcastPublicKey);
  await e2ee.ready;
});

socket.on('room:peer_left', ({ peerName: name }) => {
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
  // Guard against the peer's key arriving before our own key pair is generated
  if (e2ee.ready) await e2ee.ready;

  let peerJWK;
  try { peerJWK = JSON.parse(publicKey); } catch { setE2EEBadge('failed'); return; }

  let peerKey;
  try {
    peerKey = await crypto.subtle.importKey(
      'jwk', peerJWK, { name: 'ECDH', namedCurve: 'P-256' }, false, []
    );
  } catch { setE2EEBadge('failed'); return; }

  try {
    e2ee.sharedKey = await deriveSharedKey(e2ee.keyPair.privateKey, peerKey, roomSecret);
  } catch { setE2EEBadge('failed'); return; }

  if (!roomSecret) addSystem('warning: room secret missing — use the full shared link for maximum security.', 'warn');

  const ownJWK = await crypto.subtle.exportKey('jwk', e2ee.keyPair.publicKey);
  e2ee.fingerprint = await computeFingerprint(ownJWK, peerJWK);
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
