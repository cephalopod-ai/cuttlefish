---
name: showcase-video-capture
description: Create polished Cuttlefish product showcase videos, GIFs, and README demo assets from isolated mock or sandbox instances. Use when asked to record a Cuttlefish web UI walkthrough, update the README showcase GIF, build a mock gateway or clean test instance, script UI animations, capture Playwright video, convert WebM to MP4/GIF, or document video-capture gotchas for the Cuttlefish platform.
---

# Showcase Video Capture

Use this skill to produce deterministic Cuttlefish showcase media without touching a live operator instance. The goal is a short, readable product story: a believable org, visible work state, live chat streaming, and a clean final GIF/MP4 suitable for GitHub.

## Core Rules

- Keep the live gateway safe. Do not use port `8888` or the operator's real `~/.cuttlefish` unless the user explicitly asks for live-instance work.
- Prefer a mock gateway for README/demo captures. It is deterministic, fast, and avoids real engines, connectors, credentials, sessions, cron, and private data.
- Keep all committed fixtures generic. Do not commit personal paths, private project names, real customer data, tokens, or machine-specific paths.
- Stage only the intended media asset when replacing the README GIF. Leave capture scripts, raw videos, and scratch outputs untracked unless the user asks to keep them.
- Make the video feel like the product, not a landing page. Show the actual UI, real navigation, plausible session state, and a live streamed final answer.

## Recommended Flow

1. Confirm the target asset and story.
   - README asset is usually `assets/cuttlefish-showcase.gif`.

2. Create an isolated capture sandbox.
   - Use a separate directory such as `/tmp/cuttlefish-showcase-*` or a repo-external scratch directory.
   - Use a non-live port such as `7788`.
   - Verify the port is free before and after:
     ```bash
     lsof -nP -iTCP:7788 -sTCP:LISTEN || true
     ```
   - Do not run against the live gateway unless the user specifically requests it.

3. Build a mock gateway for deterministic captures.
   - Serve the built web bundle from `packages/cuttlefish/dist/web`.
   - Implement just enough API surface for the UI path being captured.
   - Provide mock WebSocket events for chat streaming.
   - Add a manual trigger endpoint for the demo stream, for example `/api/showcase/start-demo`, so navigation can happen first and the chat stream can be last.

4. Script the capture with Playwright.
   - Use `@playwright/test` from the repo if plain `playwright` is not installed.
   - Record at 1280x720 for MP4.
   - Export GIF at 960x540, 12 fps, with a generated palette.
   - Capture stills for visual QA at representative timestamps.

5. Validate before handing off.
   - Run `node --check` on scripts.
   - Run the recorder end to end.
   - Check `ffprobe` dimensions and duration.
   - Inspect still frames with the local image viewer.
   - Confirm no browser console errors were captured.
   - Confirm the sandbox port is no longer listening.

## Mock Gateway Pattern

For a capture-only sandbox, a small Node server is usually enough:

- Static files:
  - Serve `packages/cuttlefish/dist/web`.
  - Fallback unknown paths to `index.html` so client routes load.

- REST endpoints commonly needed by the web UI:
  - `GET /api/status`
  - `GET /api/instances`
  - `GET /api/onboarding`
  - `GET /api/config`
  - `GET /api/engines`
  - `GET /api/engine-limits`
  - `GET /api/sessions`
  - `GET /api/sessions/:id`
  - `GET /api/sessions/:id/children`
  - `GET /api/sessions/:id/queue`
  - `GET /api/org`
  - `GET /api/org/employees/:name`
  - `GET /api/org/departments/:name/board`
  - `GET /api/cron`
  - `GET /api/logs`
  - `GET /api/stt/status`
  - `GET /api/talk/status`

- WebSocket:
  - Accept `/ws`.
  - Reply to `ping` with `pong`.
  - Broadcast frames as `{"event":"session:delta","payload":...,"ts":...}`.

- Demo trigger:
  - Do not auto-start the stream on WebSocket connection if the chat is not the first scene.
  - Add a route such as `GET /api/showcase/start-demo` that schedules the stream only when the recorder is on the chat scene.

Keep mock data plausible and generic. Example org shape for a balanced 11-specialist showcase:

- Product: Launch Lead, Research Agent, QA Agent
- Design: Design Agent, Motion Agent, Mobile Agent
- Growth: Growth Agent, Support Agent, Content Agent
- Operations: Ops Lead, Cron Agent

Include an explicit executive/operator node in `/api/org` when the org map expects one. If the root is only named in hierarchy metadata but not included in `employees`, layout may degrade or fall back.

## Capture Script Pattern

Use Playwright to drive the real UI, not screenshots stitched by hand.

Important setup:

```js
const { chromium } = require("@playwright/test");

const context = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  deviceScaleFactor: 1,
  colorScheme: "dark",
  recordVideo: { dir: rawVideoDir, size: { width: 1280, height: 720 } },
});

await context.addInitScript(() => {
  localStorage.clear();
  localStorage.setItem("cuttlefish-theme", "dark");
  localStorage.setItem("cuttlefish-sidebar-focus-mode", "all");
  localStorage.setItem("cuttlefish-sidebar-older-expanded", "true");
});
```

Recording gotchas:

- Playwright writes the raw `.webm` only after `context.close()`. Do not look for the video before closing the context.
- Capture browser console errors during the run and write them to a file only if non-empty.
- Use a `finally` block to close the browser and kill the mock gateway.
- Add a small in-page cursor overlay if the UI interactions need to read clearly in the final GIF.

Selector gotchas:

- Scope ambiguous labels. `getByText("Design Agent")` can match sidebar rows and org nodes. Prefer:
  ```js
  page.locator(".react-flow__node", { hasText: "Design Agent" }).first()
  ```
- Wait for meaningful UI structure, not only navigation:
  ```js
  await page.locator(".react-flow").waitFor();
  await page.waitForFunction(
    () => document.querySelectorAll(".react-flow__node").length >= 12,
  );
  ```

## Storyboarding Guidance

Use fewer scenes and let each one breathe.

Good README rhythm:

1. Org chart, 2-4 seconds.
   - Show the operating model first.
   - Keep the org readable. 11 specialists plus one executive works well at desktop scale.

2. Kanban, 4-6 seconds.
   - Show active work, review, done, and ownership.
   - Click or hover one high-priority card if the UI supports it.

3. Chat, 12-16 seconds.
   - Open the main session.
   - Trigger live WebSocket deltas only after arriving on chat.
   - Stream a concise final answer that mentions the visible workstreams.
   - Optionally type a final prompt in the composer but do not send it.

Do not put chat first if the user wants chat last. The UI connects to WebSocket early, so auto-started streams will finish before the final scene. The manual trigger endpoint solves this.

## Conversion Commands

Convert raw Playwright WebM to MP4:

```bash
ffmpeg -y \
  -i raw.webm \
  -vf "scale=1280:-2" \
  -movflags +faststart \
  -pix_fmt yuv420p \
  showcase.mp4
```

Convert raw WebM to a compact GIF:

```bash
ffmpeg -y \
  -i raw.webm \
  -vf "fps=12,scale=960:-1:flags=lanczos,palettegen=max_colors=160:reserve_transparent=0" \
  palette.png

ffmpeg -y \
  -i raw.webm \
  -i palette.png \
  -lavfi "fps=12,scale=960:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" \
  -loop 0 \
  showcase.gif
```

Extract QA frames:

```bash
ffmpeg -y -ss 00:00:02 -i showcase.mp4 -frames:v 1 -update 1 frame-02.png
ffmpeg -y -ss 00:00:08 -i showcase.mp4 -frames:v 1 -update 1 frame-08.png
ffmpeg -y -ss 00:00:15 -i showcase.mp4 -frames:v 1 -update 1 frame-15.png
ffmpeg -y -ss 00:00:25 -i showcase.mp4 -frames:v 1 -update 1 frame-25.png
```

Probe final files:

```bash
ffprobe -v error -select_streams v:0 \
  -show_entries stream=width,height,duration,nb_frames \
  -of default=noprint_wrappers=1 \
  showcase.gif
```

Target sizes:

- GIF: under 5 MB for README comfort, ideally around 3 MB.
- MP4: keep as a review artifact even if README uses GIF.
- Duration: 25-35 seconds is enough for a rich but skimmable showcase.

## Replacing The README GIF

When the user asks to replace the existing showcase:

1. Locate the README asset reference:
   ```bash
   rg -n "showcase|\\.gif|assets/" README.md packages/cuttlefish/README.md
   ```

2. Replace only the tracked asset:
   ```bash
   cp /path/to/new-showcase.gif assets/cuttlefish-showcase.gif
   ```

3. Stage only that file:
   ```bash
   git add assets/cuttlefish-showcase.gif
   git diff --cached --stat
   git diff --cached --name-only
   ```

4. Run the public-repo leak grep from the Cuttlefish platform instructions. A binary-only GIF replacement should produce no textual hits.

5. Commit without co-author trailers:
   ```bash
   git commit -m "docs: refresh showcase gif"
   git push origin main
   ```

Leave raw videos, alternate GIFs, and recorder scripts out of the commit unless asked. They often appear as untracked files from previous capture attempts.

## Cleanup Checklist

- `lsof -nP -iTCP:<port> -sTCP:LISTEN || true` shows no sandbox server.
- Browser context is closed so Playwright flushed the video.
- Temporary palette files are deleted.
- `output/console-errors.txt` is absent or reviewed.
- Local scratch files are either outside the repo or intentionally untracked.
- The final answer links the GIF/MP4 paths and states what was verified.

## Common Failure Modes

- **Stream finishes too early:** WebSocket demo starts on first connection. Add a manual start endpoint and call it only on the final chat scene.
- **Selector clicks the wrong thing:** Text labels are duplicated across sidebar, chat, and org. Scope selectors to route-specific containers.
- **No video found:** The Playwright context was not closed yet.
- **GIF is too large:** Lower GIF width to 960, fps to 12, and palette colors to around 160.
- **Org chart is too dense:** Reduce the employee count. For README scale, 11 specialists plus the executive is a practical ceiling.
- **Org chart root missing:** Include the root/executive in `employees`, not only in hierarchy metadata.
- **Live data leak risk:** Mock all sessions, org names, cron jobs, logs, connectors, and settings with generic names.
- **Port conflict:** Check and free the sandbox port before recording; never reuse `8888` for capture sandboxes.
