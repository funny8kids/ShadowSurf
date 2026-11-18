/**
 * 仅在需要时给 Electron 追加「软件 WebGL（SwiftShader）」启动参数。
 *
 * 为什么这么做（务必看清，别误解成「伪造了宿主 GPU」）：
 *
 * 本仓库这些 verify:* 门禁断言的是**注入值是否等于 profile 配置值**，而根本不是
 * 「宿主机真实显卡是什么型号」。换句话说，宿主 GPU 型号从来就不是被测量的对象。
 * 在 Linux（Spark 远程用 Xvfb :99，没有硬件 GPU）上，`getContext('webgl')` 直接
 * 失败或 `WEBGL_debug_renderer_info` 取不到，于是 w-webgl-renderer / w-webgl-vendor
 * 以及 AC-09 / AC-14 / AC-21 这些字段只能被记成 no-webgl / unmeasured —— 门禁
 * 不是「没通过」，而是「压根没测到」。这不是我们想要的结果。
 *
 * SwiftShader 是一个可移植的纯软件渲染器，能提供一个**真实可用的 WebGL 上下文**，
 * 让注入脚本的 `getParameter` / `WEBGL_debug_renderer_info` 真的跑起来、真的产出
 * 一个可被断言的数值。我们把它当作**测量 substrate（观测基底）**来用：有了上下文，
 * 才能验证「注入进去的值 === 配置里写的值」这件事。它绝不代表、也绝不能被表述为
 * 「宿主 GPU 被伪造了」—— 宿主显卡是什么，我们既不关心也没改。
 *
 * 平台策略：Linux 上恒开（SwiftShader 可移植，且门禁测的是注入值而非宿主显卡）；
 * Windows / macOS 上默认返回 []，行为逐字节保持不变，除非显式设
 * SS_FORCE_SWIFTSHADER=1（给 CI 用的强制开关）。
 */

const SWIFTSHADER_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader'
]

/**
 * 返回需要追加给 Electron 的启动参数。
 * @param {NodeJS.ProcessEnv} env 环境变量对象，默认取 process.env
 * @returns {string[]} 需要追加的参数；不需要时为空数组
 */
export function gpuFallbackArgs(env = process.env) {
  if (env.SS_FORCE_SWIFTSHADER === '1' || process.platform === 'linux') {
    return [...SWIFTSHADER_ARGS]
  }
  return []
}
