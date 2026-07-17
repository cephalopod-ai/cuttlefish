import fs from "node:fs"
import http from "node:http"
import path from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const webRoot = path.join(repoRoot, "packages", "cuttlefish", "dist", "web")
const port = Number(process.env.CUTTLEFISH_E2E_PORT || 7779)
const scrollSession = {
  id: "e2e-scroll-session",
  engine: "claude",
  engineSessionId: null,
  source: "web",
  sourceRef: "e2e-scroll-session",
  sessionKey: "e2e-scroll-session",
  employee: null,
  model: "opus",
  title: "E2E scroll fixture",
  status: "idle",
  totalCost: 0,
  totalTurns: 0,
  lastContextTokens: null,
  createdAt: "2026-07-16T00:00:00.000Z",
  lastActivity: "2026-07-16T00:00:00.000Z",
  lastError: null,
}
const scrollMessages = Array.from({ length: 30 }, (_, index) => ({
  id: `e2e-message-${index}`,
  role: index % 2 === 0 ? "user" : "assistant",
  content: `Scroll fixture message ${index + 1}: ${"deterministic content ".repeat(8)}`,
  timestamp: Date.parse("2026-07-16T00:00:00.000Z") + index * 1000,
}))

const jsonFixtures = new Map([
  ["/api/auth/state", {
    authRequired: false,
    authenticated: true,
    canBootstrapLocal: false,
    networkExposed: false,
  }],
  ["/api/onboarding", {
    needed: false,
    onboarded: true,
    sessionsCount: 0,
    hasEmployees: false,
    portalName: "Cuttlefish",
    operatorName: "E2E Operator",
  }],
  ["/api/sessions", { sessions: [scrollSession], counts: { direct: 1 }, perGroup: 50 }],
  ["/api/approvals", []],
  ["/api/checkpoints", []],
  ["/api/cron", []],
  ["/api/command-center", {
    generatedAt: "2026-07-16T00:00:00.000Z",
    summary: { agents: 0, agentsRunning: 0, cronJobs: 0, ticketsOpen: 0, ticketsTotal: 0 },
    ticketCounts: {},
    managers: [],
    availableAgents: [],
  }],
  ["/api/engine-limits", {
    generatedAt: "2026-07-16T00:00:00.000Z",
    default: "claude",
    engines: {},
  }],
  ["/api/org", {
    departments: [],
    employees: [],
    hierarchy: { root: null, sorted: [], warnings: [] },
  }],
  ["/api/workspace-profiles", { profiles: [] }],
  ["/api/engines", {
    default: "claude",
    engines: {
      claude: {
        name: "claude",
        available: false,
        defaultModel: "opus",
        effortMechanism: "claude-flag",
        models: [{ id: "opus", label: "Opus", supportsEffort: true, effortLevels: ["low", "medium", "high"] }],
      },
    },
  }],
  ["/api/skills", []],
])

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
}

function sendJson(res, body, status = 200) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" })
  res.end(JSON.stringify(body))
}

function resolveStaticFile(pathname) {
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "")
  const candidate = path.resolve(webRoot, requested)
  if (!candidate.startsWith(`${webRoot}${path.sep}`) && candidate !== webRoot) return null
  try {
    if (fs.statSync(candidate).isFile()) return candidate
  } catch {
    // SPA routes fall through to index.html.
  }
  return path.join(webRoot, "index.html")
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`)
  if (url.pathname === "/api/readyz") return sendJson(res, { status: "ready" })
  if (url.pathname === `/api/sessions/${scrollSession.id}`) {
    return sendJson(res, { ...scrollSession, messages: scrollMessages })
  }
  if (url.pathname === `/api/sessions/${scrollSession.id}/queue`) return sendJson(res, [])
  if (jsonFixtures.has(url.pathname)) return sendJson(res, jsonFixtures.get(url.pathname))
  if (url.pathname.startsWith("/api/")) {
    return sendJson(res, { error: `No E2E fixture for ${url.pathname}` }, 501)
  }

  const file = resolveStaticFile(url.pathname)
  if (!file) {
    res.writeHead(404)
    res.end("Not found")
    return
  }
  fs.readFile(file, (err, content) => {
    if (err) {
      res.writeHead(500)
      res.end("Built dashboard unavailable; run pnpm build")
      return
    }
    res.writeHead(200, {
      "content-type": contentTypes[path.extname(file)] || "application/octet-stream",
    })
    res.end(content)
  })
})

server.on("upgrade", (_req, socket) => socket.destroy())
server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`Cuttlefish E2E server listening on http://127.0.0.1:${port}\n`)
})

function shutdown() {
  server.closeAllConnections?.()
  server.close(() => process.exit(0))
}

process.once("SIGINT", shutdown)
process.once("SIGTERM", shutdown)
