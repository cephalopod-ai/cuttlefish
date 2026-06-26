// Phase-2 live capture: opens /talk (proxy→7788), POSTs real turns, screenshots
// the WS-driven UI to ~/Downloads/cuttlefish-talk-aura. Gateway must be on 7788.
import { chromium } from "@playwright/test"
import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
const OUT = join(homedir(), "Downloads", "cuttlefish-talk-aura")
mkdirSync(OUT, { recursive: true })
const GW = "http://127.0.0.1:7788", SID = "talk-main"
const post = (text) => fetch(`${GW}/api/talk/turn`, { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({ sessionId: SID, text }) })
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const shot = async (p, n) => { await p.screenshot({ path: join(OUT, n) }); console.log("saved", n) }

const b = await chromium.launch()
const page = await b.newPage({ viewport: { width: 1440, height: 860 }, deviceScaleFactor: 2 })
await page.addInitScript(() => localStorage.setItem("cuttlefish-theme", "dark"))
await page.goto("http://localhost:5174/talk", { waitUntil: "networkidle" })
await sleep(1500)

// Turn 1: org pulse → card + spoken summary
post("What is running across the org right now?").catch(()=>{})
await sleep(9500); await shot(page, "live-1-org-pulse.png")
await sleep(4000)

// Turn 2: delegate to COO → tracker task + card + spoken summary
post("Ask the COO for a one-sentence status of the demo project, and track it.").catch(()=>{})
await sleep(11000); await shot(page, "live-2-thinking-delegating.png")  // mid: thinking + task running
await sleep(13000); await shot(page, "live-3-delegate-done.png")        // task done + card + spoken

await b.close(); console.log("DONE ->", OUT)
