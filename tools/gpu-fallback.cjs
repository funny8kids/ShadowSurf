/**
 * 在 CJS 探针里按需启用软件 WebGL。
 *
 * 为什么需要：`probe-worker.cjs` / `probe-mask.cjs` 会 `app.disableHardwareAcceleration()`
 * 来让读数在有无 GPU 的机器上都一致；但那同时关掉了软件渲染 —— 于是 WebGL 探针
 * 读到 `no-webgl` / `no-ext`，不是注入没生效，而是根本没测到。
 *
 * 门禁要验的是「注入值 == profile 配置」，宿主真 GPU 是什么型号无关紧要；
 * 用 SwiftShader 造出一个真实 WebGL 上下文当测量底座，正好够用。
 * Windows / macOS 默认不动（保持原有行为），Linux 上无条件开软件渲染。
 *
 * 注意：这不是在声称「宿主 GPU 被伪造了」—— 软件渲染只是为了让探针能读到
 * 被注入的 vendor/renderer 值。
 */

function gpuFallbackSwitches(env = process.env) {
  if (env.SS_FORCE_SWIFTSHADER === '1' || process.platform === 'linux') {
    return [
      ['use-gl', 'angle'],
      ['use-angle', 'swiftshader'],
      ['enable-unsafe-swiftshader', '']
    ]
  }
  return []
}

/** 在 `app.whenReady()` 之前调用；返回实际追加的开关，方便探针打印。 */
function enableSoftwareWebGL(app, env = process.env) {
  const sw = gpuFallbackSwitches(env)
  for (const [key, value] of sw) {
    if (value === '') app.commandLine.appendSwitch(key)
    else app.commandLine.appendSwitch(key, value)
  }
  return sw.map(([k, v]) => (v ? `--${k}=${v}` : `--${k}`))
}

module.exports = { gpuFallbackSwitches, enableSoftwareWebGL }
