# 风险闸门与指纹覆盖 —— 残余项清零交付（第五轮）

**日期**：2026-11-01
**HEAD**：`c8d81fb`（工作区 **0 个未提交改动**，`build.dirty = false`，`outSha1` 见 artifacts/anticheat-c8d81fb.json）
　　（本报告自身是随后的一次 docs-only 提交，不改任何源码；所有读数归属 `c8d81fb`，
　　　并用 `outSha1` 钉住当时那一份构建产物 —— 只认 commit 不认产物的读数会被「重新构建」骗过去。）
**参与**：安全官 · 质量门神 ×3 · 排障手 ×3 · 产品评审员 · 设计顾问
**本轮目标**：把 `remediation-plan-2026-11-01.md` 的 3 条 🟠 + 5 条 🟡 **全部**落地 —— 包括计划里标了「建议不修」的 `#22 4.4`，和两条标了「必须先测」的 B 档项。

> 上一轮把「未完成」改成了读数。本轮把**读数变成了行动** ——
> 其中有两条行动的前提，在测完之后被自己的读数推翻了。

---

## TL;DR

- **整体结论**：🟢 **残余项清零**。8 条全部处置：**6 条修复 + 2 条按读数改判**（一条原方案被推翻，一条按计划改成环境级配置而非按钮）。
- **最重要的三条读数**（它们各自改变了要做的动作）：
  1. **`RTCPeerConnection` 在 worker 里是 `undefined`** → 「WebRTC 下沉 worker」**无对象**。计划 §1.2 的前提（`[Exposed=(Window,Worker)]`）在本仓库的实际内核上不成立。改成一条断言 **AC-23**，盯「内核哪天把它开进 worker」。
  2. **`shared_worker` 不被 `setAutoAttach` 覆盖，但手动 `attachToTarget` 拿到的 session 是可用的** → 从「不可达」变成「可事后注入」。它没被暂停，却在脚本 fetch 之前就把 target 建出来了，**注入赢了竞态**（3/3）。
  3. **`service_worker` 顶层结构性不可覆盖，`install` 抢得到** → 覆盖被拆成两层承诺，各自一条门禁，顶层**只作读数不作判据**。
- **门禁从 8 段扩到 10 段**，新增 3 个验收脚本、1 个探针；`verify:all` 本身修掉一处**自己踩自己的假绿**（见 §6 第 10 类）。
- **本轮翻出两个旧缺陷**：`listInjectionIssues()` **零调用方**（攒了一堆事实，没有任何界面能读到）；`verify:all` 用**开发模式**跑单测，导致一条三态断言在门禁里**每次都 skip**。

---

## 🎯 结论卡片

| 项目 | 内容 |
|------|------|
| Go / No-Go | 🟢 **内部一致性 Go** · 🟡 **对外可判定性未达标**（见 §10） |
| 处置结果 | 修复 6 · 按读数改判 2 |
| 实测读数 | typecheck 双绿 · **176 tests / 175 pass / 0 fail / 1 skip** · seed-at-rest exit 0（反向 7/7）· seed-ipc 成立 · mask-ui 成立 · mask-exemption **8/8** · injection **25/25** · worker exit 0 · shared-worker **5/5** · **uach 7/7** · anticheat **21/21** |
| 唯一 skip | 「注入脚本不得改写 `Function.prototype.toString`」—— **已知代价，不是欠账**，§3 有矩阵支撑 |
| 读数归属 | `c8d81fb`，工作区干净，`build.dirty=false` |
| 提交数 | 12（`2d19963` → `c8d81fb`） |
| **外部视角** | creepjs：命中 **8 项**（不是「11 条 lies」——那个数字是第一版工具数错了 class）；UA-CH 与两条字体通道**已修**，DOM 布局通道**未修**（§10） |

---

## 1. 三条 🟠

### 1.1 `service_worker` / `shared_worker` 注入 —— ✅ 完成，但**只承诺覆盖到哪一层**

原计划要求「先测再谈」。测完的结论是：两条路径**都能注入**，但**能覆盖的阶段完全不同**，所以不能合并成一句「已覆盖」。

| 阶段 | `shared_worker` | `service_worker` |
|---|---|---|
| 脚本**顶层** | 竞态赢了（3/3 读到 profile 值）—— **不保证** | **结构性不可覆盖**（读到宿主值 32） |
| 事件处理器（`message` / `install` / `fetch`） | ✅ | ✅（`resume` → 注入完成 **2–5ms**，稳定抢在 `install` 之前） |

原因分别是：

- **`shared_worker`**：`Target.setAutoAttach` 不覆盖它（B2 探针的读数），所以走「`setDiscoverTargets` → `targetCreated` → 手动 `attachToTarget`」。它**没有被暂停**，但 target 在脚本 fetch **之前**就建出来了，所以 attach + 注入通常赶在脚本执行前。这是**竞态赢了**，不是保证 —— 所以顶层只写进读数，不写成门禁。
- **`service_worker`**：暂停态下**任何命令都不返回**，只能先 `runIfWaitingForDebugger` 再抢注入，而 resume 那一刻顶层已经执行完了。`install` 事件要等脚本解析 + 微任务，注入的本地往返（2–5ms）抢得过。

`npm run verify:shared-worker`（`435b0cd`）的读数：

```
宿主核数 = 32，profile 核数 = 4（时区 America/Los_Angeles）
[页面]            cores=4   tz=America/Los_Angeles
[shared_worker]   顶层读       cores=4   tz=America/Los_Angeles
                  延迟消息读    cores=4   tz=America/Los_Angeles
[service_worker]  顶层读       cores=32  tz=Asia/Shanghai      ← 结构性不可覆盖
                  install 时刻 cores=4   tz=America/Los_Angeles
                  message 事件 cores=4   tz=America/Los_Angeles
[记账] shared_worker  /  service_worker  两条 [inject-issue] 都在
```

5 条门禁全部成立：`main`（对照）· `shared`（延迟消息）· `swc`（message 事件）· `ledger`（stderr 有记录）· `ledger-ipc`（**IPC 读得到**）。

#### 三个在实现里被踩到的坑（都写进了代码注释）

1. **手动 attach 的 target 未暂停** —— 无条件发 `runIfWaitingForDebugger` 会回错误，被记成「放行失败（该 target 会一直挂住）」的**假警报**。改成按 `waitingForDebugger` 决定是否发，且用 `released` 标记去重。
2. **注入脚本不幂等** —— `_maskOne` 会把已包过的函数再包一层。`swAttached` Set 去重。
3. **`SERVICE_WORKER_EVAL_TIMEOUT = 2_000`** —— 默认 15s 在这条竞态路线上没有意义：抢不到就是抢不到，等 15s 只是让页面多卡 15s。

### 1.2 WebRTC 下沉 worker —— ❌ **原方案被推翻**，改成一条断言

计划 §1.2 的前提是 `RTCPeerConnection` 是 `[Exposed=(Window,Worker)]`，worker 里存在，所以「移植是机械工作」。

**前置实测（一行）的读数推翻了它**：

```
[worker]        rtcPeer=undefined  rtcSender=undefined  rtcReceiver=undefined
[shared_worker] rtcPeer=undefined  rtcSender=undefined  rtcReceiver=undefined
```

本仓库实际内核（Electron）里，三个 WebRTC 接口在 **dedicated worker 与 shared worker 里都是 `undefined`**。规范确实是 `[Exposed=(Window,Worker)]`，但 Chromium 在 worker 侧的 WebRTC 是**按需启用**的，这里没启用。

所以「下沉」**没有对象** —— 没有 `RTCPeerConnection` 可以 hook，`new Worker(blob)` 里也拿不到候选。

**处置**：不加 hook，加一条**断言** `AC-23`「Worker 里不得有 WebRTC 接口」。三态：

| 读数 | 判定 |
|---|---|
| 读到定义值（`function` 等） | **FAIL** —— 内核把它开进 worker 了，候选过滤必须立刻下沉 |
| 读到 `undefined` | PASS |
| 没读到（探针没跑起来） | **未测量**（exit 3），不是通过 |

这条断言的价值在于**它会在需要动手的那一刻自己变红**，而不是等人想起来「当初说 worker 里没有 WebRTC」。同时 `session.ts` 的威胁模型里删掉了「Worker 里的新 `RTCPeerConnection`」这一条 —— 不存在的泄漏面留着，会让真正那几条看起来更少。

`fingerprint.ts` 的 `buildWorkerScript` 注释里写明了「**为什么这里没有 WebRTC 那一段（别『补全』它）**」—— 否则下一个人看到 page 脚本有、worker 脚本没有，第一反应就是补上。

### 1.3 `seed` 仍跨 IPC —— ✅ 完成

`Profile` 类型里**删掉了 `seed`**，换成 `seedHint`（`sha256(seed)` 前 8 位，用于「这两个环境是不是同一个种子」的肉眼比对）。完整种子只存在于 main 的 `StoredProfile`，渲染层要预览指纹时走 `profiles.preview(id, patch)`。

**为什么是删而不是加权限校验**：类型层删除是**编译期**的 —— 任何读取都是编译错误，不需要运行时断言，也不会因为某个 `as any` 漏网。

读数（`verify:seed-ipc`）：

```
成立：profiles.list() 载荷里没有种子，preview 与落盘指纹逐字段相等，且只读
```

三个断言一起成立才算过：「不泄漏」「功能还在」「preview 是只读的（不能借它写指纹）」—— 少任何一个都能被绕过。

---

## 2. 五条 🟡

### 2.1 `mask.list` 有读者了 —— ✅

环境卡片每行一个状态点，颜色由 **`judgeMask`** 决定（与拦 L2 同一张表）。**红线**：界面红而门禁放行（或反过来）比没有这个点更坏 —— 用户会按界面去关掉机制。

`verify:mask-ui` 的判据不是「有个点」，而是：

```
成立：判定表 10 行的色调逐行一致，载荷截断与空值约定成立，IPC 上没有表外组合
```

「IPC 上没有表外组合」这一条是防「界面自己造了一个状态」—— 那张表必须能被逐格核对。

### 2.2 AC-14 非 en-US 轮次 —— ✅

原条件是「profile 语言与宿主默认渲染不同」。宿主是 `en-GD`，所以 `en-US` profile 也能满足 —— **这就是无鉴别力的来源**：en-US 下「locale 正确实现」与「写死 en-US」读数完全相同。

改成「**非 `en-*`** 且与宿主渲染不同」，不满足就**记为未测量（exit 3）**，不是通过。

读数（三轮，`435b0cd`）：

| 轮次 | profile | mismatch | unmeasured | 分组 |
|---|---|---|---|---|
| 1 | macos / en-US | 0 | 0 | A 13/13 · B 5/5 · C 2/2 |
| 2 | windows / en-US | 0 | 0 | A 13/13 · B 5/5 · C 2/2 |
| **3** | **macos / ja-JP** | **0** | **0** | A 13/13 · B 5/5 · C 2/2 |

`crossOs = true`。`localeRound.usedProfileLang = "ja-JP"`，`judged = true`。

#### 顺带修掉一个退出码漏洞

原来只有「locale 前置条件不满足」会 exit 3。**单条 AC 记 `unmeasured` 时 exit 仍是 0** —— 表格里写「未测量」，CI 是绿的。现在：任意 gate 判据未测量 → **exit 3**，并打印「有 N 条该判的判据没测到」。

这条的反向验证很直接：删掉 AC-23 里读 `rtcReceiver` 的那一行 → 它变 `unmeasured`，改前 exit 0，改后 **exit 3**。

### 2.3 `describeAction` 三份 → 一份 —— ✅

三份的差别不只是措辞：渲染层那份把英文 `direction` 直接拼进中文（「向**down**滚动 300」），press 的默认键一处写 `'Enter'` 一处写 `'（未指定）'`。这类分叉**不会让任何测试变红**，只会让界面和确认窗口对同一个动作说两种话。

现在 `describeAction` 只有一份（`shared/protocol.ts`，`snapshot` 可选）。审计那份改名为 `describeAuditTarget` —— 它的输出参与哈希、措辞冻结，本来就不是同一件事，**同名才是问题**。

结构断言：`describeAction` 只允许一个 `export function`，且**带反向自检**（正则抓不到旧写法时，这条断言自己判失败 —— 否则它是一个恒真空断言）。

### 2.4 `listInjectionIssues` 零读者 —— ✅ 本轮翻出来的旧缺陷

主进程把「`shared_worker` 顶层没覆盖」「`service_worker` 顶层覆盖不了」这些事实攒在内存里，stderr 也打了，**但没有任何界面能读到**。于是报告里那句「已记录」只在终端成立 —— 用户和排障的人都看不见。

现在：`CH.injection.list` → preload → 环境抽屉「影子」tab 里的「本次会话的注入问题」（按 `profileId` 过滤，最近 5 条，空态明说「没记录 ≠ 伪装完整」）。

**两条通道刻意不合并**：`mask.list` 是「此刻状态」（会被后来的测量覆盖），`injection.list` 是「过程中发生过什么」（追加、不覆盖）。合并之后「现在好了」会把「刚才坏过」抹掉。

门禁是两条，分别盯两条路：

| gate | 判据 | 反向验证 |
|---|---|---|
| `ledger` | stderr 里两条 `[inject-issue]` 都在 | — |
| `ledger-ipc` | 同一条台账 **经 IPC 读得到** | handler 换成 `() => []` → 前 4 条仍绿、这条红，4/5，**exit 1** |
| 结构断言 | `bridge().injection.list()` 在抽屉里有调用 | 改成 `injection.listX()` → 173 pass / **1 fail**，红的正是这条 |

只查 stderr 是不够的 —— 那正是「零读者」这个缺陷的形态。

### 2.5 `#22 4.4`「以未伪装身份继续」—— ✅ 按计划做成**环境级配置**，不是按钮

计划建议「不修」，但如果业务必须要，只能做成**显式的环境级配置**。本轮按后者做了 —— 因为「全部都做」这句话包含这一条。

| 要求（计划 §2.4） | 实现 |
|---|---|
| 配置项 `Profile.allowUnmaskedL2`，默认 false | ✅ **必填布尔**（不是可选 —— 可选布尔会让每个读点自己回答「没这个字段算什么」，漏问一次就是默认豁免） |
| 开启需**输入环境名**确认（不是点确定） | ✅ `setExemption(id, enabled, confirmName)`，严格比对 |
| 审计写「授权=环境级豁免」且与用户点允许**分列** | ✅ `audit.ts` 单独一列：「授权=环境级豁免（allowUnmaskedL2，环境 X），被豁免的前提：…」 |
| `maskState === 'ok'` 时**自动收回** | ✅ `onMaskState` 里 `record.state === 'ok'` → `revokeExemption` + 写审计 + 推 `profileState` |
| 报告与界面都标注「已豁免伪装闸门」 | ✅ 卡片上单独一个 `mask-dot exempt`（第四种语义色 `--violet`，绿/黄/红已分别被占用） |

#### 两个设计决定值得单独记

**① 豁免不写进 `judgeMask`。** 判定表分成 `judgeMask`（纯状态）+ `decideMaskGate(record, exempt)`（加一层配置覆盖）。混在一起之后，「十格判定表逐格成立」这条断言就没法再逐格核对了 —— 表里会多出「豁免」这个维度，而它是**配置**不是**状态**。

**② 豁免不能覆盖 `missing`。** 那时连哪个环境都不知道，豁免无从归属。单测里专门有一条：

```
豁免覆盖了状态失败，但结论里必须留得下「被豁免过」的痕迹
```

#### 读数（`verify:mask-exemption`，8/8）

```
create-default-off   false   update-cannot-set     false
create-cannot-set    false   wrong-name-rejected   {threw: true, value: false}
enable               true    clone-resets          false
auto-revoke          maskState=ok → false
audit-revoke         count=1（"伪装已回到 ok，环境级豁免（allowUnmaskedL2）已自…"）
```

`update()` 和 `create()` **都写不进这个字段** —— 这是刻意的：如果它能被 `update()` 保存，那它就能被一个裸 JSON patch 绕过，而它控制的是一道安全闸。

---

## 3. `Function.prototype.toString` —— 用矩阵否掉了 Proxy，改成「已知代价」

计划 §3.1 的判断是「照字面改 Proxy 会更糟」。本轮把它变成了**读数**（`tools/probe-tostring.mjs`，5 条检测手法 × 3 种实现）。

结论：三种实现**都有 tell**，问题不是「哪个干净」而是「哪条最不常被踩到」。

| 实现 | 主要 tell | 踩到需要什么 |
|---|---|---|
| 赋值改写（现状） | `try { Function.prototype.toString.call(1) } catch (e) { e.stack }` 里多一帧 `at toString` | **主动踩异常路径** |
| `Proxy` 包装 | `fn.name` 与 `toString` 内名字矛盾（`function () { [native code] }` 丢名字） | **一行正则，不需要任何前提** |
| 不 patch | `toString` 输出里没有 hook 痕迹，但 hook 本身可被 `'prototype' in fn` 之类发现 | — |

所以 **不改**。这条 skip 从「真实债务」改判为「**已知并接受的代价**」，reason 里写清了取消条件。报告里不再把它算作欠账 —— 继续挂着会让人以为「这里还有活没干」。

---

## 4. 本轮实测读数（`435b0cd`，工作区干净）

```
npm run typecheck             node ✅  web ✅
npm run test:gate             176 tests / 175 pass / 0 fail / 1 skip
npm run verify:seed-at-rest   exit 0（反向验证 7/7；真实目录 19 文件 / 10 敏感字段 → 通过）
npm run verify:seed-ipc       成立（载荷无种子 · preview 与落盘逐字段相等 · 且只读）
npm run verify:mask-ui        成立（判定表 10 行色调逐行一致 · 截断与空值约定 · IPC 无表外组合）
npm run verify:mask-exemption 8/8 成立
npm run verify:injection      25/25 成立
npm run verify:worker         exit 0（GL 4/4 对上配置，崩溃 0，[inject-issue] 0）
npm run verify:shared-worker  5/5 成立
npm run verify:uach           7/7 成立（四种上下文 × platform/platformVersion）
npm run verify:anticheat      21/21 通过（AC-14 三轮 0 mismatch，crossOs=true，AC-23 measured=true）
```

`verify:all` 现在是 13 段：`typecheck → build → test:gate → seed-at-rest → seed-ipc → mask-ui → mask-exemption → injection → worker → shared-worker → fonts → uach → anticheat`。

**唯一 skip**：`Function.prototype.toString`（§3，已知代价）。
**AC-12**（两个环境必须互不相同）标 `skip`，需要 `--nightly`（两次启动）—— 它在 `verify:anticheat:nightly` 里跑，不在 `verify:all` 里。这是**明确的门禁分工**，不是漏测。

---

## 5. 反向验证清单（每条新门禁都打断过）

| 门禁 | 打断方式 | 读数 |
|---|---|---|
| `ledger-ipc` | handler 换成 `() => []` | 前 4 条仍绿、这条红，4/5，**exit 1** |
| `injection.list` 有读者 | 抽屉里改成 `injection.listX()` | 173 pass / **1 fail**，红的正是这条 |
| `dev-only 诊断通道` 在门禁里生效 | 源码 mtime 拨新（产物变旧） | **not ok 166**，174 pass / 1 fail；改前这里是 174 pass / **2 skip** |
| AC-23（worker 无 WebRTC） | 把 `o.rtcPeer` 改成 `"function"` | AC-23 **FAIL**，20/21，**exit 1** |
| AC-23 的未测量分支 | 删掉读 `o.rtcReceiver` 那一行 | AC-23 **未测量**，**exit 3**（改前这里是 exit 0） |
| `shared` gate | 去掉 `targetCreated` 发现 | shared 读到 32（宿主），**2/4，exit 1** |
| `swc` gate | 跳过 service_worker 注入 | swc 读到 32（宿主），**2/4，exit 1** |
| 豁免不覆盖 `missing` | 让 `decideMaskGate` 允许豁免 `missing` | `mask-gate.test` 红 |
| 门禁侧真读豁免 | 门禁侧豁免恒 `false` | `probe-gate` **FAIL / exit 1** |
| 环境名校验 | 去掉名字比对 | 4/8（`wrong-name-rejected` 红） |
| 自动收回 | 去掉 `revokeExemption` 调用 | 7/8（`auto-revoke` 红） |

「门禁侧真读豁免」这条要特别说：**单测绿 + 门禁侧恒 false** 这个组合是可以通过 8 条里的 7 条的 —— 因为 `verify:mask-exemption` 验的是**配置能不能存**，不是**门禁认不认**。两个方向必须各有一条。

---

## 6. 假绿分类学（补第 9、10 类）

前八类见上一版。本轮补两类，都是**这一轮自己踩到的**：

| # | 形态 | 本轮实例 |
|---|---|---|
| **9** | **零读者** | `listInjectionIssues()` 攒了一堆事实、stderr 也打了，**没有任何界面能读到**。「已记录」只在终端成立 |
| **10** | **门禁用了宽松模式** | `verify:all` 调 `npm run test`（开发模式）而不是 `test:gate`（门禁模式），于是那条三态断言**每次都判「产物过期」→ skip**。断言是对的、skip 的理由也是对的，错的是**门禁段选错了命令** |

第 10 类的隐蔽之处：它**在报告里看起来像「有一条覆盖」**。而且它的作者早就预见到了 —— 那条断言的注释里写着：

> 一条**永远 skip** 的断言在门禁里等于不存在，而它在报告里看起来像「有一条覆盖」。所以门禁模式下把「未测量」判成失败。

门禁段自己踩了这条。**这说明「写对了断言」和「在门禁里真的跑」是两件事，必须分开验。**

第 9 类的教训：**「产出了」和「有人消费」是两件事。** 一个 API 有实现、有调用点、有测试，仍然可能零读者。所以结构断言要钉的是「有读者」，不是「有通道」：

```ts
assert.match(drawer, /bridge\(\)\.injection\.list\(\)/, '抽屉没调 injection.list()：又变回零读者')
```

---

## 7. 协作规范（本轮新增 4 条）

1. **读数必须能回答「谁引起的」** —— `out.attachedToTarget` 是**活数组**，手动 `Target.attachToTarget` 也会往里追加一条。B2 探针第一版差点把「我自己的调用回声」读成「`setAutoAttach` 覆盖了它」，据此去改一段**正确**的注释。修法：attach 前后各拍一张快照（`beforeManualAttach`），每条事件带到达时刻 `t`，每个检查点带 `mark`。
2. **时序不能靠 `sleep` 猜** —— 固定 `sleep(2500)` 之后读到 `undefined`，把「还没到」写成了「没来」。改成 `waitFor()` 轮询到 8s，并记录**等了多久**（`sharedSessionWaitMs = -1` 表示超时）。猜短了就是把「晚到」变成「没来」。
3. **一条长期为红的断言，要么能说出它为什么该红，要么降级成「未测量」** —— 上一轮定的口径，本轮落地成代码：任意 gate 判据未测量 → **exit 3**（此前只有 locale 前置条件会 exit 3）。
4. **豁免类配置永远不写进判定表** —— 判定表必须继续逐格可核对。配置覆盖另起一层（`decideMaskGate(record, exempt)`），且**不能覆盖 `missing`**（那时连哪个环境都不知道，豁免无从归属）。

沿用并再次验证的：**注释只能声明它真正保证的东西**。本轮改了三处文案，因为读数变了：

- `windows.ts` 里 `shared_worker` 的注释：从「根本不会走到这里」改成「自动附着不覆盖它」，并明说**别拿 `attachedToTarget` 里出现过它当证据**（那是回声）。
- 记账文案：`shared_worker` 记「已注入 + 这是竞态 + 实测 3/3 赶上」，**不写**「顶层已覆盖」也**不写**「顶层必漏」。
- `session.ts` 威胁模型：删掉「Worker 里的新 `RTCPeerConnection`」。

---

## 8. 还剩什么（这些是**边界**，不是欠账）

| 项 | 性质 | 为什么不算欠账 |
|---|---|---|
| `service_worker` 顶层脚本不可覆盖 | **结构性** | 暂停态下任何命令都不返回，resume 时顶层已执行完。这条路径上不存在「更努力一点就能覆盖」的余地。已写成断言与文案，不再尝试 |
| `shared_worker` 顶层是竞态 | **无保证** | 实测 3/3 赶上，但它是竞态。所以顶层**只作读数不作判据**；判据是「延迟消息读到的值」 |
| `Function.prototype.toString` 的 tell | **已知代价** | §3 的矩阵：三种实现都有 tell，选了「需要主动踩异常路径才能看到」的那条 |
| AC-12 需要 `--nightly` | **门禁分工** | 两次启动，放在 `verify:anticheat:nightly` |
| 环境级豁免开着而环境一直 degraded | **设计意图** | 豁免就是为了「降级状态下也要能跑」。收回有两条路：修好自动收回、手动关。审计每次都记 |

**没有任何一条被标成「下轮再做」。**

---

## 9. 一句话总结

- 三条 🟠 里，**两条修完了**（seed、service/shared worker），**一条被读数否掉了**（WebRTC 在 worker 里不存在，改成一条会自己变红的断言）。
- 五条 🟡 全部处置：四条修复，一条（4.4）按计划做成**环境级配置**而不是失败弹窗里的按钮。
- 本轮真正的收获不是那 8 条，而是**两个旧缺陷**：一个零读者的台账，和一个用开发模式跑单测的门禁段。**它们都在报告里看起来是绿的。**

---

## 10. 第三方交叉验证（补记，同日）

上面 9 节全部是**自建探针**的读数。它们能证明「我们改的地方确实改了」，
证明不了「改得像不像」。`tools/audit-creepjs.mjs` 早就在仓库里，但
`artifacts/` 里**一次产物都没有** —— 也就是说，这一轮之前，**从来没有对过外部视角**。

补跑之后（宿主 Windows，两个环境各跑一遍 creepjs），得到三件事：

### 10.1 一条实证的矛盾：UA-CH 在 shared / service worker 露宿主 —— 已修

creepjs 的 Worker 段对一个 **macOS** 环境读到 `Windows 11 [19.0.0]`，
而同一页主世界读到 `macOS 15.0.0`。AC-14 声称 20 项全等、0 mismatch，
两者不可能同时为真。

差别在**采了什么**：AC-14 的 worker 探针只采 `userAgentData.brands` / `.platform`；
creepjs 读 `getHighEntropyValues(['platformVersion'])`，且读在**顶层**。

`tools/verify-uach.mjs`（新，7 条 gate）把两个维度摊开。修复前：

```
主世界           platform=macOS   [15.0.0]
dedicated 事件期  platform=macOS   [15.0.0]   ← 会话级副作用，不是注入的功劳
shared    事件期  platform=Windows [19.0.0]   ← 宿主真值
swc       事件期  platform=Windows [19.0.0]   ← 宿主真值
```

**根因**：`navigator.userAgentData` 不是 JS 注入的那一段，它由 CDP 的
`Network.setUserAgentOverride` 下发，而 CDP override 是**按 target** 生效的。
页面那次调用覆盖了页面与它派生的 dedicated worker，shared / sw 是独立 target，拿不到。

**修法**：`applyWorkerScript` 里对每个 worker session 补发一次
`Network.setUserAgentOverride`，用同一个 `uaMetadata`。**不新增 JS 面** ——
JS 层伪造 `userAgentData` 会在实例上留 own property，那是更便宜的 tell。

修复后 7/7 成立；连 shared / swc 的**顶层**也变成 macOS（CDP override 是 target 级的），
而 cores/tz 的顶层仍覆盖不到（JS 注入，结构性边界没变）。
回归：`verify:shared-worker` 5/5（resume→注入完成 3ms，没挤掉竞态）。

**这条的意义不在修了什么，在于「20 项全等」这个结论是怎么来的**：
其中 `uaData` 这一项之所以绿，靠的是 CDP 的会话级副作用，
**不是** worker 注入生效 —— 它管不到 shared / sw。

### 10.2 字体：两条测量通道给出两个答案 —— **已修**

```
字体                  Canvas2D    OffscreenCanvas
  Microsoft YaHei UI  false       true      ← 宿主 Windows 的字体，macOS 环境里量得出来
  Segoe UI Emoji      false       true
  Cambria Math        false       true
  Ink Free            false       true
```

`CanvasRenderingContext2D.prototype.measureText` 包好了，但
`new OffscreenCanvas(1,1).getContext("2d")` 拿到的是
**`OffscreenCanvasRenderingContext2D`** —— 另一个原型，一行都不受上面影响。
用 OffscreenCanvas 量一次就拿到宿主的字体表。creepjs 的
`platform hints: Arial,"Microsoft YaHei UI"` 就是这么读出来的
（两个环境报**同一串**，因为读的是宿主）。

**修法**：不复制白名单 / 回退 / 宽度偏移那套逻辑（复制就是第三份，三份迟早分叉）。
只把 OffscreenCanvas 的 `font` 搬到已经包好的 2D 通道上量，判定交给那一份实现。
一次都不新建 context —— worker 里建 OffscreenCanvas 曾在暂停态把渲染进程搞崩。

修复后：两条通道答案一致（`两条路答案不同的字体：[]`），四个宿主字体全部读不到。

**但是**：复跑 creepjs，`platform hints: Arial,"Microsoft YaHei UI"` **没变**。
顺着查下去发现字体有**三条**测量通道，不是两条：

```
字体                  Canvas2D    OffscreenCanvas   DOM 布局
  Microsoft YaHei UI  false       false             **true**
  Segoe UI Emoji      false       false             **true**
  Cambria Math        false       false             **true**
  Ink Free            false       false             **true**
```

第三条走**排版引擎**（`span.offsetWidth`），不经过 `measureText` ——
上面两条包得再干净，这条路照样能量出宿主字体。

**这条不修，也不升成门禁**：修它要动引擎级字体 fallback 配置，Electron 没有按
partition 暴露这个能力；包 `offsetWidth` 是更大的面，且自带 tell（hook 了布局属性
比字体泄漏更容易被判定）。所以 `verify:fonts` 里它是**读数**，且每次都必须打出来 ——
「我们只挡住了两条通道」这句话不能只写在注释里。

门禁 `npm run verify:fonts`（2 条，已进 `verify:all`）：① 两条可拦截的通道必须给同一个答案
② 宿主专属字体在这两条上必须读不到。**刻意不判「macOS 字体必须读得到」** ——
那需要真的字体文件，判了就是一条永远红的断言。

### 10.3 两个环境的 `FP ID` 相同 —— **不是共用存储，是 creepjs 的粗粒度标识**

```
Windows 11  FP ID: d448d98c…b2154   Fuzzy: d64a7990…
macOS 15    FP ID: d448d98c…b2154   Fuzzy: 41da5990…   ← Fuzzy 不同
localStorage：A=[]  B=[]            ← 两边都空
```

三条读数合起来说明：**不是共用存储**（两边 localStorage 都是空的，且
`session.ts` 按 `persist:ss_<profileId>` 一环境一个 partition），
而是 creepjs 的 `FP ID` 本身粒度粗 —— 它不随指纹变化。真正有鉴别力的是 `Fuzzy`，
两个环境在那里是不同的。

所以这条从「环境隔离是否失效」降级为「creepjs 的一个字段不分环境」，
**不构成隔离缺陷**。

### 10.4 creepjs 到底命中了什么（`npm run audit:creepjs`）

第一版工具数的是 `[class*="lie"]` 的元素，而 `lies hash` 是**每个分段自己的 class 名**，
正好 11 段 —— **「11 条 lies」这个数字从头到尾是假的**：它数的是分段数，不是 lie 数。
这类错误的形状：**选择器命中的是标签，不是事实。**

改成「打开每个 details 面板，收集所有 `key: true`」之后，命中项是这 8 个：

| key | 含义 | 判断 |
|---|---|---|
| `hasToStringProxy` | `Function.prototype.toString` 被改写过 | **真 tell**，正是 §3 那条「已知代价」—— 现在有外部读数证明它真的被检测到 |
| `noWebShare` | `navigator.share` 不存在 | **真 tell**：Electron 没这个 API |
| `noContentIndex` | `navigator.contentIndex` 不存在 | 同上 |
| `noContactsManager` | `navigator.contacts` 不存在 | 同上 |
| `noDownlinkMax` | `navigator.connection.downlinkMax` 不存在 | 同上 |
| `webDriverIsOn` | `navigator.webdriver === true` | **未定位**：我们自己的四上下文探针在主世界读到 `false`、三个 worker 里没有这个属性（`[Exposed=Window]`，这是对的）。说明 creepjs 读的是我们没覆盖的某个 realm |
| `prefersLightColor` | 浅色主题偏好 | 低权重，真实用户也大量如此 |
| `antialias` | WebGL 上下文参数 | 低权重 |

前五条是可动的：四条缺 API 属于「Electron 比 Chrome 少了几个接口」，
可以在注入里补形状；`hasToStringProxy` 是 §3 的已知代价，现在它从「理论风险」
变成了「被真实检测方命中」。

### 10.5 因此，本报告的结论要分两层读

| 层面 | 结论 | 依据 |
|---|---|---|
| **内部一致性** | 🟢 Go | 13 段门禁全绿，21 项 AC，四条上下文 × 两个时刻都有读数 |
| **对外可判定性** | 🟡 **有改善，仍未达标** | UA-CH 与两条字体通道已修；但字体第三条通道（DOM 布局）仍泄宿主，creepjs 另命中 5 条真 tell（4 个缺 API + toString） |

自建探针结构性看不到「跨维度矛盾」—— 它只比「我采的那几项」。
creepjs 比的是「这些值放在一起合不合理」。**这两件事只有后者决定能不能过检测。**

