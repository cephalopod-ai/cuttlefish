import { chromium } from '/home/ericl/Work/vscode/public_share/cuttlefish/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';
import fs from 'fs';
import path from 'path';

const SCREENSHOTS_DIR = '/tmp/screenshots';
const LOG_FILE = '/tmp/user-exploration-log.md';
fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

let screenshotCount = 100;
const consoleErrors = [];
const networkErrors = [];
const allFindings = [];

async function shot(page, name) {
  screenshotCount++;
  const filename = `${screenshotCount}-${name}.png`;
  const filepath = path.join(SCREENSHOTS_DIR, filename);
  await page.screenshot({ path: filepath, fullPage: true });
  return filename;
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function record(section, action, result, issues = []) {
  allFindings.push({ section, action, result, issues });
  const issueStr = issues.length ? `  !! ISSUE: ${issues.join('; ')}` : '';
  console.log(`  [${section}] ${action}: ${result}${issueStr}`);
}

async function main() {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    recordHar: { path: '/tmp/network.har' }
  });
  const page = await context.newPage();

  page.on('console', msg => {
    if (msg.type() === 'error') {
      consoleErrors.push({ url: page.url(), text: msg.text(), time: new Date().toISOString() });
    }
  });
  page.on('pageerror', err => {
    consoleErrors.push({ url: page.url(), text: `PAGE ERROR: ${err.message}`, time: new Date().toISOString() });
  });
  context.on('requestfailed', req => {
    networkErrors.push({ url: req.url(), failure: req.failure()?.errorText, method: req.method() });
  });

  try {
    // =============================================
    // SECTION 1: Chat / Homepage
    // =============================================
    console.log('\n=== SECTION 1: Chat/Homepage ===');
    await page.goto('http://localhost:8888', { waitUntil: 'networkidle' });
    await sleep(1500);
    const s1 = await shot(page, 'chat-homepage');
    record('Chat', 'Homepage loaded', `Title: Cuttlefish - AI Gateway, screenshot: ${s1}`);

    // Examine left panel employees
    const employeeNames = await page.$$eval('[class*="employee"], [class*="Employee"], [class*="chat"], [class*="Chat"]', els => {
      return els.map(el => el.textContent?.trim().substring(0, 100)).filter(Boolean).slice(0, 20);
    });
    console.log('Employee elements:', employeeNames.slice(0, 5));

    // Check for COO specifically
    const cooEl = await page.$('text=COO');
    const orgStew = await page.$('text=HR / Org Steward');
    if (!cooEl && orgStew) {
      record('Chat', 'Look for COO employee', 'No COO found; "HR / Org Steward" exists instead', ['No COO employee visible on homepage sidebar']);
    }

    // Try clicking on a specific employee to chat with them
    const empLinks = await page.$$('nav a, [role="navigation"] a');
    // Look for employee list entries with click targets
    const sidebarItems = await page.$$('[class*="sidebar"] a, [class*="Sidebar"] a, aside a, .chat-list a');
    console.log(`Sidebar items: ${sidebarItems.length}`);

    // Check if there's employee selection - look for employees in sidebar
    const allText = await page.evaluate(() => document.body.innerText);
    const hasFocused = allText.includes('Focused');
    const hasAll = allText.includes('All');
    record('Chat', 'Chat filter tabs', `Has "Focused"=${hasFocused}, "All"=${hasAll}`);

    // Try clicking the "All" tab
    const allTab = await page.$('button:has-text("All")');
    if (allTab) {
      await allTab.click();
      await sleep(500);
      await shot(page, 'chat-all-tab');
      record('Chat', 'Click "All" tab', 'Tab clicked');
    }

    // Find and click on a specific chat
    const chatItems = await page.$$('[class*="chat-item"], [class*="ChatItem"], [class*="conversation"]');
    console.log(`Chat items: ${chatItems.length}`);

    // Look for the "Senior Security Officer" chat
    const ssoChat = await page.$('text=Senior Security Officer');
    if (ssoChat) {
      await ssoChat.click();
      await sleep(1500);
      await shot(page, 'chat-security-officer-open');
      record('Chat', 'Click Senior Security Officer chat', 'Chat opened');

      // Check what's in the chat
      const chatContent = await page.evaluate(() => document.body.innerText.substring(0, 500));
      console.log('Chat content:', chatContent.substring(200, 400));
    }

    // Go back to home and send a new message
    await page.goto('http://localhost:8888', { waitUntil: 'networkidle' });
    await sleep(1000);

    // Find chat textarea and send a message
    const textarea = await page.$('textarea[placeholder*="message" i]');
    if (textarea) {
      await textarea.click();
      // Check if we need to first select an employee/COO
      const placeholder = await textarea.getAttribute('placeholder');
      record('Chat', 'Chat textarea placeholder', `"${placeholder}"`);

      await textarea.fill('Please start a new project to build a todo app');
      const afterType = await shot(page, 'chat-message-typed');
      record('Chat', 'Type message', `Message typed, screenshot: ${afterType}`);

      // Look for send button - try multiple approaches
      const sendBtn = await page.$('button[type="submit"]') ||
                      await page.$('[aria-label*="send" i]') ||
                      await page.$('button:has-text("Send")');

      if (sendBtn) {
        const btnText = await sendBtn.evaluate(el => el.textContent?.trim());
        const isEnabled = await sendBtn.isEnabled();
        record('Chat', 'Send button state', `Text: "${btnText}", Enabled: ${isEnabled}`);
        await sendBtn.click();
        await sleep(3000);
        await shot(page, 'chat-after-send');
        record('Chat', 'Message sent', 'Clicked send button');
      } else {
        // Try Enter key
        await textarea.press('Enter');
        await sleep(2000);
        await shot(page, 'chat-after-enter');
        record('Chat', 'Message sent via Enter', 'No send button found, tried Enter key', ['Send button not found, had to use Enter']);
      }
    }

    // Check if there's a response or loading state
    const loading = await page.$('[class*="loading"], [class*="spinner"], [class*="typing"]');
    if (loading) {
      record('Chat', 'Loading state visible', 'Loading indicator present after send');
    }

    const s1_final = await shot(page, 'chat-final-state');
    record('Chat', 'Final chat state', `Screenshot: ${s1_final}`);

    // =============================================
    // SECTION 2: Org Chart - Deep Exploration
    // =============================================
    console.log('\n=== SECTION 2: Org Chart ===');
    await page.goto('http://localhost:8888/org', { waitUntil: 'networkidle' });
    await sleep(1500);
    const s2a = await shot(page, 'org-initial');
    record('Org', 'Org page loaded', `Screenshot: ${s2a}`);

    // Read org page content carefully
    const orgText = await page.evaluate(() => document.body.innerText);
    console.log('Org page text excerpt:', orgText.substring(200, 800));

    // Check status metrics
    const statusMetrics = orgText.match(/(Running|Queued|Needs human|Blocked|Failed|Idle)\n\d+/g);
    console.log('Status metrics:', statusMetrics);
    record('Org', 'Status metrics visible', `${statusMetrics ? statusMetrics.join(', ') : 'Not found'}`);

    // Check filters
    const filterTabs = await page.$$('[role="tab"], [class*="tab"], [class*="Tab"]');
    const filterTexts = await Promise.all(filterTabs.map(t => t.textContent()));
    console.log('Filter tabs:', filterTexts.map(t => t?.trim()).filter(Boolean));
    record('Org', 'Org filter tabs', `Tabs: ${filterTexts.map(t => t?.trim()).filter(Boolean).join(', ')}`);

    // Try clicking "engineering" filter
    const engFilter = await page.$('button:has-text("engineering")');
    if (engFilter) {
      await engFilter.click();
      await sleep(500);
      await shot(page, 'org-engineering-filter');
      record('Org', 'Click engineering filter', 'Filter applied');
    }

    // Try clicking an employee card to see details
    const employeeCards = await page.$$('[class*="card"], [class*="Card"], [class*="employee"]');
    console.log(`Employee cards: ${employeeCards.length}`);

    if (employeeCards.length > 0) {
      await employeeCards[0].click();
      await sleep(1000);
      await shot(page, 'org-employee-detail');
      record('Org', 'Click first employee card', 'Employee detail view');

      // Check if a detail panel opened
      const detailPanel = await page.$('[class*="detail"], [class*="Detail"], [role="dialog"]');
      if (detailPanel) {
        const detailText = await detailPanel.evaluate(el => el.textContent?.substring(0, 300));
        record('Org', 'Employee detail panel', `Content: ${detailText?.substring(0, 100)}`);
      }
    }

    // Reset and try "Add agent" button
    await page.goto('http://localhost:8888/org', { waitUntil: 'networkidle' });
    await sleep(1000);

    const addAgentBtn = await page.$('button:has-text("Add agent")');
    if (addAgentBtn) {
      await addAgentBtn.click();
      await sleep(1000);
      const s2b = await shot(page, 'org-add-agent-dialog');
      record('Org', 'Click "Add agent" button', `Dialog opened, screenshot: ${s2b}`);

      // Check what kind of dialog opened
      const dialog = await page.$('[role="dialog"], [class*="modal"], [class*="Modal"]');
      if (dialog) {
        const dialogText = await dialog.evaluate(el => el.textContent?.substring(0, 500));
        console.log('Dialog content:', dialogText?.substring(0, 300));
        record('Org', 'Add agent dialog content', dialogText?.substring(0, 200));

        // Find all form fields
        const inputs = await dialog.$$('input, select, textarea');
        const inputDetails = await Promise.all(inputs.map(async inp => {
          const name = await inp.getAttribute('name') || '';
          const placeholder = await inp.getAttribute('placeholder') || '';
          const type = await inp.getAttribute('type') || 'text';
          const id = await inp.getAttribute('id') || '';
          return { name, placeholder, type, id };
        }));
        console.log('Form inputs:', inputDetails);
        record('Org', 'Add agent form fields', `Fields: ${inputDetails.map(i => i.name || i.placeholder || i.type).join(', ')}`);

        // Fill in the form
        for (const inp of inputs) {
          const placeholder = await inp.getAttribute('placeholder') || '';
          const name = await inp.getAttribute('name') || '';
          const type = await inp.getAttribute('type') || 'text';

          try {
            if (placeholder.toLowerCase().includes('name') || name === 'name') {
              await inp.fill('Alex Johnson');
            } else if (placeholder.toLowerCase().includes('title') || placeholder.toLowerCase().includes('role')) {
              await inp.fill('Senior Engineer');
            } else if (type === 'email' || placeholder.toLowerCase().includes('email')) {
              await inp.fill('alex@company.com');
            } else if (placeholder.toLowerCase().includes('id') || name.toLowerCase().includes('id')) {
              await inp.fill('alex-johnson');
            }
          } catch (e) {
            record('Org', `Fill form field "${placeholder || name}"`, `Error: ${e.message}`, ['Form fill failed']);
          }
        }

        await shot(page, 'org-add-agent-filled');

        // Check for selects/dropdowns
        const selects = await dialog.$$('select');
        for (const sel of selects) {
          const options = await sel.$$eval('option', opts => opts.map(o => o.textContent));
          const label = await sel.getAttribute('name') || '';
          console.log(`Select "${label}":`, options);
          record('Org', `Select dropdown "${label}"`, `Options: ${options.join(', ')}`);
        }

        // Look for submit button
        const submitBtn = await dialog.$('button[type="submit"]') ||
                          await dialog.$('button:has-text("Save")') ||
                          await dialog.$('button:has-text("Create")') ||
                          await dialog.$('button:has-text("Add")');

        if (submitBtn) {
          const btnText = await submitBtn.evaluate(el => el.textContent?.trim());
          const isEnabled = await submitBtn.isEnabled();
          record('Org', 'Add agent submit button', `"${btnText}", enabled=${isEnabled}`);

          if (isEnabled) {
            await submitBtn.click();
            await sleep(2000);
            await shot(page, 'org-after-add-agent');
            record('Org', 'Submit add agent form', 'Form submitted');

            // Check for success/error
            const successMsg = await page.$('[class*="success"], [class*="Success"], [role="alert"]');
            const errorMsg = await page.$('[class*="error"], [class*="Error"]');
            if (successMsg) {
              const msg = await successMsg.evaluate(el => el.textContent?.trim());
              record('Org', 'Add agent result', `Success: ${msg}`);
            } else if (errorMsg) {
              const msg = await errorMsg.evaluate(el => el.textContent?.trim());
              record('Org', 'Add agent result', `Error: ${msg}`, [`Form submission error: ${msg}`]);
            } else {
              record('Org', 'Add agent result', 'No success/error message shown', ['Missing feedback after form submit']);
            }
          } else {
            record('Org', 'Add agent submit', 'Submit button disabled', ['Submit button disabled - possibly form validation issue']);
          }
        } else {
          record('Org', 'Add agent dialog buttons', 'No submit button found', ['No submit/save button in add agent dialog']);
        }

        // Try to close dialog
        const closeBtn = await dialog.$('button:has-text("Cancel")') ||
                         await dialog.$('button[aria-label="Close"]') ||
                         await dialog.$('button:has-text("×")');
        if (closeBtn) {
          await closeBtn.click();
          await sleep(500);
        } else {
          await page.keyboard.press('Escape');
          await sleep(500);
        }
      } else {
        record('Org', 'Add agent dialog', 'No dialog opened after button click', ['Add agent button did not open dialog']);
      }
    } else {
      record('Org', 'Find "Add agent" button', 'Button not found on org page', ['Missing Add agent button']);
    }

    // Click on an employee to see their detail/settings
    await page.goto('http://localhost:8888/org', { waitUntil: 'networkidle' });
    await sleep(1000);

    // Click on "Software Delivery Lead" specifically
    const sdl = await page.$('text=Software Delivery Lead');
    if (sdl) {
      await sdl.click();
      await sleep(1500);
      const s2c = await shot(page, 'org-sdl-detail');
      record('Org', 'Click Software Delivery Lead', `Detail view, screenshot: ${s2c}`);

      const sdlContent = await page.evaluate(() => document.body.innerText.substring(0, 1000));
      console.log('SDL detail:', sdlContent.substring(200, 600));
    }

    // =============================================
    // SECTION 3: Kanban Board - Deep Exploration
    // =============================================
    console.log('\n=== SECTION 3: Kanban ===');
    await page.goto('http://localhost:8888/kanban', { waitUntil: 'networkidle' });
    await sleep(1500);
    const s3a = await shot(page, 'kanban-initial');
    record('Kanban', 'Kanban page loaded', `Screenshot: ${s3a}`);

    const kanbanText = await page.evaluate(() => document.body.innerText);
    console.log('Kanban text:', kanbanText.substring(200, 800));

    // Check columns
    const hasBacklog = kanbanText.includes('Backlog');
    const hasTodo = kanbanText.includes('To Do');
    const hasInProgress = kanbanText.includes('In Progress') || kanbanText.includes('In progress');
    const hasDone = kanbanText.includes('Done') || kanbanText.includes('Complete');
    record('Kanban', 'Kanban columns', `Backlog=${hasBacklog}, ToDo=${hasTodo}, InProgress=${hasInProgress}, Done=${hasDone}`);

    // Check ticket count
    const ticketCount = kanbanText.match(/(\d+)\s*tickets?/i);
    record('Kanban', 'Ticket count', ticketCount ? `${ticketCount[0]}` : 'No count shown');

    // Try "New Ticket" button
    const newTicketBtn = await page.$('button:has-text("New Ticket")');
    if (newTicketBtn) {
      await newTicketBtn.click();
      await sleep(1000);
      const s3b = await shot(page, 'kanban-new-ticket-dialog');
      record('Kanban', 'Click "New Ticket" button', `Dialog opened, screenshot: ${s3b}`);

      const dialog = await page.$('[role="dialog"], [class*="modal"], [class*="Modal"]');
      if (dialog) {
        const dialogText = await dialog.evaluate(el => el.textContent?.substring(0, 600));
        console.log('New ticket dialog:', dialogText);

        const inputs = await dialog.$$('input, textarea, select');
        for (const inp of inputs) {
          const ph = await inp.getAttribute('placeholder') || '';
          const nm = await inp.getAttribute('name') || '';
          const tag = await inp.evaluate(el => el.tagName.toLowerCase());
          console.log(`  Input: tag=${tag}, name=${nm}, placeholder=${ph}`);

          try {
            if (tag === 'textarea' || ph.toLowerCase().includes('desc') || ph.toLowerCase().includes('detail')) {
              await inp.fill('Build user authentication system with OAuth2 support for Google and GitHub sign-in');
            } else if (ph.toLowerCase().includes('title') || nm === 'title') {
              await inp.fill('Implement OAuth2 Authentication');
            } else if (ph.toLowerCase().includes('assignee') || nm === 'assignee') {
              await inp.fill('alex-johnson');
            }
          } catch(e) {}
        }

        await shot(page, 'kanban-new-ticket-filled');

        const submitBtn = await dialog.$('button[type="submit"]') ||
                          await dialog.$('button:has-text("Create")') ||
                          await dialog.$('button:has-text("Save")') ||
                          await dialog.$('button:has-text("Add")');
        if (submitBtn) {
          const btnText = await submitBtn.evaluate(el => el.textContent?.trim());
          const isEnabled = await submitBtn.isEnabled();
          record('Kanban', 'New ticket submit button', `"${btnText}", enabled=${isEnabled}`);

          if (isEnabled) {
            await submitBtn.click();
            await sleep(2000);
            await shot(page, 'kanban-after-new-ticket');
            record('Kanban', 'Submit new ticket', 'Submitted');
          }
        }

        // Close dialog
        const closeBtn = await dialog.$('button:has-text("Cancel")') || await dialog.$('[aria-label="Close"]');
        if (closeBtn) { await closeBtn.click(); await sleep(500); }
        else { await page.keyboard.press('Escape'); await sleep(500); }
      } else {
        record('Kanban', 'New ticket dialog', 'No dialog opened', ['New Ticket button did not open dialog']);
      }
    } else {
      record('Kanban', 'Find New Ticket button', 'Button not found', ['No New Ticket button on kanban page']);
    }

    // Try clicking on an existing ticket
    const existingTicket = await page.$('[class*="ticket"], [class*="Ticket"], [class*="card"]');
    if (existingTicket) {
      await existingTicket.click();
      await sleep(1000);
      const s3c = await shot(page, 'kanban-ticket-detail');
      record('Kanban', 'Click existing ticket', `Detail view, screenshot: ${s3c}`);

      const ticketContent = await page.evaluate(() => document.body.innerText.substring(0, 800));
      console.log('Ticket detail:', ticketContent.substring(200, 500));
    }

    // Check recycle bin feature
    const recycleBin = await page.$('text=Recycle bin');
    if (recycleBin) {
      await recycleBin.click();
      await sleep(500);
      await shot(page, 'kanban-recycle-bin');
      record('Kanban', 'Recycle bin button', 'Clicked, checking behavior');
    }

    // Try the filter dropdowns
    const filterBtns = await page.$$('[class*="filter"], select, [class*="dropdown"]');
    console.log(`Filter elements: ${filterBtns.length}`);

    // =============================================
    // SECTION 4: Settings - Deep Exploration
    // =============================================
    console.log('\n=== SECTION 4: Settings ===');
    await page.goto('http://localhost:8888/settings', { waitUntil: 'networkidle' });
    await sleep(1500);
    const s4a = await shot(page, 'settings-initial');
    record('Settings', 'Settings page loaded', `Screenshot: ${s4a}`);

    const settingsText = await page.evaluate(() => document.body.innerText);
    console.log('Settings text:', settingsText.substring(200, 1500));

    // Find all interactive elements
    const checkboxes = await page.$$('input[type="checkbox"]');
    const switches = await page.$$('[role="switch"]');
    const textInputs = await page.$$('input[type="text"], input[type="number"]');
    const selectEls = await page.$$('select');
    const buttons = await page.$$('button');

    record('Settings', 'Interactive elements count', `Checkboxes=${checkboxes.length}, Switches=${switches.length}, TextInputs=${textInputs.length}, Selects=${selectEls.length}, Buttons=${buttons.length}`);

    // Read each toggle label
    for (let i = 0; i < checkboxes.length; i++) {
      const cb = checkboxes[i];
      const label = await cb.evaluate(el => {
        // Try to find label
        const labelEl = document.querySelector(`label[for="${el.id}"]`) ||
                        el.closest('label') ||
                        el.parentElement;
        return labelEl?.textContent?.trim().substring(0, 100) || el.name || el.id || 'unknown';
      });
      const checked = await cb.isChecked();
      console.log(`  Checkbox ${i}: "${label}" = ${checked}`);
    }

    // Try toggling some checkboxes and check if they persist
    if (checkboxes.length > 0) {
      const cb0 = checkboxes[0];
      const initialState = await cb0.isChecked();
      await cb0.click();
      await sleep(300);
      const newState = await cb0.isChecked();
      record('Settings', 'Toggle first checkbox', `Changed from ${initialState} to ${newState}`);

      // Check if there's a save button or auto-save
      const saveBtn = await page.$('button:has-text("Save"), button:has-text("Apply"), button:has-text("Update")');
      if (saveBtn) {
        record('Settings', 'Save button presence', 'Save button found - settings NOT auto-saved');
        await saveBtn.click();
        await sleep(1000);
        await shot(page, 'settings-after-save');
        record('Settings', 'Click save button', 'Save clicked');
      } else {
        record('Settings', 'Auto-save behavior', 'No save button found - likely auto-save');
      }

      // Reload and check if settings persisted
      await page.reload({ waitUntil: 'networkidle' });
      await sleep(1000);
      const persistedState = await checkboxes[0].isChecked().catch(() => null);
      if (persistedState !== null) {
        if (persistedState === newState) {
          record('Settings', 'Settings persistence', 'Settings persisted after reload');
        } else {
          record('Settings', 'Settings persistence', 'Settings did NOT persist after reload', ['Settings changes not persisted across page reload']);
        }
      }
    }

    const s4b = await shot(page, 'settings-detailed');
    record('Settings', 'Settings detailed view', `Screenshot: ${s4b}`);

    // Examine specific settings sections
    const settingsSections = await page.$$('[class*="section"], [class*="Section"], h2, h3');
    const sectionTexts = await Promise.all(settingsSections.map(s => s.textContent()));
    record('Settings', 'Settings sections', `Sections: ${sectionTexts.map(t => t?.trim()).filter(Boolean).join(', ')}`);

    // =============================================
    // SECTION 5: Cron Jobs - Deep Exploration
    // =============================================
    console.log('\n=== SECTION 5: Cron ===');
    await page.goto('http://localhost:8888/cron', { waitUntil: 'networkidle' });
    await sleep(1500);
    const s5a = await shot(page, 'cron-initial');
    record('Cron', 'Cron page loaded', `Screenshot: ${s5a}`);

    const cronText = await page.evaluate(() => document.body.innerText);
    console.log('Cron text:', cronText.substring(200, 1200));

    // Check if any existing cron jobs
    const hasCronJobs = cronText.length > 500;
    record('Cron', 'Existing cron jobs', hasCronJobs ? 'Page has content' : 'Page appears empty or minimal');

    // Look for add/create button
    const addCronBtn = await page.$('button:has-text("Add"), button:has-text("Create"), button:has-text("New"), button:has-text("Schedule"), button:has-text("+")');
    if (addCronBtn) {
      const btnText = await addCronBtn.evaluate(el => el.textContent?.trim());
      record('Cron', 'Found cron add button', `"${btnText}"`);
      await addCronBtn.click();
      await sleep(1000);
      const s5b = await shot(page, 'cron-add-dialog');
      record('Cron', 'Click add cron button', `Dialog opened, screenshot: ${s5b}`);

      const dialog = await page.$('[role="dialog"], [class*="modal"]');
      if (dialog) {
        const formInputs = await dialog.$$('input, select, textarea');
        for (const inp of formInputs) {
          const ph = await inp.getAttribute('placeholder') || '';
          const nm = await inp.getAttribute('name') || '';
          console.log(`  Cron form: name="${nm}", ph="${ph}"`);

          try {
            if (ph.includes('cron') || ph.includes('expression') || ph.includes('schedule') || nm.includes('cron')) {
              await inp.fill('0 9 * * 1-5');
            } else if (ph.includes('name') || nm === 'name') {
              await inp.fill('Daily Report Generation');
            } else if (ph.includes('command') || nm === 'command') {
              await inp.fill('generate-report --format=pdf');
            }
          } catch(e) {}
        }

        await shot(page, 'cron-form-filled');

        const submitBtn = await dialog.$('button[type="submit"]') ||
                          await dialog.$('button:has-text("Save")') ||
                          await dialog.$('button:has-text("Create")');
        if (submitBtn) {
          await submitBtn.click();
          await sleep(1500);
          await shot(page, 'cron-after-create');
          record('Cron', 'Submit cron job', 'Submitted');
        }
      } else {
        record('Cron', 'Cron add dialog', 'No dialog opened', ['Add cron button did not open dialog']);
      }
    } else {
      record('Cron', 'Find cron add button', 'No add button found', ['No way to create cron jobs found']);
    }

    // =============================================
    // SECTION 6: HR Page - Deep Exploration
    // =============================================
    console.log('\n=== SECTION 6: HR ===');
    await page.goto('http://localhost:8888/hr', { waitUntil: 'networkidle' });
    await sleep(1500);
    const s6a = await shot(page, 'hr-initial');
    record('HR', 'HR page loaded', `Screenshot: ${s6a}`);

    const hrText = await page.evaluate(() => document.body.innerText);
    console.log('HR text:', hrText.substring(200, 1200));
    record('HR', 'HR page content', hrText.substring(200, 400));

    // Check HR page tabs
    const hrTabs = await page.$$('[role="tab"], [class*="tab"]');
    const hrTabTexts = await Promise.all(hrTabs.map(t => t.textContent()));
    record('HR', 'HR tabs', `Tabs: ${hrTabTexts.map(t => t?.trim()).filter(Boolean).join(', ')}`);

    // Try each tab
    for (const tab of hrTabs) {
      const tabText = await tab.evaluate(el => el.textContent?.trim());
      if (tabText) {
        await tab.click();
        await sleep(500);
        await shot(page, `hr-tab-${tabText.replace(/\s+/g, '-').toLowerCase()}`);
        const tabContent = await page.evaluate(() => document.body.innerText.substring(200, 600));
        record('HR', `Tab "${tabText}"`, tabContent.substring(0, 100));
      }
    }

    // Try clicking on employees
    const hrEmployees = await page.$$('[class*="employee"], [class*="Employee"]');
    console.log(`HR employee cards: ${hrEmployees.length}`);

    const s6b = await shot(page, 'hr-final');
    record('HR', 'HR final state', `Screenshot: ${s6b}`);

    // Note: /hr not in nav
    record('HR', 'HR navigation', 'HR page at /hr NOT linked from main navigation', ['HR page (/hr) is not accessible from main nav - hidden/undiscoverable']);

    // =============================================
    // SECTION 7: Skills - Deep Exploration
    // =============================================
    console.log('\n=== SECTION 7: Skills ===');
    await page.goto('http://localhost:8888/skills', { waitUntil: 'networkidle' });
    await sleep(1500);
    const s7a = await shot(page, 'skills-initial');
    record('Skills', 'Skills page loaded', `Screenshot: ${s7a}`);

    const skillsText = await page.evaluate(() => document.body.innerText);
    console.log('Skills text:', skillsText.substring(200, 1200));
    record('Skills', 'Skills page content', skillsText.substring(200, 400));

    // Find skills list
    const skillItems = await page.$$('[class*="skill"], [class*="Skill"]');
    console.log(`Skill items: ${skillItems.length}`);
    record('Skills', 'Skill items', `Found ${skillItems.length} skill elements`);

    // Try add skill button
    const addSkillBtn = await page.$('button:has-text("Add"), button:has-text("Create"), button:has-text("New"), button:has-text("Install")');
    if (addSkillBtn) {
      const btnText = await addSkillBtn.evaluate(el => el.textContent?.trim());
      await addSkillBtn.click();
      await sleep(1000);
      await shot(page, 'skills-add-dialog');
      record('Skills', `Click "${btnText}" button`, 'Checking dialog');

      const dialog = await page.$('[role="dialog"], [class*="modal"]');
      if (dialog) {
        const formContent = await dialog.evaluate(el => el.textContent?.substring(0, 400));
        console.log('Skill dialog:', formContent);
        record('Skills', 'Add skill dialog', formContent?.substring(0, 200));

        const skillInputs = await dialog.$$('input, select, textarea');
        for (const inp of skillInputs) {
          const ph = await inp.getAttribute('placeholder') || '';
          const nm = await inp.getAttribute('name') || '';
          try {
            if (ph.includes('name') || nm === 'name') {
              await inp.fill('Data Analysis');
            } else if (ph.includes('desc') || nm === 'description') {
              await inp.fill('Analyze datasets and generate insights');
            } else if (ph.includes('url') || nm === 'url') {
              await inp.fill('npx data-analysis-skill@latest');
            }
          } catch(e) {}
        }

        await shot(page, 'skills-add-filled');

        const submitBtn = await dialog.$('button[type="submit"]') ||
                          await dialog.$('button:has-text("Add")') ||
                          await dialog.$('button:has-text("Install")') ||
                          await dialog.$('button:has-text("Save")');
        if (submitBtn) {
          await submitBtn.click();
          await sleep(1500);
          await shot(page, 'skills-after-add');
          record('Skills', 'Submit add skill', 'Submitted');
        }

        const closeBtn = await dialog.$('button:has-text("Cancel")') || await dialog.$('[aria-label="Close"]');
        if (closeBtn) await closeBtn.click();
        else await page.keyboard.press('Escape');
        await sleep(500);
      } else {
        record('Skills', 'Add skill', 'No dialog opened', ['Add skill button did not open dialog']);
      }
    } else {
      record('Skills', 'Find add skill button', 'No add button found', ['Cannot find way to add skills']);
    }

    // Try clicking on an existing skill
    const firstSkill = await page.$('[class*="skill-item"], [class*="SkillItem"]');
    if (firstSkill) {
      await firstSkill.click();
      await sleep(500);
      await shot(page, 'skills-detail');
      record('Skills', 'Click skill item', 'Skill detail shown');
    }

    // =============================================
    // SECTION 8: Limits - Deep Exploration
    // =============================================
    console.log('\n=== SECTION 8: Limits ===');
    await page.goto('http://localhost:8888/limits', { waitUntil: 'networkidle' });
    await sleep(1500);
    const s8a = await shot(page, 'limits-initial');
    record('Limits', 'Limits page loaded', `Screenshot: ${s8a}`);

    const limitsText = await page.evaluate(() => document.body.innerText);
    console.log('Limits text:', limitsText.substring(200, 1500));
    record('Limits', 'Limits content', limitsText.substring(200, 500));

    // Check for limit values and interactive elements
    const limitInputs = await page.$$('input[type="number"], input[type="text"], input[type="range"]');
    record('Limits', 'Limit inputs', `Found ${limitInputs.length} inputs`);

    for (let i = 0; i < Math.min(limitInputs.length, 5); i++) {
      const inp = limitInputs[i];
      const val = await inp.inputValue();
      const nm = await inp.getAttribute('name') || '';
      const ph = await inp.getAttribute('placeholder') || '';
      console.log(`  Limit input ${i}: name="${nm}", ph="${ph}", val="${val}"`);
    }

    // Try editing a limit
    if (limitInputs.length > 0) {
      const firstInput = limitInputs[0];
      const oldVal = await firstInput.inputValue();
      await firstInput.triple_click?.() || (await firstInput.click({ clickCount: 3 }));
      await firstInput.fill('100');
      await sleep(300);
      await shot(page, 'limits-edited');
      record('Limits', 'Edit limit value', `Changed from "${oldVal}" to "100"`);

      const saveBtn = await page.$('button:has-text("Save"), button:has-text("Apply"), button:has-text("Update")');
      if (saveBtn) {
        await saveBtn.click();
        await sleep(1000);
        await shot(page, 'limits-saved');
        record('Limits', 'Save limit change', 'Save button clicked');
      }
    }

    const s8b = await shot(page, 'limits-final');
    record('Limits', 'Limits final state', `Screenshot: ${s8b}`);

    // =============================================
    // SECTION 9: Approvals - Deep Exploration
    // =============================================
    console.log('\n=== SECTION 9: Approvals ===');
    await page.goto('http://localhost:8888/approvals', { waitUntil: 'networkidle' });
    await sleep(1500);
    const s9a = await shot(page, 'approvals-initial');
    record('Approvals', 'Approvals page loaded', `Screenshot: ${s9a}`);

    const approvalsText = await page.evaluate(() => document.body.innerText);
    console.log('Approvals text:', approvalsText.substring(200, 1500));
    record('Approvals', 'Approvals content', approvalsText.substring(200, 500));

    // Check for pending items
    const pendingCount = approvalsText.match(/PENDING|Pending/g);
    record('Approvals', 'Pending approvals', `Found ${pendingCount?.length || 0} "pending" mentions`);

    // Find approve/deny buttons
    const approveButtons = await page.$$('button:has-text("Approve"), button:has-text("Accept"), button:has-text("Allow")');
    const denyButtons = await page.$$('button:has-text("Deny"), button:has-text("Reject"), button:has-text("Decline"), button:has-text("Block")');
    record('Approvals', 'Action buttons', `Approve buttons: ${approveButtons.length}, Deny buttons: ${denyButtons.length}`);

    // Look at approval items in detail
    const approvalItems = await page.$$('[class*="approval"], [class*="Approval"], [class*="pending"], [class*="Pending"]');
    console.log(`Approval items: ${approvalItems.length}`);

    if (approvalItems.length > 0) {
      const firstItem = approvalItems[0];
      const itemText = await firstItem.evaluate(el => el.textContent?.substring(0, 300));
      record('Approvals', 'First approval item', itemText?.substring(0, 200));

      // Try clicking the first approval
      await firstItem.click();
      await sleep(1000);
      await shot(page, 'approvals-item-detail');
      record('Approvals', 'Click first approval item', 'Approval detail view');
    }

    // Check if there are "approve all" buttons
    const approveAll = await page.$('button:has-text("Approve All"), button:has-text("Approve all")');
    if (approveAll) {
      record('Approvals', 'Approve All button', 'Button present');
    }

    // Look at individual approval actions
    if (approveButtons.length > 0) {
      // Screenshot but don't click to avoid side effects
      const btnContext = await approveButtons[0].evaluate(el => {
        return el.closest('[class]')?.className || el.parentElement?.textContent?.substring(0, 100);
      });
      record('Approvals', 'First approve button context', btnContext?.substring(0, 100));
    }

    const s9b = await shot(page, 'approvals-final');
    record('Approvals', 'Approvals final state', `Screenshot: ${s9b}`);

    // =============================================
    // SECTION 10: Archive - Deep Exploration
    // =============================================
    console.log('\n=== SECTION 10: Archive ===');
    await page.goto('http://localhost:8888/archive', { waitUntil: 'networkidle' });
    await sleep(1500);
    const s10a = await shot(page, 'archive-initial');
    record('Archive', 'Archive page loaded', `Screenshot: ${s10a}`);

    const archiveText = await page.evaluate(() => document.body.innerText);
    console.log('Archive text:', archiveText.substring(200, 1000));
    record('Archive', 'Archive content', archiveText.substring(200, 400));

    const hasProjects = archiveText.includes('No previous projects') || archiveText.includes('project');
    record('Archive', 'Previous projects', hasProjects ? 'Shows project archive' : 'No projects section found');

    // =============================================
    // SECTION 11: Activity / Logs
    // =============================================
    console.log('\n=== SECTION 11: Activity/Logs ===');
    await page.goto('http://localhost:8888/logs', { waitUntil: 'networkidle' });
    await sleep(1500);
    const s11a = await shot(page, 'logs-initial');
    record('Activity', 'Activity page loaded', `Screenshot: ${s11a}`);

    const logsText = await page.evaluate(() => document.body.innerText);
    console.log('Logs text:', logsText.substring(200, 1200));
    record('Activity', 'Activity page content', logsText.substring(200, 400));

    // =============================================
    // SECTION 12: Talk (AURA)
    // =============================================
    console.log('\n=== SECTION 12: Talk ===');
    await page.goto('http://localhost:8888/talk', { waitUntil: 'networkidle' });
    await sleep(2000);
    const s12a = await shot(page, 'talk-initial');
    record('Talk', 'Talk page loaded', `Screenshot: ${s12a}`);

    const talkText = await page.evaluate(() => document.body.innerText);
    console.log('Talk text:', talkText.substring(0, 500));
    record('Talk', 'Talk page content', talkText.substring(0, 300));

    // Check for "Connecting" state
    const isConnecting = talkText.includes('Connecting');
    if (isConnecting) {
      record('Talk', 'Talk connection state', 'Shows "Connecting" - may indicate voice/WebRTC feature', ['Talk page stuck on "Connecting" state']);
    }

    // =============================================
    // SECTION 13: File viewer feature (discovered in nav)
    // =============================================
    console.log('\n=== SECTION 13: File Viewer ===');
    await page.goto('http://localhost:8888/file?path=packages%2Fcuttlefish%2Fsrc%2Fgateway%2Femployee-execution.ts', { waitUntil: 'networkidle' });
    await sleep(1500);
    await shot(page, 'file-viewer');
    const fileText = await page.evaluate(() => document.body.innerText.substring(0, 500));
    record('File Viewer', 'File viewer with valid path', fileText.substring(0, 200), ['File shows "File not found" even for likely valid paths']);
    console.log('File viewer text:', fileText);

    // =============================================
    // EXTRA: Look at Org page employee details
    // =============================================
    console.log('\n=== EXTRA: Org Employee Interaction ===');
    await page.goto('http://localhost:8888/org', { waitUntil: 'networkidle' });
    await sleep(1500);

    // Try clicking each visible employee card
    const employeeTexts = [
      'Software Delivery Lead',
      'Code Implementer',
      'HR Manager',
    ];

    for (const empName of employeeTexts) {
      const empEl = await page.$(`text=${empName}`);
      if (empEl) {
        // Try finding the clickable parent
        const clickable = await empEl.evaluate(el => {
          let parent = el;
          for (let i = 0; i < 5; i++) {
            if (parent.onclick || parent.tagName === 'A' || parent.tagName === 'BUTTON') return true;
            parent = parent.parentElement;
          }
          return false;
        });

        await empEl.click();
        await sleep(1000);
        await shot(page, `org-employee-${empName.replace(/\s+/g, '-').toLowerCase()}`);

        const content = await page.evaluate(() => document.body.innerText.substring(200, 700));
        record('Org Employee', `Click "${empName}"`, content.substring(0, 150));
      }
    }

    // =============================================
    // EXTRA: Kanban ticket interaction
    // =============================================
    console.log('\n=== EXTRA: Kanban Deep Interaction ===');
    await page.goto('http://localhost:8888/kanban', { waitUntil: 'networkidle' });
    await sleep(1500);

    // Scroll to see more of the kanban
    await page.evaluate(() => window.scrollTo(0, 500));
    await sleep(500);
    await shot(page, 'kanban-scrolled');

    // Try the employee filter dropdowns
    const employeeFilter = await page.$('select, [class*="filter"] select');
    if (employeeFilter) {
      const options = await employeeFilter.$$eval('option', opts => opts.map(o => o.textContent?.trim()));
      record('Kanban', 'Employee filter options', `Options: ${options.join(', ')}`);
      if (options.length > 1) {
        await employeeFilter.selectOption({ index: 1 });
        await sleep(500);
        await shot(page, 'kanban-filtered');
        record('Kanban', 'Apply employee filter', 'Filter applied');
      }
    }

  } catch (err) {
    console.error('\nERROR during exploration:', err.message);
    console.error(err.stack);
    await shot(page, 'error-state').catch(() => {});
    record('Error', 'Script error', err.message, [`Unhandled error: ${err.message}`]);
  } finally {
    await context.close();
    await browser.close();
  }

  // Generate the comprehensive report
  generateReport(allFindings, consoleErrors, networkErrors);
}

function generateReport(findings, consoleErrors, networkErrors) {
  const sections = {};
  for (const f of findings) {
    if (!sections[f.section]) sections[f.section] = [];
    sections[f.section].push(f);
  }

  const allIssues = findings.flatMap(f => f.issues);

  let md = `# Cuttlefish Dashboard - User Exploration Log\n\n`;
  md += `**Date:** ${new Date().toISOString()}\n`;
  md += `**App URL:** http://localhost:8888\n\n`;
  md += `---\n\n`;

  // Summary table
  md += `## Summary Table\n\n`;
  md += `| Feature | Status | Issues Found |\n`;
  md += `|---------|--------|-------------|\n`;

  for (const [section, items] of Object.entries(sections)) {
    const sectionIssues = items.flatMap(i => i.issues);
    const status = sectionIssues.length === 0 ? 'OK' : `${sectionIssues.length} issue(s)`;
    md += `| ${section} | ${status} | ${sectionIssues.slice(0, 2).join('; ') || 'None'} |\n`;
  }

  md += `\n**Total issues found:** ${allIssues.length}\n`;
  md += `**Console errors:** ${consoleErrors.length}\n`;
  md += `**Network failures:** ${networkErrors.length}\n\n`;

  // Issues list
  md += `## All Issues Found\n\n`;
  if (allIssues.length === 0) {
    md += `No issues found.\n\n`;
  } else {
    for (const issue of allIssues) {
      md += `- ${issue}\n`;
    }
    md += `\n`;
  }

  // Console errors
  md += `## Console Errors (${consoleErrors.length})\n\n`;
  if (consoleErrors.length === 0) {
    md += `No console errors.\n\n`;
  } else {
    const uniqueErrors = [...new Map(consoleErrors.map(e => [e.text, e])).values()];
    for (const err of uniqueErrors.slice(0, 30)) {
      md += `**URL:** ${err.url}\n`;
      md += `**Error:** \`${err.text.substring(0, 300)}\`\n\n`;
    }
  }

  // Network errors
  md += `## Network Failures (${networkErrors.length})\n\n`;
  if (networkErrors.length === 0) {
    md += `No network failures.\n\n`;
  } else {
    for (const err of networkErrors.slice(0, 20)) {
      md += `- [${err.method}] ${err.url} → ${err.failure}\n`;
    }
    md += `\n`;
  }

  // Detailed findings per section
  md += `## Detailed Findings\n\n`;
  for (const [section, items] of Object.entries(sections)) {
    md += `### ${section}\n\n`;
    for (const item of items) {
      md += `**Action:** ${item.action}\n\n`;
      md += `**Result:** ${item.result}\n\n`;
      if (item.issues.length > 0) {
        md += `**Issues:**\n`;
        for (const issue of item.issues) {
          md += `- ${issue}\n`;
        }
        md += `\n`;
      }
    }
    md += `---\n\n`;
  }

  // Screenshots index
  md += `## Screenshots\n\n`;
  const screenshots = fs.readdirSync(SCREENSHOTS_DIR).sort();
  for (const s of screenshots) {
    md += `- /tmp/screenshots/${s}\n`;
  }

  fs.writeFileSync(LOG_FILE, md);
  console.log(`\nReport written to: ${LOG_FILE}`);
  console.log(`Screenshots: ${screenshots.length} saved to /tmp/screenshots/`);
  console.log(`Total findings: ${findings.length}`);
  console.log(`Total issues: ${allIssues.length}`);
  console.log(`Console errors: ${consoleErrors.length}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
