import { chromium } from '/home/ericl/Work/vscode/public_share/cuttlefish/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';
import fs from 'fs';
import path from 'path';

const SCREENSHOTS_DIR = '/tmp/screenshots';
fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

let screenshotCount = 300;
const consoleErrors = [];
const allFindings = [];

async function shot(page, name) {
  screenshotCount++;
  const filename = `${screenshotCount}-${name}.png`;
  await page.screenshot({ path: path.join(SCREENSHOTS_DIR, filename), fullPage: false });
  return filename;
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function record(section, action, result, issues = []) {
  allFindings.push({ section, action, result, issues });
  const issueStr = issues.length ? `\n  BUG/ISSUE: ${issues.join('; ')}` : '';
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
    return page;
  }

  // =============================================
  // BUG: Kanban "Board save failed: Invalid time value"
  // =============================================
  console.log('\n=== Bug: Kanban Save Failed ===');
  {
    const page = await newPage();
    try {
      await page.goto('http://localhost:8888/kanban', { waitUntil: 'domcontentloaded' });
      await sleep(2000);

      // Click on "Valid ticket in batch"
      const ticket = await page.$('text=Valid ticket in batch');
      if (ticket) {
        await ticket.click();
        await sleep(1500);
        const s = await shot(page, 'kanban-ticket-click-error');
        const errorBanner = await page.$('text=Board save failed');
        if (errorBanner) {
          const errorText = await errorBanner.evaluate(el => el.closest('[class]')?.textContent?.substring(0, 300));
          console.log('Error banner:', errorText);
          record('Kanban', 'Board save failed error', `Error appeared: "Board save failed: Invalid time value"`, ['BUG: Clicking ticket triggers "Board save failed: Invalid time value" error - likely date parsing issue in ticket data']);
        }
      }

      // Check the error more carefully
      const allText = await page.evaluate(() => document.body.innerText);
      const hasSaveFailed = allText.includes('Board save failed');
      const hasInvalidTime = allText.includes('Invalid time value');
      record('Kanban', 'Save error details', `Board save failed=${hasSaveFailed}, Invalid time=${hasInvalidTime}`);

      // Check if ticket detail view opened despite error
      const hasTicketDetail = allText.includes('Details') || allText.includes('Assignee') || allText.includes('Priority');
      record('Kanban', 'Ticket detail after error', `Detail shown=${hasTicketDetail}`);

      await shot(page, 'kanban-error-state');

    } catch(e) {
      record('Kanban', 'Error investigation', `Error: ${e.message}`);
    } finally {
      await page.close();
    }
  }

  // =============================================
  // Bug: Add agent form is inline but closes too fast
  // =============================================
  console.log('\n=== Org: Add Agent Form Details ===');
  {
    const page = await newPage();
    try {
      await page.goto('http://localhost:8888/org', { waitUntil: 'domcontentloaded' });
      await sleep(2000);

      const addBtn = await page.$('button:has-text("Add agent")');
      if (addBtn) {
        await addBtn.click();
        await sleep(1000);
        await shot(page, 'org-add-form-open');

        // Check what the inline form looks like
        const formText = await page.evaluate(() => document.body.innerText);
        const formMatch = formText.match(/DISPLAY NAME[\s\S]{0,500}/);
        console.log('Form context:', formMatch?.[0]);

        // Try to fill the inline form
        const allInputs = await page.$$('input:not([type="hidden"])');
        console.log(`Inputs visible: ${allInputs.length}`);

        for (const inp of allInputs) {
          const ph = await inp.getAttribute('placeholder') || '';
          const nm = await inp.getAttribute('name') || '';
          const val = await inp.inputValue();
          const visible = await inp.isVisible();
          console.log(`  Input: placeholder="${ph}", name="${nm}", value="${val}", visible=${visible}`);
        }

        // Fill display name
        const nameInputs = await page.$$('input[placeholder*="display" i], input[placeholder*="name" i], input[placeholder*="agent" i]');
        if (nameInputs.length > 0) {
          await nameInputs[0].fill('Test Agent');
          await sleep(300);
          await shot(page, 'org-add-form-name-filled');
        }

        // Look for required fields
        const requiredFields = await page.$$('[aria-required="true"], [required]');
        record('Org', 'Required fields in add agent form', `${requiredFields.length} required fields`);

        // Find the submit button
        const submitBtns = await page.$$('button[type="submit"], button:has-text("Add"), button:has-text("Create"), button:has-text("Save")');
        for (const btn of submitBtns) {
          const txt = await btn.evaluate(el => el.textContent?.trim());
          const enabled = await btn.isEnabled();
          console.log(`  Submit button: "${txt}", enabled=${enabled}`);
        }

        // Get all form fields and their labels
        const formHTML = await page.evaluate(() => {
          const form = document.querySelector('form') || document.querySelector('[class*="form"]');
          return form?.textContent?.substring(0, 800) || 'No form found';
        });
        console.log('Form HTML text:', formHTML);
        record('Org', 'Add agent inline form', formHTML.substring(0, 300));

        // Check close button
        const closeBtn = await page.$('button:has-text("✕"), button:has-text("×"), button:has-text("Close"), button:has-text("Cancel"), [aria-label="Close"]');
        if (closeBtn) {
          const closeTxt = await closeBtn.evaluate(el => el.textContent?.trim());
          record('Org', 'Add agent form close button', `"${closeTxt}"`);
        }
      }
    } catch(e) {
      record('Org', 'Add agent form', `Error: ${e.message}`);
    } finally {
      await page.close();
    }
  }

  // =============================================
  // Check: Settings - "Creating..." button state
  // =============================================
  console.log('\n=== Settings: Pairing Code & Forget Browser ===');
  {
    const page = await newPage();
    try {
      await page.goto('http://localhost:8888/settings', { waitUntil: 'domcontentloaded' });
      await sleep(2000);

      // Check pairing buttons more carefully
      const allBtns = await page.$$('button');
      for (const btn of allBtns) {
        const txt = await btn.evaluate(el => el.textContent?.trim());
        const enabled = await btn.isEnabled();
        const visible = await btn.isVisible();
        if (visible && (txt?.includes('pairing') || txt?.includes('Pairing') || txt?.includes('Creating') || txt?.includes('Forget') || txt?.includes('Forgetting'))) {
          console.log(`  Button: "${txt}", enabled=${enabled}`);
          record('Settings', `Button "${txt}"`, `enabled=${enabled}`, enabled ? [] : [`Settings button "${txt}" is disabled/broken`]);
        }
      }

      // Check if "Creating..." and "Forgetting..." are stuck in loading states
      const creatingBtn = await page.$('button:has-text("Creating...")');
      const forgettingBtn = await page.$('button:has-text("Forgetting...")');
      if (creatingBtn) {
        const enabled = await creatingBtn.isEnabled();
        record('Settings', '"Creating..." button state', `Visible and enabled=${enabled}`, [`Settings: "Create pairing code" button shows "Creating..." loading state persistently - may be stuck`]);
      }
      if (forgettingBtn) {
        const enabled = await forgettingBtn.isEnabled();
        record('Settings', '"Forgetting..." button state', `Visible and enabled=${enabled}`, [`Settings: "Forget this browser" shows "Forgetting..." persistently - may be stuck loading state`]);
      }

      // Look at the full settings page content with specific areas
      await page.evaluate(() => window.scrollTo(0, 0));
      await sleep(300);
      const s1 = await shot(page, 'settings-top');
      await page.evaluate(() => window.scrollTo(0, 800));
      await sleep(300);
      const s2 = await shot(page, 'settings-middle');
      await page.evaluate(() => window.scrollTo(0, 2000));
      await sleep(300);
      const s3 = await shot(page, 'settings-bottom');

      // Check operator name
      const operatorName = await page.$('input[placeholder*="Operator" i], input[value*="Eric" i]');
      if (operatorName) {
        const val = await operatorName.inputValue();
        record('Settings', 'Operator name field', `Value: "${val}"`);
      }

      // Try changing language setting
      const langSelect = await page.$('select');
      if (langSelect) {
        const currentLang = await langSelect.inputValue();
        record('Settings', 'Language selector value', `Current: "${currentLang}"`);
      }

      // Check the Email inboxes section
      const addInboxBtn = await page.$('button:has-text("Add inbox")');
      if (addInboxBtn) {
        const enabled = await addInboxBtn.isEnabled();
        record('Settings', 'Add inbox button', `enabled=${enabled}`);
        if (enabled) {
          await addInboxBtn.click();
          await sleep(1000);
          await shot(page, 'settings-inbox-form');
          const bodyText = await page.evaluate(() => document.body.innerText.substring(200, 1500));
          if (bodyText.includes('IMAP') || bodyText.includes('inbox') || bodyText.includes('Server')) {
            record('Settings', 'Add inbox opens form', 'IMAP inbox form appeared');
          }
        }
      }

    } catch(e) {
      record('Settings', 'Settings buttons', `Error: ${e.message}`, [`Settings investigation error: ${e.message}`]);
    } finally {
      await page.close();
    }
  }

  // =============================================
  // Check: Cron "Schedule" tab vs action
  // =============================================
  console.log('\n=== Cron: Schedule Tab vs Create ===');
  {
    const page = await newPage();
    try {
      await page.goto('http://localhost:8888/cron', { waitUntil: 'domcontentloaded' });
      await sleep(2000);

      // Look at the "Overview", "Schedule", "Pipelines" tabs
      const overviewTab = await page.$('button:has-text("Overview")');
      const scheduleTab = await page.$('button:has-text("Schedule")');
      const pipelinesTab = await page.$('button:has-text("Pipelines")');

      record('Cron', 'Cron tab navigation', `Overview=${!!overviewTab}, Schedule=${!!scheduleTab}, Pipelines=${!!pipelinesTab}`);

      // Click Overview
      if (overviewTab) {
        await overviewTab.click();
        await sleep(500);
        await shot(page, 'cron-overview-tab');
        const content = await page.evaluate(() => document.body.innerText.substring(200, 800));
        record('Cron', 'Overview tab content', content.substring(0, 200));
      }

      // Click Pipelines
      if (pipelinesTab) {
        await pipelinesTab.click();
        await sleep(500);
        await shot(page, 'cron-pipelines-tab');
        const content = await page.evaluate(() => document.body.innerText.substring(200, 1000));
        record('Cron', 'Pipelines tab content', content.substring(0, 200));
      }

      // Note: "Schedule" is a VIEW tab showing weekly schedule visualization, not "create job"
      // The confusing naming is an issue
      record('Cron', 'Cron navigation issue', '"Schedule" button is a VIEW tab for weekly timeline, NOT a way to create jobs', ['UX: Cron "Schedule" button is confusingly named - it shows a visual calendar, not a form to schedule new jobs. No visible way to create new cron jobs found.']);

    } catch(e) {
      record('Cron', 'Cron tabs', `Error: ${e.message}`);
    } finally {
      await page.close();
    }
  }

  // =============================================
  // Check: Chat - message sending destination
  // =============================================
  console.log('\n=== Chat: Message Sending ===');
  {
    const page = await newPage();
    try {
      await page.goto('http://localhost:8888', { waitUntil: 'domcontentloaded' });
      await sleep(2000);
      await shot(page, 'chat-fresh-start');

      // Check which employee is "active" in the chat
      const chatHeader = await page.evaluate(() => {
        const header = document.querySelector('h1, h2, [class*="chat-header"], [class*="ChatHeader"]');
        return header?.textContent?.trim() || 'No header found';
      });
      console.log('Chat header:', chatHeader);

      // Check the right side chat panel for any employee name
      const rightPanel = await page.evaluate(() => {
        const main = document.querySelector('main, [class*="main"], [class*="content"]');
        return main?.textContent?.trim().substring(0, 500) || 'No main panel';
      });
      console.log('Right panel:', rightPanel.substring(0, 300));

      // Look for employee switcher or recipient indicator
      const recipientInfo = await page.evaluate(() => {
        // Look for any text indicating who we're chatting with
        const elements = document.querySelectorAll('[class*="recipient"], [class*="to"], [class*="employee-name"]');
        return Array.from(elements).map(el => el.textContent?.trim()).filter(Boolean).slice(0, 5);
      });
      console.log('Recipient info:', recipientInfo);
      record('Chat', 'Chat recipient info', `Recipient elements: ${recipientInfo.join(', ') || 'none found'}`);

      // Look at the chat input area for context
      const chatArea = await page.evaluate(() => {
        const textarea = document.querySelector('textarea');
        const parent = textarea?.closest('[class]');
        return parent?.textContent?.trim().substring(0, 500) || 'No chat area';
      });
      console.log('Chat area context:', chatArea.substring(0, 300));

      // Check for "Focused" filter - what does it show?
      const focusedTab = await page.$('button:has-text("Focused"), [data-state="active"]:has-text("Focused")');
      if (focusedTab) {
        await focusedTab.click();
        await sleep(500);
        await shot(page, 'chat-focused-view');
        const focusedContent = await page.evaluate(() => document.body.innerText.substring(200, 800));
        record('Chat', 'Focused view content', focusedContent.substring(0, 200));
      }

      // Check "All" view
      const allTab = await page.$('button:has-text("All")');
      if (allTab) {
        await allTab.click();
        await sleep(500);
        await shot(page, 'chat-all-view');
        const allContent = await page.evaluate(() => document.body.innerText.substring(200, 800));
        record('Chat', '"All" view content', allContent.substring(0, 200));
      }

      // Check for "Today" section
      const todaySection = await page.$('text=Today');
      if (todaySection) {
        record('Chat', 'Today section exists', 'Yes - chat history organized by date');
      }

      // Look at the actual number shown - "49 chats across 10 employees"
      const chatStats = await page.evaluate(() => {
        const text = document.body.innerText;
        const match = text.match(/\d+ chats? across \d+ employees?/);
        return match?.[0] || 'No chat stats';
      });
      record('Chat', 'Chat statistics', chatStats);

      // Check if clicking on a chat shows conversation
      const chatItem = await page.$('[class*="chat-item" i], [class*="chatItem" i]');
      if (!chatItem) {
        // Try list items
        const listItems = await page.$$('li, [role="listitem"]');
        console.log(`List items: ${listItems.length}`);
      }

      // Click on "Senior Security Officer" from today
      const ssoBtn = await page.$('button:has-text("Senior Security Officer")');
      if (ssoBtn) {
        await ssoBtn.click();
        await sleep(1500);
        await shot(page, 'chat-sso-convo');
        record('Chat', 'Click Senior Security Officer', 'Chat opened');

        // Look at conversation content
        const convoText = await page.evaluate(() => {
          const msgs = document.querySelectorAll('[class*="message" i], [class*="Message" i]');
          return Array.from(msgs).map(m => m.textContent?.trim().substring(0, 100)).filter(Boolean).slice(0, 5);
        });
        console.log('Conversation messages:', convoText);
        record('Chat', 'Conversation messages visible', `${convoText.length} messages shown`);
      }

    } catch(e) {
      record('Chat', 'Chat message flow', `Error: ${e.message}`);
    } finally {
      await page.close();
    }
  }

  // =============================================
  // Check: Approvals - Actually click Approve button
  // =============================================
  console.log('\n=== Approvals: Try clicking Approve ===');
  {
    const page = await newPage();
    try {
      await page.goto('http://localhost:8888/approvals', { waitUntil: 'domcontentloaded' });
      await sleep(2000);
      await shot(page, 'approvals-pre-action');

      // Get the first pending item
      const pendingItems = await page.$$eval('button', btns =>
        btns.filter(b => b.textContent?.includes('Security review required') && b.textContent?.includes('Session'))
            .map(b => ({ text: b.textContent?.trim().substring(0, 100) }))
            .slice(0, 3)
      );
      console.log('Pending items:', pendingItems);
      record('Approvals', 'Pending approval items list', `${pendingItems.length} pending items visible in list`);

      // Click first pending item to expand it
      const firstPendingBtn = await page.$('button:has-text("Session abfeb41a")');
      if (firstPendingBtn) {
        await firstPendingBtn.click();
        await sleep(1000);
        await shot(page, 'approvals-expanded-item');

        const expandedContent = await page.evaluate(() => document.body.innerText.substring(200, 2000));
        console.log('Expanded item:', expandedContent.substring(500, 1200));
        record('Approvals', 'Expand approval item', expandedContent.substring(500, 700));

        // Now check for action buttons
        const approveBtn = await page.$('button:has-text("Approve")');
        const reviseBtn = await page.$('button:has-text("Revise & resume")');
        const rejectBtn = await page.$('button:has-text("Reject")');

        record('Approvals', 'Approval action buttons', `Approve=${!!approveBtn}, Revise=${!!reviseBtn}, Reject=${!!rejectBtn}`);

        // Check if there's a textarea for revision notes
        const notesField = await page.$('textarea, input[placeholder*="note" i], input[placeholder*="revision" i]');
        if (notesField) {
          record('Approvals', 'Revision notes field', 'Text area for revision notes present');
        }

        // Check for the command preview
        const commandPreview = await page.evaluate(() => {
          const code = document.querySelector('code, pre, [class*="command"], [class*="bash"]');
          return code?.textContent?.substring(0, 200) || 'No command preview';
        });
        console.log('Command preview:', commandPreview);
        record('Approvals', 'Command preview in approval', commandPreview.substring(0, 150));

        // Check for "Revision notes" textarea
        const revisionNotes = await page.$('textarea[placeholder*="revision" i]') ||
                              await page.$('textarea[placeholder*="note" i]') ||
                              await page.$('textarea');
        if (revisionNotes) {
          const ph = await revisionNotes.getAttribute('placeholder');
          record('Approvals', 'Revision notes textarea', `Placeholder: "${ph}"`);
          await revisionNotes.fill('Approved for testing purposes');
          await sleep(300);
        }
      }

      const s = await shot(page, 'approvals-with-actions');
      record('Approvals', 'Approvals UI with action buttons', `Screenshot: ${s}`);

    } catch(e) {
      record('Approvals', 'Approvals interaction', `Error: ${e.message}`);
    } finally {
      await page.close();
    }
  }

  // =============================================
  // Check: Skills page - what "+ Create Skill" does
  // =============================================
  console.log('\n=== Skills: Create Skill Form ===');
  {
    const page = await newPage();
    try {
      await page.goto('http://localhost:8888/skills', { waitUntil: 'domcontentloaded' });
      await sleep(2000);
      await shot(page, 'skills-before-create');

      const createSkillBtn = await page.$('button:has-text("+ Create Skill")') ||
                             await page.$('button:has-text("Create Skill")');
      if (createSkillBtn) {
        await createSkillBtn.click();
        await sleep(1500);
        await shot(page, 'skills-after-create-click');

        const bodyText = await page.evaluate(() => document.body.innerText.substring(200, 2000));
        console.log('After Create Skill click:', bodyText.substring(0, 600));
        record('Skills', 'Create Skill click result', bodyText.substring(0, 200));

        // Check if we navigated somewhere
        const url = page.url();
        console.log('URL after click:', url);
        if (url !== 'http://localhost:8888/skills') {
          record('Skills', 'Create Skill navigation', `Navigated to: ${url}`);
        }

        // Look for form
        const form = await page.$('form');
        const modal = await page.$('[role="dialog"]');
        if (form || modal) {
          const formText = await (form || modal)?.evaluate(el => el.textContent?.substring(0, 400));
          record('Skills', 'Create Skill form', formText?.substring(0, 200));
        }

        // Check if a chat session opened with the skill-creator
        if (bodyText.includes('skill') || bodyText.includes('SKILL') || bodyText.includes('playbook')) {
          record('Skills', 'Create Skill opens assistant chat', 'Appears to open a chat for skill creation');
        }
      }

      // Also check what clicking on an existing skill does
      await page.goto('http://localhost:8888/skills', { waitUntil: 'domcontentloaded' });
      await sleep(2000);

      const cronManagerSkill = await page.$('text=cron-manager');
      if (cronManagerSkill) {
        await cronManagerSkill.click();
        await sleep(1000);
        await shot(page, 'skills-cron-manager-clicked');
        const content = await page.evaluate(() => document.body.innerText.substring(200, 1000));
        record('Skills', 'Click cron-manager skill', content.substring(0, 200));

        // Check for skill details panel
        const detailText = await page.evaluate(() => {
          const detail = document.querySelector('[class*="detail"], [class*="Detail"]');
          return detail?.textContent?.substring(0, 400);
        });
        if (detailText) {
          record('Skills', 'Skill detail panel', detailText.substring(0, 200));
        }
      }

    } catch(e) {
      record('Skills', 'Skills create', `Error: ${e.message}`);
    } finally {
      await page.close();
    }
  }

  // =============================================
  // Check: Limits - page seems empty
  // =============================================
  console.log('\n=== Limits: Detailed check ===');
  {
    const page = await newPage();
    try {
      await page.goto('http://localhost:8888/limits', { waitUntil: 'domcontentloaded' });
      await sleep(3000); // Extra wait for potential async load

      const s1 = await shot(page, 'limits-after-wait');
      const bodyText = await page.evaluate(() => document.body.innerText);
      console.log('Limits content after 3s wait:', bodyText);
      record('Limits', 'Limits page after full load', bodyText.substring(200, 600) || 'Empty page');

      // Check if page is rendering at all
      const bodyHTML = await page.evaluate(() => document.body.innerHTML.substring(0, 2000));
      console.log('Limits HTML:', bodyHTML.substring(0, 500));

      if (bodyText.trim().length < 200) {
        record('Limits', 'Limits page state', 'Page appears nearly empty or not loading content', ['BUG: Limits page (/limits) appears empty - content not loading or component not rendering']);
      } else {
        record('Limits', 'Limits page state', 'Page has content');
      }

      // Try scrolling to find content
      await page.evaluate(() => window.scrollTo(0, 500));
      await sleep(300);
      await shot(page, 'limits-scrolled');

    } catch(e) {
      record('Limits', 'Limits page', `Error: ${e.message}`);
    } finally {
      await page.close();
    }
  }

  // =============================================
  // Check: Archive items
  // =============================================
  console.log('\n=== Archive: Detailed check ===');
  {
    const page = await newPage();
    try {
      await page.goto('http://localhost:8888/archive', { waitUntil: 'domcontentloaded' });
      await sleep(2000);

      const bodyText = await page.evaluate(() => document.body.innerText);
      console.log('Archive full content:', bodyText.substring(200, 1500));
      record('Archive', 'Archive full content', bodyText.substring(200, 600));

      // Check left panel (list of archives)
      const leftPanel = await page.evaluate(() => {
        const panels = document.querySelectorAll('[class*="panel"], [class*="sidebar"], aside');
        return Array.from(panels).map(p => p.textContent?.trim().substring(0, 200)).filter(Boolean);
      });
      console.log('Left panels:', leftPanel);

      // Try clicking items in the list
      const archiveListBtns = await page.$$('button:not(:has-text("Theme")):not(:has-text("Chat")):not(:has-text("Organization"))');
      console.log(`Non-nav buttons on archive: ${archiveListBtns.length}`);

      for (let i = 0; i < Math.min(archiveListBtns.length, 3); i++) {
        const btn = archiveListBtns[i];
        const txt = await btn.evaluate(el => el.textContent?.trim().substring(0, 100));
        const visible = await btn.isVisible();
        if (visible && txt) console.log(`  Archive btn ${i}: "${txt}"`);
      }

      await shot(page, 'archive-detailed');
    } catch(e) {
      record('Archive', 'Archive detailed', `Error: ${e.message}`);
    } finally {
      await page.close();
    }
  }

  // =============================================
  // Final: Check console errors count
  // =============================================
  console.log('\n=== Collecting Console Errors Summary ===');
  {
    const page = await newPage();
    const pageErrors = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        pageErrors.push({ url: page.url(), text: msg.text() });
      }
    });

    const pagesToCheck = [
      'http://localhost:8888/',
      'http://localhost:8888/org',
      'http://localhost:8888/kanban',
      'http://localhost:8888/approvals',
      'http://localhost:8888/settings',
      'http://localhost:8888/cron',
      'http://localhost:8888/limits',
      'http://localhost:8888/skills',
      'http://localhost:8888/archive',
      'http://localhost:8888/logs',
    ];

    for (const url of pagesToCheck) {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await sleep(1500);
    }

    console.log(`Total console errors from page crawl: ${pageErrors.length}`);
    const errorsByPage = {};
    for (const err of pageErrors) {
      const p = new URL(err.url).pathname;
      if (!errorsByPage[p]) errorsByPage[p] = [];
      errorsByPage[p].push(err.text);
    }
    console.log('Errors by page:');
    for (const [p, errs] of Object.entries(errorsByPage)) {
      const unique = [...new Set(errs)];
      console.log(`  ${p}: ${unique.length} unique errors`);
      for (const e of unique.slice(0, 3)) {
        console.log(`    - ${e.substring(0, 100)}`);
      }
    }

    for (const [path, errs] of Object.entries(errorsByPage)) {
      const unique = [...new Set(errs)];
      if (unique.length > 0) {
        record('Console Errors', `Page ${path}`, `${unique.length} unique errors`, unique.slice(0, 3).map(e => `${path}: ${e.substring(0, 100)}`));
      }
    }

    await page.close();
  }

  await browser.close();
  appendReport(allFindings, consoleErrors);
}

function appendReport(findings, consoleErrors) {
  const allIssues = findings.flatMap(f => f.issues);

  let md = `\n\n---\n\n# Part 3: Bug Investigation Results\n\n`;
  md += `**Date:** ${new Date().toISOString()}\n\n`;

  md += `## Confirmed Bugs & Issues\n\n`;
  for (const issue of allIssues) {
    md += `- ${issue}\n`;
  }

  md += `\n## Detailed Investigation\n\n`;
  const sections = {};
  for (const f of findings) {
    if (!sections[f.section]) sections[f.section] = [];
    sections[f.section].push(f);
  }

  for (const [section, items] of Object.entries(sections)) {
    md += `### ${section}\n\n`;
    for (const item of items) {
      md += `**${item.action}:** ${item.result}\n\n`;
      if (item.issues.length > 0) {
        for (const issue of item.issues) md += `> BUG: ${issue}\n`;
        md += `\n`;
      }
    }
  }

  const existing = fs.readFileSync('/tmp/user-exploration-log.md', 'utf8');
  fs.writeFileSync('/tmp/user-exploration-log.md', existing + '\n' + md);
  console.log(`\nPart 3 appended. Total new issues: ${allIssues.length}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
