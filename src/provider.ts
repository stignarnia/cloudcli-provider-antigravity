import path from 'node:path';

import { createApprovalService } from './approvals.js';
import { createAuth } from './auth.js';
import { ensureApprovalHook } from './hooks.js';
import type { Host } from './host.js';
import { createMcp, createSkills, syncBrowserMcp } from './mcp-skills.js';
import { createModels } from './models.js';
import { AGY_BINARY, agyConversationsDir, PROVIDER_ID, PROVIDER_LABEL } from './paths.js';
import { createRuntime } from './runtime.js';
import { createSessions, createSessionSynchronizer } from './sessions.js';

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * Entry point CloudCLI's provider-plugin loader calls (manifest `provider`).
 * Returns the IProvider implementation plus the metadata the core and the UI
 * would otherwise hard-code for a built-in provider.
 */
export default async function createAntigravityProvider(host: Host) {
  // Tool calls ask in the chat through agy's PreToolUse hook (approvals.ts);
  // without the hook agy's headless runs can only auto-deny.
  const hookReady = await ensureApprovalHook();
  await syncBrowserMcp();
  const approvals = createApprovalService(host);
  const { runtime } = createRuntime(host, approvals, () => hookReady);

  const provider = {
    id: PROVIDER_ID,
    runtime,
    models: createModels(),
    auth: createAuth(),
    mcp: createMcp(host),
    skills: createSkills(host),
    sessions: createSessions(host),
    sessionSynchronizer: createSessionSynchronizer(host),
  };

  const meta = {
    label: PROVIDER_LABEL,
    description: 'Google Antigravity',
    // agy signs in interactively the first time it starts.
    loginCommand: AGY_BINARY,
    capabilities: {
      provider: PROVIDER_ID,
      permissionModes: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
      permissionModeOptions: {
        default: {
          label: 'Default Mode',
          description: 'Workspace file reads and saved allow rules run automatically. Other tool calls ask for approval; saved deny rules block matching calls.',
        },
        acceptEdits: {
          label: 'Accept Edits',
          description: 'Workspace file reads and writes, plus saved allow rules, run automatically. Other tool calls ask for approval; saved deny rules block matching calls.',
        },
        bypassPermissions: {
          label: 'Bypass Permissions',
          description: 'Tool calls run without approval. Saved deny rules still block matching calls while the CloudCLI approval hook is active.',
        },
        plan: {
          label: 'Plan Mode',
          description: 'Uses Antigravity’s native Plan mode. Planning is read-only and does not run implementation commands; CloudCLI approval prompts are not used.',
        },
      },
      defaultPermissionMode: 'default',
      supportsImages: true,
      supportsFiles: true,
      supportsAbort: true,
      supportsPermissionRequests: hookReady,
      supportsTokenUsage: false,
      supportsEffort: true,
      effortLevels: ['low', 'medium', 'high'],
      supportsMessageEditing: false,
      supportsSessionForking: false,
      supportsMcp: true,
      supportsSkills: true,
      skillsPath: '~/.gemini/skills/<skill-name>/SKILL.md',
    },
    watchRoots: [agyConversationsDir()],
    isWatchTarget: (filePath: string) => /\.db(-wal)?$/.test(path.basename(filePath)),
    shellCommand: ({ resumeSessionId }: { resumeSessionId: string | null }) => (
      resumeSessionId ? `${AGY_BINARY} --conversation ${shellQuote(resumeSessionId)}` : AGY_BINARY
    ),
    getTokenUsage: () => null,
    // Offered by CloudCLI's Settings > Agents CLI panel (newer CloudCLI only).
    cliUpdater: { command: AGY_BINARY, args: ['update'] },
    // Settings > Agents > Permissions is this plugin's own panel
    // (manifest `entry` settings-panel.js, served by `server` settings-server.js).
  };

  return { provider, meta };
}
