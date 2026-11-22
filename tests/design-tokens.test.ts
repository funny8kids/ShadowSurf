/**
 * 设计令牌的完整性。
 *
 * `var(--xxx)` 引用了一个**未定义**的变量时，CSS 不会报错 ——
 * 浏览器只是把那条声明当无效丢掉。表现是"这行字颜色怎么是继承的"，
 * 而且只在特定 hover / 特定面板里出现，极难发现。
 *
 * 这里扫一遍所有 CSS / TSX，找出既没在 tokens.css 定义、
 * 也没有 fallback、也不是运行时注入（cssVars）的引用。
 *
 * 运行时注入的白名单：`--c`（环境卡颜色）、`--grp-color`（分组色）、
 * `--pct`（进度条）—— 它们通过 style 属性传给组件，不在 CSS 里定义。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')

/** 运行时通过 cssVars / style 注入的变量，不在 CSS 里定义 */
const RUNTIME_INJECTED = new Set(['--c', '--grp-color', '--pct', '--tab-side-w'])

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(css|tsx?)$/.test(name)) out.push(p)
  }
  return out
}

test('所有 var(--x) 引用都必须有定义、fallback 或运行时注入', () => {
  const tokens = readFileSync(join(ROOT, 'src/renderer/styles/tokens.css'), 'utf8')
  const defined = new Set(
    [...tokens.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)].map((m) => m[1])
  )

  const missing: string[] = []
  for (const file of walk(join(ROOT, 'src/renderer'))) {
    const src = readFileSync(file, 'utf8')
    // var(--x) 或 var(--x, fallback) —— 后者是安全的
    for (const m of src.matchAll(/var\((--[a-zA-Z0-9-]+)\s*([,)])/g)) {
      const name = m[1]
      const hasFallback = m[2] === ','
      if (hasFallback || defined.has(name) || RUNTIME_INJECTED.has(name)) continue
      missing.push(`${name} @ ${file.replace(ROOT + '\\', '').replace(ROOT + '/', '')}`)
    }
  }

  assert.deepEqual(missing, [], `发现未定义且无 fallback 的 CSS 变量：\n${missing.join('\n')}`)
})

/**
 * 用户可见文案不能硬编码中文：产品有完整的 zh/en 词条，
 * 硬编码的那几句在英文界面下会突然冒出中文。
 *
 * 只扫 toast.push / 标题这类"直接给最终用户看"的调用，
 * 不扫代码注释与 i18n 目录本身。
 */
test('渲染层没有硬编码的中文 toast', () => {
  const offenders: string[] = []
  for (const file of walk(join(ROOT, 'src/renderer'))) {
    if (file.includes('i18n')) continue
    const src = readFileSync(file, 'utf8')
    // toast.push('中文') / toast.push(`中文...`) —— 排除 t('...') 与 errorMessage(err)
    const re = /toast\.push\(\s*[`'\"]([^`'\"]*[\u4e00-\u9fff][^`'\"]*)[`'\"]/g
    for (const m of src.matchAll(re)) {
      const line = src.slice(0, m.index).split('\n').length
      offenders.push(`${file.replace(ROOT, '')}:${line} — ${m[1].slice(0, 40)}`)
    }
  }
  assert.deepEqual(offenders, [], `发现硬编码中文 toast：\n${offenders.join('\n')}`)
})
