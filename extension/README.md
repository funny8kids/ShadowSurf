# ShadowSurf 扩展 · 让 AI 真的会操作你的浏览器

一个 MV3 侧边栏扩展：AI 能**读到当前页面在讲什么**，也能**真的点按钮、填表单、翻页**。模型服务商、API Key、Base URL、模型名全部可配，支持 9 家 OpenAI 兼容服务。

这是三级火箭的**第一级**——零安装成本，先在扩展里把 Agent 循环跑通，再决定要不要往下走到 Electron 壳。

---

## 1. 30 秒跑起来

```bash
# 1. 打开扩展管理页
#    Chrome / Edge 地址栏输入：chrome://extensions
# 2. 右上角打开「开发者模式」
# 3. 点「加载已解压的扩展程序」，选择本目录（extension/）
# 4. 打开任意网页，点工具栏的 ShadowSurf 图标 → 右侧滑出侧边栏
# 5. 点侧边栏右上角 ⚙ → 选服务商 → 填 API Key → 「测试连接」→ 保存
```

图标没出来？点一下工具栏的拼图图标，把 ShadowSurf 固定到工具栏。

---

## 2. 配置模型

### 2.1 选服务商

设置面板顶部是一排服务商按钮，点一下会自动填好 `Base URL` 和默认模型：

| 服务商 | Base URL | 默认模型 | Key 申请 |
|---|---|---|---|
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` | https://platform.openai.com/api-keys |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` | https://platform.deepseek.com/api_keys |
| 通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` | https://bailian.console.aliyun.com |
| Kimi | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` | https://platform.moonshot.cn/console/api-keys |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-plus` | https://open.bigmodel.cn/usercenter/apikeys |
| 硅基流动 | `https://api.siliconflow.cn/v1` | `Qwen/Qwen2.5-72B-Instruct` | https://cloud.siliconflow.cn/account/ak |
| Ollama 本地 | `http://localhost:11434/v1` | `llama3.1` | 无需 Key |
| LM Studio | `http://localhost:1234/v1` | `local-model` | 无需 Key |
| 自定义 | 自己填 | 自己填 | — |

> 做 Agent 决策，**模型能力比价格重要**。太小的模型会频繁输出不合法的 JSON、乱编元素编号。建议起步用 `deepseek-chat` / `qwen-plus` / `gpt-4o-mini`，跑不顺再往上换。

### 2.2 Base URL 三种填法都认

`resolveEndpoint()` 会自己补全，下面三种写法结果一样：

```
https://api.deepseek.com             → https://api.deepseek.com/v1/chat/completions
https://api.deepseek.com/v1          → https://api.deepseek.com/v1/chat/completions
https://api.deepseek.com/v1/chat/completions  → 原样使用
```

填的时候看设置面板里那行灰色小字 `实际请求：…`，它实时显示最终会打到哪个地址，**这是排查 404 最快的办法**。

智谱的版本段是 `/v4` 不是 `/v1`，脚本已经处理，但你手填时别写成 `/v1`。

### 2.3 API Key 存在哪

- 存在 `chrome.storage.local`，只在本机这个浏览器配置里，不上传任何服务器。
- 请求从扩展直接发往你填的服务商，中间没有 ShadowSurf 的转发层。
- 输入框是 password 类型，右侧眼睛按钮可临时显形。
- 换电脑/换浏览器配置要重新填。

### 2.4 其他参数

- **温度**：默认 `0.2`。Agent 要的是稳定决策，不是创意。
- **最大步数**：默认 `12`，范围 1–30。简单任务 5 步内完成；超过上限会返回「已达步数上限」并给出已完成的部分。

---

## 3. 怎么用

侧边栏输入一句话，回车。例如：

- 「把这一页的标题、作者、发布时间提取出来」
- 「在搜索框输入 shadow browser 然后搜索」
- 「找到价格最低的那个套餐，告诉我多少钱」
- 「翻到下一页，把前 5 条结果的链接列出来」

你会看到实时过程：

```
计划：先定位搜索框 → 输入关键词 → 提交 → 读取结果
① 点击「搜索框」            ✓
② 在「搜索框」输入「xxx」   ✓
③ 提交表单                  ✓
④ 读取结果                  ✓
完成：找到 5 条结果，最低价 ¥29/月
```

页面元素被操作时会有一次深青色描边闪烁——那是影子在动手。

### 风险动作会拦下来

支付、下单、删除、转账、发送消息这类不可逆操作，执行前会弹确认框，说明**要做什么、为什么判定为高风险**。点「取消」就跳过这一步，Agent 会继续往下走而不是整轮失败。

拦截发生在执行器里，不依赖模型自觉——模型说「这个很安全」也没用。

---

## 4. 它是怎么工作的

```
sidepanel.js          Agent 循环（观察 → 决策 → 执行）
   │  chrome.runtime.sendMessage
   ├──────────────► content.js   快照 / 执行动作
   │                   │  data-ss-id 落在真实 DOM 上
   └──────────────► lib/llm.js   POST /chat/completions
```

**为什么 Agent 循环不在 background 里**：MV3 的 service worker 空闲 30 秒就被回收，一个跑 40 秒的多步任务会莫名其妙断在半路。侧边栏是真实页面，只要开着就不会被杀。`background.js` 因此只有 30 行，只负责「点图标开侧边栏」和「URL 变化通知」。

**元素怎么编号**：`content.js` 每轮扫描可见的可交互元素，过滤掉 `display:none`、`visibility:hidden`、`opacity≈0`、`aria-hidden`、零尺寸的，按「是否在视口内」排序，然后写入 `data-ss-id="e3"`。模型只说「点 e3」，执行器拿 `e3` 回查真实 DOM。模型永远拿不到选择器，也就无法被诱导去点一个不该点的东西。

**为什么每步都重新快照**：页面会变（弹窗、异步加载、跳转）。每步重新观察，元素编号重新分配，所以 `e3` 在下一步可能指向别的元素——这没关系，因为决策和执行在同一步内完成。

**受控输入怎么填**：React / Vue 的 `value` 有 getter/setter 拦截，直接 `el.value = x` 框架感知不到。`setNativeValue()` 用原型链上的原生 setter 绕过，再手动派发 `input` + `change`。

**页面内容是不可信数据**：`<page>` 标签里的正文、元素文本一律视为数据而非指令，system prompt 里写死这条规则，且注入的文本会先剥掉零宽字符。侧边栏渲染全部走 `textContent`，页面里藏一段 `<img onerror=...>` 也执行不了。

---

## 5. 权限说明

| 权限 | 用途 | 能否避免 |
|---|---|---|
| `sidePanel` | 侧边栏 | 不能 |
| `storage` | 存配置和 Key | 不能 |
| `tabs` | 读当前标签页 URL / 标题，切换时同步 | 不能 |
| `scripting` | 页面加载前手动注入 content script | 可去掉，但遇到「刷新前就打开的旧标签页」会失效 |
| `activeTab` | 点击时临时授权当前页 | 不能 |
| `host_permissions: <all_urls>` | 任意网页上都能工作 | 不能，除非限定站点 |

扩展**不采集、不上报**任何浏览数据。除了你配置的模型服务商，没有第三方请求。

---

## 6. 排错

| 现象 | 原因 | 处理 |
|---|---|---|
| `API Key 无效或没有权限（401/403）` | Key 错、过期、或该 Key 没开通这个模型 | 重新复制 Key；确认模型名在账号权限内 |
| `接口不存在（404）。当前实际请求：…` | Base URL 填错 | 看提示里的完整地址，对照上表；智谱是 `/v4` |
| `无法连接到 …` | 网络不通 / 本地服务没启动 / 被墙 | 本地模型先确认 `ollama serve` 或 LM Studio Server 已开；境外服务确认网络 |
| `触发限流（429）` | 请求太密 | 等几秒；降 `maxSteps`；换模型 |
| `模型没有返回合法 JSON：…` | 模型太弱或温度太高 | 换更强的模型；温度降到 0 |
| `浏览器内置页面禁止注入` | 当前是 `chrome://`、扩展商店、PDF 内置查看器 | 换一个普通网页 |
| 侧边栏一片空白 / 点图标没反应 | 扩展没重载 | `chrome://extensions` 点刷新按钮，然后刷新目标网页 |
| 动作执行了但页面没反应 | 元素被遮挡，或点击目标是伪元素 | 让 Agent 先 `scroll` 再点；或手动滚动到该元素附近重试 |
| 一直说「找不到元素」 | 目标在 iframe 里 | 当前版本不跨 iframe，需手动切到那个 frame 的页面 |

**最快的自检**：设置面板点「测试连接」，它会显示实际请求地址、耗时、模型回复。这一步通过，说明 Key 和地址都没问题，剩下的问题都在页面侧。

---

## 7. 已知限制

- **不跨 iframe / shadow DOM**：复杂站点（部分支付页、嵌套表单）会失败。
- **不做视觉理解**：纯 DOM 快照，Canvas / 图片里的信息读不到，需要视觉模型的话得另加截图链路。
- **单标签页**：一次只操作当前激活的标签页，没有多标签协同。
- **无持久记忆**：每次任务从零开始，不记得上次做过什么。
- **验证码即停**：遇到验证码直接返回「需要人工处理」，不尝试绕过——这是刻意的。
- **无回放**：步骤只存在于当前会话的界面上，刷新侧边栏就没了（架构文档里的 `tsk_` / `stp_` 持久化是第二阶段的事）。

---

## 8. 目录

```
extension/
├── manifest.json     MV3 清单，权限与入口
├── background.js     30 行，只做面板行为和 URL 转发
├── content.js        页面侧：快照（眼睛）+ 动作执行（手）
├── lib/
│   ├── llm.js        9 家服务商预设、端点解析、JSON 容错、人话报错
│   └── agent.js      Agent 循环、system prompt、风险判定
├── sidepanel.html    侧边栏结构（含设置面板与确认弹窗）
├── sidepanel.css     设计令牌与组件样式，跟随系统深浅色
├── sidepanel.js      渲染、配置管理、事件绑定
└── icons/            16 / 32 / 48 / 128
```

图标由 `tools/gen-icons.mjs` 生成（纯 Node，无依赖），改配色后跑 `node tools/gen-icons.mjs` 重新出图。

---

## 9. 下一步

扩展验证过之后，按架构文档往下走：

1. **Electron + `WebContentsView` 壳** — 每个环境一个独立 `BrowserContext`，指纹注入、代理绑定、双轨窗口（人一个标签组、影子一个标签组）。
2. **Agent Service 独立进程**（Bun + TS）— 把 `lib/agent.js` 的循环搬出去，加 SQLite 持久化、任务队列、断点续跑。
3. **Chromium fork** — 只在内核层补 20 个以内的补丁，其余逻辑不动。

详见 [`../docs/architecture.html`](../docs/architecture.html)。
