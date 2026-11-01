/**
 * 生成应用图标：扩展 16/32/48/128、桌面 512、Windows .ico、以及 docs/app-icon.svg。
 * 纯 Node 实现，不依赖任何图形库：解析式抗锯齿 + 手写 PNG / ICO / SVG 编码。
 *
 * 构图（相对上一版的改动）：
 *   上一版是「青色渐变圆角块 + 一条白色对称折线」。折线波形在小尺寸任务栏 / 标签栏上
 *   和音频、心率、播客一类图标高度撞脸 —— 撞脸在小尺寸上最致命，因为那时只剩轮廓。
 *   这一版把名字拆开画：surf 是浪（陡起、缓落、不对称），shadow 是浪影（两重按笔画宽度
 *   等距后退的拖影，越远越细越淡，且沿弧长衰减到消失）。
 *
 *   两条从渲染结果里改出来的约束，别凭直觉改回去：
 *   1) 峰顶必须给够控制点。少给两个点，Catmull-Rom 在峰顶会折出三角尖角，整枚图标就变成
 *      「心电图」而不是「浪」。见 CREST_FULL 里 0.385/0.425/0.470 三个点。
 *   2) 拖影必须在弧长上衰减（alpha 沿路径滑向 0），不能整条等权复制。等权复制时最远那条
 *      的右端会戳到方块右下角，脱离主体变成一块孤立色块 —— 那是缺陷，不是拖尾。
 *
 * 抗锯齿用距离场解析覆盖率（clamp(0.5 + h - d)），不超采样：一次求值 / 像素，
 * 512 也在亚秒级出图，边缘比 4×4 超采样更平滑。
 *
 * 用法：node tools/gen-icons.mjs [--sheet <out.png>]
 *   --sheet 额外输出一张各尺寸对照表（浅底 + 深底两行），用来肉眼验收小尺寸有没有糊。
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXT_OUT = join(ROOT, 'extension', 'icons');
const BUILD_OUT = join(ROOT, 'build');
const DOCS_OUT = join(ROOT, 'docs');

/* ---------- 几何参数（归一化到 0..1，y 向下） ---------- */
const RADIUS = 0.235;
const WATER = 0.605; // 水位线：浪长在它上方，倒影从它往下
const REFL_SQUASH = 0.62; // 倒影竖向压缩，真倒影也是压扁的
const REFL_SPAN = 0.28; // 倒影向下渐隐的长度

// 大尺寸浪形：左侧陡、右侧缓，峰顶圆。刻意不对称 —— 对称波形就是撞脸的根源。
// 试过在峰顶加一段横向「唇」，结果 Catmull-Rom 把它画成台阶，整枚图标读成「台地」，
// 已回退。峰顶想更圆就给控制点，不要加平台。
const CREST_FULL = [
  [0.06, 0.615],
  [0.16, 0.6],
  [0.24, 0.545],
  [0.3, 0.45],
  [0.345, 0.35],
  [0.39, 0.285],
  [0.44, 0.265], // 峰
  [0.49, 0.3],
  [0.525, 0.39],
  [0.55, 0.49],
  [0.585, 0.565],
  [0.63, 0.6], // 谷，正好落在水位线上
  [0.7, 0.605],
  [0.78, 0.575],
  [0.86, 0.525]
];

// 小尺寸（16/32）：砍掉拐点，只留「陡起—峰—缓落」。点多于 8 个时 16px 上会抖成锯齿。
const CREST_SMALL = [
  [0.06, 0.615],
  [0.24, 0.56],
  [0.4, 0.28],
  [0.5, 0.3],
  [0.6, 0.58],
  [0.8, 0.605],
  [0.92, 0.53]
];

const BG_TOP = [0x0f, 0x5b, 0x53];
const BG_BOTTOM = [0x03, 0x18, 0x17];
const INK = [0xf0, 0xff, 0xfa]; // 前景浪

/* ---------- 工具 ---------- */
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth01 = (v) => {
  const t = clamp01(v);
  return t * t * (3 - 2 * t);
};
const to255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

/* ---------- 距离场 ---------- */
function roundRectSDF(px, py) {
  const hw = 0.5 - RADIUS;
  const qx = Math.abs(px - 0.5) - hw;
  const qy = Math.abs(py - 0.5) - hw;
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - RADIUS;
}

function segDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/* ---------- Catmull-Rom 采样成密折线（光栅用） ---------- */
function catmullRom(pts, perSeg) {
  const p = [pts[0], ...pts, pts[pts.length - 1]];
  const out = [];
  for (let i = 0; i < p.length - 3; i++) {
    const [x0, y0] = p[i];
    const [x1, y1] = p[i + 1];
    const [x2, y2] = p[i + 2];
    const [x3, y3] = p[i + 3];
    for (let s = 0; s < perSeg; s++) {
      const t = s / perSeg;
      out.push([cr(x0, x1, x2, x3, t), cr(y0, y1, y2, y3, t)]);
    }
  }
  out.push(p[p.length - 2]);
  return out;
}

function cr(a, b, c, d, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3)
  );
}

/* ---------- 图层栈 ---------- */
// 把折线转成线段数组，每段带归一化半宽 h
function toSegs(pts, h) {
  const segs = [];
  for (let i = 0; i < pts.length - 1; i++) {
    segs.push({ x1: pts[i][0], y1: pts[i][1], x2: pts[i + 1][0], y2: pts[i + 1][1], h });
  }
  return segs;
}

function bboxOf(pts, h) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of pts) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return [x0 - h, y0 - h, x1 + h, y1 + h];
}

// 倒影：关于水位线垂直镜像 + 竖向压缩，向下渐隐到 0
function reflect(pts) {
  return pts.map(([x, y]) => [x, WATER + (WATER - y) * REFL_SQUASH]);
}

function buildLayers(size) {
  const small = size < 48;
  const control = small ? CREST_SMALL : CREST_FULL;
  const dense = catmullRom(control, small ? 7 : 9);
  const wPx = small ? (size <= 16 ? 2.0 : 3.2) : Math.max(3.4, size * 0.075);
  const h = wPx / 2 / size;

  const main = {
    segs: toSegs(dense, h),
    halfPx: wPx / 2,
    color: INK,
    alpha: 1,
    glow: !small,
    fade: null,
    bbox: bboxOf(dense, h)
  };

  // 16px 不画倒影：浪本身只有 2px，倒影贴着浪底起，两者会糊成一团灰。
  // 这是唯一一处按尺寸删元素的地方，删的理由是实测出来的，不是"小尺寸看着复杂"。
  if (size <= 16) return [main];

  // 倒影比浪细一档：真倒影对比度更低，细一点也正好避免和浪底粘连
  const reflPts = reflect(dense);
  return [
    {
      segs: toSegs(reflPts, h * 0.85),
      color: INK,
      alpha: small ? 0.4 : 0.42,
      glow: false,
      fade: (py) => clamp01(1 - (py - WATER) / REFL_SPAN),
      bbox: bboxOf(reflPts, h * 0.85)
    },
    main
  ];
}

// 返回覆盖率。各段覆盖率取最大近似并集 —— 半宽恒定时它等价于 1 - 最近距离，不会出接缝。
function strokeAt(px, py, segs, size) {
  let cov = 0;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const d = segDist(px, py, s.x1, s.y1, s.x2, s.y2);
    const v = (s.h - d) * size + 0.5;
    if (v > cov) {
      cov = v;
      if (cov >= 1) return 1;
    }
  }
  return clamp01(cov);
}

/* ---------- 渲染 ---------- */
function render(size) {
  const layers = buildLayers(size);
  const rgba = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = (x + 0.5) / size;
      const py = (y + 0.5) / size;
      const sdf = roundRectSDF(px, py);
      const cov = clamp01(0.5 - sdf * size);
      if (cov <= 0) continue; // Buffer 已全 0，直接跳过

      // 竖向渐变
      const t = smooth01(py);
      let r = BG_TOP[0] + (BG_BOTTOM[0] - BG_TOP[0]) * t;
      let gr = BG_TOP[1] + (BG_BOTTOM[1] - BG_TOP[1]) * t;
      let bl = BG_TOP[2] + (BG_BOTTOM[2] - BG_TOP[2]) * t;

      // 左上柔光，给平面色块一点体积
      const hx = px - 0.26;
      const hy = py - 0.2;
      const hl = Math.exp(-(hx * hx + hy * hy) / (2 * 0.3 * 0.3)) * 0.22;
      r += 30 * hl;
      gr += 104 * hl;
      bl += 96 * hl;

      // 内缘压暗，避免在浅色桌面上边缘发虚
      const v = 0.84 + 0.16 * clamp01(-sdf / 0.1);
      r *= v;
      gr *= v;
      bl *= v;

      for (let i = 0; i < layers.length; i++) {
        const L = layers[i];
        const bb = L.bbox;
        if (px < bb[0] || px > bb[2] || py < bb[1] || py > bb[3]) continue;

        if (L.glow) {
          let dmin = Infinity;
          for (const s of L.segs) {
            const d = segDist(px, py, s.x1, s.y1, s.x2, s.y2);
            if (d < dmin) dmin = d;
          }
          const g = clamp01(1 - (dmin * size) / (L.halfPx * 2.2));
          if (g > 0) {
            const k = 0.13 * g * g;
            r += INK[0] * k;
            gr += INK[1] * k;
            bl += INK[2] * k;
          }
        }

        const c = strokeAt(px, py, L.segs, size);
        const a = c * L.alpha * (L.fade ? L.fade(py) : 1);
        if (a > 0) {
          r += (L.color[0] - r) * a;
          gr += (L.color[1] - gr) * a;
          bl += (L.color[2] - bl) * a;
        }
      }

      const o = (y * size + x) * 4;
      rgba[o] = to255(r);
      rgba[o + 1] = to255(gr);
      rgba[o + 2] = to255(bl);
      rgba[o + 3] = Math.round(cov * 255);
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

function encodePNG(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: None
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ---------- ICO 编码（PNG-in-ICO，Vista+ 支持） ---------- */
function encodeICO(entries) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0); // reserved
  head.writeUInt16LE(1, 2); // type: icon
  head.writeUInt16LE(entries.length, 4);

  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + dir.length;
  entries.forEach((e, i) => {
    const o = i * 16;
    dir[o] = e.size >= 256 ? 0 : e.size; // 256 用 0 表示
    dir[o + 1] = e.size >= 256 ? 0 : e.size;
    dir[o + 2] = 0; // 调色板色数
    dir[o + 3] = 0; // reserved
    dir.writeUInt16LE(1, o + 4); // planes
    dir.writeUInt16LE(32, o + 6); // bit depth
    dir.writeUInt32LE(e.png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += e.png.length;
  });

  return Buffer.concat([head, dir, ...entries.map((e) => e.png)]);
}

/* ---------- SVG（同一组控制点，Catmull-Rom → 三次贝塞尔） ---------- */
const V = 512;
const fx = (n) => Math.round(n * V * 10) / 10;
const hex = (c) => '#' + c.map((n) => n.toString(16).padStart(2, '0')).join('');

function toPath(pts) {
  const p = [pts[0], ...pts, pts[pts.length - 1]];
  let d = `M${fx(pts[0][0])} ${fx(pts[0][1])}`;
  for (let i = 0; i < p.length - 3; i++) {
    const [x0, y0] = p[i];
    const [x1, y1] = p[i + 1];
    const [x2, y2] = p[i + 2];
    const [x3, y3] = p[i + 3];
    const c1x = x1 + (x2 - x0) / 6;
    const c1y = y1 + (y2 - y0) / 6;
    const c2x = x2 - (x3 - x1) / 6;
    const c2y = y2 - (y3 - y1) / 6;
    d += ` C${fx(c1x)} ${fx(c1y)} ${fx(c2x)} ${fx(c2y)} ${fx(x2)} ${fx(y2)}`;
  }
  return d;
}

function buildSVG() {
  const wPx = V * 0.075;
  const reflPts = reflect(CREST_FULL);

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${V} ${V}" width="${V}" height="${V}" role="img" aria-label="ShadowSurf">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${hex(BG_TOP)}" />
      <stop offset="1" stop-color="${hex(BG_BOTTOM)}" />
    </linearGradient>
    <radialGradient id="glow" cx="0.26" cy="0.2" r="0.55">
      <stop offset="0" stop-color="${hex(INK)}" stop-opacity="0.16" />
      <stop offset="1" stop-color="${hex(INK)}" stop-opacity="0" />
    </radialGradient>
    <!-- 倒影向下渐隐：贴水位线最实，到 REFL_SPAN 处完全透明 -->
    <linearGradient id="refl" x1="0" y1="${WATER}" x2="0" y2="${WATER + REFL_SPAN}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${hex(INK)}" stop-opacity="0.44" />
      <stop offset="1" stop-color="${hex(INK)}" stop-opacity="0" />
    </linearGradient>
    <clipPath id="tile">
      <rect x="0" y="0" width="${V}" height="${V}" rx="${(RADIUS * V).toFixed(1)}" />
    </clipPath>
  </defs>
  <rect x="0" y="0" width="${V}" height="${V}" rx="${(RADIUS * V).toFixed(1)}" fill="url(#bg)" />
  <rect x="0" y="0" width="${V}" height="${V}" rx="${(RADIUS * V).toFixed(1)}" fill="url(#glow)" />
  <g clip-path="url(#tile)" fill="none" stroke-linecap="round" stroke-linejoin="round">
    <path d="${toPath(reflPts)}" stroke="url(#refl)" stroke-width="${wPx.toFixed(2)}" />
    <path d="${toPath(CREST_FULL)}" stroke="${hex(INK)}" stroke-width="${wPx.toFixed(2)}" />
  </g>
</svg>
`;
}

/* ---------- 对照表（验收用，不进产物目录） ---------- */
// 每个尺寸放大到 CELL×CELL（最近邻，不做插值）—— 只有放大才能看清 16px 到底糊没糊。
// 注意：传进来的是**原始 RGBA**缓存，不是 PNG 字节。混用会把压缩流当像素画，出来是一片噪声。
function buildSheet(rawCache) {
  const sizes = [16, 32, 48, 128, 256];
  const CELL = 160;
  const GAP = 12;
  const PAD = 12;
  const cols = sizes.length;
  const w = PAD * 2 + cols * CELL + (cols - 1) * GAP;
  const rowH = CELL + PAD * 2;
  const h = rowH * 2;
  const bgs = [
    [0xf6, 0xf5, 0xf2],
    [0x18, 0x1a, 0x19]
  ];

  const buf = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const row = y < rowH ? 0 : 1;
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      buf[o] = bgs[row][0];
      buf[o + 1] = bgs[row][1];
      buf[o + 2] = bgs[row][2];
      buf[o + 3] = 255;
    }
  }

  sizes.forEach((n, col) => {
    const src = rawCache.get(n);
    const cx = PAD + col * (CELL + GAP);
    for (let row = 0; row < 2; row++) {
      const cy = row * rowH + PAD;
      for (let dy = 0; dy < CELL; dy++) {
        const sy = Math.min(n - 1, Math.floor((dy * n) / CELL));
        for (let dx = 0; dx < CELL; dx++) {
          const sx = Math.min(n - 1, Math.floor((dx * n) / CELL));
          const s = (sy * n + sx) * 4;
          const a = src[s + 3] / 255;
          if (a === 0) continue;
          const d = ((cy + dy) * w + cx + dx) * 4;
          for (let k = 0; k < 3; k++) {
            buf[d + k] = Math.round(src[s + k] * a + buf[d + k] * (1 - a));
          }
        }
      }
    }
  });

  return encodePNG(w, h, buf);
}

/* ---------- 执行 ---------- */
for (const dir of [EXT_OUT, BUILD_OUT, DOCS_OUT]) mkdirSync(dir, { recursive: true });

const rawCache = new Map();
const raw = (size) => {
  if (!rawCache.has(size)) rawCache.set(size, render(size));
  return rawCache.get(size);
};

const pngCache = new Map();
const png = (size) => {
  if (!pngCache.has(size)) pngCache.set(size, encodePNG(size, size, raw(size)));
  return pngCache.get(size);
};

for (const size of [16, 32, 48, 128]) {
  const buf = png(size);
  writeFileSync(join(EXT_OUT, `icon${size}.png`), buf);
  console.log(`extension/icons/icon${size}.png  ${buf.length} bytes`);
}

const big = png(512);
writeFileSync(join(BUILD_OUT, 'icon.png'), big);
console.log(`build/icon.png  ${big.length} bytes`);

const icoSizes = [16, 32, 48, 64, 128, 256];
const ico = encodeICO(icoSizes.map((size) => ({ size, png: png(size) })));
writeFileSync(join(BUILD_OUT, 'icon.ico'), ico);
console.log(`build/icon.ico  ${ico.length} bytes  (${icoSizes.join('/')})`);

const svg = buildSVG();
writeFileSync(join(DOCS_OUT, 'app-icon.svg'), svg);
console.log(`docs/app-icon.svg  ${svg.length} bytes`);

const si = process.argv.indexOf('--sheet');
if (si > -1 && process.argv[si + 1]) {
  const out = process.argv[si + 1];
  writeFileSync(out, buildSheet(rawCache));
  console.log(`sheet → ${out}`);
}

console.log('done');
