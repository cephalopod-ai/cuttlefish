import { chromium } from './node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';
import fs from 'fs';

const logFile = '/tmp/approval-dashboard-exploration.md';

const log = (msg) => {
  console.log(msg);
  fs.appendFileSync(logFile, msg + '\n');
};

async function main() {
  fs.writeFileSync(logFile, '# Approval Dashboard Exploration\n\n');

  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();

  try {
    log('## Step 1: Loading Dashboard');
    // Try both ports
    let url = 'http://localhost:8888/approvals';
    log(`Loading: ${url}`);

    const response = await page.goto(url, { waitUntil: 'networkidle' });
    log(`Response status: ${response?.status()}`);

    await page.waitForTimeout(2000);

    // Take a screenshot
    await page.screenshot({ path: '/tmp/approvals-full-page.png' });
    log('✓ Screenshot saved: /tmp/approvals-full-page.png\n');

    // Get page content info
    log('## Step 2: Page Structure Analysis');
    const title = await page.title();
    log(`Page title: ${title}`);

    // Check for main content areas
    const mainContent = await page.locator('main, [role="main"]').first();
    if (mainContent) {
      log('✓ Main content area found');
      const mainBox = await mainContent.boundingBox();
      if (mainBox) {
        log(`  Dimensions: ${mainBox.width}x${mainBox.height} at (${mainBox.x}, ${mainBox.y})`);
      }
    }

    // Check sidebar
    const sidebar = await page.locator('[role="complementary"], aside, .sidebar').first();
    if (sidebar) {
      log('✓ Sidebar/complementary area found');
      const sidebarBox = await sidebar.boundingBox();
      if (sidebarBox) {
        log(`  Dimensions: ${sidebarBox.width}x${sidebarBox.height} at (${sidebarBox.x}, ${sidebarBox.y})`);
      }
    }

    // Look for approval cards/bubbles
    log('\n## Step 3: Looking for Approval Items');
    const cards = await page.locator('[class*="card"], [class*="approval"], [class*="bubble"], [role="article"]').all();
    log(`Found ${cards.length} card-like elements`);

    for (let i = 0; i < Math.min(3, cards.length); i++) {
      const card = cards[i];
      const box = await card.boundingBox();
      const text = await card.textContent();
      log(`\nCard ${i+1}:`);
      log(`  Dimensions: ${box?.width.toFixed(0)}x${box?.height.toFixed(0)}`);
      log(`  Text preview: ${text?.substring(0, 100).replace(/\n/g, ' ')}`);

      // Check for text container width issues
      const textElements = await card.locator('p, span, div').all();
      for (let j = 0; j < Math.min(3, textElements.length); j++) {
        const textElem = textElements[j];
        const textBox = await textElem.boundingBox();
        const content = await textElem.textContent();
        if (content && content.length > 0) {
          log(`    Text elem ${j}: width=${textBox?.width.toFixed(0)}, text="${content.substring(0, 50)}"`);
        }
      }
    }

    // Look for layout issues
    log('\n## Step 4: Checking for Layout Issues');

    // Check if any text is overflowing
    const allTextElements = await page.locator('p, span, div').all();
    let overflowCount = 0;

    for (let elem of allTextElements.slice(0, 50)) {
      try {
        const box = await elem.boundingBox();
        const scrollSize = await elem.evaluate(el => ({
          scrollWidth: el.scrollWidth,
          scrollHeight: el.scrollHeight,
          clientWidth: el.clientWidth,
          clientHeight: el.clientHeight
        }));

        if (scrollSize.scrollWidth > scrollSize.clientWidth) {
          overflowCount++;
          if (overflowCount <= 3) {
            const text = await elem.textContent();
            log(`  ⚠️ Horizontal overflow: "${text?.substring(0, 50)}" (${scrollSize.clientWidth} vs ${scrollSize.scrollWidth})`);
          }
        }
      } catch (e) {
        // skip elements that can't be evaluated
      }
    }

    if (overflowCount > 3) {
      log(`  ... and ${overflowCount - 3} more overflow issues`);
    }

    // Check viewport issues
    log('\n## Step 5: Viewport and Responsive Layout');
    const viewport = page.viewportSize();
    log(`Current viewport: ${viewport?.width}x${viewport?.height}`);

    // Get computed styles for main content areas
    const mainComputedStyle = await page.locator('main, [role="main"]').first().evaluate(el => {
      const styles = window.getComputedStyle(el);
      return {
        width: styles.width,
        maxWidth: styles.maxWidth,
        padding: styles.padding,
        marginLeft: styles.marginLeft,
        marginRight: styles.marginRight,
        display: styles.display,
        overflow: styles.overflow
      };
    }).catch(() => null);

    if (mainComputedStyle) {
      log('\nMain content computed styles:');
      Object.entries(mainComputedStyle).forEach(([key, value]) => {
        log(`  ${key}: ${value}`);
      });
    }

    // Screenshot of right sidebar area specifically
    log('\n## Step 6: Right Sidebar Focus');
    const rightSidebar = await page.locator('aside, [role="complementary"]').last();
    const sidebarBounds = await rightSidebar.boundingBox();
    if (sidebarBounds) {
      await page.screenshot({
        path: '/tmp/approvals-right-sidebar.png',
        clip: sidebarBounds
      });
      log(`✓ Right sidebar screenshot saved (${sidebarBounds.width}x${sidebarBounds.height})`);
    }

    log('\n✓ Exploration complete');

  } catch (error) {
    log(`\n❌ Error: ${error.message}`);
    await page.screenshot({ path: '/tmp/approvals-error.png' });
  } finally {
    await browser.close();
    log(`\n📝 Full log saved to: ${logFile}`);
  }
}

main();
