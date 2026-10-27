import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  agySettingsPath,
  pluginSettingsPath,
  readPermissionRules,
  readSkipPermissions,
  writePermissionRules,
} from '../src/permissions.js';
import { resolvePermissionArgs } from '../src/runtime.js';

/** Runs `body` with HOME pointing at a fresh temp directory. */
async function withTempHome(body: () => Promise<void>) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-perms-'));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    await body();
  } finally {
    process.env.HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('saving permission rules keeps every other agy setting', () => withTempHome(async () => {
  fs.mkdirSync(path.dirname(agySettingsPath()), { recursive: true });
  fs.writeFileSync(agySettingsPath(), JSON.stringify({
    colorScheme: 'dark',
    trustedWorkspaces: ['/work'],
    permissions: { allow: ['command(ls)'], ask: ['command(git push)'] },
  }));

  assert.deepEqual(await readPermissionRules(), { allow: ['command(ls)'], deny: [], skipPermissions: false });

  const saved = await writePermissionRules({ allow: ['command(ls)', 'command(wc)'], deny: ['command(rm)'] });
  assert.deepEqual(saved, { allow: ['command(ls)', 'command(wc)'], deny: ['command(rm)'], skipPermissions: false });

  const onDisk = JSON.parse(fs.readFileSync(agySettingsPath(), 'utf8'));
  assert.equal(onDisk.colorScheme, 'dark');
  assert.deepEqual(onDisk.trustedWorkspaces, ['/work']);
  assert.deepEqual(onDisk.permissions.ask, ['command(git push)']);
}));

test('a missing settings.json reads as no rules and is created on save', () => withTempHome(async () => {
  assert.deepEqual(await readPermissionRules(), { allow: [], deny: [], skipPermissions: false });
  await writePermissionRules({ allow: ['read_url(*)'], deny: [] });
  assert.deepEqual(JSON.parse(fs.readFileSync(agySettingsPath(), 'utf8')), { permissions: { allow: ['read_url(*)'], deny: [] } });
  assert.equal(fs.existsSync(pluginSettingsPath()), false, 'no skip flag sent, so no plugin settings written');
}));

test('"skip permission prompts" is stored by the plugin, not in agy\'s settings', () => withTempHome(async () => {
  await writePermissionRules({ allow: [], deny: [], skipPermissions: true });
  assert.equal(await readSkipPermissions(), true);
  assert.equal(JSON.parse(fs.readFileSync(agySettingsPath(), 'utf8')).skipPermissions, undefined);

  // Saving the lists without the flag leaves it as it was.
  await writePermissionRules({ allow: ['command(ls)'], deny: [] });
  assert.equal(await readSkipPermissions(), true);

  await writePermissionRules({ allow: ['command(ls)'], deny: [], skipPermissions: false });
  assert.equal(await readSkipPermissions(), false);
}));

test('skip permissions bypasses every mode except plan', () => {
  assert.deepEqual(resolvePermissionArgs('default', true), ['--dangerously-skip-permissions']);
  assert.deepEqual(resolvePermissionArgs('acceptEdits', true), ['--dangerously-skip-permissions']);
  assert.deepEqual(resolvePermissionArgs('plan', true), ['--mode', 'plan']);
  assert.deepEqual(resolvePermissionArgs('default', false), []);
  assert.deepEqual(resolvePermissionArgs('acceptEdits', false), ['--mode', 'accept-edits']);
  assert.deepEqual(resolvePermissionArgs('bypassPermissions', false), ['--dangerously-skip-permissions']);
});
