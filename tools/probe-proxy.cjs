/**
 * 一次性实验：Proxy 包装能不能替代「全局 patch Function.prototype.toString」。
 *
 * 要回答四个问题，全部靠读数，不靠推理：
 * 1. `Function.prototype.toString.call(proxy)` 到底返回什么？
 *    产品评审说是「target 的原生源码」，安全官据此建议删掉全局 patch。
 *    如果实际返回 `function () { [native code] }`（丢了名字和 get 前缀），
 *    那它本身就是一条比现在更强的 tell。
 * 2. `'prototype' in proxy` 是不是 false？
 * 3. `proxy.name` / `proxy.length` 是否自动转发？
 * 4. 调用 proxy 时栈里有没有多一帧（has-own-frame）？
 *
 * 跑法：node tools/run-electron.mjs tools/probe-proxy.mjs
 */

const { app, BrowserWindow } = require('electron')
const { writeFileSync, mkdirSync } = require('node:fs')
const { resolve } = require('node:path')

const PAGE = resolve(__dirname, '../artifacts/proxy-lab.html')

const EXPR = `(function () {
  var out = {};

  // 拿一个真实的原生 getter 做 target
  var d = Object.getOwnPropertyDescriptor(Navigator.prototype, 'userAgent');
  var nativeGet = d.get;

  out.native_toString = Function.prototype.toString.call(nativeGet);
  out.native_name = nativeGet.name;
  out.native_length = nativeGet.length;
  out.native_hasPrototype = 'prototype' in nativeGet;

  // Proxy 住原生 getter，apply trap 返回假值
  var proxied = new Proxy(nativeGet, {
    apply: function (t, self, args) { return 'FakeUA/1.0'; }
  });

  out.proxy_toString = Function.prototype.toString.call(proxied);
  out.proxy_name = proxied.name;
  out.proxy_length = proxied.length;
  out.proxy_hasPrototype = 'prototype' in proxied;
  out.proxy_call_works = (function () {
    try { return proxied.call(navigator); } catch (e) { return '<throw> ' + e.message; }
  })();

  // 栈帧：调用 proxy 出错时，栈里有没有多一帧
  var boom = new Proxy(nativeGet, {
    apply: function () { throw new Error('boom'); }
  });
  out.proxy_throw_stack = (function () {
    try { boom.call(navigator); } catch (e) { return String(e.stack || '').split('\\n').slice(0, 4); }
    return [];
  })();

  // 对照：普通函数字面量包装
  var wrap = function () { return 'FakeUA/1.0'; };
  out.wrap_toString = Function.prototype.toString.call(wrap);
  out.wrap_hasPrototype = 'prototype' in wrap;
  out.wrap_throw_stack = (function () {
    try { (function () { throw new Error('boom2'); })(); } catch (e) {
      return String(e.stack || '').split('\\n').slice(0, 4);
    }
    return [];
  })();

  // 构造器形态：Proxy 住原生构造器
  var PIntl = new Proxy(Intl.DateTimeFormat, {
    construct: function (t, args) { return Reflect.construct(t, args); }
  });
  out.proxy_ctor_toString = Function.prototype.toString.call(PIntl);
  out.proxy_ctor_name = PIntl.name;
  out.proxy_ctor_proto_ctor_same = (PIntl.prototype.constructor === PIntl);
  out.proxy_ctor_new_works = (function () {
    try { return new PIntl('en-US').resolvedOptions().locale; } catch (e) { return '<throw> ' + e.message; }
  })();

  return out;
})()`

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  mkdirSync(resolve(__dirname, '../artifacts'), { recursive: true })
  writeFileSync(PAGE, '<!doctype html><meta charset="utf-8"><title>lab</title><body>lab</body>', 'utf8')

  const win = new BrowserWindow({ show: false, width: 640, height: 480 })
  const wc = win.webContents
  await wc.loadURL('file:///' + PAGE.replace(/\\/g, '/'))
  wc.debugger.attach('1.3')

  const res = await wc.debugger.sendCommand('Runtime.evaluate', {
    expression: EXPR,
    returnByValue: true
  })

  if (res.exceptionDetails) {
    console.error('求值抛错：', res.exceptionDetails.exception?.description ?? res.exceptionDetails.text)
    app.exit(1)
    return
  }

  const v = res.result.value
  const row = (k, val) => console.log(`  ${k.padEnd(30)} ${JSON.stringify(val)}`)

  console.log('\n── 原生 getter（基准） ──')
  row('toString', v.native_toString)
  row('name / length', [v.native_name, v.native_length])
  row("'prototype' in fn", v.native_hasPrototype)

  console.log('\n── Proxy(nativeGetter, {apply}) ──')
  row('toString', v.proxy_toString)
  row('name / length', [v.proxy_name, v.proxy_length])
  row("'prototype' in proxy", v.proxy_hasPrototype)
  row('调用是否生效', v.proxy_call_works)
  console.log('  抛错栈：')
  for (const line of v.proxy_throw_stack) console.log('    ' + line)

  console.log('\n── 普通函数字面量包装（当前做法） ──')
  row('toString', v.wrap_toString)
  row("'prototype' in fn", v.wrap_hasPrototype)

  console.log('\n── Proxy(nativeCtor, {construct}) ──')
  row('toString', v.proxy_ctor_toString)
  row('name', v.proxy_ctor_name)
  row('prototype.constructor === 自身', v.proxy_ctor_proto_ctor_same)
  row('new 是否可用', v.proxy_ctor_new_works)

  console.log('')
  try { wc.debugger.detach() } catch { /* 忽略 */ }
  win.destroy()
  app.exit(0)
})
