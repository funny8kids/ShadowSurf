# 范围裁定记录（Scope Decision Record）

> 状态：**工程裁定（已生效，可被项目维护者推翻）**。
>
> 裁定性质：本文件记录的是**执行工程师依据可复核技术事实、在「使用最佳判断」授权下
> 作出的工程裁定**，不是项目维护者的本人表态。交互式问询就本裁定发起 6 次均未获答复，
> 因此不把沉默记为同意，也不把本裁定虚构为维护者已确认。
>
> 工程结论不因「维护者尚未表态」而悬置：三类能力在本仓库内技术上无法实现，这是事实判断，
> 与任何人的偏好无关。推翻方式：在文末「裁定变更」追加一行，写明纳入范围、理由与立项编号，
> 即可启动新的产品线（内核 fork / 新引擎线 / 云服务），无需改动现有代码结构。

---

## 一、裁定结论

把本项目的能力缺口分成三类，避免把「没做完」和「做不到」混为一谈：

| 类别 | 裁定 | 性质 |
|---|---|---|
| A. Electron 单引擎桌面端可实现的能力 | **已全部实现并复验** | 工程交付 |
| B. 云同步 / 云手机 / 云浏览器 | **范围外（需新产品线）** | 技术上需服务端 + 设备农场 + 调度，且与零遥测设计冲突 |
| C. Firefox/Gecko 引擎 + Android 环境 | **范围外（需新引擎线）** | Electron 只嵌 Chromium；Gecko 需独立 embedder + Marionette |
| D. TLS/JA3、HTTP/2、TCP 栈网络指纹 | **范围外（需内核 fork）** | Chromium 网络栈不向 JS/CDP 暴露 |

团队/云中**本地可实现的那一半**（成员、角色、环境分享 ACL、活动日志）已按 A 类实现，
不属于范围外；范围外的只是「云端」部分。

---

## 二、每一类的可复核依据

### B —— 云端能力

- `README.md` / `docs/open-source-features.html`：本项目定位是**零遥测、无登录、单机优先**；
  侧栏页脚实机显示为「未登录 · 单机模式」。
- 云同步要求服务端托管浏览器状态；云手机要求 Android 设备农场与分钟计费；
  云浏览器要求远端调度。三者都需要新增后端服务与运营成本结构，
  与「服务不自建、不赚差价」的既定边界冲突。
- 这类能力不是在一个 Electron 仓库里补几个文件能得到的，需要立项云服务产品线。

### C —— 引擎与移动端

- `package.json` 依赖只有 `electron` + `playwright-core`，不存在 Gecko 或移动端运行时。
- Electron 的渲染器固定为 Chromium。Gecko 需要独立 embedder，调试协议是
  Marionette / Remote Agent，与本项目整套 CDP 基础设施（`src/main/core/cdp.ts`）不兼容。
- Android 环境在竞品那里是「云手机」形态，本质同 B 类，不是桌面端的一个配置项。

### D —— 网络层指纹

- 全仓库 `src/` 中对 `JA3` / `TLS fingerprint` / `HTTP2 fingerprint` / `TCP 指纹`
  的引用为 **0 处**。
- `Page.addScriptToEvaluateOnNewDocument` 与 CDP 都不足以修改 TLS ClientHello、
  HTTP/2 SETTINGS 帧或 TCP 栈特征。
- `docs/competitive-parity.html` §10「三条红线」已写明**禁止措辞**：
  不得声称「已伪装网络指纹」「内核级 TLS 伪造」「网络层已对齐」。

以上三类在 `docs/competitive-parity.html` 的 P2 路线图中列为「需要内核 fork 或云端」，
并逐条附了一手来源与不可在本层实现的技术原因。

---

## 三、A 类（已实现）的范围

| 领域 | 交付物 |
|---|---|
| 指纹引擎 | 补齐 10 个指纹面；canvas/audio 三态；OffscreenCanvas 与 Worker 侧补齐；Web Share 按平台判定 |
| 模块 | Cookie 导入导出、SOCKS5 探测（含 socks5h）、MCP Server（12 工具 + 5 个补齐端点）、独立 MCP 构建产物 |
| 本地协作 | 成员、四档角色、环境分享 ACL、活动日志、末位所有者保护（16 条策略单测） |
| UI | 四套令牌 + 10 类交互原语 + 命令面板 + 视觉重构 + 垂直标签/标签组/标签搜索 + 密度调节 + 三档主题 |
| 死控件闭合 | 列表视图、审计导出、时间线回放播放器均由 stub 改为真实功能 |
| 契约 | OpenAPI 同步新增端点与 socks5h；README 过时限制已按代码更正 |

---

## 四、验收证据（远程 Spark 节点实测）

```
typecheck           EXIT=0
unit tests          255 total / 254 pass / 0 fail / 1 skip
build               EXIT=0
verify:injection    EXIT=0
verify:anticheat    21/21 gates，P0 子目标 3/3
verify:mask-ui      EXIT=0
verify:fonts        EXIT=0
verify:theme        EXIT=0（10 组对比度读数）
verify:share        9/9 gates，EXIT=0（远程安装 Chrome for Testing 157 arm64 后测通）
docs site           127.0.0.1:7800 → 首页与对位文档均 200
```

远程实机截图与 DOM 状态核验见 `artifacts/ui-review/`。
**客观性验收**（对比度、门禁、渲染、交互存在性）已全部通过；
**主观审美验收**（「是否媲美顶级水准」）需要人本人查看后给出，本记录不代为签署。

---

## 五、裁定变更

> 在此追加。格式：`日期 · 变更 · 理由 · 立项编号 · 裁定人`
>
> 例：`2026-11-18 · 将 C 类 Firefox/Gecko 纳入范围 · 立项 Gecko 引擎线 · ENG-001 · 维护者`
>
> 当前：**无变更记录**（本裁定为暂行状态）。
