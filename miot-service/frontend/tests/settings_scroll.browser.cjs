// Run inside browserless/chrome with NODE_PATH=/usr/src/app/node_modules.
// MIOT_TEST_URL points to the built frontend served with its static/ directory.
// CHROME_EXECUTABLE optionally selects an older Chromium (including 103).
// Example from the plugin root (serve the frontend at port 51999 first):
// docker run --rm --network host --entrypoint node -e NODE_PATH=/usr/src/app/node_modules \
//   -e MIOT_TEST_URL=http://127.0.0.1:51999/?embed \
//   -v "$PWD/frontend/tests/settings_scroll.browser.cjs:/tmp/scroll.cjs:ro" \
//   browserless/chrome:latest /tmp/scroll.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const puppeteer = require('puppeteer');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];

async function metrics(page, selector) {
  return page.$eval(selector, (element) => ({
    height: element.clientHeight,
    scrollHeight: element.scrollHeight,
    scrollTop: element.scrollTop,
    bottom: element.getBoundingClientRect().bottom,
  }));
}

async function swipe(page, client, selector) {
  const point = await page.$eval(selector, (element) => {
    const rect = element.getBoundingClientRect();
    return { x: rect.left + 6, y: Math.min(rect.bottom, innerHeight) - 40 };
  });
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  for (let offset = 20; offset <= 240; offset += 20) {
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchMove', touchPoints: [{ x: point.x, y: point.y - offset }],
    });
    await delay(40);
  }
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await delay(400);
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_EXECUTABLE || undefined,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    console.log(JSON.stringify({ browser: await browser.version() }));
    for (const [width, height, safeTop] of [[390, 640, 0], [390, 480, 24], [1024, 768, 24]]) {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.setViewport({ width, height, isMobile: width < 600, hasTouch: true });
      await page.evaluateOnNewDocument(() => {
        window.SongloftPlugin = {
          getTheme: () => 'light', onThemeChange: () => () => {},
          host: { isAvailable: () => true },
          apiGet: async (path) => {
            if (path === '/config') return {};
            if (path.startsWith('/dlna-receiver/config')) return { enabled: false };
            if (path.startsWith('/chat/config')) return { enabled: false, models: [], context_turns: 6 };
            if (path.startsWith('/chat/history')) return { history: [] };
            if (path.startsWith('/chat/status')) return { phase: 'idle' };
            if (path.startsWith('/schedules')) return { enabled: false, tasks: [], logs: [] };
            if (path.startsWith('/voice-commands')) return { enabled: false, commands: [] };
            if (path.startsWith('/memory/stats')) return { entity_count: 0, relation_count: 0, episode_count: 0 };
            if (path.startsWith('/memory/')) return { entities: [], unclassified: [], records: [], stats: {} };
            return [];
          },
        };
      });
      await page.goto(process.env.MIOT_TEST_URL, { waitUntil: 'networkidle0' });
      await page.evaluate((top) => document.documentElement.style.setProperty('--sl-safe-top', `${top}px`), safeTop);
      await page.click('[title="设置"]');
      const client = await page.createCDPSession();

      // Calibrate the same touch input independently before testing app scrolling.
      await page.evaluate(() => {
        const control = document.createElement('div');
        control.id = 'scroll-control';
        control.style.cssText = 'position:fixed;inset:0;z-index:9999;overflow:auto;background:white';
        control.innerHTML = '<div style="height:2000px"></div>';
        document.body.append(control);
      });
      await swipe(page, client, '#scroll-control');
      assert.ok((await metrics(page, '#scroll-control')).scrollTop > 0, 'Touch input calibration failed');
      await page.$eval('#scroll-control', (element) => element.remove());

      for (const category of ['设备', '播放', '语音', 'AI 设置', '定时', '工具箱']) {
        if (width < 600) await page.waitForSelector('.settings-mobile-menu');
        await page.evaluate((title) => {
          Array.from(document.querySelectorAll('.settings-nav-item')).find(
            (element) => element.querySelector('strong').textContent === title,
          ).click();
        }, category);
        await page.waitForSelector('.settings-content');
        await page.waitForFunction((title, narrow) => {
          const heading = document.querySelector(narrow
            ? '.settings-appbar-shell .miot-appbar-title'
            : '.settings-header h1');
          return heading?.textContent.trim() === title;
        }, {}, category, width < 600);
        // Ensure overflow even when fixture accounts/tasks are empty.
        await page.$eval('.settings-content', (element) => {
          element.querySelector('[data-scroll-probe]')?.remove();
          const tail = document.createElement('div');
          tail.dataset.scrollProbe = '';
          tail.style.height = '1200px';
          element.append(tail);
        });
        const before = await metrics(page, '.settings-content');
        await swipe(page, client, '.settings-content');
        const after = await metrics(page, '.settings-content');
        const row = { width, height, safeTop, category, before, after };
        results.push(row);
        console.log(JSON.stringify(row));
        if (process.env.MIOT_TEST_SCREENSHOTS) {
          fs.mkdirSync(process.env.MIOT_TEST_SCREENSHOTS, { recursive: true });
          await page.screenshot({ path: `${process.env.MIOT_TEST_SCREENSHOTS}/${width}-${height}-${category}.png` });
        }
        assert.equal(before.height, height - 56 - safeTop, 'Settings viewport must be bounded by the screen');
        assert.ok(before.bottom <= height + 1, 'Settings content is clipped outside the screen');
        assert.ok(after.scrollTop > before.scrollTop, `${category} must scroll after a touch swipe`);
        if (width < 600) await page.click('.settings-appbar-shell button');
      }
      assert.deepEqual(errors, [], 'Frontend should not throw');
      await page.close();
    }
  } finally {
    if (process.env.MIOT_TEST_REPORT) fs.writeFileSync(process.env.MIOT_TEST_REPORT, JSON.stringify(results, null, 2));
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
