import { chromium } from "@playwright/test"
import { homedir } from "node:os"; import { join } from "node:path"
const OUT = join(homedir(), "Downloads", "cuttlefish-talk-aura")
const GW = "http://127.0.0.1:7788", SID = "talk-main"
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const b = await chromium.launch()
const page = await b.newPage({ viewport: { width: 1440, height: 860 }, deviceScaleFactor: 2 })
await page.addInitScript(() => localStorage.setItem("cuttlefish-theme", "dark"))
await page.goto("http://localhost:5174/talk", { waitUntil: "networkidle" })
await sleep(1500)
fetch(`${GW}/api/talk/turn`, { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({ sessionId: SID, text: "Ask the COO for a one-sentence status of the demo project, and track it." })}).catch(()=>{})
// Poll the tracker DOM until a task row shows a done/result, max 50s.
let done = false
for (let i = 0; i < 25 && !done; i++) {
  await sleep(2000)
  done = await page.evaluate(() => /ALL DONE|revenue|chat app|done/i.test(document.querySelector(".tracker")?.textContent || ""))
}
await sleep(1500)
await page.screenshot({ path: join(OUT, "live-3-delegate-done.png") })
console.log("done-state captured:", done)
await b.close()
