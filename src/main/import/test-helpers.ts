/** Shared helpers for the import tests (not a test file itself). */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

export const FIXTURE_DIR = fileURLToPath(new URL('../../../test/fixtures/export-basic', import.meta.url));

export interface ZipInput {
  /** Entry name as stored in the archive; '/'-terminated names are directories. */
  name: string;
  data?: Buffer | string;
}

/**
 * Minimal zip writer (no zip64, no encryption) so tests can build archives, including hostile
 * ones like `../evil.json`, without depending on a `zip` binary being installed.
 */
export function buildZip(inputs: readonly ZipInput[], opts: { deflate?: boolean } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const input of inputs) {
    const name = Buffer.from(input.name, 'utf8');
    const isDir = input.name.endsWith('/');
    const raw = isDir ? Buffer.alloc(0) : Buffer.from(input.data ?? '');
    const method = opts.deflate && !isDir ? 8 : 0;
    const body = method === 8 ? zlib.deflateRawSync(raw) : raw;
    const crc = zlib.crc32(raw);
    const common = { method, crc, compressed: body.length, size: raw.length, nameLength: name.length };
    const local = Buffer.concat([localHeader(common), name, body]);
    centrals.push(Buffer.concat([centralHeader(common, offset, isDir), name]));
    locals.push(local);
    offset += local.length;
  }
  const central = Buffer.concat(centrals);
  return Buffer.concat([...locals, central, endOfCentralDirectory(inputs.length, central.length, offset)]);
}

interface HeaderFields {
  method: number;
  crc: number;
  compressed: number;
  size: number;
  nameLength: number;
}

const UTF8_FLAG = 0x0800;
const DOS_TIME = 0; // 00:00:00
const DOS_DATE = ((2024 - 1980) << 9) | (3 << 5) | 1; // 2024-03-01

function localHeader(h: HeaderFields): Buffer {
  const b = Buffer.alloc(30);
  b.writeUInt32LE(0x04034b50, 0);
  b.writeUInt16LE(20, 4);
  b.writeUInt16LE(UTF8_FLAG, 6);
  b.writeUInt16LE(h.method, 8);
  b.writeUInt16LE(DOS_TIME, 10);
  b.writeUInt16LE(DOS_DATE, 12);
  b.writeUInt32LE(h.crc, 14);
  b.writeUInt32LE(h.compressed, 18);
  b.writeUInt32LE(h.size, 22);
  b.writeUInt16LE(h.nameLength, 26);
  b.writeUInt16LE(0, 28);
  return b;
}

function centralHeader(h: HeaderFields, localOffset: number, isDir: boolean): Buffer {
  const b = Buffer.alloc(46);
  b.writeUInt32LE(0x02014b50, 0);
  b.writeUInt16LE(20, 4);
  b.writeUInt16LE(20, 6);
  b.writeUInt16LE(UTF8_FLAG, 8);
  b.writeUInt16LE(h.method, 10);
  b.writeUInt16LE(DOS_TIME, 12);
  b.writeUInt16LE(DOS_DATE, 14);
  b.writeUInt32LE(h.crc, 16);
  b.writeUInt32LE(h.compressed, 20);
  b.writeUInt32LE(h.size, 24);
  b.writeUInt16LE(h.nameLength, 28);
  b.writeUInt16LE(0, 30); // extra length
  b.writeUInt16LE(0, 32); // comment length
  b.writeUInt16LE(0, 34); // disk number
  b.writeUInt16LE(0, 36); // internal attributes
  b.writeUInt32LE(isDir ? 0x10 : 0, 38); // MS-DOS directory attribute
  b.writeUInt32LE(localOffset, 42);
  return b;
}

function endOfCentralDirectory(count: number, size: number, offset: number): Buffer {
  const b = Buffer.alloc(22);
  b.writeUInt32LE(0x06054b50, 0);
  b.writeUInt16LE(0, 4);
  b.writeUInt16LE(0, 6);
  b.writeUInt16LE(count, 8);
  b.writeUInt16LE(count, 10);
  b.writeUInt32LE(size, 12);
  b.writeUInt32LE(offset, 16);
  b.writeUInt16LE(0, 20);
  return b;
}

/** Every regular file under `dir` as zip inputs, names prefixed with `prefix` (e.g. 'wrap/'). */
export function zipInputsFromDir(dir: string, prefix = ''): ZipInput[] {
  const out: ZipInput[] = [];
  const walk = (rel: string): void => {
    for (const d of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) {
        out.push({ name: `${prefix}${childRel}/` });
        walk(childRel);
      } else if (d.isFile()) {
        out.push({ name: `${prefix}${childRel}`, data: fs.readFileSync(path.join(dir, childRel)) });
      }
    }
  };
  walk('');
  return out;
}

/** A fresh temp directory; register it with `cleanup` to delete it after the test. */
export function tempDir(prefix = 'slack-archive-import-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Copy of the fixture export that a test may modify freely. */
export function copyFixture(dest: string): string {
  fs.cpSync(FIXTURE_DIR, dest, { recursive: true });
  return dest;
}

export function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

export function writeJson(file: string, value: unknown): void {
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}
