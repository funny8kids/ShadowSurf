/** 扩展管理面板文案。 */
import type { Dict } from '../index'

export const zh: Dict = {
  'ext.title': '扩展',
  'ext.subtitle': '本地扩展 · 只登记已解压目录，不下载远程包',
  'ext.add': '添加',
  'ext.name': '名称',
  'ext.namePlaceholder': '例如：广告拦截',
  'ext.path': '目录路径',
  'ext.pathHint': '填扩展目录的绝对路径，目录里必须含 manifest.json。',
  'ext.pathPlaceholder': 'C:\\Extensions\\my-extension 或 /home/me/ext',
  'ext.empty': '还没有登记任何扩展',
  'ext.emptyHint': '在 chrome://extensions 里打包/找到已解压目录后填绝对路径',
  'ext.enabled': '已启用',
  'ext.disabled': '已停用',
  'ext.remove': '删除',
  'ext.removeConfirm': '删除「{name}」的登记？只删记录，不会删除磁盘上的扩展目录。',
  'ext.added': '已添加扩展',
  'ext.removed': '已删除扩展登记',
  'ext.readFailed': '读取扩展列表失败',
  'ext.noManifest': '扩展目录里没有 manifest.json'
}

export const en: Dict = {
  'ext.title': 'Extensions',
  'ext.subtitle': 'Local extensions · register unpacked directories only; no remote downloads',
  'ext.add': 'Add',
  'ext.name': 'Name',
  'ext.namePlaceholder': 'e.g. Ad blocker',
  'ext.path': 'Directory path',
  'ext.pathHint': 'Absolute path to the extension directory; it must contain manifest.json.',
  'ext.pathPlaceholder': 'C:\\Extensions\\my-extension or /home/me/ext',
  'ext.empty': 'No extensions registered yet',
  'ext.emptyHint':
    'Pack or locate the unpacked directory in chrome://extensions, then enter its absolute path',
  'ext.enabled': 'Enabled',
  'ext.disabled': 'Disabled',
  'ext.remove': 'Remove',
  'ext.removeConfirm':
    'Remove the registration for "{name}"? Only the record is removed; the extension directory on disk is left untouched.',
  'ext.added': 'Extension added',
  'ext.removed': 'Extension registration removed',
  'ext.readFailed': 'Could not read the extension list',
  'ext.noManifest': 'The extension directory has no manifest.json'
}
