/** profiles 域文案：环境列表、环境卡片、批量操作与分组弹窗。缺 key 时英文回落中文（见 ../index.ts）。 */
import type { Dict } from '../index'

export const zh: Dict = {
  'profiles.bulk.button': '批量新建',
  'profiles.bulk.title': '批量新建环境',
  'profiles.bulk.count': '数量（1–50）',
  'profiles.bulk.confirm': '创建',
  'profiles.bulk.note': '每个环境都会得到独立的指纹与种子；数量越多创建越久。',
  'profiles.bulk.created': '已创建 {n} 个环境',
  'profiles.bulk.createdPartial': '创建完成：成功 {ok} 个，失败 {failed} 个',
  'profiles.title': '环境',
  'profiles.subtitle.isolated': '个隔离环境',
  'profiles.subtitle.running': '个正在运行',
  'profiles.subtitle.needsAttention': '{n} 个需要处理',
  'profiles.subtitle.allReady': '全部就绪',

  'profiles.view.density': '视图密度',
  'profiles.view.grid': '网格视图',
  'profiles.view.list': '列表视图',

  'profiles.trash.toggle': '回收站',
  'profiles.trash.title': '回收站',
  'profiles.trash.empty': '回收站是空的。删除的环境会先移到这里，可以随时恢复。',
  'profiles.trash.deletedAt': '删除时间',
  'profiles.trash.restore': '恢复',
  'profiles.trash.purge': '彻底删除',
  'profiles.trash.purgeConfirmTitle': '彻底删除这个环境？',
  'profiles.trash.purgeConfirmNote':
    '此操作不可恢复，并且会清除该环境的 Cookie / localStorage / IndexedDB 等全部站点数据。仅当确定不再需要它的登录态时再继续。',
  'profiles.trash.restored': '已恢复环境「{name}」',
  'profiles.trash.purged': '已彻底删除环境「{name}」',

  'profiles.stat.total': '环境总数',
  'profiles.stat.totalDesc': '{n} 个分组',
  'profiles.stat.errorSuffix': ' · {n} 个异常',
  'profiles.stat.running': '运行中',
  'profiles.stat.runningUnit': '个',
  'profiles.stat.managed': '{n} 个由影子托管',
  'profiles.stat.today': '今日任务',
  'profiles.stat.todayDesc': '成功 {done} · 失败 {failed}',
  'profiles.stat.rate': '成功率',
  'profiles.stat.rateDesc': '近 7 日 · 共 {n} 个已结算任务',

  'profiles.filter.all': '全部',
  'profiles.selectAll': '全选',
  'profiles.selectAllTitle': '全选当前筛选结果',
  'profiles.deselectAll': '取消全选',
  'profiles.new': '新建',
  'profiles.ungrouped': '未分组',

  'profiles.bridgeWarn':
    '主进程尚未就绪（window.ss 未注入），当前列表为空。启动 Electron 后会自动拉取环境。',

  'profiles.error.title': '读不到环境列表 ≠ 没有环境',
  'profiles.error.hint':
    '这里只是没读到数据，不代表一个环境都没有。文件可能被杀毒软件或索引服务占用，也可能没有读权限；先停下别动，再试一次。',

  'profiles.loadingAria': '正在加载环境',

  'profiles.empty.createTitle': '新建第一个环境',
  'profiles.empty.noMatchTitle': '没有匹配的环境',
  'profiles.empty.createDesc':
    '每个环境都是一套独立的指纹、代理与 Cookie 空间。影子在里面干活，你在另一个环境里浏览，互不干扰。',
  'profiles.empty.noMatchDesc': '换个关键词，或切回「全部」分组。',
  'profiles.empty.createAction': '新建环境',
  'profiles.empty.showAllAction': '查看全部',
  'profiles.empty.hint': '指纹按平台模板确定性生成，同一个环境永远同一套参数',

  'profiles.table.name': '环境名',
  'profiles.table.platform': '平台',
  'profiles.table.group': '分组',
  'profiles.table.proxy': '代理',

  'profiles.select': '选择环境',
  'profiles.deselect': '取消选择',
  'profiles.clearSelection': '取消选择',

  'profiles.favorite.add': '加入收藏（置顶）',
  'profiles.favorite.remove': '取消收藏',
  'profiles.sort.label': '排序方式',
  'profiles.sort.recent': '最近使用',
  'profiles.sort.name': '名称',
  'profiles.sort.created': '创建时间',
  'profiles.sort.favorite': '收藏优先',

  'profiles.configure': '配置',
  'profiles.open': '打开',
  'profiles.view': '查看',
  'profiles.action.moveGroup': '移到分组',
  'profiles.action.switchProxy': '切换代理',

  'profiles.batch.selected': '已选 {n} 项',
  'profiles.batch.total': '共 {n} 个环境',
  'profiles.batch.start': '启动',
  'profiles.batch.stop': '停止',

  'profiles.modal.applyTo': '应用到 {n} 个环境',
  'profiles.modal.proxyNote': '格式：host:port，协议沿用原配置；留空表示改为直连',
  'profiles.modal.groupName': '分组名称',
  'profiles.modal.proxyAddress': '代理地址',
  'profiles.modal.groupPlaceholder': '例如：电商',
  'profiles.modal.proxyPlaceholder': '例如：45.132.8.21:8000',

  'profiles.card.openAria': '打开环境 {name}',
  'profiles.card.configAria': '配置环境',
  'profiles.card.runningStatus': '影子执行中 {done}/{total}',
  'profiles.status.idle': '影子待命',
  'profiles.status.starting': '启动中',
  'profiles.status.running': '运行中',
  'profiles.status.failed': '启动失败',
  'profiles.latency.timeout': '超时',
  'profiles.latency.unknown': '未探测',

  'profiles.mask.aria': '伪装状态：{state}',
  'profiles.mask.tone.idle': '未启动',
  'profiles.mask.tone.ok': '已伪装',
  'profiles.mask.tone.warn': '子目标降级',
  'profiles.mask.tone.block': '不可逆动作被拦',
  'profiles.mask.short.warn': '降级',
  'profiles.mask.short.block': '已拦',

  'profiles.exempt.title':
    '该环境已豁免伪装闸门（allowUnmaskedL2）：伪装不完整时仍可执行不可逆动作；伪装修好后自动收回',
  'profiles.exempt.aria': '已豁免伪装闸门',
  'profiles.exempt.badge': '已豁免',

  'profiles.direct': '直连 · 未配置代理',
  'profiles.lastUsed': '最后使用 {time}'
}

export const en: Dict = {
  'profiles.bulk.button': 'Bulk create',
  'profiles.bulk.title': 'Bulk create profiles',
  'profiles.bulk.count': 'Count (1–50)',
  'profiles.bulk.confirm': 'Create',
  'profiles.bulk.note': 'Each profile gets its own fingerprint and seed. More profiles take longer to create.',
  'profiles.bulk.created': 'Created {n} profiles',
  'profiles.bulk.createdPartial': 'Done: {ok} created, {failed} failed',
  'profiles.title': 'Profiles',
  'profiles.subtitle.isolated': 'isolated profiles',
  'profiles.subtitle.running': 'running',
  'profiles.subtitle.needsAttention': '{n} profiles need attention',
  'profiles.subtitle.allReady': 'All ready',

  'profiles.view.density': 'View density',
  'profiles.view.grid': 'Grid view',
  'profiles.view.list': 'List view',

  'profiles.trash.toggle': 'Trash',
  'profiles.trash.title': 'Trash',
  'profiles.trash.empty':
    'Trash is empty. Deleted profiles land here first and can be restored anytime.',
  'profiles.trash.deletedAt': 'Deleted at',
  'profiles.trash.restore': 'Restore',
  'profiles.trash.purge': 'Delete permanently',
  'profiles.trash.purgeConfirmTitle': 'Permanently delete this profile?',
  'profiles.trash.purgeConfirmNote':
    'This cannot be undone. It also clears all site data for this profile — cookies, localStorage, IndexedDB and more. Continue only if you no longer need its signed-in state.',
  'profiles.trash.restored': 'Restored {name}',
  'profiles.trash.purged': 'Permanently deleted {name}',

  'profiles.stat.total': 'Total profiles',
  'profiles.stat.totalDesc': '{n} groups',
  'profiles.stat.errorSuffix': ' · {n} errors',
  'profiles.stat.running': 'Running',
  'profiles.stat.runningUnit': 'profiles',
  'profiles.stat.managed': '{n} managed by Shadow',
  'profiles.stat.today': 'Tasks today',
  'profiles.stat.todayDesc': '{done} succeeded · {failed} failed',
  'profiles.stat.rate': 'Success rate',
  'profiles.stat.rateDesc': 'Last 7 days · {n} settled tasks',

  'profiles.filter.all': 'All',
  'profiles.selectAll': 'Select all',
  'profiles.selectAllTitle': 'Select all filtered profiles',
  'profiles.deselectAll': 'Deselect all',
  'profiles.new': 'New',
  'profiles.ungrouped': 'Ungrouped',

  'profiles.bridgeWarn':
    'Main process is not ready (window.ss not injected), so the list is empty. Profiles load automatically once Electron starts.',

  'profiles.error.title': "Couldn't load profiles — this doesn't mean there are none",
  'profiles.error.hint':
    'This only means the data could not be read — not that there are no profiles. The file may be locked by antivirus or an indexer, or you may lack read permission. Leave it untouched and try again.',

  'profiles.loadingAria': 'Loading profiles',

  'profiles.empty.createTitle': 'Create your first profile',
  'profiles.empty.noMatchTitle': 'No matching profiles',
  'profiles.empty.createDesc':
    'Each profile is its own fingerprint, proxy and cookie space. Shadow works in one while you browse in another — fully isolated.',
  'profiles.empty.noMatchDesc': 'Try a different search, or switch back to the All group.',
  'profiles.empty.createAction': 'New profile',
  'profiles.empty.showAllAction': 'Show all',
  'profiles.empty.hint':
    'Fingerprints are generated deterministically from platform templates — the same profile always gets the same parameters.',

  'profiles.table.name': 'Profile',
  'profiles.table.platform': 'Platform',
  'profiles.table.group': 'Group',
  'profiles.table.proxy': 'Proxy',

  'profiles.select': 'Select profile',
  'profiles.deselect': 'Deselect',
  'profiles.clearSelection': 'Clear selection',

  'profiles.favorite.add': 'Add to favorites (pin)',
  'profiles.favorite.remove': 'Remove from favorites',
  'profiles.sort.label': 'Sort by',
  'profiles.sort.recent': 'Recently used',
  'profiles.sort.name': 'Name',
  'profiles.sort.created': 'Created',
  'profiles.sort.favorite': 'Favorites first',

  'profiles.configure': 'Configure',
  'profiles.open': 'Open',
  'profiles.view': 'View',
  'profiles.action.moveGroup': 'Move to group',
  'profiles.action.switchProxy': 'Switch proxy',

  'profiles.batch.selected': '{n} selected',
  'profiles.batch.total': 'of {n} profiles',
  'profiles.batch.start': 'Start',
  'profiles.batch.stop': 'Stop',

  'profiles.modal.applyTo': 'Apply to {n} profiles',
  'profiles.modal.proxyNote':
    'Format: host:port. The existing protocol is kept; leave blank to connect directly.',
  'profiles.modal.groupName': 'Group name',
  'profiles.modal.proxyAddress': 'Proxy address',
  'profiles.modal.groupPlaceholder': 'e.g. E-commerce',
  'profiles.modal.proxyPlaceholder': 'e.g. 45.132.8.21:8000',

  'profiles.card.openAria': 'Open profile {name}',
  'profiles.card.configAria': 'Configure profile',
  'profiles.card.runningStatus': 'Shadow running {done}/{total}',
  'profiles.status.idle': 'Shadow idle',
  'profiles.status.starting': 'Starting',
  'profiles.status.running': 'Running',
  'profiles.status.failed': 'Failed to start',
  'profiles.latency.timeout': 'Timed out',
  'profiles.latency.unknown': 'Not probed',

  'profiles.mask.aria': 'Mask status: {state}',
  'profiles.mask.tone.idle': 'Not running',
  'profiles.mask.tone.ok': 'Masked',
  'profiles.mask.tone.warn': 'Worker degraded',
  'profiles.mask.tone.block': 'Irreversible actions blocked',
  'profiles.mask.short.warn': 'Degraded',
  'profiles.mask.short.block': 'Blocked',

  'profiles.exempt.title':
    'This profile is exempt from the mask gate (allowUnmaskedL2): irreversible actions remain available while masking is incomplete. The exemption is revoked automatically once masking is fixed.',
  'profiles.exempt.aria': 'Mask gate exempt',
  'profiles.exempt.badge': 'Exempt',

  'profiles.direct': 'Direct · no proxy',
  'profiles.lastUsed': 'Last used {time}'
}
