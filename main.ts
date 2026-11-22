// Tiny stack VM for make.fun's tiny-stack-vm-01 ISA (kit: ISA.md).
// One run answers a set: /input/<id>/program.bin + input.bin ->
// /output/<id>/stdout.bin + exit.txt. 32-bit wrapping ints, 256 stack, 64 call
// stack, 256 words memory, 1M steps, 65,536 output bytes, ten traps.
// Deterministic: no clock, no env beyond the kit's dir vars.
// Never removes the output dir itself.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const IN_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Per-opcode spec packed as (imm << 4) | (pops << 2) | pushes, plus 1,
// so 0 means "no such opcode".
const SPEC = new Uint8Array(256);
for (const [op, s] of [
  [0x00, 0x01], [0x01, 0x12], [0x02, 0x42], [0x03, 0x05], [0x04, 0x07],
  [0x05, 0x0b], [0x06, 0x0c], [0x07, 0x10], [0x10, 0x0a], [0x11, 0x0a],
  [0x12, 0x0a], [0x13, 0x0a], [0x14, 0x0a], [0x15, 0x0a], [0x16, 0x0a],
  [0x17, 0x06], [0x18, 0x0a], [0x19, 0x0a], [0x1a, 0x0a], [0x1b, 0x06],
  [0x1c, 0x0a], [0x1d, 0x0a], [0x1e, 0x0a], [0x20, 0x0a], [0x21, 0x0a],
  [0x22, 0x0a], [0x30, 0x21], [0x31, 0x25], [0x32, 0x25], [0x33, 0x21],
  [0x34, 0x01], [0x40, 0x06], [0x41, 0x09], [0x50, 0x05], [0x51, 0x05],
  [0x52, 0x02], [0x53, 0x05],
]) SPEC[op] = s;

// Runs one program on its input. Returns [stdout bytes, exit code].
function run(p, inp) {
  const n = p.length;
  const st = new Int32Array(256);
  let sp = 0;
  const cs = new Int32Array(64);
  let cp = 0;
  const mem = new Int32Array(256);
  const out = new Uint8Array(65536);
  const dig = new Uint8Array(12); // scratch for PRINT decimal digits
  let ol = 0, ip = 0, pc = 0, steps = 0;
  const end = (code) => [out.subarray(0, ol), code];
  for (;;) {
    // Trap order is the ISA's: step limit, pc range, unknown opcode,
    // cut-off immediate, then the step counts and the stack is checked.
    if (steps === 1000000) return end(10);
    if (pc < 0 || pc >= n) return end(9);
    const op = p[pc];
    const packed = SPEC[op];
    if (packed === 0) return end(5);
    const spec = packed - 1;
    const imm = spec >> 4, pops = (spec >> 2) & 3, pushes = spec & 3;
    if (pc + imm >= n) return end(9);
    steps++;
    const nx = pc + 1 + imm;
    if (sp < pops) return end(2);
    if (sp - pops + pushes > 256) return end(3);
    pc = nx;
    switch (op) {
      case 0x00: return end(0); // HALT
      case 0x01: st[sp++] = (p[nx - 1] << 24) >> 24; break; // PUSH8, sign-extended
      case 0x02: // PUSH32, little-endian
        st[sp++] = p[nx - 4] | (p[nx - 3] << 8) | (p[nx - 2] << 16) | (p[nx - 1] << 24);
        break;
      case 0x03: sp--; break; // POP
      case 0x04: st[sp] = st[sp - 1]; sp++; break; // DUP
      case 0x05: { const t = st[sp - 1]; st[sp - 1] = st[sp - 2]; st[sp - 2] = t; break; } // SWAP
      case 0x06: st[sp] = st[sp - 2]; sp++; break; // OVER
      case 0x07: { const a = st[sp - 3]; st[sp - 3] = st[sp - 2]; st[sp - 2] = st[sp - 1]; st[sp - 1] = a; break; } // ROT
      case 0x17: st[sp - 1] = -st[sp - 1] | 0; break; // NEG, wraps at INT_MIN
      case 0x1b: st[sp - 1] = ~st[sp - 1]; break; // NOT
      case 0x10: case 0x11: case 0x12: case 0x13: case 0x14: case 0x15: case 0x16:
      case 0x18: case 0x19: case 0x1a: case 0x1c: case 0x1d: case 0x1e:
      case 0x20: case 0x21: case 0x22: {
        const b = st[sp - 1], a = st[sp - 2];
        let r;
        if (op === 0x10) r = (a + b) | 0;
        else if (op === 0x11) r = (a - b) | 0;
        else if (op === 0x12) r = Math.imul(a, b);
        else if (op === 0x13) { if (b === 0) return end(4); r = (a / b) | 0; }
        else if (op === 0x14) { if (b === 0) return end(4); r = (a % b) | 0; }
        else if (op === 0x15) { if (b === 0) return end(4); r = Math.floor((a >>> 0) / (b >>> 0)) | 0; }
        else if (op === 0x16) { if (b === 0) return end(4); r = ((a >>> 0) % (b >>> 0)) | 0; }
        else if (op === 0x18) r = a & b;
        else if (op === 0x19) r = a | b;
        else if (op === 0x1a) r = a ^ b;
        else if (op === 0x1c) r = a << (b & 31);
        else if (op === 0x1d) r = a >> (b & 31);
        else if (op === 0x1e) r = (a >>> (b & 31)) | 0;
        else if (op === 0x20) r = a === b ? 1 : 0;
        else if (op === 0x21) r = a < b ? 1 : 0;
        else r = (a >>> 0) < (b >>> 0) ? 1 : 0; // LTU
        sp -= 2;
        st[sp++] = r;
        break;
      }
      case 0x30: case 0x31: case 0x32: { // JMP / JZ / JNZ, signed 16-bit offset
        const rel = ((p[nx - 2] | (p[nx - 1] << 8)) << 16) >> 16;
        if (op === 0x30) { pc = nx + rel; break; }
        const v = st[--sp];
        if ((op === 0x31) === (v === 0)) pc = nx + rel;
        break;
      }
      case 0x33: // CALL, unsigned target, 64 return addresses max
        if (cp === 64) return end(7);
        cs[cp++] = nx;
        pc = p[nx - 2] | (p[nx - 1] << 8);
        break;
      case 0x34: // RET
        if (cp === 0) return end(8);
        pc = cs[--cp];
        break;
      case 0x40: { // LOAD
        const a = st[sp - 1];
        if (a < 0 || a > 255) return end(6);
        st[sp - 1] = mem[a];
        break;
      }
      case 0x41: { // STORE: ( v addr -- )
        const a = st[sp - 1], v = st[sp - 2];
        if (a < 0 || a > 255) return end(6);
        sp -= 2;
        mem[a] = v;
        break;
      }
      case 0x50: { // PRINT: decimal ASCII, no newline; trap 11 writes nothing
        let v = st[sp - 1];
        const neg = v < 0;
        if (neg) v = -v; // -INT_MIN becomes 2147483648, exact in a double
        let e = 12;
        do { dig[--e] = 48 + (v % 10); v = (v / 10) | 0; } while (v > 0);
        if (neg) dig[--e] = 45;
        if (ol + (12 - e) > 65536) return end(11);
        sp--;
        out.set(dig.subarray(e, 12), ol);
        ol += 12 - e;
        break;
      }
      case 0x51: // PUTC
        if (ol + 1 > 65536) return end(11);
        out[ol++] = st[--sp] & 255;
        break;
      case 0x52: // IN: -1 once the input is used up
        st[sp++] = ip < inp.length ? inp[ip++] : -1;
        break;
      case 0x53: return end(st[--sp] & 255); // EXIT: low byte
    }
  }
}

for (const id of readdirSync(IN_DIR).sort()) {
  const dir = join(IN_DIR, id);
  const progPath = join(dir, 'program.bin');
  if (!existsSync(progPath)) continue;
  const prog = readFileSync(progPath);
  const inpPath = join(dir, 'input.bin');
  const inp = existsSync(inpPath) ? readFileSync(inpPath) : Buffer.alloc(0);
  const [stdout, exit] = run(prog, inp);
  const od = join(OUT_DIR, id);
  mkdirSync(od, { recursive: true }); // never removes the output dir itself
  writeFileSync(join(od, 'stdout.bin'), stdout);
  writeFileSync(join(od, 'exit.txt'), String(exit) + '\n');
}
