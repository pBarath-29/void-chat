const code = window.location.pathname.replace('/r/', '').toUpperCase();
if (!code) { window.location.href = '/'; }


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
    label.textContent = '[enc] e2ee';
    badge.title = 'End-to-end encrypted\nFingerprint: ' + fingerprint + '\nAsk peer to confirm.';
  } else if (state === 'failed') {
    label.textContent = '[!] not secure';
    badge.title = 'Encryption failed — chat is locked.';
  } else {
    label.textContent = '[...] securing...';
    badge.title = 'Establishing secure channel...';
  }
}

function checkBothReady() {
  if (e2ee.selfReady && e2ee.peerReady) {
    clearTimeout(kxTimeout);
    showFingerprintModal(e2ee.fingerprint);
  }
}

// ── Focus trap helper ─────────────────────────────────────────

function trapFocus(containerEl, onRelease) {
  const focusable = containerEl.querySelectorAll(
    'button, input, a[href], [tabindex]:not([tabindex="-1"])'
  );
  const first = focusable[0];
  const last  = focusable[focusable.length - 1];

  function handler(e) {
    if (e.key !== 'Tab') return;
    if (e.shiftKey) {
      if (document.activeElement === first) { e.preventDefault(); last.focus(); }
    } else {
      if (document.activeElement === last)  { e.preventDefault(); first.focus(); }
    }
  }

  document.addEventListener('keydown', handler);
  return () => {
    document.removeEventListener('keydown', handler);
    if (onRelease) onRelease();
  };
}

function showFingerprintModal(fp) {
  const gate = document.getElementById('fp-gate');
  document.getElementById('fp-value').textContent = fp;
  gate.classList.add('visible');

  const matchBtn    = document.getElementById('fp-match-btn');
  const mismatchBtn = document.getElementById('fp-mismatch-btn');
  const releaseTrap = trapFocus(gate);
  setTimeout(() => matchBtn.focus(), 30);

  matchBtn.onclick = () => {
    releaseTrap();
    gate.classList.remove('visible');
    unlockInput();
    setE2EEBadge('secured', fp);
    addSystem('secure channel established. fingerprints verified.', 'ok');
  };
  mismatchBtn.onclick = () => {
    releaseTrap();
    gate.classList.remove('visible');
    setE2EEBadge('failed');
    addSystem('fingerprint mismatch — possible interception. do not send messages.', 'error');
    lockInput();
    socket.disconnect();
  };
}

document.title = `${code} · void`;
document.getElementById('room-code').textContent = code;

const messagesEl  = document.getElementById('messages');
const inputEl     = document.getElementById('msg-input');
const sendBtn     = document.getElementById('send-btn');
const statusEl    = document.getElementById('status');
const copyBtn     = document.getElementById('copy-btn');
const typingEl    = document.getElementById('typing-indicator');
const youNameEl   = document.getElementById('you-name');
const charCountEl = document.getElementById('char-count');
const scrollBtn   = document.getElementById('scroll-btn');
const scrollCount = document.getElementById('scroll-count');
const emptyState  = document.getElementById('empty-state');
const emptyCode   = document.getElementById('empty-code');
const emptyCopyBtn= document.getElementById('empty-copy-btn');
const deadState   = document.getElementById('dead-state');
const deadMsg     = document.getElementById('dead-msg');
const soundBtn    = document.getElementById('sound-btn');

let mySocketId      = null;
let typingTimeout   = null;
let peerName        = 'voidmous';
let peerEverJoined  = false;
let newMsgCount   = 0;
let audioCtx      = null;
let soundEnabled  = localStorage.getItem('void_sound') !== 'off';

let myName    = localStorage.getItem('void_name') || '';
let nameReady = Boolean(localStorage.getItem('void_name'));

// ── Sound ─────────────────────────────────────────────────────

function initAudio() {
  if (audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
}

// Initialise AudioContext on first user interaction (autoplay policy)
document.addEventListener('click', initAudio, { once: true });
document.addEventListener('keydown', initAudio, { once: true });

function playNotification() {
  if (!soundEnabled || !audioCtx) return;
  try {
    const osc  = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(660, audioCtx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(440, audioCtx.currentTime + 0.1);
    gain.gain.setValueAtTime(0.07, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.3);
    osc.start(audioCtx.currentTime);
    osc.stop(audioCtx.currentTime + 0.3);
  } catch (_) { /* ignore audio errors */ }
}

function updateSoundBtn() {
  soundBtn.textContent = soundEnabled ? 'snd:on' : 'snd:off';
  soundBtn.classList.toggle('muted', !soundEnabled);
}
updateSoundBtn();

soundBtn.addEventListener('click', () => {
  initAudio();
  soundEnabled = !soundEnabled;
  localStorage.setItem('void_sound', soundEnabled ? 'on' : 'off');
  updateSoundBtn();
});

// ── Favicon badge ─────────────────────────────────────────────

function drawFavicon(count) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 32;
  const ctx = canvas.getContext('2d');
  const accent = getComputedStyle(document.documentElement)
    .getPropertyValue('--accent').trim() || '#39d353';

  ctx.fillStyle = '#090909';
  ctx.fillRect(0, 0, 32, 32);
  ctx.fillStyle = accent;
  ctx.font = 'bold 18px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  if (count > 0) {
    ctx.fillText(count > 9 ? '9+' : String(count), 16, 16);
  } else {
    ctx.fillText('v', 16, 17);
  }
  document.getElementById('favicon').href = canvas.toDataURL();
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    newMsgCount = 0;
    drawFavicon(0);
    scrollBtn.classList.remove('visible');
  }
});

// ── Scroll-to-bottom ──────────────────────────────────────────

function isNearBottom() {
  return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
}

function scrollBottom() {
  if (isNearBottom()) {
    messagesEl.scrollTop = messagesEl.scrollHeight;
    scrollBtn.classList.remove('visible');
    scrollCount.textContent = '';
    newMsgCount = 0;
  } else {
    newMsgCount++;
    scrollCount.textContent = newMsgCount;
    scrollBtn.classList.add('visible');
  }
}

function forceScrollBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
  scrollBtn.classList.remove('visible');
  scrollCount.textContent = '';
  newMsgCount = 0;
}

scrollBtn.addEventListener('click', () => {
  forceScrollBottom();
});

// ── Dead state (replaces forced redirects) ────────────────────

function showDeadState(msg) {
  deadMsg.textContent = msg;
  deadState.classList.add('visible');
}

// ── Empty state ───────────────────────────────────────────────

function showEmptyState() {
  emptyCode.textContent = code;
  emptyState.style.display = 'flex';

}

function hideEmptyState() {
  emptyState.style.display = 'none';
}

emptyCopyBtn.addEventListener('click', () => copyRoomLink(emptyCopyBtn));

// ── Copy link (with fallback) ─────────────────────────────────

function copyRoomLink(btn) {
  const url = window.location.href;
  const original = btn.textContent;

  const fallback = () => {
    const ta = document.createElement('textarea');
    ta.value = url;
    ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (_) { /* fallback may not be available */ }
    ta.remove();
  };

  const onSuccess = () => {
    btn.textContent = '✓ copied';
    btn.style.color = 'var(--accent)';
    setTimeout(() => {
      btn.textContent = original;
      btn.style.color = '';
    }, 2000);
  };

  if (navigator.clipboard) {
    navigator.clipboard.writeText(url).then(onSuccess).catch(() => { fallback(); onSuccess(); });
  } else {
    fallback();
    onSuccess();
  }
}

copyBtn.addEventListener('click', () => copyRoomLink(copyBtn));

// ── Character counter ─────────────────────────────────────────

inputEl.addEventListener('input', () => {
  const len = inputEl.value.length;
  if (len > 1800) {
    charCountEl.textContent = `${len}/2000`;
    charCountEl.style.color = len > 1950 ? 'var(--error)' : 'var(--warn)';
  } else {
    charCountEl.textContent = '';
    charCountEl.style.color = '';
  }

  // typing indicator
  if (!inputEl.value.trim()) {
    socket.emit('typing:stop');
    clearTimeout(typingTimeout);
    return;
  }
  socket.emit('typing:start');
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => socket.emit('typing:stop'), 2500);
});

// ── socket ──────────────────────────────────────────────────

const socket = io();

if (!nameReady) {
  const gateEl    = document.getElementById('name-gate');
  const gateInput = document.getElementById('gate-name');
  const gateBtn   = document.getElementById('gate-btn');
  document.getElementById('gate-room-code').textContent = code;
  gateEl.classList.add('visible');
  setTimeout(() => gateInput.focus(), 50);

  const releaseTrap = trapFocus(gateEl);

  const submitGate = () => {
    releaseTrap();
    myName = gateInput.value.trim();
    localStorage.setItem('void_name', myName);
    gateEl.classList.remove('visible');
    nameReady = true;
    if (socket.connected) socket.emit('room:join', { code, name: myName });
  };

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
  showDeadState(message);
});

socket.on('room:update', ({ users }) => {
  if (users === 1) {
    setStatus('waiting', 'waiting...');
    if (!peerEverJoined) showEmptyState();
  } else if (users === 2) {
    setStatus('connected', 'connected');
    hideEmptyState();
  }
});

socket.on('room:peer_joined', async ({ peerName: name, expiresAt }) => {
  peerName = name;
  peerEverJoined = true;
  hideEmptyState();
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
    e2ee.sharedKey = await deriveSharedKey(e2ee.keyPair.privateKey, peerKey, code);
  } catch { setE2EEBadge('failed'); return; }

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
  showDeadState(msg);
});

socket.on('message:receive', async ({ iv, ciphertext, socketId, ts }) => {
  const isSelf = socketId === mySocketId;
  if (isSelf) return;

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

  if (document.hidden || !isNearBottom()) {
    newMsgCount++;
    scrollCount.textContent = newMsgCount;
    scrollBtn.classList.add('visible');
    drawFavicon(newMsgCount);
    playNotification();
  }
});

socket.on('typing:start', () => {
  typingEl.innerHTML = `<span class="typing-name">${peerName}</span> <span class="typing-dots"><span>.</span><span>.</span><span>.</span></span>`;
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
  charCountEl.textContent = '';
}

sendBtn.addEventListener('click', send);

inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
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
  forceScrollBottom();
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
  typingEl.innerHTML = '';
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
      el.textContent = '00:00';
      el.className = 'timer danger';
      return;
    }

    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    const s = Math.floor((ms % 60_000) / 1_000);

    // Abbreviate to mm:ss on narrow screens (< 600px) when < 1h
    const narrow = window.innerWidth < 600;
    if (narrow && h === 0) {
      el.textContent = [m, s].map(n => String(n).padStart(2, '0')).join(':');
    } else {
      el.textContent = [h, m, s].map(n => String(n).padStart(2, '0')).join(':');
    }

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
      showDeadState('room not found or expired.');
      return;
    }
    return res.json();
  })
  .then(data => {
    if (!data) return;
    if (data.expiresAt) startTimer(data.expiresAt);
    addSystem(`room ${code} · expires in 24h or when empty`);
    if (data.users < 2 && !data.expiresAt) showEmptyState();
  })
  .catch(() => {
    addSystem(`room ${code} · expires in 24h or when empty`);
    showEmptyState();
  });
