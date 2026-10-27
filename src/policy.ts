import path from 'node:path';

import type { PermissionRules } from './permissions.js';

/**
 * Decides agy tool calls for CloudCLI runs.
 *
 * CloudCLI runs agy with `--dangerously-skip-permissions` and gates every
 * tool call through a PreToolUse hook (see approvals.ts), because agy's own
 * permission check cannot ask anyone in headless mode and a hook's "allow"
 * cannot override it. That makes this module the permission system for those
 * runs, so it applies the user's agy rules itself, then the permission mode,
 * and leaves everything else to the user.
 */

export type ToolCall = { name: string; args: Record<string, unknown> };

/** agy's permission rule kinds, as in `command(git status)`. */
export type ActionKind = 'command' | 'read_file' | 'write_file' | 'read_url' | 'execute_url' | 'mcp' | 'other';

export type Action = { kind: ActionKind; target: string };

export type Decision = { decision: 'allow' | 'deny' | 'ask'; reason?: string };

const READ_TOOLS = new Set([
  'read_file', 'view_file', 'view_file_outline', 'view_code_item', 'list_dir', 'grep_search', 'find_by_name',
]);
const WRITE_TOOLS = new Set([
  'write_file', 'write_to_file', 'edit_file', 'replace_file_content', 'multi_replace_file_content', 'sed_file',
  'notebook_edit',
]);
const COMMAND_TOOLS = new Set(['run_command', 'send_command_input', 'notebook_execution']);
const URL_READ_TOOLS = new Set(['read_url_content', 'search_web']);

const str = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

const pathArg = (args: Record<string, unknown>): string =>
  str(args.Path) ?? str(args.AbsolutePath) ?? str(args.TargetFile) ?? str(args.File) ?? str(args.DirectoryPath)
  ?? str(args.SearchPath) ?? str(args.SearchDirectory) ?? str(args.NotebookPath) ?? '';

export function classifyToolCall(call: ToolCall): Action {
  const { name, args } = call;
  if (COMMAND_TOOLS.has(name)) {
    return { kind: 'command', target: (str(args.CommandLine) ?? str(args.Input) ?? '').trim() };
  }
  if (READ_TOOLS.has(name)) {
    return { kind: 'read_file', target: pathArg(args) };
  }
  if (WRITE_TOOLS.has(name)) {
    return { kind: 'write_file', target: pathArg(args) };
  }
  if (URL_READ_TOOLS.has(name)) {
    return { kind: 'read_url', target: str(args.Url) ?? str(args.url) ?? str(args.query) ?? str(args.Query) ?? '' };
  }
  if (name.startsWith('browser_') || name.includes('browser')) {
    return { kind: 'execute_url', target: str(args.Url) ?? str(args.url) ?? '' };
  }
  if (name === 'call_mcp_tool') {
    const server = str(args.ServerName) ?? str(args.serverName) ?? str(args.server) ?? '';
    const tool = str(args.ToolName) ?? str(args.toolName) ?? str(args.tool) ?? '';
    return { kind: 'mcp', target: `${server}/${tool}` };
  }
  // agy's own bookkeeping (tasks, questions, waiting, finishing, ...).
  return { kind: 'other', target: '' };
}

const RULE_PATTERN = /^([a-z_]+)\((.*)\)$/s;

const isWithin = (target: string, root: string): boolean => {
  if (!target || !root) return false;
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

/** Whether one agy rule such as `command(git status)` covers `action`. */
export function ruleMatches(rule: string, action: Action): boolean {
  const match = RULE_PATTERN.exec(rule.trim());
  if (!match || match[1] !== action.kind) {
    return false;
  }
  const argument = match[2].trim();
  if (argument === '*' || argument === '') {
    return true;
  }
  switch (action.kind) {
    case 'command':
      return action.target === argument || action.target.startsWith(`${argument} `);
    case 'read_file':
    case 'write_file':
      return isWithin(action.target, argument);
    case 'mcp':
      return action.target === argument || (argument.endsWith('/*') && action.target.startsWith(argument.slice(0, -1)));
    default:
      return action.target.startsWith(argument);
  }
}

export type PolicyInput = {
  call: ToolCall;
  permissionMode: string;
  skipPermissions: boolean;
  rules: PermissionRules;
  workspaces: string[];
};

export function decideToolCall({ call, permissionMode, skipPermissions, rules, workspaces }: PolicyInput): Decision {
  const action = classifyToolCall(call);
  if (action.kind === 'other') {
    return { decision: 'allow' };
  }

  const denyRule = rules.deny.find((rule) => ruleMatches(rule, action));
  if (denyRule) {
    return { decision: 'deny', reason: `Blocked by the deny rule ${denyRule}.` };
  }
  if (skipPermissions || permissionMode === 'bypassPermissions') {
    return { decision: 'allow' };
  }
  if (rules.allow.some((rule) => ruleMatches(rule, action))) {
    return { decision: 'allow' };
  }

  const inWorkspace = workspaces.some((root) => isWithin(action.target, root));
  // agy itself reads the workspace freely; edits need Accept Edits, as for Claude.
  if (action.kind === 'read_file' && inWorkspace) {
    return { decision: 'allow' };
  }
  if (action.kind === 'write_file' && inWorkspace && permissionMode === 'acceptEdits') {
    return { decision: 'allow' };
  }
  return { decision: 'ask' };
}

/** Programs whose subcommand is part of what is being allowed (`git status`, not every `git`). */
const SUBCOMMAND_PROGRAMS = new Set([
  'git', 'npm', 'pnpm', 'yarn', 'bun', 'npx', 'docker', 'kubectl', 'cargo', 'go', 'pip', 'uv', 'systemctl', 'gh', 'make',
]);

/** The agy rule "Allow & remember" saves for this call, or null when none fits. */
export function suggestRule(call: ToolCall, workspaces: string[]): string | null {
  const action = classifyToolCall(call);
  switch (action.kind) {
    case 'command': {
      const tokens = action.target.split(/\s+/).filter(Boolean);
      if (tokens.length === 0) return null;
      const prefix = SUBCOMMAND_PROGRAMS.has(tokens[0]) && tokens[1] && !tokens[1].startsWith('-')
        ? `${tokens[0]} ${tokens[1]}`
        : tokens[0];
      return `command(${prefix})`;
    }
    case 'read_file':
    case 'write_file': {
      if (!action.target) return null;
      const root = workspaces.find((workspace) => isWithin(action.target, workspace)) ?? path.dirname(action.target);
      return `${action.kind}(${root})`;
    }
    case 'read_url':
    case 'execute_url': {
      try {
        return `${action.kind}(${new URL(action.target).origin})`;
      } catch {
        return `${action.kind}(*)`;
      }
    }
    case 'mcp':
      return action.target !== '/' ? `mcp(${action.target})` : null;
    default:
      return null;
  }
}
