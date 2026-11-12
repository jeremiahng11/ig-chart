'use strict';

// Pure-JavaScript decoder for the LZMA "alone" (.lzma) container used by
// Dukascopy .bi5 files. Follows the reference LzmaSpec decoder.

const kNumBitModelTotalBits = 11;
const kBitModelTotal = 1 << kNumBitModelTotalBits;
const kNumMoveBits = 5;
const PROB_INIT = kBitModelTotal >>> 1;
const kTopValue = 1 << 24;

const kNumPosBitsMax = 4;
const kNumStates = 12;
const kNumLenToPosStates = 4;
const kNumAlignBits = 4;
const kStartPosModelIndex = 4;
const kEndPosModelIndex = 14;
const kNumFullDistances = 1 << (kEndPosModelIndex >>> 1);
const kMatchMinLen = 2;

class LzmaError extends Error {}

class RangeDecoder {
  constructor(buf, pos) {
    this.buf = buf;
    this.pos = pos;
    this.range = 0xffffffff;
    this.code = 0;
    this.overrun = 0;
    if (this.byte() !== 0) throw new LzmaError('corrupted range coder header');
    for (let i = 0; i < 4; i++) this.code = ((this.code << 8) | this.byte()) >>> 0;
    if (this.code === this.range) throw new LzmaError('corrupted range coder header');
  }

  byte() {
    if (this.pos < this.buf.length) return this.buf[this.pos++];
    this.overrun++;
    return 0;
  }

  normalize() {
    if (this.range < kTopValue) {
      this.range = (this.range << 8) >>> 0;
      this.code = ((this.code << 8) | this.byte()) >>> 0;
    }
  }

  finishedOk() {
    return this.code === 0;
  }

  directBits(numBits) {
    let res = 0;
    do {
      this.range >>>= 1;
      this.code = (this.code - this.range) >>> 0;
      const t = 0 - (this.code >>> 31);
      this.code = (this.code + (this.range & t)) >>> 0;
      if (this.code === this.range) throw new LzmaError('corrupted direct bits');
      this.normalize();
      res = ((res << 1) + t + 1) >>> 0;
    } while (--numBits);
    return res;
  }

  bit(probs, i) {
    const v = probs[i];
    const bound = (this.range >>> kNumBitModelTotalBits) * v;
    let symbol;
    if (this.code < bound) {
      probs[i] = v + ((kBitModelTotal - v) >>> kNumMoveBits);
      this.range = bound;
      symbol = 0;
    } else {
      probs[i] = v - (v >>> kNumMoveBits);
      this.code = (this.code - bound) >>> 0;
      this.range = (this.range - bound) >>> 0;
      symbol = 1;
    }
    this.normalize();
    return symbol;
  }
}

function probs(n) {
  return new Uint16Array(n).fill(PROB_INIT);
}

function bitTree(rc, p, offset, numBits) {
  let m = 1;
  for (let i = 0; i < numBits; i++) m = (m << 1) + rc.bit(p, offset + m);
  return m - (1 << numBits);
}

function bitTreeReverse(rc, p, offset, numBits) {
  let m = 1;
  let symbol = 0;
  for (let i = 0; i < numBits; i++) {
    const bit = rc.bit(p, offset + m);
    m = (m << 1) + bit;
    symbol |= bit << i;
  }
  return symbol;
}

class LenDecoder {
  constructor() {
    this.choice = probs(2);
    this.low = probs((1 << kNumPosBitsMax) * 8);
    this.mid = probs((1 << kNumPosBitsMax) * 8);
    this.high = probs(256);
  }

  decode(rc, posState) {
    if (rc.bit(this.choice, 0) === 0) return bitTree(rc, this.low, posState << 3, 3);
    if (rc.bit(this.choice, 1) === 0) return 8 + bitTree(rc, this.mid, posState << 3, 3);
    return 16 + bitTree(rc, this.high, 0, 8);
  }
}

function decompress(input) {
  if (!Buffer.isBuffer(input)) input = Buffer.from(input);
  if (input.length < 13) throw new LzmaError('input too short for LZMA header');

  let d = input[0];
  if (d >= 9 * 5 * 5) throw new LzmaError('invalid LZMA properties byte');
  const lc = d % 9;
  d = (d / 9) | 0;
  const lp = d % 5;
  const pb = (d / 5) | 0;

  let dictSize = input.readUInt32LE(1);
  if (dictSize < 4096) dictSize = 4096;

  const sizeLo = input.readUInt32LE(5);
  const sizeHi = input.readUInt32LE(9);
  const unpackSizeDefined = !(sizeLo === 0xffffffff && sizeHi === 0xffffffff);
  let unpackSize = -1;
  if (unpackSizeDefined) {
    unpackSize = sizeHi * 0x100000000 + sizeLo;
    if (unpackSize > 0x7fffffff) throw new LzmaError('declared uncompressed size too large');
  }

  // Output buffer doubles as the dictionary (whole output is retained).
  let outCap = unpackSizeDefined ? unpackSize : Math.max(65536, input.length * 4);
  let out = Buffer.allocUnsafe(Math.max(outCap, 1));
  let outPos = 0;

  const ensure = (n) => {
    if (outPos + n <= out.length) return;
    let cap = out.length * 2;
    while (cap < outPos + n) cap *= 2;
    const next = Buffer.allocUnsafe(cap);
    out.copy(next, 0, 0, outPos);
    out = next;
  };

  if (unpackSizeDefined && unpackSize === 0) {
    // Encoders may still emit an end marker; nothing to decode either way.
    return Buffer.alloc(0);
  }

  const rc = new RangeDecoder(input, 13);

  const literalProbs = probs(0x300 << (lc + lp));
  const posSlot = probs(kNumLenToPosStates << 6);
  const posDecoders = probs(1 + kNumFullDistances - kEndPosModelIndex);
  const alignDecoder = probs(1 << kNumAlignBits);
  const isMatch = probs(kNumStates << kNumPosBitsMax);
  const isRep = probs(kNumStates);
  const isRepG0 = probs(kNumStates);
  const isRepG1 = probs(kNumStates);
  const isRepG2 = probs(kNumStates);
  const isRep0Long = probs(kNumStates << kNumPosBitsMax);
  const lenDecoder = new LenDecoder();
  const repLenDecoder = new LenDecoder();

  const pbMask = (1 << pb) - 1;
  const lpMask = (1 << lp) - 1;

  let rep0 = 0;
  let rep1 = 0;
  let rep2 = 0;
  let rep3 = 0;
  let state = 0;
  let markerFound = false;

  const decodeDistance = (len) => {
    let lenState = len;
    if (lenState > kNumLenToPosStates - 1) lenState = kNumLenToPosStates - 1;
    const slot = bitTree(rc, posSlot, lenState << 6, 6);
    if (slot < 4) return slot;
    const numDirectBits = (slot >>> 1) - 1;
    let dist = ((2 | (slot & 1)) << numDirectBits) >>> 0;
    if (slot < kEndPosModelIndex) {
      dist = (dist + bitTreeReverse(rc, posDecoders, dist - slot, numDirectBits)) >>> 0;
    } else {
      dist = (dist + ((rc.directBits(numDirectBits - kNumAlignBits) << kNumAlignBits) >>> 0)) >>> 0;
      dist = (dist + bitTreeReverse(rc, alignDecoder, 0, kNumAlignBits)) >>> 0;
    }
    return dist;
  };

  for (;;) {
    if (unpackSizeDefined && outPos >= unpackSize) break;
    if (!unpackSizeDefined && rc.overrun > 4) {
      throw new LzmaError('unexpected end of input');
    }

    const posState = outPos & pbMask;

    if (rc.bit(isMatch, (state << kNumPosBitsMax) + posState) === 0) {
      const prevByte = outPos > 0 ? out[outPos - 1] : 0;
      const litState = ((outPos & lpMask) << lc) + (prevByte >>> (8 - lc));
      const base = 0x300 * litState;
      let symbol = 1;
      if (state >= 7) {
        if (rep0 >= outPos) throw new LzmaError('match distance beyond output');
        let matchByte = out[outPos - rep0 - 1];
        do {
          const matchBit = (matchByte >>> 7) & 1;
          matchByte <<= 1;
          const bit = rc.bit(literalProbs, base + ((1 + matchBit) << 8) + symbol);
          symbol = (symbol << 1) | bit;
          if (matchBit !== bit) break;
        } while (symbol < 0x100);
      }
      while (symbol < 0x100) symbol = (symbol << 1) | rc.bit(literalProbs, base + symbol);
      ensure(1);
      out[outPos++] = symbol - 0x100;
      state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
      continue;
    }

    let len;
    if (rc.bit(isRep, state) !== 0) {
      if (outPos === 0) throw new LzmaError('rep match at stream start');
      if (rc.bit(isRepG0, state) === 0) {
        if (rc.bit(isRep0Long, (state << kNumPosBitsMax) + posState) === 0) {
          state = state < 7 ? 9 : 11;
          ensure(1);
          out[outPos] = out[outPos - rep0 - 1];
          outPos++;
          continue;
        }
      } else {
        let dist;
        if (rc.bit(isRepG1, state) === 0) {
          dist = rep1;
        } else {
          if (rc.bit(isRepG2, state) === 0) {
            dist = rep2;
          } else {
            dist = rep3;
            rep3 = rep2;
          }
          rep2 = rep1;
        }
        rep1 = rep0;
        rep0 = dist;
      }
      len = repLenDecoder.decode(rc, posState);
      state = state < 7 ? 8 : 11;
    } else {
      rep3 = rep2;
      rep2 = rep1;
      rep1 = rep0;
      len = lenDecoder.decode(rc, posState);
      state = state < 7 ? 7 : 10;
      rep0 = decodeDistance(len);
      if (rep0 === 0xffffffff) {
        markerFound = true;
        break;
      }
      if (rep0 >= dictSize || rep0 >= outPos) throw new LzmaError('match distance beyond dictionary');
    }

    len += kMatchMinLen;
    if (unpackSizeDefined && unpackSize - outPos < len) {
      throw new LzmaError('match exceeds declared uncompressed size');
    }
    ensure(len);
    let src = outPos - rep0 - 1;
    for (let i = 0; i < len; i++) out[outPos++] = out[src++];
  }

  if (markerFound && !rc.finishedOk()) throw new LzmaError('data after end marker is corrupted');
  if (rc.overrun > 0 && !markerFound) {
    // Range decoder consumed past the input end: tolerated only for the final
    // normalization byte reads, never if output is short of its declared size.
    if (unpackSizeDefined && outPos < unpackSize) throw new LzmaError('unexpected end of input');
  }
  if (unpackSizeDefined && outPos !== unpackSize) throw new LzmaError('output size mismatch');

  return out.subarray(0, outPos);
}

module.exports = { decompress, LzmaError };
