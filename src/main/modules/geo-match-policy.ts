/**
 * 「代理出口 → 指纹地理」的**纯策略**。
 *
 * 这个文件刻意不 import electron / store / 网络探测：它是整套校准里唯一
 * 可以脱离运行时验证的部分，`tests/geo-match.test.ts` 用 node:test 直接跑。
 * 真正碰磁盘和网络的编排在 `./geo-match.ts`。
 *
 * 依赖只有 shared 里的 `TIMEZONE_GEO`（时区→坐标，见 shared/presets.ts）
 * 与几个类型定义。类型 import 会被 Node 的 strip-types 擦掉，不会触发别名解析。
 */

import type { FingerprintConfig, GeoPoint } from '@shared/types'

// 这里必须带 `.ts` 扩展名，原因有两个，缺一不可：
//   1. 本文件要被 `node --experimental-strip-types --test` 直接 import，
//      Node 的 ESM 解析不会像 TS 那样自动补扩展名，写成 `../../shared/presets`
//      会直接 ERR_MODULE_NOT_FOUND；
//   2. 项目没开 `allowImportingTsExtensions`，所以 tsc 会对显式 `.ts` 报 TS5097。
// 用一行 @ts-ignore 只压掉这条工具链限制，不改变任何类型信息 ——
// `TIMEZONE_GEO` 仍然是精确的 `Record<string, { latitude; longitude }>`。
// 不为此改全局 tsconfig：那会放宽**所有**文件对扩展名的约束。
// @ts-ignore TS5097：显式 .ts 扩展名是 Node 测试加载本文件的硬要求
import { TIMEZONE_GEO } from '../../shared/presets.ts'

/* ────────────────────────────── 国家 → locale ────────────────────────────── */

/**
 * ISO 3166-1 alpha-2 国家代码 → 区域 locale。
 *
 * **不认识的返回 en-US**：宁可退到最常见的那个，也不要按语言前缀临时拼一个
 * 可能并不存在的 locale（例如把 `DE` 拼成 `de` 之外的 `en-DE`）。一个编造的
 * locale 会让 `navigator.languages` 出现真 Chrome 永远不会给的值，比“不够本地化”
 * 更容易被风控识别。
 */
const COUNTRY_LOCALE: Readonly<Record<string, string>> = {
  US: 'en-US',
  GB: 'en-GB',
  // 兼容常见但非 ISO 的写法；ISO 里英国就是 GB
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
  AT: 'de-AT',
  CH: 'de-CH',
  FR: 'fr-FR',
  ES: 'es-ES',
  MX: 'es-MX',
  AR: 'es-AR',
  CL: 'es-CL',
  CO: 'es-CO',
  IT: 'it-IT',
  NL: 'nl-NL',
  BE: 'nl-BE',
  BR: 'pt-BR',
  PT: 'pt-PT',
  RU: 'ru-RU',
  UA: 'uk-UA',
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

/**
 * ip-api 的 `country` 字段返回的是**国家名**（"Germany"），不是代码。
 *
 * `ProxyCheck.country` 正是这个字段，所以校准链路里拿到的永远是名字。
 * 如果只认代码，真实场景下每个国家都会落到 en-US —— 功能看起来“跑通了”，
 * 实际一次都没有生效。这里把常见英文写法归一化到代码，代码路径保持不变。
 */
const COUNTRY_NAME_TO_CODE: Readonly<Record<string, string>> = {
  'united states': 'US',
  usa: 'US',
  'united states of america': 'US',
  'united kingdom': 'GB',
  'great britain': 'GB',
  england: 'GB',
  canada: 'CA',
  australia: 'AU',
  'new zealand': 'NZ',
  ireland: 'IE',
  'south africa': 'ZA',
  india: 'IN',
  singapore: 'SG',
  philippines: 'PH',
  germany: 'DE',
  austria: 'AT',
  switzerland: 'CH',
  france: 'FR',
  spain: 'ES',
  mexico: 'MX',
  argentina: 'AR',
  chile: 'CL',
  colombia: 'CO',
  italy: 'IT',
  netherlands: 'NL',
  holland: 'NL',
  belgium: 'BE',
  brazil: 'BR',
  portugal: 'PT',
  russia: 'RU',
  'russian federation': 'RU',
  ukraine: 'UA',
  japan: 'JP',
  'south korea': 'KR',
  korea: 'KR',
  'republic of korea': 'KR',
  china: 'CN',
  taiwan: 'TW',
  'hong kong': 'HK',
  thailand: 'TH',
  vietnam: 'VN',
  'viet nam': 'VN',
  indonesia: 'ID',
  malaysia: 'MY',
  turkey: 'TR',
  'türkiye': 'TR',
  'saudi arabia': 'SA',
  'united arab emirates': 'AE',
  uae: 'AE',
  egypt: 'EG',
  poland: 'PL',
  sweden: 'SE',
  norway: 'NO',
  denmark: 'DK',
  finland: 'FI',
  czechia: 'CZ',
  'czech republic': 'CZ',
  greece: 'GR',
  israel: 'IL'
}

/**
 * 国家代码或国家名 → locale。
 *
 * 两种入参都收：调用方可能传 ISO 代码（手工测试 / 未来改用 countryCode），
 * 也可能传 ip-api 的国家名（当前真实链路）。大小写、点号、连字符先归一化，
 * 但不做模糊匹配 —— 拼错的国家名应该明确地退到 en-US，而不是猜一个最近的。
 */
export function localeForCountry(country: string): string {
  const raw = String(country ?? '').trim()
  if (raw === '') return 'en-US'

  const code = raw.toUpperCase()
  const byCode = COUNTRY_LOCALE[code]
  if (byCode !== undefined) return byCode

  const name = raw
    .toLowerCase()
    .replace(/[._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const mappedCode = COUNTRY_NAME_TO_CODE[name]
  if (mappedCode !== undefined) {
    const byName = COUNTRY_LOCALE[mappedCode]
    if (byName !== undefined) return byName
  }

  return 'en-US'
}

/**
 * locale → `navigator.languages`。
 *
 * 规则是「完整标签 + 基础语言」：`de-DE` → `['de-DE','de']`。
 * 真 Chrome 在德语区就是这个形状；只给 `['de']` 会少一层信息，
 * 只给 `['de-DE']` 则和一些真实用户的配置对不上。
 */
export function languagesForLocale(locale: string): string[] {
  const tag = String(locale ?? '').trim()
  if (tag === '') return ['en-US', 'en']

  const parts = tag.split('-').filter((part) => part !== '')
  const primary = (parts[0] ?? '').toLowerCase()
  // 单段标签（'de'）没有“基础语言”可展开，返回去重后的一项
  if (primary === '' || parts.length <= 1) return [tag]
  return [tag, primary]
}

/**
 * 时区 → 坐标。表只有一份（`shared/presets.ts` 的 `TIMEZONE_GEO`），
 * 不在这里复制一份：两份表迟早会漂移，而“指纹里的坐标和时区不是一套”
 * 正是校准功能要消灭的问题。
 *
 * 返回副本而不是表里的对象本身：调用方拿到的是计划结果，
 * 不应该能通过改它反向污染共享常量。
 */
export function timezoneGeoOf(tz: string): GeoPoint | null {
  const hit = TIMEZONE_GEO[String(tz ?? '').trim()]
  if (hit === undefined) return null
  return { latitude: hit.latitude, longitude: hit.longitude }
}

/* ────────────────────────────── 校准计划 ────────────────────────────── */

export interface GeoCalibrationInput {
  /** 出口时区（来自代理探测）。缺失表示探测没拿到，调用方应放弃校准 */
  timezone?: string
  /** 出口国家（ip-api 返回国家名，也接受 ISO 代码） */
  country?: string
  /** 当前指纹：只读取缺失国家时的 locale/languages 兜底，不会被修改 */
  current: FingerprintConfig
}

/**
 * 校准计划：**只包含四个地理字段**。
 *
 * 为什么不动 os / userAgent / screen / webgl：
 * - UA 描述的是浏览器与平台，和出口国家没有对应关系。按国家改 UA 等于伪造
 *   一个不存在的版本组合，反而制造矛盾；
 * - screen / webgl 是硬件特征，和地理位置无关，改它们只会让同一台“机器”
 *   在换代理后突然换屏换显卡，是更明显的异常；
 * - 这四个字段才是页面能从代理出口推断出来的东西（时区、语言、坐标）。
 *
 * 也不返回 `current` 的其它字段：调用方用 `{ ...current, ...plan }` 合并，
 * 计划本身保持最小，测试可以精确断言“没有碰别的键”。
 */
export interface GeoCalibrationPlan {
  timezone: string
  locale: string
  languages: string[]
  geolocation: GeoPoint | null
}

/**
 * 组装一次校准计划。`timezone` 缺失直接返回 null —— 这是唯一的硬失败：
 * 没有出口时区就没有校准依据，不能拿当前值冒充“已校准”。
 */
export function planGeoCalibration(input: GeoCalibrationInput): GeoCalibrationPlan | null {
  const timezone = String(input.timezone ?? '').trim()
  if (timezone === '') return null

  const country = String(input.country ?? '').trim()
  // 没有 country 不等同于“国家未知”：ip-api 成功回包通常会带国家，
  // 真缺失时保留环境已有的 locale 比改成 en-US 更诚实 —— 后者会把一个
  // 本来正确的 ja-JP 环境降级成英文。国家**有值但不认识**时仍走
  // localeForCountry 的 en-US 兜底（见该函数注释）。
  const locale = country === '' ? input.current.locale || 'en-US' : localeForCountry(country)
  const languages =
    country === '' && input.current.languages.length > 0
      ? [...input.current.languages]
      : languagesForLocale(locale)

  return {
    timezone,
    locale,
    languages,
    geolocation: timezoneGeoOf(timezone)
  }
}
