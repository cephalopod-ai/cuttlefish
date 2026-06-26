---
name: find-and-install
description: Find and install skills from skills.sh when a capability gap is detected
---

# Find & Install Skills

## Trigger

This skill activates when you detect a capability gap that a community skill might fill, the user explicitly asks to find or install a skill and a task would benefit from a specialized skill you don't currently have

## Searching for Skills

Run a search using the skills CLI:

```bash
npx skills find [query]
```

Review the results and assess trust level before suggesting:

- 🟢 **VERIFIED** (1000+ installs or known orgs like `vercel-labs`, `anthropics`, `microsoft`): Suggest confidently
- 🟡 **COMMUNITY** (50–999 installs): Suggest with a note about the install count
- 🔴 **UNKNOWN** (<50 installs): Show but warn the user - offer to preview the SKILL.md before installing

## Installing a Skill

Once the user approves (or for 🟢 VERIFIED skills when you're confident it fits):

### Step 1: Install globally

```bash
npx skills add <owner/repo@skill> -g -y
```

This places files into `~/.claude/skills/<name>/` or `~/.agents/skills/<name>/`.

### Step 2: Copy into {{portalSlug}} skills directory

```bash
cp -r ~/.claude/skills/<name>/ ~/.{{portalSlug}}/skills/<name>/
```

The {{portalName}} file watcher will detect the new directory and create the appropriate symlinks automatically.

### Step 3: Update the skills manifest

Read `~/.{{portalSlug}}/skills.json`, add the new skill entry, and write it back.

The manifest format:

```json
{
  "installed": {
    "<name>": {
      "source": "<owner/repo@skill>",
      "installedAt": "<ISO 8601 timestamp>"
    }
  }
}
```

### Step 4: Apply the skill immediately

Read the newly installed `~/.{{portalSlug}}/skills/<name>/SKILL.md` and follow its instructions to complete the current task.

## When No Skills Are Found

If `npx skills find` returns no results:

1. Offer to help the user directly with the task using your built-in capabilities
2. Suggest creating a custom skill if this is a recurring need (use the `skill-creator` skill)

## Examples

**User asks to deploy to Vercel:**

```bash
npx skills find "vercel deploy"
# → vercel-labs/ai-skills@vercel-deploy (🟢 VERIFIED, 5200 installs)
npx skills add vercel-labs/ai-skills@vercel-deploy -g -y
cp -r ~/.claude/skills/vercel-deploy/ ~/.{{portalSlug}}/skills/vercel-deploy/
# → update skills.json → read SKILL.md → follow deploy instructions
```

**User asks for an obscure skill:**

```bash
npx skills find "arduino serial monitor"
# → random-user/arduino-tools@serial-monitor (🔴 UNKNOWN, 12 installs)
# → Warn user, offer to preview SKILL.md before installing
```
