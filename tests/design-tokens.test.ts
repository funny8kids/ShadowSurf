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
