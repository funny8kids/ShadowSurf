/**
 * 标签分组 / 搜索的纯函数。
 *
 * 为什么单独成文件：这些逻辑被双轨窗口的标签条和测试同时消费，但它们本身
 * 不碰 React、不碰 DOM、不碰 electron —— 所以能在 Node 里用 node:test 直接跑。
 * 分组是**渲染层的视觉偏好**（存 localStorage），不是浏览器身份，也不是 IPC
 * 语义；这里的函数只负责把「标签 + 分组映射」整理成可渲染的顺序结构。
 */

/** 参与分组的最小标签形状。BrowserTab 结构上满足它，但不在这里 import 它，保持零依赖。 */
export interface GroupableTab {
  id: string
  title: string
  url: string
  track: 'human' | 'shadow'
}

/** tabId → 组名。缺键或空串表示该标签未分组。 */
export type TabGroupMap = Record<string, string>

/** 组色板：返回的都是 tokens.css 里两套主题都存在的变量名，不写死色值。 */
export const GROUP_COLORS = ['--accent', '--green', '--amber', '--violet', '--blue'] as const
export type GroupColor = (typeof GROUP_COLORS)[number]

/** 分组头节点：点击可折叠 / 展开该组。 */
export interface GroupHeaderItem {
  kind: 'header'
  /** 稳定 key，供 React 列表使用 */
  key: string
  label: string
  color: GroupColor
  count: number
}

/** 标签节点：group 为 null 表示未分组，否则带上所属组名（便于按折叠集合过滤）。 */
export interface GroupTabItem<T extends GroupableTab = GroupableTab> {
  kind: 'tab'
  key: string
  tab: T
  group: string | null
}

export type GroupedItem<T extends GroupableTab = GroupableTab> = GroupHeaderItem | GroupTabItem<T>

/**
 * 组名 → 组色。用 31 进制字符累加做 hash，结果稳定可复现：同一个组名在任何
 * 时候都拿到同一种颜色，不会因为重渲染而变色（视觉分组最忌「颜色乱跳」）。
 */
export function groupColor(groupName: string): GroupColor {
  let hash = 0
  for (let i = 0; i < groupName.length; i += 1) {
    hash = (hash * 31 + groupName.charCodeAt(i)) | 0
  }
  return GROUP_COLORS[(hash >>> 0) % GROUP_COLORS.length]
}

/**
 * 按标题 / URL 做大小写不敏感的子串筛选。
 * 空查询（含纯空白）返回全部标签 —— 搜索框清空即恢复完整列表。
 */
export function filterTabs<T extends GroupableTab>(tabs: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...tabs]
  return tabs.filter(
    (tab) => tab.title.toLowerCase().includes(q) || tab.url.toLowerCase().includes(q)
  )
}

/**
 * 把标签整理成「未分组在前 + 各组成簇」的线性序列。
 *
 * 全量聚簇（同一组的所有标签相邻）而不是只在首次出现处插一个头：
 * 这样点击组头折叠时，隐藏的是一整段连续节点，React 只需按 group 字段过滤，
 * 不需要维护跨节点的归属关系。组的顺序按首个成员的出现顺序决定，稳定不抖。
 */
export function groupTabs<T extends GroupableTab>(
  tabs: readonly T[],
  groups: Readonly<TabGroupMap>
): GroupedItem<T>[] {
  const result: GroupedItem<T>[] = []
  const ungrouped: T[] = []
  // Map 保留插入顺序：组按「首个成员出现」的次序排列
  const clusters = new Map<string, T[]>()

  for (const tab of tabs) {
    const label = (groups[tab.id] ?? '').trim()
    if (!label) {
      ungrouped.push(tab)
      continue
    }
    const members = clusters.get(label)
    if (members) members.push(tab)
    else clusters.set(label, [tab])
  }

  // 未分组标签保持原始相对顺序，不打乱用户熟悉的排列
  for (const tab of ungrouped) {
    result.push({ kind: 'tab', key: tab.id, tab, group: null })
  }

  for (const [label, members] of clusters) {
    result.push({
      kind: 'header',
      key: `group:${label}`,
      label,
      color: groupColor(label),
      count: members.length
    })
    for (const tab of members) {
      result.push({ kind: 'tab', key: tab.id, tab, group: label })
    }
  }

  return result
}
