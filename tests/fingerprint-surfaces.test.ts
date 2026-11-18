/**
 * 新增指纹面的**纯逻辑**测试。
 *
 * 为什么只测纯逻辑：
 * 注入脚本是**运行时拼出来的字符串**，它跑在页面里（要 Electron / 真浏览器）。
 * 在 node --test 里没法执行它 —— 所以把「脚本要用的那份数据」抽成纯函数，
 * 在这里钉住；脚本那侧只负责把这些值搬过去。
 *
 * 钉的是**值本身**，不是「代码写了没写」：
 *   · 权限表：状态错一个就是「这个浏览器在同一个权限上撒谎」；
 *   · 插件表：多一个或少一个插件都是编的；
 *   · UA-CH 高熵值：它与 CDP 下发的 UA-CH 头必须**逐字相同**，
 *     两边各写一份必然漂移，而漂移的表现是「头说 Windows、JS 说 Linux」；
 *   · 缺省值补齐：老盘上的 profile 是旧结构，缺字段必须被补成完整的，
 *     而不是变成 undefined。
 *
 * 依赖：`shared/presets.ts` 只 import type，不碰 Electron，
 * 所以能直接在 Node 里跑。
 *
 * 跑法：node --experimental-strip-types --test tests/fingerprint-surfaces.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_BATTERY,
  DEFAULT_CONNECTION,
  DEFAULT_MEDIA_DEVICES,
  DEFAULT_PERMISSION_STATES,
  DEFAULT_STORAGE_QUOTA,
  PDF_MIME_TYPES,
  PDF_PLUGIN_NAMES,
  applySurfaceDefaults,
  resolveFingerprint,
  resolvePluginDescriptors,
  resolveUaBrands,
  resolveUaHighEntropy,
  resolveWebgpuAdapterInfo
} from '../src/shared/presets.ts'
import type { FingerprintConfig, FingerprintPermissionState } from '../src/shared/types.ts'

const SEED = 'a'.repeat(64)

/** 一份**旧结构**的指纹：落盘的老 profile 就是这个形状（新增面一个都没有） */
function legacyConfig(): FingerprintConfig {
  return {
    os: 'windows',
    osLabel: 'Windows 11 · 23H2',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.8078.75 Safari/537.36',
    uaVersion: '156.0.8078.75',
    timezone: 'America/Los_Angeles',
    locale: 'en-US',
    languages: ['en-US', 'en'],
    geolocation: { latitude: 37.7749, longitude: -122.4194 },
    screen: { width: 1920, height: 1080, dpr: 1, colorDepth: 24 },
    hardware: { cpuCores: 8, memoryGB: 16 },
    webgl: { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, ...)' },
    canvas: 'noise',
    audio: 'noise',
    webrtc: 'proxy',
    fonts: ['Arial'],
    clientRectsNoise: true,
    webgpu: true
  }
}

/* ────────────────────────── 权限表 ────────────────────────── */

test('权限表的取值逐条来自实测，且不是「一律 prompt」', () => {
  // 这几个是「默认就 granted」的：写成 prompt 反而与真 Chrome 不一样。
  for (const name of ['clipboard-write', 'background-sync', 'payment-handler', 'storage-access']) {
    assert.equal(
      DEFAULT_PERMISSION_STATES[name],
      'granted',
      `${name} 在真 Chrome 里默认就是 granted，写成别的值就是在这一个权限上撒谎`
    )
  }
  // 这几个是「默认要问」的。
  for (const name of ['camera', 'microphone', 'geolocation', 'notifications']) {
    assert.equal(DEFAULT_PERMISSION_STATES[name], 'prompt', `${name} 默认应当是 prompt`)
  }
  // periodic-background-sync 默认是 **denied**（Chrome 默认禁用后台周期同步）。
  assert.equal(DEFAULT_PERMISSION_STATES['periodic-background-sync'], 'denied')
})

test('权限表的值域只有三种，且键都是查询时用的名字', () => {
  const allowed: FingerprintPermissionState[] = ['granted', 'denied', 'prompt']
  for (const [name, state] of Object.entries(DEFAULT_PERMISSION_STATES)) {
    assert.ok(allowed.includes(state), `${name} 的状态 ${state} 不在三种之内`)
    // 内部名（video_capture / durable_storage / clipboard_read）是浏览器内部的，
    // 查询时用的是 descriptor name。混进内部名会让 query 直接抛 TypeError。
    assert.ok(!name.includes('_'), `${name} 看着像内部名而不是查询用的名字`)
  }
})

/* ────────────────────────── 插件表 ────────────────────────── */

test('插件表是桌面 Chrome 的那五个，且全是 PDF 插件', () => {
  assert.deepEqual(PDF_PLUGIN_NAMES, [
    'PDF Viewer',
    'Chrome PDF Viewer',
    'Chromium PDF Viewer',
    'Microsoft Edge PDF Viewer',
    'WebKit built-in PDF'
  ])
  // 桌面 Chrome 的插件表里**只有** PDF 插件。多一个都是编的。
  assert.equal(PDF_PLUGIN_NAMES.length, 5)
  for (const name of PDF_PLUGIN_NAMES) {
    assert.match(name, /pdf/i, `${name} 不是 PDF 插件`)
  }
})

test('mime 类型表是 application/pdf 与 text/pdf，suffixes 不是空串', () => {
  assert.deepEqual(
    PDF_MIME_TYPES.map((m) => m.type),
    ['application/pdf', 'text/pdf']
  )
  for (const m of PDF_MIME_TYPES) {
    assert.equal(m.suffixes, 'pdf', `${m.type} 的 suffixes 写成空串会和真 Chrome 差一个字段`)
    assert.equal(m.description, 'Portable Document Format')
  }
})

test('resolvePluginDescriptors：chrome-pdf 给出五个描述，none 给出空表', () => {
  const full = resolvePluginDescriptors('chrome-pdf')
  assert.equal(full.length, 5)
  assert.deepEqual(
    full.map((p) => p.name),
    PDF_PLUGIN_NAMES
  )
  for (const p of full) {
    assert.equal(p.filename, 'internal-pdf-viewer')
    assert.equal(p.description, 'Portable Document Format')
    assert.deepEqual(p.mimeTypes, ['application/pdf', 'text/pdf'])
  }
  assert.deepEqual(resolvePluginDescriptors('none'), [], "'none' 必须是空表")
})

/* ────────────────────────── UA-CH 高熵值 ────────────────────────── */

test('高熵值与 CDP 下发的 UA-CH 头同源：两处取值必须逐字相同', () => {
  const fp = resolveFingerprint('windows', SEED)
  const hi = resolveUaHighEntropy(fp)
  const { brands, fullVersionList } = resolveUaBrands(fp)

  assert.equal(hi['platform'], 'Windows')
  assert.equal(hi['platformVersion'], '15.0.0')
  assert.equal(hi['architecture'], 'x86', "Chrome 报的是 'x86'，不是 'x86_64'")
  assert.equal(hi['bitness'], '64')
  assert.equal(hi['model'], '', '桌面 Chrome 的 model 恒为空串')
  assert.equal(hi['mobile'], false)
  assert.equal(hi['wow64'], false)
  assert.equal(hi['uaFullVersion'], fp.uaVersion)
  assert.deepEqual(hi['formFactors'], ['Desktop'])

  // brands 里必须有 Google Chrome —— 只发 Chromium 的话
  // 「UA 说自己是 Chrome、Client Hints 里没有 Chrome」是一眼可见的矛盾。
  assert.ok(brands.some((b) => b.brand === 'Google Chrome'))
  assert.equal(fullVersionList.length, brands.length)
  assert.equal(
    fullVersionList.find((b) => b.brand === 'Google Chrome')?.version,
    fp.uaVersion
  )
})

test('platformVersion 跟着系统走，不是写死的一个值', () => {
  assert.equal(resolveUaHighEntropy(resolveFingerprint('windows', SEED))['platform'], 'Windows')
  assert.equal(resolveUaHighEntropy(resolveFingerprint('macos', SEED))['platform'], 'macOS')
  assert.equal(resolveUaHighEntropy(resolveFingerprint('linux', SEED))['platform'], 'Linux')
  assert.equal(
    resolveUaHighEntropy(resolveFingerprint('linux', SEED))['platformVersion'],
    '6.8.0',
    'Linux 的 platformVersion 与 Windows/macOS 不同，写死会与 UA 对不上'
  )
})

/* ────────────────────────── WebGPU adapter.info ────────────────────────── */

test('adapter.info 的 vendor 必须从 webgl.vendor 派生（两处不能各说各话）', () => {
  const fp = resolveFingerprint('windows', SEED)
  const info = resolveWebgpuAdapterInfo(fp)
  assert.equal(info.vendor, 'nvidia')
  assert.equal(info.architecture, '', '拿不到架构族时留空，不编')
  assert.equal(info.device, '')
  assert.equal(info.description, '')

  const mac = resolveFingerprint('macos', SEED)
  assert.equal(resolveWebgpuAdapterInfo(mac).vendor, 'apple')
  const linux = resolveFingerprint('linux', SEED)
  assert.equal(resolveWebgpuAdapterInfo(linux).vendor, 'intel')
})

/* ────────────────────────── 缺省值补齐（存储迁移） ────────────────────────── */

test('旧盘上的 profile 缺新增字段，补齐后必须是一份完整配置', () => {
  const legacy = legacyConfig()
  // 前置：旧结构里确实没有这些字段
  assert.equal((legacy as { connection?: unknown }).connection, undefined)
  assert.equal((legacy as { permissions?: unknown }).permissions, undefined)

  const resolved = applySurfaceDefaults(legacy)
  assert.equal(resolved.maxTouchPoints, 0)
  assert.deepEqual(resolved.connection, DEFAULT_CONNECTION)
  assert.deepEqual(resolved.battery, DEFAULT_BATTERY)
  assert.deepEqual(resolved.mediaDevices, DEFAULT_MEDIA_DEVICES)
  assert.equal(resolved.plugins, 'chrome-pdf')
  assert.equal(resolved.mediaCapabilities, true)
  assert.equal(resolved.storageEstimate, true)
  assert.equal(resolved.uaHighEntropy, true)
  // 权限表按缺省补齐 —— 不是空对象
  assert.equal(resolved.permissions['camera'], 'prompt')
  assert.equal(Object.keys(resolved.permissions).length, Object.keys(DEFAULT_PERMISSION_STATES).length)
})

test('旧盘上的 canvas/audio 取值仍然有效，block 不被降级成 noise', () => {
  assert.equal(applySurfaceDefaults(legacyConfig()).canvas, 'noise')
  assert.equal(applySurfaceDefaults({ ...legacyConfig(), canvas: 'off' }).canvas, 'off')
  assert.equal(applySurfaceDefaults({ ...legacyConfig(), canvas: 'block' }).canvas, 'block')
  assert.equal(applySurfaceDefaults({ ...legacyConfig(), audio: 'off' }).audio, 'off')
  assert.equal(applySurfaceDefaults({ ...legacyConfig(), audio: 'block' }).audio, 'block')
})

test('缺省值补齐是幂等的：补两次与补一次结果相同', () => {
  const once = applySurfaceDefaults(legacyConfig())
  assert.deepEqual(applySurfaceDefaults(once), once)
})

test('电池缺省值与真 Chrome 的桌面读数一致', () => {
  // 桌面机没有电池时真 Chrome 报的就是这一组
  assert.equal(DEFAULT_BATTERY.charging, true)
  assert.equal(DEFAULT_BATTERY.level, 1)
  assert.equal(DEFAULT_BATTERY.chargingTime, 0)
  assert.equal(DEFAULT_BATTERY.dischargingTime, Infinity)
  assert.ok(
    Number.isFinite(DEFAULT_BATTERY.level) && DEFAULT_BATTERY.level >= 0 && DEFAULT_BATTERY.level <= 1,
    '电量必须落在 0..1'
  )
})

test('connection 缺省值是一次「正常宽带」而不是抖动值', () => {
  assert.equal(DEFAULT_CONNECTION.effectiveType, '4g')
  assert.equal(DEFAULT_CONNECTION.downlink, 10)
  assert.equal(DEFAULT_CONNECTION.rtt, 50)
  assert.equal(DEFAULT_CONNECTION.saveData, false)
})

test('storage quota 是钉死的常量，不是宿主磁盘算出来的', () => {
  // 宿主真实 quota 随磁盘大小变 —— 那是「这台机器盘多大」的宿主特征。
  assert.equal(DEFAULT_STORAGE_QUOTA, 10737418240)
})

/* ────────────────────────── resolveFingerprint 的产出 ────────────────────────── */

test('resolveFingerprint 产出的配置带齐全部新增字段', () => {
  const fp = resolveFingerprint('macos', SEED)
  assert.equal(typeof fp.maxTouchPoints, 'number')
  assert.equal(fp.connection.effectiveType, '4g')
  assert.equal(fp.battery.level, 1)
  assert.equal(fp.mediaDevices.videoInput, 0)
  assert.equal(fp.plugins, 'chrome-pdf')
  assert.equal(fp.mediaCapabilities, true)
  assert.equal(fp.storageEstimate, true)
  assert.equal(fp.uaHighEntropy, true)
  assert.equal(fp.canvas, 'noise')
  assert.equal(fp.audio, 'noise')
})

test('overrides 里给的表面值不会被缺省覆盖掉', () => {
  const fp = resolveFingerprint('linux', SEED, {
    canvas: 'block',
    audio: 'block',
    plugins: 'none',
    maxTouchPoints: 5,
    connection: { effectiveType: '3g', downlink: 1.5, rtt: 300, saveData: true }
  })
  assert.equal(fp.canvas, 'block')
  assert.equal(fp.audio, 'block')
  assert.equal(fp.plugins, 'none')
  assert.equal(fp.maxTouchPoints, 5)
  assert.equal(fp.connection.effectiveType, '3g')
  assert.equal(fp.connection.rtt, 300)
})

test('同 seed 两次 resolve 得到同一套值（确定性是这个项目的前提）', () => {
  const a = resolveFingerprint('windows', SEED)
  const b = resolveFingerprint('windows', SEED)
  assert.deepEqual(a, b)
  const c = resolveFingerprint('windows', 'b'.repeat(64))
  assert.notDeepEqual(a, c)
})
