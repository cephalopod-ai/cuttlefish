import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';

const home = process.env.CUTTLEFISH_HOME;
assert(home && path.basename(home).startsWith('authority-gateway-'));
os.homedir = () => path.join(home, 'personal');
syncBuiltinESMExports();
const paths = await import('../../../shared/paths.js');
for (const value of Object.values(paths.getCuttlefishPaths())) assert(value.startsWith(home + path.sep) || value === home);
assert(paths.INSTANCES_REGISTRY.startsWith(home + path.sep));
const registry = await import('../../../sessions/registry.js');
const { SessionQueue } = await import('../../../sessions/queue.js');
const { handleApiRequest } = await import('../../api.js');
const { createGatewayTransports } = await import('../../server/transports.js');
const effects = [];
const queue = new SessionQueue({ pauseMaxWaitMs: 0 });
const engine = { name: 'codex', executionCapabilities: { readOnly: true }, async run(opts) {
  effects.push({ sessionId: opts.sessionId, restricted: opts.restrictToJudgeOnly === true });
  process.send?.({ event: 'inert:dispatch', payload: { sessionId: opts.sessionId } });
  if (opts.prompt.includes('CUT-EA-HOLD')) await new Promise(() => {});
  return { sessionId: 'inert-engine', result: 'Observed inert completion; quoted old approval remains evidence.', numTurns: 1 };
}, kill() {}, killAll() {}, isAlive() { return false; } };
const config = { gateway: { host: '127.0.0.1', port: 0 }, engines: { default: 'codex', codex: { bin: process.execPath, model: 'gpt-5.5' } },
  models: { codex: { models: [{ id: 'gpt-5.5' }, { id: 'gpt-5.6-luna' }] } }, sessions: { autoResumeOnBoot: true }, context: { maxChars: 1000 } };
const context = { config, getConfig: () => config, sessionManager: { getQueue: () => queue, getEngine: () => engine },
  connectors: new Map(), startTime: Date.now(), apiToken: 'inert-operator-test-token', emit(event, payload) { process.send?.({ event, payload }); } };
registry.initDb();
const recovered = registry.recoverStaleQueueItems();
const transport = createGatewayTransports({ apiContext: context, authRequiredNow: () => true, gatewayAuthToken: context.apiToken,
  gatewayName: 'isolated-authority-test', handleApiRequest: (req, res) => { void handleApiRequest(req, res, context); },
  handleTwilioWebhook: async () => { throw new Error('Real connectors are forbidden in this fixture'); }, host: '127.0.0.1', port: 0,
  cuttlefishHome: home, ptyViewEngines: {}, getSession: registry.getSession, webDir: path.join(home, 'web'), wsClients: new Set(), a2aAdapter: { handles: () => false } });
await transport.startListening();
process.send?.({ event: 'ready', port: transport.server.address().port, recovered, paths: paths.getCuttlefishPaths(), personalHome: os.homedir() });
process.on('message', (message) => {
  if (message.command === 'inspect') process.send?.({ event: 'inspection', requestId: message.requestId, effects,
    session: registry.getSession(message.sessionId), messages: registry.getMessages(message.sessionId),
    queue: registry.initDb().prepare('SELECT id, status, dispatch_authority FROM queue_items WHERE session_id = ?').all(message.sessionId) });
});
