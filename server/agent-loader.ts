/**
 * agent-loader.ts — Load agent definitions from agents/*.md and skills from skills/.
 *
 * Agent file format follows pi-subagents convention:
 *   - YAML frontmatter: name, description, tools, model, skills
 *   - Markdown body: system prompt
 *
 * Skill directories follow the Agent Skills standard (agentskills.io):
 *   - skills/<name>/SKILL.md with YAML frontmatter (name, description)
 *   - skills/<name>/references/ for on-demand deeper context
 *   - skills/<name>/scripts/ for executable helpers
 *
 * At dispatch time, the agent's referenced skills are injected as an
 * <available_skills> XML block (matching Pi/OpenCode convention).
 * The worker uses read_file to load full skill content on-demand.
 */

import fs from 'fs';
import path from 'path';
import type { AgentTool } from '/usr/lib/node_modules/openclaw/node_modules/@mariozechner/pi-agent-core/dist/index.js';
import type { Model } from '/usr/lib/node_modules/openclaw/node_modules/@mariozechner/pi-ai/dist/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentDef {
  name: string;
  description: string;
  toolNames: string[];
  skillNames: string[];
  modelAlias: string;  // e.g. 'worker', 'research', 'foh' — resolved by caller
  systemPrompt: string;
  filePath: string;
}

export interface SkillDef {
  name: string;
  description: string;
  filePath: string;     // absolute path to SKILL.md
  baseDir: string;      // absolute path to skill directory
}

interface Frontmatter {
  name?: string;
  description?: string;
  tools?: string;
  model?: string;
  skills?: string;
  skill?: string;       // legacy singular form
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

function parseFrontmatter(raw: string): { frontmatter: Frontmatter; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: raw };

  const fm: Frontmatter = {};
  for (const line of match[1].split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim() as keyof Frontmatter;
    const val = line.slice(colonIdx + 1).trim();
    (fm as any)[key] = val;
  }
  return { frontmatter: fm, body: match[2].trim() };
}

function parseCommaSeparated(value: string | undefined): string[] {
  return value
    ? value.split(',').map(s => s.trim()).filter(Boolean)
    : [];
}

function parseAgent(filePath: string): AgentDef {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const { frontmatter, body } = parseFrontmatter(raw);
  const basename = path.basename(filePath, '.md');

  // Support both 'skills' (plural) and 'skill' (legacy singular)
  const skillNames = parseCommaSeparated(frontmatter.skills)
    .concat(parseCommaSeparated(frontmatter.skill));
  // Deduplicate
  const uniqueSkills = [...new Set(skillNames)];

  return {
    name: frontmatter.name || basename,
    description: frontmatter.description || '',
    toolNames: parseCommaSeparated(frontmatter.tools),
    skillNames: uniqueSkills,
    modelAlias: frontmatter.model || 'worker',
    systemPrompt: body,
    filePath,
  };
}

// ---------------------------------------------------------------------------
// Skill loader
// ---------------------------------------------------------------------------

const SKILLS_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'skills');

let skillCache: Map<string, SkillDef> | null = null;

function parseSkill(skillDir: string): SkillDef | null {
  const skillMdPath = path.join(skillDir, 'SKILL.md');
  if (!fs.existsSync(skillMdPath)) return null;

  const raw = fs.readFileSync(skillMdPath, 'utf-8');
  const { frontmatter } = parseFrontmatter(raw);
  const dirName = path.basename(skillDir);

  if (!frontmatter.description) {
    console.warn(`[agent-loader] Skill ${dirName} missing description, skipping`);
    return null;
  }

  return {
    name: frontmatter.name || dirName,
    description: frontmatter.description,
    filePath: skillMdPath,
    baseDir: skillDir,
  };
}

/** Load all skills from skills/ directory. */
export function loadSkills(): Map<string, SkillDef> {
  if (skillCache) return skillCache;
  skillCache = new Map();

  if (!fs.existsSync(SKILLS_DIR)) {
    console.warn(`[agent-loader] No skills directory at ${SKILLS_DIR}`);
    return skillCache;
  }

  const entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
    const skillDir = path.join(SKILLS_DIR, entry.name);
    const def = parseSkill(skillDir);
    if (def) {
      skillCache.set(def.name, def);
      console.log(`[agent-loader] Loaded skill: ${def.name}`);
    }
  }

  console.log(`[agent-loader] ${skillCache.size} skill(s) loaded from ${SKILLS_DIR}`);
  return skillCache;
}

/** Get a single skill by name. */
export function getSkill(name: string): SkillDef | undefined {
  return loadSkills().get(name);
}

/** List all available skill names. */
export function listSkills(): string[] {
  return [...loadSkills().keys()];
}

/**
 * Format skills as XML for injection into a worker's system prompt.
 * Follows the Pi/OpenCode convention for skill discovery.
 * Only includes skills referenced by the agent definition.
 */
export function formatSkillsForPrompt(skillNames: string[]): string {
  const skills = loadSkills();
  const matched = skillNames
    .map(name => skills.get(name))
    .filter((s): s is SkillDef => s !== undefined);

  if (matched.length === 0) return '';

  const lines = [
    '',
    'The following skills provide specialized instructions for specific tasks.',
    'Use the read_file tool to load a skill\'s SKILL.md when the task matches its description.',
    'When a skill file references a relative path (e.g., references/channels.md), resolve it against the skill directory and use that absolute path.',
    '',
    '<available_skills>',
  ];

  for (const skill of matched) {
    lines.push('  <skill>');
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
    lines.push('  </skill>');
  }

  lines.push('</available_skills>');
  return lines.join('\n');
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ---------------------------------------------------------------------------
// Agent loader
// ---------------------------------------------------------------------------

const AGENTS_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'agents');

let agentCache: Map<string, AgentDef> | null = null;

/** Load all agent definitions from agents/ directory. Caches on first call. */
export function loadAgents(): Map<string, AgentDef> {
  if (agentCache) return agentCache;
  agentCache = new Map();

  // Also trigger skill loading
  loadSkills();

  if (!fs.existsSync(AGENTS_DIR)) {
    console.warn(`[agent-loader] No agents directory at ${AGENTS_DIR}`);
    return agentCache;
  }

  const files = fs.readdirSync(AGENTS_DIR)
    .filter(f => f.endsWith('.md') && !f.startsWith('_'));

  for (const file of files) {
    const def = parseAgent(path.join(AGENTS_DIR, file));
    agentCache.set(def.name, def);
    const skillInfo = def.skillNames.length > 0 ? `, skills: ${def.skillNames.join(', ')}` : '';
    console.log(`[agent-loader] Loaded agent: ${def.name} (tools: ${def.toolNames.join(', ')}${skillInfo}, model: ${def.modelAlias})`);
  }

  console.log(`[agent-loader] ${agentCache.size} agent(s) loaded from ${AGENTS_DIR}`);
  return agentCache;
}

/** Get a single agent by name. */
export function getAgent(name: string): AgentDef | undefined {
  return loadAgents().get(name);
}

/** List all available agent names. */
export function listAgents(): string[] {
  return [...loadAgents().keys()];
}

/** Force reload (e.g. after editing agent/skill files at runtime). */
export function reloadAgents(): Map<string, AgentDef> {
  agentCache = null;
  skillCache = null;
  return loadAgents();
}

// ---------------------------------------------------------------------------
// Tool resolution — maps tool name strings to AgentTool objects
// ---------------------------------------------------------------------------

export type ToolFactory = () => AgentTool;
export type WsToolFactory = (ws: any) => AgentTool;

/** Registry entry: either a plain factory or one that needs a WebSocket. */
export type ToolEntry =
  | { type: 'plain'; factory: ToolFactory }
  | { type: 'ws'; factory: WsToolFactory };

const toolRegistry = new Map<string, ToolEntry>();

/** Register a tool factory by name. */
export function registerTool(name: string, entry: ToolEntry): void {
  toolRegistry.set(name, entry);
}

/** Resolve tool name strings from an agent def into AgentTool instances. */
export function resolveTools(toolNames: string[], ws?: any): AgentTool[] {
  const tools: AgentTool[] = [];
  for (const name of toolNames) {
    const entry = toolRegistry.get(name);
    if (!entry) {
      console.warn(`[agent-loader] Unknown tool: ${name}`);
      continue;
    }
    if (entry.type === 'ws') {
      if (!ws) {
        console.warn(`[agent-loader] Tool ${name} requires WebSocket but none provided`);
        continue;
      }
      tools.push(entry.factory(ws));
    } else {
      tools.push(entry.factory());
    }
  }
  return tools;
}
