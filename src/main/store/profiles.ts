/**
 * 环境（Profile）仓库。
 *
 * 一个 Profile = 一个独立的浏览器身份：独立存储分区、独立代理、独立指纹。
 * 这里只管「身份是什么」，不管「怎么把它跑起来」——启动逻辑在 browser 层。
 *
 * 存储实现藏在 JsonStore 后面，将来换 SQLite 时这个类的方法签名不变。
 */

import { randomInt } from 'node:crypto'
import { PROFILE_COLORS } from '@shared/presets'
import type { CloneOptions, CreateProfileInput, OSKind, Profile } from '@shared/types'
import { buildFingerprint, deriveSeed } from '@main/core/fingerprint'
import { JsonStore } from './db'

/** 去掉了 0/1/i/l/o —— 手抄、念读、日志里肉眼对齐时都不会认错 */
const ID_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz'
const ID_LENGTH = 12
const DEFAULT_GROUP = '默认'

function deepCopy(p: Profile): Profile {
  return structuredClone(p)
}

function newId(taken: Profile[]): string {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    let body = ''
    for (let i = 0; i < ID_LENGTH; i += 1) {
      body += ID_ALPHABET.charAt(randomInt(0, ID_ALPHABET.length))
    }
    const id = 'prf_' + body
    if (!taken.some((p) => p.id === id)) return id
  }
  // 16 次全撞上说明随机源坏了，宁可抛也不能生成重复身份
  throw new Error('无法生成唯一的 Profile ID')
}

/** 旧版本数据兜底：只保留形状正确的条目，坏一条不至于丢掉整个列表 */
function migrateProfiles(raw: unknown): Profile[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((item): item is Profile => {
    if (item === null || typeof item !== 'object') return false
    const rec = item as Record<string, unknown>
    return typeof rec.id === 'string' && typeof rec.seed === 'string' && typeof rec.fingerprint === 'object'
  })
}

export class ProfileStore {
  private readonly store = new JsonStore<Profile[]>('profiles.json', () => [], migrateProfiles)

  /** 按创建时间倒序：新环境永远在最上面，符合用户「刚建完就要用」的直觉 */
  list(): Profile[] {
    const all = this.store.read().slice()
    all.sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
    return all.map(deepCopy)
  }

  get(id: string): Profile | null {
    const hit = this.store.read().find((p) => p.id === id)
    return hit === undefined ? null : deepCopy(hit)
  }

  count(): number {
    return this.store.read().length
  }

  create(input: CreateProfileInput): Profile {
    const all = this.store.read()
    const platform: OSKind = input.platform ?? input.fingerprint?.os ?? 'windows'
    const id = newId(all)
    const seed = deriveSeed(id)
    // 传了指纹就用传的（用户可能从别处导入），否则按平台现算一套
    const fingerprint = input.fingerprint ?? buildFingerprint(platform, seed)
    const now = Date.now()

    const profile: Profile = {
      id,
      name: (input.name ?? '').trim() || '环境 ' + String(all.length + 1),
      group: (input.group ?? '').trim() || DEFAULT_GROUP,
      color: PROFILE_COLORS[all.length % PROFILE_COLORS.length],
      status: 'idle',
      platform: fingerprint.os,
      browserVersion: fingerprint.uaVersion,
      seed,
      fingerprint,
      proxy: input.proxy ?? null,
      tags: [],
      note: '',
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null
    }

    this.store.update((draft) => {
      draft.push(profile)
    })
    return deepCopy(profile)
  }

  update(id: string, patch: Partial<Profile>): Profile {
    const existing = this.get(id)
    if (existing === null) throw new Error('环境不存在：' + id)

    // id / createdAt 是身份的锚点，seed 改了就是另一个身份（要走 regenerate）
    const next: Profile = {
      ...existing,
      ...patch,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: Date.now()
    }

    this.store.update((draft) => {
      const i = draft.findIndex((p) => p.id === id)
      if (i >= 0) draft[i] = next
    })
    return deepCopy(next)
  }

  /** 删除后不留占位：列表就是纯数组，天然没有空洞 */
  remove(id: string): void {
    if (this.get(id) === null) throw new Error('环境不存在：' + id)
    this.store.update((draft) => {
      const i = draft.findIndex((p) => p.id === id)
      if (i >= 0) draft.splice(i, 1)
    })
  }

  clone(id: string, opts: CloneOptions): Profile {
    const src = this.get(id)
    if (src === null) throw new Error('环境不存在：' + id)

    const all = this.store.read()
    const newProfileId = newId(all)
    // newFingerprint=false 时连 seed 一起复制：同一身份多开，服务端看到的是同一个人
    const seed = opts.newFingerprint ? deriveSeed(newProfileId) : src.seed
    const fingerprint = opts.newFingerprint ? buildFingerprint(src.platform, seed) : structuredClone(src.fingerprint)
    const now = Date.now()

    const copy: Profile = {
      ...src,
      id: newProfileId,
      name: (opts.name ?? '').trim() || src.name + ' 副本',
      seed,
      fingerprint,
      status: 'idle',
      lastError: undefined,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null,
      tags: src.tags.slice()
    }

    this.store.update((draft) => {
      draft.push(copy)
    })
    return deepCopy(copy)
  }

  /**
   * 重掷种子 + 重新生成整套指纹。
   *
   * deriveSeed 只接受 profileId，直接再算一次会得到同一个 seed，
   * 所以在 info 后面拼一次性 nonce：仍然由 masterKey 派生（不可预测、不可反推），
   * 但结果与旧值无关，等于换了一个身份。
   */
  regenerate(id: string): Profile {
    const existing = this.get(id)
    if (existing === null) throw new Error('环境不存在：' + id)

    const seed = deriveSeed(existing.id + '#' + Date.now().toString(36))
    const fingerprint = buildFingerprint(existing.platform, seed)
    const next: Profile = {
      ...existing,
      seed,
      fingerprint,
      browserVersion: fingerprint.uaVersion,
      updatedAt: Date.now()
    }

    this.store.update((draft) => {
      const i = draft.findIndex((p) => p.id === id)
      if (i >= 0) draft[i] = next
    })
    return deepCopy(next)
  }
}
