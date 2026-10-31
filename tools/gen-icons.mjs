/**
 * 生成扩展图标（16/32/48/128）。
 * 纯 Node 实现，不依赖任何图形库：超采样抗锯齿 + 手写 PNG 编码。
 * 图形与 sidepanel 品牌栏一致：深青渐变圆角方块 + 白色波形折线。
 *
 * 用法：node tools/gen-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'extension', 'icons');

/* ---------- 几何参数（归一化到 0..1） ---------- */
const RADIUS = 0.22;
// 波形折线，与 SVG 的 viewBox 0 0 24 24 同源
const WAVE_FULL = [[3, 12], [7, 12], [9.5, 5], [13, 19], [15.5, 12], [21, 12]]
  .map(([x, y]) => [x / 24, y / 24]);
// 小尺寸（16/32）用简化波形：去掉两个短横段、加大振幅，否则会糊成一团白
const WAVE_SMALL = [[3.5, 14.5], [9, 7], [14, 17.5], [20.5, 8.5]]
  .map(([x, y]) => [x / 24, y / 24]);

const GRAD_FROM = [0x24, 0x84, 0x7b]; // 亮端
const GRAD_TO = [0x0b, 0x38, 0x36]; // 暗端

/* ---------- 距离场 ---------- */
function roundRectSDF(px, py) {
  // 以中心为原点，半宽 0.5
  const hw = 0.5 - RADIUS;
  const qx = Math.abs(px - 0.5) - hw;
  const qy = Math.abs(py - 0.5) - hw;
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - RADIUS;
}

function segDist(px, py, [x1, y1], [x2, y2]) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function waveDist(px, py, wave) {
  let d = Infinity;
  for (let i = 0; i < wave.length - 1; i++) {
    d = Math.min(d, segDist(px, py, wave[i], wave[i + 1]));
  }
  return d;
}

/* ---------- 渲染 ---------- */
function render(size) {
  const SS = size < 48 ? 8 : 4; // 超采样倍数，小尺寸加倍
  const small = size < 48;
  const wave = small ? WAVE_SMALL : WAVE_FULL;
  // 小尺寸线宽按像素定，避免抗锯齿把细线洗掉
  const stroke = (small ? Math.max(2.1, size * 0.08) : Math.max(2.6, size * 0.075)) / size;
  const half = stroke / 2;

  const rgba = Buffer.alloc(size * size * 4);
  const samples = SS * SS;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let inShape = 0;
      let r = 0, g = 0, b = 0;

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = (x + (sx + 0.5) / SS) / size;
          const py = (y + (sy + 0.5) / SS) / size;

          if (roundRectSDF(px, py) > 0) continue; // 形状外
          inShape++;

          if (waveDist(px, py, wave) <= half) {
            r += 255; g += 255; b += 255; // 白色波形
          } else {
            // 沿对角线插值出渐变
            const t = Math.max(0, Math.min(1, (px + py) / 2));
            r += GRAD_FROM[0] + (GRAD_TO[0] - GRAD_FROM[0]) * t;
            g += GRAD_FROM[1] + (GRAD_TO[1] - GRAD_FROM[1]) * t;
            b += GRAD_FROM[2] + (GRAD_TO[2] - GRAD_FROM[2]) * t;
          }
        }
      }

      const i = (y * size + x) * 4;
      if (inShape === 0) {
        rgba[i] = rgba[i + 1] = rgba[i + 2] = rgba[i + 3] = 0;
      } else {
        rgba[i] = Math.round(r / inShape);
        rgba[i + 1] = Math.round(g / inShape);
        rgba[i + 2] = Math.round(b / inShape);
        rgba[i + 3] = Math.round((inShape / samples) * 255);
      }
    }
  }
  return rgba;
}

/* ---------- PNG 编码 ---------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  // 每行前加一个 filter byte（0 = None）
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------- 执行 ---------- */
mkdirSync(OUT, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const png = encodePNG(size, render(size));
  const file = join(OUT, `icon${size}.png`);
  writeFileSync(file, png);
  console.log(`icon${size}.png  ${png.length} bytes`);
}
console.log('done →', OUT);
