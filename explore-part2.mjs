import { chromium } from '/home/ericl/Work/vscode/public_share/cuttlefish/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';
import fs from 'fs';
import path from 'path';

const SCREENSHOTS_DIR = '/tmp/screenshots';
fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

let screenshotCount = 200;
const consoleErrors = [];
const networkErrors = [];
const allFindings = [];

async function shot(page, name) {
  screenshotCount++;
  const filename = `${screenshotCount}-${name}.png`;
  const filepath = path.join(SCREENSHOTS_DIR, filename);
  await page.screenshot({ path: filepath, fullPage: false });
  return filename;
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function record(section, action, result, issues = []) {
  allFindings.push({ section, action, result, issues });
  const issueStr = issues.length ? `\n  !! ISSUE: ${issues.join('; ')}` : '';
  console.log(`  [${section}] ${action}: ${result}${issueStr}`);
}

async function main() {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });

  async function newPage() {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on('console', msg => {
      if (msg.type() === 'error') {
        consoleErrors.push({ url: page.url(), text: msg.text() });
      }
    });
    page.on('pageerror', err => {
      consoleErrors.push({ url: page.url(), text: `PAGE ERROR: ${err.message}` });
    });
    return page;
  }

  // =============================================
  // HR PAGE
  // =============================================
  console.log('\n=== HR Page ===');
  {
    const page = await newPage();
    try {
      await page.goto('http://localhost:8888/hr', { waitUntil: 'domcontentloaded', timeout: 10000 });
      await sleep(2000);
      const s = await shot(page, 'hr-initial');
      record('HR', 'HR page loaded', `Screenshot: ${s}`);

      const hrText = await page.evaluate(() => document.body.innerText);
      console.log('HR text (first 800):', hrText.substring(0, 800));
      record('HR', 'HR page content summary', hrText.substring(200, 600).trim());

      // Check tabs
      const tabs = await page.$$('[role="tab"], button[class*="tab"]');
      for (const tab of tabs) {
        const txt = await tab.evaluate(el => el.textContent?.trim());
        if (txt) console.log('  HR Tab:', txt);
      }

      // Click each tab
      const tabBtns = await page.$$('button');
      const btnTexts = await Promise.all(tabBtns.map(b => b.evaluate(el => el.textContent?.trim())));
      const hrTabNames = btnTexts.filter(t => ['Chat', 'Org changes', 'Retired'].includes(t));
      console.log('HR tab buttons:', hrTabNames);

      // Click "Org changes" tab
      const orgChangesTab = await page.$('button:has-text("Org changes")');
      if (orgChangesTab) {
        await orgChangesTab.click();
        await sleep(800);
        await shot(page, 'hr-org-changes-tab');
        const content = await page.evaluate(() => document.body.innerText.substring(200, 800));
        record('HR', 'Org changes tab', content.trim().substring(0, 200));
      }

      // Click "Retired" tab
      const retiredTab = await page.$('button:has-text("Retired")');
      if (retiredTab) {
        await retiredTab.click();
        await sleep(800);
        await shot(page, 'hr-retired-tab');
        const content = await page.evaluate(() => document.body.innerText.substring(200, 600));
        record('HR', 'Retired tab', content.trim().substring(0, 200));
      }

      record('HR', 'Navigation', 'HR page at /hr is NOT in main nav bar', ['HR page (/hr) hidden from main navigation - not accessible without knowing URL']);
    } catch(e) {
      record('HR', 'HR page', `Error: ${e.message}`, [`HR page error: ${e.message}`]);
    } finally {
      await page.close();
    }
  }

  // =============================================
  // SKILLS PAGE
  // =============================================
  console.log('\n=== Skills Page ===');
  {
    const page = await newPage();
    try {
      await page.goto('http://localhost:8888/skills', { waitUntil: 'domcontentloaded', timeout: 10000 });
      await sleep(2000);
      const s = await shot(page, 'skills-initial');
      record('Skills', 'Skills page loaded', `Screenshot: ${s}`);

      const skillsText = await page.evaluate(() => document.body.innerText);
      console.log('Skills text:', skillsText.substring(0, 1200));
      record('Skills', 'Skills content', skillsText.substring(200, 600).trim());

      // Look for skill items / installed skills
      const skillCards = await page.$$('[class*="skill"], [class*="Skill"]');
      console.log(`Skill card elements: ${skillCards.length}`);

      // Find all buttons on skills page
      const btns = await page.$$('button');
      const btnTxts = await Promise.all(btns.map(b => b.evaluate(el => ({ text: el.textContent?.trim(), visible: el.offsetParent !== null }))));
      const visibleBtns = btnTxts.filter(b => b.visible && b.text);
      console.log('Skills buttons:', visibleBtns.map(b => b.text));

      // Try to click on any "Add" or "Install" button
      const addBtn = await page.$('button:has-text("Add skill")') ||
                     await page.$('button:has-text("Add")') ||
                     await page.$('button:has-text("Install")') ||
                     await page.$('button:has-text("+")');

      if (addBtn) {
        const btnTxt = await addBtn.evaluate(el => el.textContent?.trim());
        record('Skills', `Found add button: "${btnTxt}"`, 'Button exists');
        await addBtn.click();
        await sleep(1000);
        await shot(page, 'skills-add-clicked');

        const dialog = await page.$('[role="dialog"], [class*="modal"], [class*="Modal"], [class*="dialog"], [class*="Dialog"]');
        if (dialog) {
          const dialogContent = await dialog.evaluate(el => el.textContent?.substring(0, 500));
          console.log('Skills dialog:', dialogContent);
          record('Skills', 'Add skill dialog content', dialogContent?.substring(0, 200));

          const inputs = await dialog.$$('input, textarea');
          for (const inp of inputs) {
            const ph = await inp.getAttribute('placeholder') || '';
            const nm = await inp.getAttribute('name') || '';
            try {
              if (ph.toLowerCase().includes('name') || nm === 'name') {
                await inp.fill('Data Analysis Pro');
              } else if (ph.toLowerCase().includes('desc')) {
                await inp.fill('Advanced data analysis and visualization');
              } else if (ph.toLowerCase().includes('url') || ph.toLowerCase().includes('npm')) {
                await inp.fill('https://github.com/example/data-analysis');
              }
            } catch(e) {}
          }

          await shot(page, 'skills-add-filled');

          const submitBtn = await dialog.$('button[type="submit"]') ||
                            await dialog.$('button:has-text("Add")') ||
                            await dialog.$('button:has-text("Install")') ||
                            await dialog.$('button:has-text("Save")');
          if (submitBtn) {
            const enabled = await submitBtn.isEnabled();
            const txt = await submitBtn.evaluate(el => el.textContent?.trim());
            record('Skills', `Submit button "${txt}"`, `enabled=${enabled}`);
            if (enabled) {
              await submitBtn.click();
              await sleep(1500);
              await shot(page, 'skills-after-add');
              record('Skills', 'Submit add skill', 'Submitted');
            }
          } else {
            record('Skills', 'Add skill dialog submit', 'No submit button found', ['Add skill dialog has no submit button']);
          }

          // Close
          await page.keyboard.press('Escape');
          await sleep(500);
        } else {
          // Maybe the UI expanded inline rather than dialog
          await shot(page, 'skills-add-no-dialog');
          record('Skills', 'Add skill dialog', 'No dialog appeared after clicking add', ['Add skill may use inline form rather than dialog']);
        }
      } else {
        record('Skills', 'Add skill button', 'No add/install button found', ['Cannot find way to add new skills']);
      }

      await shot(page, 'skills-final');
    } catch(e) {
      record('Skills', 'Skills page', `Error: ${e.message}`, [`Skills error: ${e.message}`]);
    } finally {
      await page.close();
    }
  }

  // =============================================
  // LIMITS PAGE
  // =============================================
  console.log('\n=== Limits Page ===');
  {
    const page = await newPage();
    try {
      await page.goto('http://localhost:8888/limits', { waitUntil: 'domcontentloaded', timeout: 10000 });
      await sleep(2000);
      const s = await shot(page, 'limits-initial');
      record('Limits', 'Limits page loaded', `Screenshot: ${s}`);

      const limitsText = await page.evaluate(() => document.body.innerText);
      console.log('Limits text (first 1500):', limitsText.substring(200, 1700));
      record('Limits', 'Limits page content', limitsText.substring(200, 600).trim());

      // Find inputs and their labels
      const limitInputs = await page.$$('input');
      console.log(`Found ${limitInputs.length} inputs`);
      for (const inp of limitInputs) {
        const val = await inp.inputValue();
        const nm = await inp.getAttribute('name') || '';
        const ph = await inp.getAttribute('placeholder') || '';
        const type = await inp.getAttribute('type') || 'text';
        const label = await inp.evaluate(el => {
          const parent = el.closest('label') || el.parentElement?.parentElement;
          return parent?.querySelector('label, span, p')?.textContent?.trim() || '';
        });
        console.log(`  Input: type=${type}, name="${nm}", ph="${ph}", val="${val}", label="${label}"`);
      }

      // Find sliders/ranges
      const ranges = await page.$$('input[type="range"]');
      record('Limits', 'Range sliders', `Found ${ranges.length}`);

      // Try editing a number input
      const numberInputs = await page.$$('input[type="number"]');
      if (numberInputs.length > 0) {
        const ni = numberInputs[0];
        const oldVal = await ni.inputValue();
        await ni.click({ clickCount: 3 });
        await ni.fill('50');
        await sleep(300);
        const newVal = await ni.inputValue();
        record('Limits', 'Edit number input', `Changed "${oldVal}" to "${newVal}"`);

        const saveBtn = await page.$('button:has-text("Save"), button:has-text("Apply"), button:has-text("Update"), button[type="submit"]');
        if (saveBtn) {
          record('Limits', 'Save button found', 'Limits changes require save button click');
          await saveBtn.click();
          await sleep(500);
          await shot(page, 'limits-saved');
        } else {
          record('Limits', 'Auto-save limits', 'No save button - likely auto-save on limits page');
        }
      }

      // Check for tabs/sections
      const tabs = await page.$$('[role="tab"]');
      record('Limits', 'Limit tabs/sections', `${tabs.length} tabs found`);

    } catch(e) {
      record('Limits', 'Limits page', `Error: ${e.message}`, [`Limits error: ${e.message}`]);
    } finally {
      await page.close();
    }
  }

  // =============================================
  // APPROVALS PAGE
  // =============================================
  console.log('\n=== Approvals Page ===');
  {
    const page = await newPage();
    try {
      await page.goto('http://localhost:8888/approvals', { waitUntil: 'domcontentloaded', timeout: 10000 });
      await sleep(2000);
      const s = await shot(page, 'approvals-initial');
      record('Approvals', 'Approvals page loaded', `Screenshot: ${s}`);

      const appText = await page.evaluate(() => document.body.innerText);
      console.log('Approvals text:', appText.substring(200, 2000));
      record('Approvals', 'Approvals content', appText.substring(200, 600).trim());

      // Count pending items
      const pendingItems = await page.$$('[class*="pending"], [class*="Pending"]');
      console.log(`Pending item elements: ${pendingItems.length}`);

      // Find all buttons
      const btns = await page.$$('button');
      const btnInfos = await Promise.all(btns.map(async b => ({
        text: await b.evaluate(el => el.textContent?.trim()),
        visible: await b.isVisible(),
        enabled: await b.isEnabled()
      })));
      const visibleBtns = btnInfos.filter(b => b.visible && b.text);
      console.log('Approval buttons:', visibleBtns.map(b => `"${b.text}" (enabled=${b.enabled})`));
      record('Approvals', 'Available action buttons', `Buttons: ${visibleBtns.map(b => b.text).join(', ')}`);

      // Look for approval items and check their structure
      const approvalDivs = await page.$$('[class*="approval" i], [class*="checkpoint" i], [class*="decision" i]');
      console.log(`Approval divs: ${approvalDivs.length}`);

      // Get text of first 3 approval items
      for (let i = 0; i < Math.min(3, approvalDivs.length); i++) {
        const txt = await approvalDivs[i].evaluate(el => el.textContent?.substring(0, 200));
        console.log(`  Approval item ${i}:`, txt);
      }

      // Try clicking on an approval to expand it
      const firstApproval = approvalDivs[0];
      if (firstApproval) {
        await firstApproval.click();
        await sleep(800);
        await shot(page, 'approvals-item-expanded');
        record('Approvals', 'Click first approval item', 'Interaction attempted');
      }

      // Check for approve/deny/allow/block buttons
      const allowBtn = await page.$('button:has-text("Allow")');
      const blockBtn = await page.$('button:has-text("Block")');
      const approveBtn = await page.$('button:has-text("Approve")');
      const denyBtn = await page.$('button:has-text("Deny")');

      record('Approvals', 'Allow/Block buttons', `Allow=${!!allowBtn}, Block=${!!blockBtn}, Approve=${!!approveBtn}, Deny=${!!denyBtn}`);

      if (allowBtn) {
        const allowText = await allowBtn.evaluate(el => el.textContent?.trim());
        record('Approvals', 'Allow button text', `"${allowText}"`);
        // Try clicking allow on first item
        await allowBtn.click();
        await sleep(1500);
        await shot(page, 'approvals-after-allow');
        record('Approvals', 'Click Allow on approval', 'Clicked Allow button');

        // Check for any confirmation dialog
        const confirmDialog = await page.$('[role="alertdialog"], [role="dialog"]');
        if (confirmDialog) {
          const dialogText = await confirmDialog.evaluate(el => el.textContent?.substring(0, 300));
          record('Approvals', 'Confirmation dialog after allow', dialogText?.substring(0, 150));
          await shot(page, 'approvals-confirm-dialog');

          // Confirm
          const confirmBtn = await confirmDialog.$('button:has-text("Confirm"), button:has-text("Yes"), button:has-text("Allow")');
          if (confirmBtn) {
            await confirmBtn.click();
            await sleep(1000);
          } else {
            await page.keyboard.press('Escape');
          }
        }
      }

      const s2 = await shot(page, 'approvals-final');
      record('Approvals', 'Approvals final', `Screenshot: ${s2}`);

    } catch(e) {
      record('Approvals', 'Approvals page', `Error: ${e.message}`, [`Approvals error: ${e.message}`]);
    } finally {
      await page.close();
    }
  }

  // =============================================
  // ARCHIVE PAGE
  // =============================================
  console.log('\n=== Archive Page ===');
  {
    const page = await newPage();
    try {
      await page.goto('http://localhost:8888/archive', { waitUntil: 'domcontentloaded', timeout: 10000 });
      await sleep(2000);
      const s = await shot(page, 'archive-initial');
      record('Archive', 'Archive page loaded', `Screenshot: ${s}`);

      const archiveText = await page.evaluate(() => document.body.innerText);
      console.log('Archive text:', archiveText.substring(200, 1000));
      record('Archive', 'Archive content', archiveText.substring(200, 500).trim());

      // Check for any archive items or projects
      const archiveItems = await page.$$('[class*="archive"], [class*="Archive"], [class*="project"]');
      console.log(`Archive items: ${archiveItems.length}`);

      if (archiveItems.length > 0) {
        await archiveItems[0].click();
        await sleep(500);
        await shot(page, 'archive-item-clicked');
        record('Archive', 'Click archive item', 'Item clicked');
      } else {
        record('Archive', 'Archive items', 'No archive items found (may be empty)');
      }
    } catch(e) {
      record('Archive', 'Archive page', `Error: ${e.message}`, [`Archive error: ${e.message}`]);
    } finally {
      await page.close();
    }
  }

  // =============================================
  // CRON PAGE - Deep dive
  // =============================================
  console.log('\n=== Cron Page Deep Dive ===');
  {
    const page = await newPage();
    try {
      await page.goto('http://localhost:8888/cron', { waitUntil: 'domcontentloaded', timeout: 10000 });
      await sleep(2000);
      const s = await shot(page, 'cron-initial');
      record('Cron', 'Cron page loaded', `Screenshot: ${s}`);

      const cronText = await page.evaluate(() => document.body.innerText);
      console.log('Cron text:', cronText.substring(200, 1500));
      record('Cron', 'Cron page content', cronText.substring(200, 500).trim());

      // Find all buttons
      const btns = await page.$$('button');
      const btnInfos = await Promise.all(btns.map(async b => ({
        text: await b.evaluate(el => el.textContent?.trim()),
        visible: await b.isVisible()
      })));
      console.log('Cron buttons:', btnInfos.filter(b => b.visible && b.text).map(b => `"${b.text}"`));

      // Click "Schedule" button and investigate
      const scheduleBtn = await page.$('button:has-text("Schedule")');
      if (scheduleBtn) {
        await scheduleBtn.click();
        await sleep(1500);
        await shot(page, 'cron-after-schedule-click');

        const pageState = await page.evaluate(() => document.body.innerText.substring(200, 1000));
        console.log('After schedule click:', pageState.substring(0, 500));
        record('Cron', 'Click Schedule button', pageState.substring(0, 200));

        // Check if a form/dialog appeared or if page changed
        const dialog = await page.$('[role="dialog"]');
        const form = await page.$('form');
        if (dialog) {
          record('Cron', 'Schedule dialog', 'Dialog appeared');
          const dialogText = await dialog.evaluate(el => el.textContent?.substring(0, 500));
          console.log('Dialog:', dialogText);

          // Fill form
          const nameInp = await dialog.$('input[placeholder*="name" i], input[name="name"]');
          if (nameInp) await nameInp.fill('Daily Status Report');

          const cronInp = await dialog.$('input[placeholder*="cron" i], input[placeholder*="expression" i], input[placeholder*="schedule" i]');
          if (cronInp) await cronInp.fill('0 9 * * 1-5');

          await shot(page, 'cron-schedule-filled');

          const submitBtn = await dialog.$('button[type="submit"]') ||
                            await dialog.$('button:has-text("Create")') ||
                            await dialog.$('button:has-text("Save")') ||
                            await dialog.$('button:has-text("Schedule")');
          if (submitBtn) {
            const enabled = await submitBtn.isEnabled();
            record('Cron', 'Schedule form submit button', `enabled=${enabled}`);
            if (enabled) {
              await submitBtn.click();
              await sleep(1500);
              await shot(page, 'cron-after-create');
              record('Cron', 'Submit cron job', 'Submitted');
            }
          }

          await page.keyboard.press('Escape');
          await sleep(500);
        } else if (form) {
          record('Cron', 'Schedule form', 'Form appeared');
          await shot(page, 'cron-form-visible');
        } else {
          // Maybe UI navigation
          const newUrl = page.url();
          record('Cron', 'Schedule button effect', `No dialog/form - URL: ${newUrl}`, ['Cron Schedule button shows no dialog or form']);
        }
      } else {
        record('Cron', 'Schedule button', 'Not found on cron page', ['No Schedule button found']);
      }
    } catch(e) {
      record('Cron', 'Cron page', `Error: ${e.message}`, [`Cron error: ${e.message}`]);
    } finally {
      await page.close();
    }
  }

  // =============================================
  // SETTINGS PAGE - Deep dive
  // =============================================
  console.log('\n=== Settings Page Deep Dive ===');
  {
    const page = await newPage();
    try {
      await page.goto('http://localhost:8888/settings', { waitUntil: 'domcontentloaded', timeout: 10000 });
      await sleep(2000);
      const s = await shot(page, 'settings-full');
      record('Settings', 'Settings page loaded', `Screenshot: ${s}`);

      // Scroll to see all settings
      await page.evaluate(() => window.scrollTo(0, 500));
      await sleep(300);
      await shot(page, 'settings-scroll1');
      await page.evaluate(() => window.scrollTo(0, 1200));
      await sleep(300);
      await shot(page, 'settings-scroll2');
      await page.evaluate(() => window.scrollTo(0, 2000));
      await sleep(300);
      await shot(page, 'settings-scroll3');
      await page.evaluate(() => window.scrollTo(0, 3000));
      await sleep(300);
      await shot(page, 'settings-scroll4');

      const fullText = await page.evaluate(() => document.body.innerText);
      console.log('Full settings text:', fullText.substring(200, 3000));

      // Look at toggle switches specifically
      const switches = await page.$$('[role="switch"]');
      console.log(`Found ${switches.length} switches`);

      for (let i = 0; i < switches.length; i++) {
        const sw = switches[i];
        const label = await sw.evaluate(el => {
          const parent = el.closest('label, [class*="setting"], [class*="row"]') ||
                         el.parentElement?.parentElement;
          const labelEl = parent?.querySelector('span, label, p, h3, h4') ||
                          el.previousElementSibling ||
                          el.parentElement?.previousElementSibling;
          return labelEl?.textContent?.trim().substring(0, 80) || el.getAttribute('aria-label') || `switch-${i}`;
        });
        const checked = await sw.evaluate(el => el.getAttribute('aria-checked') === 'true' || el.checked);
        console.log(`  Switch ${i}: "${label}" = ${checked}`);
      }

      // Try toggling the first switch
      if (switches.length > 0) {
        const sw = switches[0];
        const before = await sw.evaluate(el => el.getAttribute('aria-checked') === 'true');
        await sw.click();
        await sleep(500);
        const after = await sw.evaluate(el => el.getAttribute('aria-checked') === 'true');
        record('Settings', 'Toggle first switch', `Changed from ${before} to ${after}`);
      }

      // Look for specific settings sections
      const headings = await page.$$('h2, h3, h4, [class*="heading"], [class*="section-title"]');
      const headingTexts = await Promise.all(headings.map(h => h.textContent()));
      console.log('Settings headings:', headingTexts.map(t => t?.trim()).filter(Boolean));
      record('Settings', 'Settings headings/sections', headingTexts.map(t => t?.trim()).filter(Boolean).join(', '));

      // Try filling a text input (Portal Name)
      await page.evaluate(() => window.scrollTo(0, 0));
      await sleep(300);

      const portalNameInput = await page.$('input[placeholder*="Portal Name" i]') ||
                              await page.$('input[value*="Cuttlefish" i]');
      if (portalNameInput) {
        const currentVal = await portalNameInput.inputValue();
        record('Settings', 'Portal Name field value', `"${currentVal}"`);
      }

      // Check "Create pairing code" button
      const pairingBtn = await page.$('button:has-text("Create pairing code"), button:has-text("Pairing")');
      if (pairingBtn) {
        record('Settings', 'Pairing code button', 'Found - device pairing feature exists');
        await pairingBtn.click();
        await sleep(1500);
        await shot(page, 'settings-pairing-code');
        const pairingContent = await page.evaluate(() => document.body.innerText.substring(200, 800));
        console.log('After pairing click:', pairingContent.substring(0, 300));
        record('Settings', 'Create pairing code', pairingContent.substring(0, 200));
      }

      // Check email inbox configuration
      const addInboxBtn = await page.$('button:has-text("Add inbox")');
      if (addInboxBtn) {
        await addInboxBtn.click();
        await sleep(1000);
        await shot(page, 'settings-add-inbox');
        const inboxDialog = await page.$('[role="dialog"]');
        if (inboxDialog) {
          const inboxContent = await inboxDialog.evaluate(el => el.textContent?.substring(0, 400));
          console.log('Add inbox dialog:', inboxContent);
          record('Settings', 'Add inbox dialog', inboxContent?.substring(0, 200));

          await page.keyboard.press('Escape');
          await sleep(300);
        } else {
          record('Settings', 'Add inbox', 'No dialog opened after clicking Add inbox', ['Add inbox button may not open dialog']);
        }
      }

      await shot(page, 'settings-final');

    } catch(e) {
      record('Settings', 'Settings page', `Error: ${e.message}`, [`Settings error: ${e.message}`]);
    } finally {
      await page.close();
    }
  }

  // =============================================
  // ORG PAGE - More detailed interaction
  // =============================================
  console.log('\n=== Org Page Detailed ===');
  {
    const page = await newPage();
    try {
      await page.goto('http://localhost:8888/org', { waitUntil: 'domcontentloaded', timeout: 10000 });
      await sleep(2000);
      await shot(page, 'org-detailed');

      // Try clicking "Add agent" button and look carefully at what happens
      const addAgentBtn = await page.$('button:has-text("Add agent")');
      if (addAgentBtn) {
        console.log('Clicking Add agent...');
        await addAgentBtn.click();
        await sleep(1500);
        await shot(page, 'org-add-agent-after-click');

        const bodyContent = await page.evaluate(() => document.body.innerHTML);
        // Check for dialog/modal/overlay
        const hasDialog = bodyContent.includes('dialog') || bodyContent.includes('modal') || bodyContent.includes('Modal');
        const hasOverlay = bodyContent.includes('overlay') || bodyContent.includes('Overlay');
        console.log(`After Add agent click: hasDialog=${hasDialog}, hasOverlay=${hasOverlay}`);

        // Check for any new elements
        const allDialogs = await page.$$('[role="dialog"]');
        const allModals = await page.$$('[class*="modal" i]');
        const allOverlays = await page.$$('[class*="overlay" i]');
        console.log(`Dialogs: ${allDialogs.length}, Modals: ${allModals.length}, Overlays: ${allOverlays.length}`);

        // Look at body classes
        const bodyClasses = await page.evaluate(() => document.body.className);
        console.log('Body classes:', bodyClasses);

        // Scroll to look for any form that appeared
        await page.evaluate(() => window.scrollTo(0, 0));
        const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 2000));
        console.log('Body text after Add agent:', bodyText.substring(200, 1000));

        if (bodyText.includes('Name') || bodyText.includes('name') || bodyText.includes('Create') || bodyText.includes('Role')) {
          record('Org', 'Add agent form appearance', 'Form fields appeared in page', ['Add agent form appears inline, not as dialog']);
        } else {
          record('Org', 'Add agent button click result', 'No form/dialog appeared after click', ['Add agent button click has no visible effect - bug?']);
        }
      }

      // Try clicking on an employee card to see detail
      const sdlEl = await page.$('text=Software Delivery Lead');
      if (sdlEl) {
        // Navigate up to the card
        const cardEl = await sdlEl.evaluate(el => {
          let p = el;
          for (let i = 0; i < 6; i++) {
            if (p.tagName === 'BUTTON' || p.tagName === 'A' || p.getAttribute('role') === 'button') return p.tagName;
            p = p.parentElement;
          }
          return 'no button found';
        });
        console.log('SDL element parent type:', cardEl);

        await sdlEl.click({ force: true });
        await sleep(1500);
        const urlAfterClick = page.url();
        console.log('URL after clicking SDL:', urlAfterClick);
        await shot(page, 'org-sdl-after-click');

        const pageContent = await page.evaluate(() => document.body.innerText.substring(200, 1000));
        console.log('After SDL click:', pageContent.substring(0, 500));

        if (urlAfterClick !== 'http://localhost:8888/org') {
          record('Org', 'Click employee card navigates', `Navigated to: ${urlAfterClick}`);
        } else {
          // Check if a side panel opened
          const hasSidePanel = pageContent.includes('Edit') || pageContent.includes('Details') || pageContent.includes('Configuration');
          record('Org', 'Click employee card', hasSidePanel ? 'Side panel with details appeared' : 'No navigation or panel change',
            hasSidePanel ? [] : ['Clicking employee card has no apparent visual effect']);
        }
      }
    } catch(e) {
      record('Org', 'Org detailed', `Error: ${e.message}`, [`Org error: ${e.message}`]);
    } finally {
      await page.close();
    }
  }

  // =============================================
  // KANBAN - More interaction
  // =============================================
  console.log('\n=== Kanban Detailed ===');
  {
    const page = await newPage();
    try {
      await page.goto('http://localhost:8888/kanban', { waitUntil: 'domcontentloaded', timeout: 10000 });
      await sleep(2000);
      await shot(page, 'kanban-detailed');

      // Try the New Ticket dialog more carefully
      const newTicketBtn = await page.$('button:has-text("New Ticket")');
      if (newTicketBtn) {
        await newTicketBtn.click();
        await sleep(1000);
        await shot(page, 'kanban-new-ticket-open');

        // The submit was disabled before - check validation requirements
        const submitBtn = await page.$('button:has-text("Create Ticket")');
        if (submitBtn) {
          const isEnabled = await submitBtn.isEnabled();
          record('Kanban', 'New Ticket submit initially disabled', `enabled=${isEnabled}`);
        }

        // Fill in title (required field)
        const titleInput = await page.$('input[placeholder="What needs to be done?"]');
        if (titleInput) {
          await titleInput.fill('Build Todo App MVP');
          await sleep(300);

          // Check if submit is now enabled
          const submitBtnAfter = await page.$('button:has-text("Create Ticket")');
          const isEnabledAfter = await submitBtnAfter?.isEnabled();
          record('Kanban', 'Submit button after filling title', `enabled=${isEnabledAfter}`,
            isEnabledAfter ? [] : ['Submit button still disabled after filling required title field']);

          if (isEnabledAfter) {
            await submitBtnAfter.click();
            await sleep(1500);
            await shot(page, 'kanban-ticket-created');
            record('Kanban', 'Create ticket', 'Ticket created successfully');
          }
        }

        await page.keyboard.press('Escape');
        await sleep(500);
      }

      // Click on an existing ticket
      const ticketEl = await page.$('text=Valid ticket in batch');
      if (ticketEl) {
        await ticketEl.click();
        await sleep(1000);
        await shot(page, 'kanban-existing-ticket-clicked');
        const content = await page.evaluate(() => document.body.innerText.substring(200, 1000));
        record('Kanban', 'Click existing ticket "Valid ticket in batch"', content.substring(0, 200));
      }

      // Try dragging a ticket between columns (drag-drop test)
      const kanbanCards = await page.$$('[class*="ticket" i], [class*="card" i]');
      console.log(`Kanban cards found: ${kanbanCards.length}`);

      // Check column headers
      const columns = await page.$$('[class*="column" i], [class*="Column" i]');
      console.log(`Kanban columns: ${columns.length}`);

    } catch(e) {
      record('Kanban', 'Kanban detailed', `Error: ${e.message}`, [`Kanban error: ${e.message}`]);
    } finally {
      await page.close();
    }
  }

  // =============================================
  // ACTIVITY/LOGS PAGE
  // =============================================
  console.log('\n=== Activity/Logs Page ===');
  {
    const page = await newPage();
    try {
      await page.goto('http://localhost:8888/logs', { waitUntil: 'domcontentloaded', timeout: 10000 });
      await sleep(2000);
      const s = await shot(page, 'logs-initial');
      record('Activity', 'Activity/Logs page loaded', `Screenshot: ${s}`);

      const logsText = await page.evaluate(() => document.body.innerText);
      console.log('Logs text:', logsText.substring(200, 2000));
      record('Activity', 'Logs page content', logsText.substring(200, 600).trim());

      // Try any filtering or searching
      const searchInput = await page.$('input[type="search"], input[placeholder*="search" i], input[placeholder*="filter" i]');
      if (searchInput) {
        await searchInput.fill('error');
        await sleep(500);
        await shot(page, 'logs-filtered');
        record('Activity', 'Search/filter logs', 'Filter applied');
      }

    } catch(e) {
      record('Activity', 'Logs page', `Error: ${e.message}`, [`Logs error: ${e.message}`]);
    } finally {
      await page.close();
    }
  }

  // =============================================
  // TALK PAGE
  // =============================================
  console.log('\n=== Talk Page ===');
  {
    const page = await newPage();
    try {
      await page.goto('http://localhost:8888/talk', { waitUntil: 'domcontentloaded', timeout: 10000 });
      await sleep(3000);
      const s = await shot(page, 'talk-initial');
      record('Talk', 'Talk page loaded', `Screenshot: ${s}`);

      const talkText = await page.evaluate(() => document.body.innerText);
      console.log('Talk text:', talkText.substring(0, 800));
      record('Talk', 'Talk page content', talkText.substring(0, 400).trim());

      const hasConnecting = talkText.includes('Connecting');
      const hasConnected = talkText.includes('Connected');
      const hasError = talkText.toLowerCase().includes('error') || talkText.toLowerCase().includes('failed');

      if (hasConnecting && !hasConnected) {
        record('Talk', 'Talk connection status', 'Stuck at "Connecting" state', ['Talk/AURA page stuck on "Connecting" - may need WebRTC or microphone access']);
      } else if (hasConnected) {
        record('Talk', 'Talk connection status', 'Successfully connected');
      } else if (hasError) {
        record('Talk', 'Talk connection status', 'Connection error', ['Talk page shows error state']);
      }

      // Check for buttons
      const btns = await page.$$('button');
      const btnTxts = await Promise.all(btns.map(b => b.evaluate(el => el.textContent?.trim())));
      console.log('Talk buttons:', btnTxts.filter(Boolean));

    } catch(e) {
      record('Talk', 'Talk page', `Error: ${e.message}`, [`Talk error: ${e.message}`]);
    } finally {
      await page.close();
    }
  }

  // =============================================
  // Check file viewer specifically
  // =============================================
  console.log('\n=== File Viewer ===');
  {
    const page = await newPage();
    try {
      // Try a path that exists - look for actual codebase files
      const testPaths = [
        '/file?path=CLAUDE.md',
        '/file?path=README.md',
        '/file?path=package.json',
      ];

      for (const p of testPaths) {
        await page.goto(`http://localhost:8888${p}`, { waitUntil: 'domcontentloaded', timeout: 5000 });
        await sleep(1000);
        const content = await page.evaluate(() => document.body.innerText.substring(0, 400));
        console.log(`File ${p}:`, content.substring(0, 200));
        await shot(page, `file-viewer-${p.replace(/[^a-z0-9]/gi, '-')}`);

        if (content.includes('File not found') || content.includes('not found')) {
          record('File Viewer', `File path ${p}`, 'File not found', [`File viewer cannot find ${p} - path resolution issue?`]);
        } else {
          record('File Viewer', `File path ${p}`, 'File found and displayed');
        }
      }
    } catch(e) {
      record('File Viewer', 'File viewer', `Error: ${e.message}`, [`File viewer error: ${e.message}`]);
    } finally {
      await page.close();
    }
  }

  // =============================================
  // Chat - Explore COO message sending
  // =============================================
  console.log('\n=== Chat COO Interaction ===');
  {
    const page = await newPage();
    try {
      await page.goto('http://localhost:8888', { waitUntil: 'domcontentloaded', timeout: 10000 });
      await sleep(2000);

      // Find the COO in the sidebar
      const cooEl = await page.$('text=Cuttlefish');
      if (cooEl) {
        await cooEl.click();
        await sleep(1000);
        await shot(page, 'chat-coo-clicked');
        const content = await page.evaluate(() => document.body.innerText.substring(200, 1000));
        console.log('After clicking Cuttlefish COO:', content.substring(0, 400));
        record('Chat', 'Click Cuttlefish COO in sidebar', content.substring(0, 200));
      }

      // Look at the full sidebar structure
      const sidebarHTML = await page.evaluate(() => {
        const sidebar = document.querySelector('aside, [class*="sidebar"], nav');
        return sidebar?.textContent?.substring(0, 1000) || 'No sidebar found';
      });
      console.log('Sidebar content:', sidebarHTML);

      // Check what the employee list looks like
      const managerSection = await page.$('text=Managers');
      const teamSection = await page.$('text=Team');
      record('Chat', 'Sidebar structure', `Has Managers section=${!!managerSection}, Has Team section=${!!teamSection}`);

      // Look at the chat with an employee
      const currentContent = await page.evaluate(() => document.body.innerText.substring(200, 2000));
      console.log('Current chat state:', currentContent.substring(0, 500));

      // Check if there's context about the message sent in previous test
      const hasMessage = currentContent.includes('todo app') || currentContent.includes('Todo');
      record('Chat', 'Previous message visible', `Message visible=${hasMessage}`);

      // Check the employee info shown in sidebar
      const empCount = await page.$$eval('[class*="employee-item"], [class*="chat-item"], aside li, aside a', els => els.length);
      record('Chat', 'Employee/chat list items', `${empCount} items in sidebar`);

      await shot(page, 'chat-full-state');

    } catch(e) {
      record('Chat', 'Chat COO', `Error: ${e.message}`, [`Chat error: ${e.message}`]);
    } finally {
      await page.close();
    }
  }

  await browser.close();
  generateReport(allFindings, consoleErrors, networkErrors);
}

function generateReport(findings, consoleErrors, networkErrors) {
  const sections = {};
  for (const f of findings) {
    if (!sections[f.section]) sections[f.section] = [];
    sections[f.section].push(f);
  }
  const allIssues = findings.flatMap(f => f.issues);

  // Append to existing log
  let md = `\n\n---\n\n# Part 2: Deep Exploration Results\n\n`;
  md += `**Date:** ${new Date().toISOString()}\n\n`;

  md += `## Part 2 Summary\n\n`;
  md += `| Feature | Status | Key Issues |\n`;
  md += `|---------|--------|------------|\n`;
  for (const [section, items] of Object.entries(sections)) {
    const issues = items.flatMap(i => i.issues);
    const status = issues.length === 0 ? 'OK' : `${issues.length} issue(s)`;
    md += `| ${section} | ${status} | ${issues.slice(0, 2).join('; ') || 'None'} |\n`;
  }

  md += `\n**Total new issues:** ${allIssues.length}\n`;
  md += `**Console errors captured:** ${consoleErrors.length}\n\n`;

  md += `## Part 2 Issues\n\n`;
  for (const issue of allIssues) {
    md += `- ${issue}\n`;
  }

  md += `\n## Part 2 Console Errors\n\n`;
  const uniqueErrors = [...new Map(consoleErrors.map(e => [e.text.substring(0, 80), e])).values()];
  for (const err of uniqueErrors.slice(0, 40)) {
    md += `**URL:** ${err.url}\n**Error:** \`${err.text.substring(0, 400)}\`\n\n`;
  }

  md += `\n## Part 2 Detailed Findings\n\n`;
  for (const [section, items] of Object.entries(sections)) {
    md += `### ${section}\n\n`;
    for (const item of items) {
      md += `**Action:** ${item.action}\n\n`;
      md += `**Result:** ${item.result}\n\n`;
      if (item.issues.length > 0) {
        md += `**Issues:**\n`;
        for (const issue of item.issues) md += `- ${issue}\n`;
        md += `\n`;
      }
    }
    md += `---\n\n`;
  }

  const existing = fs.existsSync('/tmp/user-exploration-log.md') ? fs.readFileSync('/tmp/user-exploration-log.md', 'utf8') : '';
  fs.writeFileSync('/tmp/user-exploration-log.md', existing + '\n' + md);

  console.log(`\nPart 2 report appended to: /tmp/user-exploration-log.md`);
  console.log(`Total part 2 findings: ${findings.length}`);
  console.log(`Total part 2 issues: ${allIssues.length}`);
  console.log(`Part 2 console errors: ${consoleErrors.length}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
