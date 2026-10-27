import { execFile } from 'node:child_process';

import type { ProviderModelOption, ProviderModelsDefinition } from './host.js';
import { AGY_BINARY } from './paths.js';

const CACHE_TTL_MS = 10 * 60 * 1000;
const EFFORT_ORDER = ['low', 'medium', 'high'];
const EFFORT_SUFFIX = /-(low|medium|high)$/;
const LABEL_EFFORT_SUFFIX = /\s*\((Low|Medium|High)\)$/;

/** Used when `agy models` cannot run (not signed in, offline); observed on agy 1.4.7. */
const FALLBACK_MODEL_LINES = [
  'gemini-4-argon-medium\tGemini 4 Argon (Medium)',
  'gemini-4-argon-high\tGemini 4 Argon (High)',
  'gemini-4-argon-low\tGemini 4 Argon (Low)',
  'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
  'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)',
  'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
];

/**
 * Turns `agy models` output (`<id>\t<label>` per line) into one catalog entry
 * per base model, with the `-low/-medium/-high` variants as its effort levels.
 * agy accepts `--model <base> --effort <level>` for these.
 */
export function parseAgyModels(output: string): ProviderModelsDefinition {
  const byBase = new Map<string, { label: string; efforts: Set<string> }>();

  for (const line of output.split(/\r?\n/)) {
    const [id, label] = line.split('\t').map((part) => part?.trim());
    if (!id || !label || /\s/.test(id)) {
      continue;
    }
    const effort = EFFORT_SUFFIX.exec(id)?.[1];
    const base = effort ? id.replace(EFFORT_SUFFIX, '') : id;
    const entry = byBase.get(base) ?? { label: label.replace(LABEL_EFFORT_SUFFIX, ''), efforts: new Set<string>() };
    if (effort) {
      entry.efforts.add(effort);
    }
    byBase.set(base, entry);
  }

  const options: ProviderModelOption[] = Array.from(byBase, ([value, { label, efforts }]) => {
    const values = EFFORT_ORDER.filter((level) => efforts.has(level)).map((level) => ({ value: level }));
    if (values.length === 0) {
      return { value, label };
    }
    const defaultEffort = efforts.has('medium') ? 'medium' : values[0].value;
    return { value, label, effort: { default: defaultEffort, values } };
  });

  return { OPTIONS: options, DEFAULT: options[0]?.value ?? '' };
}

const runAgyModels = (): Promise<string> => new Promise((resolve, reject) => {
  execFile(AGY_BINARY, ['models'], { timeout: 30_000 }, (error, stdout) => {
    if (error) {
      reject(error);
      return;
    }
    resolve(stdout);
  });
});

export function createModels() {
  let cached: { value: ProviderModelsDefinition; at: number } | null = null;

  async function getSupportedModels(): Promise<ProviderModelsDefinition> {
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return cached.value;
    }
    try {
      const parsed = parseAgyModels(await runAgyModels());
      if (parsed.OPTIONS.length > 0) {
        cached = { value: parsed, at: Date.now() };
        return parsed;
      }
    } catch {
      // Fall through to the static list; not cached, so the next call retries.
    }
    return parseAgyModels(FALLBACK_MODEL_LINES.join('\n'));
  }

  return {
    getSupportedModels,
    // agy does not record a per-conversation model anywhere readable.
    async getCurrentActiveModel() {
      return { model: (await getSupportedModels()).DEFAULT };
    },
  };
}
