/**
 * 页面内采集脚本。
 *
 * 通过 CDP 注入到目标页面的 **isolated world**（worldName = shadow-agent），
 * 因此**不能走模块系统**，只能以字符串常量导出。
 *
 * 三条硬规矩：
 * 1. 脚本内部只用 ES5（老页面里没有箭头函数、const、模板字符串），避免注入即报错。
 * 2. 脚本内部**不使用模板字符串**，也不出现反斜杠转义，全部靠字符串拼接 +
 *    String.fromCharCode 构造正则，避免与外层模板字符串互相打架。
 * 3. 元素编号 e1..eN 只活在 isolated world 的 WeakMap 里，**绝不落到真实 DOM**。
 *    两条都不能省：写进 DOM 的话页面脚本能读、能改（风险闸门的输入被篡改），
 *    而 `querySelectorAll('[data-ss-id]').length > 0` 本身就是一行机器人指纹；
 *    只靠 isolated world 的全局则挡不住 DOM 标记。
 */
export const PAGE_AGENT_SOURCE = `
(function () {
  'use strict';

  // 重复注入保护：Page.addScriptToEvaluateOnNewDocument 会在每次导航后重跑
  if (window.__SS__ && window.__SS__.v === 1) { return; }

  var NL = String.fromCharCode(10);
  // 空白：空格 / 制表 / CR / LF / nbsp
  var WS_RE = new RegExp('[' + String.fromCharCode(32, 9, 13, 10, 160) + ']+', 'g');
  // 零宽与双向控制符：200b-200f、202a-202e
  var ZW_RE = (function () {
    var chars = [];
    var i;
    for (i = 0x200b; i <= 0x200f; i++) { chars.push(String.fromCharCode(i)); }
    for (i = 0x202a; i <= 0x202e; i++) { chars.push(String.fromCharCode(i)); }
    return new RegExp('[' + chars.join('') + ']', 'g');
  })();
  // 编号白名单，防止模型塞进选择器碎片
  var ID_RE = new RegExp('^e[0-9]+$');

  // 元素 → 编号。isolated world 私有，页面脚本读不到也改不了。
  // WeakMap 是单向的，反向查（编号 → 元素）只能靠 _order：
  // 下标对齐，_order[i] 就是编号 e(i+1) 的那个元素。单轮上限 150，线性扫足够。
  var _idOf = new WeakMap();
  var _order = [];

  var SEL = 'a[href], button, input, select, textarea, summary,' +
    ' [role=button], [role=link], [role=textbox], [role=checkbox], [role=radio],' +
    ' [role=combobox], [role=tab], [role=menuitem], [role=option],' +
    ' [contenteditable=""], [contenteditable=true], [onclick], [tabindex]:not([tabindex="-1"])';

  var HL_COLOR = '#0F766E';
  var HL_MS = 200;

  /* ────────────────────────────── 文本清洗 ────────────────────────────── */

  function clean(s) {
    if (s === null || s === undefined) { return ''; }
    return String(s).replace(ZW_RE, '').replace(WS_RE, ' ').trim();
  }

  function clip(s, n) {
    var t = clean(s);
    return t.length > n ? t.slice(0, n) : t;
  }

  /** 逐行 trim、丢空行：既压掉连续空行，也顺手省 token */
  function cleanText(raw) {
    if (!raw) { return ''; }
    var lines = String(raw).replace(ZW_RE, '').split(NL);
    var out = [];
    var i;
    for (i = 0; i < lines.length; i++) {
      var ln = lines[i].replace(WS_RE, ' ').trim();
      if (ln) { out.push(ln); }
    }
    return out.join(NL);
  }

  /* ────────────────────────────── 可见性 ────────────────────────────── */

  function isVisible(el, rect) {
    if (rect.width <= 0 || rect.height <= 0) { return false; }
    if (el.getAttribute('aria-hidden') === 'true') { return false; }
    var cs = window.getComputedStyle(el);
    if (cs) {
      if (cs.display === 'none' || cs.visibility === 'hidden') { return false; }
      if (parseFloat(cs.opacity) < 0.05) { return false; }
    }
    // 被祖先裁掉 / 祖先 display:none 的情况交给浏览器自己判断
    if (typeof el.checkVisibility === 'function') {
      try {
        if (el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) === false) {
          return false;
        }
      } catch (e) { /* 老内核不支持参数，忽略 */ }
    }
    return true;
  }

  /* ────────────────────────────── 取名 ────────────────────────────── */

  function labelledByText(el) {
    var ids = el.getAttribute('aria-labelledby');
    if (!ids) { return ''; }
    var parts = ids.split(' ');
    var out = '';
    var i;
    for (i = 0; i < parts.length; i++) {
      var n = document.getElementById(parts[i]);
      if (n) { out += ' ' + (n.innerText || n.textContent || ''); }
    }
    return out;
  }

  function labelText(el) {
    var out = '';
    var i;
    if (el.labels && el.labels.length) {
      for (i = 0; i < el.labels.length; i++) {
        out += ' ' + (el.labels[i].innerText || el.labels[i].textContent || '');
      }
      if (out.trim()) { return out; }
    }
    // 没有 for= 绑定时，退一步看是否被 label 直接包住
    var p = el.parentNode;
    if (p && p.tagName === 'LABEL') { return p.innerText || p.textContent || ''; }
    return '';
  }

  function nameOf(el) {
    var v;
    v = el.getAttribute('aria-label');
    if (v && v.trim()) { return clip(v, 90); }
    v = labelledByText(el);
    if (v && v.trim()) { return clip(v, 90); }
    v = labelText(el);
    if (v && v.trim()) { return clip(v, 90); }
    v = el.getAttribute('placeholder');
    if (v && v.trim()) { return clip(v, 90); }
    if (typeof el.value === 'string' && el.value.trim()) { return clip(el.value, 90); }
    var img = el.querySelector ? el.querySelector('img[alt]') : null;
    if (img) {
      v = img.getAttribute('alt');
      if (v && v.trim()) { return clip(v, 90); }
    }
    v = el.innerText;
    if (v && v.trim()) { return clip(v, 90); }
    v = el.getAttribute('title');
    if (v && v.trim()) { return clip(v, 90); }
    return el.tagName.toLowerCase();
  }

  function roleOf(el) {
    var r = (el.getAttribute('role') || '').toLowerCase();
    if (r === 'button' || r === 'link' || r === 'textbox' || r === 'checkbox' ||
        r === 'radio' || r === 'combobox' || r === 'tab' || r === 'menuitem' ||
        r === 'option' || r === 'summary') {
      return r;
    }
    var tag = el.tagName;
    if (tag === 'A') { return 'link'; }
    if (tag === 'BUTTON') { return 'button'; }
    if (tag === 'SUMMARY') { return 'summary'; }
    if (tag === 'SELECT') { return 'combobox'; }
    if (tag === 'TEXTAREA') { return 'textbox'; }
    if (tag === 'INPUT') {
      var t = (el.type || 'text').toLowerCase();
      if (t === 'checkbox') { return 'checkbox'; }
      if (t === 'radio') { return 'radio'; }
      if (t === 'button' || t === 'submit' || t === 'reset' || t === 'image') { return 'button'; }
      return 'textbox';
    }
    if (el.isContentEditable) { return 'textbox'; }
    return 'other';
  }

  function valueOf(el) {
    var tag = el.tagName;
    if (tag === 'INPUT') {
      var t = (el.type || '').toLowerCase();
      if (t === 'checkbox' || t === 'radio') { return el.checked ? 'checked' : ''; }
      // 密码框不回传内容，只告诉模型"这里已经有值"
      if (t === 'password') { return el.value ? '***' : ''; }
      return clip(el.value || '', 120);
    }
    if (tag === 'TEXTAREA' || tag === 'SELECT') { return clip(el.value || '', 120); }
    if (el.isContentEditable) { return clip(el.textContent || '', 120); }
    return '';
  }

  /* ────────────────────────────── 快照 ────────────────────────────── */

  function snapshot(opts) {
    opts = opts || {};
    var max = opts.max > 0 ? opts.max : 140;
    var maxText = opts.maxText > 0 ? opts.maxText : 6000;
    var vw = window.innerWidth || 0;
    var vh = window.innerHeight || 0;

    // 上一轮的元素不能带着旧编号留下来，否则 findEl 会点到已经过期的元素
    _order = [];

    var nodes = document.querySelectorAll(SEL);
    var picked = [];
    var i;
    var el;
    var rect;

    // 1 + 2 + 3：采集 → 可见性 → 视口上下各留一屏
    for (i = 0; i < nodes.length; i++) {
      el = nodes[i];
      rect = el.getBoundingClientRect();
      if (!isVisible(el, rect)) { continue; }
      if (!(rect.bottom > -vh && rect.top < vh * 2)) { continue; }
      picked.push({
        el: el,
        rect: rect,
        inVp: rect.bottom > 0 && rect.top < vh && rect.right > 0 && rect.left < vw
      });
    }

    // 视口内的排前面，其次按纵向位置，再按横向
    picked.sort(function (a, b) {
      if (a.inVp !== b.inVp) { return a.inVp ? -1 : 1; }
      if (a.rect.top !== b.rect.top) { return a.rect.top - b.rect.top; }
      return a.rect.left - b.rect.left;
    });

    // 4：按最终顺序重写 e1..eN。只写进 isolated world 的 WeakMap，不碰 DOM
    var truncated = picked.length > max;
    var count = Math.min(picked.length, max);
    var elements = [];

    for (i = 0; i < count; i++) {
      el = picked[i].el;
      rect = picked[i].rect;
      var id = 'e' + (i + 1);
      _idOf.set(el, id);
      _order.push(el);
      var item = {
        id: id,
        tag: el.tagName.toLowerCase(),
        role: roleOf(el),
        name: nameOf(el),
        disabled: !!el.disabled,
        inViewport: picked[i].inVp,
        box: {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          w: Math.round(rect.width),
          h: Math.round(rect.height)
        }
      };
      if (el.type) { item.type = String(el.type); }
      var val = valueOf(el);
      if (val) { item.value = val; }
      elements.push(item);
    }

    // 正文：优先主内容区。innerText 天然不含 display:none 的 script/style
    var root = document.querySelector('main, article, [role=main]') || document.body;
    var raw = '';
    if (root) {
      raw = typeof root.innerText === 'string' ? root.innerText : (root.textContent || '');
    }
    var text = cleanText(raw);
    if (text.length > maxText) {
      text = text.slice(0, maxText);
      truncated = true;
    }

    var docEl = document.documentElement;
    var y = window.pageYOffset || (docEl ? docEl.scrollTop : 0) || 0;
    var maxY = Math.max(0, (docEl ? docEl.scrollHeight : 0) - vh);

    return {
      url: String(location.href || ''),
      title: String(document.title || ''),
      viewport: { width: vw, height: vh },
      scroll: { y: Math.round(y), maxY: Math.round(maxY) },
      text: text,
      elements: elements,
      truncated: truncated
    };
  }

  /* ────────────────────────────── 执行 ────────────────────────────── */

  function findEl(id) {
    var sid = String(id || '');
    if (!ID_RE.test(sid)) { return null; }
    var i;
    var el;
    for (i = 0; i < _order.length; i++) {
      el = _order[i];
      // 快照之后被页面摘掉的元素当作不存在，和以前 querySelector 的行为保持一致
      if (el && el.isConnected && _idOf.get(el) === sid) { return el; }
    }
    return null;
  }

  function notFound(action) {
    return { ok: false, message: '元素 ' + String(action.id || '?') + ' 不在当前页面' };
  }

  /** 让用户看见 AI 点了什么 */
  function flash(el) {
    var prevOutline = el.style.outline;
    var prevOffset = el.style.outlineOffset;
    el.style.outline = '2px solid ' + HL_COLOR;
    el.style.outlineOffset = '2px';
    setTimeout(function () {
      el.style.outline = prevOutline;
      el.style.outlineOffset = prevOffset;
    }, HL_MS);
  }

  function reveal(el) {
    try {
      el.scrollIntoView({ block: 'center', inline: 'nearest' });
    } catch (e) {
      try { el.scrollIntoView(); } catch (e2) { /* 忽略 */ }
    }
    flash(el);
  }

  function isClickable(el) {
    var tag = el.tagName;
    if (tag === 'A' || tag === 'BUTTON') { return true; }
    var r = (el.getAttribute('role') || '').toLowerCase();
    return r === 'button' || r === 'link';
  }

  /** 元素本身不可点时，向上找最近的 a/button/[role=button]/[role=link] */
  function clickTarget(el) {
    if (isClickable(el)) { return el; }
    var up = el.parentNode;
    while (up && up.nodeType === 1 && up !== document.body) {
      if (isClickable(up)) { return up; }
      up = up.parentNode;
    }
    return el;
  }

  function pressKey(el, key) {
    var target = el || document.activeElement || document.body;
    if (!target) { return; }
    var init = { key: key, code: key, bubbles: true, cancelable: true };
    try { target.dispatchEvent(new KeyboardEvent('keydown', init)); } catch (e) { /* 忽略 */ }
    try { target.dispatchEvent(new KeyboardEvent('keypress', init)); } catch (e2) { /* 忽略 */ }
    try { target.dispatchEvent(new KeyboardEvent('keyup', init)); } catch (e3) { /* 忽略 */ }
  }

  function submitForm(el) {
    var form = el.form || (el.closest ? el.closest('form') : null);
    if (form && typeof form.requestSubmit === 'function') {
      try { form.requestSubmit(); return; } catch (e) { /* 落到回车 */ }
    }
    pressKey(el, 'Enter');
  }

  function doClick(action) {
    var el = findEl(action.id);
    if (!el) { return notFound(action); }
    reveal(el);
    if (el.disabled) {
      return { ok: false, message: '元素 ' + action.id + ' 处于禁用状态' };
    }
    var target = clickTarget(el);
    try {
      target.click();
    } catch (e) {
      // 极端情况下 click() 被页面改写，退化成原生事件派发
      var init = { bubbles: true, cancelable: true, view: window };
      target.dispatchEvent(new MouseEvent('mousedown', init));
      target.dispatchEvent(new MouseEvent('mouseup', init));
      target.dispatchEvent(new MouseEvent('click', init));
    }
    return { ok: true, message: '已点击 ' + action.id + '「' + nameOf(el) + '」' };
  }

  function doType(action) {
    var el = findEl(action.id);
    if (!el) { return notFound(action); }
    var text = action.text === null || action.text === undefined ? '' : String(action.text);
    reveal(el);

    var tag = el.tagName;
    if (el.isContentEditable) {
      el.focus();
      el.textContent = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (tag === 'SELECT') {
      el.focus();
      el.value = text;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      // React/Vue 受控输入：必须走原型链 setter，直接赋值会被框架的 value 追踪忽略
      var proto = tag === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      var desc = Object.getOwnPropertyDescriptor(proto, 'value');
      el.focus();
      if (desc && desc.set) { desc.set.call(el, text); } else { el.value = text; }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    if (action.submit) { submitForm(el); }
    return {
      ok: true,
      message: '已在 ' + action.id + ' 输入「' + clip(text, 40) + '」' + (action.submit ? ' 并提交' : '')
    };
  }

  function doPress(action) {
    var el = null;
    if (action.id) {
      el = findEl(action.id);
      if (!el) { return notFound(action); }
      try { el.focus(); } catch (e) { /* 忽略 */ }
    }
    var key = action.key ? String(action.key) : 'Enter';
    pressKey(el, key);
    return { ok: true, message: '已按下 ' + key };
  }

  function doScroll(action) {
    var vh = window.innerHeight || 600;
    var amount = action.amount > 0 ? Number(action.amount) : Math.round(vh * 0.85);
    var dir = action.direction || 'down';
    var docEl = document.documentElement;
    if (dir === 'top') {
      window.scrollTo(0, 0);
    } else if (dir === 'bottom') {
      window.scrollTo(0, docEl ? docEl.scrollHeight : 0);
    } else if (dir === 'up') {
      window.scrollBy(0, -amount);
    } else {
      window.scrollBy(0, amount);
    }
    return { ok: true, message: '已向 ' + dir + ' 滚动 ' + amount + 'px' };
  }

  function doNavigate(action) {
    var url = String(action.url || '');
    if (!new RegExp('^https?:', 'i').test(url)) {
      return { ok: false, message: '只允许 http/https 地址' };
    }
    // 先把返回值送出去，再跳转；否则 CDP 的 evaluate 会被导航掐断
    setTimeout(function () {
      try { window.location.assign(url); } catch (e) { /* 忽略 */ }
    }, 30);
    return { ok: true, navigated: true, message: '正在打开 ' + url };
  }

  function act(action) {
    if (!action || !action.type) { return { ok: false, message: '缺少动作类型' }; }
    var type = String(action.type);
    if (type === 'click') { return doClick(action); }
    if (type === 'type') { return doType(action); }
    if (type === 'press') { return doPress(action); }
    if (type === 'scroll') { return doScroll(action); }
    if (type === 'navigate') { return doNavigate(action); }
    if (type === 'extract') { return { ok: true, message: '已记录取数指令' }; }
    if (type === 'done') {
      return { ok: true, message: action.summary ? String(action.summary) : '已完成' };
    }
    return { ok: false, message: '不支持的动作类型 ' + type };
  }

  function ping() { return { ok: true, v: 1 }; }

  // 挂在 isolated world 的全局上：名字照旧，但页面脚本的 window 上看不到它
  window.__SS__ = { v: 1, snapshot: snapshot, act: act, ping: ping };
})();
`
