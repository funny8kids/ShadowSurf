/**
 * ShadowSurf · background service worker
 *
 * 职责刻意保持很薄：
 *   1. 让点击工具栏图标直接打开侧边栏
 *   2. 转发「页面已变化」这类广播（侧边栏可能没在前台）
 *
 * Agent 循环跑在侧边栏里，不放在这里 —— MV3 的 service worker 会被
 * 空闲回收，长任务放进来会莫名其妙中断。侧边栏只要开着就一直活着，
 * 生命周期可预期，调试也简单。
 */

const enablePanelOnActionClick = () => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.warn('[ShadowSurf] setPanelBehavior failed:', err));
};

chrome.runtime.onInstalled.addListener(enablePanelOnActionClick);
chrome.runtime.onStartup.addListener(enablePanelOnActionClick);
enablePanelOnActionClick();

// 页面导航时通知侧边栏，让 UI 上的地址显示保持同步
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url && changeInfo.status !== 'complete') return;
  chrome.runtime
    .sendMessage({ type: 'SS_TAB_UPDATED', tabId, url: changeInfo.url })
    .catch(() => {
      /* 侧边栏没开，正常 */
    });
});
