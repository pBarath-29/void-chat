const createBtn = document.getElementById('create-btn');
const joinBtn   = document.getElementById('join-btn');
const joinInput = document.getElementById('join-input');
const nameInput = document.getElementById('name-input');
const errMsg    = document.getElementById('err-msg');

// Restore saved name
nameInput.value = localStorage.getItem('void_name') || '';

function saveName() {
  localStorage.setItem('void_name', nameInput.value.trim());
}

function showErr(msg) {
  errMsg.textContent = msg;
  setTimeout(() => { errMsg.textContent = ''; }, 4000);
}

createBtn.addEventListener('click', async () => {
  saveName();
  createBtn.disabled = true;
  createBtn.textContent = 'creating...';
  errMsg.textContent = '';

  try {
    const res = await fetch('/api/rooms', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to create room.');
    const secret = Array.from(crypto.getRandomValues(new Uint8Array(16)))
      .map(b => b.toString(16).padStart(2, '0')).join('');
    window.location.href = `/r/${data.code}#${secret}`;
  } catch (err) {
    showErr(err.message);
    createBtn.disabled = false;
    createBtn.textContent = 'create room →';
  }
});

async function joinRoom() {
  saveName();
  let raw = joinInput.value.trim();

  // Handle pasted full URLs like http://localhost:3000/r/ABCD1234#secret
  let fragment = '';
  const urlMatch = raw.match(/\/r\/([A-Za-z0-9]+)(?:#([A-Fa-f0-9]*))?/i);
  if (urlMatch) { raw = urlMatch[1]; fragment = urlMatch[2] ? '#' + urlMatch[2] : ''; }

  const code = raw.toUpperCase();
  if (!code) { showErr('Enter a room code.'); return; }

  joinBtn.disabled = true;
  joinBtn.textContent = 'joining...';
  errMsg.textContent = '';

  try {
    const res = await fetch(`/api/rooms/${code}`);
    if (!res.ok) {
      showErr('Room not found or expired.');
      joinBtn.disabled = false;
      joinBtn.textContent = 'join';
      return;
    }
    window.location.href = `/r/${code}${fragment}`;
  } catch {
    window.location.href = `/r/${code}${fragment}`;
  }
}

joinBtn.addEventListener('click', joinRoom);
joinInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') joinRoom();
});

joinInput.addEventListener('input', () => {
  joinInput.value = joinInput.value.toUpperCase();
});
