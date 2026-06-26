#!/usr/bin/env bash
# Talk Mission Control smoke: boots an ISOLATED gateway (throwaway CUTTLEFISH_HOME,
# non-8888 port), builds a 2-level delegation tree via the talk APIs, and
# asserts the graph snapshot + delegate validation behave. Engine turns may
# error in the throwaway home — irrelevant; this tests session/graph plumbing.
set -euo pipefail

PORT="${PORT:-7878}"
HOME_DIR="$(mktemp -d /tmp/cuttlefish-mc-smoke.XXXXXX)"
DIST="$(cd "$(dirname "$0")/.." && pwd)/dist/bin/cuttlefish.js"
BASE="http://127.0.0.1:${PORT}"

# Minimal config — loadConfig() requires the file to exist; the port can only
# come from here (no env override).
cat > "${HOME_DIR}/config.yaml" <<EOF
gateway:
  port: ${PORT}
  host: 127.0.0.1
engines:
  default: claude
  claude:
    bin: claude
    model: haiku
  codex:
    bin: codex
    model: gpt-5.5
connectors: {}
logging:
  level: info
EOF

echo "CUTTLEFISH_HOME=${HOME_DIR} port=${PORT}"
CUTTLEFISH_HOME="${HOME_DIR}" node "${DIST}" start &
GW_PID=$!
trap 'kill ${GW_PID} 2>/dev/null || true; sleep 1; rm -rf "${HOME_DIR}"' EXIT

for i in $(seq 1 40); do
  curl -fsS "${BASE}/api/status" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS "${BASE}/api/status" >/dev/null

TALK=$(curl -fsS -X POST "${BASE}/api/talk/session" -H 'Content-Type: application/json' -d '{}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["sessionId"])')
echo "talk session: ${TALK}"

D1=$(curl -fsS -X POST "${BASE}/api/talk/delegate" -H 'Content-Type: application/json' \
  -d "{\"sessionId\":\"${TALK}\",\"thread\":\"new\",\"label\":\"Thread A\",\"brief\":\"Reply with the single word ok.\"}")
COO1=$(echo "${D1}" | python3 -c 'import sys,json;d=json.load(sys.stdin);assert d["created"] is True;print(d["threadId"])')
echo "coo1: ${COO1}"

curl -fsS -X POST "${BASE}/api/talk/delegate" -H 'Content-Type: application/json' \
  -d "{\"sessionId\":\"${TALK}\",\"thread\":\"new\",\"label\":\"Thread B\",\"brief\":\"Reply with the single word ok.\"}" >/dev/null

# grandchild under COO1 (what a COO delegating to an employee does)
curl -fsS -X POST "${BASE}/api/sessions" -H 'Content-Type: application/json' \
  -d "{\"prompt\":\"Reply ok.\",\"parentSessionId\":\"${COO1}\"}" >/dev/null

GRAPH=$(curl -fsS "${BASE}/api/talk/graph?root=${TALK}")
echo "${GRAPH}" | python3 -c '
import sys, json
g = json.load(sys.stdin)
nodes = g["nodes"]
assert len(nodes) == 3, f"expected 3 nodes, got {len(nodes)}: {nodes}"
depths = sorted(n["depth"] for n in nodes)
assert depths == [1, 1, 2], f"bad depths: {depths}"
labels = {n["label"] for n in nodes if n["depth"] == 1}
assert labels == {"Thread A", "Thread B"}, f"bad labels: {labels}"
print("graph snapshot OK:", [(n["label"], n["depth"], n["status"]) for n in nodes])
'

# bad thread id -> 400 with roster
CODE=$(curl -s -o /tmp/delegate-err.json -w '%{http_code}' -X POST "${BASE}/api/talk/delegate" \
  -H 'Content-Type: application/json' \
  -d "{\"sessionId\":\"${TALK}\",\"thread\":\"bogus\",\"brief\":\"x\"}")
test "${CODE}" = "400"
python3 -c 'import json;d=json.load(open("/tmp/delegate-err.json"));assert d.get("threads"),d;print("delegate roster error OK:",[t["label"] for t in d["threads"]])'

# graph root validation: non-talk root -> 400
CODE=$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/api/talk/graph?root=${COO1}")
test "${CODE}" = "400"
echo "graph root validation OK"

# ── (a) Search ───────────────────────────────────────────────────────────────
# Sessions above were created with prompts containing "ok"; those prompts are
# persisted as user messages and indexed by the FTS trigger on INSERT, so the
# search should find them immediately.
SEARCH=$(curl -fsS "${BASE}/api/talk/search?q=ok")
echo "${SEARCH}" | python3 -c '
import sys, json
r = json.load(sys.stdin)
assert r.get("ok") is True, f"expected ok:true, got: {r}"
results = r["results"]
assert len(results) >= 1, f"expected >=1 results, got {len(results)}"
for item in results:
    assert "sessionId" in item, f"missing sessionId in {item}"
    assert "title" in item, f"missing title in {item}"
    assert "hits" in item, f"missing hits in {item}"
print("search OK: found", len(results), "result(s), first sessionId:", results[0]["sessionId"])
'

# ── (b) Attach a standalone (non-owned) session ───────────────────────────────
STANDALONE=$(curl -fsS -X POST "${BASE}/api/sessions" -H 'Content-Type: application/json' \
  -d '{"prompt":"Reply ok."}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
echo "standalone: ${STANDALONE}"

ATTACH_RESP=$(curl -fsS -X POST "${BASE}/api/talk/delegate" -H 'Content-Type: application/json' \
  -d "{\"sessionId\":\"${TALK}\",\"thread\":\"${STANDALONE}\",\"attach\":true}")
echo "${ATTACH_RESP}" | python3 -c '
import sys, json
r = json.load(sys.stdin)
assert r.get("ok") is True, f"attach: expected ok:true, got {r}"
assert r.get("attached") is True, f"attach: expected attached:true, got {r}"
assert r.get("mode") == "observe", f"attach: expected mode observe, got {r}"
print("attach OK: mode=", r["mode"])
'

GRAPH4=$(curl -fsS "${BASE}/api/talk/graph?root=${TALK}")
echo "${GRAPH4}" | python3 -c "
import sys, json
g = json.load(sys.stdin)
nodes = g['nodes']
assert len(nodes) == 4, f'expected 4 nodes after attach, got {len(nodes)}: {nodes}'
attached = [n for n in nodes if n.get('attached') is True]
assert len(attached) == 1, f'expected 1 attached node, got {len(attached)}'
assert attached[0]['depth'] == 1, f'attached node depth must be 1, got {attached[0][\"depth\"]}'
assert attached[0]['id'] == '${STANDALONE}', f'attached node id mismatch: {attached[0][\"id\"]}'
print('graph with attachment OK: 4 nodes, attached node depth=1, id=', attached[0]['id'])
"

# ── (c) Engage+brief on ALREADY attached → 400 ───────────────────────────────
CODE=$(curl -s -o /tmp/attach-dupe.json -w '%{http_code}' -X POST "${BASE}/api/talk/delegate" \
  -H 'Content-Type: application/json' \
  -d "{\"sessionId\":\"${TALK}\",\"thread\":\"${STANDALONE}\",\"attach\":true,\"mode\":\"engage\",\"brief\":\"already here\"}")
test "${CODE}" = "400"
python3 -c "
import json
d = json.load(open('/tmp/attach-dupe.json'))
err = d.get('error', '')
assert '${STANDALONE}' in err or 'already attached' in err, f'unexpected error: {err}'
print('already-attached 400 OK:', err)
"

# ── (d) Detach → 200; graph collapses back to 3 nodes ────────────────────────
DETACH_RESP=$(curl -fsS -X POST "${BASE}/api/talk/delegate" -H 'Content-Type: application/json' \
  -d "{\"sessionId\":\"${TALK}\",\"thread\":\"${STANDALONE}\",\"detach\":true}")
echo "${DETACH_RESP}" | python3 -c '
import sys, json
r = json.load(sys.stdin)
assert r.get("ok") is True, f"detach: expected ok:true, got {r}"
assert r.get("detached") is True, f"detach: expected detached:true, got {r}"
print("detach OK")
'

GRAPH3=$(curl -fsS "${BASE}/api/talk/graph?root=${TALK}")
echo "${GRAPH3}" | python3 -c '
import sys, json
g = json.load(sys.stdin)
nodes = g["nodes"]
assert len(nodes) == 3, f"expected 3 nodes after detach, got {len(nodes)}: {nodes}"
assert not any(n.get("attached") for n in nodes), "no attached nodes expected after detach"
print("graph after detach OK: 3 nodes")
'

# ── (e) Observe-attach WITH brief → 400 (observe cannot send) ─────────────────
# Standalone is no longer attached after step (d), so this reaches the mode check.
CODE=$(curl -s -o /tmp/attach-obs.json -w '%{http_code}' -X POST "${BASE}/api/talk/delegate" \
  -H 'Content-Type: application/json' \
  -d "{\"sessionId\":\"${TALK}\",\"thread\":\"${STANDALONE}\",\"attach\":true,\"brief\":\"will fail\"}")
test "${CODE}" = "400"
python3 -c "
import json
d = json.load(open('/tmp/attach-obs.json'))
err = d.get('error', '')
assert 'observe mode' in err, f'expected observe-mode error, got: {err}'
print('observe-with-brief 400 OK:', err)
"

echo "SMOKE PASSED"
