import fs from 'node:fs';

import type { Host, NormalizedMessage } from './host.js';
import { agyConversationDbPath, PROVIDER_ID } from './paths.js';
import { ProtoView } from './protobuf.js';
import { stepMessageId } from './normalize.js';
import { mapAgyTool, parseToolArgs } from './tools.js';

/**
 * Reads a conversation's history from agy's own store,
 * `~/.gemini/antigravity-cli/conversations/<id>.db` (table `steps`, one
 * protobuf blob per step). Field paths, observed on agy 1.4.x:
 *
 *   all steps        5.1.1 / 5.1.2   created at (seconds / nanos)
 *   14 user input    19.2            prompt text
 *   15 agent         20.1            response text
 *   132 tool         5.4.1 / 5.4.2 / 5.4.3   call id / tool name / JSON args
 *                    140.2.1         result text shown to the model
 *                    5.34.4          permission decision ("allow" / "deny")
 *                    steps.status    3 = done, 6 = not run (auto-denied)
 *   101 system       agy-internal notices, not shown
 *
 * Works for conversations started in CloudCLI and in a terminal alike.
 */

const STEP_USER_INPUT = 14;
const STEP_AGENT = 15;
const STEP_TOOL = 132;

/** Final status codes observed in agy's steps table. */
const STATUS_DONE = 3;
const STATUS_NOT_RUN = 6;

type StepRow = { idx: number; step_type: number; status?: number; step_payload: Uint8Array | null };

export type AgyStep =
  | { kind: 'user'; index: number; timestamp: string; text: string }
  | { kind: 'agent'; index: number; timestamp: string; text: string }
  | {
    kind: 'tool';
    index: number;
    timestamp: string;
    name: string;
    args: string;
    output: string | null;
    denied: boolean;
  };

const timestampOf = (view: ProtoView): string => {
  const seconds = view.int('5.1.1');
  const nanos = view.int('5.1.2') ?? 0;
  return seconds ? new Date(seconds * 1000 + Math.floor(nanos / 1e6)).toISOString() : new Date(0).toISOString();
};

export function decodeStep(row: StepRow): AgyStep | null {
  const view = ProtoView.decode(row.step_payload);
  const timestamp = timestampOf(view);

  if (row.step_type === STEP_USER_INPUT) {
    const text = view.string('19.2') ?? view.string('19.3.1');
    return text === undefined ? null : { kind: 'user', index: row.idx, timestamp, text };
  }

  if (row.step_type === STEP_AGENT) {
    const text = view.string('20.1');
    return text?.trim() ? { kind: 'agent', index: row.idx, timestamp, text } : null;
  }

  if (row.step_type === STEP_TOOL) {
    const name = view.string('5.4.2');
    if (!name) {
      return null;
    }
    return {
      kind: 'tool',
      index: row.idx,
      timestamp,
      name,
      args: view.string('5.4.3') ?? '{}',
      output: view.string('140.2.1') ?? null,
      // A non-DONE status can mean the tool is still running. Treating every
      // non-DONE row as denied made accepted calls appear refused until the
      // turn finished and agy changed their status to DONE. Status 6 is the
      // persisted auto-denied/not-run state; an explicit permission decision
      // is authoritative when present.
      denied: view.string('5.34.4') === 'deny' || row.status === STATUS_NOT_RUN,
    };
  }

  return null;
}

export function readConversationSteps(host: Host, conversationId: string): AgyStep[] {
  const dbPath = agyConversationDbPath(conversationId);
  if (!fs.existsSync(dbPath)) {
    return [];
  }

  const db = new host.Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare('SELECT idx, step_type, status, step_payload FROM steps ORDER BY idx').all() as StepRow[];
    return rows.map(decodeStep).filter((step): step is AgyStep => step !== null);
  } finally {
    db.close();
  }
}

export function stepsToMessages(host: Host, conversationId: string, appSessionId: string, steps: AgyStep[]): NormalizedMessage[] {
  const { createNormalizedMessage } = host.utils;
  const messages: NormalizedMessage[] = [];

  for (const step of steps) {
    const id = stepMessageId(conversationId, step.index);
    const base = { id, sessionId: appSessionId, provider: PROVIDER_ID, timestamp: step.timestamp };

    if (step.kind === 'user') {
      // Prompts sent with attachments carry tag-encoded paths (see runtime.ts).
      const parsedImages = host.attachments.parseImagesInputTag(step.text);
      const parsedFiles = host.attachments.parseFilesInputTag(parsedImages.text);
      messages.push(createNormalizedMessage({
        ...base,
        kind: 'text',
        role: 'user',
        content: parsedFiles.text,
        images: parsedImages.attachments.length > 0 ? parsedImages.attachments : undefined,
        files: parsedFiles.attachments.length > 0 ? parsedFiles.attachments : undefined,
      }));
      continue;
    }

    if (step.kind === 'agent') {
      messages.push(createNormalizedMessage({ ...base, kind: 'text', role: 'assistant', content: step.text }));
      continue;
    }

    const { toolName, toolInput } = mapAgyTool(step.name, parseToolArgs(step.args));
    const toolMessage = createNormalizedMessage({ ...base, kind: 'tool_use', toolName, toolInput, toolId: id });
    if (step.output !== null || step.denied) {
      toolMessage.toolResult = {
        content: step.denied
          ? `Not run: ${step.output ?? 'denied by the permission mode (headless agy cannot ask)'}`
          : step.output,
        isError: step.denied,
      };
    }
    messages.push(toolMessage);
  }

  return messages;
}
