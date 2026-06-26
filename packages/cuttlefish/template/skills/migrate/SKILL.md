---
name: migrate
description: Apply pending version migrations to update this {{portalName}} instance
---

# Migrate Skill

## Trigger

This skill activates when the user runs `/migrate`, when launched by `cuttlefish migrate`, or when asked to update/upgrade the instance.

## Overview

When a new version of Cuttlefish is released, it may include updated skills, new documentation, improved prompts, or config schema changes. These updates are shipped as **migration folders** in `~/.cuttlefish/migrations/<version>/`. Each folder contains:

- `MIGRATION.md` - AI-readable instructions describing exactly what changed
- `files/` - New or updated files in their correct relative directory structure

Your job is to apply these migrations **intelligently** - preserving user customizations while incorporating improvements.

## Steps

### 1. Read Current Version

Read `~/.cuttlefish/config.yaml` and note the `cuttlefish.version` field. If the field is missing, assume `0.0.0`.

### 2. List Pending Migrations

List all directories in `~/.cuttlefish/migrations/`. Each directory name is a semver version string (e.g., `0.2.0`, `0.3.0`).

Sort them in ascending semver order. Filter to only versions **greater than** the current instance version.

If no pending migrations exist, inform the user they are up to date and stop.

### 3. Apply Each Migration In Order

For each pending version, in ascending order:

#### a. Read the Migration Instructions

Read `~/.cuttlefish/migrations/<version>/MIGRATION.md`. This file describes:
- What changed in this version
- Which files are new (safe to copy directly)
- Which files were updated (need intelligent merging)
- Any config schema changes
- Any breaking changes or manual steps

#### b. Follow the Instructions

The MIGRATION.md will categorize changes:

**New files** (safe - just copy):
- Copy from `~/.cuttlefish/migrations/<version>/files/<path>` to `~/.cuttlefish/<path>`
- These are files that didn't exist before - no conflict possible

**Updated files** (needs merge):
- The migration provides the **new template version** of the file
- Read the user's **current version** of the file
- Compare them and merge intelligently:
  - For **CLAUDE.md / AGENTS.md**: Look for new sections in the template that don't exist in the user's file. Append them. Never remove user customizations.
  - For **config.yaml**: Add new keys with their default values. Never overwrite existing user values.
  - For **skills**: If the user hasn't modified the skill (compare with previous template version if available), replace it. If modified, merge new instructions while preserving customizations.
  - For **docs**: Replace entirely - these are reference docs, not user-customized.

**Removed files** (careful):
- Only remove files explicitly listed in MIGRATION.md
- Back up to `<filename>.pre-migration.bak` before removing

#### c. Back Up Before Modifying

Before modifying any existing file, create a backup:
- Copy `file.ext` to `file.ext.pre-<version>.bak`
- Example: `CLAUDE.md` → `CLAUDE.md.pre-0.2.0.bak`

This ensures the user can always recover if something goes wrong.

### 4. Update Version

After all migrations are successfully applied, update `config.yaml`:

```yaml
cuttlefish:
  version: "<final-migrated-version>"
```

### 5. Sync Skill Symlinks

After adding any new skills, ensure their symlinks exist:
- `~/.cuttlefish/.claude/skills/<skill-name>` → `../../skills/<skill-name>`
- `~/.cuttlefish/.agents/skills/<skill-name>` → `../../skills/<skill-name>`

### 6. Clean Up

Remove the applied migration directories from `~/.cuttlefish/migrations/`.
Keep the backup files - the user can delete them manually later.

### 7. Report

Give the user a clear summary:

```
Migration complete: v{old} → v{new}

Added:
- skills/migrate/ (new skill)
- docs/migrations.md (new doc)

Updated:
- CLAUDE.md (added new delegation protocol section)
- config.yaml (added cuttlefish.version field)

Backups created:
- CLAUDE.md.pre-0.2.0.bak
- config.yaml.pre-0.2.0.bak
```

## Merge Strategy Reference

### CLAUDE.md / AGENTS.md Merging

These are the most sensitive files - users heavily customize them. Follow this strategy:

1. **Identify sections** by markdown headings (`# Heading`, `## Heading`)
2. **New sections**: If the template has a section heading that doesn't exist in the user's file, append the entire section
3. **Updated sections**: If both have the same section, keep the user's version unless MIGRATION.md explicitly says to replace it
4. **Deleted sections**: Only remove if MIGRATION.md explicitly says to
5. **Order**: Maintain the user's existing section order; append new sections at the end

### config.yaml Merging

1. **New top-level keys**: Add with their default values
2. **New nested keys**: Add under the existing parent with defaults
3. **Existing keys**: Never overwrite - the user's values take priority
4. **Removed keys**: Only remove if MIGRATION.md explicitly says to (rare)

### Skills Merging

1. **New skill directories**: Copy entirely
2. **Updated skills**: Check if the user's SKILL.md differs from the previous template version
   - If identical (user never customized): replace with new version
   - If different (user customized): merge cautiously, preserving user additions
3. **Supporting files** (data, templates within skill dirs): Update unless user-modified

## Error Handling

- If a migration fails mid-way, **stop**. Do not continue to later versions.
- Note which version failed and what step failed.
- The version in config.yaml was NOT updated yet, so re-running `cuttlefish migrate` will retry.
- If a file conflict cannot be resolved automatically, **ask the user** for guidance.
- If MIGRATION.md is missing from a version folder, skip that version and warn the user.

## Dry Run

If the user asks for a dry run or preview, read all pending MIGRATION.md files and summarize what would change - without modifying any files.
