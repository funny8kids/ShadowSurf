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
import { safeStorage } from 'electron'
import { filePath } from '@main/store/db'
import { TIMEZONE_GEO, resolveFingerprint } from '@shared/presets'
import type { FingerprintConfig, OSKind, Profile, StoredProfile } from '@shared/types'

/* ────────────────────────────── 主密钥 ────────────────────────────── */

const MASTER_KEY_FILE = 'master.key'
const HKDF_SALT = 'shadowsurf'

/**
 * 主密钥的落盘前缀。
 *
 * 旧格式是**裸 32 字节随机数** —— 拿到这个文件就能直接当 HKDF 的 ikm 用，
 * 于是「所有环境的指纹」全都能重算出来。它和 profiles.json 躺在同一个目录里，
 * 所以任何一次目录拷贝都同时拿到锁和钥匙。
 *
 * 现在用 Electron 的 safeStorage（Windows 走 DPAPI，按当前登录用户加密）包一层，
 * 前缀标明格式，便于将来换算法（v2）和识别降级形态。
 */
const MASTER_KEY_PREFIX = 'SSKEYv1:'

let cachedMaster: Buffer | null = null

/** 把 32 字节密钥写成 SSKEYv1 形态；safeStorage 不可用时返回 false，由调用方决定怎么办 */
function writeWrapped(file: string, key: Buffer): boolean {
  let payload: string
  try {
    if (!safeStorage.isEncryptionAvailable()) return false
    payload = safeStorage.encryptString(key.toString('hex')).toString('base64')
  } catch {
    return false
  }

  writeAtomic(file, MASTER_KEY_PREFIX + payload)
  return true
}

/**
 * 原子写。
 *
 * 这个文件是**全机所有身份的根**：写到一半崩掉（断电、被杀进程、杀软拦写）
 * 会留下一个截断的 `master.key`，而 `masterKey()` 对「长度不足且无前缀」的
 * 形态是**抛错**的 —— 于是所有环境的指纹派生一起失效。
 *
 * 用 tmp + rename 之后，最坏情况是「旧文件还在、tmp 是垃圾」，也就是零损失。
 * 这也是 `json-file.ts` 对数据文件用的同一套做法；根密钥没有任何理由比数据文件弱。
 */
function writeAtomic(file: string, data: Buffer | string): void {
  const tmp = file + '.tmp'
  const fd = fs.openSync(tmp, 'w', 0o600)
  try {
    fs.writeFileSync(fd, data)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, file)
  try {
    // Windows 上 chmod 是近似实现，失败也无所谓
    fs.chmodSync(file, 0o600)
  } catch {
    /* ignore */
  }
}

/**
 * 本机主密钥：32 字节随机数，首次运行时生成并落盘（0600）。
 * 所有 profile 的 seed 都由它派生，所以这个文件就是「这台机器上所有身份」的根。
 * 泄露它 = 泄露所有环境的指纹规律；丢了它 = 所有环境指纹全部漂移。
 *
 * 读取顺序：
 *   1. `SSKEYv1:` 前缀 → safeStorage 解密（正常路径）
 *   2. 恰好 32 字节 → 旧裸密钥，**照常使用**，并尽力就地封装回写
 *   3. 其它 → 抛错。不猜、不重建：把损坏的根密钥当成「没有根密钥」去生成新的，
 *      会让所有环境的噪声静默漂移，而用户完全看不出发生了什么。
 *
 * 注意用的是同步版 safeStorage API（本版本标了 deprecated）。
 * 换异步版要把 masterKey / deriveSeed / create / clone / regenerate 一路改成 async，
 * 改动面远超本次范围；同步版仍然可用，这里显式记一笔，避免后来人以为是无意为之。
 */
export function masterKey(): Buffer {
  if (cachedMaster !== null) return cachedMaster
  const file = filePath(MASTER_KEY_FILE)

  let existing: Buffer | null = null
  try {
    existing = fs.readFileSync(file)
  } catch {
    /* 首次运行，继续走生成分支 */
  }

  if (existing !== null) {
    const text = existing.toString('utf8')

    if (text.startsWith(MASTER_KEY_PREFIX)) {
      let key: Buffer
      try {
        const hex = safeStorage.decryptString(
          Buffer.from(text.slice(MASTER_KEY_PREFIX.length), 'base64')
        )
        key = Buffer.from(hex, 'hex')
      } catch (err) {
        // 换机器 / 换用户 / 系统重装都会走到这里：DPAPI 解不开别人的密文。
        // 宁可明确报错，也不要静默换一把新密钥 —— 那等于把所有环境的噪声改掉。
        throw new Error(
          '主密钥无法解密（' + String(err instanceof Error ? err.message : err) + '）：' +
            'safeStorage 的密钥绑定当前系统用户与这台机器。' +
            '如果你是从别的机器/用户拷来的数据目录，指纹噪声将无法保持一致。'
        )
      }
      if (key.length < 32) {
        throw new Error(`主密钥解密后长度不足 32 字节（实际 ${key.length}）`)
      }
      cachedMaster = key
      return key
    }

    if (existing.length >= 32) {
      // 旧裸密钥：先按原样用，再尝试封装。封装失败不影响本次运行，
      // 但会留下「仍是裸密钥」的状态，verify-seed-at-rest 会如实报出来。
      const legacy = existing.subarray(0, 32)
      cachedMaster = legacy
      if (!writeWrapped(file, legacy)) {
        console.warn(
          '[fingerprint] safeStorage 不可用，主密钥仍以裸 32 字节落盘。' +
            '这台机器上「拿到数据目录 = 拿到全部指纹」的前提没有解除。'
        )
      }
      return legacy
    }

    throw new Error(`主密钥文件形态无法识别（${existing.length} 字节，且无 ${MASTER_KEY_PREFIX} 前缀）`)
  }

  const fresh = randomBytes(32)
  if (!writeWrapped(file, fresh)) {
    // 降级形态也走原子写：这个文件写坏 = 全机身份派生一起失效，没有理由在
    // 「加密不可用」这条更脆弱的路径上反而把写保护去掉。
    writeAtomic(file, fresh)
    console.warn(
      '[fingerprint] safeStorage 不可用，主密钥以裸 32 字节落盘。' +
        '这台机器上「拿到数据目录 = 拿到全部指纹」的前提没有解除。'
    )
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
/* ────────────────────────── 多 target 注入源 ────────────────────────── */

/**
 * 注入目标。
 *
 * 为什么必须区分：`Page.addScriptToEvaluateOnNewDocument` 只作用于 document。
 * Worker 是**独立 target**，全局是 `WorkerGlobalScope`：没有 `Navigator` / `window` /
 * `document` / `Screen` / `Element` / `HTMLCanvasElement` / `CanvasRenderingContext2D`。
 * 把 page 那份 source 原样灌进 Worker，`_MASK_TABLE` 第一项 `[Navigator.prototype, …]`
 * 就抛 ReferenceError，被外层 catch 吞掉，**后面一行都不执行**——不报错、不生效，
 * 是「看起来装了其实没装」的典型。实测（真 Chromium）Worker 相对宿主零改动。
 *
 * iframe 与 page 同源：OOPIF 是独立进程的 document，window/document/canvas 都在，
 * 只是需要按 target 单独下一遍（page 级注入到不了跨进程子帧）。
 */
export type InjectionTarget = 'page' | 'worker' | 'iframe'

/**
 * 注入脚本要的那个 Profile —— 必须带明文 seed（脚本里要拿它做扰动）。
 *
 * 曾经直接写成 `Profile`，而 `Profile` 现在不含 seed 了（seed 不出主进程），
 * 于是这个别名必须指到内部形态，否则 `buildInjectionScript(profile)` 会在
 * 调用点报「缺 seed」—— 那个报错是对的，它说明调用方手里拿的是对外形态。
 */
export type FingerprintProfile = StoredProfile

/**
 * Worker 专用注入源。
 *
 * 与 page 版的三个结构性差异（不是「少几段」那么简单）：
 * 1. navigator 的原型是 `WorkerNavigator.prototype`，不是 `Navigator.prototype` ——
 *    必须用 `Object.getPrototypeOf(self.navigator)` 动态取，写死接口名会静默空转。
 * 2. 表要重写：page 表里的 `Screen` / `window` / `Element` / `HTMLCanvasElement` /
 *    `CanvasRenderingContext2D` 在 Worker 里不存在，**不声明**（而不是声明了再失败）。
 * 3. 伪装层必须整层搬。`defVal` 是 `defGet` 的封装，装上去的**全是 accessor**；
 *    不搬 `_maskOne` / `Function.prototype.toString` 的话，
 *    `getOwnPropertyDescriptor(proto, 'hardwareConcurrency').get.toString()`
 *    会直接吐出 `function () { return 12; }` —— 比不伪装更容易被判定插桩。
 *
 * 台账与失败语义（不留任何全局）：
 * 三本账留在 IIFE 闭包里 —— `_applied` / `_failed` / `_skipped`。
 * 任一属性失败**不回滚**，脚本末尾抛 `[ss-mask] applied=… failed=…`。
 *
 * 为什么放弃「整体回滚」：回滚只撤得掉 `defGet`/`defMethod` 登记的项，
 * 而 `Intl.DateTimeFormat = _Patched`、`Intl[nm] = W` 是裸赋值，撤不掉 ——
 * 回滚后的终态恰恰是它想消灭的矛盾（Intl 说伪装时区、Date 说宿主时区）。
 * 而且回滚的终态是「零伪装 = 真实指纹 100% 泄露」，比坏一个属性更差。
 * 详见脚本里「`_rollback` 已删除」那段注释。
 *
 * 失败怎么被看见：不靠页面自报。早先往 self 上挂过一个诊断全局（SS_DIAG），
 * 一行 `Object.getOwnPropertyNames(self)` 就能看到，等于自己给检测方留标记，
 * 已被 `tests/structure.test.ts` 的「dev-only 诊断通道不得出现在构建产物里」挡下。
 * 现在改成抛错（`Runtime.evaluate` 会放进 `exceptionDetails`，页面删不掉），
 * 外加主进程 resume 后读实际值跟 profile 比对 —— 两条都不需要页面配合。
 *
 * 为什么这里**没有** WebRTC 那一段（别「补全」它）：
 * `RTCPeerConnection` / `RTCRtpSender` / `RTCRtpReceiver` 在 Worker 里都是
 * `undefined` —— 规范上是 `[Exposed=Window]`，实测见
 * `artifacts/probe-shared-worker.json`。在一个本来没有这个接口的上下文里
 * 凭空造一个出来，比不注入更容易被判定：属性**存在性**是比属性值更硬的指纹。
 * 这条事实由 `verify:anticheat` 的 AC-23 守着 —— 哪天内核真的把它开进 Worker，
 * AC-23 会红，那时才该在这里加候选过滤，而不是现在先写一段死代码。
 */
function buildWorkerScript(fp: FingerprintConfig, seed: string): string {
  const cfg = injectionConfig(fp, seed)
  const json = JSON.stringify(cfg).replace(/</g, '\\u003c')
  const L: string[] = []

  L.push('(function () {')
  L.push('  var T = "worker";')
  L.push('  var C = ' + json + ';')
  L.push('  var S = C.seed | 0;')
  L.push("  var _LOC = (C.languages && C.languages.length) ? C.languages[0] : (C.locale || 'en-US');")
  // 三本账，**全部留在 IIFE 闭包里，不对外暴露**：
  //   `_applied` —— 装成功的属性名；
  //   `_failed`  —— 装失败的属性名 + 原因（**非空就抛错**，见脚本末尾）；
  //   `_skipped` —— 原生就没有的属性，按「不该造」跳过（不算失败，见 defGet）。
  // 早先还有一个 `__SS_DIAG__` 全局把它们挂到 self 上，已按裁决删除：
  // 一行 `Object.getOwnPropertyNames(self)` 就能看到它，等于自己给检测方留标记。
  L.push('  var _applied = [];')
  L.push('  var _failed = [];')
  L.push('  var _skipped = [];')
  L.push('  var _masked = [];')
  L.push('')
  L.push('  var _fakeSrc = function (nm) { return "function " + nm + "() { [native code] }"; };')
  L.push('  var _noProto = function (fn) {')
  L.push('    try { return { f() { return fn.apply(this, arguments); } }.f; } catch (e) { return fn; }')
  L.push('  };')
  L.push('  var _maskOne = function (fn, nm, len) {')
  L.push('    if (typeof fn !== "function") { return fn; }')
  L.push('    try { Object.defineProperty(fn, "name", { value: nm, configurable: true }); } catch (e) {}')
  // 原生方法的 length 是外部事实（`getParameter` 是 1 参、`toTimeString` 是 0 参），
  // 换掉之后再也推导不出来。不还原的话 `f.length` 一行就能判定被换过。
  L.push('    try { if (typeof len === "number") { Object.defineProperty(fn, "length", { value: len, configurable: true }); } } catch (e) {}')
  L.push('    _masked.push(fn);')
  L.push('    return fn;')
  L.push('  };')
  L.push('')
  // 声明：只登记「这个属性属于本次要改的清单」，真正的 apply 在 defGet 里做。
  // 分开是为了让「声明了但没改成功」和「压根没声明」在台账里可区分。
  L.push('  var defGet = function (o, p, fn) {')
  L.push('    if (!o) { _failed.push({ p: p, why: "宿主对象不存在" }); return; }')
  L.push('    try {')
  L.push('      var d = Object.getOwnPropertyDescriptor(o, p);')
  // **原生没有的属性不创建。**
  // 早先这里是 `had: !!d` 然后照装不误，于是在 http:// 这类非安全上下文里，
  // `[SecureContext]` 的属性（`navigator.deviceMemory` 之类）本来**不存在**，
  // 却被我们凭空造了一个出来。属性**存在性**是比属性值更硬的指纹：
  // 一个本该没有 deviceMemory 的页面有了它，比「值不对」更容易被判定。
  // 跳过不算失败 —— 那正是原生真相，所以记 `_skipped` 而不是 `_failed`。
  L.push('      if (!d) { _skipped.push(p); return; }')
  // getter 也必须走 `_noProto` + `"get " + p`，两条都是一行就能查的：
  //   `"prototype" in getOwnPropertyDescriptor(P,"x").get`   → 原生 false，裸函数 true
  //   `...get.toString()`                                    → 原生 "function get x() { [native code] }"
  // 少了这两处，Worker 里的 accessor 和 page 里的长得不一样，
  // 而「同一个属性在两个上下文里 toString 不同」本身就是判定插桩的充分条件。
  L.push('      var g = _maskOne(_noProto(fn), "get " + p, 0);')
  L.push('      Object.defineProperty(o, p, {')
  L.push('        configurable: d.configurable !== false,')
  L.push('        enumerable: d.enumerable,')
  L.push('        get: g')
  L.push('      });')
  L.push('      _applied.push(p);')
  // getter 也要进伪装台账：`defVal` 装的是 accessor，不登记的话
  // `getOwnPropertyDescriptor(proto, "hardwareConcurrency").get.toString()`
  // 会直接吐出 `function () { return v; }` —— 比不伪装更容易被判定插桩。
  // （`_maskOne` 已在上面调过，这里不再重复登记。）
  L.push('    } catch (e) {')
  // 这一层最阴：属性不可配置时 defineProperty 会抛，被这里吞掉就是「这一个属性
  // 静默保持原生」。块级 try 和枚举截断都看不见它，只有台账能看见。
  L.push('      _failed.push({ p: p, why: String((e && e.message) || e) });')
  L.push('    }')
  L.push('  };')
  L.push('  var defVal = function (o, p, v) { defGet(o, p, function () { return v; }); };')
  // 方法必须保持「数据属性」形态。
  // 用 defGet 把 `Date.prototype.getTimezoneOffset` 换成 accessor 会出事：
  // 之后任何一次 `Date.prototype.getTimezoneOffset` 的**读取**都会触发 getter，
  // 而 getter 里 `this` 是 prototype 不是 Date，直接抛 "this is not a Date object"。
  // 原生方法本来就是 value 属性，这里照原样装回去，形态也才不会被查出来。
  L.push('  var defMethod = function (o, p, fn) {')
  L.push('    if (!o) { _failed.push({ p: p, why: "宿主对象不存在" }); return; }')
  L.push('    try {')
  L.push('      var d = Object.getOwnPropertyDescriptor(o, p);')
  L.push('      if (!d) { _skipped.push(p); return; }')
  // 原生方法同样是**没有 prototype 的 concise method**，而且 length 是外部事实。
  // 裸函数装回去的话 `"prototype" in Date.prototype.getHours` 立刻为 true —— 一行可查。
  L.push('      var _len = (typeof d.value === "function") ? d.value.length : fn.length;')
  L.push('      var m = _maskOne(_noProto(fn), p, _len);')
  L.push('      Object.defineProperty(o, p, {')
  L.push('        value: m,')
  L.push('        writable: d.writable !== false,')
  L.push('        enumerable: d.enumerable,')
  L.push('        configurable: d.configurable !== false')
  L.push('      });')
  L.push('      _applied.push(p);')
  L.push('    } catch (e) { _failed.push({ p: p, why: String((e && e.message) || e) }); }')
  L.push('  };')
  L.push('')
  // `_rollback` 已删除 —— 这里**刻意**不留「整体回滚」。
  //
  // 早先的策略是「任一属性失败 → 撤销本次全部 apply」，理由是「半伪装会自证」。
  // 实测把它推翻了：回滚只撤得掉 `defGet`/`defMethod` 登记的项，而
  // `Intl.DateTimeFormat = _Patched` 和 `Intl[nm] = W` 是**裸赋值**，撤不掉。
  // 于是回滚后的终态恰恰是它想消灭的那个矛盾：
  //   `Intl.DateTimeFormat().resolvedOptions().timeZone` = 伪装值（还在）
  //   `new Date().getTimezoneOffset()`                  = 宿主值（已撤）
  // 同一个上下文两个时区 —— 回滚亲手制造了它。
  //
  // 更要命的是终态本身：回滚 = 零伪装 = 真实指纹 100% 泄露。
  // 25 个属性里坏 1 个，回滚等于把另外 24 个好的也扔掉。部分伪装只漏那 1 个。
  // 所以现在的策略是：**保留部分伪装 + 完整失败台账 + 失败时抛错**。
  //
  // 抛错而不是挂全局：
  //   · 生产路径 —— `Runtime.evaluate` 把它放进 `exceptionDetails`，主进程读得到；
  //   · 探针路径 —— `new Function(src)()` 直接抛，探针 catch 得到；
  //   · 零全局、零 console。页面删得掉属性，删不掉已经返回给调试器的异常。
  L.push('')
  // 这里**不**往页面/Worker 上留任何诊断全局。
  //
  // 早先有一个诊断全局 SS_DIAG（declared / applied / failed / rolledBack），
  // 被 `tests/structure.test.ts` 的「dev-only 诊断通道不得出现在构建产物里」挡下：
  // 这个字符串会原样进 `out/main/index.js`，等于我们自己给检测方留了一个
  // 「哪些 Intl 构造器被接管过」的标记 —— 比不伪装更容易判定。
  // 用运行期判断（`process.env.NODE_ENV`）消不掉它，打包后那个值常常是 undefined；
  // 而注入脚本是**运行时拼出来的字符串**，vite 的 `define` 也够不到它。
  // 所以结论是：一个全局都不留。
  //
  // 那「回滚发生了」怎么被看见？—— 由主进程在 `Runtime.runIfWaitingForDebugger`
  // 之后对同一个 session 做一次 `Runtime.evaluate`，读 `navigator.hardwareConcurrency`
  // 之类的值跟 profile 比对。整体回滚后这些值会退回宿主值，一比就出来。
  // 这条路不需要任何页面内全局，也不需要 console（console 同样是页面可见的 tell）。
  // 它落在 cdp.ts / windows.ts 那条链路上，不在这里。
  L.push('')
  L.push('  try {')
  // ── navigator ────────────────────────────────────────────────────────
  // 关键：Worker 里没有 `Navigator` 这个构造器，navigator 的原型是
  // `WorkerNavigator.prototype`。写死 `Navigator.prototype` 会抛 ReferenceError。
  L.push('    var NP = Object.getPrototypeOf(self.navigator);')
  L.push('    defVal(NP, "userAgent", C.ua);')
  L.push('    defVal(NP, "appVersion", C.appVersion);')
  L.push('    defVal(NP, "platform", C.platform);')
  L.push('    defVal(NP, "vendor", C.vendor);')
  L.push('    defVal(NP, "hardwareConcurrency", C.cores);')
  L.push('    defVal(NP, "deviceMemory", C.memory);')
  L.push('    defVal(NP, "language", C.languages[0]);')
  L.push('    defGet(NP, "languages", function () { return C.languages.slice(); });')
  L.push('    defVal(NP, "webdriver", false);')
  L.push('    defVal(NP, "pdfViewerEnabled", true);')
  L.push('')
  // ── Intl：locale 与 timeZone 都必须接管 ──────────────────────────────
  // 不接管 timeZone 的话 `resolvedOptions().timeZone` 报宿主，而
  // `getTimezoneOffset` 报伪装值 —— 同一页面两个时区，不需要参照值就能判定。
  L.push('    var _DTF = Intl.DateTimeFormat;')
  L.push('    var _lang = _LOC;')
  L.push('    var _Patched = function (locales, options) {')
  L.push('      var o = {};')
  L.push('      if (options) { for (var k in options) { o[k] = options[k]; } }')
  L.push('      if (!o.timeZone) { o.timeZone = C.tz; }')
  L.push('      if (locales === undefined || locales === null) { locales = _lang; }')
  L.push('      return new _DTF(locales, o);')
  L.push('    };')
  L.push('    _Patched.prototype = _DTF.prototype;')
  L.push('    try { Object.defineProperty(_Patched, "name", { value: "DateTimeFormat", configurable: true }); } catch (e) {}')
  L.push('    try { Object.defineProperty(_DTF.prototype, "constructor", { value: _Patched, configurable: true, writable: true }); } catch (e) {}')
  L.push('    Intl.DateTimeFormat = _Patched;')
  L.push('    _maskOne(_Patched, "DateTimeFormat");')
  L.push('')
  // `_parts` 必须写死 "en-US"，**不能**跟 `_LOC`。它不产出给页面看的字符串，
  // 只喂下面 :596 的 `parseInt(arr[i].value, 10)` 反解时区偏移。
  // ar-EG / fa-IR / bn-BD 的 `formatToParts` 吐阿拉伯-印度数字（"١٩٦٩"），
  // `parseInt` 返回 NaN → y/mo/dd 全 0 → offset 恒 0 → `_shifted` 不平移，
  // 所有 getFullYear/getMonth/getHours 一起错，而注入不报任何错。
  // `_nameFmt`（时区名）才是要跟 `_LOC` 的那个。
  L.push('    var _parts = new _DTF("en-US", {')
  L.push('      timeZone: C.tz, hour12: false, year: "numeric", month: "2-digit",')
  L.push('      day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit"')
  L.push('    });')
  L.push('')
  // 其余 Intl 构造器：运行时枚举 + **每个成员单独 try**。
  // 整段包一个 try 的话，任何一个成员抛错都会让 _IN 从那一刻截断，
  // 后面的构造器全部不接管 —— 外部表现就是「DateTimeFormat 说 de-DE、
  // DurationFormat 说 zh-CN」，同一个 Intl 上两个语言，不需要参照值即可判定。
  L.push('    var _IN = [];')
  L.push('    var _ik = [];')
  L.push('    try { _ik = Object.getOwnPropertyNames(Intl); } catch (e) { _ik = []; }')
  L.push('    for (var _ii = 0; _ii < _ik.length; _ii++) {')
  L.push('      try {')
  L.push('        var _iv = Intl[_ik[_ii]];')
  L.push('        if (typeof _iv === "function" && typeof _iv.supportedLocalesOf === "function" && _ik[_ii] !== "DateTimeFormat") { _IN.push(_ik[_ii]); }')
  L.push('      } catch (e) {}')
  L.push('    }')
  L.push('    for (var ni = 0; ni < _IN.length; ni++) {')
  L.push('      try {')
  L.push('        (function (nm) {')
  L.push('          var Orig = Intl[nm];')
  L.push('          if (typeof Orig !== "function") { return; }')
  L.push('          var W = function (locales, options) {')
  L.push('            if (locales === undefined || locales === null) { locales = _lang; }')
  L.push('            return new Orig(locales, options);')
  L.push('          };')
  L.push('          W.prototype = Orig.prototype;')
  L.push('          if (Orig.supportedLocalesOf) { W.supportedLocalesOf = Orig.supportedLocalesOf; }')
  // 上一句是**共享**同一个 prototype 对象，不是复制一份。
  // 少了下面这行，`Orig.prototype.constructor` 仍指回原生构造器，
  // `new (Intl.NumberFormat.prototype.constructor)()` 就拿到未包装的原生 formatter
  // —— 宿主 locale + 宿主时区，本段全部作废，而 `_maskOne` 修不了它
  // （它只改 name/length/toString，改不了「constructor 指回谁」）。
  // 注释里刻意不写出赋值语句原文：structure.test.ts 用正则数「复用/修复」配对，
  // 注释里出现同样字面量会被数成第 5 处复用，让配对断言假红。
  L.push('          try { Object.defineProperty(Orig.prototype, "constructor", { value: W, configurable: true, writable: true }); } catch (e) {}')
  L.push('          try { Object.defineProperty(W, "prototype", { writable: false, enumerable: false, configurable: false }); } catch (e) {}')
  L.push('          try { Object.defineProperty(W, "name", { value: nm, configurable: true }); } catch (e) {}')
  L.push('          Intl[nm] = W;')
  L.push('          _maskOne(W, nm);')
  L.push('        })(_IN[ni]);')
  L.push('      } catch (e) { _failed.push({ p: "Intl." + _IN[ni], why: String((e && e.message) || e) }); }')
  L.push('    }')
  L.push('')
  // ── Date：本地 getter 整体平移 + toLocale* 带上 profile 的 locale/timeZone ──
  // 只改 getTimezoneOffset 是不够的：Date 的本地时间 getter 读宿主时区表，
  // 一台 UTC+8 的机器配洛杉矶环境，getHours() 会直接吐东八区的小时数。
  L.push('    var _gtzoNative = Date.prototype.getTimezoneOffset;')
  L.push('    var _offT = NaN, _offV = 0;')
  L.push('    var _targetOff = function (d) {')
  L.push('      var t = d.getTime();')
  L.push('      if (t === _offT) { return _offV; }')
  L.push('      var y = 0, mo = 1, dd = 1, hh = 0, mi = 0, ss = 0;')
  L.push('      var arr = _parts.formatToParts(d);')
  L.push('      for (var i = 0; i < arr.length; i++) {')
  L.push('        var tp = arr[i].type, v = parseInt(arr[i].value, 10);')
  L.push('        if (tp === "year") { y = v; }')
  L.push('        else if (tp === "month") { mo = v; }')
  L.push('        else if (tp === "day") { dd = v; }')
  L.push('        else if (tp === "hour") { hh = v % 24; }')
  L.push('        else if (tp === "minute") { mi = v; }')
  L.push('        else if (tp === "second") { ss = v; }')
  L.push('      }')
  L.push('      var asUTC = Date.UTC(y, mo - 1, dd, hh, mi, ss);')
  L.push('      var off = Math.round((t - asUTC) / 60000);')
  L.push('      if (!isFinite(off)) { off = 0; }')
  L.push('      _offT = t; _offV = off;')
  L.push('      return off;')
  L.push('    };')
  L.push('    var _shifted = function (d) {')
  L.push('      var t = _targetOff(d), h = 0;')
  L.push('      try { h = _gtzoNative.call(d); } catch (e) {}')
  L.push('      return new Date(d.getTime() + (h - t) * 60000);')
  L.push('    };')
  L.push('    var _withTz = function (fn) {')
  L.push('      return function (l, o) {')
  L.push('        var q = {};')
  L.push('        if (o) { for (var k in o) { q[k] = o[k]; } }')
  L.push('        if (!q.timeZone) { q.timeZone = C.tz; }')
  L.push('        if (l === undefined || l === null) { l = _lang; }')
  L.push('        return fn.call(this, l, q);')
  L.push('      };')
  L.push('    };')
  L.push('    defMethod(Date.prototype, "getTimezoneOffset", function () { return _targetOff(this); });')
  L.push('    var _LOCAL = ["getFullYear", "getMonth", "getDate", "getDay", "getHours", "getMinutes", "getSeconds"];')
  L.push('    for (var li = 0; li < _LOCAL.length; li++) {')
  L.push('      (function (nm) {')
  L.push('        var orig = Date.prototype[nm];')
  L.push('        defMethod(Date.prototype, nm, function () { return orig.apply(_shifted(this), arguments); });')
  L.push('      })(_LOCAL[li]);')
  L.push('    }')
  // toString 也必须走平移：`new Date(0).toString()` 会带出宿主时区名，
  // 与已改好的 getHours() 直接矛盾。先取原生再包，不能在里面再 `String(date)`，
  // 那会回到被替换后的 toString，无限递归。
  // toString / toTimeString 印的是**宿主机**的 GMT 偏移和时区名，平移救不了：
  // 平移只改时刻，改不了格式化时用的时区表。所以整个重写，和 page 版同一条路子。
  L.push('    var _p2 = function (n) { return (n < 10 ? "0" : "") + n; };')
  L.push('    var _DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];')
  L.push('    var _MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];')
  L.push('    var _nameFmt = new _DTF(_LOC, { timeZone: C.tz, timeZoneName: "long" });')
  L.push('    var _zoneName = function (d) {')
  L.push('      try {')
  L.push('        var a = _nameFmt.formatToParts(d);')
  L.push('        for (var i = 0; i < a.length; i++) { if (a[i].type === "timeZoneName") { return a[i].value; } }')
  L.push('      } catch (e) {}')
  L.push('      return "";')
  L.push('    };')
  L.push('    defMethod(Date.prototype, "toTimeString", function () {')
  L.push('      if (isNaN(this.getTime())) { return "Invalid Date"; }')
  L.push('      var off = -this.getTimezoneOffset();')
  L.push('      var sg = off >= 0 ? "+" : "-";')
  L.push('      var ab = Math.abs(off);')
  L.push('      var zone = "GMT" + sg + _p2(Math.floor(ab / 60)) + _p2(ab % 60);')
  L.push('      var nm = _zoneName(this);')
  L.push('      return _p2(this.getHours()) + ":" + _p2(this.getMinutes()) + ":" + _p2(this.getSeconds()) + " " + zone + (nm ? " (" + nm + ")" : "");')
  L.push('    });')
  L.push('    defMethod(Date.prototype, "toDateString", function () {')
  L.push('      if (isNaN(this.getTime())) { return "Invalid Date"; }')
  L.push('      return _DOW[this.getDay()] + " " + _MON[this.getMonth()] + " " + _p2(this.getDate()) + " " + this.getFullYear();')
  L.push('    });')
  L.push('    defMethod(Date.prototype, "toString", function () {')
  L.push('      if (isNaN(this.getTime())) { return "Invalid Date"; }')
  L.push('      return this.toDateString() + " " + this.toTimeString();')
  L.push('    });')
  L.push('    defMethod(Date.prototype, "toLocaleString", _withTz(Date.prototype.toLocaleString));')
  L.push('    defMethod(Date.prototype, "toLocaleDateString", _withTz(Date.prototype.toLocaleDateString));')
  L.push('    defMethod(Date.prototype, "toLocaleTimeString", _withTz(Date.prototype.toLocaleTimeString));')
  L.push('    _maskOne(Date.prototype.getTimezoneOffset, "getTimezoneOffset");')
  L.push('')
  // ── WebGL：只装原型，**不建 context** ────────────────────────────────
  // `WEBGL_debug_renderer_info` 给出的是高熵硬指纹，跨上下文一对读就能判定插桩。
  //
  // **曾经崩溃**：这里原来是 `new OffscreenCanvas(1, 1).getContext("webgl")` ——
  // 建一个实例再 `Object.getPrototypeOf(ctx)` 取 prototype。那一行在**暂停态**
  // worker（`waitForDebuggerOnStart` 挂住、isolate 停住）里执行会让渲染进程
  // crashed（实测 `render-process-gone: crashed`，整页白屏）。
  // 实测把条件钉死的三组对照：
  //   · 普通 worker 顶层执行同一行（全程无 CDP）→ 不崩
  //   · 同一会话先 `runIfWaitingForDebugger` 再 evaluate 同一行 → 不崩
  //   · 暂停态只执行这一行、别的什么都不做 → 崩
  // 所以条件是「暂停态 × 建 GL context」。机制推测是暂停期 isolate 挂住，
  // 而创建 GL context 要走 GPU 进程同步 IPC —— **这是推测，未验证**。
  //
  // **修法**：不建 context。`getParameter` 的伪装只依赖 prototype，
  // 而 `WebGLRenderingContext` 是 `[Exposed=(Window,Worker)]`，
  // 实测 Worker 里 `typeof WebGLRenderingContext === "function"`（不是 undefined），
  // prototype 直接可取。建实例纯属多余。
  //
  // **不要再加回来**：任何在注入期创建 GL/GPU 资源的代码都会重新触发这个崩溃。
  // 将来若确实需要实例，必须先 `Runtime.runIfWaitingForDebugger` 再注入，
  // 代价是失去「注入早于 worker 顶层脚本」这条保证。
  //
  // 这里必须是 defMethod，不能是 defGet：`getParameter` 是方法（data property）。
  // 用 defGet 装成 accessor 后，读 `…prototype.getParameter`（不调用、只读值）
  // 会触发 getter，`this` 是 prototype 而不是 context → `_gpo.call(this, p)`
  // 抛 Illegal invocation，整段进 _failed。这条是实测里 `applied=0` 的唯一原因。
  L.push('    try {')
  L.push('      var _GLC = (typeof WebGLRenderingContext !== "undefined") ? WebGLRenderingContext : null;')
  L.push('      if (_GLC && _GLC.prototype && typeof _GLC.prototype.getParameter === "function") {')
  L.push('        var _gpo = _GLC.prototype.getParameter;')
  L.push('        defMethod(_GLC.prototype, "getParameter", function (p) {')
  L.push('          if (p === 37445) { return C.glVendor; }')
  L.push('          if (p === 37446) { return C.glRenderer; }')
  L.push('          return _gpo.call(this, p);')
  L.push('        });')
  L.push('      }')
  L.push('    } catch (e) { _failed.push({ p: "WebGL.getParameter", why: String((e && e.message) || e) }); }')
  L.push('')
  // ── 收口：Function.prototype.toString 必须认识所有被换过的函数 ──────────
  L.push('    var _fts = Function.prototype.toString;')
  L.push('    var _patched = _maskOne(_noProto(function () {')
  L.push('      for (var i = 0; i < _masked.length; i++) {')
  L.push('        if (_masked[i] === this) { return _fakeSrc(String(this.name || "")); }')
  L.push('      }')
  L.push('      return _fts.call(this);')
  L.push('    }), "toString");')
  L.push('    Function.prototype.toString = _patched;')
  L.push('  } catch (e) {')
  L.push('    _failed.push({ p: "<block>", why: String((e && e.message) || e) });')
  L.push('  }')
  L.push('')
  // 失败时**不回滚**，抛错把台账带出去。理由见上面「`_rollback` 已删除」那段。
  //
  // 口径：
  //   · `applied` 正常应该是 25 上下；如果它是 0 而 failed 有内容，说明整块都没装上
  //     （这正是上一轮 WebGL 那个 bug 的读数形态）；
  //   · `skipped` 是「原生就没有、按不该造跳过」，**不是失败**，只作参考；
  //   · 抛错发生在 IIFE 末尾，此时已装上的属性**保持已装状态**，不回退。
  L.push('  if (_failed.length > 0) {')
  L.push("    throw new Error('[ss-mask] applied=' + _applied.length + ' skipped=' + _skipped.length + ' failed=' + JSON.stringify(_failed));")
  L.push('  }')
  L.push('})();')

  return L.join('\n')
}

/**
 * 按 target 取注入源。
 *
 * `'page'` 的产物**逐字节不变**（`buildPageScript` 未被改动），这是硬约束：
 * 25 条 injection probe 全绿不能因为这次改动而回归。
 * `'iframe'` 与 page 同源 —— OOPIF 是独立进程的 document，window/document/canvas 都在，
 * 差别只在「要按 target 单独下一遍」，不在脚本内容。
 */
function dispatchScript(fp: FingerprintConfig, seed: string, target: InjectionTarget): string {
  if (target === 'worker') return buildWorkerScript(fp, seed)
  return buildPageScript(fp, seed)
}

/**
 * 生成注入脚本。
 *
 * 两种调用形态都支持（迁移期）：
 *   buildInjectionScript(profile)                    —— 契约形态，从 Profile 取 fingerprint + seed
 *   buildInjectionScript(profile, 'worker')          —— 契约形态
 *   buildInjectionScript(fingerprintConfig, seed)    —— 旧形态，等价于 target='page'
 */
export function buildInjectionScript(profile: FingerprintProfile, target?: InjectionTarget): string
export function buildInjectionScript(
  fp: FingerprintConfig,
  seed: string,
  target?: InjectionTarget
): string
export function buildInjectionScript(
  a: StoredProfile | FingerprintConfig,
  b?: InjectionTarget | string,
  c?: InjectionTarget
): string {
  // Profile 一定带 fingerprint + seed；FingerprintConfig 两者都没有。
  if (a && typeof a === 'object' && 'fingerprint' in a && 'seed' in a) {
    const p = a as StoredProfile
    return dispatchScript(p.fingerprint, p.seed, (b as InjectionTarget | undefined) ?? 'page')
  }
  // 这里必须炸，不能静默降级。
  // `(fingerprintConfig, 'worker')` 是最容易写出来的错：第二个位置在旧形态里是 seed，
  // 于是 'worker' 会被当成种子，函数照样返回一份**语法正确、内容却是 page 的**脚本。
  // 调用方拿到它去注 Worker，结果和没注入一模一样（静默空转），排查成本极高。
  // seed 是必须的（噪声要靠它确定），所以正确写法只有：
  //   buildInjectionScript(profile, 'worker')            —— Profile 自带 seed
  //   buildInjectionScript(fingerprintConfig, seed, 'worker')
  if (typeof b === 'string' && (b === 'page' || b === 'worker' || b === 'iframe')) {
    throw new Error(
      `buildInjectionScript: 第二个参数是 seed，不是 target。` +
        `要指定 target 请传整个 Profile（自带 seed），或写成 (fingerprintConfig, seed, '${b}')。`
    )
  }
  return dispatchScript(a as FingerprintConfig, String(b ?? ''), c ?? 'page')
}

function buildPageScript(fp: FingerprintConfig, seed: string): string {
  const cfg = injectionConfig(fp, seed)
  // < 只可能出现在字符串值里，替换成 \u003c 防止脚本被内联进 HTML 时提前闭合
  const json = JSON.stringify(cfg).replace(/</g, '\\u003c')
  const L: string[] = []

  L.push('(function () {')
  L.push('  try {')
  L.push('    var C = ' + json + ';')
  L.push('    var S = C.seed | 0;')
  // profile 的语言：所有 locale 出口（Intl 的缺省 locale、Number / String 的
  // toLocale*、Date 的 toLocaleString）都从这一个变量取。同一个事实在多处各写
  // 一遍，迟早漂移，而漂移的表现就是「同一页面上两个语言」。
  L.push("    var _LOC = (C.languages && C.languages.length) ? C.languages[0] : (C.locale || 'en-US');")
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
  // **原生没有的属性不创建。**
  //
  // 实测（非安全上下文 data: URL，`isSecureContext === false`）：
  //   注入前 `'deviceMemory' in navigator` → false，原型上根本没有这个属性
  //   注入后 → true，被我们凭空造了一个 accessor 出来
  // 属性**存在性**是比属性值更硬的指纹：一个本该没有 `deviceMemory` 的页面有了它，
  // 比「值不对」更容易判定。`[SecureContext]` 的属性在 http:// 页面上就是这样。
  // 跳过不算失败 —— 那正是原生真相。
  L.push('        if (!d) { return; }')
  L.push('        Object.defineProperty(o, p, {')
  L.push('          configurable: d.configurable !== false,')
  L.push('          enumerable: d.enumerable,')
  L.push('          get: fn')
  L.push('        });')
  L.push('      } catch (e) { _failed.push({ p: p, why: String((e && e.message) || e) }); }')
  L.push('    }')
  L.push('    function defVal(o, p, v) { defGet(o, p, function () { return v; }); }')
  /* defGet 的前提是「原生没有就不创建」，理由见上面那段：属性存在性比属性值更硬。
     但有一类例外必须破例 —— **真 Chrome 有、Electron 没实现**的 API。
     那种情况下「不存在」本身就是 tell，补回来才是对齐。
     破例的代价是判断必须来自实测（同版本真 Chrome 的差集），不能凭印象：
     凭印象补错一个 API，等于凭空造一个真浏览器没有的属性，比漏掉更糟。
     这个函数因此只创建、绝不覆盖：原生已有就原样返回 false。 */
  L.push('    function defNewVal(o, p, v) {')
  L.push('      try {')
  L.push('        if (Object.getOwnPropertyDescriptor(o, p)) { return false; }')
  L.push('        Object.defineProperty(o, p, { value: v, writable: true, enumerable: true, configurable: true });')
  L.push('        return true;')
  L.push('      } catch (e) { _failed.push({ p: p, why: String((e && e.message) || e) }); return false; }')
  L.push('    }')

  /* 伪装台账必须声明在**最前面**。
     早期版本把它放在脚本末尾的统一收口处，导致 geolocation / 音频 / WebRTC 实例方法
     这几个「中途 patch」的地方没法登记，只能各自挂匿名函数 ——
     `Geolocation.prototype.getCurrentPosition.toString()` 直接吐出
     `function (ok) { _reply(ok); }`，一处露馅等于前面所有伪装白做。 */
  L.push('')
  L.push('    var _masked = [];')
  // page 侧的失败台账。
  //
  // 早先 page 侧**完全没有**台账：任何一个 `defineProperty` 失败都被 `catch (e) {}`
  // 静默吞掉 —— 属性保持宿主值、其它属性是伪装值，页面上没有任何痕迹。
  // worker 侧至少有「失败就抛错」，page 侧连「有没有装全」都无从得知。
  // 而 page 是当前唯一在工作的注入路径，这一层更该有护栏。
  //
  // 这里**只记不撤**：不回滚（回滚的终态是零伪装 = 真实指纹全泄露），
  // 只把失败明细挂到一个非枚举属性上给主进程读。
  L.push('    var _failed = [];')
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

  /* 原生 arity 是**外部事实**，一旦我们把函数换掉就再也推导不出来。
     必须在任何 patch 发生之前拍快照 —— 收口时再去读 `d.value.length`，
     读到的是我们自己写的包装的形参个数，那是「假修」：
     `HTMLCanvasElement.prototype.toBlob` 原生是 1 参，我们的包装写成 0 参，
     快照拿到的就是 0，于是这条断言永远是绿的、而页面看到的值是错的。
     这里同时是 _maskAll 的唯一数据源，避免「快照表」和「登记表」漂移。 */
  L.push('    var _arity = [];')
  L.push('    var _snapAll = function (obj, names) {')
  L.push('      if (!obj) { return; }')
  L.push('      for (var i = 0; i < names.length; i++) {')
  L.push('        try {')
  L.push('          var d = Object.getOwnPropertyDescriptor(obj, names[i]);')
  L.push('          if (d && typeof d.value === "function") { _arity.push([obj, names[i], d.value.length]); }')
  L.push('        } catch (e) {}')
  L.push('      }')
  L.push('    };')
  L.push('    var _arityOf = function (obj, prop) {')
  L.push('      for (var i = 0; i < _arity.length; i++) {')
  L.push('        if (_arity[i][0] === obj && _arity[i][1] === prop) { return _arity[i][2]; }')
  L.push('      }')
  L.push('      return undefined;')
  L.push('    };')
  L.push('')
  L.push('    // [宿主对象, 属性名列表] —— 快照与登记共用这一张表')
  L.push('    var _MASK_TABLE = [')
  L.push('      [Navigator.prototype, ["userAgent", "appVersion", "platform", "vendor",')
  L.push('        "hardwareConcurrency", "deviceMemory", "language", "languages", "webdriver",')
  L.push('        "pdfViewerEnabled", "plugins", "mimeTypes", "maxTouchPoints", "gpu",')
  L.push('        "requestMediaKeySystemAccess", "share", "canShare"]],')
  L.push('      [Screen.prototype, ["width", "height", "availWidth", "availHeight", "colorDepth", "pixelDepth"]],')
  L.push('      [window, ["devicePixelRatio"]],')
  L.push('      [Date.prototype, ["getTimezoneOffset", "toTimeString", "toDateString", "toString",')
  L.push('        "toLocaleString", "toLocaleDateString", "toLocaleTimeString", "getFullYear", "getMonth",')
  L.push('        "getDate", "getDay", "getHours", "getMinutes", "getSeconds"]],')
  L.push('      [Element.prototype, ["getBoundingClientRect", "getClientRects"]],')
  L.push('      [window.AudioBuffer && AudioBuffer.prototype, ["getChannelData"]],')
  L.push('      [window.CanvasRenderingContext2D && CanvasRenderingContext2D.prototype, ["measureText", "getImageData"]],')
  L.push('      [window.HTMLCanvasElement && HTMLCanvasElement.prototype, ["toDataURL", "toBlob"]],')
  L.push('      [window.WebGLRenderingContext && WebGLRenderingContext.prototype, ["getParameter"]],')
  L.push('      [window.WebGL2RenderingContext && WebGL2RenderingContext.prototype, ["getParameter"]],')
  L.push('      [window.Geolocation && Geolocation.prototype, ["getCurrentPosition", "watchPosition"]],')
  L.push('      [window.AnalyserNode && AnalyserNode.prototype, ["getFloatFrequencyData"]],')
  // locale 出口也要登记：不登记就没有 patch 前的原生 arity 快照，收口时读到的
  // 是包装函数的形参个数（这里统一是 0）—— localeCompare 原生是 1 参，会被改错。
  L.push('      [Number.prototype, ["toLocaleString"]],')
  L.push('      [typeof BigInt !== "undefined" && BigInt.prototype, ["toLocaleString"]],')
  L.push('      [String.prototype, ["localeCompare", "toLocaleUpperCase", "toLocaleLowerCase"]],')
  // RTCPeerConnection 的 hook 现在挂在**原型**上（实例级 hook 会让
  // new 出来的对象多出 own property，真实 Chrome 是空的）。
  // addEventListener 的原生归属层就是 EventTarget.prototype，必须登记在这里，
  // 否则收口时拿不到 patch 前的 arity 快照（原生 2 参，包装写成 3 参会被查出）。
  L.push('      [window.EventTarget && EventTarget.prototype, ["addEventListener"]],')
  L.push('      [window.RTCPeerConnection && window.RTCPeerConnection.prototype,')
  L.push('        ["createDataChannel", "createOffer", "createAnswer", "setLocalDescription", "addIceCandidate"]]')
  L.push('    ];')
  L.push('    for (var _ti = 0; _ti < _MASK_TABLE.length; _ti++) {')
  L.push('      _snapAll(_MASK_TABLE[_ti][0], _MASK_TABLE[_ti][1]);')
  L.push('    }')
  L.push('    _snapAll(document.fonts, ["check"]);')
  L.push('    _snapAll(window.speechSynthesis, ["getVoices"]);')

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

  /* ── Web Share：全脚本唯一一处「凭空创建属性」 ──
   *
   * 真 Chrome 156 桌面版有 `navigator.share` / `navigator.canShare`；Electron 45
   * 没实现，于是 `'share' in navigator` 在真 Chrome 是 true、在我们这里是 false。
   * 属性**存在性**比属性值更硬 —— 值可以解释成用户设置，不存在没法解释。
   *
   * 判据全部来自实测，不是印象（tools/probe-api-shape.mjs，基准是同版本真 Chrome
   * 156.0.8078.x，与 Electron 内置的 156.0.8078.75 同主版本）：
   *   Navigator.prototype 属性集合：补之前 真 Chrome 84 项 / 我们 82 项
   *   差集恰好 { share, canShare }，我们**没有**多出任何一项
   *   补之后 84 对 84，缺 0 多 0（这个比对每次都要重跑，不能只看「补上了」）
   * 同一份探针还确认了三件事 —— 它们**不能补**，补了就是造新 tell：
   *   navigator.contacts        Windows 桌面 Chrome 里本来就没有（Android 专属）
   *   navigator.contentIndex    同上（Android / ChromeOS 专属）
   *   connection.downlinkMax    早已从规范移除，Chrome 里不存在
   *
   * 行为按 tools/verify-share.mjs 的 47 条读数逐条对齐。三条容易写错的：
   *   1. canShare 的 WebIDL 转换错误是**同步抛**，share 的是 **rejected promise**
   *      （同一个错误在两边语义不同，不能共用一条 throw）
   *   2. share() 无参 → TypeError；share(undefined) → NotAllowedError。
   *      区别就在 arity，所以必须读 `arguments.length`，不能读 `data === undefined`
   *   3. 激活检查在 url 校验**之前** —— 实测 share({url:'javascript:'}) 给的是
   *      NotAllowedError 而不是 TypeError
   *
   * ── 平台：只测了 Windows，另两个平台是**未测量** ──
   *
   * 本机只有 Windows，所以 `navigator.share` 的存在性只在 Windows 上实测过。
   * macOS / Linux 没有基准可比。这里选择**三个平台统一创建**，理由不是「应该都有」，
   * 而是：Electron 缺这两个 API 是**构建级**的遗漏（Blink 的 NavigatorShare 在
   * Electron 里没编进来），不是平台级的差异；用平台级的分支去补一个构建级的洞，
   * 等于把一个没测过的平台信念写进代码，还写成了「事实」的样子。
   * 代价说清楚：如果真 macOS / Linux Chrome 恰好没有 Web Share，那我们在这两个
   * 平台上就是「多造了属性」—— 比漏掉更糟。这个风险**已知、未消除**，
   * 消除它需要在 macOS / Linux 上各跑一次 tools/verify-share.mjs。
   */
  L.push('')
  L.push('    var _isFile = function (v) {')
  L.push("      try { return Object.prototype.toString.call(v) === '[object File]'; } catch (e) { return false; }")
  L.push('    };')
  /* WebIDL 字典转换。返回 { err } 表示转换失败（调用方决定 throw 还是 reject），
     返回 has* 标志位表示成员是否**存在** —— 注意是存在性，不是「值非空」：
     实测 {title:''} 是 true、{} 是 false、{files:[]} 是 false。 */
  L.push('    var _sdConv = function (fnName, data, hasArg) {')
  L.push("      var pre = \"Failed to execute '\" + fnName + \"' on 'Navigator': \";")
  L.push('      if (!hasArg) { return { absent: true }; }')
  L.push('      if (data === null || data === undefined) { return { empty: true }; }')
  L.push("      var t = typeof data;")
  L.push("      if (t !== 'object' && t !== 'function') {")
  L.push("        return { err: pre + \"The provided value is not of type 'ShareData'.\" };")
  L.push('      }')
  L.push("      var r = { hasTitle: ('title' in data), hasText: ('text' in data), hasUrl: ('url' in data), hasFiles: false, files: null, url: data.url };")
  L.push("      if ('files' in data) {")
  L.push('        r.hasFiles = true;')
  L.push('        var fv = data.files;')
  L.push("        var it = (fv === null || fv === undefined) ? null : fv[Symbol.iterator];")
  L.push("        if (typeof it !== 'function') {")
  L.push("          return { err: pre + \"Failed to read the 'files' property from 'ShareData': The object must have a callable @@iterator property.\" };")
  L.push('        }')
  L.push('        var arr = [];')
  L.push('        try {')
  L.push('          for (var s = it.call(fv), n = s.next(); !n.done; n = s.next()) { arr.push(n.value); }')
  L.push('        } catch (e) {')
  L.push("          return { err: pre + \"Failed to read the 'files' property from 'ShareData': The object must have a callable @@iterator property.\" };")
  L.push('        }')
  L.push('        for (var fi = 0; fi < arr.length; fi++) {')
  L.push('          if (!_isFile(arr[fi])) {')
  L.push("            return { err: pre + \"Failed to read the 'files' property from 'ShareData': Failed to convert value to 'File'.\" };")
  L.push('          }')
  L.push('        }')
  L.push('        r.files = arr;')
  L.push('      }')
  L.push('      return r;')
  L.push('    };')
  /* canShare：同步返回布尔。
     判据顺序按实测反推 —— files 非空时**不按类型过滤**（{files:[未知类型]} 仍是 true），
     且 files 非空时 url 根本不参与判断（{title, files:[txt]} → true）。 */
  L.push('    var _canShare = function () {')
  L.push('      var data = arguments[0];')
  L.push("      var c = _sdConv('canShare', data, arguments.length > 0);")
  L.push('      if (c.err) { throw new TypeError(c.err); }')
  L.push('      var files = (c.hasFiles && c.files) ? c.files : null;')
  L.push('      if (!c.hasTitle && !c.hasText && !c.hasUrl && (!files || files.length === 0)) { return false; }')
  L.push('      if (files && files.length > 0) { return true; }')
  L.push('      if (c.hasUrl) {')
  /* url 只认 http/https —— 实测 data: / file: / ftp: / mailto: / tel: / about: /
     javascript: 全 false，而 '' 和 '//example.com/x' 解析成 http(s) 后为 true。
     所以判据是「解析后协议」而不是「字符串长什么样」。 */
  L.push('        var u = null;')
  L.push("        try { u = new URL(String(c.url), document.baseURI); } catch (e) { return false; }")
  L.push("        if (u.protocol !== 'http:' && u.protocol !== 'https:') { return false; }")
  L.push('      }')
  L.push('      return true;')
  L.push('    };')
  /* share：返回 promise。
     转换错误在 share 里是 rejected 而不是同步抛（实测 4 条，与 canShare 相反）。 */
  L.push('    var _share = function () {')
  L.push('      var data = arguments[0];')
  L.push('      var hasArg = arguments.length > 0;')
  L.push("      var c = _sdConv('share', data, hasArg);")
  L.push('      if (c.err) { return Promise.reject(new TypeError(c.err)); }')
  L.push('      if (!hasArg) {')
  L.push("        return Promise.reject(new TypeError(\"Failed to execute 'share' on 'Navigator': No known share data fields supplied. If using only new fields (other than title, text and url), you must feature-detect them first.\"));")
  L.push('      }')
  /* 激活检查在 url 校验之前：实测 share({url:'javascript:'}) → NotAllowedError */
  L.push('      var act = false;')
  L.push('      try { act = !!(navigator.userActivation && navigator.userActivation.isActive); } catch (e) {}')
  L.push('      if (!act) {')
  L.push("        return Promise.reject(new DOMException(\"Failed to execute 'share' on 'Navigator': Must be handling a user gesture to perform a share request.\", 'NotAllowedError'));")
  L.push('      }')
  /* 有用户激活的分支**未测量** —— 没法在没有真人操作的情况下让真 Chrome 弹出面板，
     所以拿不到它的返回值。这里选最保守的形态：按「用户关掉了分享面板」返回
     AbortError，这也是 Chrome 在那种情况下的结果。**不是**假装成功：
     我们确实没有系统分享面板，resolve 会让页面以为分享完成了。 */
  L.push("      return Promise.reject(new DOMException('Share canceled', 'AbortError'));")
  L.push('    };')
  L.push('    try {')
  L.push("      defNewVal(Navigator.prototype, 'share', _share);")
  L.push("      defNewVal(Navigator.prototype, 'canShare', _canShare);")
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
  L.push("      var _lang = _LOC;")
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
  L.push('      try { Object.defineProperty(_DTF.prototype, "constructor", { value: _Patched, configurable: true, writable: true }); } catch (e) {}')
  // 原生构造器的 prototype 是 writable:false / configurable:false。
  // 赋值语句造出来的描述符是 writable:true / configurable:true —— 一行就能查出来。
  // 必须**单独一个 try**：和上面那句共用一个 try 的话，constructor 那步一旦抛错，
  // 这步就被跳过，而 catch 吞掉异常 —— 结果就是「悄悄没锁上」，探针也看不出来。
  L.push('      try { Object.defineProperty(_Patched, "prototype", { writable: false, enumerable: false, configurable: false }); } catch (e) {}')
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
  // 不写死名单。Chromium 156 还带 Intl.DurationFormat 和 V8 私有的
  // Intl.v8BreakIterator —— 漏掉任何一个，同一个 Intl 对象上就会出现两个语言
  // （DateTimeFormat 说 en-US、DurationFormat 说宿主机的 zh-CN），不需要任何参照值
  // 就能判定是伪造，比缺字段严重得多。补名字只能补到今天知道的，下个版本又会漏。
  //
  // 运行时枚举：supportedLocalesOf 是 ECMA-402「服务构造器」的共同特征。
  // Intl.Locale 没有它（它是值类型，不是格式化器），会被自动排除。
  // getCanonicalLocales / supportedValuesOf 是普通函数，同样被排除。
  /* 每个成员单独 try —— 这一条是拿掉字面量清单之后**换来的新代价**，必须记住。
     早先写死的名单有个好处：漏项是「少做一点」，漏掉的那几个构造器继续用宿主 locale，
     表现是「这个构造器不对」，容易发现。
     改成运行时枚举之后覆盖面完整了，但整段包在一个 try 里：任何一个成员取值抛错，
     _IN 就从那一刻截断，后面的构造器全部不接管 —— 而外部表现是
     「DateTimeFormat 说 de-DE、DurationFormat 说 zh-CN」，同一个 Intl 对象上两个语言。
     截断比漏项更坏，因为它是**做了一半**，而做了一半会自证。
     单项 try 让失败退化成「跳过这一个」，而不是「后面全丢」。 */
  L.push('      var _IN = [];')
  L.push('      var _ik = [];')
  L.push('      try { _ik = Object.getOwnPropertyNames(Intl); } catch (e) { _ik = []; }')
  L.push('      for (var _ii = 0; _ii < _ik.length; _ii++) {')
  L.push('        try {')
  L.push('          var _iv = Intl[_ik[_ii]];')
  L.push('          if (typeof _iv === "function" && typeof _iv.supportedLocalesOf === "function") { _IN.push(_ik[_ii]); }')
  L.push('        } catch (e) {}')
  L.push('      }')
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
  L.push('          try { Object.defineProperty(W, "prototype", { writable: false, enumerable: false, configurable: false }); } catch (e) {}')
  // 同 _Patched：包装函数的 name 是变量名 W，必须改回构造器名
  L.push('          try {')
  L.push('            Object.defineProperty(W, "name", { value: nm, configurable: true });')
  L.push('            Object.defineProperty(W, "length", { value: 0, configurable: true });')
  L.push('          } catch (e) {}')
  L.push('          Intl[nm] = W;')
  L.push('        })(_IN[ni]);')
  L.push('      }')
  L.push('')
  // 同 page 版：`_parts` 只喂 parseInt，必须锁 "en-US"；`_nameFmt` 才跟 `_LOC`。
  L.push('      var _parts = new _DTF("en-US", {')
  L.push("        timeZone: C.tz, hour12: false, year: 'numeric', month: '2-digit',")
  L.push("        day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'")
  L.push('      });')
  L.push("      var _nameFmt = new _DTF(_LOC, { timeZone: C.tz, timeZoneName: 'long' });")
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
  /* 只在调用方没指定时补 profile 的时区。
     原先是无条件 `q.timeZone = C.tz`，于是页面显式要求东京或 UTC 也会被改成本地，
     同一个时间戳在同一页上出现两个值：
       new Date(0).toLocaleString('en-US', {timeZone:'UTC'})        → 洛杉矶时间
       new Intl.DateTimeFormat('en-US',{timeZone:'UTC'}).format(...) → UTC
     这是**不需要任何参照值**就能判定的自相矛盾 —— 比缺字段严重得多。
     原生语义是「不传就用默认时区」，那就照原生来。 */
  L.push('          if (!q.timeZone) { q.timeZone = C.tz; }')
  L.push('          if (l === undefined || l === null) { l = _lang; }')
  L.push('          return fn.call(this, l, q);')
  L.push('        };')
  L.push('      };')
  L.push('      Date.prototype.toLocaleString = _withTz(Date.prototype.toLocaleString);')
  L.push('      Date.prototype.toLocaleDateString = _withTz(Date.prototype.toLocaleDateString);')
  L.push('      Date.prototype.toLocaleTimeString = _withTz(Date.prototype.toLocaleTimeString);')
  L.push('      }')
  L.push('    } catch (e) {}')

  /* 其余 locale 出口。上面只接了 Intl 和 Date，但这几个原生方法无参调用时读的是
     宿主默认 locale —— Number 的千分位、localeCompare 的排序、toLocaleUpperCase
     的土耳其语 i/İ，都是一行就能读出宿主语言，和 navigator.language 对不上。 */
  L.push('')
  L.push('    try {')
  // 各方法签名不同，用「locale 落在实参的第几个位置」区分，不共用一张形参表：
  //   toLocaleString(locales, options)                → 0
  //   localeCompare(that, locales, options)           → 1
  //   toLocaleUpperCase / toLocaleLowerCase(locales)  → 0
  L.push('      var _withLoc = function (fn, idx) {')
  L.push('        return function () {')
  L.push('          var a = [];')
  L.push('          for (var i = 0; i < arguments.length; i++) { a.push(arguments[i]); }')
  L.push('          if (a[idx] === undefined || a[idx] === null) { a[idx] = _LOC; }')
  L.push('          return fn.apply(this, a);')
  L.push('        };')
  L.push('      };')
  L.push('      Number.prototype.toLocaleString = _withLoc(Number.prototype.toLocaleString, 0);')
  L.push('      if (typeof BigInt !== "undefined" && BigInt.prototype && BigInt.prototype.toLocaleString) {')
  L.push('        BigInt.prototype.toLocaleString = _withLoc(BigInt.prototype.toLocaleString, 0);')
  L.push('      }')
  L.push('      String.prototype.localeCompare = _withLoc(String.prototype.localeCompare, 1);')
  L.push('      String.prototype.toLocaleUpperCase = _withLoc(String.prototype.toLocaleUpperCase, 0);')
  L.push('      String.prototype.toLocaleLowerCase = _withLoc(String.prototype.toLocaleLowerCase, 0);')
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
  L.push('        var _priv = function (ip) {')
  L.push("          if (!ip || /\\.local$/i.test(ip)) { return true; }")
  L.push("          if (/^10\\./.test(ip) || /^192\\.168\\./.test(ip) || /^169\\.254\\./.test(ip) || /^127\\./.test(ip)) { return true; }")
  L.push("          if (/^172\\.(1[6-9]|2[0-9]|3[01])\\./.test(ip)) { return true; }")
  L.push("          if (/^(fc|fd|fe80)/i.test(ip)) { return true; }")
  L.push('          return false;')
  L.push('        };')
  L.push('        var _keep = function (cand) { return cand; };')
  L.push("        if (C.webrtc === 'disabled') {")
  // 「禁用」改成「不产生候选」，不再把接口从全局摘掉。
  //
  // 早先的做法是 delete window.RTCPeerConnection 等七个全局。方向是错的：
  // Page.addScriptToEvaluateOnNewDocument 只作用于 frame，Worker 里接口原样还在，
  // 于是主世界 typeof 是 undefined、Worker 里是 function —— 真实 Chromium 里
  // WebRTC 是整特性开关、永远同真同假，这个组合不可能出现，等于自证。
  //
  // 而 session.ts 在网络层已经设了 disable_non_proxied_udp，候选本来就出不来，
  // 删接口对「IP 泄漏」的边际贡献是 0 —— 它只改外观，外观恰好是矛盾来源。
  // 现在改成：接口保留（与 Worker 一致），候选一律丢弃（与网络层一致）。
  L.push('          _keep = function () { return null; };')
  L.push("        } else if (C.webrtc === 'proxy') {")
  L.push('          _keep = function (cand) {')
  L.push("            if (!cand || !cand.candidate) { return cand; }")
  // srflx 必须整体丢弃。它带的是「STUN 服务器看到的你的公网 IP」，
  // 而 UDP 不走 HTTP 代理 —— 也就是说这个地址是**真实 IP**，不是代理出口。
  // 之前只过滤 host 候选，等于把最该藏的那个地址原样放行。
  L.push("            if (cand.candidate.indexOf(' typ srflx') !== -1) { return null; }")
  L.push("            if (cand.candidate.indexOf(' typ host') === -1) { return cand; }")
  L.push("            var m = /([0-9]{1,3}(\\.[0-9]{1,3}){3}|[a-f0-9]{1,4}(:[a-f0-9]{0,4}){2,}|[^\\s]+\\.local)/i.exec(cand.candidate);")
  L.push('            if (m && _priv(m[1])) { return null; }')
  L.push('            return cand;')
  L.push('          };')
  L.push('        }')
  L.push('')
  L.push('        if (C.webrtc === "disabled" || C.webrtc === "proxy") {')
  /* hook 必须挂在**原型**上，不能挂在实例上。
     早先是 `pc.addEventListener = ...` / `Object.defineProperty(pc, 'onicecandidate', ...)`，
     于是 `new RTCPeerConnection()` 的 own property 是 ['addEventListener','onicecandidate']，
     而真实 Chrome 是 []。检测方不用知道任何接口名，new 一个 PC 再读
     getOwnPropertyNames 就能判定 —— 比 P0-9 的「清单不全」便宜得多。
     _maskOne 修的是 name/length/toString，修不了「属性住在哪一层」。

     挂到原型之后连构造器包装都不需要了：new 出来就是原生对象，
     _PC 那一层（name / length / prototype.constructor / 静态成员搬运）整套 tell 一起消失。 */
  L.push('          var _ET = window.EventTarget && window.EventTarget.prototype;')
  L.push('          var _add = _ET && _ET.addEventListener;')
  L.push('          if (typeof _add === "function") {')
  L.push('            var _addHook = _noProto(function (t, fn, o) {')
  L.push('              if (t === "icecandidate" && typeof fn === "function" && this instanceof RTC) {')
  L.push('                return _add.call(this, t, function (e) { var c = _keep(e); if (c) { fn.call(this, c); } }, o);')
  L.push('              }')
  L.push('              return _add.apply(this, arguments);')
  L.push('            });')
  L.push('            _maskOne(_addHook, "addEventListener", 2);')
  L.push('            _ET.addEventListener = _addHook;')
  L.push('')
  /* onicecandidate 原生就是 RTCPeerConnection.prototype 上的 accessor。
     把过滤塞进 setter 的包装里，仍然走原生 setter 存值 —— 实例上不会多出任何属性。
     原始回调存在 WeakMap 里，getter 读回来的还是用户当初塞进去的那个函数。 */
  L.push('            var _iceDesc = Object.getOwnPropertyDescriptor(RTC.prototype, "onicecandidate");')
  L.push('            if (_iceDesc && typeof _iceDesc.get === "function" && typeof _iceDesc.set === "function") {')
  L.push('              var _orig = typeof WeakMap === "function" ? new WeakMap() : null;')
  L.push('              try {')
  L.push('                Object.defineProperty(RTC.prototype, "onicecandidate", {')
  L.push('                  configurable: true,')
  L.push('                  enumerable: _iceDesc.enumerable,')
  L.push('                  get: _maskOne(_noProto(function () {')
  L.push('                    if (_orig && _orig.has(this)) { return _orig.get(this); }')
  L.push('                    return _iceDesc.get.call(this);')
  L.push('                  }), "get onicecandidate", 0),')
  L.push('                  set: _maskOne(_noProto(function (fn) {')
  L.push('                    if (typeof fn !== "function") {')
  L.push('                      if (_orig) { _orig.delete(this); }')
  L.push('                      return _iceDesc.set.call(this, fn);')
  L.push('                    }')
  L.push('                    if (_orig) { _orig.set(this, fn); }')
  L.push('                    var self = this;')
  L.push('                    _iceDesc.set.call(this, function (e) { var c = _keep(e); if (c) { fn.call(self, c); } });')
  L.push('                  }), "set onicecandidate", 1)')
  L.push('                });')
  L.push('              } catch (e) {}')
  L.push('            }')
  L.push('          }')
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

  /* ── OffscreenCanvas：第二条测量通道 ──
   *
   * 上面只包了 `CanvasRenderingContext2D.prototype.measureText`。但同一台机器上
   * 还有一条路：`new OffscreenCanvas(1,1).getContext("2d")` 拿到的是
   * **`OffscreenCanvasRenderingContext2D`**，它是另一个原型，一行都不受上面影响。
   *
   * 实测（`npm run probe:fonts`，宿主 Windows / 环境 macOS）：
   *   字体                 Canvas2D   OffscreenCanvas
   *   Microsoft YaHei UI   false      **true**
   *   Segoe UI Emoji       false      **true**
   *   Cambria Math         false      **true**
   *   Ink Free             false      **true**
   * 也就是说：只包 Canvas2D 时，用 OffscreenCanvas 量一次就把宿主的字体表全读走了。
   * creepjs 的 `platform hints: Arial,"Microsoft YaHei UI"` 正是这么读出来的 ——
   * 两个环境（Windows / macOS）报的是**同一串**，因为读的是宿主。
   *
   * 修法刻意**不复制**上面那套白名单 / 回退 / 宽度偏移的逻辑（复制就是第三份，
   * 三份迟早会分叉）。这里只做一件事：把 OffscreenCanvas 的 font 搬到已经包好的
   * 2D 通道上量，判定完全交给那一份实现。
   *
   * 为什么不用 `new OffscreenCanvas` 自己建探针：worker 里建 OffscreenCanvas 曾经
   * 在**暂停态**下把渲染进程搞崩（见本文件 buildWorkerScript 的注释）。这条路径
   * 一次都不新建 context，只借用已经存在的 `_probe`。
   */
  L.push('')
  L.push('        try {')
  L.push('          if (_probe && typeof OffscreenCanvasRenderingContext2D !== "undefined" &&')
  L.push('              OffscreenCanvasRenderingContext2D.prototype &&')
  L.push('              OffscreenCanvasRenderingContext2D.prototype.measureText) {')
  L.push('            var _omt = OffscreenCanvasRenderingContext2D.prototype.measureText;')
  L.push('            OffscreenCanvasRenderingContext2D.prototype.measureText = function (text) {')
  L.push('              try {')
  L.push('                _probe.font = this.font;')
  L.push('                return CanvasRenderingContext2D.prototype.measureText.call(_probe, text);')
  L.push('              } catch (e) {}')
  L.push('              return _omt.apply(this, arguments);')
  L.push('            };')
  L.push('          }')
  L.push('        } catch (e) {}')
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

  /* window.chrome
     Electron 下 window.chrome 是空对象（0 个自有属性），真实 Chrome 有
     app / csi / loadTimes 三个。一行
       Object.getOwnPropertyNames(window.chrome).length === 3
     就能判定，成本比任何指纹都低。

     值必须从 performance.timing 派生，**不能写常量**：
     写死会让每次导航返回同一组数字，那比缺属性更好抓 ——
     缺属性只说明「不像 Chrome」，恒定值说明「装得像但不会动」。
     注意 chrome.runtime 真实 Chrome 也没有（那是扩展才有的），别顺手补。 */
  L.push('')
  L.push('    try {')
  L.push('      var _c = window.chrome;')
  L.push("      if (_c && typeof _c === 'object' && !('loadTimes' in _c)) {")
  L.push('        var _t = (window.performance && performance.timing) || {};')
  L.push('        var _ns = _t.navigationStart || 0;')
  L.push('        var _sec = function (x) { return (x && _ns && x >= _ns) ? (x - _ns) / 1000 : 0; };')
  L.push('        var _navType = (window.performance && performance.navigation && performance.navigation.type) || 0;')
  L.push('        var _csi = _maskOne(_noProto(function () {')
  L.push('          return {')
  L.push('            onloadT: _t.domContentLoadedEventEnd || _t.loadEventEnd || 0,')
  L.push('            startE: _ns,')
  L.push('            pageT: (window.performance && performance.now) ? performance.now() : 0,')
  L.push('            tran: _navType')
  L.push('          };')
  L.push('        }), "csi", 0);')
  L.push('        var _loadTimes = _maskOne(_noProto(function () {')
  L.push('          return {')
  L.push('            requestTime: _sec(_t.navigationStart),')
  L.push('            startLoadTime: _sec(_t.navigationStart),')
  L.push('            commitLoadTime: _sec(_t.responseStart),')
  L.push('            finishDocumentLoadTime: _sec(_t.domContentLoadedEventEnd),')
  L.push('            finishLoadTime: _sec(_t.loadEventEnd),')
  L.push('            firstPaintTime: _sec(_t.responseStart),')
  L.push('            firstPaintAfterLoadTime: 0,')
  L.push("            navigationType: _navType === 0 ? 'Other' : (_navType === 1 ? 'Reload' : 'BackForward'),")
  L.push('            wasFetchedViaSpdy: true,')
  L.push('            wasNpnNegotiated: true,')
  L.push("            npnNegotiatedProtocol: 'h2',")
  L.push('            wasAlternateProtocolAvailable: false,')
  L.push("            connectionInfo: 'h2'")
  L.push('          };')
  L.push('        }), "loadTimes", 0);')
  L.push('        var _app = {')
  L.push('          isInstalled: false,')
  L.push("          InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },")
  L.push("          RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },")
  L.push('          getDetails: _maskOne(_noProto(function () { return null; }), "getDetails", 0),')
  L.push('          getIsInstalled: _maskOne(_noProto(function () { return false; }), "getIsInstalled", 0),')
  L.push('          runningState: _maskOne(_noProto(function () { return "cannot_run"; }), "runningState", 0),')
  L.push('          installState: _maskOne(_noProto(function (cb) { if (typeof cb === "function") { cb("not_installed"); } }), "installState", 1)')
  L.push('        };')
  // 按 Chrome 的自有属性顺序定义，顺序本身也是可读的
  L.push('        var _defChrome = function (k, v) {')
  L.push('          try { Object.defineProperty(_c, k, { value: v, enumerable: true, configurable: true, writable: true }); } catch (e) {}')
  L.push('        };')
  L.push("        _defChrome('app', _app);")
  L.push("        _defChrome('csi', _csi);")
  L.push("        _defChrome('loadTimes', _loadTimes);")
  L.push('      }')
  L.push('    } catch (e) {}')

  /* EME（加密媒体扩展）
     Electron 里 navigator.requestMediaKeySystemAccess 直接 reject NotSupportedError。
     但真实 headless Chrome 156 的实测是：stage-1 **resolve**，拿到 access 之后
     createMediaKeys() 才抛 NotSupportedError。

     所以「播不了 Widevine」不是 tell —— 真 headless 也播不了，检测方不能因为
     播不了 DRM 就判负，否则所有 headless 全误杀。真正的 tell 是 **stage-1 就拒绝**，
     而大多数检测方只做 stage-1（一行 await，不踩异常路径）。

     修法不需要内核：把拒绝换成「给一个 access，createMediaKeys 抛 NotSupportedError」，
     与真 headless 不可区分。 */
  L.push('')
  L.push('    try {')
  L.push('      if (navigator && typeof navigator.requestMediaKeySystemAccess === "function") {')
  L.push('        var _rq = navigator.requestMediaKeySystemAccess;')
  L.push('        var _mkAccess = function (ks, cfg) {')
  L.push('          return {')
  L.push('            keySystem: ks,')
  L.push('            getConfiguration: _maskOne(_noProto(function () { return cfg || {}; }), "getConfiguration", 0),')
  L.push('            createMediaKeys: _maskOne(_noProto(function () {')
  L.push('              return Promise.reject(new DOMException("Unsupported keySystem", "NotSupportedError"));')
  L.push('            }), "createMediaKeys", 0)')
  L.push('          };')
  L.push('        };')
  L.push('        navigator.requestMediaKeySystemAccess = _maskOne(_noProto(function (ks, cfgs) {')
  L.push('          return _rq.apply(this, arguments).then(')
  L.push('            function (a) { return a; },')
  L.push('            function () { return _mkAccess(ks, cfgs && cfgs[0]); }')
  L.push('          );')
  L.push('        }), "requestMediaKeySystemAccess", 1);')
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
  L.push('            // 长度取**patch 前**拍的原生快照。收口时读 d.value.length 是假修：')
  L.push('            // 那一刻 d.value 已经是我们的包装了，读到的是包装的形参个数。')
  L.push('            _maskOne(f, nm, _arityOf(obj, prop));')
  L.push('          }')
  L.push('        } catch (e) { _failed.push({ p: nm, why: String((e && e.message) || e) }); }')
  L.push('      };')
  L.push('      var _maskAll = function (obj, names, keepProto) {')
  L.push('        for (var i = 0; i < names.length; i++) { _maskAt(obj, names[i], names[i], keepProto); }')
  L.push('      };')
  L.push('')
  // 登记直接遍历顶部那张 _MASK_TABLE，不再另抄一份列表 ——
  // 两份列表必然漂移，而漂移的结果是「某一处静默没登记」，正是这一轮反复踩的坑
  L.push('      for (var _mi = 0; _mi < _MASK_TABLE.length; _mi++) {')
  L.push('        _maskAll(_MASK_TABLE[_mi][0], _MASK_TABLE[_mi][1]);')
  L.push('      }')
  L.push('      _maskAt(document.fonts, "check", "check");')
  L.push('      _maskAt(window.speechSynthesis, "getVoices", "getVoices");')
  L.push('      if (window.RTCPeerConnection) {')
  // 构造器必须保留 prototype，方法必须去掉 —— keepProto 只在构造器这里为 true
  L.push('        _maskOne(window.RTCPeerConnection, "RTCPeerConnection");')
  L.push('      }')
  // 不再另抄一份名单：_IN 是「哪些 Intl 构造器被接管过」的唯一事实来源。
  // 两份名单必然漂移，而漂移的结果就是「某一处静默没登记」。
  // _IN 用 var 声明在上面的 if (C.tz) 块里，和这里是同一个函数作用域，能直接读到；
  // 没跑过那段（无时区）时它是 undefined —— 那种情况下也没有构造器被接管，跳过即可。
  L.push('      if (window.Intl && _IN) {')
  L.push('        for (var _i2 = 0; _i2 < _IN.length; _i2++) {')
  L.push('          if (Intl[_IN[_i2]]) { _maskOne(Intl[_IN[_i2]], _IN[_i2]); }')
  L.push('        }')
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
  L.push('    } catch (e) { _failed.push({ p: "<收口>", why: String((e && e.message) || e) }); }')

  L.push('  } catch (e) { _failed.push({ p: "<块>", why: String((e && e.message) || e) }); }')
  L.push('')
  // 失败台账挂到 window 上给主进程读。
  //
  // 这里**故意**用一个全局，和 worker 侧「一个全局都不留」不同，理由有两条：
  //   1. worker 侧失败可以 throw（`Runtime.evaluate` 会放进 exceptionDetails，
  //      页面删不掉已经返回给调试器的异常）。page 侧不行 —— page 脚本是
  //      `Page.addScriptToEvaluateOnNewDocument` 注入的，抛错只会变成一次页面报错，
  //      主进程拿不到结构化信息，而且会污染页面的 error 事件。
  //   2. 这个属性**页面可以删**。删掉就等于承认自己在伪装 —— 那反而是更强的信号，
  //      所以不怕删。主进程读到「读不到」时按 degraded 处理（见 windows.ts），
  //      默认不信。
  // 用非枚举，避免 `Object.keys(window)` / `for...in` 扫到。
  L.push('  try {')
  L.push('    Object.defineProperty(window, "__ss_mask_failed__", {')
  L.push('      value: _failed, enumerable: false, configurable: true, writable: false')
  L.push('    });')
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
