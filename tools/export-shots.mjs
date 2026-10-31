import { chromium } from 'playwright-core';

const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe'
});
const page = await browser.newPage({ viewport: { width: 1240, height: 900 }, deviceScaleFactor: 2 });
await page.goto('file:///G:/Worker-Space/ShadowSurf/docs/ai-integration.html', { waitUntil: 'networkidle' });
await page.waitForTimeout(500);

// 四张设计稿单独导出（不含图注）
const svgs = await page.$$('.shot svg');
const names = ['ai-panel-1-welcome', 'ai-panel-2-running', 'ai-panel-3-confirm', 'ai-panel-4-settings'];
for (let i = 0; i < svgs.length; i++) {
  await svgs[i].screenshot({ path: `G:/Worker-Space/ShadowSurf/docs/${names[i]}.png` });
  console.log(names[i], 'ok');
}

await browser.close();
