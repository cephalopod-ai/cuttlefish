# PTY subsidy verification - HONEST status

Date: 2026-06-01. No engine code change. Question: does the live interactive-PTY
Claude path run as cc_entrypoint=cli (Max-subsidized)?

## ⚠️ CORRECTION
An earlier commit message (7e1a47d) said "PROVEN cc_entrypoint=cli". That was an
OVERCLAIM - the SessionStart-hook capture I ran returned None (hook did not fire)
BOTH times. I have NOT empirically captured the entrypoint value this session. The
deductive case is strong, but I am not claiming verified subsidy. Correcting now.

## FACTS (solid)
- Migration is LIVE (1d36d75, gateway PID 30275). Work-turn path = REAL node-pty
  `pty.spawn` (claude-interactive.ts), NOT a stream-json pipe. Routing log:
  "Claude work turns: INTERACTIVE PTY". No -p, no stream-json, no --sdk-url in args.
- Strictly better than before regardless of the open empirical point: we are off
  `claude -p` (the definitely-de-subsidized path).

## DEDUCTIVE case for cli (free-code source - verified reads)
- node-pty child ⇒ process.stdout.isTTY === true.
- main.tsx:803  isNonInteractive = hasPrintFlag||hasInitOnlyFlag||hasSdkUrl||!isTTY ⇒ all FALSE.
- main.tsx:539  CLAUDE_CODE_ENTRYPOINT = isNonInteractive ? 'sdk-cli' : 'cli' ⇒ 'cli'.
- main.tsx:519  a PRE-SET CLAUDE_CODE_ENTRYPOINT is used verbatim (no recompute) - so the
  child must NOT inherit one. buildPtyEnv strips CLAUDECODE + all CLAUDE_CODE_* ⇒ fresh recompute.
This is a strong chain but it is INFERENCE, not a measured value.

## REAL FINDING (verified, important)
The LIVE gateway's own env has CLAUDE_CODE_ENTRYPOINT=sdk-cli and CLAUDECODE=1
(inherited because the deploy ran inside this cuttlefish-dev AGENT's shell, itself a
claude-code process). If the engine did NOT strip env, main.tsx:519 would make every
child inherit sdk-cli ⇒ DE-SUBSIDIZED. buildPtyEnv's strip is therefore LOAD-BEARING
for subsidy. (Confirmed the strip exists and removes both vars.)

## EMPIRICAL: NOT captured this session (honest)
Attempts that failed to yield an attributable value:
- Transcript read: ~/.claude/projects/<repo-id>/ is polluted by every
  claude with cwd ~/.cuttlefish (incl. this agent) ⇒ not attributable.
- Forced --session-id PTY spawns: transcript "NOT FOUND" in-window (throwaway spawn
  killed before persist).
- SessionStart-hook capture (printf $CLAUDE_CODE_ENTRYPOINT > file): hook did not fire
  (None) twice - likely the throwaway session never reached a settled SessionStart, or
  the standalone --settings hook needs the relay the real engine uses.
- Bash output channel also degraded mid-investigation.

## CLEAN verification to run (recommended, in-engine - will be attributable)
Add ONE diagnostic line in claude-interactive.ts: in the SessionStart hook handler the
engine ALREADY receives (via HOOK_RELAY_SCRIPT), log the hook payload's cwd + the
child's CLAUDE_CODE_ENTRYPOINT (the relay can echo `$CLAUDE_CODE_ENTRYPOINT`). Fire ONE
fresh gateway turn; read that single attributable logger line. cli ⇒ subsidy confirmed;
sdk-cli ⇒ the env-strip isn't taking effect on the live path and must be fixed before
trusting subsidy. This uses the engine's own working hook infra (unlike my throwaway).

## Verdict
- Deductively: cli (subsidized) - strong source chain + load-bearing env-strip confirmed present.
- Empirically: UNPROVEN this session. NOT claiming verified subsidy (correcting the 7e1a47d overclaim).
- Migration is live and at worst neutral (off -p). The remaining task is the one
  attributable in-engine entrypoint log above - recommend doing it before declaring subsidy done.
