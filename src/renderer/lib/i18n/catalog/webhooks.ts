/** Webhook 文案（任务 / 定时结果回调）。 */
import type { Dict } from '../index'

export const zh: Dict = {
  'wh.title': 'Webhook',
  'wh.subtitle': '任务与定时执行的结果回调到外部系统。请求只从本机发出，不经过任何中间服务器。',
  'wh.url': '回调地址',
  'wh.urlPlaceholder': 'https://example.com/hooks/shadowsurf',
  'wh.events': '订阅事件',
  'wh.eventsHint': '不勾选任何事件 = 订阅全部。',
  'wh.last.ok': '上次投递成功 · HTTP {status}',
  'wh.last.bad': '上次投递失败 · HTTP {status} · {reason}',
  'wh.last.unknown': '原因未知',
  'wh.allowInternal': '允许投递到内网地址',
  'wh.allowInternalHint':
    '默认拒绝回环 / 私网 / 链路本地地址（含云元数据）。你的回调在自己家里时才需要勾选。',
  'wh.event.taskDone': '任务完成',
  'wh.event.taskFailed': '任务失败',
  'wh.event.scheduleDone': '定时执行完成',
  'wh.add': '添加',
  'wh.test': '测试',
  'wh.testOk': '已送达（HTTP {status}）',
  'wh.testFailed': '投递失败：{error}',
  'wh.empty': '还没有 Webhook',
  'wh.emptyHint': '添加一个地址，任务跑完就会收到一条 JSON。',
  'wh.remove': '删除',
  'wh.created': '已添加 Webhook',
  'wh.removed': '已删除 Webhook',
  'wh.invalidUrl': '回调地址必须是 http / https',
  'wh.readFailed': '读取 Webhook 失败'
}

export const en: Dict = {
  'wh.title': 'Webhooks',
  'wh.subtitle':
    'Task and scheduled-run results delivered to your own systems. Requests leave this machine only — no relay server in between.',
  'wh.url': 'Callback URL',
  'wh.urlPlaceholder': 'https://example.com/hooks/shadowsurf',
  'wh.events': 'Events',
  'wh.eventsHint': 'Selecting nothing subscribes to all of them.',
  'wh.last.ok': 'Last delivery OK · HTTP {status}',
  'wh.last.bad': 'Last delivery failed · HTTP {status} · {reason}',
  'wh.last.unknown': 'reason unknown',
  'wh.allowInternal': 'Allow internal addresses',
  'wh.allowInternalHint':
    'Loopback / private / link-local addresses (including cloud metadata) are refused by default. Only tick this if the endpoint is on your own network.',
  'wh.event.taskDone': 'Task finished',
  'wh.event.taskFailed': 'Task failed',
  'wh.event.scheduleDone': 'Scheduled run finished',
  'wh.add': 'Add',
  'wh.test': 'Test',
  'wh.testOk': 'Delivered (HTTP {status})',
  'wh.testFailed': 'Delivery failed: {error}',
  'wh.empty': 'No webhooks yet',
  'wh.emptyHint': 'Add an address and every finished task posts a JSON payload to it.',
  'wh.remove': 'Delete',
  'wh.created': 'Webhook added',
  'wh.removed': 'Webhook deleted',
  'wh.invalidUrl': 'The callback URL must be http or https',
  'wh.readFailed': 'Could not read webhooks'
}
