/**
 * agent-loader.ts — Load agent definitions from agents/*.md files.
 *
 * File format follows pi-subagents convention:
 *   - YAML frontmatter: name, description, tools, model, skill, thinking
 *   - Markdown body: system prompt
 *
 * The loader parses these into AgentDef objects that can be wired
 * directly into WorkerAgent instances.
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
  modelAlias: string;  // e.g. 'worker', 'research', 'foh' — resolved by caller
  systemPrompt: string;
  skills: string[];
  filePath: string;
}

interface Frontmatter {
  name?: string;
  description?: string;
  tools?: string;
  model?: string;
  skill?: string;
  thinking?: string;
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

function parseAgent(filePath: string): AgentDef {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const { frontmatter, body } = parseFrontmatter(raw);
  const basename = path.basename(filePath, '.md');

  return {
    name: frontmatter.name || basename,
    description: frontmatter.description || '',
    toolNames: frontmatter.tools
      ? frontmatter.tools.split(',').map(t => t.trim()).filter(Boolean)
      : [],
    modelAlias: frontmatter.model || 'worker',
    systemPrompt: body,
    skills: frontmatter.skill
      ? frontmatter.skill.split(',').map(s => s.trim()).filter(Boolean)
      : [],
    filePath,
  };
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

const AGENTS_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'agents');

let cache: Map<string, AgentDef> | null = null;

/** Load all agent definitions from agents/ directory. Caches on first call. */
export function loadAgents(): Map<string, AgentDef> {
  if (cache) return cache;
  cache = new Map();

  if (!fs.existsSync(AGENTS_DIR)) {
    console.warn(`[agent-loader] No agents directory at ${AGENTS_DIR}`);
    return cache;
  }

  const files = fs.readdirSync(AGENTS_DIR)
    .filter(f => f.endsWith('.md') && !f.startsWith('_'));

  for (const file of files) {
    const def = parseAgent(path.join(AGENTS_DIR, file));
    cache.set(def.name, def);
    console.log(`[agent-loader] Loaded agent: ${def.name} (tools: ${def.toolNames.join(', ')}, model: ${def.modelAlias})`);
  }

  console.log(`[agent-loader] ${cache.size} agent(s) loaded from ${AGENTS_DIR}`);
  return cache;
}

/** Get a single agent by name. */
export function getAgent(name: string): AgentDef | undefined {
  return loadAgents().get(name);
}

/** List all available agent names. */
export function listAgents(): string[] {
  return [...loadAgents().keys()];
}

/** Force reload (e.g. after editing agent files at runtime). */
export function reloadAgents(): Map<string, AgentDef> {
  cache = null;
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
