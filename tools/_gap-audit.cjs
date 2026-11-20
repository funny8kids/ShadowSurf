/**
 * 从 docs/competitive-parity.html 的对照矩阵里抽出「ShadowSurf 列为缺失 / 部分 / 未核实」的行。
 * 只读分析脚本，不改仓库。
 */
const fs = require('fs')
const html = fs.readFileSync('docs/competitive-parity.html', 'utf8')

// 取所有 <table>...</table> 块
const tables = [...html.matchAll(/<table>([\s\S]*?)<\/table>/g)].map((m) => m[1])
const out = []
for (const [ti, table] of tables.entries()) {
  const rows = [...table.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) => m[1])
  for (const row of rows) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1].replace(/<[^>]+>/g, '').trim())
    if (cells.length < 5) continue
    const label = cells[0]
    // 最后一列是 ShadowSurf
    const last = cells[cells.length - 1]
    if (last === '缺失' || last === '部分' || last === '未核实') {
      out.push({ table: ti, label, shadowSurf: last })
    }
  }
}
const byState = {}
for (const r of out) {
  ;(byState[r.shadowSurf] ||= []).push(r.label)
}
for (const [state, labels] of Object.entries(byState)) {
  console.log(`\n=== ShadowSurf = ${state}（${labels.length} 项）===`)
  for (const l of labels) console.log('  · ' + l)
}
