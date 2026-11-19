/**
 * agent 域文案：AI 侧栏（影子面板）的欢迎态、计划与步骤、结果/错误卡片、
 * 输入区、确认弹窗与模型设置。缺 key 时英文回落中文（见 ../index.ts）。
 */
import type { Dict } from '../index'

export const zh: Dict = {
  /* ── 头部状态 ── */
  'agent.panel.aria': '影子面板',
  'agent.panel.collapse': '收起侧栏',
  'agent.status.idle': '影子待命',
  'agent.status.running': '正在执行',
  'agent.status.waiting': '等待确认',
  'agent.status.done': '已完成',
  'agent.status.error': '执行出错',
  'agent.status.step': ' · 第 {n} 步',

  /* ── 上下文条 ── */
  'agent.context.noPage': '未打开页面',
  'agent.context.refresh': '重新读取当前页面',

  /* ── 模型设置 ── */
  'agent.settings.aria': '模型设置',
  'agent.settings.provider': '服务商',
  'agent.settings.baseUrl': 'BASE URL',
  'agent.settings.apiKey': 'API KEY',
  'agent.settings.effectiveRequest': '实际请求：',
  'agent.settings.keyPlaceholder': '本地模型可留空',
  'agent.settings.hideKey': '隐藏 Key',
  'agent.settings.showKey': '显示 Key',
  'agent.settings.savedKey': '已保存的 Key：{key}',
  'agent.settings.model': '模型',
  'agent.settings.temperature': '温度',
  'agent.settings.maxSteps': '最大步数',
  'agent.settings.humanize': '拟人输入',
  'agent.settings.humanizeHint': '逐字符随机间隔输入，抹掉「瞬间填满」的机器特征。越慢越像真人，但任务耗时也越长。',
  'agent.humanize.off': '关闭（最快）',
  'agent.humanize.light': '轻量（约 12 字/秒）',
  'agent.humanize.normal': '标准（约 7 字/秒）',
  'agent.humanize.slow': '慢速（约 4 字/秒）',
  'agent.settings.test': '测试连接',
  'agent.settings.testOk': '连接正常',
  'agent.settings.testFailed': '连接失败：{error}',
  'agent.settings.unknownError': '未知错误',
  'agent.settings.keyNote':
    'Key 只保存在本机，请求直连你填写的服务商，不经任何中转服务器。共用电脑请用完清空。',

  /* ── 欢迎态 ── */
  'agent.welcome.title': '影子待命',
  'agent.welcome.body1': '我能读懂这一页，也能替你点按钮。',
  'agent.welcome.body2': '先告诉我你想做什么。',
  'agent.welcome.tryThese': '试试这些',
  'agent.suggest.extract': '提取这一页的关键信息',
  'agent.suggest.cheapest': '把这一页里价格最低的套餐列出来',
  'agent.suggest.search': '在页面里找到搜索框并搜索「shadow」',

  /* ── 计划与步骤 ── */
  'agent.plan.title': '计划',
  'agent.plan.steps': '{n} 步',

  /* ── 结果与错误 ── */
  'agent.result.title': '已完成',
  'agent.result.meta': '{steps} 步 · {tokens} tokens',
  'agent.error.title': '执行失败',
  'agent.error.checkSettings': '检查模型配置',

  /* ── 输入区 ── */
  'agent.input.placeholder': '让影子做点什么…',
  'agent.input.placeholderRunning': '执行中可以继续输入下一个任务',
  'agent.input.aria': '任务输入',
  'agent.input.stop': '停止执行',
  'agent.input.send': '发送',
  'agent.input.sendTitle': '发送（Enter）',
  'agent.footer.openSettings': '打开模型设置',
  'agent.footer.noModel': '未配置模型',
  'agent.footer.running': '执行中 · 可继续输入',
  'agent.footer.maxSteps': '上限 {n} 步',

  /* ── 系统确认弹窗 ── */
  'agent.confirm.title': '等待你在系统窗口中确认',
  'agent.confirm.cancel': '取消本次任务',
  'agent.confirm.note': '确认窗口由操作系统绘制 · 这个页面无权替你点「允许」',
  'agent.confirm.defaultReason': '这一步可能产生不可逆的结果。',
  'agent.confirm.body':
    '请到应用弹出的系统确认窗口上点「允许执行」。这里的按钮只能取消 —— 批准必须来自那个窗口，否则被篡改的界面就能自己批准自己。',

  /* ── 提示 ── */
  'agent.toast.noProfile': '当前没有可用的环境，请先打开一个环境',
  'agent.toast.noApiKey': '还没有配置模型 API Key',
  'agent.toast.resnapshot': '已重新读取：{n} 个可交互元素',
  'agent.toast.settingsSaved': '模型配置已保存'
}

export const en: Dict = {
  /* ── Header status ── */
  'agent.panel.aria': 'Shadow panel',
  'agent.panel.collapse': 'Collapse panel',
  'agent.status.idle': 'Shadow idle',
  'agent.status.running': 'Running',
  'agent.status.waiting': 'Awaiting confirmation',
  'agent.status.done': 'Done',
  'agent.status.error': 'Error',
  'agent.status.step': ' · Step {n}',

  /* ── Context bar ── */
  'agent.context.noPage': 'No page open',
  'agent.context.refresh': 'Re-read the current page',

  /* ── Model settings ── */
  'agent.settings.aria': 'Model settings',
  'agent.settings.provider': 'Provider',
  'agent.settings.baseUrl': 'BASE URL',
  'agent.settings.apiKey': 'API KEY',
  'agent.settings.effectiveRequest': 'Effective request:',
  'agent.settings.keyPlaceholder': 'Optional for local models',
  'agent.settings.hideKey': 'Hide key',
  'agent.settings.showKey': 'Show key',
  'agent.settings.savedKey': 'Saved key: {key}',
  'agent.settings.model': 'Model',
  'agent.settings.temperature': 'Temperature',
  'agent.settings.maxSteps': 'Max steps',
  'agent.settings.humanize': 'Human-like typing',
  'agent.settings.humanizeHint': 'Types character by character with randomized pauses, removing the "instant fill" automation signal. Slower looks more human but takes longer.',
  'agent.humanize.off': 'Off (fastest)',
  'agent.humanize.light': 'Light (~12 chars/s)',
  'agent.humanize.normal': 'Normal (~7 chars/s)',
  'agent.humanize.slow': 'Slow (~4 chars/s)',
  'agent.settings.test': 'Test connection',
  'agent.settings.testOk': 'Connection OK',
  'agent.settings.testFailed': 'Connection failed: {error}',
  'agent.settings.unknownError': 'Unknown error',
  'agent.settings.keyNote':
    'The key is stored only on this machine, and requests go straight to the provider you entered — no relay server. Clear it when you are done on a shared computer.',

  /* ── Welcome ── */
  'agent.welcome.title': 'Shadow standing by',
  'agent.welcome.body1': 'I can read this page, and I can click buttons for you.',
  'agent.welcome.body2': 'Tell me what you want to do.',
  'agent.welcome.tryThese': 'Try these',
  'agent.suggest.extract': 'Extract the key information from this page',
  'agent.suggest.cheapest': 'List the cheapest plan on this page',
  'agent.suggest.search': 'Find the search box on this page and search for “shadow”',

  /* ── Plan and steps ── */
  'agent.plan.title': 'Plan',
  'agent.plan.steps': '{n} steps',

  /* ── Result and error ── */
  'agent.result.title': 'Done',
  'agent.result.meta': '{steps} steps · {tokens} tokens',
  'agent.error.title': 'Execution failed',
  'agent.error.checkSettings': 'Check model settings',

  /* ── Input area ── */
  'agent.input.placeholder': 'Ask the shadow to do something…',
  'agent.input.placeholderRunning': 'You can keep typing the next task while this runs',
  'agent.input.aria': 'Task input',
  'agent.input.stop': 'Stop',
  'agent.input.send': 'Send',
  'agent.input.sendTitle': 'Send (Enter)',
  'agent.footer.openSettings': 'Open model settings',
  'agent.footer.noModel': 'No model configured',
  'agent.footer.running': 'Running · you can keep typing',
  'agent.footer.maxSteps': 'Max {n} steps',

  /* ── System confirmation modal ── */
  'agent.confirm.title': 'Confirm in the system window',
  'agent.confirm.cancel': 'Cancel this task',
  'agent.confirm.note':
    'The confirmation window is drawn by the operating system · this page cannot click “Allow” for you',
  'agent.confirm.defaultReason': 'This step may produce an irreversible result.',
  'agent.confirm.body':
    'Click “Allow” in the system confirmation window that the app opened. The button here can only cancel — approval must come from that window; otherwise a tampered UI could approve itself.',

  /* ── Toasts ── */
  'agent.toast.noProfile': 'No profile available — open a profile first',
  'agent.toast.noApiKey': 'No model API key configured yet',
  'agent.toast.resnapshot': 'Refreshed: {n} interactive elements',
  'agent.toast.settingsSaved': 'Model settings saved'
}
