import { chromium } from './node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';
import fs from 'fs';

async function main() {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

  try {
    console.log('Loading approval dashboard...');
    await page.goto('http://localhost:8888/approvals', { waitUntil: 'networkidle' });

    // Wait for content to load
    await page.waitForTimeout(2000);

    // Take full page screenshot
    await page.screenshot({ path: '/tmp/approvals-dashboard.png' });
    console.log('✓ Saved: /tmp/approvals-dashboard.png');

    // Get info about the main content area and Actions box
    const actionsBox = await page.locator('text=Actions').first().boundingBox();
    if (actionsBox) {
      console.log(`\nActions header bounding box: ${JSON.stringify(actionsBox)}`);
    }

    // Get text styling info
    const actionCodeBlock = await page.locator('[class*="action"], code, pre').first().evaluate(el => {
      const styles = window.getComputedStyle(el);
      return {
        width: styles.width,
        maxWidth: styles.maxWidth,
        overflowX: styles.overflowX,
        overflowY: styles.overflowY,
        wordWrap: styles.wordWrap,
        whiteSpace: styles.whiteSpace,
        paddingLeft: styles.paddingLeft,
        paddingRight: styles.paddingRight,
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
      };
    }).catch(() => null);

    if (actionCodeBlock) {
      console.log('\nActions code block styles:');
      Object.entries(actionCodeBlock).forEach(([k, v]) => {
        console.log(`  ${k}: ${v}`);
      });
    }

    // Check the sidebar items
    const pendingItems = await page.locator('[class*="pending"], text=PENDING').count();
    console.log(`\nPending items visible: ${pendingItems}`);

    // Get sidebar width
    const sidebar = await page.locator('aside, [role="complementary"]').first();
    const sidebarBox = await sidebar.boundingBox();
    if (sidebarBox) {
      console.log(`Sidebar dimensions: ${sidebarBox.width}x${sidebarBox.height}`);
    }

    // Get main content width
    const main = await page.locator('main, [role="main"]').first();
    const mainBox = await main.boundingBox();
    if (mainBox) {
      console.log(`Main content dimensions: ${mainBox.width}x${mainBox.height}`);
    }

    // Specifically look at text widths in the approval cards
    const textElements = await page.locator('main p, main span, main div').all();
    console.log(`\nAnalyzing text elements in main content...`);

    let narrowCount = 0;
    for (let i = 0; i < Math.min(20, textElements.length); i++) {
      const elem = textElements[i];
      const scroll = await elem.evaluate(e => ({
        scrollWidth: e.scrollWidth,
        clientWidth: e.clientWidth,
        textContent: e.textContent?.substring(0, 40)
      })).catch(() => null);

      if (scroll && scroll.scrollWidth > scroll.clientWidth + 5) {
        narrowCount++;
        if (narrowCount <= 5) {
          console.log(`  ${i}: Overflow - ${scroll.clientWidth}/${scroll.scrollWidth} - "${scroll.textContent}"`);
        }
      }
    }

    if (narrowCount > 5) {
      console.log(`  ... and ${narrowCount - 5} more text overflow issues`);
    }

    console.log('\n✓ Analysis complete');

  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await browser.close();
  }
}

main();
