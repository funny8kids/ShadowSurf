import { chromium } from 'playwright-core';
const URL = 'file:///G:/Worker-Space/ShadowSurf/docs/prototype.html';
const OUT = 'G:/Worker-Space/ShadowSurf/docs';
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
const page = await browser.newPage({ viewport: { width: 1280, height: 980 }, deviceScaleFactor: 1.5 });
await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);

const shot = async (name) => {
  await page.waitForTimeout(420);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log('saved', name);
};

// 1 环境列表
await shot('prototype-1-envs');

// 2 指纹配置抽屉
await page.locator('button:has-text("配置")').first().click();
await shot('prototype-2-fingerprint');
await page.keyboard.press('Escape');

// 3 双轨窗口
await page.click('.env');
await shot('prototype-3-dual-track');
await page.keyboard.press('Escape');

// 4 任务与回放
await page.click('[data-view="tasks"]');
await shot('prototype-4-tasks');

await browser.close();
