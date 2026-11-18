/**
 * 代理出口 → 指纹地理校准的**纯逻辑**测试。
 *
 * 被测模块 `src/main/modules/geo-match-policy.ts` 只 import 类型和
 * `shared/presets.ts` 里的一张常量表，不碰 electron / store / 网络，
 * 所以能像 tests/proxy-parse.test.ts 一样用 node:test 直接在 Node 里跑：
 *   node --experimental-strip-types --test tests/geo-match.test.ts
 *
 * 守的是四件事：
 *   1. 国家 → locale 的覆盖与未知回落（不能编不存在的 locale）；
 *   2. languages 是“完整标签 + 基础语言”，不是拍脑袋的数组；
 *   3. 缺时区必须放弃校准，不能拿当前值冒充成功；
 *   4. 计划只包含四个地理字段 —— 不许碰 UA / 屏幕 / os / webgl。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  languagesForLocale,
  localeForCountry,
  planGeoCalibration,
  timezoneGeoOf
} from '../src/main/modules/geo-match-policy.ts'
import { TIMEZONE_GEO } from '../src/shared/presets.ts'
import type { FingerprintConfig } from '../src/shared/types.ts'

/* ────────────────────────────── 夹具 ────────────────────────────── */

function fingerprint(overrides: Partial<FingerprintConfig> = {}): FingerprintConfig {
  return {
    os: 'windows',
    osLabel: 'Windows 11 · 23H2',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/141.0.0.0 Safari/537.36',
    uaVersion: '141.0.7390.107',
    timezone: 'America/Los_Angeles',
    locale: 'en-US',
    languages: ['en-US', 'en'],
    geolocation: { latitude: 37.7749, longitude: -122.4194 },
    screen: { width: 1920, height: 1080, dpr: 1, colorDepth: 24 },
    hardware: { cpuCores: 8, memoryGB: 8 },
    webgl: {
      vendor: 'Google Inc. (Intel)',
      renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)'
    },
    canvas: 'noise',
    audio: 'noise',
    webrtc: 'proxy',
    fonts: ['Arial', 'Segoe UI'],
    clientRectsNoise: true,
    webgpu: true,
    ...overrides
  }
}

/* ────────────────────────────── localeForCountry ────────────────────────────── */

test('localeForCountry：覆盖 40+ 个常见国家/地区', () => {
  const expected: Record<string, string> = {
    US: 'en-US',
    GB: 'en-GB',
    UK: 'en-GB',
    CA: 'en-CA',
    AU: 'en-AU',
    NZ: 'en-NZ',
    IE: 'en-IE',
    ZA: 'en-ZA',
    IN: 'en-IN',
    SG: 'en-SG',
    PH: 'en-PH',
    DE: 'de-DE',
    FR: 'fr-FR',
    ES: 'es-ES',
    MX: 'es-MX',
    AR: 'es-AR',
    CL: 'es-CL',
    CO: 'es-CO',
    IT: 'it-IT',
    NL: 'nl-NL',
    BR: 'pt-BR',
    PT: 'pt-PT',
    RU: 'ru-RU',
    JP: 'ja-JP',
    KR: 'ko-KR',
    CN: 'zh-CN',
    TW: 'zh-TW',
    HK: 'zh-HK',
    TH: 'th-TH',
    VN: 'vi-VN',
    ID: 'id-ID',
    MY: 'ms-MY',
    TR: 'tr-TR',
    SA: 'ar-SA',
    AE: 'ar-AE',
    EG: 'ar-EG',
    PL: 'pl-PL',
    SE: 'sv-SE',
    NO: 'nb-NO',
    DK: 'da-DK',
    FI: 'fi-FI',
    CZ: 'cs-CZ',
    GR: 'el-GR',
    IL: 'he-IL'
  }
  for (const [country, locale] of Object.entries(expected)) {
    assert.equal(localeForCountry(country), locale, `国家 ${country}`)
  }
  // 要求里点名“至少 12 个”，这里把覆盖面也钉住，防止以后悄悄删表
  assert.ok(Object.keys(expected).length >= 40, '覆盖国家数不应回退')
})

test('localeForCountry：大小写与空白不敏感', () => {
  assert.equal(localeForCountry('de'), 'de-DE')
  assert.equal(localeForCountry('  jp '), 'ja-JP')
  assert.equal(localeForCountry('Gb'), 'en-GB')
})

test('localeForCountry：也认 ip-api 返回的国家名', () => {
  // ProxyCheck.country 是 ip-api 的 country 字段 —— 国家名，不是代码。
  // 只认代码的话，真实链路上每个环境都会退到 en-US。
  assert.equal(localeForCountry('Germany'), 'de-DE')
  assert.equal(localeForCountry('United States'), 'en-US')
  assert.equal(localeForCountry('united kingdom'), 'en-GB')
  assert.equal(localeForCountry('Czechia'), 'cs-CZ')
  assert.equal(localeForCountry('Türkiye'), 'tr-TR')
})

test('localeForCountry：不认识的国家回落 en-US，不凭空拼 locale', () => {
  assert.equal(localeForCountry('ZZ'), 'en-US')
  assert.equal(localeForCountry('Narnia'), 'en-US')
  assert.equal(localeForCountry(''), 'en-US')
  assert.equal(localeForCountry('   '), 'en-US')
  // 关键反例：不能把 DE 拼成 en-DE / de-XX 这类真 Chrome 不会给的值
  assert.notEqual(localeForCountry('DE'), 'en-DE')
})

/* ────────────────────────────── languagesForLocale ────────────────────────────── */

test('languagesForLocale：完整标签 + 基础语言', () => {
  assert.deepEqual(languagesForLocale('de-DE'), ['de-DE', 'de'])
  assert.deepEqual(languagesForLocale('en-US'), ['en-US', 'en'])
  assert.deepEqual(languagesForLocale('zh-CN'), ['zh-CN', 'zh'])
  assert.deepEqual(languagesForLocale('pt-BR'), ['pt-BR', 'pt'])
})

test('languagesForLocale：带 script 的标签只展开到主语言', () => {
  assert.deepEqual(languagesForLocale('zh-Hant-TW'), ['zh-Hant-TW', 'zh'])
})

test('languagesForLocale：单段标签不重复自己，空值有确定兜底', () => {
  assert.deepEqual(languagesForLocale('de'), ['de'])
  assert.deepEqual(languagesForLocale(''), ['en-US', 'en'])
  assert.deepEqual(languagesForLocale('   '), ['en-US', 'en'])
})

/* ────────────────────────────── timezoneGeoOf ────────────────────────────── */

test('timezoneGeoOf：命中 TIMEZONE_GEO 返回同坐标，未命中返回 null', () => {
  assert.deepEqual(timezoneGeoOf('Asia/Tokyo'), TIMEZONE_GEO['Asia/Tokyo'])
  assert.deepEqual(timezoneGeoOf('Europe/Berlin'), TIMEZONE_GEO['Europe/Berlin'])
  // America/Chicago 是真 IANA 时区，但表里没有 —— 不能按“美国中部”去猜坐标
  assert.equal(timezoneGeoOf('America/Chicago'), null)
  assert.equal(timezoneGeoOf(''), null)
})

test('timezoneGeoOf：返回副本，改它不会污染共享表', () => {
  const geo = timezoneGeoOf('Asia/Tokyo')
  assert.notEqual(geo, null)
  geo!.latitude = -1
  assert.equal(TIMEZONE_GEO['Asia/Tokyo'].latitude, 35.6762)
})

/* ────────────────────────────── planGeoCalibration ────────────────────────────── */

test('planGeoCalibration：timezone 缺失 → null（不拿当前值冒充已校准）', () => {
  const current = fingerprint()
  assert.equal(planGeoCalibration({ current }), null)
  assert.equal(planGeoCalibration({ timezone: '', current }), null)
  assert.equal(planGeoCalibration({ timezone: '   ', country: 'Germany', current }), null)
})

test('planGeoCalibration：正常输入组装四项地理参数', () => {
  const current = fingerprint()
  const plan = planGeoCalibration({
    timezone: 'Europe/Berlin',
    country: 'Germany',
    current
  })
  assert.notEqual(plan, null)
  assert.equal(plan!.timezone, 'Europe/Berlin')
  assert.equal(plan!.locale, 'de-DE')
  assert.deepEqual(plan!.languages, ['de-DE', 'de'])
  assert.deepEqual(plan!.geolocation, {
    latitude: 52.52,
    longitude: 13.405
  })
})

test('planGeoCalibration：TIMEZONE_GEO 未命中时时区保留、坐标置 null', () => {
  const plan = planGeoCalibration({
    timezone: 'America/Chicago',
    country: 'United States',
    current: fingerprint()
  })
  assert.notEqual(plan, null)
  assert.equal(plan!.timezone, 'America/Chicago')
  assert.equal(plan!.geolocation, null)
})

test('planGeoCalibration：探测没给 country 时保留当前 locale/languages', () => {
  // 没有 country 不等于“国家未知”。此时保留已有值，比把一个正确的
  // ja-JP 环境降级成 en-US 更诚实。
  const current = fingerprint({
    timezone: 'Asia/Tokyo',
    locale: 'ja-JP',
    languages: ['ja-JP', 'ja']
  })
  const plan = planGeoCalibration({ timezone: 'Asia/Tokyo', current })
  assert.notEqual(plan, null)
  assert.equal(plan!.timezone, 'Asia/Tokyo')
  assert.equal(plan!.locale, 'ja-JP')
  assert.deepEqual(plan!.languages, ['ja-JP', 'ja'])
  assert.deepEqual(plan!.geolocation, TIMEZONE_GEO['Asia/Tokyo'])
})

test('planGeoCalibration：country 有值但不认识 → en-US 兜底', () => {
  const plan = planGeoCalibration({
    timezone: 'Europe/London',
    country: 'Atlantis',
    current: fingerprint({ locale: 'ja-JP', languages: ['ja-JP', 'ja'] })
  })
  assert.notEqual(plan, null)
  assert.equal(plan!.locale, 'en-US')
  assert.deepEqual(plan!.languages, ['en-US', 'en'])
})

test('planGeoCalibration：只返回四个地理键，不碰 os / UA / 屏幕', () => {
  const plan = planGeoCalibration({
    timezone: 'Asia/Tokyo',
    country: 'Japan',
    current: fingerprint()
  })
  assert.notEqual(plan, null)
  assert.deepEqual(Object.keys(plan!).sort(), [
    'geolocation',
    'languages',
    'locale',
    'timezone'
  ])
  for (const untouched of ['os', 'osLabel', 'userAgent', 'uaVersion', 'screen', 'hardware', 'webgl']) {
    assert.equal(untouched in plan!, false, `计划不应包含 ${untouched}`)
  }
})

test('planGeoCalibration：不修改传入的 current', () => {
  const current = fingerprint()
  const before = structuredClone(current)
  const plan = planGeoCalibration({
    timezone: 'Europe/Berlin',
    country: 'Germany',
    current
  })
  assert.notEqual(plan, null)
  assert.deepEqual(current, before)
})
