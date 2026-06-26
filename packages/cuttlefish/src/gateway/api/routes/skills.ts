import fs from "node:fs";
import path from "node:path";
import type { ServerResponse } from "node:http";
import { SKILLS_DIR } from "../../../shared/paths.js";
import { logger } from "../../../shared/logger.js";
import { safeRmSync } from "../../../shared/safe-delete.js";
import { matchRoute } from "../match-route.js";
import { json, notFound } from "../responses.js";

const skillDescriptionCache = new Map<string, { mtimeMs: number; description: string }>();

function parseSkillDescription(content: string): string {
  let description = "";
  const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (frontmatterMatch) {
    const descMatch = frontmatterMatch[1].match(/^description:\s*(.+)$/m);
    if (descMatch) {
      description = descMatch[1].trim();
    }
  }
  if (!description) {
    const triggerMatch = content.match(/##\s*Trigger\s*\n+([^\n#]+)/);
    if (triggerMatch) {
      description = triggerMatch[1].trim();
    } else {
      const bodyContent = frontmatterMatch ? content.slice(frontmatterMatch[0].length) : content;
      const lines = bodyContent.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith("#")) {
          description = trimmed;
          break;
        }
      }
    }
  }
  return description;
}

export async function handleSkillRoutes(
  method: string,
  pathname: string,
  res: ServerResponse,
): Promise<boolean> {
  if (method === "GET" && pathname === "/api/skills") {
    if (!fs.existsSync(SKILLS_DIR)) {
      json(res, []);
      return true;
    }
    const entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
    const skills = entries.filter((entry) => entry.isDirectory()).map((entry) => {
      const skillMdPath = path.join(SKILLS_DIR, entry.name, "SKILL.md");
      const st = fs.statSync(skillMdPath, { throwIfNoEntry: false });
      if (!st) {
        skillDescriptionCache.delete(entry.name);
        return { name: entry.name, description: "" };
      }
      const hit = skillDescriptionCache.get(entry.name);
      if (hit && hit.mtimeMs === st.mtimeMs) return { name: entry.name, description: hit.description };
      const description = parseSkillDescription(fs.readFileSync(skillMdPath, "utf-8"));
      skillDescriptionCache.set(entry.name, { mtimeMs: st.mtimeMs, description });
      return { name: entry.name, description };
    });
    json(res, skills);
    return true;
  }

  let params = matchRoute("/api/skills/:name", pathname);
  if (method === "GET" && params) {
    const skillMd = path.join(SKILLS_DIR, params.name, "SKILL.md");
    if (!fs.existsSync(skillMd)) {
      notFound(res);
      return true;
    }
    const content = fs.readFileSync(skillMd, "utf-8");
    json(res, { name: params.name, content });
    return true;
  }

  params = matchRoute("/api/skills/:name", pathname);
  if (method === "DELETE" && params) {
    const skillDir = path.join(SKILLS_DIR, params.name);
    if (!fs.existsSync(skillDir)) {
      notFound(res);
      return true;
    }
    safeRmSync(skillDir, { within: SKILLS_DIR, label: `skill directory "${params.name}"` });
    const { removeFromManifest } = await import("../../../cli/skills.js");
    removeFromManifest(params.name);
    logger.info(`Skill removed via API: ${params.name}`);
    json(res, { status: "removed", name: params.name });
    return true;
  }

  return false;
}
