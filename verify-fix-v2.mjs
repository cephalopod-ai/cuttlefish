import { chromium } from './node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';

async function main() {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  try {
    console.log('Loading approval dashboard (version 2)...');
    await page.goto('http://localhost:8888/approvals', { waitUntil: 'networkidle' });

    console.log('Waiting for page to fully render...');
    await page.waitForTimeout(3000);

    console.log('Taking screenshot...');
    await page.screenshot({ path: '/tmp/approval-dashboard-v2.png' });
    console.log('✓ Screenshot saved: /tmp/approval-dashboard-v2.png');

    console.log('\nPage loaded successfully. Browser will stay open for 60 seconds for inspection.');

    // Keep browser open for inspection
    await page.waitForTimeout(60000);

  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await browser.close();
  }
}

main();
