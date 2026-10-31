/**
 * 指纹引擎。
 *
 * 核心思想：**确定性，而不是随机化**。
 *   seed = HKDF-SHA256(masterKey, salt='shadowsurf', info=profileId)
 * 同一个 profileId 永远派生出同一个 seed，同一个 seed 永远生成同一套指纹。
 * 于是「环境迁移 / 备份恢复后指纹不变」成立，而「换 ID 就是全新身份」也成立。
 *
 * 随机化反而是反模式：每次刷新页面指纹都变，等于告诉对方「这是个假浏览器」。
 * 所以这里所有噪声都由 seed 派生的哈希决定，同一坐标永远得到同一扰动。
 */

import { hkdfSync, randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import { filePath } from '@main/store/db'
import { TIMEZONE_GEO, resolveFingerprint } from '@shared/presets'
import type { FingerprintConfig, OSKind } from '@shared/types'

/* ────────────────────────────── 主密钥 ────────────────────────────── */

const MASTER_KEY_FILE = 'master.key'
const HKDF_SALT = 'shadowsurf'

let cachedMaster: Buffer | null = null

/**
 * 本机主密钥：32 字节随机数，首次运行时生成并落盘（0600）。
 * 所有 profile 的 seed 都由它派生，所以这个文件就是「这台机器上所有身份」的根。
 * 泄露它 = 泄露所有环境的指纹规律；丢了它 = 所有环境指纹全部漂移。
 */
export function masterKey(): Buffer {
  if (cachedMaster !== null) return cachedMaster
  const file = filePath(MASTER_KEY_FILE)

  try {
    const existing = fs.readFileSync(file)
    if (existing.length >= 32) {
      cachedMaster = existing
      return existing
    }
  } catch {
    /* 首次运行，继续走生成分支 */
  }

  const fresh = randomBytes(32)
  fs.writeFileSync(file, fresh, { mode: 0o600 })
  try {
    // Windows 上 chmod 是近似实现，失败也无所谓
    fs.chmodSync(file, 0o600)
  } catch {
    /* ignore */
  }
  cachedMaster = fresh
  return fresh
}

/**
 * HKDF-SHA256(masterKey, salt='shadowsurf', info=profileId) → hex 前 32 位。
 * info 绑 profileId，保证不同环境之间 seed 互相独立（不能从一个推出另一个）。
 */
export function deriveSeed(profileId: string): string {
  const okm = hkdfSync(
    'sha256',
    masterKey(),
    Buffer.from(HKDF_SALT, 'utf8'),
    Buffer.from(profileId, 'utf8'),
    32
  )
  return Buffer.from(okm).toString('hex').slice(0, 32)
}

/* ────────────────────────────── 指纹生成 ────────────────────────────── */

function hash32(input: string): number {
  let h = 2166136261
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** 每个系统各自合理的分辨率池，跨系统乱配（Mac 上出现 1366x768）反而更容易被识别 */
const SCREEN_POOL: Record<OSKind, Array<[number, number, number]>> = {
  windows: [
    [1920, 1080, 1],
    [2560, 1440, 1],
    [1536, 864, 1.25],
    [1440, 900, 1],
    [1680, 1050, 1]
  ],
  macos: [
    [1512, 982, 2],
    [1440, 900, 2],
    [1728, 1117, 2],
    [1680, 1050, 2],
    [2560, 1440, 2]
  ],
  linux: [
    [1920, 1080, 1],
    [1366, 768, 1],
    [1600, 900, 1],
    [2560, 1440, 1]
  ]
}

const CORE_POOL: Record<OSKind, number[]> = {
  windows: [4, 6, 8, 12, 16],
  macos: [8, 10, 12],
  linux: [2, 4, 8]
}

/**
 * 在 resolveFingerprint 的基础上再叠一层 seed 决定的扰动。
 *
 * 为什么要多这一层：resolveFingerprint 只对 windows 做了扰动，
 * macos / linux 会退化成模板默认值——一批环境全是同一个分辨率，
 * 反而成了明显的批量特征。
 *
 * 关键约束：调用方显式传入的 overrides 优先级最高，绝不覆盖。
 */
export function buildFingerprint(
  os: OSKind,
  seed: string,
  overrides: Partial<FingerprintConfig> = {}
): FingerprintConfig {
  const base = resolveFingerprint(os, seed, overrides)
  const h = hash32(seed)

  const out: FingerprintConfig = { ...base }

  if (overrides.screen === undefined) {
    const pool = SCREEN_POOL[os]
    const pick = pool[h % pool.length]
    out.screen = { width: pick[0], height: pick[1], dpr: pick[2], colorDepth: base.screen.colorDepth }
  }

  if (overrides.hardware === undefined) {
    const cores = CORE_POOL[os]
    const memory = [8, 16, 32]
    out.hardware = {
      cpuCores: cores[(h >>> 3) % cores.length],
      memoryGB: memory[(h >>> 7) % memory.length]
    }
  }

  if (overrides.geolocation === undefined) {
    out.geolocation = TIMEZONE_GEO[out.timezone] ?? out.geolocation
  }

  return out
}

/* ────────────────────────────── 注入脚本 ────────────────────────────── */

interface InjectionConfig {
  seed: number
  ua: string
  appVersion: string
  platform: string
  vendor: string
  cores: number
  memory: number
  languages: string[]
  tz: string
  locale: string
  scr: { w: number; h: number; aw: number; ah: number; depth: number; dpr: number }
  geo: { lat: number; lon: number; acc: number } | null
  glVendor: string
  glRenderer: string
  canvasNoise: boolean
  audioNoise: boolean
  webrtc: string
  rectNoise: boolean
  fonts: string[]
  webgpu: boolean
  os: string
}

export function platformOf(os: OSKind): string {
  if (os === 'windows') return 'Win32'
  if (os === 'macos') return 'MacIntel'
  return 'Linux x86_64'
}

/**
 * UA-CH（Sec-CH-UA）元数据。
 *
 * 只改 User-Agent 是不够的：Chromium 会另外发一套 Client Hints，
 * 里面写着真实平台和真实版本。macOS 环境报 "Windows" 是最典型的破绽。
 * 这套值通过 CDP 的 Network.setUserAgentOverride 一起下发。
 */
export function uaMetadata(fp: FingerprintConfig): Record<string, unknown> {
  const major = fp.uaVersion.split('.')[0] || '156'
  // 真实 Chrome 的 brands 里一定有 "Google Chrome" 这一项。
  // 只发 Chromium 的话，任何读 navigator.userAgentData.brands 的站点
  // 都会立刻发现「这台的 UA 说自己 是 Chrome，但 Client Hints 里没有 Chrome」。
  const brands = [
    { brand: 'Google Chrome', version: major },
    { brand: 'Chromium', version: major },
    { brand: 'Not_A Brand', version: '24' }
  ]
  const fullVersionList = [
    { brand: 'Google Chrome', version: fp.uaVersion },
    { brand: 'Chromium', version: fp.uaVersion },
    { brand: 'Not_A Brand', version: '24.0.0.0' }
  ]
  return {
    brands,
    fullVersionList,
    fullVersion: fp.uaVersion,
    // Client Hints 里的平台名只有这三个合法值
    platform: fp.os === 'windows' ? 'Windows' : fp.os === 'macos' ? 'macOS' : 'Linux',
    // Windows 11 报 15.0.0（Win10 是 10.0.0），macOS 15 报 15.0.0
    platformVersion: fp.os === 'windows' ? '15.0.0' : fp.os === 'macos' ? '15.0.0' : '6.8.0',
    architecture: 'x86',
    model: '',
    mobile: false,
    bitness: '64',
    wow64: false
  }
}

/** Chrome 的 navigator.deviceMemory 上限就是 8，写 16 会自曝 */
function deviceMemoryOf(gb: number): number {
  if (gb >= 8) return 8
  if (gb >= 4) return 4
  if (gb >= 2) return 2
  return 1
}

function injectionConfig(fp: FingerprintConfig, seed: string): InjectionConfig {
  const h = hash32(seed)
  const chromeHeight = fp.os === 'windows' ? 40 : fp.os === 'macos' ? 25 : 27
  const geo =
    fp.geolocation === null
      ? null
      : {
          // ±0.0008 度 ≈ 90 米：既避免和时区中心点完全重合，又不至于跨城市
          lat: Number((fp.geolocation.latitude + (((h % 1600) - 800) / 1e6)).toFixed(6)),
          lon: Number((fp.geolocation.longitude + ((((h >>> 11) % 1600) - 800) / 1e6)).toFixed(6)),
          acc: 20 + (h % 30)
        }

  return {
    seed: hash32(seed),
    ua: fp.userAgent,
    appVersion: fp.userAgent.replace(/^Mozilla\//, ''),
    platform: platformOf(fp.os),
    vendor: 'Google Inc.',
    cores: fp.hardware.cpuCores,
    memory: deviceMemoryOf(fp.hardware.memoryGB),
    languages: fp.languages.slice(),
    tz: fp.timezone,
    locale: fp.locale,
    scr: {
      w: fp.screen.width,
      h: fp.screen.height,
      aw: fp.screen.width,
      ah: Math.max(0, fp.screen.height - chromeHeight),
      depth: fp.screen.colorDepth,
      dpr: fp.screen.dpr
    },
    geo,
    glVendor: fp.webgl.vendor,
    glRenderer: fp.webgl.renderer,
    canvasNoise: fp.canvas === 'noise',
    audioNoise: fp.audio === 'noise',
    webrtc: fp.webrtc,
    rectNoise: fp.clientRectsNoise,
    fonts: fp.fonts.slice(),
    webgpu: fp.webgpu,
    os: fp.os
  }
}

/**
 * 生成注入脚本。
 *
 * 几条铁律：
 * - 纯 ES5：注入发生在页面最早阶段，任何语法糖都可能在某些页面环境炸掉。
 * - 每个面独立 try/catch：某面失败不影响其它面。
 * - 页面里不留任何自己的标记。幂等由主进程保证（同一个 webContents 只注入一次），
 *   不在 window 上挂 __SS_FP__ 这类全局变量 —— 那行代码一行就能查到，等于自报家门。
 * - 噪声用 seed 派生的哈希，不用 Math.random()：同一坐标永远同一扰动，
 *   所以同一页面多次读取得到相同结果——「稳定」才是伪装，抖动等于自曝。
 */
export function buildInjectionScript(fp: FingerprintConfig, seed: string): string {
  const cfg = injectionConfig(fp, seed)
  // < 只可能出现在字符串值里，替换成 \u003c 防止脚本被内联进 HTML 时提前闭合
  const json = JSON.stringify(cfg).replace(/</g, '\\u003c')
  const L: string[] = []

  L.push('(function () {')
  L.push('  try {')
  L.push('    var C = ' + json + ';')
  L.push('    var S = C.seed | 0;')
  L.push('')
  L.push('    function h32(a, b, c, d) {')
  L.push('      var h = (S ^ (a | 0) ^ (b | 0) ^ (c | 0) ^ (d | 0)) | 0;')
  L.push('      h = Math.imul(h ^ (h >>> 16), 2246822507);')
  L.push('      h = Math.imul(h ^ (h >>> 13), 3266489909);')
  L.push('      return (h ^ (h >>> 16)) >>> 0;')
  L.push('    }')
  L.push('    function defGet(o, p, fn) {')
  L.push('      try {')
  L.push('        var d = Object.getOwnPropertyDescriptor(o, p);')
  L.push('        Object.defineProperty(o, p, {')
  L.push('          configurable: d ? d.configurable !== false : true,')
  L.push('          enumerable: d ? d.enumerable : true,')
  L.push('          get: fn')
  L.push('        });')
  L.push('      } catch (e) {}')
  L.push('    }')
  L.push('    function defVal(o, p, v) { defGet(o, p, function () { return v; }); }')

  /* 伪装台账必须声明在**最前面**。
     早期版本把它放在脚本末尾的统一收口处，导致 geolocation / 音频 / WebRTC 实例方法
     这几个「中途 patch」的地方没法登记，只能各自挂匿名函数 ——
     `Geolocation.prototype.getCurrentPosition.toString()` 直接吐出
     `function (ok) { _reply(ok); }`，一处露馅等于前面所有伪装白做。 */
  L.push('')
  L.push('    var _masked = [];')
  L.push('    var _fakeSrc = function (nm) { return "function " + nm + "() { [native code] }"; };')
  L.push('    var _noProto = function (fn) {')
  L.push('      try { return { f() { return fn.apply(this, arguments); } }.f; } catch (e) { return fn; }')
  L.push('    };')
  L.push('    var _maskOne = function (fn, nm, len) {')
  L.push('      if (typeof fn !== "function") { return fn; }')
  L.push('      try { Object.defineProperty(fn, "name", { value: nm, configurable: true }); } catch (e) {}')
  L.push('      try { if (typeof len === "number") { Object.defineProperty(fn, "length", { value: len, configurable: true }); } } catch (e) {}')
  L.push('      _masked.push(fn);')
  L.push('      return fn;')
  L.push('    };')

  /* navigator */
  L.push('')
  L.push('    try {')
  L.push('      var NP = Navigator.prototype;')
  L.push("      defVal(NP, 'userAgent', C.ua);")
  L.push("      defVal(NP, 'appVersion', C.appVersion);")
  L.push("      defVal(NP, 'platform', C.platform);")
  L.push("      defVal(NP, 'vendor', C.vendor);")
  L.push("      defVal(NP, 'hardwareConcurrency', C.cores);")
  L.push("      defVal(NP, 'deviceMemory', C.memory);")
  L.push("      defVal(NP, 'language', C.languages[0]);")
  L.push("      defGet(NP, 'languages', function () { return C.languages.slice(); });")
  L.push("      defVal(NP, 'webdriver', false);")
  L.push("      defVal(NP, 'pdfViewerEnabled', true);")
  L.push('    } catch (e) {}')

  /* screen */
  L.push('')
  L.push('    try {')
  L.push('      var SP = Screen.prototype;')
  L.push("      defVal(SP, 'width', C.scr.w);")
  L.push("      defVal(SP, 'height', C.scr.h);")
  L.push("      defVal(SP, 'availWidth', C.scr.aw);")
  L.push("      defVal(SP, 'availHeight', C.scr.ah);")
  L.push("      defVal(SP, 'colorDepth', C.scr.depth);")
  L.push("      defVal(SP, 'pixelDepth', C.scr.depth);")
  L.push('    } catch (e) {}')

  /* devicePixelRatio */
  L.push('')
  L.push('    try {')
  L.push("      defGet(window, 'devicePixelRatio', function () { return C.scr.dpr; });")
  L.push('    } catch (e) {}')

  /* timezone
     只改 Intl.DateTimeFormat 和 getTimezoneOffset 是不够的：Date 的本地时间
     getter 读的是宿主机的时区表，一台 UTC+8 的机器配洛杉矶环境，getHours()
     会直接吐出东八区的小时数 —— 比不改更假。这里把所有本地 getter 整体平移。 */
  L.push('')
  L.push('    try {')
  L.push('      if (C.tz) {')
  L.push('      var _DTF = Intl.DateTimeFormat;')
  L.push("      var _lang = (C.languages && C.languages.length) ? C.languages[0] : 'en-US';")
  L.push('      var _Patched = function (locales, options) {')
  L.push('        var o = {};')
  L.push('        if (options) { for (var k in options) { o[k] = options[k]; } }')
  L.push('        // 站点显式要 UTC 时要放行，只有缺省才补默认时区')
  L.push('        if (!o.timeZone) { o.timeZone = C.tz; }')
  L.push('        // 缺省 locale 也要跟着走：navigator.languages 说 en-US，')
  L.push('        // Intl 默认却还是宿主机的 zh-CN，是个一眼可见的矛盾')
  L.push('        if (locales === undefined || locales === null) { locales = _lang; }')
  L.push('        return new _DTF(locales, o);')
  L.push('      };')
  L.push('      _Patched.prototype = _DTF.prototype;')
  L.push('      _Patched.supportedLocalesOf = _DTF.supportedLocalesOf;')
  // 原生是 `Intl.DateTimeFormat.prototype.constructor === Intl.DateTimeFormat`。
  // 只把 prototype 指过去、不修 constructor，读一次就发现指向的是被我们藏起来的
  // 那个原生构造器 —— 而且它是全页共享的，不修等于把「原版」留了个把手。
  L.push('      try {')
  L.push('        Object.defineProperty(_DTF.prototype, "constructor", { value: _Patched, configurable: true, writable: true });')
  L.push('      } catch (e) {}')
  // 包装函数的 name 默认取变量名 —— 直接把 `_Patched` 这个名字送给了检测脚本。
  // 实测 `Intl.DateTimeFormat.name === "_Patched"`、`RTCPeerConnection.name === "_PC"`，
  // 等于把「这里被 hook 过」和「hook 变量的命名习惯」一起交出去。
  // 原生构造器的 name 就是构造器名、length 是 0，两样都要对齐。
  L.push('      try {')
  L.push('        Object.defineProperty(_Patched, "name", { value: "DateTimeFormat", configurable: true });')
  L.push('        Object.defineProperty(_Patched, "length", { value: 0, configurable: true });')
  L.push('      } catch (e) {}')
  L.push('      Intl.DateTimeFormat = _Patched;')
  L.push('')
  L.push('      // 其余 Intl 构造器同理，缺省 locale 一并接管')
  L.push("      var _IN = ['NumberFormat', 'Collator', 'RelativeTimeFormat', 'PluralRules', 'ListFormat', 'DisplayNames', 'Segmenter'];")
  L.push('      for (var ni = 0; ni < _IN.length; ni++) {')
  L.push('        (function (nm) {')
  L.push('          var Orig = Intl[nm];')
  L.push('          if (typeof Orig !== "function") { return; }')
  L.push('          var W = function (locales, options) {')
  L.push('            if (locales === undefined || locales === null) { locales = _lang; }')
  L.push('            return new Orig(locales, options);')
  L.push('          };')
  L.push('          W.prototype = Orig.prototype;')
  L.push('          if (Orig.supportedLocalesOf) { W.supportedLocalesOf = Orig.supportedLocalesOf; }')
  L.push('          try { Object.defineProperty(Orig.prototype, "constructor", { value: W, configurable: true, writable: true }); } catch (e) {}')
  // 同 _Patched：包装函数的 name 是变量名 W，必须改回构造器名
  L.push('          try {')
  L.push('            Object.defineProperty(W, "name", { value: nm, configurable: true });')
  L.push('            Object.defineProperty(W, "length", { value: 0, configurable: true });')
  L.push('          } catch (e) {}')
  L.push('          Intl[nm] = W;')
  L.push('        })(_IN[ni]);')
  L.push('      }')
  L.push('')
  L.push('      var _parts = new _DTF("en-US", {')
  L.push("        timeZone: C.tz, hour12: false, year: 'numeric', month: '2-digit',")
  L.push("        day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'")
  L.push('      });')
  L.push("      var _nameFmt = new _DTF('en-US', { timeZone: C.tz, timeZoneName: 'long' });")
  L.push('      var _gtzoNative = Date.prototype.getTimezoneOffset;')
  L.push('      var _offT = NaN, _offV = 0;')
  L.push('      var _targetOff = function (d) {')
  L.push('        var t = d.getTime();')
  L.push('        if (t === _offT) { return _offV; }')
  L.push('        var y = 0, mo = 1, dd = 1, hh = 0, mi = 0, ss = 0;')
  L.push('        var arr = _parts.formatToParts(d);')
  L.push('        for (var i = 0; i < arr.length; i++) {')
  L.push('          var tp = arr[i].type, v = parseInt(arr[i].value, 10);')
  L.push("          if (tp === 'year') { y = v; }")
  L.push("          else if (tp === 'month') { mo = v; }")
  L.push("          else if (tp === 'day') { dd = v; }")
  L.push("          else if (tp === 'hour') { hh = v % 24; }")
  L.push("          else if (tp === 'minute') { mi = v; }")
  L.push("          else if (tp === 'second') { ss = v; }")
  L.push('        }')
  L.push('        var asUTC = Date.UTC(y, mo - 1, dd, hh, mi, ss);')
  L.push('        var off = Math.round((t - asUTC) / 60000);')
  L.push('        if (!isFinite(off)) { off = 0; }')
  L.push('        _offT = t; _offV = off;')
  L.push('        return off;')
  L.push('      };')
  L.push('      Date.prototype.getTimezoneOffset = function () {')
  L.push('        try { return _targetOff(this); } catch (e) { return 0; }')
  L.push('      };')
  L.push('')
  L.push('      var _shifted = function (d) {')
  L.push('        var t = _targetOff(d), h = 0;')
  L.push('        try { h = _gtzoNative.call(d); } catch (e) {}')
  L.push('        return new Date(d.getTime() + (h - t) * 60000);')
  L.push('      };')
  L.push("      var _GETS = ['getFullYear', 'getMonth', 'getDate', 'getDay', 'getHours', 'getMinutes', 'getSeconds'];")
  L.push('      for (var gi = 0; gi < _GETS.length; gi++) {')
  L.push('        (function (nm) {')
  L.push('          var orig = Date.prototype[nm];')
  L.push('          Date.prototype[nm] = function () { return orig.apply(_shifted(this), arguments); };')
  L.push('        })(_GETS[gi]);')
  L.push('      }')
  L.push('')
  L.push("      var _p2 = function (n) { return (n < 10 ? '0' : '') + n; };")
  L.push("      var _DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];")
  L.push("      var _MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];")
  L.push('      var _zoneName = function (d) {')
  L.push('        try {')
  L.push('          var a = _nameFmt.formatToParts(d);')
  L.push("          for (var i = 0; i < a.length; i++) { if (a[i].type === 'timeZoneName') { return a[i].value; } }")
  L.push('        } catch (e) {}')
  L.push("        return '';")
  L.push('      };')
  L.push('      // 原生 toTimeString 印的是宿主机时区的 GMT 偏移和时区名，必须整个重写')
  L.push('      Date.prototype.toTimeString = function () {')
  L.push('        if (isNaN(this.getTime())) { return "Invalid Date"; }')
  L.push('        var off = -this.getTimezoneOffset();')
  L.push("        var sg = off >= 0 ? '+' : '-';")
  L.push('        var ab = Math.abs(off);')
  L.push("        var zone = 'GMT' + sg + _p2(Math.floor(ab / 60)) + _p2(ab % 60);")
  L.push('        var nm = _zoneName(this);')
  L.push("        return _p2(this.getHours()) + ':' + _p2(this.getMinutes()) + ':' + _p2(this.getSeconds()) + ' ' + zone + (nm ? ' (' + nm + ')' : '');")
  L.push('      };')
  L.push('      Date.prototype.toDateString = function () {')
  L.push('        if (isNaN(this.getTime())) { return "Invalid Date"; }')
  L.push("        return _DOW[this.getDay()] + ' ' + _MON[this.getMonth()] + ' ' + _p2(this.getDate()) + ' ' + this.getFullYear();")
  L.push('      };')
  L.push('      Date.prototype.toString = function () {')
  L.push('        if (isNaN(this.getTime())) { return "Invalid Date"; }')
  L.push("        return this.toDateString() + ' ' + this.toTimeString();")
  L.push('      };')
  L.push('')
  L.push('      var _withTz = function (fn) {')
  L.push('        return function (l, o) {')
  L.push('          var q = {};')
  L.push('          if (o) { for (var k in o) { q[k] = o[k]; } }')
  L.push('          q.timeZone = C.tz;')
  L.push('          if (l === undefined || l === null) { l = _lang; }')
  L.push('          return fn.call(this, l, q);')
  L.push('        };')
  L.push('      };')
  L.push('      Date.prototype.toLocaleString = _withTz(Date.prototype.toLocaleString);')
  L.push('      Date.prototype.toLocaleDateString = _withTz(Date.prototype.toLocaleDateString);')
  L.push('      Date.prototype.toLocaleTimeString = _withTz(Date.prototype.toLocaleTimeString);')
  L.push('      }')
  L.push('    } catch (e) {}')

  /* 语音合成：默认语音表来自宿主机。一个 en-US 环境里冒出
     "Microsoft Huihui - Chinese (Simplified, PRC)" 是硬伤。 */
  L.push('')
  L.push('    try {')
  L.push('      var _syn = window.speechSynthesis;')
  L.push('      if (_syn && _syn.getVoices && C.languages && C.languages.length) {')
  L.push('        var _want = String(C.languages[0]).toLowerCase().split("-")[0];')
  L.push('        // 宿主机常常只装了本机语言的语音包，过滤后为空。此时退回真实列表')
  L.push('        // 等于自曝，所以按目标系统补几条出厂自带的标准语音。')
  L.push('        var _FAKE = C.os === "macos"')
  L.push('          ? ["Samantha", "Alex", "Fred", "Victoria", "Daniel"]')
  L.push('          : C.os === "linux"')
  L.push('            ? ["English (America)", "English (Great Britain)"]')
  L.push('            : ["Microsoft David - English (United States)", "Microsoft Zira - English (United States)", "Microsoft Mark - English (United States)"];')
  L.push('        var _made = null;')
  L.push('        var _gv = _syn.getVoices;')
  L.push('        _syn.getVoices = function () {')
  L.push('          var all = _gv.call(_syn) || [];')
  L.push('          var out = [];')
  L.push('          for (var i = 0; i < all.length; i++) {')
  L.push('            var lg = String(all[i].lang || "").toLowerCase().replace("_", "-");')
  L.push('            if (lg.split("-")[0] === _want) { out.push(all[i]); }')
  L.push('          }')
  L.push('          if (out.length) { return out; }')
  L.push('          if (!_made) {')
  L.push('            _made = [];')
  L.push('            for (var j = 0; j < _FAKE.length; j++) {')
  L.push('              _made.push({')
  L.push('                name: _FAKE[j], lang: C.languages[0], localService: true,')
  L.push('                default: j === 0, voiceURI: _FAKE[j]')
  L.push('              });')
  L.push('            }')
  L.push('          }')
  L.push('          return _made.slice();')
  L.push('        };')
  L.push('      }')
  L.push('    } catch (e) {}')

  /* geolocation */
  L.push('')
  L.push('    try {')
  L.push('      var GP = window.Geolocation && Geolocation.prototype;')
  L.push('      if (GP && C.geo) {')
  L.push('        var _reply = function (cb) {')
  L.push('          if (typeof cb !== "function") { return; }')
  L.push('          var pos = {')
  L.push('            coords: {')
  L.push('              latitude: C.geo.lat, longitude: C.geo.lon, accuracy: C.geo.acc,')
  L.push('              altitude: null, altitudeAccuracy: null, heading: null, speed: null')
  L.push('            },')
  L.push('            timestamp: Date.now()')
  L.push('          };')
  L.push('          setTimeout(function () { cb(pos); }, 0);')
  L.push('        };')
  L.push('        GP.getCurrentPosition = function (ok) { _reply(ok); };')
  L.push('        GP.watchPosition = function (ok) { _reply(ok); return 1; };')
  L.push('      }')
  L.push('    } catch (e) {}')

  /* canvas */
  L.push('')
  L.push('    try {')
  L.push('      var CE = window.HTMLCanvasElement && HTMLCanvasElement.prototype;')
  L.push('      if (CE && C.canvasNoise) {')
  L.push('        var C2D = window.CanvasRenderingContext2D && CanvasRenderingContext2D.prototype;')
  L.push('        var _scrub = function (cv) {')
  L.push('          var w = cv.width, h = cv.height;')
  L.push('          if (!w || !h || w * h > 4194304) { return; }')
  L.push('          var ctx = null;')
  L.push('          try { ctx = cv.getContext("2d"); } catch (e) { return; }')
  L.push('          if (!ctx) { return; }')
  L.push('          var img = ctx.getImageData(0, 0, w, h);')
  L.push('          ctx.putImageData(img, 0, 0);')
  L.push('        };')
  L.push('        if (C2D) {')
  L.push('          var _gid = C2D.getImageData;')
  L.push('          C2D.getImageData = function (sx, sy, sw, sh) {')
  L.push('            var img = _gid.call(this, sx, sy, sw, sh);')
  L.push('            try {')
  L.push('              if (!sw || !sh) { return img; }')
  L.push('              var d = img.data;')
  L.push('              for (var i = 0; i < d.length; i += 4) {')
  L.push('                var idx = i >>> 2;')
  L.push('                var px = idx % sw, py = (idx / sw) | 0;')
  L.push('                var k = h32(px, py, sx, sy);')
  L.push('                d[i] = (d[i] & 254) | (k & 1);')
  L.push('                d[i + 1] = (d[i + 1] & 254) | ((k >>> 1) & 1);')
  L.push('                d[i + 2] = (d[i + 2] & 254) | ((k >>> 2) & 1);')
  L.push('              }')
  L.push('            } catch (e) {}')
  L.push('            return img;')
  L.push('          };')
  L.push('        }')
  L.push('        var _tdu = CE.toDataURL;')
  L.push('        CE.toDataURL = function () {')
  L.push('          try { _scrub(this); } catch (e) {}')
  L.push('          return _tdu.apply(this, arguments);')
  L.push('        };')
  L.push('        var _tob = CE.toBlob;')
  L.push('        if (_tob) {')
  L.push('          CE.toBlob = function () {')
  L.push('            try { _scrub(this); } catch (e) {}')
  L.push('            return _tob.apply(this, arguments);')
  L.push('          };')
  L.push('        }')
  L.push('      }')
  L.push('    } catch (e) {}')

  /* audio */
  L.push('')
  L.push('    try {')
  L.push('      var AN = window.AnalyserNode && AnalyserNode.prototype;')
  L.push('      if (AN && C.audioNoise) {')
  L.push('        var _gff = AN.getFloatFrequencyData;')
  L.push('        AN.getFloatFrequencyData = function (arr) {')
  L.push('          _gff.call(this, arr);')
  L.push('          try {')
  L.push('            for (var i = 0; i < arr.length; i++) {')
  L.push('              var k = h32(i, 31, 7, 13) % 2000;')
  L.push('              arr[i] = arr[i] + (k - 1000) * 1e-10;')
  L.push('            }')
  L.push('          } catch (e) {}')
  L.push('        };')
  L.push('      }')
  L.push('    } catch (e) {}')

  /* webgl */
  L.push('')
  L.push('    try {')
  L.push('      var _patchGL = function (G) {')
  L.push('        if (!G || !G.prototype || !G.prototype.getParameter) { return; }')
  L.push('        var _gp = G.prototype.getParameter;')
  L.push('        G.prototype.getParameter = function (p) {')
  L.push('          if (p === 37445) { return C.glVendor; }')
  L.push('          if (p === 37446) { return C.glRenderer; }')
  L.push('          return _gp.apply(this, arguments);')
  L.push('        };')
  L.push('      };')
  L.push('      _patchGL(window.WebGLRenderingContext);')
  L.push('      _patchGL(window.WebGL2RenderingContext);')
  L.push('    } catch (e) {}')

  /* webrtc：disabled 直接掐死；proxy 模式只放行 srflx/relay，
     把 host candidate（内网 IP、mDNS）全部吞掉——这是最经典的泄漏面 */
  L.push('')
  L.push('    try {')
  L.push('      var RTC = window.RTCPeerConnection || window.webkitRTCPeerConnection;')
  L.push('      if (RTC && RTC.prototype) {')
  L.push("        if (C.webrtc === 'disabled') {")
  L.push('          var _deny = function () {')
  L.push("            throw new Error('RTCPeerConnection is disabled by policy');")
  L.push('          };')
  L.push('          RTC.prototype.createDataChannel = _deny;')
  L.push('          RTC.prototype.createOffer = _deny;')
  L.push("        } else if (C.webrtc === 'proxy') {")
  L.push('          var _priv = function (ip) {')
  L.push("            if (!ip || /\.local$/i.test(ip)) { return true; }")
  L.push("            if (/^10\./.test(ip) || /^192\.168\./.test(ip) || /^169\.254\./.test(ip) || /^127\./.test(ip)) { return true; }")
  L.push("            if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(ip)) { return true; }")
  L.push("            if (/^(fc|fd|fe80)/i.test(ip)) { return true; }")
  L.push('            return false;')
  L.push('          };')
  L.push('          var _keep = function (cand) {')
  L.push("            if (!cand || !cand.candidate || cand.candidate.indexOf(' typ host') === -1) { return cand; }")
  L.push("            var m = /([0-9]{1,3}(\.[0-9]{1,3}){3}|[a-f0-9]{1,4}(:[a-f0-9]{0,4}){2,}|[^\s]+\.local)/i.exec(cand.candidate);")
  L.push('            if (m && _priv(m[1])) { return null; }')
  L.push('            return cand;')
  L.push('          };')
  L.push('          var _guard = function (pc) {')
  L.push('            var add = pc.addEventListener;')
  // 实例级 hook 也要登记：函数字面量的 name 是空串、且带 prototype，
  // 一次 `"prototype" in pc.addEventListener` 就暴露了这里被动过手脚
  L.push('            pc.addEventListener = _maskOne(_noProto(function (t, fn, o) {')
  L.push("              if (t === 'icecandidate' && typeof fn === 'function') {")
  L.push('                return add.call(this, t, function (e) { var c = _keep(e); if (c) { fn.call(this, c); } }, o);')
  L.push('              }')
  L.push('              return add.apply(this, arguments);')
  L.push('            }), "addEventListener", 2);')
  L.push('            var on = null;')
  L.push('            try {')
  L.push("              Object.defineProperty(pc, 'onicecandidate', {")
  L.push('                configurable: true,')
  L.push('                get: _maskOne(_noProto(function () { return on; }), "get onicecandidate", 0),')
  L.push('                set: _maskOne(_noProto(function (fn) {')
  L.push('                  on = fn;')
  L.push('                  if (typeof fn === "function") {')
  L.push("                    add.call(pc, 'icecandidate', function (e) { var c = _keep(e); if (c) { fn.call(pc, c); } });")
  L.push('                  }')
  L.push('                }), "set onicecandidate", 1)')
  L.push('              });')
  L.push('            } catch (e) {}')
  L.push('          };')
  L.push('          var _PC = function (cfg) { var pc = new RTC(cfg); _guard(pc); return pc; };')
  L.push('          _PC.prototype = RTC.prototype;')
  L.push('          try { Object.setPrototypeOf(_PC, RTC); } catch (e) {}')
  // 同 Intl：不修 constructor，`RTCPeerConnection.prototype.constructor` 就还是原生的，
  // 一次读取就能拿回未加固的构造器绕开 _guard
  L.push('          try { Object.defineProperty(RTC.prototype, "constructor", { value: _PC, configurable: true, writable: true }); } catch (e) {}')
  // 原生 RTCPeerConnection.name === "RTCPeerConnection"、length === 0，
  // 包装函数不改就是 "_PC" / 1 —— 一次 name 读取就能确认被 hook
  L.push('          try {')
  L.push('            Object.defineProperty(_PC, "name", { value: "RTCPeerConnection", configurable: true });')
  L.push('            Object.defineProperty(_PC, "length", { value: 0, configurable: true });')
  L.push('          } catch (e) {}')
  L.push('          window.RTCPeerConnection = _PC;')
  L.push('        }')
  L.push('      }')
  L.push('    } catch (e) {}')

  /* 音频：AnalyserNode 只覆盖了实时分析，离线渲染（OfflineAudioContext）走的是
     AudioBuffer.getChannelData，那条路不堵住，音频指纹就是全网唯一的真实值 */
  L.push('')
  L.push('    try {')
  L.push('      if (C.audioNoise && window.AudioBuffer) {')
  L.push('        var _AB = AudioBuffer.prototype;')
  L.push('        var _gcd = _AB.getChannelData;')
  L.push('        var _seen = typeof WeakSet === "function" ? new WeakSet() : null;')
  L.push('        _AB.getChannelData = function (ch) {')
  L.push('          var data = _gcd.call(this, ch);')
  L.push('          if (_seen) { if (_seen.has(data)) { return data; } _seen.add(data); }')
  L.push('          for (var i = 0; i < data.length; i += 997) {')
  L.push('            var kk = h32(i, ch, 13, 5) % 2000;')
  L.push('            data[i] += (kk - 1000) / 1e9;')
  L.push('          }')
  L.push('          return data;')
  L.push('        };')
  L.push('      }')
  L.push('    } catch (e) {}')

  /* client rects */
  L.push('')
  L.push('    try {')
  L.push('      if (C.rectNoise) {')
  L.push('        var EP = Element.prototype;')
  L.push('        var _jit = function (v, s) {')
  L.push('          var q = Math.round(v * 100);')
  L.push('          var k = h32(q, s, 11, 7) % 2000;')
  L.push('          return v + (k - 1000) / 100000;')
  L.push('        };')
  L.push('        var _mk = function (r) {')
  L.push('          var x = _jit(r.left, 1), y = _jit(r.top, 2);')
  L.push('          var w = _jit(r.width, 3), h = _jit(r.height, 4);')
  L.push('          try {')
  L.push('            return new DOMRect(x, y, w, h);')
  L.push('          } catch (e) {')
  L.push('            return { x: x, y: y, width: w, height: h, left: x, top: y, right: x + w, bottom: y + h };')
  L.push('          }')
  L.push('        };')
  L.push('        var _gbcr = EP.getBoundingClientRect;')
  L.push('        EP.getBoundingClientRect = function () { return _mk(_gbcr.call(this)); };')
  L.push('        var _gcr = EP.getClientRects;')
  L.push('        EP.getClientRects = function () {')
  L.push('          var src = _gcr.call(this), out = [];')
  L.push('          for (var i = 0; i < src.length; i++) { out.push(_mk(src[i])); }')
  L.push('          out.item = function (i) { return this[i] || null; };')
  L.push('          return out;')
  L.push('        };')
  L.push('      }')
  L.push('    } catch (e) {}')

  /* fonts */
  L.push('')
  L.push('    try {')
  L.push('      if (C.fonts && C.fonts.length && document.fonts && document.fonts.check) {')
  L.push('        var WL = {};')
  L.push('        for (var fi = 0; fi < C.fonts.length; fi++) { WL[C.fonts[fi].toLowerCase()] = 1; }')
  L.push("        var GEN = { 'serif': 1, 'sans-serif': 1, 'monospace': 1, 'cursive': 1, 'fantasy': 1, 'system-ui': 1 };")
  L.push('        var QUOTE = /\\x22([^\\x22]+)\\x22|\'([^\']+)\'/g;')
  L.push('        var _fams = function (s) {')
  L.push('          var out = [], m;')
  L.push('          QUOTE.lastIndex = 0;')
  L.push('          while ((m = QUOTE.exec(s))) { out.push(String(m[1] || m[2]).toLowerCase()); }')
  L.push('          if (!out.length) {')
  L.push('            var parts = String(s).split(/\\s+/), cut = -1;')
  L.push('            for (var i = 0; i < parts.length; i++) {')
  L.push("              if (/^[\\d.]+(px|pt|em|rem|%)$/.test(parts[i])) { cut = i; break; }")
  L.push('            }')
  L.push('            if (cut >= 0) {')
  L.push("              var rest = parts.slice(cut + 1).join(' ').split(',');")
  L.push('              for (var j = 0; j < rest.length; j++) {')
  L.push("                var name = rest[j].trim().toLowerCase();")
  L.push('                if (name) { out.push(name); }')
  L.push('              }')
  L.push('            }')
  L.push('          }')
  L.push('          return out;')
  L.push('        };')
  L.push('        var _check = document.fonts.check;')
  L.push('        document.fonts.check = function (font) {')
  L.push('          try {')
  L.push('            var list = _fams(String(font));')
  L.push('            for (var i = 0; i < list.length; i++) {')
  L.push('              if (WL[list[i]] || GEN[list[i]]) { return true; }')
  L.push('            }')
  L.push('            if (list.length) { return false; }')
  L.push('          } catch (e) {}')
  L.push('          return _check.apply(document.fonts, arguments);')
  L.push('        };')

  // document.fonts.check 只挡住一条路。更常见的探测是 canvas measureText：
  // 换字体量同一串字，宽度不同就说明字体存在。macOS 环境里测出 Consolas
  // 就等于告诉对方「这台机器其实是 Windows」。
  L.push('')
  L.push('        if (window.CanvasRenderingContext2D) {')
  L.push('          var _mt = CanvasRenderingContext2D.prototype.measureText;')
  L.push('          var _probe = document.createElement("canvas").getContext("2d");')
  L.push('          var _miss = {};')
  L.push('          var _bare = function (s) { return String(s).replace(/["\']/g, "").trim().toLowerCase(); };')
  L.push('          CanvasRenderingContext2D.prototype.measureText = function (text) {')
  L.push('            try {')
  L.push('              var f = this.font || "";')
  L.push('              var m = /([0-9.]+)px\\s+(.+)$/.exec(f);')
  L.push('              if (m && _probe) {')
  L.push('                var fams = m[2].split(",");')
  L.push('                // 注意转小写：WL 的键是小写的，这里漏了就会让白名单永远命中不了，')
  L.push('                // 结果是连 Arial 都被判成「不存在」——比不伪装更像机器人')
  L.push('                var first = _bare(fams[0]);')
  L.push('                if (first && !GEN[first]) {')
  L.push('                  var fb = _bare(fams[fams.length - 1]) || "sans-serif";')
  L.push('                  if (fb === first) { fb = "sans-serif"; }')
  L.push('                  if (!WL[first]) {')
  L.push('                    // 不在目标系统的字体表里 → 一律按 fallback 量，假装没有')
  L.push('                    _probe.font = m[1] + "px " + fb;')
  L.push('                    return _mt.call(_probe, text);')
  L.push('                  }')
  L.push('                  // 在表里，但宿主机可能根本没装（macOS 环境的 Helvetica Neue')
  L.push('                  // 跑在 Windows 上）。量出来和 fallback 等宽就说明缺字，')
  L.push('                  // 补一个确定性偏移，让探测方看到「存在且宽度不同」。')
  L.push('                  var miss = _miss[f];')
  L.push('                  if (miss === undefined) {')
  L.push('                    var w1 = _mt.call(this, "mmmmmmmmmmlli").width;')
  L.push('                    _probe.font = m[1] + "px " + fb;')
  L.push('                    var w2 = _mt.call(_probe, "mmmmmmmmmmlli").width;')
  L.push('                    miss = Math.abs(w1 - w2) > 0.1 ? 0 : 1;')
  L.push('                    _miss[f] = miss;')
  L.push('                  }')
  L.push('                  if (miss) {')
  L.push('                    var mt = _mt.call(this, text);')
  L.push('                    _probe.font = m[1] + "px " + fb;')
  L.push('                    var wf = _mt.call(_probe, text).width;')
  L.push('                    var dl = 0.2 + (h32(String(text).length, first.length, 7, 3) % 400) / 1000;')
  L.push('                    try { Object.defineProperty(mt, "width", { value: wf + dl, configurable: true }); } catch (e) {}')
  L.push('                    return mt;')
  L.push('                  }')
  L.push('                }')
  L.push('              }')
  L.push('            } catch (e) {}')
  L.push('            return _mt.apply(this, arguments);')
  L.push('          };')
  L.push('        }')
  L.push('      }')
  L.push('    } catch (e) {}')

  /* webgpu */
  L.push('')
  L.push('    try {')
  L.push('      if (!C.webgpu) {')
  L.push("        var removed = false;")
  L.push("        try { removed = delete Navigator.prototype.gpu; } catch (e) {}")
  L.push("        if (!removed) { defVal(Navigator.prototype, 'gpu', undefined); }")
  L.push('      }')
  L.push('    } catch (e) {}')

  /* 反检测：被改过的函数必须自称 native。
     Function.prototype.toString.call(fn) 返回一段 JS 源码，是最高频的机器人检测之一
     （creepjs 的 Prototype / JS Proxy 两项就在打分）。只要有一处露馅，
     前面所有的伪装都白做 —— 所以这一步放在最后，把所有动过的地方统一收口。 */
  L.push('')
  L.push('    try {')
  L.push('      // 原生方法 / getter / setter 都没有 prototype，普通函数字面量有。')
  L.push('      // 于是 `"prototype" in fn` 一行就能把整张 hook 清单枚举出来 ——')
  L.push('      // 比 toString 泄漏更彻底，而且这个洞恰恰是「用函数字面量做包装」这个修法自己造的。')
  L.push('      // 方法简写既没有 prototype 又保留 this 绑定，是这里唯一能同时满足两边的形态。')
  L.push('      // _noProto 在脚本顶部声明（geolocation / 音频 / WebRTC 中途就要用）')
  L.push('      // 传进来的可能已经是原生函数；重复登记不改变行为，输出仍是 native 串')
  L.push('      var _maskAt = function (obj, prop, nm, keepProto) {')
  L.push('        try {')
  L.push('          var d = Object.getOwnPropertyDescriptor(obj, prop);')
  L.push('          if (!d) { return; }')
  L.push('          if (typeof d.get === "function" || typeof d.set === "function") {')
  L.push('            // accessor 一律去掉 prototype：原生 getter 从来没有 prototype')
  L.push('            Object.defineProperty(obj, prop, {')
  L.push('              configurable: d.configurable, enumerable: d.enumerable,')
  L.push('              get: typeof d.get === "function" ? _maskOne(_noProto(d.get), "get " + nm, 0) : d.get,')
  L.push('              set: typeof d.set === "function" ? _maskOne(_noProto(d.set), "set " + nm, 1) : d.set')
  L.push('            });')
  L.push('            return;')
  L.push('          }')
  L.push('          if (typeof d.value === "function") {')
  L.push('            // 构造器必须保留 prototype（原生构造器本来就有），普通方法必须去掉')
  L.push('            var f = keepProto ? d.value : _noProto(d.value);')
  L.push('            if (f !== d.value) {')
  L.push('              Object.defineProperty(obj, prop, {')
  L.push('                configurable: d.configurable, enumerable: d.enumerable, writable: d.writable, value: f')
  L.push('              });')
  L.push('            }')
  L.push('            _maskOne(f, nm);')
  L.push('          }')
  L.push('        } catch (e) {}')
  L.push('      };')
  L.push('      var _maskAll = function (obj, names, keepProto) {')
  L.push('        for (var i = 0; i < names.length; i++) { _maskAt(obj, names[i], names[i], keepProto); }')
  L.push('      };')
  L.push('')
  L.push('      _maskAll(Navigator.prototype, ["userAgent", "appVersion", "platform", "vendor",')
  L.push('        "hardwareConcurrency", "deviceMemory", "language", "languages", "webdriver",')
  L.push('        "pdfViewerEnabled", "plugins", "mimeTypes", "maxTouchPoints", "gpu"]);')
  L.push('      _maskAll(Screen.prototype, ["width", "height", "availWidth", "availHeight", "colorDepth", "pixelDepth"]);')
  L.push('      _maskAll(window, ["devicePixelRatio"]);')
  L.push('      _maskAll(Date.prototype, ["getTimezoneOffset", "toTimeString", "toDateString", "toString",')
  L.push('        "toLocaleString", "toLocaleDateString", "toLocaleTimeString", "getFullYear", "getMonth",')
  L.push('        "getDate", "getDay", "getHours", "getMinutes", "getSeconds"]);')
  L.push('      _maskAll(Element.prototype, ["getBoundingClientRect", "getClientRects"]);')
  L.push('      if (window.AudioBuffer) { _maskAll(AudioBuffer.prototype, ["getChannelData"]); }')
  L.push('      if (window.CanvasRenderingContext2D) {')
  L.push('        _maskAll(CanvasRenderingContext2D.prototype, ["measureText", "getImageData"]);')
  L.push('      }')
  L.push('      if (window.HTMLCanvasElement) { _maskAll(HTMLCanvasElement.prototype, ["toDataURL", "toBlob"]); }')
  L.push('      if (window.WebGLRenderingContext) { _maskAll(WebGLRenderingContext.prototype, ["getParameter"]); }')
  L.push('      if (window.WebGL2RenderingContext) { _maskAll(WebGL2RenderingContext.prototype, ["getParameter"]); }')
  L.push('      if (document.fonts) { _maskAt(document.fonts, "check", "check"); }')
  L.push('      if (window.speechSynthesis) { _maskAt(speechSynthesis, "getVoices", "getVoices"); }')
  // 这三组是中途 patch 的，早期版本的台账声明在末尾，它们根本登记不上，
  // 于是 toString() 直接吐出 `function (ok) { _reply(ok); }` 这种源码
  L.push('      if (window.Geolocation) { _maskAll(Geolocation.prototype, ["getCurrentPosition", "watchPosition"]); }')
  L.push('      if (window.AnalyserNode) { _maskAll(AnalyserNode.prototype, ["getFloatFrequencyData"]); }')
  L.push('      if (window.RTCPeerConnection) {')
  // 构造器必须保留 prototype，方法必须去掉 —— keepProto 只在构造器这里为 true
  L.push('        _maskOne(window.RTCPeerConnection, "RTCPeerConnection");')
  L.push('        _maskAll(window.RTCPeerConnection.prototype, ["createDataChannel", "createOffer", "addEventListener"]);')
  L.push('      }')
  L.push('      if (window.Intl) {')
  L.push('        _maskOne(Intl.DateTimeFormat, "DateTimeFormat");')
  L.push('        _maskOne(Intl.NumberFormat, "NumberFormat");')
  L.push('        _maskOne(Intl.Collator, "Collator");')
  L.push('        _maskOne(Intl.RelativeTimeFormat, "RelativeTimeFormat");')
  L.push('        _maskOne(Intl.PluralRules, "PluralRules");')
  L.push('        _maskOne(Intl.ListFormat, "ListFormat");')
  L.push('        _maskOne(Intl.DisplayNames, "DisplayNames");')
  L.push('        _maskOne(Intl.Segmenter, "Segmenter");')
  L.push('      }')
  L.push('')
  L.push('      var _fts = Function.prototype.toString;')
  // toString 自己也是方法，原生没有 prototype，所以同样要走 _noProto
  L.push('      var _patched = _maskOne(_noProto(function () {')
  L.push('        for (var i = 0; i < _masked.length; i++) {')
  L.push('          if (_masked[i] === this) { return _fakeSrc(String(this.name || "")); }')
  L.push('        }')
  L.push('        return _fts.call(this);')
  L.push('      }), "toString", 0);')
  L.push('      Function.prototype.toString = _patched;')
  L.push('    } catch (e) {}')

  L.push('  } catch (e) {}')
  L.push('})();')

  return L.join('\n')
}

/* ────────────────────────────── 摘要 ────────────────────────────── */

/** 卡片上展示的一句话摘要，给 UI 用 */
export function fingerprintSummary(fp: FingerprintConfig): {
  os: string
  screen: string
  timezone: string
  webgl: string
} {
  return {
    os: fp.osLabel,
    screen: fp.screen.width + '×' + fp.screen.height + ' @' + fp.screen.dpr + 'x',
    timezone: fp.timezone,
    webgl: shortRenderer(fp.webgl.renderer)
  }
}

/** ANGLE 字符串太长，卡片上只留 GPU 型号 */
function shortRenderer(renderer: string): string {
  const angle = /ANGLE \([^,]+,\s*([^,)]+)/.exec(renderer)
  if (angle) return angle[1].trim()
  return renderer.length > 40 ? renderer.slice(0, 40) + '…' : renderer
}
