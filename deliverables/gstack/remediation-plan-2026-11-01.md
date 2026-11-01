# 残余项修复方案（第四轮后）

**日期**：2026-11-01
**基线**：`d01ed18`（三条 P0 已关闭，工作区干净）
**范围**：交付报告 §5 的 3 条 🟠 + 5 条 🟡
**本文性质**：可行性判断 + 方案 + 验收口径。**不含实现**。

> **落地状态（2026-11-01 补记，`435b0cd`）**：本文 8 条**已全部处置**，读数见
> `security-audit-risk-gate-2026-11-01.md`。其中两条的判断被实测推翻 / 改写：
>
> - **§1.2 WebRTC 下沉 worker** —— 前置实测 `typeof RTCPeerConnection` 在 dedicated
>   与 shared worker 里**都是 `undefined`**（本仓库内核没在 worker 侧启用 WebRTC）。
>   「下沉」无对象，改成断言 **AC-23**（Worker 里不得有 WebRTC 接口；读到定义值即 FAIL）。
> - **§2.4 `#22 4.4`** —— 本文建议「不修」，实际按「若业务确需」那一档做了**环境级
>   配置**（`Profile.allowUnmaskedL2`，默认 false，需手打环境名开启，`maskState=ok`
>   自动收回，审计单列一栏）。理由见交付报告 §2.5：决策挪到冷静的时候做。
>
> §3.1 的「不要凭推理选，用读数选」得到了印证：矩阵证明三种实现**都有 tell**，
> 所以 `Function.prototype.toString` 那条 skip 从「真实债务」改判为「已知代价」。

---

## 0. 一句话结论

| 档 | 项 | 判断 |
|---|---|---|
| **A 可修，方案明确** | seed 跨 IPC、listMaskStates 读者、AC-14 非 en-US 轮、describeAction 三份 | 直接做，无架构阻碍 |
| **B 可修，但要先测** | WebRTC 下沉 worker、service_worker 注入、`Function.prototype.toString` | 可行性取决于一条还没测过的读数 |
| **C 建议不修** | `#22 4.4` 单次会话授权 | 修它等于给用户一个「关掉机制」的按钮 |

另外两件事必须先说清，因为它们影响 B 档的全部判断：

1. **「`Target.setAutoAttach` 不覆盖 shared_worker」这条目前没有证据文件。** `probe-tmp/` 里没有任何 shared_worker 探针。它可能是真的（Chromium 的 auto-attach 只对 dedicated worker 生效），但按本轮定下的规矩，**没有 artifact 的结论不能当前提**。
2. **`Function.prototype.toString` 那条 skip，照字面「改成 Proxy」会更糟。** 详见 §3.3，有具体机制解释。

---

## 1. 🟠 高

### 1.1 `service_worker` / `shared_worker` 不可注入

#### 现状（代码位置）

`windows.ts:onChildTargetAttached` 对 `type === 'service_worker'` 走的是「记一条未覆盖 + 立刻放行」，理由是：

> 暂停期间**任何命令都不返回**（实测连续 3 次 6s 超时），resume 之后才能注入，而那时顶层与 install 已经跑完。

`shared_worker` 连这个分支都到不了 —— 注释写的是 `Target.setAutoAttach` 不覆盖它。

#### 可行性：B 档，分两条路

**service_worker：可以拿到「事件期」覆盖，拿不到「顶层」覆盖。**

这是两条不同的保证，必须分开承诺：

| 阶段 | 能否覆盖 | 为什么 |
|---|---|---|
| 顶层脚本（`self.navigator` 在顶层读） | ❌ | 暂停态下 `Runtime.evaluate` 不返回，resume 时顶层已执行 |
| `install` / `activate` / `fetch` / `message` 事件处理器内 | ✅ | 事件是 resume 之后才投递的，只要注入赶在第一个事件之前 |

方案：

1. `Target.setAutoAttach` 保持 `waitForDebuggerOnStart: true`；
2. 收到 `attachedToTarget(type=service_worker)` 后，**不发 evaluate**，直接 `Runtime.runIfWaitingForDebugger`；
3. **立刻**发 `Runtime.evaluate(注入脚本, sessionId)`，不等返回先挂回调；用 `awaitPromise:false`；
4. 若 evaluate 在 2s 内不返回 → 记 `degraded`（source=worker），不阻塞。
5. `install` 事件通常要等脚本解析 + 微任务，注入的往返（本地 CDP，<5ms）大概率赶得上。**这是竞态，不是保证** —— 所以必须实测「注入成功的比例」，并把这个比例写进报告。

如果竞态赢不了，还有一条**不需要注入**的路：**禁止 service worker**。`ses.setPermissionRequestHandler` 管不到，但 Electron 有 `session.setPreloads` 之外的手段 —— 实际可用的是 `webRequest` 拦 `Service-Worker` 脚本请求，或 `--disable-features=ServiceWorker`。后者是全局开关，会影响正常站点功能（离线缓存失效），属于产品取舍。

**shared_worker：先测再谈。**

测什么（30 分钟，一个探针）：

```
tools/probe-shared-worker.mjs
  1. Target.getTargets()  → 页面 new SharedWorker 后，列表里有没有 type=shared_worker
  2. Target.setAutoAttach({autoAttach:true, waitForDebuggerOnStart:true, flatten:true})
     → 有没有 attachedToTarget(type=shared_worker) 到达
  3. 若有：Target.attachToTarget({targetId, flatten:true}) 手动附着，能否 evaluate
```

三种结果对应三种方案：
- **到达了** → 与 dedicated worker 同一条路径，零新增机制，只是现在没接。
- **没到达但 `getTargets` 能看到** → 在 `onChildTargetAttached` 之外加一条 `Target.getTargets` 轮询（页面 `new SharedWorker` 后 200ms 内），手动 `attachToTarget`。代价：轮询。
- **两者都没有** → 确认是架构限制，写进报告，不再尝试。

#### 验收口径

- 探针：页面里 `new SharedWorker(blob)`，worker 内读 `navigator.hardwareConcurrency` / `Intl…timeZone` / `OffscreenCanvas` GL，必须与主世界一致（沿用 `verify:worker` 的 20 项）。
- service_worker：注册一个 SW，在 `install` 处理器里读同一组值，postMessage 回页面比对。
- **顶层覆盖必须显式标注为「不覆盖」**，不能因为事件期绿了就写成「已覆盖」。

#### 代价

- service_worker 的竞态无法 100% 消除，只能测出比例。这个比例本身就是报告要写的东西。
- shared_worker 若走轮询，每次页面创建 SharedWorker 都要多一次 `getTargets`（约 1-3ms）。

---

### 1.2 WebRTC 候选过滤只在 frame 里执行

#### 现状

`fingerprint.ts:1385` 起，WebRTC 段全部基于 `window.RTCPeerConnection`：

```js
var RTC = window.RTCPeerConnection || window.webkitRTCPeerConnection;
```

worker 变体脚本里 `window.` 出现 **0 次**（已核实），所以这段**根本没有被搬过去**。`new Worker(blob)` 里 `new RTCPeerConnection()` 拿到的候选含内网地址 → 一次比对就能判定插桩。

#### 可行性：A/B 之间，偏 A

`RTCPeerConnection` 是 `[Exposed=(Window,Worker)]`，worker 里存在。移植是机械工作，但**不能复制粘贴第三份** —— 现在 page 与 worker 两套脚本已经各有一份 WebGL 段，再加两份 WebRTC 段就是四份。

方案：

1. 抽出 `buildRtcHook(realm: 'window' | 'self'): string[]`，与 `buildWebglHook` 同样的形态；
2. page 脚本传 `'window'`，worker 脚本传 `'self'`；
3. 该函数内部只用 `R` 这个别名访问 realm（`var R = self; R.RTCPeerConnection`），不写死 `window`；
4. 原型级 hook（`RTCPeerConnection.prototype.addEventListener` + `onicecandidate` accessor）在两个 realm 里都成立 —— 现在的实现已经挂在原型上（`fingerprint.ts:982` 的注释记录了从实例级改到原型级的原因），所以直接可搬。

**前置实测（一行）**：worker 里 `typeof RTCPeerConnection`。如果是 `undefined`（Electron 可能裁掉了 worker 侧的 WebRTC），这条路直接关闭，改成「worker 里删除 `RTCPeerConnection` 全局」—— 那也是一个有效答案（比漏着好），但要说清是「移除」而不是「伪装」。

#### 验收口径

- worker 里 `new RTCPeerConnection()` → `createOffer()` → 收集 3 秒候选 → 候选串里**不得**出现 `192.168.` / `10.` / `172.16-31.` / `169.254.` / `.local`。
- 实例 own property 必须为空（AC-22 的 worker 版）。
- 同一探针在主世界跑一遍，两边结果必须一致 —— 否则是「worker 更严」，那说明 hook 有 realm 依赖。

#### 代价

- 一条新的判据要进 AC 体系（AC-23：worker 侧 WebRTC 候选）。AC-10/AC-17 现在只覆盖主世界，注释里必须写清。

---

### 1.3 `seed` 仍跨 IPC 到渲染层

#### 现状（这条比我报告里写的更容易修）

`Profile.seed`（`types.ts:135`）随 `profiles.list()` 到渲染层。渲染层**真的在用**，两处：

| 位置 | 用途 |
|---|---|
| `FingerprintDrawer.tsx:259` | 显示（只读，`title={draft.seed}`） |
| `FingerprintDrawer.tsx:293/314/898` | 平台切换时 `resolveFingerprint(platform, seed)` 预览新指纹 |

关键事实：`resolveFingerprint` 在 **`@shared/presets.ts`** —— 纯函数，main 也能调。而 `regenerate()` **已经走 IPC**（`profiles.regenerate(id)`）。

所以「渲染层需要 seed」是个**假需求**：它只需要「用某个 platform + 某个不可见的 seed 算出的结果」。

#### 可行性：A 档，无架构阻碍

方案：

1. `Profile` 类型删掉 `seed`，换成 `seedHint: string`（`sha256(seed)` 前 8 位，用于「同一个种子」的肉眼比对）；
2. 新增 `profiles.preview(profileId, patch: { platform?: OSKind })` → main 用**盘上的 seed** + patch 调 `resolveFingerprint`，返回 `FingerprintConfig`；
3. `FingerprintDrawer` 三处 `resolveFingerprint(platform, draft.seed)` 改成 `await bridge().profiles.preview(draft.id, { platform })`；
4. 显示那处改成 `seedHint`，文案从「种子」改成「种子指纹」，说明「完整种子不出主进程」。

**为什么用 `seedHint` 而不是直接删**：用户需要一个「这两个环境是不是同一个种子」的判断依据（备份恢复、迁移后核对）。`sha256` 前 8 位足够做等值比较，且不可逆。

#### 验收口径

- **类型层**：`Profile` 不含 `seed` → 任何读取都是编译错误（这是最强的一道，不需要运行时断言）。
- **运行时**：`JSON.stringify(await window.ss.profiles.list())` 里不得出现任一 profile 的真实 seed 串。
- **功能**：切换平台后预览指纹与改前一致（同一 seed + 同一 platform 必须给出同一结果）。
- **反向**：把 `seed` 加回 `Profile` → 类型断言红（沿用 `tests/structure.test.ts` 的形态）。

#### 代价

- 平台切换从同步变异步（一次本地 IPC，<5ms）。抽屉里要处理 loading 态，否则切换瞬间会闪一帧旧值。
- 未保存的 draft：`preview` 只依赖 `(seed, platform)`，而 seed 不可编辑，所以 main 能算对 —— 但**如果以后允许编辑 seed**，这条就破了，注释里要写死这个前提。

---

## 2. 🟡 中（可修，成本低）

### 2.1 `listMaskStates` / `listInjectionIssues` 零读者

方案：新增 `mask.list()` IPC，返回 `MaskLastRecord[]`（已有这个 `Omit<MaskStateRecord,'webContentsId'>` 类型），渲染层在**环境页每行**加一个状态点：

| 状态 | 颜色 | 悬浮说明 |
|---|---|---|
| `ok` | 绿 | 伪装完整 |
| `unknown` | 灰 | 尚未测量 |
| `degraded`（page） | 红 | 不可逆动作会被拦 |
| `degraded`（仅 worker/iframe） | 黄 | 可执行，但有子目标缺口 |
| `rolled-back` | 红 | 伪装已回滚 |

**红线**：severity 必须由 `judgeMask` 决定，与拦 L2 同一张表。界面红而门禁放行（或反过来）比没有这个点更坏 —— 用户会按界面去关掉机制。

验收：`tests/mask-gate.test.ts` 加一条「UI 映射表与 `MASK_DECISION_TABLE` 逐行一致」的表驱动断言。

### 2.2 AC-14 在非 en-US profile 上复跑

现状：`verify-anticheat` 已有一个「locale 轮次」，条件是「profile 语言与宿主默认渲染不同」。宿主是 `en-GD`，所以 `en-US` profile 也能满足 —— 这就是无鉴别力的来源。

方案：把 locale 轮次的选轮条件从「不同」改成「**非 en-US 且非 en-\***」。若现有轮次里没有，就新建一个 `ja-JP` profile 跑一轮。

验收：读数里 `refChecks.locale.cfg` 必须不以 `en` 开头。不满足时该轮次记为**未测量**（exit 3），不是通过。

### 2.3 `describeAction` 三份

现状三处用途确实不同：

| 位置 | 输入 | 输出 | 用途 |
|---|---|---|---|
| `actions.ts:359` | action + snapshot | 「点击「立即支付」」 | 人读文案（步骤、对话框） |
| `protocol.ts:98` | action | `{target, marker}` | 审计前缀 |
| `AgentPanel.tsx:63` | action | 「点击某个元素」 | 渲染层兜底（无 snapshot） |

方案：把 `actions.ts` 那份下沉到 `protocol.ts`，签名改成 `describeAction(action, snapshot?)` —— snapshot 缺省时退化成 `AgentPanel` 那份的措辞。这样三份变一份，且「没有快照时说什么」只有一处定义。

验收：结构断言「`describeAction` 只允许一个 `export function`」，反向自检（加回第二份即红）。

### 2.4 `#22 4.4`「以未伪装身份继续」单次会话授权

**建议不修。** 理由不是工作量，是产品性质：

> 一个只在伪装失败时出现的按钮，等于告诉用户「这里有个开关」。而伪装失败的正确处置是**修环境**（重开窗口 / 换 profile），不是「我知道有风险，继续」。后者会让 `judgeMask` 的默认拒绝退化成「一次点击的障碍」。

如果业务上必须要（例如自动化流水线不能因为 worker 降级就整条停掉），那也不能做成按钮，只能做成**显式的环境级配置**：

1. 配置项 `Profile.allowUnmaskedL2: boolean`，默认 false，写在环境设置里（不在失败弹窗里）；
2. 开启时需要输入环境名确认（不是点「确定」）；
3. 每次以该状态执行 L2，审计必须写 `授权=环境级豁免（allowUnmaskedL2）`，与「用户在系统窗口点了允许」**分列**；
4. 该配置在 `maskState === 'ok'` 时自动关闭（伪装修好了就收回豁免）；
5. 报告与界面都必须显式标注该环境「已豁免伪装闸门」。

**为什么不给「单次会话」**：单次授权必然出现在失败弹窗里（因为那是唯一能问的时机），而那个位置就是「教用户关掉机制」。环境级配置把决策挪到冷静的时候做，且留下持久痕迹。

---

## 3. B 档：两条必须先测的

### 3.1 `Function.prototype.toString` —— 照字面改 Proxy 会更糟

skip 的 reason 里写的是「改用 Proxy 后 toString 自动转发到 target」。这句话**对，但结论错**。

V8 里 `Function.prototype.toString.call(proxy)` 对「target 是函数的 Proxy」返回：

```
function () { [native code] }
```

—— **名字丢了**。而 `proxy.name` 会经 `[[Get]]` 转发到 target，拿到真名 `getParameter`。

于是检测方只要一行：

```js
fn.name === /^function\s*(\w*)/.exec(Function.prototype.toString.call(fn))[1]
```

就得到 `'getParameter' !== ''` → 判定被包装。**这正是 AC-15 现在检查的东西**，而 AC-15 现在是绿的（因为赋值改写保留了 `fn.name` 与 toString 的一致性）。

所以这是一次**换 tell**，不是消除 tell：
- 现状 tell：`toString` 抛错时栈里多一帧 `at toString`（需要主动踩异常路径才看得到）
- Proxy tell：`fn.name` 与 toString 名字矛盾（一行正则，不需要任何前提）

**方案：不要凭推理选，用读数选。**

写 `tools/probe-tostring.mjs`，对三种实现（赋值改写 / Proxy / 不 patch）各跑 5 条检测手法，输出 tell 命中矩阵：

```
手法 1  fn.name vs toString 名字一致性
手法 2  try { Function.prototype.toString.call(1) } catch (e) { e.stack }  ← 有没有 at toString 帧
手法 3  toString.call(toString) 是否 [native code]
手法 4  被替换函数的 .length / .name 与原生是否一致
手法 5  Object.getOwnPropertyDescriptor(Function.prototype,'toString')
```

用矩阵决定，而不是用「哪个听起来更干净」。如果三种都有 tell，就选**最不常被踩到的那条**，并在报告里把它记成「已知代价」，而不是继续留在 skip 里假装是债务。

### 3.2 shared_worker 覆盖率

见 §1.1 的三步探针。**测之前不动代码。**

---

## 4. 建议批次

| 批次 | 内容 | 为什么这个顺序 |
|---|---|---|
| 1 | seed 跨 IPC、AC-14 非 en-US、describeAction 收敛、listMaskStates 读者 | 全部 A 档，互不依赖，一天内可完成并各自带反向验证 |
| 2 | `tools/probe-tostring.mjs` + `tools/probe-shared-worker.mjs` | 纯测量，不改产品代码；它们的读数决定批次 3 做什么 |
| 3 | WebRTC 下沉 worker（含 AC-23）、service_worker 事件期注入 | 依赖批次 2 的结论 |
| 4 | `#22 4.4`（仅当业务确需） | 产品决策，不是技术决策 |

每批的出口条件一致：**在新 commit 上跑 `verify:all`，读数归属写进报告**。

---

## 5. 一句话总结

- 三条 🟠 里，**两条是真能修的**（seed、WebRTC），**一条要先测**（service_worker / shared_worker）。
- 五条 🟡 里，**四条是低成本可修的**，**一条建议不做**（4.4）。
- 报告里有两处结论缺 artifact（shared_worker 覆盖、Proxy 更优），本方案的第一件事是把它们变成读数。
