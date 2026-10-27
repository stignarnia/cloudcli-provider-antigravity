import type { AnyRecord } from './host.js';

/**
 * Maps agy tool calls onto the tool names and input fields CloudCLI's chat
 * already has cards for (modules/chat/tools/configs/toolConfigs.ts), so a
 * command renders as a Bash card, a file read as a Read card, and so on.
 * The original agy parameters are kept alongside the mapped ones.
 *
 * Live stream-json events report display names (read_file, write_file,
 * edit_file); the stored history and the tool list use the internal ones
 * (view_file, write_to_file, replace_file_content). Both are listed.
 */
type ToolMapping = {
  name: string;
  input: (params: AnyRecord) => AnyRecord;
};

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

const filePath = (params: AnyRecord) => str(params.Path) ?? str(params.AbsolutePath) ?? str(params.TargetFile);

const TOOL_MAPPINGS: Record<string, ToolMapping> = {
  run_command: {
    name: 'Bash',
    input: (params) => ({
      command: str(params.CommandLine) ?? '',
      description: str(params.toolSummary),
      cwd: str(params.Cwd),
    }),
  },
  read_file: { name: 'Read', input: (params) => ({ file_path: filePath(params) }) },
  view_file: { name: 'Read', input: (params) => ({ file_path: filePath(params) }) },
  write_file: {
    name: 'Write',
    input: (params) => ({ file_path: filePath(params), content: str(params.Content) ?? str(params.CodeContent) }),
  },
  write_to_file: {
    name: 'Write',
    input: (params) => ({ file_path: filePath(params), content: str(params.CodeContent) ?? str(params.Content) }),
  },
  edit_file: {
    name: 'Edit',
    input: (params) => ({
      file_path: filePath(params),
      old_string: str(params.Target) ?? str(params.TargetContent),
      new_string: str(params.Replacement) ?? str(params.ReplacementContent),
    }),
  },
  replace_file_content: {
    name: 'Edit',
    input: (params) => ({
      file_path: filePath(params),
      old_string: str(params.TargetContent) ?? str(params.Target),
      new_string: str(params.ReplacementContent) ?? str(params.Replacement),
    }),
  },
  multi_replace_file_content: { name: 'Edit', input: (params) => ({ file_path: filePath(params) }) },
  grep_search: {
    name: 'Grep',
    input: (params) => ({ pattern: str(params.Query) ?? str(params.Pattern), path: str(params.SearchPath) }),
  },
  find_by_name: {
    name: 'Glob',
    input: (params) => ({ pattern: str(params.Pattern), path: str(params.SearchDirectory) }),
  },
  list_dir: { name: 'LS', input: (params) => ({ path: str(params.DirectoryPath) ?? filePath(params) }) },
  search_web: { name: 'WebSearch', input: (params) => ({ query: str(params.query) ?? str(params.Query) }) },
  read_url_content: { name: 'WebFetch', input: (params) => ({ url: str(params.Url) ?? str(params.url) }) },
};

export function parseToolArgs(raw: unknown): AnyRecord {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as AnyRecord;
  }
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as AnyRecord) : {};
    } catch {
      return { raw };
    }
  }
  return {};
}

/** CloudCLI tool name and input for one agy tool call. */
export function mapAgyTool(agyName: string, params: AnyRecord): { toolName: string; toolInput: AnyRecord } {
  const mapping = TOOL_MAPPINGS[agyName];
  if (!mapping) {
    return { toolName: agyName, toolInput: params };
  }

  const mapped = Object.fromEntries(
    Object.entries(mapping.input(params)).filter(([, value]) => value !== undefined),
  );
  return { toolName: mapping.name, toolInput: { ...params, ...mapped, agyTool: agyName } };
}
