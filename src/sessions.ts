import fs from 'node:fs';
import path from 'node:path';

import { readConversationSteps, stepsToMessages } from './history.js';
import type { Host, NormalizedMessage } from './host.js';
import { normalizeAgyEvent } from './normalize.js';
import {
  agyConversationDbPath,
  agySummariesDbPath,
  fileUriToPath,
  isConversationId,
  PROVIDER_ID,
} from './paths.js';
import { ProtoView } from './protobuf.js';

const FALLBACK_TITLE = 'Untitled Antigravity Session';

type SummaryRow = {
  conversation_id: string;
  title: string;
  workspace_uris: string;
  last_modified_time: string;
};

/** agy writes Go timestamps (`2026-10-26 18:39:09.522869202+00:00`); Date wants ms precision and a `T`. */
export function parseAgyTime(value: string | null | undefined): string | undefined {
  if (!value || value.startsWith('0001-')) {
    return undefined;
  }
  const iso = value.trim().replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1');
  const time = Date.parse(iso);
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}

export function firstWorkspacePath(workspaceUris: string | null | undefined): string | undefined {
  try {
    const uris: unknown = JSON.parse(workspaceUris ?? '[]');
    const first = Array.isArray(uris) ? uris.find((uri): uri is string => typeof uri === 'string' && uri.length > 0) : undefined;
    return first ? fileUriToPath(first) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Indexes agy conversations into CloudCLI's sessions table.
 *
 * The list comes from agy's own index, conversation_summaries.db (title,
 * workspace, last update). A conversation that index has not caught up with
 * yet is read from its own .db instead: the first user step carries the
 * workspace (19.12.12) and the prompt doubles as a title.
 */
export function createSessionSynchronizer(host: Host) {
  const openSummaries = () => {
    const dbPath = agySummariesDbPath();
    return fs.existsSync(dbPath) ? new host.Database(dbPath, { readonly: true, fileMustExist: true }) : null;
  };

  const upsert = (conversationId: string, projectPath: string, title: string | undefined, createdAt?: string, updatedAt?: string) => {
    const { sessionsDb } = host;

    // A chat started in CloudCLI has an app row waiting for this id; bind it
    // first so the watcher does not add a second sidebar entry for it.
    const pending = sessionsDb.getSessionByProviderSessionId(conversationId)
      ?? sessionsDb.findLatestPendingAppSession(PROVIDER_ID, projectPath);
    if (pending && !pending.provider_session_id) {
      sessionsDb.assignProviderSessionId(pending.session_id, conversationId);
    }

    const existing = sessionsDb.getSessionByProviderSessionId(conversationId);
    const existingName = existing?.custom_name;
    const name = existingName && existingName !== FALLBACK_TITLE ? existingName : title;

    // jsonl_path stays null: deleting a CloudCLI session must never delete agy's store.
    return sessionsDb.createSession(
      conversationId,
      PROVIDER_ID,
      projectPath,
      host.utils.normalizeSessionName(name, FALLBACK_TITLE),
      createdAt,
      updatedAt,
      null,
    );
  };

  const upsertSummary = (row: SummaryRow): string | null => {
    const projectPath = firstWorkspacePath(row.workspace_uris);
    // agy's index can outlive a deleted conversation store; nothing to show then.
    if (!projectPath || !fs.existsSync(agyConversationDbPath(row.conversation_id))) {
      return null;
    }
    const updatedAt = parseAgyTime(row.last_modified_time);
    return upsert(row.conversation_id, projectPath, row.title || undefined, updatedAt, updatedAt);
  };

  /** For a conversation agy's index does not list yet. */
  const upsertFromConversationDb = (conversationId: string): string | null => {
    const dbPath = agyConversationDbPath(conversationId);
    if (!fs.existsSync(dbPath)) {
      return null;
    }
    const db = new host.Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const first = db.prepare('SELECT step_payload FROM steps WHERE step_type = 14 ORDER BY idx LIMIT 1').get() as
        | { step_payload: Uint8Array }
        | undefined;
      if (!first) {
        return null;
      }
      const view = ProtoView.decode(first.step_payload);
      const workspaceUri = view.string('19.12.12');
      if (!workspaceUri) {
        return null;
      }
      const seconds = view.int('5.1.1');
      const createdAt = seconds ? new Date(seconds * 1000).toISOString() : undefined;
      const updatedAt = new Date(fs.statSync(dbPath).mtimeMs).toISOString();
      const title = view.string('19.2')?.split('\n')[0]?.slice(0, 80);
      return upsert(conversationId, fileUriToPath(workspaceUri), title, createdAt, updatedAt);
    } finally {
      db.close();
    }
  };

  const readSummaries = (where: string, ...params: unknown[]): SummaryRow[] => {
    const db = openSummaries();
    if (!db) {
      return [];
    }
    try {
      // Subagent conversations (parent set / nested) are part of their parent's run.
      const rows = db.prepare(`
        SELECT conversation_id, title, workspace_uris, last_modified_time
        FROM conversation_summaries
        WHERE step_count > 0 AND parent_conversation_id = '' AND nesting_depth = 0 ${where}
        ORDER BY last_modified_time DESC
      `).all(...params) as SummaryRow[];
      // agy's index can outlive a deleted conversation; only real ones get a sidebar entry.
      return rows.filter((row) => fs.existsSync(agyConversationDbPath(row.conversation_id)));
    } finally {
      db.close();
    }
  };

  // The core's scan cursor is shared by every provider, so a newly installed
  // plugin would never index conversations older than it. The first scan of
  // each server start therefore ignores it; agy's index is one small table.
  let fullScanDone = false;

  return {
    async synchronize(cursor?: Date): Promise<number> {
      const since = fullScanDone ? cursor : undefined;
      fullScanDone = true;
      try {
        const rows = readSummaries('');
        let processed = 0;
        for (const row of rows) {
          const updatedAt = parseAgyTime(row.last_modified_time);
          if (since && updatedAt && Date.parse(updatedAt) < since.getTime()) {
            continue;
          }
          if (upsertSummary(row)) {
            processed += 1;
          }
        }
        return processed;
      } catch (error) {
        console.warn('[Antigravity] Failed to synchronize sessions:', error instanceof Error ? error.message : error);
        return 0;
      }
    },

    /** Watcher hook: `<conversation>.db` or its `-wal` changed. */
    async synchronizeFile(filePath: string): Promise<string | null> {
      const conversationId = path.basename(filePath).replace(/\.db(-wal)?$/, '');
      if (!isConversationId(conversationId)) {
        return null;
      }
      try {
        const [row] = readSummaries('AND conversation_id = ?', conversationId);
        return row ? upsertSummary(row) : upsertFromConversationDb(conversationId);
      } catch (error) {
        console.warn(`[Antigravity] Failed to synchronize ${conversationId}:`, error instanceof Error ? error.message : error);
        return null;
      }
    },
  };
}

export function createSessions(host: Host) {
  return {
    /** Live events; the runtime normalizes its own stream, this serves the shared context API. */
    normalizeMessage(raw: unknown, sessionId: string | null): NormalizedMessage[] {
      return normalizeAgyEvent(raw, sessionId, host.utils.createNormalizedMessage);
    },

    async fetchHistory(
      sessionId: string,
      options: { limit?: number | null; offset?: number; providerSessionId?: string } = {},
    ) {
      const { limit = null, offset = 0 } = options;
      const conversationId = options.providerSessionId ?? sessionId;
      const empty = { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
      if (!isConversationId(conversationId)) {
        return empty;
      }

      try {
        const messages = stepsToMessages(host, conversationId, sessionId, readConversationSteps(host, conversationId));
        const normalizedOffset = Math.max(0, offset);
        const normalizedLimit = limit === null ? null : Math.max(0, limit);
        const { page, hasMore } = host.utils.sliceTailPage(messages, normalizedLimit, normalizedOffset);
        return { messages: page, total: messages.length, hasMore, offset: normalizedOffset, limit: normalizedLimit };
      } catch (error) {
        console.warn(`[Antigravity] Failed to read conversation ${conversationId}:`, error instanceof Error ? error.message : error);
        return empty;
      }
    },
  };
}
