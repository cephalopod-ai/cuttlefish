// scripts/hermes-acp-smoke.mjs — run: node scripts/hermes-acp-smoke.mjs
import { spawn } from "node:child_process";
const proc = spawn("hermes", ["acp"], { stdio: ["pipe","pipe","ignore"], env: { ...process.env, HERMES_YOLO_MODE:"1", HERMES_ACCEPT_HOOKS:"1" } });
let buf = "", sid = null, answer = "", sawUsage = false, step = 0;
const send = (o) => proc.stdin.write(JSON.stringify(o)+"\n");
proc.stdout.on("data", (d) => {
  buf += d.toString();
  let nl; while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0,nl).trim(); buf = buf.slice(nl+1); if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id === 1 && m.result) send({jsonrpc:"2.0",id:2,method:"session/new",params:{cwd:"/tmp",mcpServers:[]}});
    else if (m.id === 2 && m.result) { sid = m.result.sessionId; console.log("MODELS:", JSON.stringify(m.result.models?.availableModels?.map(x=>x.modelId))); send({jsonrpc:"2.0",id:3,method:"session/prompt",params:{sessionId:sid,prompt:[{type:"text",text:"Reply with exactly the word: ok"}]}}); }
    else if (m.method === "session/update" && m.params.sessionId === sid) {
      const u = m.params.update;
      if (u.sessionUpdate?.startsWith("agent_message")) { const t = u.content?.text ?? u.text ?? ""; if (t) { answer += t; process.stdout.write("[TEXT] "+t+"\n"); } }
      if (u.sessionUpdate === "usage_update") { sawUsage = true; console.log("USAGE:", u.used, "/", u.size); }
    }
    else if (m.id === 3 && m.result) {
      console.log("STOP:", JSON.stringify(m.result));
      if (step === 0) { step = 1; // resume test: load same session in a fresh prompt
        send({jsonrpc:"2.0",id:4,method:"session/prompt",params:{sessionId:sid,prompt:[{type:"text",text:"Reply with exactly the word: again"}]}});
      }
    }
    else if (m.id === 4 && m.result) {
      console.log("RESUME-OK answer so far:", JSON.stringify(answer));
      console.log(answer.toLowerCase().includes("ok") && sawUsage ? "SMOKE PASS" : "SMOKE FAIL");
      proc.kill("SIGTERM"); process.exit(0);
    }
  }
});
send({jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:1,clientCapabilities:{}}});
setTimeout(()=>{ console.log("TIMEOUT"); proc.kill("SIGTERM"); process.exit(1); }, 120000);
