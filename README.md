# ShadowSurf

AI 原生浏览器。不是"更聪明的浏览器"，而是与你并行的影子操作者：你照常冲浪，影子在另一个 Space 里把活干完。

**开源（MIT），不设付费墙。** 商业指纹浏览器锁在 VIP 档的团队协作、API、RPA、窗口同步器、审计日志，这里全部开放。

> 当前状态：**v0.1 可运行**。Electron 桌面端已能启动、建环境、开双轨窗口、加载真实网页、按环境注入指纹，Agent 循环跑通端到端（读页面 → 决策 → 执行 → 再读）。未接真实模型做长期联调，未打包分发。

## 现在能跑什么

| 能力 | 状态 | 怎么验证的 |
|---|---|---|
| 环境管理（创建/克隆/删除/改指纹） | 可用 | 真实创建 9 个环境，指纹按种子确定性生成 |
| 指纹注入（UA / 屏幕 / 时区 / WebGL / Canvas / WebRTC / 字体等 20+ 面） | 可用 | 页面内实测：`screen 1536×864 / dpr 1.25 / tz America/Los_Angeles / offset 420 / GPU NVIDIA GTX 1660`，与环境配置逐项一致 |
| 会话隔离（每环境独立 cookie/storage/代理） | 可用 | `persist:ss_<id>` 分区 + 独立代理 |
| 双轨窗口（人轨 + 影子轨并排） | 可用 | 两个 `WebContentsView` 实测 `512px / 1px / 387px`，与渲染层上报的矩形严丝合缝 |
| 网页真实加载 | 可用 | Bing 首页在 view 内正常渲染 |
| 页面快照（结构化，给模型看） | 可用 | 单页提取 30 个可交互元素，带角色/名称/当前值，编号 `e1..e30` |
| 动作执行（点击/输入/按键/滚动/跳转/取数） | 可用 | 搜索框输入成功回读、`e999` 幻觉编号被拒绝 |
| Agent 循环（观察→决策→执行→再观察） | 可用 | 用本地 mock 模型跑完整任务：navigate → 页面跳转 → done，2 步 / 1720 token / 成功率 100% |
| 风险拦截（L2 支付/下单/删除需确认） | 代码就绪 | 判定在执行器，不依赖模型自觉 |
| 模型接入（9 家 OpenAI 兼容） | 可用 | 设置面板实时显示解析后的真实请求地址 |
| **代理池** | 可用 | 三种写法批量导入；CONNECT 隧道真实探测出口 IP/时区/延迟；挂载时比对出口时区与指纹时区 |
| **指纹模板 + 迁移包** | 可用 | 首次打开播种 3 条内置模板；实测 save→apply→export→import→remove 全链路（导出 10.4KB，不含任何密钥） |
| **自动化脚本（RPA）** | 可用 | 从历史任务导入步骤，回放不走模型；实测 `navigate` 步骤 1/1 执行成功 |
| **本地 HTTP API** | 可用 | 实测 `GET /health` 200、无 token 401、带 token 200 返回环境列表；只监听 127.0.0.1 |
| **审计日志（哈希链）** | 可用 | 每条带前一条哈希；`verify()` 从头重算，实测 1 条记录校验通过 |
| **指纹一致性自检** | 可用 | 页面内 16 项实测对照，macOS 环境在 Windows 宿主上跑出 **100 分 / 16 通过 / 0 失败** |
| **浏览数据（Cookie/下载/历史）** | 可用 | 真实读出某环境的 28 条 Cookie（含 Secure/HttpOnly/过期时间） |

> 六个模块的主进程与界面都已接进 IPC 与导航，不是占位页面。验收脚本在 `tools/`：
> `capture-modules.mjs`（逐面板截图）、`verify-deep.mjs`（自检/脚本/审计深链路）、
> `verify-audit-ui.mjs`（走 UI 跑自检）。

## 快速开始

```bash
npm install
npm run build      # 或 npm run dev 开发模式
npm start
```

首次启动是空环境列表，点「新建环境」→ 核对指纹 →「保存并启动」，会打开一个双轨窗口。

**配模型**：侧栏右上角齿轮 → 选服务商 → 填 API Key。Base URL 支持三种写法（裸域名 / 带 `/v1` / 完整端点），下方会实时显示最终请求地址。

**没有 Key 也能试**：仓库带一个 mock 模型服务，它会按预设动作序列回应，用来验证整条链路。

```bash
npm run mock          # 终端 A：起本地兼容服务 127.0.0.1:9977
npm start             # 终端 B：Base URL 填 http://127.0.0.1:9977/v1
```

> Windows 注意：如果你的环境全局设置了 `ELECTRON_RUN_AS_NODE=1`（很多 Electron 套壳工具会这么做），直接用 `electron .` 启动会退化成纯 Node 跑主进程，报 `app is undefined`。`npm run dev` / `npm start` 已经通过 `tools/launch.mjs` 处理掉了这个变量。

## 架构

```
src/
├── shared/          三方共用的契约（唯一事实来源）
│   ├── types.ts        Profile / FingerprintConfig / Settings / TaskRecord
│   ├── protocol.ts     动作协议、PageSnapshot、AgentEvent
│   ├── ipc.ts          IPC 通道与 window.ss API 签名
│   └── presets.ts      9 家服务商、指纹平台模板
├── main/
│   ├── core/        内核层
│   │   ├── cdp.ts        CDP 桥（debugger 封装、超时、重连）
│   │   ├── session.ts    会话分区、UA、代理认证
│   │   ├── windows.ts    双轨窗口（BrowserWindow + 2×WebContentsView）
│   │   ├── profiles.ts   环境运行时（启动/停止/去重）
│   │   └── fingerprint.ts 种子派生 + 注入脚本生成
│   ├── agent/       智能层
│   │   ├── page-agent.ts  注入页面的采集/执行脚本
│   │   ├── snapshot.ts    五步快照管道
│   │   ├── actions.ts     七个动作 + 防幻觉校验
│   │   ├── risk.ts        L0/L1/L2 判定
│   │   ├── llm.ts         OpenAI 兼容网关（错误翻译、JSON 降级）
│   │   ├── prompt.ts      系统提示词与每轮消息
│   │   └── loop.ts        Agent 状态机
│   ├── store/       持久化（原子写 JSON，接口可换 SQLite）
│   ├── ipc/         接线层
│   └── index.ts     入口
├── preload/         contextBridge 白名单
└── renderer/        React 19 + 手写 CSS
```

三条设计红线，代码里都落在具体位置：

1. **模型拿不到选择器**。元素用 `data-ss-id="e3"` 落在真实 DOM，模型只能说「点 e3」，执行器回查；编号不在当轮快照里就判幻觉。
2. **红线在执行器，不在 prompt**。`assessRisk()` 在动作执行前拦截支付/下单/删除，模型说「这很安全」也没用。
3. **页面内容和模型输出都是不可信数据**。渲染层全部走 React 文本节点，没有 `dangerouslySetInnerHTML`。

## 目录里还有什么

- `docs/` — 六份设计文档（技术路线、架构、API、前端规范、AI 集成、开源功能清单）+ 可交互原型 + 实机截图
- `extension/` — 同一套 Agent 逻辑的 MV3 侧边栏版本（三级火箭的第一级）
- `tools/` — 截图、图标生成、mock 模型服务、启动器

## 已知限制

诚实列出，不粉饰：

- **没做真实模型联调**。Agent 循环用 mock 验证了机制，但没跑过 10 步以上的真实任务，提示词还没被真实模型打磨过。
- **网络层指纹做不到**。TLS/JA3、HTTP2 指纹、TCP 栈特征在 Electron 层无法伪造，要等内核 fork。文档里已写明「阶段三之前不承诺」。
- **字体探测只做了一半**。`document.fonts.check` 与 canvas `measureText` 两条路都已接管，白名单外的字体一律按 fallback 度量；但用 `<span>` + `offsetWidth` 做布局度量的探测拦不住。
- **Worker 上下文没有注入指纹**。`Page.addScriptToEvaluateOnNewDocument` 只覆盖 frame，不覆盖 Web Worker / Service Worker。实测 creepjs 在 Worker 段读到了真实 UA、真实时区、真实 GPU 与真实 CPU 核数。Electron 层没有干净的修法（改 `Worker` 构造函数要同步取源码、还会被站点 CSP 的 `worker-src` 挡），留到内核 fork 阶段。
- **代理只探测 http/https**。socks5 会明确报「暂不支持」，不假装成功。
- **脚本回放靠语义选择器**。快照里没有 CSS 选择器，步骤用 `role=button name=登录` 这类描述定位，同名元素取首个匹配，复杂页面需要人工核对。
- **本地 API 的 `/act` 与 `/snapshot` 只验到鉴权与参数校验**。真实 CDP 执行链路没有在 Electron 内跑通回归。
- **下载监听对新建环境有缺口**。监听在首次打开数据面板时按分区补挂，之后新建的环境要等下一次打开面板才生效。
- **迁移包导入非事务**。中途失败会留下部分数据，需要手动清理。
- **存储是 JSON 不是 SQLite**。为避开原生模块在 Electron 里的重编译问题，第一版用原子写 JSON。接口按 DAO 设计，换 SQLite 不动上层。
- **控制台窗口保留了系统标题栏**。无边框窗口在 Windows 上会丢窗口控制按钮，而控制台没有自绘的关闭/最大化。
- **单窗口单任务**。同一时刻只允许一个 Agent 任务，多任务编排还没做。

## 文档

**产品**
- [技术路线与落地方案](docs/ai-native-browser-plan.html) — 市场尸检、五条技术路线对比、参考架构、路线图
- [产品原型（可交互）](docs/prototype.html) — 环境列表 / 指纹配置 / 双轨窗口 / 任务回放
- 实机截图：`docs/app-1-console.png`、`app-2-fingerprint.png`、`app-3-dual-track.png`、`app-4-settings.png`、`app-5-tasks.png`
- 六模块截图：`docs/app-6-proxies.png`（代理池）、`app-7-scripts.png`（自动化）、`app-8-templates.png`（模板与迁移）、`app-9-data.png`（浏览数据）、`app-10-localapi.png`（本地 API）、`app-11-audit.png`（审计与自检）

**研发基线**
- [架构设计文档](docs/architecture.html) — 分层架构、进程模型、CDP 桥接、数据模型、性能预算
- [API 接口文档](docs/api.html) — REST + WebSocket + MCP（[OpenAPI 3.1](docs/api/openapi.yaml)）
- [前端界面设计文档](docs/frontend.html) — 设计令牌、组件库、页面规格、可访问性
- [AI 集成设计文档](docs/ai-integration.html) — 模型接入、上下文引擎、动作协议、风险分级
- [开源功能清单](docs/open-source-features.html) — 商业产品五种锁法拆解、47 项 VIP 能力实现方案

## 一句话结论

不做通用 AI 浏览器入口（Atlas 已证伪），做人机双轨的 Agent 工作台；技术上走三级火箭：MV3 扩展 → Electron 壳 → Chromium fork，同一套 TypeScript 逻辑贯穿三阶段。**当前处在第二级。**
