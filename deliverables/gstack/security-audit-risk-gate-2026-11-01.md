# 风险闸门与指纹覆盖 —— 审计修复交付（第四轮）

**日期**：2026-11-01
**HEAD**：`ad1e18e`（工作区 **0 个未提交改动**，`build.dirty = false`）
**参与**：安全官 · 质量门神 ×3 · 排障手 ×3 · 产品评审员 · 设计顾问
**本轮目标**：把第三轮留下的三条 P0 真正做完 —— P0-2 Worker 露宿主真值、P0-3 seed 明文落盘、P0-4 确认窗口伪造。

> 第三轮的报告把「未完成」写成了结论，本轮把它改成了读数。
> 所有数字都来自 `ad1e18e` 这一次干净构建，命令逐条可复跑。

---

## TL;DR

- **整体结论**：🟢 **三条 P0 全部关闭**。P0-2 找到根因并修掉，开关翻回 `true`，AC-14 从「未测量」变回硬门禁并**通过**。
- **P0-2 的根因不是「注入不生效」，是「注入会崩」**：`new OffscreenCanvas(1,1).getContext("webgl")` 在**暂停态** worker 里执行会让渲染进程崩。修法是**不建 context**，只装 `WebGLRenderingContext.prototype.getParameter`。验收方式随之改变 —— 不是「脚本不报错」，而是**让 worker 自己建 GL 上下文，读 37445/37446 必须等于 profile 配置**。
- **本轮最意外的产出是一条「假失败」**：`CdpBridge.evaluate` 把 CDP 的 RemoteObject 原样当值返回，导致 worker 自检**每一次**都判「不通过」。注入明明是成功的，审计里却一直写着「注入失败」。这条比假绿更隐蔽 —— 假绿骗过门禁，假红骗过**所有人**，因为没人会去查一条「已经在修」的告警。
- **闸门与执行器的语义分歧修掉了，而且是在结构层修掉的**：三处手拼（不是两处）、两套元素查找规则（trim 与不 trim）。现在元素名由 `actionSemantic` 自己从快照取，调用方只能传 `note` —— 「拼两次」写不出来。

---

## 🎯 结论卡片

| 项目 | 内容 |
|------|------|
| Go / No-Go | 🟢 **Go**（三条 P0 关闭；残余项见 §5，均不阻断） |
| P0 状态 | P0-4 ✅ · P0-3 ✅ · P0-2 ✅ |
| 实测读数 | typecheck 双绿 · 155 tests / 154 pass / 0 fail / 1 skip · injection 25/25 + worker 24/24 · **worker 链路 exit 0** · anticheat **20/20** · seed-at-rest **exit 0** |
| 唯一 skip | 「注入脚本不得改写 `Function.prototype.toString`」—— 真实债务，见 §5 |
| 读数归属 | `ad1e18e`，工作区干净，`build.dirty=false` |

---

## 1. 三条 P0 的真实状态

### P0-4 确认窗口伪造 —— ✅ 完成

同意只能来自一个来源：操作系统绘制的原生对话框。三个旧旁路全部封闭，`verify:consent` 逐条实测：

| 旁路 | 旧行为 | 现在 |
|---|---|---|
| 渲染层 `ss:agent:confirm(true)` | `Boolean('false') === true` → 字符串即批准 | 通道已删除 |
| 脚本回放 `{confirmed: true}` | 调用方自称「用户已同意」 | 传了仍然弹窗，实测 `asked=1` |
| 本地 API `payload.confirm === true` | 无人值守执行 L2 | 无人确认 → `409 E_CONSENT_TIMEOUT` |

本轮补强：`Approval` 类型里**删掉了 `approvedBy`**。此前它是一句调用方声明，现在授权来源是「票据有没有被消费成功」，而票据只有 `consent.ts` 里那次 `dialog.showMessageBox` 能铸。调用方连「我授权了」这句话都说不了了。

新增结构断言：`Approval` 不得包含 `level` / `approvedBy`（反向验证见 §4）。

### P0-3 seed 明文落盘 —— ✅ 完成

落盘侧封口 + 启动时就地重封历史备份 + 令牌迁移。

- `master.key` 用 `safeStorage`（DPAPI）封装，`SSKEYv1:` 前缀
- `seed` 字段 `enc:` 密封；scrypt(N=2^15,r=8,p=1) → AES-256-GCM，AAD 绑 `name|platform`
- 历史 `.schema0-*` 备份：**启动时原地重封**（写 tmp → 回读 → 逐条解密校验 → rename），不删文件、不改名
- `local-api-token.json` 改原子写，并在模块注册时迁移 —— 此前只有调用 `startService`/`copyToken` 的用户才会被迁移，不用本地 API 的人令牌永远明文

**反向验证 7/7**（`verify:seed-at-rest --self-test`，spawn 自己打临时目录）：

```
ok  A1 明文 seed：exit 1
ok  A2 明文 seed：输出里点名了字段路径
ok  B1 密封 seed：exit 0
ok  C1 裸 master.key：exit 1
ok  C2 裸 master.key：分类正确
ok  D1 全合规：exit 0
ok  E1 真实数据目录被拒（不回落）
ok  E2 报错里点名了那个目录
```

B1/D1 是必须有的：**一条恒红的门禁和恒绿的一样没用**。

真实数据目录读数：`文件 19 个，敏感字段 10 处 → 通过：无明文凭据，主密钥非裸密钥形态`。

### P0-2 Worker 露宿主真值 —— ✅ 完成

#### 根因（第三轮只到「会崩」，本轮定位到「哪一行崩」）

崩溃点在注入脚本里的这一行 —— 为了拿 prototype 而建实例：

```js
var c = new OffscreenCanvas(1, 1).getContext("webgl")
var _glp = Object.getPrototypeOf(c)
```

三组对照把条件钉死：

| 场景 | 结果 |
|---|---|
| 普通 worker 顶层执行同一行（全程无 CDP） | 不崩 |
| 同一会话先 `runIfWaitingForDebugger` 再 evaluate 同一行 | 不崩 |
| **暂停态只执行这一行、别的什么都不做** | **崩**（`render-process-gone: crashed`） |

排除项：不是 evaluate 参数、不是脚本体积、不是改写 `Function.prototype.toString`。

#### 修法：不建 context

`WebGLRenderingContext` 是 `[Exposed=(Window,Worker)]`，worker 里直接可取 prototype，建实例纯属多余。现在只装 `WebGLRenderingContext.prototype.getParameter`。

#### 验收口径（这条是关键）

「脚本不报错」证明不了任何事 —— 原脚本失败时是**静默抛错**，主世界读到的仍是宿主值。真正的判据是：

> **让 worker 自己**执行 `new OffscreenCanvas(1,1).getContext("webgl")`，
> 读 `getParameter(37445)` / `getParameter(37446)`，必须等于 profile 的 `glVendor` / `glRenderer`。

`npm run verify:worker` 的读数（`ad1e18e`）：

```
--- WebGL：worker 自建 OffscreenCanvas 上下文 ---
  配置    vendor="Google Inc. (NVIDIA)"  renderer="ANGLE (NVIDIA, ... D3D11)"
  主世界  ctx=true  vendor="Google Inc. (NVIDIA)"  renderer="ANGLE (NVIDIA, ... D3D11)"
  Worker  ctx=true  vendor="Google Inc. (NVIDIA)"  renderer="ANGLE (NVIDIA, ... D3D11)"
  判定：成立 —— 不建 context 也伪装住了

--- 崩溃 ---  render-process-gone：无
结论：Worker 注入已生效（exit 0）
```

三态判定是刻意分开的：**没建出 context = 未测到**，不是通过、也不是不成立。混成两态的话，「探针环境建不出 GL」会被读成「伪装失效」，然后有人去改一个没坏的东西。

#### 顺带发现：一条一直在撒谎的「注入失败」

`CdpBridge.evaluate` 把 CDP 的 **RemoteObject**（`{type, value, description}`）原样当 `value` 返回。于是 worker 自检里的 `Number(check.value)` 得到 `NaN`、`String(check.value)` 得到 `"[object Object]"`，**每一次**都判「自检不通过」：

```
[inject-issue] {"target":"worker","reason":"注入失败：worker 自检不通过：读到 [object Object]，期望 12"}
```

而同一时刻 20 项主世界/Worker 读数**全等**。修法是拆包（`returnByValue: true` 下调用方要的必然是值），并在自检处先钉类型 —— 将来契约再变，报的是「回读值不是数字」，而不是一个看起来像「伪装没生效」的数值不符。

修完 `issues = []`。

---

## 2. 闸门与执行器的语义分歧（结构层修法）

这个 bug 的形状值得单独记：**两边各自拼串，而抑制规则看的是「命中词紧邻的右文」**。

```
loop.ts      semantic = [name, thought].join(' ')          ← name 出现 1 次
actions.ts   extra    = [name, approval.extra].join(' ')   ← name 出现 2 次
```

name 拼两次之后，第一个 name 的右文从 `"s"` 变成 `"Checkout s s"`，相邻关系被打断，抑制失效 → **闸门判 L1（不弹框）、执行器判 L2（抛错）** → 动作被拦，而用户从头到尾没被问过。实测 98 个用例里 50 个误拦、0 个真绕过：它不会放行危险动作，但会让支付按钮彻底点不动。

本轮发现的不止两处：

| 位置 | 旧写法 | 问题 |
|---|---|---|
| `loop.ts:190` | `[target?.name, thought].join(' ')` | name ×1（对） |
| `actions.ts:224` | `[target?.name, approval.extra].join(' ')` | name ×2（错） |
| **`scripts.ts:353`** | `[target?.name, note, selector].join(' ')` 再交给执行器 | name ×2（错，**第三轮没发现**） |

还有第二处分歧：元素查找。执行器 `findElement` **trim 了**，闸门那两处没 trim。模型吐出 `" e7"` 时闸门查不到元素 → 语义里没有元素名 → 判 L1 → 不弹框；执行器 trim 后查到了 → 判 L2 → 抛错。同一类后果，另一条成因。

**修法**：`@shared/protocol.ts` 提供两个函数，成为唯一入口：

```ts
export function findElement(snapshot, id)            // 编号先 trim 再比
export function actionSemantic(action, snapshot, note)  // 元素名自己取，note 只放自述
```

`Approval.extra` 同时改名 `note`。字段名本身说明「这里只放备注，元素名不许拼进来」—— 因为本地 HTTP API 手里只有 `action.id`，一旦允许调用方拼，那条路径就会「看起来接了闸门、实际扫不到任何语义」。

新增结构断言：除 `protocol.ts` 外，任何文件手工拼 `name + note` 即失败，**且带反向自检**（正则抓不到旧写法，这条断言本身就判失败 —— 否则它是一个恒真空断言）。

---

## 3. 本轮实测读数（`ad1e18e`，工作区干净）

```
npm run typecheck            node ✅  web ✅
npm run test:gate            155 tests / 154 pass / 0 fail / 1 skip
npm run verify:injection     主世界 25/25  ·  worker 脚本级 24/24
npm run verify:worker        exit 0（GL 4/4 对上配置，崩溃 0，[inject-issue] 0）
npm run verify:gate          全部通过（含 3 条伪装闸门用例）
npm run verify:consent       全部通过（三条旁路已封）
npm run verify:anticheat     20/20 通过（AC-14 PASS，build.dirty=false）
npm run verify:seed-at-rest  exit 0（反向验证 7/7）
```

AC-14 的明细（两轮，宿主 Windows）：

| 轮次 | profile | mismatch | unmeasured | 分组 |
|---|---|---|---|---|
| 1 | macos | 0 | 0 | A 13/13 · B 5/5 · **C 2/2** |
| 2 | windows | 0 | 0 | A 13/13 · B 5/5 · **C 2/2** |

`crossOs = true`。C 组就是 OffscreenCanvas 的 vendor/renderer 两项 —— 第三轮明确「禁止动 C 组」的那一组，现在是绿的，而且是靠真读数绿的。

**唯一 skip**：「注入脚本不得改写 `Function.prototype.toString`」。这是真实债务，不是本轮遗留的疏忽：改成 `Proxy` 会消除最便宜的一条 tell（`toString` 抛错时栈里多出 `at toString` 一帧），但也会把这条换成「`fn.name` 与 `toString` 内名字矛盾」—— 后者被检查得更频繁。skip 的 reason 里写清了取消条件，属于**已知并接受的代价**。

---

## 4. 反向验证清单（每条新门禁都打断过）

| 门禁 | 打断方式 | 读数 |
|---|---|---|
| `actionSemantic` 唯一性 | 把旧写法塞回 `loop.ts` | `not ok 2` |
| `Approval` 不得有 `level` | 加 `level?: string` | `not ok 1`：「Approval 不得包含 level」 |
| `matched` 有界 | 去掉 `clipOut` | `not ok 31`：「matched 没被截：长度 5006」 |
| `suppressed` 有界 | 同上（入栈处） | 同一条 |
| 截输出不截输入 | — | 正向断言：尾部 4000 字后的「删除全部订单」仍判 L2 |
| seed 密封 | `--self-test` 4 个红用例 | A1/A2/C1/C2 全红 |
| GL 三态 | — | 没 context 时判「未测到」，非通过 |

「截输出不截输入」这条是防**修法本身**变成旁路：把 `extra` 截到 2000 字再判定，模型只要先写 4000 个无害字符就能把危险词挤出视野。判定必须看全文，只有往外说的话需要有界。

---

## 5. 未修复清单（均不阻断本轮 Go）

### 🟠 高

1. **`service_worker` / `shared_worker` 不可注入** —— 暂停期间任何命令都不返回，必须先 resume，而那时顶层已跑完。这是**架构限制**，不是没做完。`shared_worker` 更彻底：`Target.setAutoAttach` 根本不覆盖它。
2. **WebRTC 候选过滤只在 frame 里执行** —— `new Worker(blob)` 一次就能比出来。AC-10/AC-17 覆盖的只是主世界。
3. **`seed` 仍跨 IPC 到渲染层** —— P0-3 只封了落盘，`profiles.list()` 仍带 seed。落盘加密 + IPC 明文 = 只挡住了一种威胁。

### 🟡 中

4. **`Function.prototype.toString` 仍是赋值改写** —— 见 §3 的 skip 说明。
5. **`listMaskStates` / `listInjectionIssues` 零读者** —— 自检报告现在会显示**当前环境**的台账（severity 由 `judgeMask` 决定，与拦 L2 同一张判定表），但「所有窗口的伪装状态」没有列表界面。
6. **AC-14 需要在非 `en-US` profile 上再跑一轮** —— en-US 下「locale 正确实现」与「写死 en-US」读数完全相同，该维度无鉴别力。
7. **`describeAction` 有三份** —— `actions.ts`（带快照，人读文案）、`protocol.ts`（审计前缀 `{target, marker}`）、`AgentPanel.tsx`（渲染层兜底）。三者用途不同，但渲染层那份是同一段用户文案的再实现，属于 `ACTION_LABEL` 三份副本同一类风险。
8. **`#22 4.4`「以未伪装身份继续」的单次会话授权** —— 没有 UI 入口，**刻意没做**：一个只在伪装失败时才出现的按钮，等于教用户关掉机制。

---

## 6. 假绿分类学（补第 8 类）

第三轮归纳了 7 类「测量本身是假的」。本轮补一类，而且是唯一一条**反向**的：

| # | 形态 | 本轮实例 |
|---|---|---|
| 1 | 恒真断言 | 结构断言的正则抓不到旧写法 → 空数组「通过」 |
| 2 | 零检查报通过 | `0/0 通过` |
| 3 | 判据与被测实现共用前提 | AC-13 期望值用同一公式现算 |
| 4 | 判据与宿主真值重合 | Windows profile 在 Windows 宿主上跑 |
| 5 | 样本被抄进词表 | 正向样本原样写进 `VOCAB` |
| 6 | 空对 | 只断言「设置项是 L1」，词表删空依然全绿 |
| 7 | 读数过期 | 同一文件被三人读到三个状态 |
| **8** | **假失败（假红）** | **worker 自检因 RemoteObject 未拆包而恒失败，注入明明是成功的** |

第 8 类的危害和假绿不同：假绿骗过门禁，**假红骗过所有人** —— 它让一条真实告警变成背景噪音。而且它有一个特别坏的副作用：为了让这条红消失，人会去「修」一个没坏的东西。

因此本轮定下一条口径：**任何一条长期为红的断言，必须能说出「它为什么该红、修好之后读数会变成什么」。说不出来就先降级成「未测量」（exit 3），不要留在门禁里当装饰。**

---

## 7. 协作规范（逐条有代价）

1. **读数有有效期，且红读数比绿读数更短命** —— 报缺陷必须带 `mtime` 或 `git diff` 片段。
2. **破坏性操作的确认阈值必须高于结论的确认阈值** —— 能证明是自己的才能删；证明不了就改名或移走。
3. **禁止 `git clean -fdx` / `checkout -- .` / 整树 `stash`**。
4. **注释只能声明它真正保证的东西** —— 指向门禁时必须能说出「哪条 AC 覆盖它」。本轮翻开关时同步改了 `probe-worker.cjs` 的结语和 AC-14 的失败文案：开关一变，那两句就开始说谎。
5. **凡是能被机械检查的同源性，都不要靠评审纪律** —— 本轮把「三处都记得只拼一次」换成了「拼两次写不出来」。
6. **提交前先冻结工作树** —— 绿读数在没有 commit 的情况下没有归属。本轮所有数字都出自 `ad1e18e` 的干净构建。
7. **验收脚本必须在版本控制里** —— 第三轮的 P0-2 证据在 `probe-tmp/`，而那个目录是 gitignore 的。本轮把它提升成 `tools/verify-worker-inject.mjs` + `npm run verify:worker`，并加进 `verify:all`。

---

## 8. 下一步（按顺序）

1. `Function.prototype.toString` 改 `Proxy` 包装 → 取消 §3 那条 skip，同时看 AC-11 读数能否从 `has-own-frame` 变 `clean`
2. `service_worker` / `shared_worker` 注入：只有 `attachToTarget` + 顶层执行完再注入这一条路，先做可行性验证再动手
3. `seed` 跨 IPC：`profiles.list()` 的返回类型去掉 seed，需要 seed 的路径显式调
4. WebRTC 过滤下沉到 worker（依赖第 2 条）
5. AC-14 在非 en-US profile 上复跑
6. `describeAction` 三份收敛
