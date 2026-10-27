import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type {
  AnyRecord,
  Host,
  McpScope,
  ProviderMcpServer,
  ProviderSkillSource,
  UpsertProviderMcpServerInput,
} from './host.js';
import { AGY_PROJECT_SKILL_DIRS, agyMcpConfigPath, agyUserSkillDirs, PROVIDER_ID } from './paths.js';

const record = (value: unknown): AnyRecord =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as AnyRecord) : {};

const stringMap = (value: unknown): Record<string, string> | undefined => {
  const entries = Object.entries(record(value)).filter(([, entry]) => typeof entry === 'string');
  return entries.length > 0 ? Object.fromEntries(entries) as Record<string, string> : undefined;
};

async function readMcpConfig(): Promise<AnyRecord> {
  try {
    const text = await fs.readFile(agyMcpConfigPath(), 'utf8');
    return text.trim() ? record(JSON.parse(text)) : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw error;
  }
}

/** Writes via a temp file so agy never reads a half-written config. */
async function writeMcpConfig(config: AnyRecord): Promise<void> {
  const target = agyMcpConfigPath();
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  await fs.rename(temp, target);
}

const BROWSER_MCP_NAME = 'cloudcli-browser';

/**
 * Gives agy CloudCLI's managed browser MCP server. CloudCLI writes it into
 * each provider's config only when its Browser feature is switched on, so a
 * provider added later never gets it; Claude's user config always has the
 * current entry while the feature is on, so it is copied from there. Does
 * nothing when the feature is off (no entry) or agy already has it.
 */
export async function syncBrowserMcp(): Promise<void> {
  try {
    const claudeConfig = record(JSON.parse(await fs.readFile(path.join(os.homedir(), '.claude.json'), 'utf8')));
    const source = record(record(claudeConfig.mcpServers)[BROWSER_MCP_NAME]);
    if (typeof source.command !== 'string') {
      return;
    }

    const config = await readMcpConfig();
    const servers = record(config.mcpServers);
    const entry = {
      command: source.command,
      args: Array.isArray(source.args) ? source.args : [],
      ...(stringMap(source.env) ? { env: stringMap(source.env) } : {}),
      disabled: false,
    };
    if (JSON.stringify(servers[BROWSER_MCP_NAME]) !== JSON.stringify(entry)) {
      await writeMcpConfig({ ...config, mcpServers: { ...servers, [BROWSER_MCP_NAME]: entry } });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('[Antigravity] Could not add the browser MCP server:', error instanceof Error ? error.message : error);
    }
  }
}

/**
 * agy keeps user-scoped MCP servers in ~/.gemini/config/mcp_config.json,
 * the file `agy mcp add` writes:
 *   stdio: { command, args, env, disabled }
 *   http:  { serverUrl, headers, disabled }
 */
export function createMcp(host: Host) {
  class AntigravityMcpProvider extends host.bases.McpProvider {
    constructor() {
      super(PROVIDER_ID, ['user'], ['stdio', 'http']);
    }

    protected async readScopedServers(scope: McpScope): Promise<Record<string, unknown>> {
      if (scope !== 'user') {
        return {};
      }
      return { ...record((await readMcpConfig()).mcpServers) };
    }

    protected async writeScopedServers(scope: McpScope, _workspacePath: string, servers: Record<string, unknown>): Promise<void> {
      if (scope !== 'user') {
        return;
      }
      const config = await readMcpConfig();
      await writeMcpConfig({ ...config, mcpServers: servers });
    }

    protected buildServerConfig(input: UpsertProviderMcpServerInput): Record<string, unknown> {
      if (input.transport === 'stdio') {
        return {
          command: input.command,
          args: input.args ?? [],
          ...(input.env && Object.keys(input.env).length > 0 ? { env: input.env } : {}),
          disabled: false,
        };
      }
      return {
        serverUrl: input.url,
        ...(input.headers && Object.keys(input.headers).length > 0 ? { headers: input.headers } : {}),
        disabled: false,
      };
    }

    protected normalizeServerConfig(scope: McpScope, name: string, rawConfig: unknown): ProviderMcpServer | null {
      const config = record(rawConfig);
      const url = typeof config.serverUrl === 'string' ? config.serverUrl : typeof config.url === 'string' ? config.url : undefined;
      if (url) {
        return { provider: PROVIDER_ID, name, scope, transport: 'http', url, headers: stringMap(config.headers) };
      }
      if (typeof config.command !== 'string') {
        return null;
      }
      return {
        provider: PROVIDER_ID,
        name,
        scope,
        transport: 'stdio',
        command: config.command,
        args: Array.isArray(config.args) ? config.args.filter((arg): arg is string => typeof arg === 'string') : [],
        env: stringMap(config.env),
      };
    }
  }

  return new AntigravityMcpProvider();
}

/**
 * Skills agy loads: `<root>/<name>/SKILL.md` under ~/.gemini/skills,
 * ~/.gemini/antigravity-cli/skills and ~/.gemini/config/skills (user), and
 * `.agents/skills` in the workspace (project). New skills go to ~/.gemini/skills.
 */
export function createSkills(host: Host) {
  class AntigravitySkillsProvider extends host.bases.SkillsProvider {
    constructor() {
      super(PROVIDER_ID);
    }

    protected async getSkillSources(workspacePath: string): Promise<ProviderSkillSource[]> {
      const projectRoot = (await host.utils.findTopmostGitRoot(workspacePath)) ?? workspacePath;
      const roots = new Set<string>();
      const sources: ProviderSkillSource[] = [];
      const add = (source: ProviderSkillSource) => {
        const resolved = path.resolve(source.rootDir);
        if (!roots.has(resolved)) {
          roots.add(resolved);
          sources.push({ ...source, rootDir: resolved });
        }
      };

      for (const dir of AGY_PROJECT_SKILL_DIRS) {
        add({ scope: 'project', rootDir: path.join(workspacePath, ...dir), commandPrefix: '/' });
        add({ scope: 'project', rootDir: path.join(projectRoot, ...dir), commandPrefix: '/' });
      }
      for (const rootDir of agyUserSkillDirs()) {
        add({ scope: 'user', rootDir, commandPrefix: '/' });
      }
      return sources;
    }

    protected async getGlobalSkillSource(): Promise<ProviderSkillSource | null> {
      return { scope: 'user', rootDir: path.join(os.homedir(), '.gemini', 'skills'), commandPrefix: '/' };
    }
  }

  return new AntigravitySkillsProvider();
}
