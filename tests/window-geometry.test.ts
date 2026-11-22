/**
 * 控制台窗口几何的持久化。
 *
 * 这是纯展示偏好，所以行为准则和 Settings 完全相反：
 * - Settings 损坏 → 响亮失败（那是数据）
 * - 几何损坏 → 静默回退默认（那只是"窗口上次多大"）
 *
 * 这里钉住三条：合法值往返、坏值拒绝、读不到返回 null。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

import {
  readWindowGeometry,
  writeWindowGeometry
} from '../src/main/store/window-geometry.ts'

function sandbox(): { dataDir: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'shadowsurf-window-'))
  const dataDir = join(root, 'data')
  mkdirSync(dataDir)
  return { dataDir, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('合法几何往返：写完能读回，文件在 data 目录旁边', () => {
  const box = sandbox()
  try {
    const g = { x: 120, y: 80, width: 1500, height: 940, maximized: false }
    writeWindowGeometry(box.dataDir, g)
    assert.deepEqual(readWindowGeometry(box.dataDir), g)
    // 不给 Settings 添乱：几何文件在 data 目录旁边，不在里面
    const p = join(dirname(box.dataDir), 'window-state.json')
    assert.ok(existsSync(p), '几何文件应在 data 目录旁边')
  } finally {
    box.cleanup()
  }
})

test('损坏 / 离谱的几何一律回退，不能把启动搞挂', () => {
  const box = sandbox()
  try {
    const p = join(dirname(box.dataDir), 'window-state.json')
    // 非法 JSON
    writeFileSync(p, '{ broken')
    assert.equal(readWindowGeometry(box.dataDir), null)
    // 尺寸离谱（显示器拔掉后的残留）
    writeFileSync(p, JSON.stringify({ x: 0, y: 0, width: 5, height: 5, maximized: false }))
    assert.equal(readWindowGeometry(box.dataDir), null)
    // x 不是数字（Number('abc') = NaN，plausible 会拒）
    writeFileSync(p, JSON.stringify({ x: 'abc', y: 0, width: 1200, height: 800 }))
    assert.equal(readWindowGeometry(box.dataDir), null)
  } finally {
    box.cleanup()
  }
})

test('没有文件时返回 null（首次运行）', () => {
  const box = sandbox()
  try {
    assert.equal(readWindowGeometry(box.dataDir), null)
  } finally {
    box.cleanup()
  }
})
