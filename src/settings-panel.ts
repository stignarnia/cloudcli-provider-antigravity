/**
 * The plugin's own settings UI (manifest `entry`), shown by CloudCLI as
 * Settings > Agents > Antigravity > Permissions. Mounted like a tab plugin:
 * loaded from a Blob URL, so this module must not import anything at runtime.
 * Reads and saves through the plugin server (settings-server.ts).
 */

type Rules = { allow: string[]; deny: string[]; skipPermissions: boolean };

type HostApi = {
  rpc(method: string, path: string, body?: unknown): Promise<unknown>;
};

const QUICK_ADD = [
  'command(git status)', 'command(git diff)', 'command(git log)', 'command(ls)', 'command(cat)',
  'command(npm test)', 'command(npm run)', 'read_url(*)',
];

const EXAMPLES: Array<[string, string]> = [
  ['command(git status)', 'shell commands starting with "git status"'],
  ['command(npm)', 'every npm command'],
  ['command(rm)', 'as a deny rule: never run rm'],
  ['write_file(/home/me/project)', 'create or edit files under that path'],
  ['read_file(/etc)', 'read files under that path'],
  ['read_url(*)', 'fetch any URL'],
  ['execute_url(https://example.com)', 'browse that site'],
  ['mcp(server/tool)', 'one tool of a configured MCP server'],
];

// Same classes as CloudCLI's built-in permission panels, so they exist in its stylesheet.
const STYLE = {
  allow: {
    title: 'Allowed',
    description: 'Run without asking. Anything neither allowed nor denied is asked in the chat.',
    row: 'flex items-center justify-between rounded-lg border border-green-200 bg-green-50 p-3 dark:border-green-800 dark:bg-green-900/20',
    text: 'font-mono text-sm text-green-800 dark:text-green-200',
    empty: 'No allowed rules',
  },
  deny: {
    title: 'Denied',
    description: 'Always refused, whatever the permission mode.',
    row: 'flex items-center justify-between rounded-lg border border-red-200 bg-red-50 p-3 dark:border-red-800 dark:bg-red-900/20',
    text: 'font-mono text-sm text-red-800 dark:text-red-200',
    empty: 'No denied rules',
  },
} as const;

const BUTTON = 'inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50';
const OUTLINE = 'inline-flex h-8 items-center rounded-md border border-input bg-background px-3 font-mono text-xs hover:bg-accent disabled:opacity-50';
const INPUT = 'flex h-10 flex-1 rounded-md border border-input bg-background px-3 py-2 font-mono text-sm';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

export function mount(container: HTMLElement, api: HostApi): void {
  let rules: Rules | null = null;
  let saving = false;
  let error = '';

  const save = async (next: Rules) => {
    const previous = rules;
    rules = next;
    saving = true;
    error = '';
    render();
    try {
      rules = await api.rpc('PUT', 'rules', next) as Rules;
    } catch (caught) {
      rules = previous;
      error = `Saving failed: ${caught instanceof Error ? caught.message : String(caught)}`;
    }
    saving = false;
    render();
  };

  const ruleList = (kind: 'allow' | 'deny', current: Rules) => {
    const style = STYLE[kind];
    const section = el('div', 'space-y-4');
    section.append(el('h3', 'text-lg font-medium text-foreground', style.title), el('p', 'text-sm text-muted-foreground', style.description));

    const form = el('div', 'flex flex-col gap-2 sm:flex-row');
    const input = el('input', INPUT);
    input.placeholder = 'e.g. command(git status)';
    input.disabled = saving;
    const add = el('button', BUTTON, 'Add');
    add.disabled = saving;
    const submit = () => {
      const value = input.value.trim();
      if (value && !current[kind].includes(value)) {
        void save({ ...current, [kind]: [...current[kind], value] });
      }
    };
    add.onclick = submit;
    input.onkeydown = (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        submit();
      }
    };
    form.append(input, add);
    section.append(form);

    if (kind === 'allow') {
      const quick = el('div', 'flex flex-wrap gap-2');
      for (const rule of QUICK_ADD) {
        const button = el('button', OUTLINE, rule);
        button.disabled = saving || current.allow.includes(rule);
        button.onclick = () => void save({ ...current, allow: [...current.allow, rule] });
        quick.append(button);
      }
      section.append(el('p', 'text-sm font-medium text-muted-foreground', 'Quick add'), quick);
    }

    const list = el('div', 'space-y-2');
    for (const rule of current[kind]) {
      const row = el('div', style.row);
      const remove = el('button', 'px-2 text-muted-foreground hover:text-foreground', '✕');
      remove.title = 'Remove';
      remove.disabled = saving;
      remove.onclick = () => void save({ ...current, [kind]: current[kind].filter((item) => item !== rule) });
      row.append(el('span', style.text, rule), remove);
      list.append(row);
    }
    if (current[kind].length === 0) {
      list.append(el('div', 'py-6 text-center text-muted-foreground', style.empty));
    }
    section.append(list);
    return section;
  };

  const render = () => {
    container.replaceChildren();
    const root = el('div', 'space-y-6 p-1');
    container.append(root);

    if (!rules) {
      root.append(el('p', error ? 'text-sm text-red-600 dark:text-red-400' : 'text-sm text-muted-foreground', error || 'Loading permission rules…'));
      return;
    }
    const current = rules;

    root.append(el('p', 'text-sm text-muted-foreground',
      'Antigravity permission rules, saved to ~/.gemini/antigravity-cli/settings.json. Deny rules win over allow rules.'));
    if (error) {
      root.append(el('p', 'text-sm text-red-600 dark:text-red-400', error));
    }

    // Same box as Claude's "Skip permission prompts".
    const skipSection = el('div', 'space-y-4');
    skipSection.append(el('h3', 'text-lg font-medium text-foreground', 'Permission Settings'));
    const box = el('div', 'rounded-lg border border-orange-200 bg-orange-50 p-4 dark:border-orange-800 dark:bg-orange-900/20');
    const label = el('label', 'flex items-center gap-3');
    const checkbox = el('input', 'h-4 w-4 rounded border-input bg-card text-primary');
    checkbox.type = 'checkbox';
    checkbox.checked = current.skipPermissions;
    checkbox.disabled = saving;
    checkbox.onchange = () => void save({ ...current, skipPermissions: checkbox.checked });
    const text = el('div');
    text.append(
      el('div', 'font-medium text-orange-900 dark:text-orange-100', 'Skip permission prompts (use with caution)'),
      el('div', 'text-sm text-orange-700 dark:text-orange-300', 'Equivalent to the --dangerously-skip-permissions flag. Not applied in Plan mode.'),
    );
    label.append(checkbox, text);
    box.append(label);
    skipSection.append(box);
    root.append(skipSection, ruleList('allow', current), ruleList('deny', current));

    const examples = el('div', 'rounded-lg border border-blue-200 bg-blue-50 p-4 dark:border-blue-800 dark:bg-blue-900/20');
    examples.append(el('h4', 'mb-2 font-medium text-blue-900 dark:text-blue-100', 'Rule syntax'));
    const items = el('ul', 'space-y-1 text-sm text-blue-800 dark:text-blue-200');
    for (const [rule, description] of EXAMPLES) {
      const item = el('li');
      item.append(el('code', 'rounded bg-blue-100 px-1 dark:bg-blue-800', rule), document.createTextNode(` ${description}`));
      items.append(item);
    }
    examples.append(items);
    root.append(examples);
  };

  render();
  void (async () => {
    try {
      rules = await api.rpc('GET', 'rules') as Rules;
    } catch (caught) {
      error = `Could not read the permission rules: ${caught instanceof Error ? caught.message : String(caught)}`;
    }
    render();
  })();
}

export function unmount(container: HTMLElement): void {
  container.replaceChildren();
}
