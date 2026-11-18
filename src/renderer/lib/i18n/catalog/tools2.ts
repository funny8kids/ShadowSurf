/** 工具面板文案（data / api / audit / team）。 */
import type { Dict } from '../index'

export const zh: Dict = {
  /* ────────────────────────────── 浏览数据 ────────────────────────────── */
  'data.title': '浏览数据',
  'data.subtitle': 'Cookie 与历史按环境独立存放，下载记录为全局视图，清空只影响当前所选环境。',
  'data.scope.global': '全局',
  'data.scope.noProfile': '未选择环境',
  'data.scope.noProfileShort': '未选择',
  'data.selectProfile': '选择环境',
  'data.noProfiles': '暂无环境',
  'data.tabsAria': '浏览数据类型',
  'data.tab.cookies': 'Cookie',
  'data.tab.downloads': '下载',
  'data.tab.history': '历史',

  'data.export.netscape': '导出 Netscape',
  'data.export.netscapeTitle': '导出为 Netscape 格式，兼容大多数浏览器与代理工具',
  'data.export.json': '导出 JSON',
  'data.export.jsonTitle': '导出为 ShadowSurf JSON，可再导入回来',
  'data.import.open': '导入Cookie',
  'data.import.openTitle': '从 Netscape 文本或 ShadowSurf JSON 导入 Cookie',

  'data.clear.cookies': '清空该环境 Cookie',
  'data.clear.downloads': '清空下载记录',
  'data.clear.history': '清空该环境历史',

  'data.note.cookies':
    'Cookie 按环境隔离，导入导出只影响当前所选环境「{name}」；其他环境不受影响。',

  'data.empty.noProfile.title': '还没有可用的环境',
  'data.empty.noProfile.desc':
    'Cookie 与历史跟着环境走。先在环境页创建一个身份，再回来查看它留下的痕迹。',
  'data.empty.cookies.title': '这个环境还没有 Cookie',
  'data.empty.cookies.desc':
    '用该环境打开任意站点登录一次，Cookie 会写进它自己的存储分区，其他环境看不到。',
  'data.empty.downloads.title': '还没有下载记录',
  'data.empty.downloads.desc':
    '在任意环境里下载文件，进度会实时出现在这里；记录只保留在本次运行期间。',
  'data.empty.history.title': '这个环境还没有历史记录',
  'data.empty.history.desc':
    '环境内的整页跳转会写进这里，站内单页路由（pushState）不计入。',

  'data.loading.cookies': '正在读取 Cookie…',
  'data.loading.downloads': '正在读取下载记录…',
  'data.loading.history': '正在读取历史…',
  'data.error.cookies': '读不到 Cookie',
  'data.error.downloads': '读不到下载记录',
  'data.error.history': '读不到历史',
  'data.errHint.cookies':
    '这不等于「没有 Cookie」。存储文件可能被杀毒软件或索引服务占用，也可能没有读权限；现在无法判断，先别据此清空或重建。',
  'data.errHint.downloads':
    '这不等于「没有下载记录」。存储文件可能被杀毒软件或索引服务占用，也可能没有读权限；现在无法判断，先别据此清空或重建。',
  'data.errHint.history':
    '这不等于「没有历史」。存储文件可能被杀毒软件或索引服务占用，也可能没有读权限；现在无法判断，先别据此清空或重建。',

  'data.table.domain': '域名',
  'data.table.value': '值',
  'data.table.flags': '属性',
  'data.table.expires': '过期',
  'data.reveal.show': '点击显示明文',
  'data.reveal.hide': '点击隐藏',
  'data.value.empty': '(空)',
  'data.flag.session': '会话',
  'data.sessionEnd': '会话结束',

  'data.download.unnamed': '未命名文件',
  'data.download.state.progressing': '下载中',
  'data.download.state.completed': '已完成',
  'data.download.state.cancelled': '已取消',
  'data.download.state.interrupted': '已中断',

  'data.clearModal.cookies.title': '清空该环境的 Cookie',
  'data.clearModal.downloads.title': '清空下载记录',
  'data.clearModal.history.title': '清空该环境的历史记录',
  'data.clearModal.cookies.note': '清空后该环境的所有站点都会回到未登录状态，其他环境不受影响。',
  'data.clearModal.downloads.note': '只清空这份列表，正在进行中的下载不会被取消。',
  'data.clearModal.history.note': '只删除该环境的浏览记录，其他环境的历史保持原样。',
  'data.clearModal.cookies.body': '将清空环境「{name}」的 {n} 条 Cookie。',
  'data.clearModal.downloads.body': '将清空 {n} 条下载记录。',
  'data.clearModal.history.body': '将删除环境「{name}」的 {n} 条历史记录。',
  'data.clearModal.confirm': '确认清空',

  'data.import.title': '导入 Cookie',
  'data.import.note':
    '导入按环境隔离：这些 Cookie 只会写进当前所选环境，不会出现在其他环境里。',
  'data.import.contentLabel': 'Cookie 内容',
  'data.import.contentHint':
    '支持 Netscape cookies.txt 格式，或 ShadowSurf 导出的 JSON。逐条校验，坏行单独报错。',
  'data.import.importing': '导入中…',
  'data.import.submit': '导入',
  'data.import.errors': '查看 {n} 条失败原因',
  'data.import.summary.noCookies': '没有可导入的 Cookie（{n} 条解析失败）。',
  'data.import.summary.failed': '已导入 {imported} 条，失败 {failed} 条。',
  'data.import.summary.ok': '已导入 {n} 条，全部成功。',

  'data.toast.clearedCookies': '已清空 {n} 条 Cookie',
  'data.toast.noCookiesToClear': '该环境没有可清理的 Cookie',
  'data.toast.clearedDownloads': '已清空下载记录',
  'data.toast.clearedHistory': '已清空该环境的历史记录',
  'data.toast.exported': '已导出 {format} Cookie',
  'data.toast.importNoCookies': '没有可导入的 Cookie（{n} 条解析失败）',
  'data.toast.importFailed': '已导入 {imported} 条，失败 {failed} 条',
  'data.toast.imported': '已导入 {imported} 条',

  'data.warmup.button': 'Cookie 预热',
  'data.warmup.title': 'Cookie 预热',
  'data.warmup.desc':
    '按顺序访问这些页面，让站点把 Cookie 与浏览历史写进该环境；每页停留 1.5–3 秒。最多 30 条。运行时会打开一个不可见窗口，请勿同时手动操作同一环境。',
  'data.warmup.urls': 'URL 列表',
  'data.warmup.urlsPlaceholder': 'https://www.google.com\nhttps://www.youtube.com',
  'data.warmup.run': '开始预热',
  'data.warmup.running': '预热中…',
  'data.warmup.done': '预热完成：成功 {ok} / {total}',
  'data.warmup.failedDetail': '查看 {n} 条失败明细',
  'data.warmup.noProfile': '请先选择环境',

  /* ────────────────────────────── 本地 API ────────────────────────────── */
  'api.title': '本地 API',
  'api.subtitle':
    '在回环地址上起一个 REST 服务，外部脚本、CLI、IDE 插件都能用它驱动环境。当前 {n} 个环境可被调用。',

  'api.error.title': '读不到本地 API 状态 ≠ 已停止',
  'api.loading': '读取中…',
  'api.running': '运行中',
  'api.stopped': '已停止',
  'api.portAria': '监听端口',
  'api.port.title.running': '停止后才能修改端口',
  'api.port.title.idle': '监听端口，默认 7717',
  'api.start': '启动',
  'api.stop': '停止',

  'api.metric.address': '监听地址',
  'api.metric.port': '端口',
  'api.metric.requests': '已处理请求',
  'api.metric.startedAt': '启动时间',

  'api.token.title': '访问令牌',
  'api.token.requirement':
    '除 /health 外，所有请求都要带 Authorization: Bearer <token>',
  'api.scope.lead': '持有此令牌的本地进程可以在',
  'api.scope.anyProfile': '任意环境',
  'api.scope.afterAny': '上执行操作。',
  'api.scope.reversible': '可回退动作',
  'api.scope.afterReversible': '（点击链接、滚动、取数）直接执行；',
  'api.scope.irreversible': '不可逆动作',
  'api.scope.afterIrreversible':
    '（支付、删除、发布、发送）需要在本机弹窗确认，必须有人当场点「允许执行」才会跑 —— 无人值守的自动化跑到那一步会停住，然后在 120 秒后拿到 409 超时。',
  'api.scope.br': '这不是能力限制，是设计：',
  'api.scope.design': '自动化可以做，不可逆的那一下要有人在场。',
  'api.scope.tail': '令牌文件以当前用户身份可读，同一账户下的其他程序也能读到它。',

  'api.token.hidden': '保存在主进程内，界面不显示',
  'api.token.copy': '复制令牌',
  'api.token.regenerate': '重新生成',
  'api.token.regenerate.title.on': '作废旧令牌并生成新的',
  'api.token.regenerate.title.off': '服务启动后才能重新生成令牌',

  'api.hint.lead':
    '令牌是 32 字节随机值，存在数据目录的 local-api-token.json 里，重启应用不会变。',
  'api.hint.noShow': ' 界面上没有「显示令牌」是有意的',
  'api.hint.mid':
    '：这一页跑在渲染层，能显示就能被读走。「复制令牌」由主进程直接写剪贴板，明文不经过这里。',
  'api.hint.regenerate': ' 重新生成是唯一的补救动作',
  'api.hint.tail': '：作废旧令牌后，已发出的调用立即失效。',

  'api.endpoints.title': '端点速查',
  'api.endpoints.response': '成功返回 {ok}，失败返回 {error}',
  'api.ep.health': '探活，唯一免鉴权的端点',
  'api.ep.profiles': '环境列表',
  'api.ep.launch': '启动环境',
  'api.ep.stop': '停止环境',
  'api.ep.snapshot': '页面快照',
  'api.ep.act': '执行单个动作',
  'api.ep.tasks': '任务列表',

  'api.act.lead': '/act 的 body 形如 ',
  'api.act.afterBody':
    '；元素编号取自 /snapshot，编号不存在会被直接拒绝。body 里的 ',
  'api.act.noEffect': '没有任何效力',
  'api.act.tail': '：不可逆动作的授权只能来自应用窗口上的一次人工点击。',

  'api.example.title': '调用示例',
  'api.example.hint': '复制后可直接在终端执行',
  'api.example.copy': '复制 curl',
  'api.example.body':
    '示例用的是列表里第一个环境，可替换成任意 profile id。复制后把 <token> 换成上一步「复制令牌」拿到的那串值。',

  'api.note.lead':
    '只监听 127.0.0.1，局域网访问不到；关闭服务或退出应用后端口立即释放。这限制的是',
  'api.note.who': '谁能连上来',
  'api.note.tail':
    '，不限制连上之后能做什么 —— 能力边界见上方令牌说明。',

  'api.err.readState': '读取本地 API 状态失败',
  'api.err.operation': '操作失败',
  'api.err.port': '端口必须是 1-65535 之间的整数',
  'api.toast.started': '本地 API 已启动',
  'api.toast.stopped': '本地 API 已停止',
  'api.toast.regenerated': '令牌已重新生成，旧令牌立即失效',
  'api.toast.copied': '{label}已复制',
  'api.toast.tokenCopied': '令牌已复制到剪贴板',
  'api.err.copyToken': '复制令牌失败',
  'api.copy.curl': 'curl 命令',

  /* ────────────────────────────── 审计与自检 ────────────────────────────── */
  'audit.title': '审计与自检',
  'audit.subtitle': '在真实页面里核对指纹，并按哈希链校验每一条操作记录',

  'audit.check.title': '指纹一致性自检',
  'audit.check.subtitle': '对照环境配置与页面实际读数，逐项给结论',
  'audit.check.profileAria': '选择要自检的环境',
  'audit.check.noProfiles': '暂无环境',
  'audit.check.runningSuffix': '（运行中）',
  'audit.check.start': '开始自检',
  'audit.check.running': '自检中…',
  'audit.check.needWindow.lead': '自检需要读取页面内的真实值，请先打开 ',
  'audit.check.needWindow.tail': ' 的窗口再开始。',
  'audit.check.failed': '这次自检没有跑完：',
  'audit.check.failedHint': '这不等于自检结果正常，也不等于没有自检过。',
  'audit.check.needProfile': '请先选择一个环境',

  'audit.score.unit': '分',
  'audit.score.consistent': '参数自洽',
  'audit.score.questionable': '存在疑点',
  'audit.score.easilyDetected': '容易被识破',
  'audit.score.breakdown': '通过 {pass} · 注意 {warn} · 失败 {fail} · 共 {total} 项',

  'audit.table.check': '检查项',
  'audit.table.expected': '期望',
  'audit.table.actual': '实际',
  'audit.table.result': '结果',

  'audit.empty.noResult.title': '还没有自检结果',
  'audit.empty.noResult.body':
    '选中一个已打开的环境并开始自检，会逐项比对 UA、时区、屏幕、WebGL、WebRTC、字体等读数，给出这套指纹是否自洽的分数。',

  'audit.severity.pass': '通过',
  'audit.severity.warn': '注意',
  'audit.severity.fail': '失败',

  'audit.log.title': '审计日志',
  'audit.log.subtitle': '按时间顺序追加，每条携带上一条的哈希',
  'audit.verify.running': '校验中…',
  'audit.verify.run': '验证完整性',
  'audit.log.scope.bold': '这里记录的是闸门判定与指纹自检',
  'audit.log.scope.tail':
    '。环境的新建、修改、删除，普通页面操作，以及脚本回放的每一步，都不在这里。',
  'audit.disclaim.title': '无法验证完整性',
  'audit.disclaim.body':
    '：摘要无密钥，整条链可被整体重算。本页能发现「改了内容但没有重算哈希」，以及「整份 / 尾部被删」——后者靠链头锚点（记在设置文件里）核对。',
  'audit.disclaim.total': '共 {n} 条。',
  'audit.verify.failed': '这次校验没有跑完：',
  'audit.verify.failedHint':
    '没有拿到结论，所以现在既不能说它完整，也不能说它断了。可以再点一次「验证完整性」。',
  'audit.verify.badShape': '校验没有返回可读的结论（返回体形状不对）',

  'audit.log.loading': '正在读取审计记录…',
  'audit.log.error.title': '读不到审计记录',
  'audit.log.error.hint':
    '这不等于「没有记录」。文件可能被杀毒软件或索引服务占用，也可能没有读权限。',
  'audit.log.empty.title': '还没有闸门记录',
  'audit.log.empty.body':
    '这个环境还没触发过风险判定，也没跑过自检。跑一次自检，或者让影子执行一个动作，记录就会出现在这里。',

  'audit.log.table.action': '动作',
  'audit.log.table.target': '目标',
  'audit.log.table.hash': '哈希',
  'audit.log.foot':
    '最多显示最近 {n} 条；哈希显示前 8 位，悬停可看完整值与上一条哈希。',
  'audit.log.foot.limit':
    '已到上限，更早的记录没有显示；「验证完整性」统计的是全量。',

  'audit.target.someElement': '某个元素',
  'audit.verdict.cannotDetermine': '无法判断',
  'audit.verdict.consistent': '未发现不一致',
  'audit.verdict.brokenAt': '断在第 {n} 条',
  'audit.fallback.brokenAt':
    '校验在第 {n} 条停下；从这一条起的内容，这次没能证明是完好的。',
  'audit.fallback.unknown':
    '这次没有拿到断点位置，所以既不能说它是完整的，也不能说它断在某一条。',

  'audit.kind.headTruncated.label': '链首缺失',
  'audit.kind.headTruncated.hint':
    '最早的记录不在了。如果记录数没到 5000 条上限，说明链头被删过；校验只能定位到断点，无法还原被删的内容。',
  'audit.kind.seqGap.label': '序号不连续',
  'audit.kind.seqGap.hint':
    '中间有记录被删除。校验能指出断在哪里，但无法还原被删的那几条。',
  'audit.kind.prevMismatch.label': '前序被改动',
  'audit.kind.prevMismatch.hint':
    '这一条指向的上一条哈希对不上，说明它之前的内容被改过或删过。',
  'audit.kind.contentMismatch.label': '内容与哈希不符',
  'audit.kind.contentMismatch.hint':
    '这条记录的内容被改过，但没有重算哈希。这是本页确实能发现的那一类改动。',
  'audit.kind.unreadable.label': '无法判断',
  'audit.kind.unreadable.hint':
    '没读到审计文件的内容，所以这次没能判断链是否完整。这不等于记录损坏，也不等于没有记录。',
  'audit.kind.tailTruncated.label': '尾部对不上',
  'audit.kind.tailTruncated.hint':
    '最后一条和「链头锚点」（记在设置文件里）对不上：可能最新几条被删了，也可能是上次写入中断留下的锚点落后 —— 后者下一次写入会自动对齐，前者不能。',
  'audit.kind.unanchored.label': '锚点刚建立',
  'audit.kind.unanchored.hint':
    '这次之前还没有锚点（旧版本数据，或设置文件被删），所以没法判断尾部有没有被删。已按当前最后一条建立锚点，从下次校验起尾部可验证；此前的记录只能验证「内部是否自洽」。',

  /* ────────────────────────────── 团队与成员 ────────────────────────────── */
  'team.title': '团队与成员',
  'team.subtitle': '本地协作 · 无登录、无云端、零遥测',
  'team.scope.lead': '这是',
  'team.scope.singleMachine': '单机多角色',
  'team.scope.mid':
    '，不是云端多用户：没有账号、没有服务端，数据只落在本机。角色与授权描述的是本机上的权限差异，',
  'team.scope.notCrossDevice': '不构成跨设备鉴权',
  'team.scope.tail':
    '。当前执行路径（agent / 本地 API / 脚本回放）尚未接入这些授权判定。',

  'team.loading': '正在读取本地团队数据…',
  'team.error.title': '读不到团队数据',
  'team.error.hint':
    '这不等于「没有成员 / 没有授权 / 没有动态」。文件可能被占用或没有读权限。',

  'team.members.title': '成员',
  'team.members.subtitle': '本机上的角色分工 · 共 {n} 人',
  'team.members.empty.title': '还没有成员',
  'team.members.empty.body':
    '在下方添加第一位成员。本机所有者会自动存在，用于管理这个工作区。',
  'team.members.table.member': '成员',
  'team.members.table.role': '角色',
  'team.members.table.lastActive': '最近活跃',
  'team.members.lastOwnerTitle':
    '最后一个所有者不可降级、禁用或移除：工作区将无人可管理',
  'team.members.badge.disabled': '已禁用',
  'team.members.roleTitle': '修改这个成员的角色',
  'team.members.roleAria': '修改 {name} 的角色',
  'team.members.restore': '恢复这个成员',
  'team.members.disableHint': '禁用后这个成员无法参与本地协作',
  'team.members.removeTitle': '移除这个成员',
  'team.members.name': '姓名',
  'team.members.nameHint': '姓名会在主进程去除首尾空白并校验，最长 40 字',
  'team.members.namePlaceholder': '例如：本机协作者',
  'team.members.add': '添加成员',

  'team.roles.owner': '所有者',
  'team.roles.admin': '管理员',
  'team.roles.member': '成员',
  'team.roles.viewer': '访客',

  'team.shares.title': '环境授权',
  'team.shares.subtitle': '逐环境分配「使用 / 管理」权限 · 共 {n} 条',
  'team.shares.profilesError': '环境列表读取失败：{message}',
  'team.shares.empty.title': '还没有授权记录',
  'team.shares.empty.body':
    '所有者 / 管理员天然能用所有环境，不需要授权。下方授权是给普通成员 / 访客收口用的。',
  'team.shares.table.profile': '环境',
  'team.shares.table.permission': '权限',
  'team.shares.revokeTitle': '撤销「{member}」对「{profile}」的授权',
  'team.shares.revoke': '撤销',
  'team.shares.noProfiles': '暂无环境',
  'team.shares.noMembers': '暂无可用成员',
  'team.shares.set': '设置授权',

  'team.permissions.use': '使用',
  'team.permissions.manage': '管理',
  'team.permissions.useDesc': '使用（能启动 / 查看）',
  'team.permissions.manageDesc': '管理（能改配置 / 改授权）',

  'team.activity.title': '活动',
  'team.activity.subtitle': '成员与授权的变更记录 · 最新在前 · 共 {n} 条',
  'team.activity.refresh': '刷新动态',
  'team.activity.empty.title': '还没有活动记录',
  'team.activity.empty.body':
    '添加成员、改角色或调整授权后，这里会按时间倒序留下「谁在什么时候改了什么」。',

  'team.remove.title': '移除成员',
  'team.remove.note': '移除会同时清掉这个成员的所有环境授权；此操作不可撤销。',
  'team.remove.confirm': '确认移除',
  'team.remove.body': '将移除成员「{name}」。',
  'team.remove.lastOwner': '这是最后一个所有者，主进程会拒绝该操作。',

  'team.err.needName': '请先填写成员姓名',
  'team.err.needShare': '请选择环境、成员与权限',
  'team.toast.added': '已添加成员「{name}」',
  'team.toast.roleUpdated': '角色已更新',
  'team.toast.disabled': '成员已禁用',
  'team.toast.enabled': '成员已启用',
  'team.toast.removed': '成员已移除',
  'team.toast.shareSet': '授权已设置',
  'team.toast.shareRevoked': '授权已撤销'
}

export const en: Dict = {
  /* ────────────────────────────── Browsing data ────────────────────────────── */
  'data.title': 'Browsing data',
  'data.subtitle':
    'Cookies and history are stored per profile; downloads are a global view. Clearing only affects the selected profile.',
  'data.scope.global': 'Global',
  'data.scope.noProfile': 'No profile selected',
  'data.scope.noProfileShort': 'Not selected',
  'data.selectProfile': 'Select a profile',
  'data.noProfiles': 'No profiles',
  'data.tabsAria': 'Browsing data types',
  'data.tab.cookies': 'Cookies',
  'data.tab.downloads': 'Downloads',
  'data.tab.history': 'History',

  'data.export.netscape': 'Export Netscape',
  'data.export.netscapeTitle':
    'Export in Netscape format — compatible with most browsers and proxy tools',
  'data.export.json': 'Export JSON',
  'data.export.jsonTitle': 'Export as ShadowSurf JSON; it can be imported back',
  'data.import.open': 'Import cookies',
  'data.import.openTitle': 'Import cookies from Netscape text or ShadowSurf JSON',

  'data.clear.cookies': 'Clear profile cookies',
  'data.clear.downloads': 'Clear download history',
  'data.clear.history': 'Clear profile history',

  'data.note.cookies':
    'Cookies are isolated per profile. Import and export only affect the selected profile "{name}"; other profiles are untouched.',

  'data.empty.noProfile.title': 'No profiles available yet',
  'data.empty.noProfile.desc':
    'Cookies and history follow the profile. Create an identity on the Profiles page first, then come back to see what it leaves behind.',
  'data.empty.cookies.title': 'This profile has no cookies yet',
  'data.empty.cookies.desc':
    'Open any site in this profile and sign in once; cookies are written to its own storage partition and are invisible to other profiles.',
  'data.empty.downloads.title': 'No downloads yet',
  'data.empty.downloads.desc':
    'Download a file in any profile and its progress appears here live; records are kept only for this run.',
  'data.empty.history.title': 'This profile has no history yet',
  'data.empty.history.desc':
    'Full-page navigations inside the profile are recorded here; single-page route changes (pushState) are not.',

  'data.loading.cookies': 'Loading cookies…',
  'data.loading.downloads': 'Loading download history…',
  'data.loading.history': 'Loading history…',
  'data.error.cookies': 'Could not read cookies',
  'data.error.downloads': 'Could not read download history',
  'data.error.history': 'Could not read history',
  'data.errHint.cookies':
    'This does not mean there are no cookies. The storage file may be locked by antivirus or an indexing service, or you may lack read permission. We cannot tell right now — do not clear or rebuild anything based on this.',
  'data.errHint.downloads':
    'This does not mean there is no download history. The storage file may be locked by antivirus or an indexing service, or you may lack read permission. We cannot tell right now — do not clear or rebuild anything based on this.',
  'data.errHint.history':
    'This does not mean there is no history. The storage file may be locked by antivirus or an indexing service, or you may lack read permission. We cannot tell right now — do not clear or rebuild anything based on this.',

  'data.table.domain': 'Domain',
  'data.table.value': 'Value',
  'data.table.flags': 'Flags',
  'data.table.expires': 'Expires',
  'data.reveal.show': 'Click to reveal the value',
  'data.reveal.hide': 'Click to hide',
  'data.value.empty': '(empty)',
  'data.flag.session': 'Session',
  'data.sessionEnd': 'End of session',

  'data.download.unnamed': 'Unnamed file',
  'data.download.state.progressing': 'Downloading',
  'data.download.state.completed': 'Completed',
  'data.download.state.cancelled': 'Cancelled',
  'data.download.state.interrupted': 'Interrupted',

  'data.clearModal.cookies.title': 'Clear cookies for this profile',
  'data.clearModal.downloads.title': 'Clear download history',
  'data.clearModal.history.title': 'Clear history for this profile',
  'data.clearModal.cookies.note':
    'After clearing, every site in this profile returns to a signed-out state; other profiles are unaffected.',
  'data.clearModal.downloads.note':
    'Only this list is cleared; downloads in progress are not cancelled.',
  'data.clearModal.history.note':
    "Only this profile's history is deleted; history in other profiles stays as it is.",
  'data.clearModal.cookies.body': 'This will clear {n} cookie(s) for profile "{name}".',
  'data.clearModal.downloads.body': 'This will clear {n} download record(s).',
  'data.clearModal.history.body':
    'This will delete {n} history entries for profile "{name}".',
  'data.clearModal.confirm': 'Clear',

  'data.import.title': 'Import cookies',
  'data.import.note':
    'Import is isolated per profile: these cookies are written only to the selected profile and will not appear in other profiles.',
  'data.import.contentLabel': 'Cookie content',
  'data.import.contentHint':
    'Supports the Netscape cookies.txt format or JSON exported by ShadowSurf. Each line is validated; bad lines are reported individually.',
  'data.import.importing': 'Importing…',
  'data.import.submit': 'Import',
  'data.import.errors': 'View {n} failure reason(s)',
  'data.import.summary.noCookies': 'No cookies to import ({n} could not be parsed).',
  'data.import.summary.failed': 'Imported {imported}; {failed} failed.',
  'data.import.summary.ok': 'Imported {n} — all succeeded.',

  'data.toast.clearedCookies': 'Cleared {n} cookie(s)',
  'data.toast.noCookiesToClear': 'This profile has no cookies to clear',
  'data.toast.clearedDownloads': 'Download history cleared',
  'data.toast.clearedHistory': 'Profile history cleared',
  'data.toast.exported': 'Exported {format} cookies',
  'data.toast.importNoCookies': 'No cookies to import ({n} could not be parsed)',
  'data.toast.importFailed': 'Imported {imported}; {failed} failed',
  'data.toast.imported': 'Imported {imported}',

  'data.warmup.button': 'Cookie warmup',
  'data.warmup.title': 'Cookie warmup',
  'data.warmup.desc':
    'Visits these pages in order so sites can write cookies and browsing history into this profile; each page is left open for 1.5–3 seconds. Up to 30 URLs. A hidden window is used — do not operate the same profile manually while it runs.',
  'data.warmup.urls': 'URL list',
  'data.warmup.urlsPlaceholder': 'https://www.google.com\nhttps://www.youtube.com',
  'data.warmup.run': 'Start warmup',
  'data.warmup.running': 'Warming up…',
  'data.warmup.done': 'Warmup finished: {ok} of {total} succeeded',
  'data.warmup.failedDetail': 'View {n} failure(s)',
  'data.warmup.noProfile': 'Select a profile first',

  /* ────────────────────────────── Local API ────────────────────────────── */
  'api.title': 'Local API',
  'api.subtitle':
    'Runs a REST service on the loopback address; external scripts, CLIs and IDE plugins can use it to drive profiles. {n} profile(s) available.',

  'api.error.title': 'Could not read local API state ≠ stopped',
  'api.loading': 'Reading…',
  'api.running': 'Running',
  'api.stopped': 'Stopped',
  'api.portAria': 'Listen port',
  'api.port.title.running': 'Stop the service before changing the port',
  'api.port.title.idle': 'Listen port; default 7717',
  'api.start': 'Start',
  'api.stop': 'Stop',

  'api.metric.address': 'Listen address',
  'api.metric.port': 'Port',
  'api.metric.requests': 'Requests handled',
  'api.metric.startedAt': 'Started',

  'api.token.title': 'Access token',
  'api.token.requirement':
    'Every request except /health must send Authorization: Bearer <token>',
  'api.scope.lead': 'A local process holding this token can perform actions on ',
  'api.scope.anyProfile': 'any profile',
  'api.scope.afterAny': '. ',
  'api.scope.reversible': 'Reversible actions',
  'api.scope.afterReversible':
    ' (clicking links, scrolling, extracting data) run directly; ',
  'api.scope.irreversible': 'irreversible actions',
  'api.scope.afterIrreversible':
    ' (payment, deletion, publishing, sending) require a native confirmation dialog on this machine — someone must click "Allow" on the spot. Unattended automation stops at that step, then receives a 409 timeout after 120 seconds.',
  'api.scope.br': 'This is not a capability limit; it is by design: ',
  'api.scope.design': 'automation can do the work, but the irreversible step needs a human present.',
  'api.scope.tail':
    ' The token file is readable under the current user, and other programs under the same account can read it too.',

  'api.token.hidden': 'Held in the main process; not shown in the UI',
  'api.token.copy': 'Copy token',
  'api.token.regenerate': 'Regenerate',
  'api.token.regenerate.title.on': 'Revoke the old token and generate a new one',
  'api.token.regenerate.title.off': 'Start the service before regenerating the token',

  'api.hint.lead':
    'The token is a 32-byte random value stored in local-api-token.json in the data directory; it survives app restarts.',
  'api.hint.noShow': ' There is deliberately no "show token" button',
  'api.hint.mid':
    ': this page runs in the renderer, and anything it can display can be read off. "Copy token" writes to the clipboard directly from the main process, so the plaintext never passes through here.',
  'api.hint.regenerate': ' Regenerating is the only remedy',
  'api.hint.tail': ': once the old token is revoked, calls already issued fail immediately.',

  'api.endpoints.title': 'Endpoint reference',
  'api.endpoints.response': 'Returns {ok} on success, {error} on failure',
  'api.ep.health': 'Health check; the only endpoint that requires no auth',
  'api.ep.profiles': 'List profiles',
  'api.ep.launch': 'Launch a profile',
  'api.ep.stop': 'Stop a profile',
  'api.ep.snapshot': 'Page snapshot',
  'api.ep.act': 'Execute a single action',
  'api.ep.tasks': 'List tasks',

  'api.act.lead': 'The /act body looks like ',
  'api.act.afterBody':
    '; element IDs come from /snapshot, and unknown IDs are rejected outright. The ',
  'api.act.noEffect': 'has no effect whatsoever',
  'api.act.tail':
    ': authorization for an irreversible action can only come from a manual click in the app window.',

  'api.example.title': 'Example call',
  'api.example.hint': 'Copy and run it directly in a terminal',
  'api.example.copy': 'Copy curl',
  'api.example.body':
    'The example uses the first profile in the list; replace it with any profile id. After copying, replace <token> with the value you got from "Copy token" above.',

  'api.note.lead':
    'Listens on 127.0.0.1 only, unreachable from the LAN; stopping the service or quitting the app releases the port immediately. This limits ',
  'api.note.who': 'who can connect',
  'api.note.tail':
    ', not what they can do once connected — see the token note above for the capability boundary.',

  'api.err.readState': 'Could not read local API state',
  'api.err.operation': 'Operation failed',
  'api.err.port': 'Port must be an integer between 1 and 65535',
  'api.toast.started': 'Local API started',
  'api.toast.stopped': 'Local API stopped',
  'api.toast.regenerated': 'Token regenerated; the old token is now invalid',
  'api.toast.copied': '{label} copied',
  'api.toast.tokenCopied': 'Token copied to the clipboard',
  'api.err.copyToken': 'Could not copy the token',
  'api.copy.curl': 'curl command',

  /* ────────────────────────────── Audit & self-check ────────────────────────────── */
  'audit.title': 'Audit & self-check',
  'audit.subtitle':
    'Verify fingerprints against the live page and check every operation record against the hash chain',

  'audit.check.title': 'Fingerprint consistency self-check',
  'audit.check.subtitle':
    'Compare the profile configuration with actual page readings, item by item',
  'audit.check.profileAria': 'Select a profile to self-check',
  'audit.check.noProfiles': 'No profiles',
  'audit.check.runningSuffix': ' (running)',
  'audit.check.start': 'Start self-check',
  'audit.check.running': 'Checking…',
  'audit.check.needWindow.lead':
    'A self-check reads real values from inside the page. Open the window for ',
  'audit.check.needWindow.tail': ' first.',
  'audit.check.failed': 'This self-check did not finish: ',
  'audit.check.failedHint':
    'This does not mean the self-check passed, and it does not mean no self-check has run.',
  'audit.check.needProfile': 'Select a profile first',

  'audit.score.unit': 'pts',
  'audit.score.consistent': 'Parameters consistent',
  'audit.score.questionable': 'Questionable',
  'audit.score.easilyDetected': 'Easily detected',
  'audit.score.breakdown':
    'Pass {pass} · Warning {warn} · Fail {fail} · {total} total',

  'audit.table.check': 'Check',
  'audit.table.expected': 'Expected',
  'audit.table.actual': 'Actual',
  'audit.table.result': 'Result',

  'audit.empty.noResult.title': 'No self-check result yet',
  'audit.empty.noResult.body':
    'Select an open profile and start a self-check. It compares UA, timezone, screen, WebGL, WebRTC, font and other readings item by item, and scores whether this fingerprint is internally consistent.',

  'audit.severity.pass': 'Pass',
  'audit.severity.warn': 'Warning',
  'audit.severity.fail': 'Fail',

  'audit.log.title': 'Audit log',
  'audit.log.subtitle':
    'Appended in time order; each record carries the previous record\'s hash',
  'audit.verify.running': 'Verifying…',
  'audit.verify.run': 'Verify integrity',
  'audit.log.scope.bold': 'This log records gate decisions and fingerprint self-checks',
  'audit.log.scope.tail':
    '. Creating, editing or deleting profiles, ordinary page interactions, and every step of script replay are not recorded here.',
  'audit.disclaim.title': 'Integrity cannot be fully verified',
  'audit.disclaim.body':
    ': the digest is unkeyed, so the entire chain can be recomputed. This page can detect "content changed without the hash being recomputed" and "the whole file / the tail was deleted" — the latter is checked against the chain-head anchor stored in the settings file.',
  'audit.disclaim.total': '{n} entries total.',
  'audit.verify.failed': 'This verification did not finish: ',
  'audit.verify.failedHint':
    'No verdict was returned, so right now we can neither call it intact nor say it is broken. You can click "Verify integrity" again.',
  'audit.verify.badShape':
    'Verification did not return a readable verdict (unexpected response shape)',

  'audit.log.loading': 'Loading audit records…',
  'audit.log.error.title': 'Could not read audit records',
  'audit.log.error.hint':
    'This does not mean there are no records. The file may be locked by antivirus or an indexing service, or you may lack read permission.',
  'audit.log.empty.title': 'No gate records yet',
  'audit.log.empty.body':
    'This profile has not triggered a risk decision or run a self-check yet. Run a self-check, or let the Shadow perform an action, and records will appear here.',

  'audit.log.table.action': 'Action',
  'audit.log.table.target': 'Target',
  'audit.log.table.hash': 'Hash',
  'audit.log.foot':
    'Shows the most recent {n} records; hashes show the first 8 characters — hover for the full value and the previous hash.',
  'audit.log.foot.limit':
    'The limit has been reached, so earlier records are not shown; "Verify integrity" covers the full set.',

  'audit.target.someElement': 'some element',
  'audit.verdict.cannotDetermine': 'Cannot determine',
  'audit.verdict.consistent': 'No inconsistencies found',
  'audit.verdict.brokenAt': 'Breaks at entry {n}',
  'audit.fallback.brokenAt':
    'Verification stopped at entry {n}; this run could not prove that anything from that entry onward is intact.',
  'audit.fallback.unknown':
    'This run did not return a break position, so we can neither call the chain complete nor say it breaks at a particular entry.',

  'audit.kind.headTruncated.label': 'Start of chain missing',
  'audit.kind.headTruncated.hint':
    'The earliest records are gone. If the record count is below the 5,000-entry limit, the head of the chain was deleted; verification can locate the break but cannot restore what was deleted.',
  'audit.kind.seqGap.label': 'Sequence gap',
  'audit.kind.seqGap.hint':
    'Records in the middle were deleted. Verification can point to where the break is, but cannot restore the missing entries.',
  'audit.kind.prevMismatch.label': 'Previous link altered',
  'audit.kind.prevMismatch.hint':
    'The previous-entry hash this record points back to does not match, which means the content before this record was altered or deleted.',
  'audit.kind.contentMismatch.label': 'Content/hash mismatch',
  'audit.kind.contentMismatch.hint':
    "This record's content was altered without recomputing its hash. This is the kind of tampering this page can actually detect.",
  'audit.kind.unreadable.label': 'Cannot determine',
  'audit.kind.unreadable.hint':
    'The audit file could not be read, so this run could not determine whether the chain is intact. This does not mean the records are corrupted, and it does not mean there are no records.',
  'audit.kind.tailTruncated.label': 'Tail does not match',
  'audit.kind.tailTruncated.hint':
    'The last record does not match the chain-head anchor (stored in the settings file): either the newest records were deleted, or the anchor is stale from an interrupted write. A stale anchor realigns on the next write; deleted records do not.',
  'audit.kind.unanchored.label': 'Anchor just established',
  'audit.kind.unanchored.hint':
    'There was no anchor before this run (older data, or the settings file was deleted), so whether the tail was deleted cannot be determined. An anchor has now been established from the current last record; the tail becomes verifiable from the next check onward. Earlier records can only be checked for internal consistency.',

  /* ────────────────────────────── Team & members ────────────────────────────── */
  'team.title': 'Team & members',
  'team.subtitle': 'Local collaboration · no sign-in, no cloud, zero telemetry',
  'team.scope.lead': 'This is ',
  'team.scope.singleMachine': 'single-machine, multi-role',
  'team.scope.mid':
    ', not cloud multi-user: there are no accounts, no server, and data stays on this machine. Roles and grants describe permission differences on this machine and ',
  'team.scope.notCrossDevice': 'do not constitute cross-device authentication',
  'team.scope.tail':
    '. Current execution paths (agent / local API / script replay) do not yet enforce these grants.',

  'team.loading': 'Loading local team data…',
  'team.error.title': 'Could not read team data',
  'team.error.hint':
    'This does not mean there are no members / no grants / no activity. The file may be locked or not readable.',

  'team.members.title': 'Members',
  'team.members.subtitle': 'Roles on this machine · {n} member(s)',
  'team.members.empty.title': 'No members yet',
  'team.members.empty.body':
    'Add the first member below. The local owner exists automatically to manage this workspace.',
  'team.members.table.member': 'Member',
  'team.members.table.role': 'Role',
  'team.members.table.lastActive': 'Last active',
  'team.members.lastOwnerTitle':
    'The last owner cannot be demoted, disabled or removed: nobody would be left to manage the workspace',
  'team.members.badge.disabled': 'Disabled',
  'team.members.roleTitle': "Change this member's role",
  'team.members.roleAria': 'Change role for {name}',
  'team.members.restore': 'Restore this member',
  'team.members.disableHint':
    'Once disabled, this member cannot take part in local collaboration',
  'team.members.removeTitle': 'Remove this member',
  'team.members.name': 'Name',
  'team.members.nameHint':
    'The name is trimmed and validated in the main process; up to 40 characters',
  'team.members.namePlaceholder': 'e.g. Local collaborator',
  'team.members.add': 'Add member',

  'team.roles.owner': 'Owner',
  'team.roles.admin': 'Admin',
  'team.roles.member': 'Member',
  'team.roles.viewer': 'Viewer',

  'team.shares.title': 'Profile grants',
  'team.shares.subtitle':
    'Assign "use / manage" permission per profile · {n} grant(s)',
  'team.shares.profilesError': 'Could not read the profile list: {message}',
  'team.shares.empty.title': 'No grants yet',
  'team.shares.empty.body':
    'Owners and admins can use every profile by default and need no grant. The grants below restrict ordinary members and viewers.',
  'team.shares.table.profile': 'Profile',
  'team.shares.table.permission': 'Permission',
  'team.shares.revokeTitle': "Revoke {member}'s grant on {profile}",
  'team.shares.revoke': 'Revoke',
  'team.shares.noProfiles': 'No profiles',
  'team.shares.noMembers': 'No available members',
  'team.shares.set': 'Set grant',

  'team.permissions.use': 'Use',
  'team.permissions.manage': 'Manage',
  'team.permissions.useDesc': 'Use (launch / view)',
  'team.permissions.manageDesc': 'Manage (edit config / grants)',

  'team.activity.title': 'Activity',
  'team.activity.subtitle':
    'Member and grant changes · newest first · {n} entries',
  'team.activity.refresh': 'Refresh activity',
  'team.activity.empty.title': 'No activity yet',
  'team.activity.empty.body':
    'After you add members, change roles or adjust grants, this list records who changed what and when, newest first.',

  'team.remove.title': 'Remove member',
  'team.remove.note':
    'Removing this member also clears all of their profile grants; this cannot be undone.',
  'team.remove.confirm': 'Remove',
  'team.remove.body': 'This will remove member "{name}".',
  'team.remove.lastOwner':
    'This is the last owner; the main process will reject the operation.',

  'team.err.needName': 'Enter a member name first',
  'team.err.needShare': 'Select a profile, member and permission',
  'team.toast.added': 'Added member "{name}"',
  'team.toast.roleUpdated': 'Role updated',
  'team.toast.disabled': 'Member disabled',
  'team.toast.enabled': 'Member enabled',
  'team.toast.removed': 'Member removed',
  'team.toast.shareSet': 'Grant set',
  'team.toast.shareRevoked': 'Grant revoked'
}
