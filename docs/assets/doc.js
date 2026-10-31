/* ==========================================================================
   ShadowSurf 文档站 · 交互脚本
   职责：主题切换、阅读进度、目录高亮
   无依赖。必须在 <head> 中同步引入，以便在首屏渲染前定好主题，避免闪烁。
   ========================================================================== */
(function () {
  'use strict';

  var KEY = 'ss-theme';
  var root = document.documentElement;

  /* ---------- 1. 主题：先定，后渲染 ---------- */
  function preferred() {
    try {
      var saved = localStorage.getItem(KEY);
      if (saved === 'light' || saved === 'dark') return saved;
    } catch (e) { /* 隐私模式下 localStorage 可能抛错 */ }
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
  }

  var userChose = false;
  try { userChose = !!localStorage.getItem(KEY); } catch (e) {}
  root.setAttribute('data-theme', preferred());

  /* 用户没手动选过时，跟随系统变化 */
  if (window.matchMedia) {
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    var onChange = function (e) {
      if (!userChose) root.setAttribute('data-theme', e.matches ? 'dark' : 'light');
    };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
  }

  /* ---------- 2. 其余交互，等 DOM ---------- */
  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  ready(function () {
    /* --- 阅读进度条 --- */
    var bar = document.createElement('div');
    bar.className = 'read-bar';
    document.body.appendChild(bar);

    /* --- 主题按钮 --- */
    var btn = document.createElement('button');
    btn.className = 'theme-btn';
    btn.type = 'button';
    btn.setAttribute('aria-label', '切换深色 / 浅色主题');
    btn.innerHTML =
      '<svg class="i-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>' +
      '<svg class="i-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">' +
      '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2M5.4 5.4l1.6 1.6M17 17l1.6 1.6M18.6 5.4L17 7M7 17l-1.6 1.6"/></svg>';
    btn.addEventListener('click', function () {
      var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      userChose = true;
      try { localStorage.setItem(KEY, next); } catch (e) {}
    });
    document.body.appendChild(btn);

    /* --- 目录高亮 --- */
    var links = Array.prototype.slice.call(document.querySelectorAll('.toc nav a[href^="#"]'));
    var targets = links.map(function (a) {
      return document.getElementById(a.getAttribute('href').slice(1));
    });

    function highlight() {
      if (!links.length) return;
      var y = window.scrollY + 150;
      var idx = 0;
      for (var i = 0; i < targets.length; i++) {
        if (!targets[i]) continue;
        var top = targets[i].getBoundingClientRect().top + window.scrollY;
        if (top <= y) idx = i;
      }
      for (var j = 0; j < links.length; j++) {
        links[j].classList.toggle('on', j === idx);
      }
    }

    /* --- 进度 + 高亮，合并到一帧 --- */
    var ticking = false;
    function onScroll() {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(function () {
        var max = document.documentElement.scrollHeight - window.innerHeight;
        var p = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
        bar.style.width = (p * 100).toFixed(2) + '%';
        highlight();
        ticking = false;
      });
    }

    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    onScroll();

    /* --- 锚点跳转后修正一次（平滑滚动结束时高亮可能滞后） --- */
    window.addEventListener('hashchange', function () {
      setTimeout(onScroll, 260);
    });
  });
})();
