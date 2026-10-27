import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import type { AnyRecord, Host, NormalizedMessage } from '../src/host.js';

// Compiled to dist-test/test/, fixtures stay in test/fixtures.
export const fixturePath = (name: string): string =>
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fixtures', name);

export const readNdjson = (name: string): AnyRecord[] =>
  fs.readFileSync(fixturePath(name), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as AnyRecord);

export const createMessage = (fields: AnyRecord & { kind: string; provider: string }): NormalizedMessage => ({
  timestamp: new Date(0).toISOString(),
  ...fields,
  id: (fields.id as string) || `${fields.kind}_generated`,
  sessionId: (fields.sessionId as string) || '',
} as NormalizedMessage);

/** better-sqlite3's surface over node:sqlite, enough for the plugin's read-only queries. */
class TestDatabase {
  private readonly db: DatabaseSync;

  constructor(filename: string, options?: { readonly?: boolean }) {
    this.db = new DatabaseSync(filename, { readOnly: options?.readonly ?? false });
  }

  prepare(sql: string) {
    const statement = this.db.prepare(sql);
    return {
      all: (...params: unknown[]) => statement.all(...(params as never[])),
      get: (...params: unknown[]) => statement.get(...(params as never[])),
    };
  }

  close() {
    this.db.close();
  }
}

/** A host with real message helpers and stubs for everything with side effects. */
export function createTestHost(): Host {
  return {
    pluginName: 'antigravity',
    pluginDir: '/tmp',
    utils: {
      createNormalizedMessage: createMessage,
      createCompleteMessage: (options) => createMessage({ ...options, kind: 'complete' }),
      normalizeSessionName: (raw, fallback) => raw?.trim() || fallback,
      normalizeProviderTimestamp: (value) => String(value),
      sliceTailPage: (items, limit, offset) => {
        const end = items.length - offset;
        const start = limit === null ? 0 : Math.max(0, end - limit);
        return { page: items.slice(start, Math.max(0, end)), hasMore: start > 0 };
      },
      stripAnsiSequences: (value) => value,
      findTopmostGitRoot: async () => null,
    },
    attachments: {
      appendImagesInputTag: (prompt) => prompt,
      appendFilesInputTag: (prompt) => prompt,
      parseImagesInputTag: (text) => ({ text, attachments: [] }),
      parseFilesInputTag: (text) => ({ text, attachments: [] }),
    },
    sessionsDb: {} as Host['sessionsDb'],
    notifications: { notifyRunStopped: () => {}, notifyRunFailed: () => {} },
    Database: TestDatabase as unknown as Host['Database'],
    bases: {} as Host['bases'],
  };
}
