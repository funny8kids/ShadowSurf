/**
 * 数据健康横幅的文案。
 *
 * 归属：store-health-agent
 */
import type { Dict } from '../index'

export const zh: Dict = {
  'sh.origin.corrupt': '损坏副本',
  'sh.origin.preupgrade': '迁移前快照',
  'sh.origin.schema': '旧命名迁移快照',

  'sh.error.shape':
    '数据健康检查返回了无法识别的结果（这不等于「一切正常」，请重试或查看日志）',
  'sh.error.read': '无法读取数据健康状态：{reason}',

  'sh.detail.open': '详情（{n}）',
  'sh.detail.close': '收起',
  'sh.close.title': '本次会话不再提示（问题本身没有被修复）',

  'sh.table.backup': '备份文件',
  'sh.table.origin': '来源',
  'sh.table.size': '大小',
  'sh.table.plaintextSeeds': '明文 seed',
  'sh.plaintextCount': '{n} 条（明文）',

  'sh.foot':
    '这些文件不会被自动清理：损坏文件是排查依据，含明文 seed 的备份可能仍是唯一的已知良好快照。',
  'sh.dataDir': '数据目录：',
  'sh.unknown': '未知',
  'sh.recheck': '重新检查'
}

export const en: Dict = {
  'sh.origin.corrupt': 'Corrupt copy',
  'sh.origin.preupgrade': 'Pre-upgrade snapshot',
  'sh.origin.schema': 'Legacy-name migration snapshot',

  'sh.error.shape':
    'The store health check returned an unrecognisable result (this is NOT "everything is fine" — retry or check the logs)',
  'sh.error.read': 'Could not read store health: {reason}',

  'sh.detail.open': 'Details ({n})',
  'sh.detail.close': 'Collapse',
  'sh.close.title': 'Do not show again this session (the problem itself is not fixed)',

  'sh.table.backup': 'Backup file',
  'sh.table.origin': 'Origin',
  'sh.table.size': 'Size',
  'sh.table.plaintextSeeds': 'Plaintext seeds',
  'sh.plaintextCount': '{n} (plaintext)',

  'sh.foot':
    'These files are never cleaned up automatically: a corrupt file is evidence, and a backup with plaintext seeds may be the only known-good snapshot left.',
  'sh.dataDir': 'Data directory: ',
  'sh.unknown': 'unknown',
  'sh.recheck': 'Re-check'
}
