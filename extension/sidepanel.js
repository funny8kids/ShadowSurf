/**
 * ShadowSurf · 侧边栏
 *
 * 只做三件事：管配置、驱动 Agent、把过程画出来。
 * 所有来自页面或模型的内容一律走 textContent，绝不拼 innerHTML ——
 * 页面里可能藏着恶意标签，这是最容易被忽略的注入面。
 */

import {
  PROVIDERS,
  DEFAULT_SETTINGS,
  resolveEndpoint,
  testConnection
} from './lib/llm.js';
import { runAgent } from './lib/agent.js';

/* ------------------------------------------------------------------ */
/* 状态                                                                */
/* ------------------------------------------------------------------ */

const state = {
  settings: { ...DEFAULT_SETTINGS },
  tabId: null,
  page: { title: '', url: '' },
  running: false,
  controller: null,
  stepNodes: new Map(),
  confirmResolver: null
};

const $ = (id) => document.getElementById(id);

const el = {
  stream: $('stream'),
  intent: $('intent'),
  send: $('btn-send'),
  stop: $('btn-stop'),
  modelName: $('model-name'),
  modelDot: $('model-dot'),
  ctxTitle: $('ctx-title'),
  brandSub: $('brand-sub'),
  settings: $('settings'),
  providers: $('providers'),
  baseUrl: $('baseUrl'),
  apiKey: $('apiKey'),
  model: $('model'),
  temperature: $('temperature'),
  maxSteps: $('maxSteps'),
  endpointHint: $('endpoint-hint'),
  testResult: $('test-result'),
  confirmMask: $('confirm-mask'),
  confirmReason: $('confirm-reason')
};

/* ------------------------------------------------------------------ */
/* 配置                                                                */
/* ------------------------------------------------------------------ */

async function loadSettings() {
  const stored = await chrome.storage.local.get('ss_settings');
  state.settings = { ...DEFAULT_SETTINGS, ...(stored.ss_settings || {}) };
  syncSettingsToForm();
  updateModelChip();
}

function syncSettingsToForm() {
  const s = state.settings;
  el.baseUrl.value = s.baseUrl || '';
  el.apiKey.value = s.apiKey || '';
  el.model.value = s.model || '';
  el.temperature.value = s.temperature ?? 0.2;
  el.maxSteps.value = s.maxSteps ?? 12;
  renderProviders();
  updateEndpointHint();
}

function renderProviders() {
  el.providers.textContent = '';
  for (const p of PROVIDERS) {
    const b = document.createElement('button');
    b.textContent = p.name;
    b.title = p.hint || '';
    if (p.id === state.settings.provider) b.classList.add('on');
    b.addEventListener('click', () => {
      state.settings.provider = p.id;
      if (p.baseUrl) el.baseUrl.value = p.baseUrl;
      if (p.model) el.model.value = p.model;
      renderProviders();
      updateEndpointHint();
    });
    el.providers.appendChild(b);
  }
}

function updateEndpointHint() {
  const raw = el.baseUrl.value.trim();
  if (!raw) {
    el.endpointHint.textContent = '填写后这里会显示实际请求地址';
    return;
  }
  try {
    el.endpointHint.textContent = '实际请求：' + resolveEndpoint(raw);
  } catch (e) {
    el.endpointHint.textContent = e.message;
  }
}

function readFormIntoSettings() {
  state.settings.baseUrl = el.baseUrl.value.trim();
  state.settings.apiKey = el.apiKey.value.trim();
  state.settings.model = el.model.value.trim();
  state.settings.temperature = Number(el.temperature.value) || 0.2;
  state.settings.maxSteps = Math.max(1, Math.min(30, Number(el.maxSteps.value) || 12));
}

async function persistSettings() {
  await chrome.storage.local.set({ ss_settings: state.settings });
}

function updateModelChip() {
  const s = state.settings;
  const configured = !!(s.baseUrl && s.model && (s.apiKey || /localhost|127\.0\.0\.1/.test(s.baseUrl)));
  el.modelName.textContent = s.model || '未配置';
  el.modelDot.className = 'dot ' + (configured ? 'on' : 'off');
  el.brandSub.textContent = configured ? '影子待命' : '需要配置模型';
}

/* ------------------------------------------------------------------ */
/* 当前页面                                                            */
/* ------------------------------------------------------------------ */

async function refreshTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;
    state.tabId = tab.id;
    state.page = { title: tab.title || '', url: tab.url || '' };

    const host = (() => {
      try {
        return new URL(tab.url).hostname;
      } catch {
        return tab.url;
      }
    })();

    const supported = /^(https?|file):/i.test(tab.url || '');
    el.ctxTitle.textContent = supported
      ? `${tab.title || host} — ${host}`
      : '当前页面不支持操作（浏览器内置页）';
    el.ctxTitle.title = tab.url || '';
  } catch (e) {
    el.ctxTitle.textContent = '无法读取当前标签页';
  }
}

/* ------------------------------------------------------------------ */
/* 渲染                                                                */
/* ------------------------------------------------------------------ */

function scrollToBottom() {
  el.stream.scrollTop = el.stream.scrollHeight;
}

function clearStream() {
  el.stream.textContent = '';
  state.stepNodes.clear();
}

function renderWelcome() {
  clearStream();
  const configured = !!(state.settings.baseUrl && state.settings.model);

  const wrap = document.createElement('div');
  wrap.className = 'welcome';

  const ico = document.createElement('div');
  ico.className = 'w-ico';
  ico.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l2.5-7 3.5 14 2.5-7H21"/></svg>';
  wrap.appendChild(ico);

  const h = document.createElement('h3');
  h.textContent = configured ? '影子在等你' : '先接上模型';
  wrap.appendChild(h);

  const p = document.createElement('p');
  p.textContent = configured
    ? '它能读懂当前页面，并替你点击、输入、翻页、抓取。每一步都会告诉你。'
    : '填一个 Base URL 和 API Key，就能让 AI 接管这个页面。支持 OpenAI 兼容接口与本地模型。';
  wrap.appendChild(p);

  if (!configured) {
    const btn = document.createElement('button');
    btn.className = 'btn primary';
    btn.style.width = '100%';
    btn.textContent = '配置模型';
    btn.addEventListener('click', openSettings);
    wrap.appendChild(btn);
  } else {
    const box = document.createElement('div');
    box.className = 'suggest';
    const samples = [
      '总结这个页面，列出三个要点',
      '找出页面上的所有链接，整理成列表',
      '在搜索框里搜「无线耳机」，读取前 5 个结果'
    ];
    for (const t of samples) {
      const b = document.createElement('button');
      const span = document.createElement('span');
      span.textContent = t;
      const arr = document.createElement('span');
      arr.className = 'arr';
      arr.textContent = '→';
      b.append(span, arr);
      b.addEventListener('click', () => {
        el.intent.value = t;
        el.intent.focus();
        autoGrow();
      });
      box.appendChild(b);
    }
    wrap.appendChild(box);
  }

  el.stream.appendChild(wrap);
}

function addUserMessage(text) {
  const d = document.createElement('div');
  d.className = 'msg user';
  d.textContent = text;
  el.stream.appendChild(d);
  scrollToBottom();
}

function addSystemNote(text) {
  const d = document.createElement('div');
  d.className = 'msg sys';
  d.textContent = text;
  el.stream.appendChild(d);
  scrollToBottom();
}

function addPlan(plan) {
  const box = document.createElement('div');
  box.className = 'plan';

  const hd = document.createElement('div');
  hd.className = 'plan-hd';
  hd.textContent = '计划';
  box.appendChild(hd);

  const ol = document.createElement('ol');
  for (const step of plan) {
    const li = document.createElement('li');
    li.textContent = step;
    ol.appendChild(li);
  }
  box.appendChild(ol);

  el.stream.appendChild(box);
  scrollToBottom();
}

const ACTION_LABEL = {
  click: '点击',
  type: '输入',
  press: '按键',
  scroll: '滚动',
  navigate: '打开',
  extract: '读取',
  done: '完成'
};

function describeAction(action, snapshot) {
  const target = snapshot?.elements?.find((e) => e.id === action.id);
  const name = target?.name ? `「${target.name}」` : action.id ? ` ${action.id}` : '';

  switch (action.type) {
    case 'click':
      return `点击${name || '元素'}`;
    case 'type':
      return `在${name || '输入框'}输入「${action.text ?? ''}」${action.submit ? ' 并提交' : ''}`;
    case 'press':
      return `按下 ${action.key || 'Enter'}`;
    case 'scroll':
      return `向${{ up: '上', down: '下', top: '顶部', bottom: '底部' }[action.direction] || '下'}滚动`;
    case 'navigate':
      return `打开 ${action.url}`;
    case 'extract':
      return `读取${name || '页面'}的内容`;
    case 'done':
      return '任务完成';
    default:
      return `${action.type}`;
  }
}

function upsertStep(data) {
  const { step, thought, action, status, result, error, snapshot } = data;
  const key = String(step);

  let node = state.stepNodes.get(key);

  if (!node) {
    node = document.createElement('div');
    node.className = 'step';

    const hd = document.createElement('div');
    hd.className = 'step-hd';

    const no = document.createElement('div');
    no.className = 'step-no';
    no.textContent = key;

    const main = document.createElement('div');
    main.className = 'step-main';

    const act = document.createElement('div');
    act.className = 'step-act';
    act.dataset.role = 'act';

    const th = document.createElement('div');
    th.className = 'step-thought';
    th.dataset.role = 'thought';

    main.append(act, th);
    hd.append(no, main);

    const st = document.createElement('div');
    st.className = 'step-status';
    st.dataset.role = 'status';
    hd.appendChild(st);

    node.append(hd);
    node.dataset.role = 'step';
    state.stepNodes.set(key, node);
    el.stream.appendChild(node);
  }

  node.classList.remove('running', 'ok', 'failed', 'rejected', 'confirm');

  const actEl = node.querySelector('[data-role="act"]');
  const thEl = node.querySelector('[data-role="thought"]');
  const stEl = node.querySelector('[data-role="status"]');

  actEl.textContent = describeAction(action, snapshot);
  thEl.textContent = thought || '';

  // 清理旧的结果块
  node.querySelectorAll('.step-result').forEach((n) => n.remove());

  if (status === 'running') {
    node.classList.add('running');
    stEl.className = 'step-status';
    stEl.textContent = '';
    const dots = document.createElement('span');
    dots.className = 'dots';
    dots.innerHTML = '<i></i><i></i><i></i>';
    stEl.appendChild(dots);
  } else if (status === 'ok' || status === 'done') {
    node.classList.add('ok');
    stEl.className = 'step-status ok';
    stEl.textContent = '完成';
  } else if (status === 'failed') {
    node.classList.add('failed');
    stEl.className = 'step-status failed';
    stEl.textContent = '失败';
  } else if (status === 'rejected') {
    node.classList.add('rejected');
    stEl.className = 'step-status rejected';
    stEl.textContent = '已跳过';
  } else if (status === 'confirm') {
    node.classList.add('confirm');
    stEl.className = 'step-status confirm';
    stEl.textContent = '待确认';
  }

  if (error) {
    const r = document.createElement('div');
    r.className = 'step-result err';
    r.textContent = error;
    node.appendChild(r);
  } else if (result && (result.content || result.clicked || result.typed || result.scrolled || result.navigating)) {
    const r = document.createElement('div');
    r.className = 'step-result';
    if (result.content) r.textContent = result.content.slice(0, 220) + (result.content.length > 220 ? '…' : '');
    else r.textContent = Object.entries(result)
      .map(([k, v]) => `${k}: ${v}`)
      .join(' · ');
    node.appendChild(r);
  }

  scrollToBottom();
}

function addResult({ summary, data, steps }) {
  const box = document.createElement('div');
  box.className = 'result';

  const hd = document.createElement('div');
  hd.className = 'result-hd';
  hd.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';
  const t = document.createElement('span');
  t.textContent = `完成 · ${steps} 步`;
  hd.appendChild(t);
  box.appendChild(hd);

  const p = document.createElement('p');
  p.textContent = summary;
  box.appendChild(p);

  if (data) {
    const pre = document.createElement('pre');
    pre.textContent = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    box.appendChild(pre);
  }

  el.stream.appendChild(box);
  scrollToBottom();
}

function addError(message, retry) {
  const box = document.createElement('div');
  box.className = 'err-card';

  const b = document.createElement('b');
  b.textContent = '出错了';
  const p = document.createElement('p');
  p.textContent = message;

  box.append(b, p);

  if (retry) {
    const btn = document.createElement('button');
    btn.textContent = '重试';
    btn.addEventListener('click', retry);
    box.appendChild(btn);
  }

  el.stream.appendChild(box);
  scrollToBottom();
}

/* ------------------------------------------------------------------ */
/* 风险确认                                                            */
/* ------------------------------------------------------------------ */

function askConfirm(reason) {
  return new Promise((resolve) => {
    state.confirmResolver = resolve;
    el.confirmReason.textContent = reason;
    el.confirmMask.hidden = false;
  });
}

function settleConfirm(value) {
  el.confirmMask.hidden = true;
  const r = state.confirmResolver;
  state.confirmResolver = null;
  if (r) r(value);
}

/* ------------------------------------------------------------------ */
/* 运行                                                                */
/* ------------------------------------------------------------------ */

function setRunning(on) {
  state.running = on;
  el.send.disabled = on;
  el.stop.hidden = !on;
  el.brandSub.textContent = on ? '影子执行中' : '影子待命';
  el.intent.disabled = on;
}

function ensureConfigured() {
  const s = state.settings;
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)/i.test(s.baseUrl || '');
  if (!s.baseUrl || !s.model || (!s.apiKey && !isLocal)) {
    openSettings();
    showTestResult('err', '先填好 Base URL、API Key 和模型名，再开始。');
    return false;
  }
  return true;
}

async function submit() {
  const intent = el.intent.value.trim();
  if (!intent || state.running) return;
  if (!ensureConfigured()) return;

  if (!state.tabId) await refreshTab();
  if (!state.tabId) {
    addError('没有找到可操作的标签页');
    return;
  }

  clearStream();
  addUserMessage(intent);
  setRunning(true);

  const controller = new AbortController();
  state.controller = controller;

  const startPage = state.page.url;

  try {
    const result = await runAgent({
      intent,
      settings: state.settings,
      tabId: state.tabId,
      signal: controller.signal,
      callbacks: {
        onPlan: (plan) => addPlan(plan),
        onStep: (data) => upsertStep(data),
        onNeedConfirm: (risk) => askConfirm(risk.reason),
        onThinking: () => {}
      }
    });

    addResult(result);

    // 任务改变了页面，刷新上下文条
    if (state.page.url !== startPage) refreshTab();
  } catch (e) {
    const msg = e?.message || String(e);
    if (msg === '已停止') {
      addSystemNote('已停止');
    } else {
      addError(msg, () => {
        el.intent.value = intent;
        submit();
      });
    }
  } finally {
    setRunning(false);
    state.controller = null;
  }
}

/* ------------------------------------------------------------------ */
/* 设置面板                                                            */
/* ------------------------------------------------------------------ */

function openSettings() {
  syncSettingsToForm();
  el.testResult.hidden = true;
  el.settings.hidden = false;
  el.baseUrl.focus();
}

function closeSettings() {
  el.settings.hidden = true;
}

function showTestResult(kind, text) {
  el.testResult.hidden = false;
  el.testResult.className = 'test-result ' + kind;
  el.testResult.textContent = text;
}

async function handleTest() {
  readFormIntoSettings();
  const btn = $('btn-test');
  btn.disabled = true;
  btn.textContent = '测试中…';
  el.testResult.hidden = true;

  try {
    const r = await testConnection(state.settings);
    showTestResult('ok', `连接成功 · ${r.latency}ms · 模型回复「${r.reply}」`);
  } catch (e) {
    showTestResult('err', e.message || String(e));
  } finally {
    btn.disabled = false;
    btn.textContent = '测试连接';
  }
}

async function handleSave() {
  readFormIntoSettings();
  await persistSettings();
  updateModelChip();
  closeSettings();
  if (!el.stream.querySelector('.step, .result, .msg.user')) renderWelcome();
}

/* ------------------------------------------------------------------ */
/* 事件绑定                                                            */
/* ------------------------------------------------------------------ */

function autoGrow() {
  el.intent.style.height = 'auto';
  el.intent.style.height = Math.min(el.intent.scrollHeight, 108) + 'px';
}

el.intent.addEventListener('input', autoGrow);
el.intent.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    submit();
  }
});

el.send.addEventListener('click', submit);

el.stop.addEventListener('click', () => {
  state.controller?.abort();
});

$('btn-settings').addEventListener('click', openSettings);
$('btn-close-settings').addEventListener('click', closeSettings);
$('btn-model').addEventListener('click', openSettings);
$('btn-refresh').addEventListener('click', async () => {
  await refreshTab();
  renderWelcome();
});

$('btn-test').addEventListener('click', handleTest);
$('btn-save').addEventListener('click', handleSave);

el.baseUrl.addEventListener('input', updateEndpointHint);

$('btn-eye').addEventListener('click', () => {
  el.apiKey.type = el.apiKey.type === 'password' ? 'text' : 'password';
});

$('btn-confirm-yes').addEventListener('click', () => settleConfirm(true));
$('btn-confirm-no').addEventListener('click', () => settleConfirm(false));

el.confirmMask.addEventListener('click', (e) => {
  if (e.target === el.confirmMask) settleConfirm(false);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!el.confirmMask.hidden) settleConfirm(false);
    else if (!el.settings.hidden) closeSettings();
  }
});

chrome.tabs.onActivated.addListener(() => {
  refreshTab().then(() => {
    if (!state.running) renderWelcome();
  });
});

chrome.tabs.onUpdated.addListener((_id, info) => {
  if (info.status === 'complete') refreshTab();
});

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

(async function init() {
  await loadSettings();
  await refreshTab();
  renderWelcome();
  autoGrow();
})();
