/**
 * 模块上下文。
 *
 * 每个功能域（代理池 / 模板迁移 / RPA / 本地 API / 审计自检 / 浏览数据）
 * 都只依赖这一个结构，不直接 import handlers.ts，避免循环依赖，
 * 也避免多个模块抢改同一个文件。
 */

import type { IpcMainInvokeEvent } from 'electron'
import type { Stores } from '@main/store'
import type { WindowManager } from '@main/core/windows'
import type { ProfileRuntime } from '@main/core/profiles'

/** 模块注册 handler 用的统一包装：异常自动转成 Result 的失败分支 */
export type HandleFn = (
  channel: string,
  fn: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown
) => void

/** 向所有窗口广播推送通道 */
export type BroadcastFn = (channel: string, payload: unknown) => void

export interface ModuleContext {
  stores: Stores
  wm: WindowManager
  runtime: ProfileRuntime
  handle: HandleFn
  broadcast: BroadcastFn
}

/** 各模块统一的注册签名 */
export type ModuleRegistrar = (ctx: ModuleContext) => void
