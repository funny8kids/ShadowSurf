/** 动作同步器文案（多环境同脚本批量回放）。 */
import type { Dict } from '../index'

export const zh: Dict = {
  'sync.title': '同步执行',
  'sync.hint':
    '把同一条脚本在多个环境里依次回放。含支付等不可逆步骤时，每个环境仍会各自弹一次系统确认 —— 一次确认放行一批环境，风险会被摊薄。',
  'sync.pick': '选择环境',
  'sync.pickHint': '按住 Ctrl / ⌘ 可以多选。',
  'sync.run': '同步执行',
  'sync.running': '正在回放…',
  'sync.result': '结果',
  'sync.ok': '{n} 个环境完成',
  'sync.partial': '{ok} 个完成 · {failed} 个失败 · {confirm} 个待确认',
  'sync.done': '完成',
  'sync.failed': '失败',
  'sync.needsConfirm': '待确认',
  'sync.noSelection': '先选至少一个环境',
  'sync.noProfile': '环境「{name}」还没打开，先启动它再回放',
  'sync.failedToStart': '环境「{name}」启动失败'
}

export const en: Dict = {
  'sync.title': 'Sync run',
  'sync.hint':
    'Replays the same script across several profiles, one after another. Irreversible steps still ask once per profile — approving a batch in one go would spread the risk instead of containing it.',
  'sync.pick': 'Select profiles',
  'sync.pickHint': 'Hold Ctrl / ⌘ to pick several.',
  'sync.run': 'Run on selected',
  'sync.running': 'Replaying…',
  'sync.result': 'Results',
  'sync.ok': '{n} profiles finished',
  'sync.partial': '{ok} done · {failed} failed · {confirm} awaiting confirmation',
  'sync.done': 'Done',
  'sync.failed': 'Failed',
  'sync.needsConfirm': 'Needs confirmation',
  'sync.noSelection': 'Pick at least one profile',
  'sync.noProfile': 'Profile {name} is not open yet — start it before replaying',
  'sync.failedToStart': 'Could not start profile {name}'
}
