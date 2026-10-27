import type { AnyRecord, Host, NormalizedMessage } from './host.js';
import { PROVIDER_ID } from './paths.js';
import { mapAgyTool, parseToolArgs } from './tools.js';

/**
 * Translates `agy --output-format stream-json` events into CloudCLI messages.
 *
 * Event shapes (agy 1.4.x):
 *   {event:"init", conversation_id, init:{cwd, tools}}
 *   {event:"step_update", step_update:{conversation_id, step_index, state:"ACTIVE"|"DONE",
 *     step_type:"user_input"|"agent_response"|"tool"|"system_message",
 *     text_delta?, tool_name?, tool_info?:{name, parameters, output?}, usage?}}
 *   {event:"result", result:{conversation_id, status:"SUCCESS"|"ERROR", response, error?,
 *     usage, denied_actions?:[{action, display_name}]}}
 *
 * Message ids are `<conversation>_<step>`, the same ids history.ts gives the
 * stored steps, so a reload replaces live rows instead of duplicating them.
 */

export type StreamState = {
  /** Tool steps whose ACTIVE update produced a tool_use already. */
  toolStepsStarted: Set<number>;
};

export const createStreamState = (): StreamState => ({ toolStepsStarted: new Set() });

type CreateMessage = Host['utils']['createNormalizedMessage'];

const record = (value: unknown): AnyRecord =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as AnyRecord) : {};

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

export const stepMessageId = (conversationId: string, stepIndex: number): string => `${conversationId}_${stepIndex}`;

export function buildTokenBudget(usage: AnyRecord): AnyRecord | null {
  const input = Number(usage.input_tokens ?? 0) + Number(usage.cache_read_tokens ?? 0);
  const output = Number(usage.output_tokens ?? 0) + Number(usage.thinking_tokens ?? 0);
  const used = input + output;
  if (!Number.isFinite(used) || used <= 0) {
    return null;
  }
  return { used, inputTokens: input, outputTokens: output, breakdown: { input, output } };
}

/** Explains auto-denied tools (headless agy cannot prompt for permission). */
export function describeDeniedActions(denied: unknown): string | null {
  if (!Array.isArray(denied) || denied.length === 0) {
    return null;
  }
  const names = denied
    .map((entry) => str(record(entry).display_name) ?? str(record(entry).action))
    .filter((name): name is string => Boolean(name));
  return `Antigravity auto-denied ${names.join(', ') || 'a tool'}: headless runs cannot ask for permission. `
    + 'Switch the permission mode to "Bypass Permissions" (or "Accept Edits" for file edits) to allow it, '
    + 'or add an allow rule under permissions.allow in ~/.gemini/antigravity-cli/settings.json.';
}

export function normalizeAgyEvent(
  rawEvent: unknown,
  appSessionId: string | null,
  createMessage: CreateMessage,
  state: StreamState = createStreamState(),
): NormalizedMessage[] {
  const event = record(rawEvent);
  const sessionId = appSessionId ?? '';
  const base = { sessionId, provider: PROVIDER_ID, timestamp: new Date().toISOString() };

  if (event.event === 'step_update') {
    const step = record(event.step_update);
    const conversationId = str(step.conversation_id) ?? sessionId;
    const stepIndex = Number(step.step_index ?? -1);
    const id = stepMessageId(conversationId, stepIndex);
    const stepType = str(step.step_type);
    const done = step.state === 'DONE';

    if (stepType === 'tool') {
      const info = record(step.tool_info);
      const agyName = str(info.name) ?? str(step.tool_name) ?? 'tool';
      const { toolName, toolInput } = mapAgyTool(agyName, parseToolArgs(info.parameters));
      const messages: NormalizedMessage[] = [];

      if (!state.toolStepsStarted.has(stepIndex)) {
        state.toolStepsStarted.add(stepIndex);
        messages.push(createMessage({ ...base, id, kind: 'tool_use', toolName, toolInput, toolId: id }));
      }
      if (done) {
        messages.push(createMessage({
          ...base,
          id: `${id}_result`,
          kind: 'tool_result',
          toolId: id,
          content: str(info.output) ?? '',
          isError: false,
        }));
      }
      return messages;
    }

    if (stepType === 'user_input' || stepType === 'system_message') {
      // The client renders the user's bubble itself; system steps are agy-internal.
      return [];
    }

    const delta = str(step.text_delta) ?? '';
    const messages: NormalizedMessage[] = [];
    if (delta) {
      messages.push(createMessage({ ...base, id, kind: 'stream_delta', content: delta }));
    }
    if (done) {
      messages.push(createMessage({ ...base, id: `${id}_end`, kind: 'stream_end' }));
    }
    return messages;
  }

  if (event.event === 'result') {
    const result = record(event.result);
    const messages: NormalizedMessage[] = [];

    if (result.status === 'ERROR') {
      messages.push(createMessage({
        ...base,
        kind: 'error',
        content: str(result.error) || 'Antigravity reported an error.',
      }));
    }

    const deniedNotice = describeDeniedActions(result.denied_actions);
    if (deniedNotice) {
      messages.push(createMessage({ ...base, kind: 'error', content: deniedNotice }));
    }

    const tokenBudget = buildTokenBudget(record(result.usage));
    if (tokenBudget) {
      messages.push(createMessage({ ...base, kind: 'status', text: 'token_budget', tokenBudget }));
    }
    return messages;
  }

  return [];
}
