# Cuttlefish Growth Marketing - "Cuttlefish Markets Itself"

> Date: 2026-03-12
> Status: Approved
> Author: Jimbo (COO) + the operator

## Summary

Make cuttlefish public and popular by building a self-marketing automation system using cuttlefish's own multi-agent architecture. The marketing pipeline is both the go-to-market strategy AND the product demo - cuttlefish proves its own value by orchestrating its own growth.

## Competitive Positioning

### Target Audience
Frustrated OpenClaw users + Claude Code / Codex power users who want multi-agent orchestration on top of their existing CLI subscriptions.

### Key Differentiators vs OpenClaw

| Pain Point | OpenClaw | Cuttlefish |
|------------|----------|------|
| Cost | $300-750/mo API bills, runaway loops | $200/mo flat (Anthropic Max via Claude Code CLI) |
| Max subscription | Banned since Jan 2026 (OAuth block) | Works natively (first-party CLI) |
| Security | 512 vulnerabilities, malicious skill store | Local markdown skills, no plugin marketplace |
| Cron scoping | Broken - jobs fire in wrong agent context | Agent-scoped in `jobs.json`, hot-reload |
| Memory | Compaction silently drops context | Delegates to Claude Code CLI's own compaction + persistent `knowledge/` files |
| Slack routing | Agent-to-agent messages silently dropped | Native connector with proper thread/DM/channel routing |
| Org isolation | No session-level access control | Departments, ranks, session isolation per employee |
| Architecture | Custom agentic loop ("brain") | Bus, not brain - delegates to professional CLI tools |

### Sources (for backing claims in posts)
- OpenClaw security: CrowdStrike blog, The Register, XDA
- OAuth ban: openclaw.report, HN discussion, Medium article
- Memory bugs: GitHub #5429, #17034, #7477, #2418
- Cron bugs: GitHub #16053
- Slack bugs: GitHub #15836
- Cost reports: everydayaiblog.com review, user reports

## Repo Foundation

### Rename
- GitHub: `<owner>/legacy-cli` → `<owner>/cuttlefish`
- npm package already `cuttlefish-cli` - no change needed

### README Updates
- Keep current intro (already good)
- Add demo GIF (`assets/cuttlefish-showcase.gif` - converted from desktop recording)
- Fix dev clone URL placeholder (`<owner>/cuttlefish` → `<owner>/cuttlefish`)
- Add "Why Cuttlefish?" or "vs OpenClaw" comparison section (factual, link-backed)

## Marketing Architecture

### Growth Department (new)

Three employees in `~/.cuttlefish/org/growth/`:

| Employee | Role | Engine |
|----------|------|--------|
| `reddit-scout` | Scan target subreddits for opportunities | claude (sonnet for cost efficiency) |
| `x-scout` | Scan X/Twitter for relevant threads | claude (sonnet) |
| `growth-writer` | Draft responses and posts in A/B/C tones | claude (opus for quality) |

### Content Tones (A/B/C testing)

**Tone A - Subtle Infiltrator:**
Helpful technical answers in AI agent threads. Mention cuttlefish only when organically relevant.
Example: *"I ended up wrapping Claude Code CLI in a lightweight gateway so I could add cron + Slack routing. Open sourced it: [link]"*

**Tone B - Direct Challenger:**
Comparison posts targeting OpenClaw pain points.
Example: *"I switched from OpenClaw to a Claude Code wrapper and my monthly bill went from $400 to $200 (Max sub). Here's the architecture..."*

**Tone C - Builder in Public:**
Architecture stories and building journey.
Example: *"I built an AI gateway that uses its own multi-agent system to market itself. Here's how the cron pipeline works..."*

### Target Channels

**Reddit:**
- r/ClaudeAI - primary (Claude users wanting more)
- r/openclaw - frustrated users seeking alternatives
- r/AI_Agents - general agent discussion
- r/LocalLLaMA - self-hosting, cost-conscious users
- r/SideProject - builder audience
- r/selfhosted - infrastructure-minded users

**X/Twitter:**
- Threads about OpenClaw costs/security
- Claude Code tips and workflows
- AI agent architecture discussions

### Keywords to Monitor
- "openclaw cost", "openclaw expensive", "openclaw security", "openclaw alternative"
- "claude code multi agent", "ai agent orchestration", "ai agent framework"
- "claude max subscription", "anthropic api cost"
- "ai assistant framework", "self-hosting ai agents"

## Cron Pipeline

### Daily Schedule

```
09:00  reddit-scout → scan subreddits for fresh opportunities (posts < 24h old)
09:30  x-scout → scan X for relevant threads
10:00  growth-writer → draft responses for top 3-5 opportunities
       → output posted to Slack #cuttlefish-growth for approval
```

### Approval Flow
1. Scouts find opportunities → post summaries to Slack
2. Growth-writer drafts content → posts drafts to Slack with tone label (A/B/C)
3. the operator approves/rejects/edits in Slack
4. Approved content → Claude in Chrome posts to Reddit/X
5. All posting is human-approved, automated execution

### Scouting Method

**Reddit:**
- Reddit API search for keywords across target subreddits
- Apify Reddit monitoring actor (already configured) for real-time keyword alerts
- Filter: posts < 24h old, > 3 upvotes (has traction), no existing cuttlefish mention

**X/Twitter:**
- X API search (OAuth 1.0a, creds in `skills/x-karma/secrets/`)
- Filter: tweets < 24h old, > 5 likes, English language

### Posting Method
- Claude in Chrome browser automation
- Opens Reddit/X in Chrome (logged in as the operator's accounts)
- Posts the approved content
- Screenshots the posted content for records

## Feedback Loop

### Metrics to Track
- Reddit: upvotes, comment count, reply sentiment
- X: likes, retweets, reply count
- GitHub: stars, forks, issues opened
- npm: weekly downloads

### Weekly Review (automated cron)
- Analyze which tone (A/B/C) performed best by engagement metrics
- Update growth-writer's skill with learnings
- Adjust subreddit/keyword priorities based on where engagement is highest
- Report summary to Slack #cuttlefish-growth

### Adaptation Rules
- Tone with highest avg engagement → increase frequency
- Tone with lowest avg engagement → reduce or modify
- New keywords discovered in high-engagement threads → add to scout list
- Subreddits with zero engagement after 2 weeks → deprioritize

## Implementation Order

1. **Now:** Rename repo, add GIF to README, fix clone URL
2. **Now:** Create growth department + employee personas
3. **Now:** Create scout + writer skills with detailed playbooks
4. **Now:** Set up cron jobs (disabled initially, manual testing first)
5. **Day 2-3:** Test pipeline manually - run scouts, review output, post manually
6. **Day 4+:** Enable cron, start approval-based automated posting
7. **Week 2+:** First feedback loop analysis, adjust strategy
8. **Ongoing:** Evolve skills based on data

## Non-Goals (for now)
- ProductHunt launch (save for later when we have stars/traction)
- Hacker News Show HN (save for polished moment)
- Video content / YouTube
- Paid advertising
- Blog / content marketing site
