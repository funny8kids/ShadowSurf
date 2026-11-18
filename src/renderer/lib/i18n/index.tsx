/**
 * 中英文切换（i18n）核心。
 *
 * ── 为什么是「flat key + 按域拆文件」而不是嵌套对象 ──
 * 1. flat key（`nav.env`）在 grep 里能直接搜到「谁在用这条文案」，
 *    嵌套对象只能搜到一半。
 * 2. 按域拆成 `catalog/*.ts` 是为了并行开发：多个模块同时做翻译时，
 *    各自改自己的文件，不会在同一个大对象上互相覆盖。
 *
 * ── 缺 key 的行为 ──
 * 英文缺 key 时**回落到中文**而不是显示 `nav.env`：
 * 半成品的英文界面显示中文，比显示一堆点号键名更可读，也更容易发现漏翻。
 * 中文是源语言，永远全量。
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

import { setCurrentLang } from './lang-store'
import { en as enCommon, zh as zhCommon } from './catalog/common'
import { en as enNav, zh as zhNav } from './catalog/nav'
import { en as enProfiles, zh as zhProfiles } from './catalog/profiles'
import { en as enTasks, zh as zhTasks } from './catalog/tasks'
import { en as enTools, zh as zhTools } from './catalog/tools'
import { en as enTools2, zh as zhTools2 } from './catalog/tools2'
import { en as enBrowser, zh as zhBrowser } from './catalog/browser'
import { en as enAgent, zh as zhAgent } from './catalog/agent'
import { en as enExtensions, zh as zhExtensions } from './catalog/extensions'

export type Lang = 'zh' | 'en'
export type Dict = Record<string, string>

const ZH: Dict = {
  ...zhCommon,
  ...zhNav,
  ...zhProfiles,
  ...zhTasks,
  ...zhTools,
  ...zhTools2,
  ...zhBrowser,
  ...zhAgent,
  ...zhExtensions
}

const EN: Dict = {
  ...enCommon,
  ...enNav,
  ...enProfiles,
  ...enTasks,
  ...enTools,
  ...enTools2,
  ...enBrowser,
  ...enAgent,
  ...enExtensions
}

const LANG_KEY = 'ss:lang'

function readLang(): Lang {
  try {
    const v = localStorage.getItem(LANG_KEY)
    if (v === 'en' || v === 'zh') return v
  } catch {
    /* 隐私模式 localStorage 可能抛错，回落中文 */
  }
  return 'zh'
}

export interface I18nApi {
  lang: Lang
  setLang: (next: Lang) => void
  /** `t('nav.env')`；`{name}` 占位由第二个参数替换 */
  t: (key: string, vars?: Record<string, string | number>) => string
}

const I18nContext = createContext<I18nApi>({
  lang: 'zh',
  setLang: () => {},
  t: (key) => key
})

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(readLang)

  // 同步 <html lang>：读屏、拼写检查、CSS `:lang()` 都看这个属性
  useEffect(() => {
    setCurrentLang(lang)
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'
    try {
      localStorage.setItem(LANG_KEY, lang)
    } catch {
      /* 存不进去只影响下次启动的语言，不影响本次 */
    }
  }, [lang])

  const t = useCallback(
    (key: string, vars?: Record<string, string | number>) => {
      const dict = lang === 'en' ? EN : ZH
      let out = dict[key]
      if (out === undefined) {
        // 英文缺 key 回落中文（见文件头注释）
        out = ZH[key] ?? key
      }
      if (vars) {
        for (const [k, v] of Object.entries(vars)) {
          out = out.split(`{${k}}`).join(String(v))
        }
      }
      return out
    },
    [lang]
  )

  const api = useMemo<I18nApi>(() => ({ lang, setLang: setLangState, t }), [lang, t])

  return <I18nContext.Provider value={api}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nApi {
  return useContext(I18nContext)
}

/** 给非组件代码（如常量表）用的取值器，避免把 t 传进每一个工具函数 */
export function tFor(lang: Lang) {
  return (key: string, vars?: Record<string, string | number>): string => {
    const dict = lang === 'en' ? EN : ZH
    let out = dict[key] ?? ZH[key] ?? key
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        out = out.split(`{${k}}`).join(String(v))
      }
    }
    return out
  }
}
