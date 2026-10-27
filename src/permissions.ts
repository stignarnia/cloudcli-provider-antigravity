import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { agyDataDir } from './paths.js';

export type PermissionRules = { allow: string[]; deny: string[]; skipPermissions?: boolean };

/** agy's user settings, where `permissions.allow` / `permissions.deny` live. */
export const agySettingsPath = (): string => path.join(agyDataDir(), 'settings.json');

/**
 * The plugin's own settings. "Skip permission prompts" is a CloudCLI choice
 * (agy has only the per-run flag), so it lives here rather than in agy's file.
 */
export const pluginSettingsPath = (): string =>
  path.join(os.homedir(), '.cloudcli', 'plugins', 'antigravity', 'settings.json');

type JsonObject = Record<string, unknown> & { permissions?: Record<string, unknown> };

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];

async function readJson(file: string): Promise<JsonObject> {
  try {
    const text = await fs.readFile(file, 'utf8');
    const parsed: unknown = text.trim() ? JSON.parse(text) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as JsonObject) : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw error;
  }
}

/** Written through a temp file so a running agy never reads a half-written file. */
async function writeJson(file: string, value: JsonObject): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(temp, file);
}

/** Whether runs get `--dangerously-skip-permissions` (Settings > Agents > Permissions). */
export async function readSkipPermissions(): Promise<boolean> {
  return (await readJson(pluginSettingsPath())).skipPermissions === true;
}

export async function readPermissionRules(): Promise<PermissionRules> {
  const permissions = (await readJson(agySettingsPath())).permissions ?? {};
  return {
    allow: stringList(permissions.allow),
    deny: stringList(permissions.deny),
    skipPermissions: await readSkipPermissions(),
  };
}

/**
 * Replaces the allow and deny lists, keeping every other agy setting (and
 * any other `permissions` key, such as `ask`), and stores the skip flag when
 * it is part of the update.
 */
export async function writePermissionRules(rules: PermissionRules): Promise<PermissionRules> {
  const settings = await readJson(agySettingsPath());
  const permissions = { ...(settings.permissions ?? {}), allow: rules.allow, deny: rules.deny };
  await writeJson(agySettingsPath(), { ...settings, permissions });

  if (typeof rules.skipPermissions === 'boolean') {
    const pluginSettings = await readJson(pluginSettingsPath());
    await writeJson(pluginSettingsPath(), { ...pluginSettings, skipPermissions: rules.skipPermissions });
  }
  return readPermissionRules();
}
