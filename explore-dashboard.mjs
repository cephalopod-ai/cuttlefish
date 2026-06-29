import { chromium } from '/home/ericl/Work/vscode/public_share/cuttlefish/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';
import fs from 'fs';
import path from 'path';

const SCREENSHOTS_DIR = '/tmp/screenshots';
const LOG_FILE = '/tmp/user-exploration-log.md';

// Ensure screenshots dir exists
fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

let screenshotCount = 0;
const findings = [];
const consoleErrors = [];

async function screenshot(page, name) {
  screenshotCount++;
  const filename = `${String(screenshotCount).padStart(3, '0')}-${name}.png`;
  const filepath = path.join(SCREENSHOTS_DIR, filename);
  await page.screenshot({ path: filepath, fullPage: true });
  return filepath;
}

async function log(section, action, result, issues = []) {
  findings.push({ section, action, result, issues });
  console.log(`[${section}] ${action}: ${result}`);
  if (issues.length > 0) {
    console.log(`  ISSUES: ${issues.join(', ')}`);
  }
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  // Capture console errors
  page.on('console', msg => {
    if (msg.type() === 'error') {
      consoleErrors.push({ url: page.url(), msg: msg.text() });
    }
  });

  page.on('pageerror', err => {
    consoleErrors.push({ url: page.url(), msg: `PAGE ERROR: ${err.message}` });
  });

  try {
    // ============================================================
    // 1. HOMEPAGE / CHAT
    // ============================================================
    console.log('\n=== SECTION 1: Homepage / Chat ===');
    await page.goto('http://localhost:8888');
    await sleep(2000);

    const title = await page.title();
    await log('Homepage', 'Navigate to homepage', `Title: ${title}`);

    const homepageScreenshot = await screenshot(page, 'homepage-initial');
    await log('Homepage', 'Initial view', `Screenshot: ${homepageScreenshot}`);

    // Look at the page structure
    const pageContent = await page.evaluate(() => document.body.innerText.substring(0, 1000));
    console.log('Page content preview:', pageContent);

    // Find chat input
    const chatInputSelectors = [
      'textarea[placeholder*="message" i]',
      'textarea[placeholder*="chat" i]',
      'input[placeholder*="message" i]',
      'input[type="text"]',
      'textarea',
      '[contenteditable="true"]',
    ];

    let chatInput = null;
    for (const sel of chatInputSelectors) {
      const el = await page.$(sel);
      if (el) {
        chatInput = el;
        await log('Homepage', `Found chat input with selector: ${sel}`, 'Found');
        break;
      }
    }

    if (chatInput) {
      // Look for employee selector or COO mention
      const bodyText = await page.evaluate(() => document.body.innerText);
      const hasCOO = bodyText.toLowerCase().includes('coo');
      await log('Homepage', 'Check for COO', hasCOO ? 'COO found in page' : 'COO not found in page text');

      // Try to send a message
      await chatInput.click();
      await chatInput.fill('Please start a new project to build a todo app');
      const afterTypingScreenshot = await screenshot(page, 'homepage-chat-typed');

      // Find send button
      const sendButtonSelectors = [
        'button[type="submit"]',
        'button:has-text("Send")',
        'button:has-text("Submit")',
        '[aria-label="Send"]',
        '[aria-label="send"]',
        'button:has(svg)',
      ];

      let sendButton = null;
      for (const sel of sendButtonSelectors) {
        const el = await page.$(sel);
        if (el) {
          const isVisible = await el.isVisible();
          const isEnabled = await el.isEnabled();
          if (isVisible) {
            sendButton = el;
            await log('Homepage', `Found send button: ${sel}`, `visible=${isVisible}, enabled=${isEnabled}`);
            break;
          }
        }
      }

      if (sendButton) {
        await sendButton.click();
        await sleep(3000);
        const afterSendScreenshot = await screenshot(page, 'homepage-after-send');
        await log('Homepage', 'Send message to COO', 'Message sent', []);

        // Check for response
        const responseText = await page.evaluate(() => document.body.innerText);
        const hasResponse = responseText.length > 200;
        await log('Homepage', 'Check for response', hasResponse ? 'Page has content after send' : 'No apparent response yet');
      } else {
        await log('Homepage', 'Find send button', 'No send button found', ['Send button missing or not detectable']);
        // Try pressing Enter
        await chatInput.press('Enter');
        await sleep(2000);
        await screenshot(page, 'homepage-enter-pressed');
      }
    } else {
      const screenshotPath = await screenshot(page, 'homepage-no-chat');
      await log('Homepage', 'Find chat input', 'No chat input found', ['Chat input not found on homepage']);
    }

    await screenshot(page, 'homepage-final');

    // ============================================================
    // 2. ORG CHART
    // ============================================================
    console.log('\n=== SECTION 2: Org Chart ===');

    // Find nav links
    const navLinks = await page.$$eval('nav a, [role="navigation"] a, header a', links =>
      links.map(l => ({ text: l.textContent.trim(), href: l.href }))
    );
    console.log('Nav links found:', navLinks);

    // Try to navigate to org page
    const orgPaths = ['/org', '/employees', '/team', '/organization'];
    let orgFound = false;

    for (const p of orgPaths) {
      await page.goto(`http://localhost:8888${p}`);
      await sleep(1500);
      const url = page.url();
      const content = await page.evaluate(() => document.body.innerText.substring(0, 300));
      if (!content.includes('Not Found') && !content.includes('404') && url.includes(p)) {
        orgFound = true;
        await log('Org Chart', `Navigate to ${p}`, 'Found org page');
        await screenshot(page, `org-chart-${p.replace('/', '')}`);
        break;
      }
    }

    if (!orgFound) {
      // Try clicking nav links
      await page.goto('http://localhost:8888');
      await sleep(1500);

      const allLinks = await page.$$eval('a', links => links.map(l => ({ text: l.textContent.trim(), href: l.href })));
      console.log('All links on homepage:', allLinks.slice(0, 20));

      // Look for org-related links
      const orgLink = allLinks.find(l =>
        l.text.toLowerCase().includes('org') ||
        l.text.toLowerCase().includes('team') ||
        l.text.toLowerCase().includes('employee')
      );

      if (orgLink) {
        await page.click(`a[href="${orgLink.href}"]`);
        await sleep(1500);
        await screenshot(page, 'org-chart-nav');
        await log('Org Chart', `Navigate via link: ${orgLink.text}`, 'Navigated to org page');
      } else {
        await log('Org Chart', 'Navigate to org page', 'Could not find org page', ['No org/team nav link found']);
      }
    }

    // Check current org page content
    const orgContent = await page.evaluate(() => document.body.innerText.substring(0, 2000));
    console.log('Org page content:', orgContent.substring(0, 500));

    // Try to find and click "Create Employee" or similar button
    const createButtonSelectors = [
      'button:has-text("Add")',
      'button:has-text("Create")',
      'button:has-text("New")',
      'button:has-text("+")',
      '[aria-label="Add employee"]',
      '[aria-label="Create employee"]',
    ];

    for (const sel of createButtonSelectors) {
      const btn = await page.$(sel);
      if (btn) {
        const isVisible = await btn.isVisible();
        if (isVisible) {
          await log('Org Chart', `Found create button: ${sel}`, 'Visible');
          await btn.click();
          await sleep(1000);
          await screenshot(page, 'org-chart-create-dialog');

          // Fill in form if dialog opened
          const form = await page.$('form, [role="dialog"]');
          if (form) {
            await log('Org Chart', 'Create employee dialog', 'Dialog opened');

            // Fill name
            const nameInput = await page.$('input[name="name"], input[placeholder*="name" i]');
            if (nameInput) {
              await nameInput.fill('Alex Johnson');
            }

            // Fill role/title
            const roleInput = await page.$('input[name="role"], input[name="title"], input[placeholder*="role" i], input[placeholder*="title" i]');
            if (roleInput) {
              await roleInput.fill('Senior Engineer');
            }

            // Fill email
            const emailInput = await page.$('input[type="email"], input[name="email"], input[placeholder*="email" i]');
            if (emailInput) {
              await emailInput.fill('alex.johnson@company.com');
            }

            await screenshot(page, 'org-chart-form-filled');

            // Submit
            const submitBtn = await page.$('button[type="submit"], button:has-text("Save"), button:has-text("Create"), button:has-text("Add")');
            if (submitBtn) {
              await submitBtn.click();
              await sleep(1500);
              await screenshot(page, 'org-chart-after-create');
              await log('Org Chart', 'Create employee form submit', 'Submitted');
            }
          } else {
            await log('Org Chart', 'Create employee button click', 'No dialog appeared', ['Button click did not open dialog']);
          }
          break;
        }
      }
    }

    // ============================================================
    // 3. KANBAN
    // ============================================================
    console.log('\n=== SECTION 3: Kanban ===');

    const kanbanPaths = ['/kanban', '/board', '/tasks', '/projects', '/tickets'];
    let kanbanFound = false;

    for (const p of kanbanPaths) {
      await page.goto(`http://localhost:8888${p}`);
      await sleep(1500);
      const content = await page.evaluate(() => document.body.innerText.substring(0, 300));
      if (!content.includes('Not Found') && !content.includes('404')) {
        const url = page.url();
        if (!url.endsWith('/') || p === '/') {
          kanbanFound = true;
          await log('Kanban', `Navigate to ${p}`, 'Found kanban page');
          await screenshot(page, `kanban-${p.replace('/', '')}`);
          break;
        }
      }
    }

    // Try clicking from nav
    await page.goto('http://localhost:8888');
    await sleep(1500);
    const allLinks2 = await page.$$eval('a', links => links.map(l => ({ text: l.textContent.trim(), href: l.href })));
    const kanbanLink = allLinks2.find(l =>
      l.text.toLowerCase().includes('kanban') ||
      l.text.toLowerCase().includes('board') ||
      l.text.toLowerCase().includes('task') ||
      l.text.toLowerCase().includes('ticket')
    );

    if (kanbanLink) {
      await page.goto(kanbanLink.href);
      await sleep(1500);
      kanbanFound = true;
      await screenshot(page, 'kanban-from-nav');
      await log('Kanban', `Navigate via nav link: ${kanbanLink.text}`, 'Navigated');
    }

    if (!kanbanFound) {
      await log('Kanban', 'Navigate to kanban', 'Kanban page not found', ['Kanban/board path not discovered']);
    }

    // Try to create a new ticket
    const kanbanContent = await page.evaluate(() => document.body.innerText.substring(0, 500));
    console.log('Kanban content:', kanbanContent);

    // Look for add ticket button
    const addTicketSelectors = [
      'button:has-text("Add")',
      'button:has-text("Create")',
      'button:has-text("New")',
      'button:has-text("+ Add")',
      'button:has-text("New Task")',
      'button:has-text("New Ticket")',
      '[aria-label*="add" i]',
    ];

    for (const sel of addTicketSelectors) {
      const btn = await page.$(sel);
      if (btn) {
        const isVisible = await btn.isVisible();
        if (isVisible) {
          await btn.click();
          await sleep(1000);
          await screenshot(page, 'kanban-create-ticket');

          const ticketTitleInput = await page.$('input[placeholder*="title" i], input[placeholder*="name" i], input[name="title"]');
          if (ticketTitleInput) {
            await ticketTitleInput.fill('Build user authentication system');

            const descInput = await page.$('textarea, input[placeholder*="desc" i]');
            if (descInput) {
              await descInput.fill('Implement OAuth2 login with Google and GitHub');
            }

            await screenshot(page, 'kanban-ticket-filled');

            const submitBtn = await page.$('button[type="submit"], button:has-text("Save"), button:has-text("Create"), button:has-text("Add")');
            if (submitBtn) {
              await submitBtn.click();
              await sleep(1500);
              await screenshot(page, 'kanban-after-create');
              await log('Kanban', 'Create ticket', 'Ticket creation attempted');
            }
          }
          break;
        }
      }
    }

    // ============================================================
    // 4. SETTINGS
    // ============================================================
    console.log('\n=== SECTION 4: Settings ===');

    const settingsPaths = ['/settings', '/config', '/preferences'];

    for (const p of settingsPaths) {
      await page.goto(`http://localhost:8888${p}`);
      await sleep(1500);
      const content = await page.evaluate(() => document.body.innerText.substring(0, 300));
      const url = page.url();
      if (!content.includes('404') && url.includes(p.replace('/', ''))) {
        await log('Settings', `Navigate to ${p}`, 'Found settings page');
        await screenshot(page, `settings-${p.replace('/', '')}`);

        // Find toggles and checkboxes
        const toggles = await page.$$('input[type="checkbox"], [role="switch"], .toggle');
        await log('Settings', 'Find toggles', `Found ${toggles.length} toggle(s)`);

        for (let i = 0; i < Math.min(toggles.length, 5); i++) {
          try {
            const toggle = toggles[i];
            const isChecked = await toggle.isChecked().catch(() => false);
            await toggle.click();
            await sleep(500);
            const newState = await toggle.isChecked().catch(() => false);
            await log('Settings', `Toggle ${i+1}`, `State changed from ${isChecked} to ${newState}`);
          } catch(e) {
            await log('Settings', `Toggle ${i+1}`, `Error toggling: ${e.message}`, ['Toggle interaction failed']);
          }
        }

        await screenshot(page, 'settings-after-toggles');
        break;
      }
    }

    // Try nav links for settings
    await page.goto('http://localhost:8888');
    await sleep(1000);
    const allLinks3 = await page.$$eval('a', links => links.map(l => ({ text: l.textContent.trim(), href: l.href })));
    const settingsLink = allLinks3.find(l =>
      l.text.toLowerCase().includes('setting') ||
      l.text.toLowerCase().includes('config') ||
      l.text.toLowerCase().includes('preference')
    );
    if (settingsLink) {
      await page.goto(settingsLink.href);
      await sleep(1500);
      await screenshot(page, 'settings-from-nav');
      await log('Settings', `Navigate to settings via: ${settingsLink.text}`, 'Navigated');
    }

    // ============================================================
    // 5. CRON JOBS
    // ============================================================
    console.log('\n=== SECTION 5: Cron Jobs ===');

    const cronPaths = ['/cron', '/scheduled', '/jobs', '/automation'];

    for (const p of cronPaths) {
      await page.goto(`http://localhost:8888${p}`);
      await sleep(1500);
      const content = await page.evaluate(() => document.body.innerText.substring(0, 300));
      const url = page.url();
      if (!content.includes('404') && url.includes(p.replace('/', ''))) {
        await log('Cron', `Navigate to ${p}`, 'Found cron page');
        await screenshot(page, `cron-${p.replace('/', '')}`);
        break;
      }
    }

    // Try nav
    await page.goto('http://localhost:8888');
    await sleep(1000);
    const allLinks4 = await page.$$eval('a', links => links.map(l => ({ text: l.textContent.trim(), href: l.href })));
    const cronLink = allLinks4.find(l =>
      l.text.toLowerCase().includes('cron') ||
      l.text.toLowerCase().includes('schedule') ||
      l.text.toLowerCase().includes('job') ||
      l.text.toLowerCase().includes('automat')
    );

    if (cronLink) {
      await page.goto(cronLink.href);
      await sleep(1500);
      await screenshot(page, 'cron-from-nav');
      await log('Cron', `Navigate via: ${cronLink.text}`, 'Navigated to cron page');

      // Try to create a cron job
      const createCronSelectors = [
        'button:has-text("Add")',
        'button:has-text("Create")',
        'button:has-text("New")',
        'button:has-text("Schedule")',
      ];

      for (const sel of createCronSelectors) {
        const btn = await page.$(sel);
        if (btn) {
          const isVisible = await btn.isVisible();
          if (isVisible) {
            await btn.click();
            await sleep(1000);
            await screenshot(page, 'cron-create-dialog');

            // Fill form
            const nameInput = await page.$('input[name="name"], input[placeholder*="name" i], input[placeholder*="job" i]');
            if (nameInput) {
              await nameInput.fill('Daily Report Generation');
            }

            const cronInput = await page.$('input[name="cron"], input[placeholder*="cron" i], input[placeholder*="schedule" i], input[placeholder*="expression" i]');
            if (cronInput) {
              await cronInput.fill('0 9 * * 1-5');
            }

            await screenshot(page, 'cron-form-filled');

            const submitBtn = await page.$('button[type="submit"], button:has-text("Save"), button:has-text("Create")');
            if (submitBtn) {
              await submitBtn.click();
              await sleep(1500);
              await screenshot(page, 'cron-after-create');
              await log('Cron', 'Create cron job', 'Job creation attempted');
            }
            break;
          }
        }
      }
    } else {
      await log('Cron', 'Find cron page', 'No cron link found in nav', ['Cron section not found']);
    }

    // ============================================================
    // 6. HR PAGE
    // ============================================================
    console.log('\n=== SECTION 6: HR Page ===');

    const hrPaths = ['/hr', '/people', '/human-resources'];

    for (const p of hrPaths) {
      await page.goto(`http://localhost:8888${p}`);
      await sleep(1500);
      const content = await page.evaluate(() => document.body.innerText.substring(0, 300));
      const url = page.url();
      if (!content.includes('404') && (url.includes(p.replace('/', '')) || !url.endsWith('/'))) {
        await log('HR', `Navigate to ${p}`, 'Found HR page');
        await screenshot(page, `hr-${p.replace('/', '')}`);

        // Explore HR interactions
        const hrButtons = await page.$$('button');
        const buttonTexts = await Promise.all(hrButtons.map(b => b.textContent()));
        console.log('HR buttons:', buttonTexts.filter(t => t && t.trim()).slice(0, 10));
        break;
      }
    }

    // Try nav
    await page.goto('http://localhost:8888');
    await sleep(1000);
    const allLinks5 = await page.$$eval('a', links => links.map(l => ({ text: l.textContent.trim(), href: l.href })));
    const hrLink = allLinks5.find(l =>
      l.text.toLowerCase().includes('hr') ||
      l.text.toLowerCase().includes('people') ||
      l.text.toLowerCase().includes('human')
    );

    if (hrLink) {
      await page.goto(hrLink.href);
      await sleep(1500);
      await screenshot(page, 'hr-from-nav');
      await log('HR', `Navigate via: ${hrLink.text}`, 'Navigated to HR page');
    } else {
      await log('HR', 'Find HR page', 'No HR link found', ['HR page not found in nav']);
    }

    // ============================================================
    // 7. SKILLS
    // ============================================================
    console.log('\n=== SECTION 7: Skills ===');

    const skillsPaths = ['/skills', '/capabilities', '/tools'];

    for (const p of skillsPaths) {
      await page.goto(`http://localhost:8888${p}`);
      await sleep(1500);
      const content = await page.evaluate(() => document.body.innerText.substring(0, 300));
      const url = page.url();
      if (!content.includes('404') && url.includes(p.replace('/', ''))) {
        await log('Skills', `Navigate to ${p}`, 'Found skills page');
        await screenshot(page, `skills-${p.replace('/', '')}`);
        break;
      }
    }

    await page.goto('http://localhost:8888');
    await sleep(1000);
    const allLinks6 = await page.$$eval('a', links => links.map(l => ({ text: l.textContent.trim(), href: l.href })));
    const skillsLink = allLinks6.find(l =>
      l.text.toLowerCase().includes('skill') ||
      l.text.toLowerCase().includes('capabilit') ||
      l.text.toLowerCase().includes('tool')
    );

    if (skillsLink) {
      await page.goto(skillsLink.href);
      await sleep(1500);
      await screenshot(page, 'skills-from-nav');
      await log('Skills', `Navigate via: ${skillsLink.text}`, 'Navigated to skills page');

      // Try to add a skill
      const addSkillBtn = await page.$('button:has-text("Add"), button:has-text("Create"), button:has-text("New")');
      if (addSkillBtn) {
        await addSkillBtn.click();
        await sleep(1000);
        await screenshot(page, 'skills-add-dialog');

        const skillNameInput = await page.$('input[name="name"], input[placeholder*="name" i], input[placeholder*="skill" i]');
        if (skillNameInput) {
          await skillNameInput.fill('Data Analysis');
        }

        const submitBtn = await page.$('button[type="submit"], button:has-text("Save"), button:has-text("Add")');
        if (submitBtn) {
          await submitBtn.click();
          await sleep(1500);
          await screenshot(page, 'skills-after-add');
          await log('Skills', 'Add skill', 'Skill addition attempted');
        }
      }
    } else {
      await log('Skills', 'Find skills page', 'No skills link found', ['Skills page not found']);
    }

    // ============================================================
    // 8. LIMITS
    // ============================================================
    console.log('\n=== SECTION 8: Limits ===');

    const limitsPaths = ['/limits', '/quotas', '/usage'];

    for (const p of limitsPaths) {
      await page.goto(`http://localhost:8888${p}`);
      await sleep(1500);
      const content = await page.evaluate(() => document.body.innerText.substring(0, 300));
      const url = page.url();
      if (!content.includes('404') && url.includes(p.replace('/', ''))) {
        await log('Limits', `Navigate to ${p}`, 'Found limits page');
        await screenshot(page, `limits-${p.replace('/', '')}`);

        const content2 = await page.evaluate(() => document.body.innerText.substring(0, 1000));
        console.log('Limits content:', content2.substring(0, 300));
        break;
      }
    }

    await page.goto('http://localhost:8888');
    await sleep(1000);
    const allLinks7 = await page.$$eval('a', links => links.map(l => ({ text: l.textContent.trim(), href: l.href })));
    const limitsLink = allLinks7.find(l =>
      l.text.toLowerCase().includes('limit') ||
      l.text.toLowerCase().includes('quota') ||
      l.text.toLowerCase().includes('usage')
    );

    if (limitsLink) {
      await page.goto(limitsLink.href);
      await sleep(1500);
      await screenshot(page, 'limits-from-nav');
      await log('Limits', `Navigate via: ${limitsLink.text}`, 'Navigated to limits page');
    } else {
      await log('Limits', 'Find limits page', 'No limits link in nav', ['Limits page not found']);
    }

    // ============================================================
    // 9. APPROVALS
    // ============================================================
    console.log('\n=== SECTION 9: Approvals ===');

    const approvalsPaths = ['/approvals', '/approval', '/pending', '/review'];

    for (const p of approvalsPaths) {
      await page.goto(`http://localhost:8888${p}`);
      await sleep(1500);
      const content = await page.evaluate(() => document.body.innerText.substring(0, 300));
      const url = page.url();
      if (!content.includes('404') && url.includes(p.replace('/', ''))) {
        await log('Approvals', `Navigate to ${p}`, 'Found approvals page');
        await screenshot(page, `approvals-${p.replace('/', '')}`);

        const content2 = await page.evaluate(() => document.body.innerText.substring(0, 1000));
        console.log('Approvals content:', content2.substring(0, 300));
        break;
      }
    }

    await page.goto('http://localhost:8888');
    await sleep(1000);
    const allLinks8 = await page.$$eval('a', links => links.map(l => ({ text: l.textContent.trim(), href: l.href })));
    const approvalsLink = allLinks8.find(l =>
      l.text.toLowerCase().includes('approval') ||
      l.text.toLowerCase().includes('pending') ||
      l.text.toLowerCase().includes('review')
    );

    if (approvalsLink) {
      await page.goto(approvalsLink.href);
      await sleep(1500);
      await screenshot(page, 'approvals-from-nav');
      await log('Approvals', `Navigate via: ${approvalsLink.text}`, 'Navigated to approvals page');

      // Check for approval items
      const approvalItems = await page.$$('[data-testid*="approval"], .approval-item, [class*="approval"]');
      await log('Approvals', 'Check approval items', `Found ${approvalItems.length} items`);

      // Try approve/deny buttons
      const approveBtn = await page.$('button:has-text("Approve"), button:has-text("Accept"), button:has-text("Allow")');
      if (approveBtn) {
        await log('Approvals', 'Found approve button', 'Button present but not clicking to avoid side effects');
        await screenshot(page, 'approvals-with-buttons');
      }
    } else {
      await log('Approvals', 'Find approvals page', 'No approvals link in nav', ['Approvals page not found via nav']);
    }

    // ============================================================
    // 10. ARCHIVE
    // ============================================================
    console.log('\n=== SECTION 10: Archive ===');

    const archivePaths = ['/archive', '/history', '/logs'];

    for (const p of archivePaths) {
      await page.goto(`http://localhost:8888${p}`);
      await sleep(1500);
      const content = await page.evaluate(() => document.body.innerText.substring(0, 300));
      const url = page.url();
      if (!content.includes('404') && url.includes(p.replace('/', ''))) {
        await log('Archive', `Navigate to ${p}`, 'Found archive page');
        await screenshot(page, `archive-${p.replace('/', '')}`);

        const content2 = await page.evaluate(() => document.body.innerText.substring(0, 1000));
        console.log('Archive content:', content2.substring(0, 300));
        break;
      }
    }

    await page.goto('http://localhost:8888');
    await sleep(1000);
    const allLinks9 = await page.$$eval('a', links => links.map(l => ({ text: l.textContent.trim(), href: l.href })));
    const archiveLink = allLinks9.find(l =>
      l.text.toLowerCase().includes('archive') ||
      l.text.toLowerCase().includes('history') ||
      l.text.toLowerCase().includes('log')
    );

    if (archiveLink) {
      await page.goto(archiveLink.href);
      await sleep(1500);
      await screenshot(page, 'archive-from-nav');
      await log('Archive', `Navigate via: ${archiveLink.text}`, 'Navigated to archive page');
    } else {
      await log('Archive', 'Find archive page', 'No archive link in nav', ['Archive page not found via nav']);
    }

    // ============================================================
    // Final: Explore navigation structure comprehensively
    // ============================================================
    console.log('\n=== FINAL: Exploring navigation ===');
    await page.goto('http://localhost:8888');
    await sleep(2000);

    // Get complete nav structure
    const navStructure = await page.evaluate(() => {
      const links = document.querySelectorAll('a, [role="link"], nav button');
      return Array.from(links).map(l => ({
        text: l.textContent.trim(),
        href: l.getAttribute('href') || '',
        visible: l.offsetParent !== null
      })).filter(l => l.text && l.visible);
    });

    console.log('Complete nav structure:', JSON.stringify(navStructure, null, 2));

    // Screenshot final state
    await screenshot(page, 'final-homepage');

    // Try to find and visit all unique nav paths
    const uniquePaths = [...new Set(navStructure.filter(l => l.href && l.href.startsWith('/')).map(l => l.href))];
    console.log('Unique paths found:', uniquePaths);

    for (const navPath of uniquePaths.slice(0, 15)) {
      await page.goto(`http://localhost:8888${navPath}`);
      await sleep(1000);
      const pathName = navPath.replace(/\//g, '-').substring(1) || 'root';
      await screenshot(page, `nav-path-${pathName}`);
      const content = await page.evaluate(() => document.body.innerText.substring(0, 200));
      await log('Navigation', `Visit ${navPath}`, content.substring(0, 100));
    }

  } catch (err) {
    console.error('Main error:', err);
    await screenshot(page, 'error-state');
  } finally {
    await browser.close();
  }

  // Generate report
  generateReport(findings, consoleErrors);
}

function generateReport(findings, consoleErrors) {
  const sections = {};
  for (const f of findings) {
    if (!sections[f.section]) sections[f.section] = [];
    sections[f.section].push(f);
  }

  // Summary table
  const sectionSummary = Object.entries(sections).map(([section, items]) => {
    const allIssues = items.flatMap(i => i.issues);
    const status = allIssues.length === 0 ? '✅ OK' : `⚠️ ${allIssues.length} issue(s)`;
    return { section, status, issues: allIssues.join('; ') };
  });

  let report = `# Cuttlefish Dashboard Exploration Log\n`;
  report += `Generated: ${new Date().toISOString()}\n\n`;

  report += `## Summary Table\n\n`;
  report += `| Feature | Status | Issues Found |\n`;
  report += `|---------|--------|-------------|\n`;
  for (const s of sectionSummary) {
    report += `| ${s.section} | ${s.status} | ${s.issues || 'None'} |\n`;
  }

  report += `\n## Console Errors\n\n`;
  if (consoleErrors.length === 0) {
    report += `No console errors detected.\n\n`;
  } else {
    for (const err of consoleErrors) {
      report += `- **URL:** ${err.url}\n  **Error:** ${err.msg}\n\n`;
    }
  }

  report += `\n## Detailed Findings\n\n`;
  for (const [section, items] of Object.entries(sections)) {
    report += `### ${section}\n\n`;
    for (const item of items) {
      report += `**Action:** ${item.action}\n`;
      report += `**Result:** ${item.result}\n`;
      if (item.issues.length > 0) {
        report += `**Issues:** ${item.issues.join(', ')}\n`;
      }
      report += `\n`;
    }
  }

  fs.writeFileSync(LOG_FILE, report);
  console.log(`\nReport written to: ${LOG_FILE}`);
  console.log(`Screenshots saved to: /tmp/screenshots/`);
  console.log(`Total findings: ${findings.length}`);
  console.log(`Console errors: ${consoleErrors.length}`);
}

main().catch(console.error);
