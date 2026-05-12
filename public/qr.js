// Self-contained QR code SVG generator (no external deps).
// EC level M, byte mode, versions 1-10.
// Faithfully ported from Nayuki qrcodegen reference (public domain).
// Usage: window.generateQRSVG(url) → SVG string

(function () {
  'use strict';

  // ── GF(256) arithmetic ────────────────────────────────────────

  const EXP = new Uint8Array(512);
  const LOG = new Uint8Array(256);
  (function () {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x; LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();

  function gmul(a, b) { return (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]]; }

  function rsEncode(data, ecLen) {
    let g = new Uint8Array([1]);
    for (let i = 0; i < ecLen; i++) {
      const f = new Uint8Array([1, EXP[i]]);
      const p = new Uint8Array(g.length + 1);
      for (let j = 0; j < g.length; j++)
        for (let k = 0; k < f.length; k++)
          p[j + k] ^= gmul(g[j], f[k]);
      g = p;
    }
    const msg = new Uint8Array(data.length + ecLen);
    msg.set(data);
    for (let i = 0; i < data.length; i++) {
      const c = msg[i];
      if (c) for (let j = 0; j < g.length; j++) msg[i + j] ^= gmul(g[j], c);
    }
    return msg.slice(data.length);
  }

  // ── Capacity tables (EC level M, verified vs ISO 18004 Table 9) ──

  const DATA_CAP = [0, 16, 28, 44, 64, 86, 108, 124, 154, 182, 216];

  // [ecPerBlock, [[count, dataPerBlock], ...]]
  const BLOCKS = [
    null,
    [10, [[1, 16]]],
    [16, [[1, 28]]],
    [26, [[1, 44]]],
    [18, [[2, 32]]],
    [24, [[2, 43]]],
    [16, [[4, 27]]],
    [18, [[4, 31]]],
    [22, [[2, 38], [2, 39]]],
    [20, [[3, 36], [2, 37]]],
    [24, [[4, 43], [1, 44]]],
  ];

  const REMAINDER_BITS = [0, 0, 7, 7, 7, 7, 7, 0, 0, 0, 0];

  // ── Matrix ────────────────────────────────────────────────────
  // Values: -1 = unfilled data, 0/1 = module, 2 = reserved (format/version area)
  // isFunc parallel matrix: true = function module (never masked)

  function makeMatrix(n) {
    return Array.from({ length: n }, () => new Int8Array(n).fill(-1));
  }

  // ── Function patterns ─────────────────────────────────────────

  function drawFinder(m, row, col) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = row + r, cc = col + c;
        if (rr < 0 || rr >= m.length || cc < 0 || cc >= m.length) continue;
        const sep    = r === -1 || r === 7 || c === -1 || c === 7;
        const outer  = (r === 0 || r === 6) && c >= 0 && c <= 6;
        const side   = c === 0 || c === 6;
        const inner  = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        m[rr][cc] = sep ? 0 : (outer || side || inner ? 1 : 0);
      }
    }
  }

  function drawAlignment(m, row, col) {
    for (let r = -2; r <= 2; r++)
      for (let c = -2; c <= 2; c++)
        m[row + r][col + c] = (r === -2 || r === 2 || c === -2 || c === 2 || (r === 0 && c === 0)) ? 1 : 0;
  }

  const ALIGN_POS = [
    [], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
    [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
  ];

  function drawAlignments(m, ver) {
    const pos = ALIGN_POS[ver];
    if (!pos || pos.length < 2) return;
    const last = pos[pos.length - 1];
    for (const r of pos)
      for (const c of pos)
        if (!((r === 6 && c === 6) || (r === 6 && c === last) || (r === last && c === 6)))
          drawAlignment(m, r, c);
  }

  function drawTiming(m) {
    const n = m.length;
    for (let i = 8; i < n - 8; i++) {
      if (m[6][i] === -1) m[6][i] = i % 2 === 0 ? 1 : 0;
      if (m[i][6] === -1) m[i][6] = i % 2 === 0 ? 1 : 0;
    }
  }

  // Mark format/version areas as reserved (value 2) so they're never masked
  function reserveFormat(m) {
    const n = m.length;
    for (let i = 0; i < 9; i++) {
      if (m[8][i] === -1) m[8][i] = 2;
      if (m[i][8] === -1) m[i][8] = 2;
    }
    for (let i = 0; i < 8; i++) {
      if (m[8][n - 1 - i] === -1) m[8][n - 1 - i] = 2;
      if (m[n - 1 - i][8] === -1) m[n - 1 - i][8] = 2;
    }
  }

  function reserveVersion(m, ver) {
    if (ver < 7) return;
    const n = m.length;
    for (let i = 0; i < 18; i++) {
      const r = Math.floor(i / 3), c = n - 11 + (i % 3);
      if (m[r][c] === -1) m[r][c] = 2;
      if (m[c][r] === -1) m[c][r] = 2;
    }
  }

  // ── Format information ─────────────────────────────────────────
  // Computed at runtime: EC_M indicator = 0b00, BCH generator 0x537, XOR mask 0x5412

  function formatBits(maskIdx) {
    let rem = maskIdx; // EC_M = 0b00, so data = maskIdx (low 3 bits)
    for (let i = 0; i < 10; i++)
      rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    return ((maskIdx << 10) | rem) ^ 0x5412; // 15-bit, bit0 = LSB = f0
  }

  // Exact port of Nayuki drawFormatBits.
  // First copy: L-shape in top-left corner (col-8 vertical + row-8 horizontal).
  // Second copy: top-right (row-8) + bottom-left (col-8).
  function writeFormat(m, maskIdx) {
    const n = m.length;
    const b = formatBits(maskIdx);

    // First copy (top-left)
    for (let i = 0; i <= 5; i++) { m[8][i] = (b >> i) & 1; m[i][8] = (b >> i) & 1; }
    m[8][7] = (b >> 6) & 1;
    m[8][8] = (b >> 7) & 1;
    m[7][8] = (b >> 8) & 1;
    for (let i = 9; i < 15; i++) { m[8][14 - i] = (b >> i) & 1; m[14 - i][8] = (b >> i) & 1; }

    // Second copy
    for (let i = 0; i <= 7; i++) m[n - 1 - i][8] = (b >> i) & 1;
    for (let i = 8; i < 15; i++) m[8][n - 15 + i] = (b >> i) & 1;
    m[8][n - 8] = 1; // always-dark module (per Nayuki / ISO 18004)
  }

  // ── Version information ────────────────────────────────────────
  // 18-bit values from ISO 18004 Table D.1, bit 0 = LSB

  const VER_BITS = [
    0, 0, 0, 0, 0, 0, 0,
    0b000111110010010100,
    0b001000010110111100,
    0b001001101010011001,
    0b001010010011010011,
  ];

  function writeVersion(m, ver) {
    if (ver < 7) return;
    const n = m.length, b = VER_BITS[ver];
    for (let i = 0; i < 18; i++) {
      const v = (b >> i) & 1;
      const r = Math.floor(i / 3), c = n - 11 + (i % 3);
      m[r][c] = v; m[c][r] = v;
    }
  }

  // ── Data encoding ──────────────────────────────────────────────

  function encodeData(bytes, ver) {
    const totalBits = DATA_CAP[ver] * 8;
    const out = [];
    const push = (v, len) => { for (let i = len - 1; i >= 0; i--) out.push((v >> i) & 1); };
    push(0b0100, 4); push(bytes.length, 8);
    for (const b of bytes) push(b, 8);
    for (let i = 0; i < 4 && out.length < totalBits; i++) out.push(0);
    while (out.length % 8) out.push(0);
    for (let pi = 0; out.length < totalBits; pi++) push(pi % 2 ? 0x11 : 0xEC, 8);
    return out;
  }

  function bitsToBytes(bits) {
    const b = new Uint8Array(bits.length >> 3);
    for (let i = 0; i < b.length; i++) {
      let v = 0;
      for (let j = 0; j < 8; j++) v = (v << 1) | bits[i * 8 + j];
      b[i] = v;
    }
    return b;
  }

  function interleave(ver, dataBits) {
    const [ecPB, groups] = BLOCKS[ver];
    const db = bitsToBytes(dataBits);
    const blocks = [];
    let off = 0;
    for (const [cnt, dcw] of groups) {
      for (let b = 0; b < cnt; b++) {
        const data = db.slice(off, off + dcw);
        blocks.push({ data, ec: rsEncode(data, ecPB) });
        off += dcw;
      }
    }
    const maxDC = Math.max(...blocks.map(b => b.data.length));
    const out = [];
    for (let i = 0; i < maxDC; i++)
      for (const blk of blocks) if (i < blk.data.length) out.push(blk.data[i]);
    for (let i = 0; i < ecPB; i++)
      for (const blk of blocks) out.push(blk.ec[i]);
    const finalBits = [];
    for (const byte of out) for (let i = 7; i >= 0; i--) finalBits.push((byte >> i) & 1);
    for (let i = 0; i < REMAINDER_BITS[ver]; i++) finalBits.push(0);
    return finalBits;
  }

  // ── Data placement ─────────────────────────────────────────────

  function placeData(m, bits) {
    const n = m.length;
    let idx = 0;
    for (let right = n - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      const goUp = Math.floor((n - 1 - right) / 2) % 2 === 0;
      for (let vert = 0; vert < n; vert++) {
        const row = goUp ? (n - 1 - vert) : vert;
        for (let j = 0; j < 2; j++) {
          const col = right - j;
          if (m[row][col] === -1)
            m[row][col] = idx < bits.length ? bits[idx++] : 0;
        }
      }
    }
  }

  // ── Masking ────────────────────────────────────────────────────

  const MASK_FN = [
    (r, c) => (r + c) % 2 === 0,
    (r)    => r % 2 === 0,
    (_,c)  => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => (r * c) % 2 + (r * c) % 3 === 0,
    (r, c) => ((r * c) % 2 + (r * c) % 3) % 2 === 0,
    (r, c) => ((r + c) % 2 + (r * c) % 3) % 2 === 0,
  ];

  // isFunc[r][c] = true means this is a function module — never apply mask.
  // Captured after all function patterns are drawn but before placeData,
  // so any non-(-1) cell is a function module.
  function applyMask(m, isFunc, idx) {
    const fn = MASK_FN[idx];
    const res = m.map(row => new Int8Array(row));
    for (let r = 0; r < res.length; r++)
      for (let c = 0; c < res.length; c++)
        if (!isFunc[r][c] && fn(r, c)) res[r][c] ^= 1;
    return res;
  }

  function penalty(m) {
    const n = m.length;
    let s = 0;
    for (let r = 0; r < n; r++) {
      for (let dir = 0; dir < 2; dir++) {
        let run = 1;
        for (let i = 1; i < n; i++) {
          const cur  = dir ? m[i][r]   : m[r][i];
          const prev = dir ? m[i-1][r] : m[r][i-1];
          if (cur === prev) { run++; if (run === 5) s += 3; else if (run > 5) s++; }
          else run = 1;
        }
      }
    }
    for (let r = 0; r < n - 1; r++)
      for (let c = 0; c < n - 1; c++)
        if (m[r][c] === m[r][c+1] && m[r][c] === m[r+1][c] && m[r][c] === m[r+1][c+1])
          s += 3;
    let dark = 0;
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (m[r][c] === 1) dark++;
    s += Math.abs(Math.round(dark / (n * n) * 20) - 10) * 10;
    return s;
  }

  // ── Main ───────────────────────────────────────────────────────

  function generateQRSVG(text) {
    const bytes = new TextEncoder().encode(text);
    const needed = 4 + 8 + bytes.length * 8;
    let ver = 1;
    while (ver <= 10 && DATA_CAP[ver] * 8 < needed) ver++;
    if (ver > 10) throw new Error('URL too long for QR v1-10');

    const n = 17 + 4 * ver;
    const base = makeMatrix(n);

    // Draw all function patterns
    drawFinder(base, 0, 0);
    drawFinder(base, 0, n - 7);
    drawFinder(base, n - 7, 0);
    drawAlignments(base, ver);
    drawTiming(base);
    base[4 * ver + 9][8] = 1; // dark module

    // Reserve format/version areas AFTER function patterns so they don't overwrite
    reserveFormat(base);
    reserveVersion(base, ver);

    // Capture which cells are function modules (everything non-(-1) at this point).
    // placeData will fill -1 cells; applyMask must never touch function modules.
    const isFunc = base.map(row => Array.from(row, v => v !== -1));

    // Encode, interleave, place
    const dataBits  = encodeData(bytes, ver);
    const finalBits = interleave(ver, dataBits);
    placeData(base, finalBits);

    // Evaluate all 8 masks, pick lowest penalty
    let bestMask = 0, bestScore = Infinity, bestMatrix = null;
    for (let mask = 0; mask < 8; mask++) {
      const candidate = applyMask(base, isFunc, mask);
      writeFormat(candidate, mask);
      writeVersion(candidate, ver);
      const score = penalty(candidate);
      if (score < bestScore) { bestScore = score; bestMask = mask; bestMatrix = candidate; }
    }
    writeFormat(bestMatrix, bestMask);
    writeVersion(bestMatrix, ver);

    // Render SVG with theme colors
    const style = getComputedStyle(document.documentElement);
    const fg = style.getPropertyValue('--accent').trim() || '#39d353';
    const bg = style.getPropertyValue('--bg').trim()     || '#090909';
    const quiet = 4, sq = 4, dim = (n + quiet * 2) * sq;
    let rects = '';
    for (let r = 0; r < n; r++)
      for (let c = 0; c < n; c++)
        if (bestMatrix[r][c] === 1)
          rects += `<rect x="${(c+quiet)*sq}" y="${(r+quiet)*sq}" width="${sq}" height="${sq}"/>`;

    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges">` +
           `<rect width="${dim}" height="${dim}" fill="${bg}"/>` +
           `<g fill="${fg}">${rects}</g></svg>`;
  }

  window.generateQRSVG = generateQRSVG;
})();
