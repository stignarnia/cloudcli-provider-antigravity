import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PROVIDER_ID = 'antigravity';
export const PROVIDER_LABEL = 'Antigravity';

/**
 * `agy`, resolved once: CLOUDCLI_AGY_BINARY, else the first `agy` on PATH,
 * else agy's default install location (~/.local/bin/agy), which a service
 * started without a login shell may not have on its PATH.
 */
function resolveAgyBinary(): string {
  if (process.env.CLOUDCLI_AGY_BINARY) {
    return process.env.CLOUDCLI_AGY_BINARY;
  }
  for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, 'agy');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  const defaultInstall = path.join(os.homedir(), '.local', 'bin', 'agy');
  return fs.existsSync(defaultInstall) ? defaultInstall : 'agy';
}

export const AGY_BINARY = resolveAgyBinary();

/** agy's per-user data directory (`~/.gemini/antigravity-cli`). */
export const agyDataDir = (): string => path.join(os.homedir(), '.gemini', 'antigravity-cli');

export const agyConversationsDir = (): string => path.join(agyDataDir(), 'conversations');

export const agyConversationDbPath = (conversationId: string): string =>
  path.join(agyConversationsDir(), `${conversationId}.db`);

export const agySummariesDbPath = (): string => path.join(agyDataDir(), 'conversation_summaries.db');

export const agyOAuthTokenPath = (): string => path.join(agyDataDir(), 'antigravity-oauth-token');

/** User-scoped MCP servers (`agy mcp add` writes here). */
export const agyMcpConfigPath = (): string => path.join(os.homedir(), '.gemini', 'config', 'mcp_config.json');

/** User skills agy loads: `<dir>/<skill-name>/SKILL.md`. */
export const agyUserSkillDirs = (): string[] => [
  path.join(os.homedir(), '.gemini', 'config', 'skills'),
  path.join(os.homedir(), '.gemini', 'skills'),
  path.join(agyDataDir(), 'skills'),
];

/** Project skills agy loads, relative to the workspace root. */
export const AGY_PROJECT_SKILL_DIRS = [['.agents', 'skills']];

const CONVERSATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const isConversationId = (value: string): boolean => CONVERSATION_ID_PATTERN.test(value);

/** `file:///a/b` → `/a/b`; anything else is returned as is. */
export const fileUriToPath = (uri: string): string => {
  if (!uri.startsWith('file://')) {
    return uri;
  }
  try {
    return decodeURIComponent(new URL(uri).pathname);
  } catch {
    return uri.slice('file://'.length);
  }
};
