/** 代理组文案（轮换策略 / 故障转移 / 绑定到环境）。 */
import type { Dict } from '../index'

export const zh: Dict = {
  'pg.title': '代理组',
  'pg.subtitle': '一组出口按策略轮换；故障转移不会退回直连。',
  'pg.create': '新建组',
  'pg.name': '组名',
  'pg.namePlaceholder': '例如：美国住宅池',
  'pg.members': '成员代理',
  'pg.membersHint': '按列表顺序轮换，先选中的先轮。',
  'pg.membersEmpty': '还没有可用的代理记录',
  'pg.strategy': '轮换策略',
  'pg.strategy.roundRobin': '轮询',
  'pg.strategy.random': '随机',
  'pg.strategy.sticky': '粘性（失败才换）',
  'pg.failover': '故障转移',
  'pg.failoverHint':
    '选中的出口探测失败时自动换下一条；全都不通则环境启动失败，**不会退回直连**——用真实 IP 出去比环境起不来危险得多。',
  'pg.empty': '还没有代理组',
  'pg.emptyHint': '建一个组，把出口放进去，再在环境抽屉里挂到某个环境。',
  'pg.count': '{n} 条出口',
  'pg.remove': '删除组',
  'pg.removeConfirm': '删除代理组「{name}」？已经挂上它的环境会退回「未配置代理」。',
  'pg.created': '已新建代理组「{name}」',
  'pg.removed': '已删除代理组「{name}」',
  'pg.assign': '代理组',
  'pg.assignNone': '不挂组',
  'pg.assignHint': '挂组后由主进程在启动前按策略选出口；改动在下次启动生效。',
  'pg.pickFailed': '代理组「{name}」没有可用出口',
  'pg.readFailed': '读取代理组失败'
}

export const en: Dict = {
  'pg.title': 'Proxy groups',
  'pg.subtitle': 'A pool of exits rotated by policy; failover never falls back to direct.',
  'pg.create': 'New group',
  'pg.name': 'Group name',
  'pg.namePlaceholder': 'e.g. US residential pool',
  'pg.members': 'Member proxies',
  'pg.membersHint': 'Rotated in list order, top first.',
  'pg.membersEmpty': 'No proxy records yet',
  'pg.strategy': 'Rotation',
  'pg.strategy.roundRobin': 'Round robin',
  'pg.strategy.random': 'Random',
  'pg.strategy.sticky': 'Sticky (switch on failure)',
  'pg.failover': 'Failover',
  'pg.failoverHint':
    'When the selected exit fails its probe, the next one is tried. If none works the profile fails to start — it never falls back to direct, because leaking the real IP is worse than a profile that will not open.',
  'pg.empty': 'No proxy groups yet',
  'pg.emptyHint': 'Create a group, put exits in it, then assign it to a profile.',
  'pg.count': '{n} exits',
  'pg.remove': 'Delete group',
  'pg.removeConfirm': 'Delete proxy group {name}? Profiles using it fall back to no proxy.',
  'pg.created': 'Created proxy group {name}',
  'pg.removed': 'Deleted proxy group {name}',
  'pg.assign': 'Proxy group',
  'pg.assignNone': 'No group',
  'pg.assignHint': 'The main process picks an exit by policy right before launch; changes apply on the next launch.',
  'pg.pickFailed': 'No working exit in proxy group {name}',
  'pg.readFailed': 'Could not read proxy groups'
}
