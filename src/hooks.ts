import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The hook's name in hooks.json; other named hooks there are left alone. */
export const APPROVAL_HOOK_NAME = 'cloudcli-approval';

/** agy's shared user hooks file. */
export const agyHooksPath = (): string => path.join(os.homedir(), '.gemini', 'config', 'hooks.json');

/** Hooks block agy until they answer; this one waits for a person, so it gets a day. */
const HOOK_TIMEOUT_SECONDS = 86_400;

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

export function approvalHookEntry(nodePath: string, scriptPath: string) {
  return {
    PreToolUse: [
      {
        matcher: '*',
        hooks: [{ type: 'command', command: `${shellQuote(nodePath)} ${shellQuote(scriptPath)}`, timeout: HOOK_TIMEOUT_SECONDS }],
      },
    ],
  };
}

/**
 * Makes sure agy runs the CloudCLI approval hook (dist/approval-hook.js)
 * before every tool call, writing only this plugin's named entry into
 * ~/.gemini/config/hooks.json. Returns false when it could not be installed;
 * the runtime then falls back to agy's own (headless, non-asking) handling.
 */
export async function ensureApprovalHook(): Promise<boolean> {
  const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'approval-hook.js');
  const entry = approvalHookEntry(process.execPath, scriptPath);
  const target = agyHooksPath();

  try {
    let hooks: Record<string, unknown> = {};
    try {
      const text = await fs.readFile(target, 'utf8');
      const parsed: unknown = text.trim() ? JSON.parse(text) : {};
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`${target} is not a JSON object`);
      }
      hooks = parsed as Record<string, unknown>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }

    if (JSON.stringify(hooks[APPROVAL_HOOK_NAME]) !== JSON.stringify(entry)) {
      await fs.mkdir(path.dirname(target), { recursive: true });
      const temp = `${target}.${process.pid}.tmp`;
      await fs.writeFile(temp, `${JSON.stringify({ ...hooks, [APPROVAL_HOOK_NAME]: entry }, null, 2)}\n`, 'utf8');
      await fs.rename(temp, target);
    }
    return true;
  } catch (error) {
    console.warn('[Antigravity] Could not install the approval hook; tool calls will not ask:', error instanceof Error ? error.message : error);
    return false;
  }
}
