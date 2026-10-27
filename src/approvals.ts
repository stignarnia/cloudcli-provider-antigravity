import { randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';

import type { AnyRecord, Host, ProviderRuntimeWriter } from './host.js';
import { PROVIDER_ID } from './paths.js';
import { readPermissionRules, writePermissionRules } from './permissions.js';
import { decideToolCall, suggestRule, type Decision, type ToolCall } from './policy.js';
import { mapAgyTool } from './tools.js';

/**
 * Tool approvals for CloudCLI runs of agy.
 *
 * Each run registers here and gets a private URL; agy's PreToolUse hook
 * (approval-hook.ts) posts every tool call to it. Calls the policy cannot
 * settle become a `permission_request` in the chat, and the hook (so agy)
 * waits until the user answers, exactly like Claude's tool approvals.
 */

type RunContext = {
  appSessionId: string;
  writer: ProviderRuntimeWriter;
  permissionMode: string;
  skipPermissions: boolean;
  workspaces: string[];
  requestIds: Set<string>;
};

type PendingApproval = {
  sessionId: string;
  toolName: string;
  input: unknown;
  context: AnyRecord;
  receivedAt: Date;
  settle: (decision: Decision, announce: 'resolved' | 'cancelled', reason?: string) => void;
};

type UserDecision = { allow: boolean; message?: string; rememberEntry?: unknown };

export function createApprovalService(host: Host) {
  const runs = new Map<string, RunContext>();
  const pending = new Map<string, PendingApproval>();
  let listening: Promise<number> | null = null;

  const send = (run: RunContext, fields: AnyRecord & { kind: string }) =>
    run.writer.send(host.utils.createNormalizedMessage({ ...fields, sessionId: run.appSessionId, provider: PROVIDER_ID }));

  async function askUser(run: RunContext, call: ToolCall, onClientGone: (cancel: () => void) => void): Promise<Decision> {
    const requestId = randomUUID();
    const { toolName, toolInput } = mapAgyTool(call.name, call.args);
    const rememberRule = suggestRule(call, run.workspaces);
    const context = { provider: PROVIDER_ID, agyTool: call.name, rememberRule };

    return new Promise<Decision>((resolve) => {
      let settled = false;
      const settle: PendingApproval['settle'] = (decision, announce, reason) => {
        if (settled) return;
        settled = true;
        pending.delete(requestId);
        run.requestIds.delete(requestId);
        send(run, announce === 'resolved'
          ? { kind: 'permission_resolved', requestId }
          : { kind: 'permission_cancelled', requestId, reason });
        resolve(decision);
      };

      pending.set(requestId, { sessionId: run.appSessionId, toolName, input: toolInput, context, receivedAt: new Date(), settle });
      run.requestIds.add(requestId);
      send(run, { kind: 'permission_request', requestId, toolName, input: toolInput, context });
      onClientGone(() => settle({ decision: 'deny', reason: 'The approval request was abandoned.' }, 'cancelled', 'abandoned'));
    });
  }

  async function decide(run: RunContext, call: ToolCall, onClientGone: (cancel: () => void) => void): Promise<Decision> {
    const rules = await readPermissionRules().catch(() => ({ allow: [], deny: [] }));
    const automatic = decideToolCall({
      call,
      permissionMode: run.permissionMode,
      skipPermissions: run.skipPermissions,
      rules,
      workspaces: run.workspaces,
    });
    return automatic.decision === 'ask' ? askUser(run, call, onClientGone) : automatic;
  }

  const readBody = (req: http.IncomingMessage): Promise<string> => new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const reply = (decision: Decision) => {
      if (!res.writableEnded) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(decision));
      }
    };
    const token = /^\/approve\/([a-f0-9]{48})$/.exec(req.url ?? '')?.[1];
    const run = token ? runs.get(token) : undefined;
    if (req.method !== 'POST' || !run) {
      reply({ decision: 'deny', reason: 'This CloudCLI run is no longer active.' });
      return;
    }

    let call: ToolCall;
    try {
      const payload = JSON.parse(await readBody(req)) as { toolCall?: { name?: unknown; args?: unknown } };
      const name = typeof payload.toolCall?.name === 'string' ? payload.toolCall.name : '';
      const args = payload.toolCall?.args && typeof payload.toolCall.args === 'object' ? payload.toolCall.args as AnyRecord : {};
      call = { name, args };
    } catch {
      reply({ decision: 'deny', reason: 'Unreadable tool call.' });
      return;
    }

    // The hook dies with agy (abort, timeout): drop the prompt it was waiting on.
    const onClientGone = (cancel: () => void) => res.on('close', () => {
      if (!res.writableEnded) cancel();
    });
    reply(await decide(run, call, onClientGone));
  };

  function ensureServer(): Promise<number> {
    listening ??= new Promise<number>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        handle(req, res).catch((error) => {
          if (!res.writableEnded) {
            res.writeHead(200, { 'content-type': 'application/json' })
              .end(JSON.stringify({ decision: 'deny', reason: `Approval failed: ${error instanceof Error ? error.message : error}` }));
          }
        });
      });
      // No request timeout: an approval waits as long as the user does.
      server.requestTimeout = 0;
      server.headersTimeout = 0;
      server.on('error', (error) => {
        listening = null;
        reject(error);
      });
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        server.unref();
        resolve(typeof address === 'object' && address ? address.port : 0);
      });
    });
    return listening;
  }

  return {
    /** Registers one run; returns the env agy needs and a cleanup for when the run ends. */
    async registerRun(options: Omit<RunContext, 'requestIds'>) {
      const port = await ensureServer();
      const token = randomBytes(24).toString('hex');
      const run: RunContext = { ...options, requestIds: new Set() };
      runs.set(token, run);
      return {
        env: { CLOUDCLI_AGY_APPROVAL_URL: `http://127.0.0.1:${port}/approve/${token}` },
        dispose(reason: string) {
          runs.delete(token);
          for (const requestId of [...run.requestIds]) {
            pending.get(requestId)?.settle({ decision: 'deny', reason }, 'cancelled', reason);
          }
        },
      };
    },

    /** The core's chat.permission-response; reaches every provider, so unknown ids are ignored. */
    resolve(requestId: string, decision: UserDecision) {
      const entry = pending.get(requestId);
      if (!entry) {
        return;
      }
      const remember = decision.allow && typeof decision.rememberEntry === 'string' ? decision.rememberEntry : null;
      if (remember) {
        // Saved as an agy allow rule: applies from now on and shows in Settings > Agents > Permissions.
        void readPermissionRules()
          .then((rules) => (rules.allow.includes(remember)
            ? rules
            : writePermissionRules({ allow: [...rules.allow, remember], deny: rules.deny.filter((rule) => rule !== remember) })))
          .catch((error) => console.warn('[Antigravity] Could not save the allow rule:', error));
      }
      entry.settle(
        decision.allow
          ? { decision: 'allow' }
          : { decision: 'deny', reason: decision.message || 'The user denied this action in CloudCLI.' },
        'resolved',
      );
    },

    listPending(sessionId: string) {
      return [...pending.entries()]
        .filter(([, entry]) => entry.sessionId === sessionId)
        .map(([requestId, entry]) => ({
          requestId,
          toolName: entry.toolName,
          input: entry.input,
          context: entry.context,
          sessionId,
          receivedAt: entry.receivedAt,
        }));
    },
  };
}
