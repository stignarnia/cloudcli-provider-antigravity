import { spawn, type ChildProcess } from 'node:child_process';

import type { AnyRecord, Host, ProviderRuntimeContext, ProviderRuntimeWriter } from './host.js';
import { createStreamState, normalizeAgyEvent } from './normalize.js';
import { AGY_BINARY, PROVIDER_ID, PROVIDER_LABEL } from './paths.js';
import { readSkipPermissions } from './permissions.js';
import type { createApprovalService } from './approvals.js';

type AgyProcess = ChildProcess & { aborted?: boolean; disposeApprovals?: (reason: string) => void };

/**
 * Maps the composer's permission mode onto agy's headless controls (agy 1.4.x).
 * Headless agy cannot prompt, so anything not pre-allowed is auto-denied;
 * the normalizer reports those denials in the chat. `skipPermissions` (the
 * Settings checkbox) bypasses every mode except Plan, as it does for Claude.
 */
export function resolvePermissionArgs(permissionMode: unknown, skipPermissions = false): string[] {
  if (permissionMode === 'plan') {
    return ['--mode', 'plan'];
  }
  if (skipPermissions || permissionMode === 'bypassPermissions') {
    return ['--dangerously-skip-permissions'];
  }
  return permissionMode === 'acceptEdits' ? ['--mode', 'accept-edits'] : [];
}

/** agy's model ids carry the effort as a suffix; `--effort` takes it separately. */
export function resolveEffortArgs(model: string | undefined, effort: unknown, allowedEfforts: string[]): string[] {
  if (!model || typeof effort !== 'string' || effort === 'default' || !allowedEfforts.includes(effort)) {
    return [];
  }
  return ['--effort', effort];
}

export function buildAgyArgs(options: {
  providerSessionId: string | null;
  model?: string;
  effortArgs: string[];
  permissionMode: unknown;
  skipPermissions?: boolean;
  /**
   * The CloudCLI approval hook decides every tool call (approvals.ts): agy's
   * own check is switched off, since it can only auto-deny in headless runs.
   */
  hookGated?: boolean;
}): string[] {
  const args = ['--input-format', 'stream-json', '--output-format', 'stream-json'];
  if (options.providerSessionId) {
    args.push('--conversation', options.providerSessionId);
  }
  if (options.model) {
    args.push('--model', options.model, ...options.effortArgs);
  }
  args.push(...(options.hookGated && options.permissionMode !== 'plan'
    ? ['--dangerously-skip-permissions']
    : resolvePermissionArgs(options.permissionMode, options.skipPermissions)));
  return args;
}

/** One stream-json stdin message; agy runs a turn per line and exits when stdin closes. */
export const buildUserInputLine = (prompt: string): string =>
  `${JSON.stringify({ event: 'user', message: { role: 'user', content: prompt } })}\n`;

type ApprovalService = ReturnType<typeof createApprovalService>;

export function createRuntime(host: Host, approvals?: ApprovalService, isHookReady: () => boolean = () => false) {
  const { createNormalizedMessage, createCompleteMessage, stripAnsiSequences } = host.utils;
  const activeProcesses = new Map<string, AgyProcess>();

  const killProcessTree = (child: AgyProcess) => {
    try {
      // Spawned detached, so the negative pid reaches agy's own children too.
      if (child.pid) {
        process.kill(-child.pid, 'SIGTERM');
        return;
      }
    } catch {
      // Group already gone; fall through to the direct kill.
    }
    child.kill('SIGTERM');
  };

  async function run(command: string, options: AnyRecord, writer: ProviderRuntimeWriter, context: ProviderRuntimeContext) {
    const appSessionId = typeof options.sessionId === 'string' ? options.sessionId : null;
    const workingDir = (options.cwd as string) || (options.projectPath as string) || process.cwd();
    const processKey = appSessionId ?? `agy-${Date.now()}`;
    const providerSessionId = context.resolveProviderSessionId(appSessionId);

    const models = await context.getProviderModels().catch(() => null);
    const model = await context.resolveResumeModel(appSessionId ?? undefined, options.model as string | undefined);
    const knownModel = models?.OPTIONS.find((option) => option.value === model);
    // agy rejects unknown model ids outright; an unknown one falls back to agy's own default.
    const resolvedModel = knownModel ? model : undefined;
    const allowedEfforts = knownModel?.effort?.values.map((value) => value.value) ?? [];

    const permissionMode = typeof options.permissionMode === 'string' ? options.permissionMode : 'default';
    const skipPermissions = await readSkipPermissions().catch(() => false);
    // Plan mode stays with agy's own read-only planning; every other mode is
    // gated by the approval hook so tool calls can ask in the chat.
    const approvalRun = approvals && isHookReady() && permissionMode !== 'plan'
      ? await approvals.registerRun({
        appSessionId: appSessionId ?? processKey,
        writer,
        permissionMode,
        skipPermissions,
        workspaces: [workingDir],
      }).catch((error) => {
        console.warn('[Antigravity] Approvals unavailable for this run:', error instanceof Error ? error.message : error);
        return null;
      })
      : null;

    const args = buildAgyArgs({
      providerSessionId,
      model: resolvedModel,
      effortArgs: resolveEffortArgs(resolvedModel, options.effort, allowedEfforts),
      permissionMode,
      skipPermissions,
      hookGated: approvalRun !== null,
    });

    const prompt = host.attachments.appendFilesInputTag(
      host.attachments.appendImagesInputTag(command?.trim() ?? '', options.images),
      options.files,
    );

    return new Promise<void>((resolve, reject) => {
      let conversationId = providerSessionId;
      let stdoutBuffer = '';
      let stderrText = '';
      let reportedError = false;
      let completeSent = false;
      const streamState = createStreamState();

      const send = (message: unknown) => writer.send(message);
      const sendError = (content: string) => {
        reportedError = true;
        send(createNormalizedMessage({ kind: 'error', content, sessionId: appSessionId ?? '', provider: PROVIDER_ID }));
      };

      const notify = (code: number | null, error?: string) => {
        const payload = {
          userId: writer.userId ?? null,
          provider: PROVIDER_ID,
          sessionId: appSessionId ?? conversationId ?? processKey,
          sessionName: options.sessionSummary,
        };
        if (code === 0 && !error) {
          host.notifications.notifyRunStopped({ ...payload, stopReason: 'completed' });
        } else {
          host.notifications.notifyRunFailed({ ...payload, error: error ?? `${PROVIDER_LABEL} exited with code ${code}` });
        }
      };

      const registerConversation = (nextId: unknown) => {
        if (typeof nextId !== 'string' || !nextId || nextId === conversationId) {
          return;
        }
        conversationId = nextId;
        writer.setSessionId?.(nextId);
        if (!providerSessionId) {
          send(createNormalizedMessage({
            kind: 'session_created',
            newSessionId: nextId,
            sessionId: nextId,
            provider: PROVIDER_ID,
          }));
        }
      };

      const processLine = (line: string) => {
        if (!line.trim()) {
          return;
        }
        let event: AnyRecord;
        try {
          event = JSON.parse(line) as AnyRecord;
        } catch {
          // Not an event; agy writes its diagnostics to stderr, so this is unexpected output.
          send(createNormalizedMessage({ kind: 'stream_delta', content: `${line}\n`, sessionId: appSessionId ?? '', provider: PROVIDER_ID }));
          return;
        }

        if (event.event === 'init') {
          registerConversation(event.conversation_id);
          return;
        }
        if (event.event === 'result') {
          registerConversation((event.result as AnyRecord | undefined)?.conversation_id);
          if ((event.result as AnyRecord | undefined)?.status === 'ERROR') {
            reportedError = true;
          }
        }

        for (const message of normalizeAgyEvent(event, appSessionId, createNormalizedMessage, streamState)) {
          send(message);
        }
      };

      let child: AgyProcess;
      try {
        child = spawn(AGY_BINARY, args, {
          cwd: workingDir,
          env: { ...process.env, ...approvalRun?.env },
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: true,
        });
        child.disposeApprovals = approvalRun?.dispose;
      } catch (error) {
        approvalRun?.dispose('The run did not start.');
        const message = error instanceof Error ? error.message : String(error);
        sendError(`Failed to start ${PROVIDER_LABEL}: ${message}`);
        send(createCompleteMessage({ provider: PROVIDER_ID, sessionId: appSessionId, exitCode: 1 }));
        notify(1, message);
        reject(error);
        return;
      }

      activeProcesses.set(processKey, child);
      child.stdin?.on('error', () => {
        // agy exited before reading the prompt; its exit is reported below.
      });
      child.stdin?.end(buildUserInputLine(prompt));

      child.stdout?.on('data', (chunk: Buffer) => {
        stdoutBuffer += chunk.toString();
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() ?? '';
        lines.forEach(processLine);
      });

      // agy prints diagnostics (and the "auto-denied" notice the result event
      // already carries) on stderr; surfaced only when the run fails.
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrText += stripAnsiSequences(chunk.toString());
      });

      const finish = (code: number | null, spawnError?: Error) => {
        activeProcesses.delete(processKey);
        approvalRun?.dispose('The run ended.');
        if (stdoutBuffer.trim()) {
          processLine(stdoutBuffer);
          stdoutBuffer = '';
        }

        const failed = spawnError !== undefined || code !== 0;
        if (failed && !child.aborted && !reportedError) {
          const notInstalled = (spawnError as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
          sendError(notInstalled
            ? `The ${PROVIDER_LABEL} CLI (\`${AGY_BINARY}\`) is not installed or not on the server's PATH.`
            : stderrText.trim() || spawnError?.message || `${PROVIDER_LABEL} exited with code ${code}`);
        }

        // An aborted run's `complete` comes from the abort handler.
        if (!completeSent && !child.aborted) {
          completeSent = true;
          send(createCompleteMessage({ provider: PROVIDER_ID, sessionId: appSessionId, exitCode: spawnError ? 1 : code }));
        }

        notify(spawnError ? 1 : code, spawnError?.message);
        if (failed && !child.aborted) {
          reject(spawnError ?? new Error(`${PROVIDER_LABEL} exited with code ${code}`));
        } else {
          resolve();
        }
      };

      let settled = false;
      child.on('error', (error) => {
        if (!settled) {
          settled = true;
          finish(1, error);
        }
      });
      child.on('close', (code) => {
        if (!settled) {
          settled = true;
          finish(code);
        }
      });
    });
  }

  function abort(sessionId: string): boolean {
    const child = activeProcesses.get(sessionId);
    if (!child) {
      return false;
    }
    child.aborted = true;
    child.disposeApprovals?.('The run was stopped.');
    killProcessTree(child);
    activeProcesses.delete(sessionId);
    return true;
  }

  return {
    runtime: {
      run,
      abort,
      // Answers from the chat's permission prompt (chat.permission-response) and replay on reconnect.
      ...(approvals ? { permissions: { resolve: approvals.resolve, listPending: approvals.listPending } } : {}),
    },
    isActive: (sessionId: string) => activeProcesses.has(sessionId),
  };
}
