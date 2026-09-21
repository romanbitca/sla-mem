/**
 * Tiny but valid binary payloads for synthetic Slack data (demo export, mock Slack file host):
 * procedurally drawn PNGs and a one-page PDF. No image libraries needed.
 */
import zlib from 'node:zlib';

export type Paint = 'mockup' | 'chart' | 'sunset' | 'screenshot' | 'logo';

export type Rgb = [number, number, number];
export type Painter = (x: number, y: number, w: number, h: number) => Rgb;

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t)) as Rgb;
const inRect = (x: number, y: number, x0: number, y0: number, x1: number, y1: number) =>
  x >= x0 && x < x1 && y >= y0 && y < y1;

export const PAINTERS: Record<Paint, Painter> = {
  mockup(x, y, w) {
    if (y < 44) return inRect(x, y, 16, 14, 110, 30) ? [255, 255, 255] : [79, 70, 229];
    if (x < 150) return y >= 64 && (y - 64) % 36 < 20 && x >= 16 && x < 130 ? [209, 213, 219] : [243, 244, 246];
    const cardW = Math.floor((w - 190) / 3);
    for (let i = 0; i < 3; i++) {
      const cx = 170 + i * (cardW + 10);
      if (inRect(x, y, cx, 70, cx + cardW, 200))
        return inRect(x, y, cx + 12, 84, cx + cardW - 30, 96) ? [156, 163, 175] : [255, 255, 255];
    }
    if (inRect(x, y, 170, 230, w - 20, 360)) {
      const bar = Math.floor((x - 180) / 36);
      const top = 350 - ((bar * 37) % 90) - 20;
      return (x - 180) % 36 < 24 && y > top && x >= 180 ? [99, 102, 241] : [255, 255, 255];
    }
    return inRect(x, y, w - 150, 372, w - 20, 396) ? [79, 70, 229] : [249, 250, 251];
  },
  chart(x, y, _w, h) {
    const col = Math.floor(x / 12);
    const spike = Math.max(0, 1 - Math.abs(col - 24) / 6);
    const value = 0.18 + 0.05 * Math.sin(col * 1.7) + spike * 0.65;
    if (x % 12 < 9 && y > h - 20 - value * (h - 40)) return spike > 0.2 ? [220, 38, 38] : [37, 99, 235];
    return y % 50 === 0 || x % 100 === 0 ? [229, 231, 235] : [255, 255, 255];
  },
  sunset(x, y, w, h) {
    const horizon = h * 0.62 + Math.sin(x / 40) * 18 + Math.sin(x / 13) * 6;
    if (y > horizon) return mix([49, 46, 129], [17, 24, 39], (y - horizon) / (h - horizon + 1));
    const dx = x - w * 0.62;
    const dy = y - h * 0.55;
    if (dx * dx + dy * dy < 42 * 42) return [253, 224, 71];
    return mix([251, 146, 60], [190, 24, 93], y / h);
  },
  screenshot(x, y, w) {
    if (y < 28) {
      for (const [i, c] of [
        [0, [239, 68, 68]],
        [1, [234, 179, 8]],
        [2, [34, 197, 94]],
      ] as [number, Rgb][]) {
        const dx = x - (18 + i * 20);
        const dy = y - 14;
        if (dx * dx + dy * dy < 36) return c;
      }
      return [229, 231, 235];
    }
    const line = Math.floor((y - 48) / 22);
    const width = w - 80 - ((line * 97) % 260);
    if (y >= 48 && (y - 48) % 22 < 10 && x > 40 && x < width) return line === 4 ? [248, 113, 113] : [203, 213, 225];
    return [255, 255, 255];
  },
  logo(x, y, w, h) {
    const cx = x < w / 2 ? w / 4 : (3 * w) / 4;
    const cy = y < h / 2 ? h / 4 : (3 * h) / 4;
    const quadrant = (x < w / 2 ? 0 : 1) + (y < h / 2 ? 0 : 2);
    const colors: Rgb[] = [
      [79, 70, 229],
      [13, 148, 136],
      [234, 88, 12],
      [219, 39, 119],
    ];
    const d = Math.hypot(x - cx, y - cy);
    if (d < 70) return mix(colors[quadrant], [255, 255, 255], d < 30 ? 0.85 : d / 140);
    return [250, 250, 249];
  },
};

export function makePng(w: number, h: number, paint: Painter): Buffer {
  const stride = w * 3 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const [r, g, b] = paint(x, y, w, h);
      raw.set([r, g, b], y * stride + 1 + x * 3);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit RGB, deflate, no filter method, no interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

/** A one-page PDF 1.4 with Helvetica text and a correct xref table. */
export function makePdf(lines: string[]): Buffer {
  const esc = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  const text = ['BT', '/F1 20 Tf', '72 720 Td', `(${esc(lines[0])}) Tj`, '/F1 12 Tf'];
  for (const line of lines.slice(1)) text.push('0 -24 Td', `(${esc(line)}) Tj`);
  text.push('ET');
  const content = text.join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}
