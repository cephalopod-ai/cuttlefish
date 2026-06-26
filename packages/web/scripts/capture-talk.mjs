// One-off capture script for the /talk AURA POC. Drives the page through its
// states + scripted demo and writes PNGs to ~/Downloads/cuttlefish-talk-aura.
// Run: node packages/web/scripts/capture-talk.mjs  (dev server must be up)
import { chromium } from "@playwright/test"
import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const OUT = join(homedir(), "Downloads", "cuttlefish-talk-aura")
mkdirSync(OUT, { recursive: true })
const URL = "http://localhost:5888/talk"

const shot = async (page, name) => {
  const p = join(OUT, name)
  await page.screenshot({ path: p })
  console.log("saved", p)
}

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })

// Force dark theme for the hero shots.
await page.addInitScript(() => localStorage.setItem("cuttlefish-theme", "dark"))
await page.goto(URL, { waitUntil: "networkidle" })
await page.waitForTimeout(800)

// 1-4: manual state scrub.
for (const s of ["idle", "listening", "thinking", "speaking"]) {
  await page.getByRole("button", { name: new RegExp(`^${s}$`, "i") }).click()
  await page.waitForTimeout(900)
  await shot(page, `aura-${s}.png`)
}

// 5: scripted demo composite (dark) — capture once cards + tracker are settled.
await page.getByRole("button", { name: /play demo/i }).click()
await page.waitForTimeout(9000) // past TASKS_FINAL (8.2s) so all 3 tasks show
await shot(page, "aura-demo-dark.png")

// 6: scripted demo composite (light theme).
await page.evaluate(() => localStorage.setItem("cuttlefish-theme", "light"))
await page.reload({ waitUntil: "networkidle" })
await page.waitForTimeout(800)
await page.getByRole("button", { name: /play demo/i }).click()
await page.waitForTimeout(9000)
await shot(page, "aura-demo-light.png")

await browser.close()
console.log("DONE")
