/**
 * 三项新增商业能力的端到端验收（真 Electron + 本地 HTTP 站点）：
 *   1. 代理组：CRUD + 环境绑定 + 互斥（挂组时清掉单条代理）
 *   2. 动作同步器：多环境同脚本批量回放，逐环境给结论
 *   3. Webhook：CRUD + 测试投递到本机 HTTP 服务（拿到真实 200）
 *
 * 跑法（远程）：DISPLAY=:99 node tools/e2e-commercial.mjs
 */
import { _electron as electron } from 'playwright-core'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = process.cwd()
const UD = mkdtempSync(join(tmpdir(), 'ss-e2e-commercial-'))
const failures = []
const check = (cond, label, detail) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'} ${label}${detail ? ' · ' + detail : ''}`)
  if (!cond) failures.push(label)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* 本地 Webhook 接收端：记录收到的 payload */
const received = []
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    received.push({ url: req.url, body: JSON.parse(body || '{}') })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true}')
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const PORT = server.address().port

const app = await electron.launch({
  executablePath: resolve(ROOT, 'node_modules/electron/dist/electron'),
  args: ['.', '--user-data-dir=' + UD, '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  cwd: ROOT,
  env: { ...process.env, DISPLAY: process.env.DISPLAY || ':99' },
  timeout: 60000
})
const w = await app.firstWindow()
await w.waitForTimeout(1800)

try {
  /* ── 1. 代理组 ── */
  console.log('\n[1] 代理组：CRUD + 绑定 + 互斥')
  const proxies = []
  for (const name of ['US-1', 'US-2', 'UK-1']) {
    const p = await w.evaluate(
      async (n) =>
        await window.ss.proxies.create({
          name: n,
          protocol: 'http',
          host: '127.0.0.1',
          port: 18080,
          region: n.slice(0, 2)
        }),
      name
    )
    proxies.push(p)
  }
  check(proxies.length === 3, '建了 3 条代理记录')

  const group = await w.evaluate(
    async (ids) =>
      await window.ss.proxyGroups.create({
        name: 'US 池',
        proxyIds: ids,
        strategy: 'round-robin',
        failover: true
      }),
    proxies.map((p) => p.id)
  )
  check(group.proxyIds.length === 3 && group.strategy === 'round-robin', '代理组创建成功', group.id)

  const updated = await w.evaluate(
    async (g) => await window.ss.proxyGroups.update(g.id, { strategy: 'sticky' }),
    group
  )
  check(updated.strategy === 'sticky', '策略可更新')

  const prof = await w.evaluate(async () => await window.ss.profiles.create({ name: 'E2E-组环境' }))
  const bound = await w.evaluate(
    async (p) =>
      await window.ss.profiles.update(p.id, {
        proxy: { type: 'http', host: '1.2.3.4', port: 8080 },
        proxyGroupId: p.gid
      }),
    { id: prof.id, gid: group.id }
  )
  check(bound.proxyGroupId === group.id, '环境挂上代理组')

  // 单独挂一条代理应自动退出组（store 层互斥，不是 UI 层的约定）
  const switched = await w.evaluate(
    async (id) =>
      await window.ss.profiles.update(id, {
        proxy: { type: 'http', host: '5.6.7.8', port: 8080 }
      }),
    prof.id
  )
  check(switched.proxyGroupId === null, '挂单条代理自动退出组（store 层强约束）')

  // 再挂回组，单条代理要被清掉
  const regrouped = await w.evaluate(
    async (p) => await window.ss.profiles.update(p.id, { proxyGroupId: p.gid }),
    { id: prof.id, gid: group.id }
  )
  check(regrouped.proxy === null, '挂组时清掉单条代理（避免两处事实打架）')

  const list = await w.evaluate(async () => await window.ss.proxyGroups.list())
  check(list.length === 1, '代理组列表正确')

  /* ── 2. 动作同步器 ── */
  console.log('\n[2] 同步执行：多环境批量回放')
  const script = await w.evaluate(async () => {
    const s = await window.ss.scripts.save({
      name: 'E2E 同步脚本',
      steps: [{ action: 'navigate', url: 'https://example.com' }]
    })
    return s
  })
  check(Boolean(script.id), '脚本已保存', script.id)

  const targets = []
  for (const name of ['同步 A', '同步 B', '同步 C']) {
    const p = await w.evaluate(async (n) => await window.ss.profiles.create({ name: n }), name)
    targets.push(p)
  }
  // 无窗口的环境应逐条失败，而不是整批中断
  let batchError = false
  let batch = null
  try {
    batch = await w.evaluate(
      async (p) => await window.ss.scripts.runBatch(p.sid, p.ids),
      { sid: script.id, ids: targets.map((t) => t.id) }
    )
  } catch (err) {
    batchError = true
  }
  check(!batchError && batch !== null, '批量回放返回聚合结果（未整体抛错）')
  check(
    batch && batch.items.length === 3 && batch.items.every((i) => !i.ok),
    '3 个未启动环境逐条给出失败结论',
    batch ? `ok=${batch.okCount} failed=${batch.failedCount}` : 'n/a'
  )
  check(
    batch && batch.items.every((i) => /打开|窗口|连接/.test(i.error ?? '')),
    '失败原因可行动（提示先启动环境）'
  )

  /* ── 3. Webhook ── */
  console.log('\n[3] Webhook：CRUD + 测试投递')
  const hook = await w.evaluate(
    async (port) =>
      await window.ss.webhooks.create({
        url: `http://127.0.0.1:${port}/hook`,
        events: ['task.done'],
        // 接收端在本机回环上 —— 主进程默认**拒绝**投递到回环 / 私网 /
        // 链路本地（云元数据）地址，所以这里显式声明"允许内网"。
        // 这不是绕过检查，而是那个检查本来就有的开关：
        // 有些人的回调就在自己家里（NAS、家庭服务器）。
        allowInternal: true
      }),
    PORT
  )
  check(hook.url.includes(String(PORT)), 'Webhook 创建成功', hook.id)

  // 不开开关时，回环地址必须**投不出去**。
  // 这条是 SSRF 防护的回归护栏：主进程发出的请求绕开了浏览器的 CORS 与
  // 代理策略，能打到本机管理接口（Docker 2375 等）与云元数据服务。
  const guarded = await w.evaluate(
    async (port) => {
      const h = await window.ss.webhooks.create({
        url: `http://127.0.0.1:${port}/hook`,
        events: ['task.done']
      })
      const r = await window.ss.webhooks.test(h.id)
      await window.ss.webhooks.remove(h.id)
      return r
    },
    PORT
  )
  check(
    guarded.ok === false && guarded.status === 0 && /拒绝|内网/.test(String(guarded.error ?? '')),
    '默认拒绝投递到回环 / 内网地址',
    `ok=${String(guarded.ok)} status=${String(guarded.status)} ${String(guarded.error ?? '')}`
  )

  // 非法协议必须在主进程拒绝
  let badRejected = false
  try {
    await w.evaluate(async () => await window.ss.webhooks.create({ url: 'file:///etc/passwd' }))
  } catch (err) {
    badRejected = /http/.test(String(err))
  }
  check(badRejected, 'file:// 回调地址被拒绝')

  const result = await w.evaluate(async (id) => await window.ss.webhooks.test(id), hook.id)
  check(result.ok && result.status === 200, '测试投递真实送达', `HTTP ${result.status}`)
  await sleep(300)
  check(received.length === 1, '本地服务收到了 1 条 payload')
  check(
    received[0]?.body?.event === 'task.done' && received[0]?.body?.data?.test === true,
    'payload 形状正确（event / at / data）',
    JSON.stringify(received[0]?.body ?? {})
  )

  const hooks = await w.evaluate(async () => await window.ss.webhooks.list())
  check(hooks.length === 1, 'Webhook 列表正确')

  await w.evaluate(async (id) => await window.ss.webhooks.remove(id), hook.id)
  const after = await w.evaluate(async () => await window.ss.webhooks.list())
  check(after.length === 0, 'Webhook 删除成功')
} finally {
  try {
    await app.close()
  } catch {
    /* 已退出 */
  }
  server.close()
  try {
    rmSync(UD, { recursive: true, force: true })
  } catch {
    /* 清理失败不影响结论 */
  }
}

console.log('\n================ 汇总 ================')
if (failures.length === 0) {
  console.log('ALL PASS')
  process.exit(0)
} else {
  console.log(`FAILED ${failures.length} 项：${failures.join(' / ')}`)
  process.exit(1)
}
