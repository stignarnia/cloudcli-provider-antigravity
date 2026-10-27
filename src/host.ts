/**
 * Structural types for what CloudCLI hands a provider plugin
 * (server/modules/plugins/provider-plugin-loader.ts, ProviderPluginHost).
 *
 * Only the members this plugin uses are declared. They mirror the host's
 * real signatures; the plugin cannot import the host's own types because it
 * is built outside the CloudCLI repository.
 */

export type AnyRecord = Record<string, unknown>;

export type NormalizedMessage = AnyRecord & {
  id: string;
  kind: string;
  sessionId: string;
  provider: string;
  timestamp: string;
};

export type SessionRow = {
  session_id: string;
  provider: string;
  provider_session_id: string | null;
  project_path: string | null;
  custom_name: string | null;
};

export type SqliteStatement = {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
};

export type SqliteDatabase = {
  prepare(sql: string): SqliteStatement;
  close(): void;
};

export type ProviderSkillSource = {
  scope: 'user' | 'project' | 'plugin' | 'repo' | 'admin' | 'system';
  rootDir: string;
  recursive?: boolean;
  commandPrefix?: '/' | '$';
};

export type McpScope = 'user' | 'local' | 'project';
export type McpTransport = 'stdio' | 'http' | 'sse';

export type ProviderMcpServer = {
  provider: string;
  name: string;
  scope: McpScope;
  transport: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
};

export type UpsertProviderMcpServerInput = {
  name: string;
  scope?: McpScope;
  transport: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
};

/** The host's abstract McpProvider; subclasses implement the four config hooks. */
export type McpProviderBase = abstract new (
  provider: string,
  supportedScopes: McpScope[],
  supportedTransports: McpTransport[],
) => {
  listServers(options?: { workspacePath?: string }): Promise<Record<McpScope, ProviderMcpServer[]>>;
  listServersForScope(scope: McpScope, options?: { workspacePath?: string }): Promise<ProviderMcpServer[]>;
  upsertServer(input: UpsertProviderMcpServerInput): Promise<ProviderMcpServer>;
  removeServer(input: { name: string; scope?: McpScope; workspacePath?: string }): Promise<unknown>;
};

/** The host's abstract SkillsProvider; subclasses say where SKILL.md folders live. */
export type SkillsProviderBase = abstract new (provider: string) => {
  listSkills(options?: { workspacePath?: string }): Promise<unknown[]>;
  addSkills(input: unknown): Promise<unknown[]>;
  removeSkill(input: { directoryName: string }): Promise<unknown>;
};

export type ProviderRuntimeWriter = {
  send(data: unknown): void;
  setSessionId?(sessionId: string): void;
  userId?: string | number | null;
};

export type ProviderModelOption = {
  value: string;
  label: string;
  description?: string;
  effort?: { default?: string; values: Array<{ value: string; description?: string }> };
};

export type ProviderModelsDefinition = {
  OPTIONS: ProviderModelOption[];
  DEFAULT: string;
};

export type ProviderRuntimeContext = {
  resolveProviderSessionId(sessionId: string | null | undefined): string | null;
  resolveResumeModel(sessionId: string | undefined, requestedModel?: string | null): Promise<string | undefined>;
  getProviderModels(): Promise<ProviderModelsDefinition>;
  normalizeMessage(raw: unknown, sessionId: string | null): NormalizedMessage[];
  isProviderInstalled(): Promise<boolean>;
};

export type Host = {
  pluginName: string;
  pluginDir: string;
  utils: {
    createNormalizedMessage(fields: AnyRecord & { kind: string; provider: string }): NormalizedMessage;
    createCompleteMessage(options: {
      provider: string;
      sessionId?: string | null;
      exitCode?: number | null;
    }): NormalizedMessage;
    normalizeSessionName(rawValue: string | undefined, fallback: string): string;
    normalizeProviderTimestamp(value: unknown): string;
    sliceTailPage<T>(items: T[], limit: number | null, offset: number): { page: T[]; hasMore: boolean };
    stripAnsiSequences(value: string): string;
    findTopmostGitRoot(startPath: string): Promise<string | null>;
  };
  attachments: {
    appendImagesInputTag(prompt: string, images: unknown): string;
    appendFilesInputTag(prompt: string, files: unknown): string;
    parseImagesInputTag(text: string): { text: string; attachments: unknown[] };
    parseFilesInputTag(text: string): { text: string; attachments: unknown[] };
  };
  sessionsDb: {
    createSession(
      providerSessionId: string,
      provider: string,
      projectPath: string,
      customName?: string,
      createdAt?: string,
      updatedAt?: string,
      jsonlPath?: string | null,
    ): string;
    assignProviderSessionId(sessionId: string, providerSessionId: string): void;
    getSessionById(sessionId: string): SessionRow | null;
    getSessionByProviderSessionId(providerSessionId: string): SessionRow | null;
    findLatestPendingAppSession(provider: string, projectPath: string): SessionRow | null;
  };
  notifications: {
    notifyRunStopped(input: AnyRecord): void;
    notifyRunFailed(input: AnyRecord): void;
  };
  Database: new (filename: string, options?: { readonly?: boolean; fileMustExist?: boolean }) => SqliteDatabase;
  bases: {
    McpProvider: McpProviderBase;
    SkillsProvider: SkillsProviderBase;
  };
};
