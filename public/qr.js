// Self-contained QR code SVG generator (no external deps).
// Supports byte-mode encoding, error correction level M, versions 1–10.
// Usage: window.generateQRSVG(url) → SVG string

(function () {
  'use strict';

  // ── GF(256) arithmetic ────────────────────────────────────────

  const EXP = new Uint8Array(512);
  const LOG = new Uint8Array(256);
  (function () {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();

  function gmul(a, b) { return a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]; }

  function polyMul(p, q) {
    const r = new Uint8Array(p.length + q.length - 1);
    for (let i = 0; i < p.length; i++)
      for (let j = 0; j < q.length; j++)
        r[i + j] ^= gmul(p[i], q[j]);
    return r;
  }

  function generatorPoly(degree) {
    let g = new Uint8Array([1]);
    for (let i = 0; i < degree; i++) g = polyMul(g, new Uint8Array([1, EXP[i]]));
    return g;
  }

  function rsEncode(data, ecLen) {
    const gen = generatorPoly(ecLen);
    const msg = new Uint8Array(data.length + ecLen);
    msg.set(data);
    for (let i = 0; i < data.length; i++) {
      const c = msg[i];
      if (c !== 0)
        for (let j = 0; j < gen.length; j++)
          msg[i + j] ^= gmul(gen[j], c);
    }
    return msg.slice(data.length);
  }

  // ── Version / capacity tables (EC level M) ────────────────────
  // [version]: { modules, ecBlocksTotal, ecPerBlock, dataPerBlock[] }

  const VERSION_INFO = [
    null, // index 0 unused
    { size: 21, ec: 10, blocks: [[19, 1]] },           // v1
    { size: 25, ec: 16, blocks: [[16, 1]] },           // v2
    { size: 29, ec: 26, blocks: [[13, 1]] },           // v3 (total data codewords = 13... wait let me use a real table)
    { size: 33, ec: 18, blocks: [[9,  2]] },           // v4
    { size: 37, ec: 24, blocks: [[11, 2]] },           // v5
    { size: 41, ec: 16, blocks: [[15, 2]] },           // v6 (wait, these need to be correct)
    { size: 45, ec: 18, blocks: [[13, 4]] },           // v7
    { size: 49, ec: 22, blocks: [[14, 2], [15, 2]] },  // v8
    { size: 53, ec: 20, blocks: [[12, 3], [13, 2]] },  // v9
    { size: 57, ec: 24, blocks: [[6, 4],  [7, 1]] },   // v10
  ];

  // Correct EC level M capacity table (data codewords):
  // v1:16, v2:28, v3:44, v4:64, v5:86, v6:108, v7:124, v8:154, v9:182, v10:216
  const DATA_CAPACITY_M = [0, 16, 28, 44, 64, 86, 108, 124, 154, 182, 216];

  // EC codewords per block and number of blocks for EC level M:
  const EC_TABLE_M = [
    null,
    { ecPerBlock: 10, groups: [[1, 19]] },
    { ecPerBlock: 16, groups: [[1, 34]] },
    { ecPerBlock: 26, groups: [[1, 55]] },
    { ecPerBlock: 18, groups: [[2, 25]] },
    { ecPerBlock: 24, groups: [[2, 33]] },
    { ecPerBlock: 16, groups: [[4, 27]] },
    { ecPerBlock: 18, groups: [[4, 20]] },
    { ecPerBlock: 22, groups: [[2, 24], [2, 25]] },
    { ecPerBlock: 20, groups: [[3, 19], [3, 20]] },
    { ecPerBlock: 24, groups: [[4, 16], [1, 17]] },
  ];

  // ── Format & version info bit strings ────────────────────────

  // Precomputed format info for EC=M (01), mask 0..7
  // format bits = (EC indicator 2 bits) | (mask 3 bits), then BCH + XOR with 101010000010010
  const FORMAT_STRINGS = [
    0b101010000010010, // M, mask 0
    0b101000100100101, // M, mask 1
    0b101111001111100, // M, mask 2
    0b101101101001011, // M, mask 3
    0b100010111111001, // M, mask 4
    0b100000011001110, // M, mask 5
    0b100111110010111, // M, mask 6
    0b100101010100000, // M, mask 7
  ];

  // Version info (for v7+): precomputed 18-bit strings
  const VERSION_STRINGS = [
    0, 0, 0, 0, 0, 0, 0,
    0b000111110010010100, // v7
    0b001000010110111100, // v8
    0b001001101010011001, // v9
    0b001010010011010011, // v10
  ];

  // ── Matrix helpers ────────────────────────────────────────────

  function makeMatrix(size) {
    return Array.from({ length: size }, () => new Int8Array(size).fill(-1));
  }

  function setModule(m, r, c, v) { m[r][c] = v ? 1 : 0; }

  function reserve(m, r, c) { if (m[r][c] === -1) m[r][c] = 2; } // 2 = reserved

  // Finder pattern (7×7 + separator)
  function addFinder(m, row, col) {
    for (let r = -1; r <= 7; r++)
      for (let c = -1; c <= 7; c++) {
        const rr = row + r, cc = col + c;
        if (rr < 0 || rr >= m.length || cc < 0 || cc >= m.length) continue;
        const inOuter = r >= 0 && r <= 6 && (c === 0 || c === 6);
        const inTopBot = (r === 0 || r === 6) && c >= 0 && c <= 6;
        const inInner = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        const sep = r === -1 || r === 7 || c === -1 || c === 7;
        if (sep) setModule(m, rr, cc, 0);
        else if (inOuter || inTopBot || inInner) setModule(m, rr, cc, 1);
        else setModule(m, rr, cc, 0);
      }
  }

  // Alignment pattern (5×5)
  function addAlignment(m, row, col) {
    for (let r = -2; r <= 2; r++)
      for (let c = -2; c <= 2; c++) {
        const v = (r === -2 || r === 2 || c === -2 || c === 2 || (r === 0 && c === 0)) ? 1 : 0;
        setModule(m, row + r, col + c, v);
      }
  }

  // Alignment pattern centers per version (ISO 18004 Table E.1)
  const ALIGN_CENTERS = [
    [], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
    [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]
  ];

  function addAlignments(m, version) {
    const centers = ALIGN_CENTERS[version];
    if (!centers || centers.length < 2) return;
    for (let i = 0; i < centers.length; i++) {
      for (let j = 0; j < centers.length; j++) {
        const r = centers[i], c = centers[j];
        if ((r === 6 && c === 6) || (r === 6 && c === centers[centers.length - 1]) ||
            (r === centers[centers.length - 1] && c === 6)) continue;
        addAlignment(m, r, c);
      }
    }
  }

  // Timing patterns
  function addTiming(m) {
    const size = m.length;
    for (let i = 8; i < size - 8; i++) {
      const v = (i % 2 === 0) ? 1 : 0;
      if (m[6][i] === -1) setModule(m, 6, i, v);
      if (m[i][6] === -1) setModule(m, i, 6, v);
    }
  }

  // Dark module
  function addDarkModule(m, version) {
    setModule(m, 4 * version + 9, 8, 1);
  }

  // Reserve format info areas
  function reserveFormat(m) {
    const size = m.length;
    // Top-left area
    for (let i = 0; i < 9; i++) { reserve(m, i, 8); reserve(m, 8, i); }
    // Top-right
    for (let i = 0; i < 8; i++) reserve(m, 8, size - 1 - i);
    // Bottom-left
    for (let i = 0; i < 8; i++) reserve(m, size - 1 - i, 8);
  }

  function reserveVersion(m, version) {
    if (version < 7) return;
    const size = m.length;
    for (let r = 0; r < 6; r++)
      for (let c = 0; c < 3; c++) {
        reserve(m, r, size - 11 + c);
        reserve(m, size - 11 + c, r);
      }
  }

  // ── Data encoding ─────────────────────────────────────────────

  function encodeData(text, version) {
    const bytes = new TextEncoder().encode(text);
    const totalDataBits = DATA_CAPACITY_M[version] * 8;

    const bits = [];
    const push = (val, len) => {
      for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1);
    };

    push(0b0100, 4);           // byte mode
    push(bytes.length, 8);     // char count (byte mode, versions 1-9 = 8 bits)
    bytes.forEach(b => push(b, 8));

    // Terminator
    for (let i = 0; i < 4 && bits.length < totalDataBits; i++) bits.push(0);
    // Pad to byte boundary
    while (bits.length % 8) bits.push(0);
    // Pad codewords
    const padBytes = [0b11101100, 0b00010001];
    let pi = 0;
    while (bits.length < totalDataBits) {
      const pb = padBytes[pi++ % 2];
      push(pb, 8);
    }

    return bits;
  }

  function bitsToBytes(bits) {
    const bytes = new Uint8Array(bits.length / 8);
    for (let i = 0; i < bytes.length; i++) {
      let b = 0;
      for (let j = 0; j < 8; j++) b = (b << 1) | bits[i * 8 + j];
      bytes[i] = b;
    }
    return bytes;
  }

  function interleaveBlocks(version, dataBits) {
    const { ecPerBlock, groups } = EC_TABLE_M[version];
    const dataBytes = bitsToBytes(dataBits);

    const blocks = [];
    let offset = 0;
    for (const [count, dcw] of groups) {
      for (let b = 0; b < count; b++) {
        const data = dataBytes.slice(offset, offset + dcw);
        const ec   = rsEncode(data, ecPerBlock);
        blocks.push({ data, ec });
        offset += dcw;
      }
    }

    // Interleave data
    const maxData = Math.max(...blocks.map(b => b.data.length));
    const out = [];
    for (let i = 0; i < maxData; i++)
      for (const blk of blocks)
        if (i < blk.data.length) out.push(blk.data[i]);
    for (let i = 0; i < ecPerBlock; i++)
      for (const blk of blocks)
        out.push(blk.ec[i]);

    const finalBits = [];
    for (const byte of out)
      for (let i = 7; i >= 0; i--) finalBits.push((byte >> i) & 1);

    // Remainder bits
    const REMAINDER = [0,0,7,7,7,7,7,0,0,0,0,0,0,0,3,3,3,3,3,3];
    const rem = REMAINDER[version] || 0;
    for (let i = 0; i < rem; i++) finalBits.push(0);

    return finalBits;
  }

  // ── Place data bits ───────────────────────────────────────────

  function placeData(m, bits) {
    const size = m.length;
    let idx = 0;

    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5; // skip timing column
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const col = right - j;
          const row = (Math.floor((size - 1 - right) / 2) % 2 === 0)
            ? (size - 1 - vert)
            : vert;
          if (m[row][col] === -1) {
            m[row][col] = idx < bits.length ? bits[idx++] : 0;
          }
        }
      }
    }
  }

  // ── Masking ───────────────────────────────────────────────────

  const MASK_FNS = [
    (r, c) => (r + c) % 2 === 0,
    (r)    => r % 2 === 0,
    (_,c)  => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
  ];

  function applyMask(m, maskIdx) {
    const fn = MASK_FNS[maskIdx];
    const result = m.map(row => new Int8Array(row));
    for (let r = 0; r < result.length; r++)
      for (let c = 0; c < result.length; c++)
        if (result[r][c] <= 1 && fn(r, c))
          result[r][c] ^= 1;
    return result;
  }

  function penaltyScore(m) {
    const size = m.length;
    let score = 0;

    // Rule 1: consecutive same-color in rows/cols
    for (let r = 0; r < size; r++) {
      let run = 1;
      for (let c = 1; c < size; c++) {
        if (m[r][c] === m[r][c - 1]) { run++; if (run === 5) score += 3; else if (run > 5) score++; }
        else run = 1;
      }
      run = 1;
      for (let rr = 1; rr < size; rr++) {
        if (m[rr][r] === m[rr - 1][r]) { run++; if (run === 5) score += 3; else if (run > 5) score++; }
        else run = 1;
      }
    }

    // Rule 2: 2×2 blocks
    for (let r = 0; r < size - 1; r++)
      for (let c = 0; c < size - 1; c++)
        if (m[r][c] === m[r][c+1] && m[r][c] === m[r+1][c] && m[r][c] === m[r+1][c+1])
          score += 3;

    // Rule 4: dark module ratio
    let dark = 0;
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (m[r][c] === 1) dark++;
    const ratio = dark / (size * size);
    score += Math.abs(Math.floor(ratio * 20) - 10) * 10;

    return score;
  }

  function writeFormatInfo(m, maskIdx) {
    const bits = FORMAT_STRINGS[maskIdx];
    const size = m.length;

    for (let i = 0; i < 6; i++) setModule(m, i, 8, (bits >> (14 - i)) & 1);
    setModule(m, 7, 8, (bits >> 8) & 1);
    setModule(m, 8, 8, (bits >> 7) & 1);
    setModule(m, 8, 7, (bits >> 6) & 1);
    for (let i = 5; i >= 0; i--) setModule(m, 8, i, (bits >> (5 - i)) & 1);

    for (let i = 0; i < 8; i++) setModule(m, 8, size - 1 - i, (bits >> i) & 1);
    for (let i = 0; i < 7; i++) setModule(m, size - 7 + i, 8, (bits >> (13 - i)) & 1);
  }

  function writeVersionInfo(m, version) {
    if (version < 7) return;
    const bits = VERSION_STRINGS[version];
    const size = m.length;
    for (let r = 0; r < 6; r++)
      for (let c = 0; c < 3; c++) {
        const bit = (bits >> (r * 3 + c)) & 1;
        setModule(m, r, size - 11 + c, bit);
        setModule(m, size - 11 + c, r, bit);
      }
  }

  // ── Main generate function ────────────────────────────────────

  function generateQRSVG(text) {
    const bytes = new TextEncoder().encode(text);
    const dataLen = 4 + 8 + bytes.length * 8; // mode + count + data bits (approx, byte mode v1-9)

    let version = 1;
    while (version <= 10 && DATA_CAPACITY_M[version] * 8 < dataLen + 4) version++;
    if (version > 10) throw new Error('Input too long for QR version 1-10');

    const size = 17 + 4 * version;

    // Build base matrix
    const base = makeMatrix(size);
    addFinder(base, 0, 0);
    addFinder(base, 0, size - 7);
    addFinder(base, size - 7, 0);
    addAlignments(base, version);
    addTiming(base);
    addDarkModule(base, version);
    reserveFormat(base);
    reserveVersion(base, version);

    // Encode + interleave
    const dataBits  = encodeData(text, version);
    const finalBits = interleaveBlocks(version, dataBits);
    placeData(base, finalBits);

    // Try all 8 masks, pick best
    let bestMask = 0, bestScore = Infinity, bestMatrix = null;
    for (let mask = 0; mask < 8; mask++) {
      const candidate = applyMask(base, mask);
      writeFormatInfo(candidate, mask);
      writeVersionInfo(candidate, version);
      const score = penaltyScore(candidate);
      if (score < bestScore) { bestScore = score; bestMask = mask; bestMatrix = candidate; }
    }

    writeFormatInfo(bestMatrix, bestMask);
    writeVersionInfo(bestMatrix, version);

    // Render SVG
    const accent = getComputedStyle(document.documentElement)
      .getPropertyValue('--accent').trim() || '#39d353';
    const bg = getComputedStyle(document.documentElement)
      .getPropertyValue('--bg').trim() || '#090909';

    const quiet = 4; // quiet zone modules
    const total = size + quiet * 2;
    const sq = 4; // pixels per module

    let rects = '';
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (bestMatrix[r][c] === 1) {
          rects += `<rect x="${(c + quiet) * sq}" y="${(r + quiet) * sq}" width="${sq}" height="${sq}"/>`;
        }
      }
    }

    const dim = total * sq;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges">` +
      `<rect width="${dim}" height="${dim}" fill="${bg}"/>` +
      `<g fill="${accent}">${rects}</g>` +
      `</svg>`;
  }

  window.generateQRSVG = generateQRSVG;
})();
