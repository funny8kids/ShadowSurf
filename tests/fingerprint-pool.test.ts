/**
 * 指纹身份池测试（纯逻辑）。
 *
 * 钉住三件事：
 * 1. 同 seed 严格可复现（同一环境永远同一台「机器」）；
 * 2. 不同 seed 能散落到多台机器（同 OS 不再只有一个 WebGL renderer）；
 * 3. 档案自洽（GPU ↔ 时区 ↔ 字体），且 overrides 优先。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEVICE_PROFILES, TIMEZONE_GEO, resolveFingerprint } from '../src/shared/presets.ts'
import type { OSKind } from '../src/shared/types.ts'

const OSES: OSKind[] = ['windows', 'macos', 'linux']

function fp(os: OSKind, seed: string) {
  return resolveFingerprint(os, seed)
}

test('同 seed 两次生成完全一致（可复现）', () => {
  for (const os of OSES) {
    const a = fp(os, 'prf_abc123')
    const b = fp(os, 'prf_abc123')
    assert.deepEqual(a, b, `${os} 的同 seed 结果必须深相等`)
  }
})

test('不同 seed 会散落到多台机器（Windows 至少 3 种 renderer）', () => {
  const seen = new Set<string>()
  for (let i = 0; i < 60; i += 1) {
    seen.add(fp('windows', `prf_seed_${i}`).webgl.renderer)
  }
  assert.ok(seen.size >= 3, `只抽到 ${String(seen.size)} 种 renderer，身份空间太窄`)
})

test('每个 OS 都能抽到至少 2 种 renderer（跨 OS 也散得开）', () => {
  for (const os of OSES) {
    const seen = new Set<string>()
    for (let i = 0; i < 40; i += 1) seen.add(fp(os, `s${os}${i}`).webgl.renderer)
    assert.ok(seen.size >= 2, `${os} 只抽到 ${String(seen.size)} 种`)
  }
})

test('档案自洽：vendor 与 renderer 匹配', () => {
  for (const os of OSES) {
    for (const p of DEVICE_PROFILES[os]) {
      if (p.glVendor.includes('Apple')) {
        assert.match(p.glRenderer, /Apple, ANGLE Metal Renderer/, `${p.id} 的 renderer 与 Apple 不匹配`)
      } else if (p.glVendor.includes('NVIDIA')) {
        assert.match(p.glRenderer, /NVIDIA.*Direct3D11|NVIDIA.*OpenGL/, `${p.id} 的 renderer 与 NVIDIA 不匹配`)
      } else if (p.glVendor.includes('Intel') && os === 'linux') {
        assert.match(p.glRenderer, /Mesa/, `${p.id} 应为 Mesa 渲染器`)
      } else if (p.glVendor.includes('AMD')) {
        assert.match(p.glRenderer, /AMD/, `${p.id} 的 renderer 与 AMD 不匹配`)
      }
    }
  }
})

test('档案时区必须存在于 TIMEZONE_GEO（保证时区↔坐标一致）', () => {
  for (const os of OSES) {
    for (const p of DEVICE_PROFILES[os]) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(TIMEZONE_GEO, p.timezone),
        `${p.id} 的时区 ${p.timezone} 不在 TIMEZONE_GEO 里，坐标会对不上`
      )
      assert.ok(fp(os, `seed_${p.id}`).geolocation !== null, `${p.id} 必须带坐标`)
    }
  }
})

test('生成结果的 timezone 一定在 TIMEZONE_GEO 里', () => {
  for (const os of OSES) {
    for (let i = 0; i < 30; i += 1) {
      const f = fp(os, `tz_${i}`)
      assert.ok(
        Object.prototype.hasOwnProperty.call(TIMEZONE_GEO, f.timezone),
        `${os} 生成了未知时区 ${f.timezone}`
      )
    }
  }
})

test('overrides 优先：显式 fingerprint 不被档案覆盖', () => {
  const explicit = {
    ...fp('windows', 'seed_a'),
    webgl: { vendor: 'Custom Vendor', renderer: 'Custom Renderer' },
    timezone: 'Europe/Paris'
  }
  const out = resolveFingerprint('windows', 'seed_b', explicit)
  assert.equal(out.webgl.vendor, 'Custom Vendor')
  assert.equal(out.webgl.renderer, 'Custom Renderer')
  assert.equal(out.timezone, 'Europe/Paris')
})

test('UA 版本始终是冻结的 major.0.0.0（不受档案影响）', () => {
  for (const os of OSES) {
    for (let i = 0; i < 20; i += 1) {
      const f = fp(os, `ua_${i}`)
      assert.equal(f.uaVersion, '156.0.0.0')
      assert.ok(f.userAgent.includes('Chrome/156.0.0.0'), `${os} 的 UA 版本未冻结`)
    }
  }
})

test('字体表始终非空且不重复', () => {
  for (const os of OSES) {
    for (let i = 0; i < 20; i += 1) {
      const fonts = fp(os, `font_${i}`).fonts
      assert.ok(fonts.length > 5, `${os} 字体表过短`)
      assert.equal(new Set(fonts).size, fonts.length, `${os} 字体表有重复项`)
    }
  }
})