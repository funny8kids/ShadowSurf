/** tasks 域文案：任务列表、统计卡、回放时间线与产出预览。缺 key 时英文回落中文（见 ../index.ts）。 */
import type { Dict } from '../index'

export const zh: Dict = {
  'tasks.title': '任务',
  'tasks.subtitle': '影子的执行记录 · 每一步都可回放、可接管',

  'tasks.exportAudit': '导出审计',
  'tasks.newTask': '新建任务',
  'tasks.auditExported': '已导出 {n} 条审计记录',

  'tasks.stat.today': '今日任务',
  'tasks.stat.total': '累计 {n} 条执行记录',
  'tasks.stat.rate': '成功率',
  'tasks.stat.rateDesc': '共 {n} 个已结算任务',
  'tasks.stat.avg': '平均耗时',
  'tasks.stat.avgDesc': '从任务开始到 done 事件',
  'tasks.stat.tokens': 'Token 消耗',
  'tasks.stat.tokensDesc': '模型与代理消耗未折算成本',

  'tasks.loading': '正在读取任务…',

  'tasks.error.title': '读不到任务列表 ≠ 没有任务',
  'tasks.error.hint':
    '这里只是没读到数据，不代表一条任务都没有。文件可能被杀毒软件或索引服务占用，也可能没有读权限；先停下别动，再试一次。',

  'tasks.empty.title': '还没有任务',
  'tasks.empty.desc': '在双轨窗口里给影子下一个指令，执行记录会出现在这里，每一步都能回放。',

  'tasks.status.queued': '排队中',
  'tasks.status.running': '进行中',
  'tasks.status.paused': '已暂停',
  'tasks.status.done': '已完成',
  'tasks.status.failed': '失败',
  'tasks.status.stopped': '已停止',

  'tasks.replay.stepOf': '第 {done} 步 / 共 {total} 步',
  'tasks.replay.profile': '环境',
  'tasks.replay.start': '开始',
  'tasks.replay.duration': '耗时',
  'tasks.replay.date': '日期',
  'tasks.replay.play': '播放回放',
  'tasks.replay.pause': '暂停回放',
  'tasks.replay.playTitle': '逐步回放执行时间线',
  'tasks.replay.progress': '回放进度',
  'tasks.replay.takeOver': '接管',
  'tasks.replay.noSteps':
    '这一步还没有产生记录。任务执行后，每一步的动作、思考摘要与结果都会写在这里。',

  'tasks.output.title': '产出预览',
  'tasks.output.stepCount': '{n} 步执行记录',
  'tasks.output.openProfile': '打开环境',
  'tasks.output.step': '步骤',
  'tasks.output.result': '结果',
  'tasks.output.empty': '暂无产出',

  'tasks.stepStatus.running': '正在执行',
  'tasks.stepStatus.ok': '已完成',
  'tasks.stepStatus.failed': '失败',
  'tasks.stepStatus.rejected': '已跳过',
  'tasks.stepStatus.confirm': '等待确认'
}

export const en: Dict = {
  'tasks.title': 'Tasks',
  'tasks.subtitle': "Shadow's run history — every step can be replayed and taken over",

  'tasks.exportAudit': 'Export audit',
  'tasks.newTask': 'New task',
  'tasks.auditExported': 'Exported {n} audit entries',

  'tasks.stat.today': 'Tasks today',
  'tasks.stat.total': '{n} runs in total',
  'tasks.stat.rate': 'Success rate',
  'tasks.stat.rateDesc': '{n} settled tasks',
  'tasks.stat.avg': 'Avg. duration',
  'tasks.stat.avgDesc': 'From task start to the done event',
  'tasks.stat.tokens': 'Token usage',
  'tasks.stat.tokensDesc': 'Model and proxy usage, excluding cost',

  'tasks.loading': 'Loading tasks…',

  'tasks.error.title': "Couldn't load tasks — this doesn't mean there are none",
  'tasks.error.hint':
    'This only means the data could not be read — not that there are no tasks. The file may be locked by antivirus or an indexer, or you may lack read permission. Leave it untouched and try again.',

  'tasks.empty.title': 'No tasks yet',
  'tasks.empty.desc':
    'Give Shadow an instruction in the split-view window and the run will appear here, with every step ready to replay.',

  'tasks.status.queued': 'Queued',
  'tasks.status.running': 'Running',
  'tasks.status.paused': 'Paused',
  'tasks.status.done': 'Done',
  'tasks.status.failed': 'Failed',
  'tasks.status.stopped': 'Stopped',

  'tasks.replay.stepOf': 'Step {done} of {total}',
  'tasks.replay.profile': 'Profile',
  'tasks.replay.start': 'Started',
  'tasks.replay.duration': 'Duration',
  'tasks.replay.date': 'Date',
  'tasks.replay.play': 'Play replay',
  'tasks.replay.pause': 'Pause replay',
  'tasks.replay.playTitle': 'Replay the execution timeline step by step',
  'tasks.replay.progress': 'Replay progress',
  'tasks.replay.takeOver': 'Take over',
  'tasks.replay.noSteps':
    "No record for this step yet. Once the task runs, each step's action, reasoning summary and result will appear here.",

  'tasks.output.title': 'Output preview',
  'tasks.output.stepCount': '{n}-step run record',
  'tasks.output.openProfile': 'Open profile',
  'tasks.output.step': 'Step',
  'tasks.output.result': 'Result',
  'tasks.output.empty': 'No output yet',

  'tasks.stepStatus.running': 'Running',
  'tasks.stepStatus.ok': 'Done',
  'tasks.stepStatus.failed': 'Failed',
  'tasks.stepStatus.rejected': 'Skipped',
  'tasks.stepStatus.confirm': 'Awaiting approval'
}
