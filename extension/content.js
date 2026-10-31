/**
 * ShadowSurf · content script
 *
 * 这是 Agent 的「眼睛」和「手」：
 *   - 眼睛：把页面压成一份模型能读懂的结构化快照（可交互元素 + 正文）
 *   - 手：按编号执行 click / type / scroll / navigate / press
 *
 * 设计约束：
 *   1. 所有元素编号通过 data-ss-id 落在真实 DOM 上，动作执行时按编号回查，
 *      避免把坐标或选择器塞给模型（模型记不住坐标，选择器又太脆）。
 *   2. 快照只保留「可见 + 在视口附近」的元素，远端的元素模型也点不到。
 *   3. 每次动作后等页面静默再返回，让下一步拿到的是稳定后的 DOM。
 */

(() => {
  if (window.__SS_LOADED__) return;
  window.__SS_LOADED__ = true;

  const MAX_ELEMENTS = 140;
  const TEXT_LIMIT = 1800;

  const INTERACTIVE_SELECTOR = [
    'a[href]',
    'button',
    'input:not([type="hidden"])',
    'select',
    'textarea',
    'summary',
    '[role="button"]',
    '[role="link"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="combobox"]',
    '[role="searchbox"]',
    '[contenteditable="true"]',
    '[onclick]',
    '[tabindex]:not([tabindex="-1"])'
  ].join(',');

  /* ------------------------------------------------------------------ */
  /* 工具                                                                */
  /* ------------------------------------------------------------------ */

  const clean = (s) =>
    String(s || '')
      .replace(/[\u200b-\u200f\u202a-\u202e\ufeff]/g, '') // 零宽字符
      .replace(/\s+/g, ' ')
      .trim();

  function isVisible(el) {
    if (!el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    if (parseFloat(cs.opacity) < 0.05) return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    return true;
  }

  /** 元素的可读名称，按可靠性从高到低取 */
  function labelOf(el) {
    const aria = el.getAttribute('aria-label');
    if (aria && clean(aria)) return clean(aria);

    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const ref = document.getElementById(labelledBy);
      if (ref && clean(ref.innerText)) return clean(ref.innerText);
    }

    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
      if (el.placeholder) return clean(el.placeholder);
      if (el.type === 'submit' || el.type === 'button') return clean(el.value);
      const label = el.labels && el.labels[0];
      if (label) return clean(label.innerText);
      if (el.name) return clean(el.name);
      return el.type ? `(${el.type})` : '';
    }

    const img = el.querySelector('img[alt]');
    if (img && clean(img.alt)) return clean(img.alt);

    const text = clean(el.innerText);
    if (text) return text.slice(0, 90);

    const title = el.getAttribute('title');
    if (title) return clean(title);

    return clean(el.tagName.toLowerCase());
  }

  /** 取页面正文，优先主内容区 */
  function pageText() {
    const main =
      document.querySelector('main') ||
      document.querySelector('article') ||
      document.querySelector('[role="main"]') ||
      document.body;

    const raw = main ? main.innerText : '';
    return clean(raw).slice(0, TEXT_LIMIT);
  }

  /* ------------------------------------------------------------------ */
  /* 快照                                                                */
  /* ------------------------------------------------------------------ */

  function snapshot(max = MAX_ELEMENTS) {
    // 清掉上一轮的编号，避免残留 id 指向已移除的元素
    document.querySelectorAll('[data-ss-id]').forEach((el) => el.removeAttribute('data-ss-id'));

    const vh = window.innerHeight;
    const vw = window.innerWidth;

    const candidates = [];
    for (const el of document.querySelectorAll(INTERACTIVE_SELECTOR)) {
      if (!isVisible(el)) continue;
      const r = el.getBoundingClientRect();
      // 视口上下各留一屏缓冲，太远的直接丢
      if (r.bottom < -vh || r.top > vh * 2) continue;
      candidates.push({ el, r });
    }

    // 视口内的排前面，模型优先看到「现在就能点」的东西
    candidates.sort((a, b) => {
      const aIn = a.r.top < vh && a.r.bottom > 0 ? 0 : 1;
      const bIn = b.r.top < vh && b.r.bottom > 0 ? 0 : 1;
      if (aIn !== bIn) return aIn - bIn;
      return a.r.top - b.r.top;
    });

    const elements = [];
    for (const { el, r } of candidates) {
      if (elements.length >= max) break;
      const id = 'e' + (elements.length + 1);
      el.setAttribute('data-ss-id', id);

      elements.push({
        id,
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || undefined,
        name: labelOf(el),
        type: el.type || undefined,
        value:
          el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT'
            ? clean(el.value).slice(0, 60)
            : undefined,
        disabled: el.disabled || el.getAttribute('aria-disabled') === 'true' || undefined,
        inViewport: r.top < vh && r.bottom > 0 ? true : undefined,
        box: [
          Math.round(r.left),
          Math.round(r.top + window.scrollY),
          Math.round(r.width),
          Math.round(r.height)
        ]
      });
    }

    return {
      url: location.href,
      title: document.title,
      viewport: { width: vw, height: vh },
      scroll: {
        y: Math.round(window.scrollY),
        height: Math.round(document.documentElement.scrollHeight),
        atBottom:
          Math.ceil(window.scrollY + vh) >= document.documentElement.scrollHeight - 8
      },
      text: pageText(),
      elements
    };
  }

  /* ------------------------------------------------------------------ */
  /* 动作                                                                */
  /* ------------------------------------------------------------------ */

  function byId(id) {
    if (!id) return null;
    return document.querySelector(`[data-ss-id="${CSS.escape(id)}"]`);
  }

  /** React / Vue 受控输入必须走原型 setter，否则框架感知不到变化 */
  function setNativeValue(el, value) {
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : el instanceof HTMLSelectElement
          ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
  }

  function waitForStable(timeout = 2500, quiet = 350) {
    return new Promise((resolve) => {
      let quietTimer;
      let hardTimer;
      const finish = () => {
        observer.disconnect();
        clearTimeout(quietTimer);
        clearTimeout(hardTimer);
        resolve();
      };
      const observer = new MutationObserver(() => {
        clearTimeout(quietTimer);
        quietTimer = setTimeout(finish, quiet);
      });
      try {
        observer.observe(document.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
          characterData: true
        });
      } catch {
        resolve();
        return;
      }
      quietTimer = setTimeout(finish, quiet);
      hardTimer = setTimeout(finish, timeout);
    });
  }

  function flash(el) {
    try {
      const prev = el.style.outline;
      el.style.outline = '2px solid #14514e';
      el.style.outlineOffset = '2px';
      setTimeout(() => {
        el.style.outline = prev;
        el.style.outlineOffset = '';
      }, 900);
    } catch {
      /* 样式被 CSP 限制时忽略 */
    }
  }

  async function act(action) {
    const type = action.type;
    let detail = {};

    if (type === 'click') {
      const el = byId(action.id);
      if (!el) throw new Error(`找不到元素 ${action.id}，页面可能已变化`);
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      flash(el);
      await new Promise((r) => setTimeout(r, 80));

      const target =
        el.closest('a,button,[role="button"],[role="link"]') || el;
      if (typeof target.click === 'function') {
        target.click();
      } else {
        const r = target.getBoundingClientRect();
        target.dispatchEvent(
          new MouseEvent('click', {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: r.left + r.width / 2,
            clientY: r.top + r.height / 2
          })
        );
      }
      detail = { clicked: labelOf(el) };
    } else if (type === 'type') {
      const el = byId(action.id);
      if (!el) throw new Error(`找不到元素 ${action.id}，页面可能已变化`);
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      flash(el);
      el.focus();

      if (el.isContentEditable) {
        el.textContent = action.text ?? '';
        el.dispatchEvent(new InputEvent('input', { bubbles: true }));
      } else {
        setNativeValue(el, action.text ?? '');
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }

      if (action.submit) {
        await new Promise((r) => setTimeout(r, 60));
        const form = el.form;
        if (form && typeof form.requestSubmit === 'function') form.requestSubmit();
        else
          el.dispatchEvent(
            new KeyboardEvent('keydown', {
              key: 'Enter',
              code: 'Enter',
              keyCode: 13,
              bubbles: true
            })
          );
      }
      detail = { typed: action.text, submitted: !!action.submit };
    } else if (type === 'press') {
      const el = action.id ? byId(action.id) : document.activeElement;
      if (!el) throw new Error('没有可聚焦的元素');
      const key = action.key || 'Enter';
      el.dispatchEvent(
        new KeyboardEvent('keydown', {
          key,
          code: key,
          keyCode: key === 'Enter' ? 13 : 0,
          bubbles: true
        })
      );
      el.dispatchEvent(new KeyboardEvent('keyup', { key, code: key, bubbles: true }));
      detail = { pressed: key };
    } else if (type === 'scroll') {
      const dir = action.direction || 'down';
      if (dir === 'top') window.scrollTo({ top: 0, behavior: 'instant' });
      else if (dir === 'bottom')
        window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' });
      else window.scrollBy({ top: dir === 'up' ? -600 : 600, behavior: 'instant' });
      await new Promise((r) => setTimeout(r, 120));
      detail = { scrolled: dir, y: Math.round(window.scrollY) };
    } else if (type === 'navigate') {
      detail = { navigating: action.url };
      // 先让消息返回，再跳转，否则页面卸载会掐断响应
      setTimeout(() => {
        location.assign(action.url);
      }, 60);
      return detail;
    } else if (type === 'extract') {
      const el = action.id ? byId(action.id) : null;
      const content = el ? clean(el.innerText || el.value || '').slice(0, 2500) : pageText();
      return { content };
    } else {
      throw new Error(`不支持的动作：${type}`);
    }

    await waitForStable();
    return detail;
  }

  /* ------------------------------------------------------------------ */
  /* 消息通道                                                            */
  /* ------------------------------------------------------------------ */

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('SS_')) return;

    (async () => {
      try {
        if (msg.type === 'SS_PING') {
          sendResponse({ ok: true, data: { url: location.href, title: document.title } });
        } else if (msg.type === 'SS_SNAPSHOT') {
          sendResponse({ ok: true, data: snapshot(msg.max) });
        } else if (msg.type === 'SS_ACT') {
          const data = await act(msg.action || {});
          sendResponse({ ok: true, data });
        } else {
          sendResponse({ ok: false, error: `未知消息：${msg.type}` });
        }
      } catch (err) {
        sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
      }
    })();

    return true; // 异步响应
  });
})();
