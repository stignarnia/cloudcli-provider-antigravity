import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createApprovalService } from '../src/approvals.js';
import type { AnyRecord } from '../src/host.js';
import { agyHooksPath, APPROVAL_HOOK_NAME, ensureApprovalHook } from '../src/hooks.js';
import { decideToolCall, ruleMatches, suggestRule, type PolicyInput } from '../src/policy.js';
import { createTestHost } from './helpers.js';

const run = (CommandLine: string) => ({ name: 'run_command', args: { CommandLine } });
const noRules = { allow: [], deny: [] };
const decide = (overrides: Partial<PolicyInput>) => decideToolCall({
  call: run('ls'),
  permissionMode: 'default',
  skipPermissions: false,
  rules: noRules,
  workspaces: ['/work'],
  ...overrides,
}).decision;

test('policy: deny rules win, allow rules and modes decide, the rest asks', () => {
  assert.equal(decide({}), 'ask');
  assert.equal(decide({ rules: { allow: ['command(ls)'], deny: [] } }), 'allow');
  assert.equal(decide({ rules: { allow: ['command(*)'], deny: ['command(ls)'] } }), 'deny');
  assert.equal(decide({ permissionMode: 'bypassPermissions' }), 'allow');
  assert.equal(decide({ skipPermissions: true }), 'allow');
  assert.equal(decide({ skipPermissions: true, rules: { allow: [], deny: ['command(ls)'] } }), 'deny');

  const write = { name: 'write_file', args: { Path: '/work/a.txt' } };
  assert.equal(decide({ call: write }), 'ask');
  assert.equal(decide({ call: write, permissionMode: 'acceptEdits' }), 'allow');
  assert.equal(decide({ call: { name: 'write_file', args: { Path: '/etc/passwd' } }, permissionMode: 'acceptEdits' }), 'ask');

  assert.equal(decide({ call: { name: 'view_file', args: { AbsolutePath: '/work/src/x.ts' } } }), 'allow');
  assert.equal(decide({ call: { name: 'view_file', args: { AbsolutePath: '/root/.ssh/id_rsa' } } }), 'ask');
  assert.equal(decide({ call: { name: 'manage_task', args: {} } }), 'allow');
  assert.equal(decide({ call: { name: 'open_browser_url', args: { Url: 'https://amazon.it' } } }), 'ask');
});

test('policy: rule matching and the rule "Allow & remember" saves', () => {
  assert.ok(ruleMatches('command(git status)', { kind: 'command', target: 'git status --short' }));
  assert.ok(!ruleMatches('command(git status)', { kind: 'command', target: 'git statusx' }));
  assert.ok(ruleMatches('write_file(/work)', { kind: 'write_file', target: '/work/deep/file' }));
  assert.ok(!ruleMatches('write_file(/work)', { kind: 'write_file', target: '/workspace/file' }));
  assert.ok(!ruleMatches('read_file(/work)', { kind: 'write_file', target: '/work/file' }));

  assert.equal(suggestRule(run('git status --short'), []), 'command(git status)');
  assert.equal(suggestRule(run('wc -l f.txt'), []), 'command(wc)');
  assert.equal(suggestRule({ name: 'write_file', args: { Path: '/work/a/b.txt' } }, ['/work']), 'write_file(/work)');
  assert.equal(suggestRule({ name: 'open_browser_url', args: { Url: 'https://www.amazon.it/x?y' } }, []), 'execute_url(https://www.amazon.it)');
});

test('approvals: an undecided call asks in the chat and waits for the answer', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-approvals-'));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const sent: AnyRecord[] = [];
    const approvals = createApprovalService(createTestHost());
    const registration = await approvals.registerRun({
      appSessionId: 'app-1',
      writer: { send: (message) => sent.push(message as AnyRecord) },
      permissionMode: 'default',
      skipPermissions: false,
      workspaces: [home],
    });
    const url = registration.env.CLOUDCLI_AGY_APPROVAL_URL;

    // An in-workspace read is decided without asking.
    const read = await fetch(url, { method: 'POST', body: JSON.stringify({ toolCall: { name: 'view_file', args: { AbsolutePath: path.join(home, 'x') } } }) });
    assert.deepEqual(await read.json(), { decision: 'allow' });
    assert.equal(sent.length, 0);

    // A command waits for the user.
    const pending = fetch(url, { method: 'POST', body: JSON.stringify({ toolCall: { name: 'run_command', args: { CommandLine: 'git push' } } }) });
    while (!sent.some((message) => message.kind === 'permission_request')) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const request = sent.find((message) => message.kind === 'permission_request')!;
    assert.equal(request.toolName, 'Bash');
    assert.equal((request.context as AnyRecord).rememberRule, 'command(git push)');
    assert.equal(approvals.listPending('app-1').length, 1);

    approvals.resolve(request.requestId as string, { allow: true, rememberEntry: 'command(git push)' });
    assert.deepEqual(await (await pending).json(), { decision: 'allow' });
    assert.ok(sent.some((message) => message.kind === 'permission_resolved'));
    assert.equal(approvals.listPending('app-1').length, 0);

    // The remembered rule is now an agy allow rule, so the next push does not ask.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const again = await fetch(url, { method: 'POST', body: JSON.stringify({ toolCall: { name: 'run_command', args: { CommandLine: 'git push origin' } } }) });
    assert.deepEqual(await again.json(), { decision: 'allow' });

    // A request still open when the run ends is cancelled and denied.
    sent.length = 0;
    const open = fetch(url, { method: 'POST', body: JSON.stringify({ toolCall: { name: 'run_command', args: { CommandLine: 'rm x' } } }) });
    while (!sent.some((message) => message.kind === 'permission_request')) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    registration.dispose('The run ended.');
    assert.equal(((await (await open).json()) as AnyRecord).decision, 'deny');
    assert.ok(sent.some((message) => message.kind === 'permission_cancelled'));

    // After the run, its URL answers deny.
    const stale = await fetch(url, { method: 'POST', body: JSON.stringify({ toolCall: { name: 'run_command', args: { CommandLine: 'ls' } } }) });
    assert.equal(((await stale.json()) as AnyRecord).decision, 'deny');
  } finally {
    process.env.HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

const hookScript = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'approval-hook.js');

const runHook = (env: NodeJS.ProcessEnv, input: string): Promise<string> => new Promise((resolve, reject) => {
  const child = execFile(process.execPath, [hookScript], { env }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  child.stdin?.end(input);
});

test('hook script: outside CloudCLI it defers to agy ("ask"); inside it relays the decision', async () => {
  const outside = await runHook({ ...process.env, CLOUDCLI_AGY_APPROVAL_URL: '' }, '{"toolCall":{"name":"run_command","args":{}}}');
  assert.deepEqual(JSON.parse(outside), { decision: 'ask' });

  const approvals = createApprovalService(createTestHost());
  const registration = await approvals.registerRun({
    appSessionId: 'app-2', writer: { send: () => {} }, permissionMode: 'bypassPermissions', skipPermissions: false, workspaces: ['/'],
  });
  const inside = await runHook({ ...process.env, ...registration.env }, '{"toolCall":{"name":"run_command","args":{"CommandLine":"ls"}}}');
  assert.deepEqual(JSON.parse(inside), { decision: 'allow' });
  registration.dispose('done');
});

test('installing the hook keeps the user\'s other hooks', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hooks-'));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    fs.mkdirSync(path.dirname(agyHooksPath()), { recursive: true });
    fs.writeFileSync(agyHooksPath(), JSON.stringify({ 'my-linter': { PostToolUse: [] } }));
    assert.equal(await ensureApprovalHook(), true);
    const hooks = JSON.parse(fs.readFileSync(agyHooksPath(), 'utf8'));
    assert.deepEqual(hooks['my-linter'], { PostToolUse: [] });
    assert.equal(hooks[APPROVAL_HOOK_NAME].PreToolUse[0].matcher, '*');
    assert.match(hooks[APPROVAL_HOOK_NAME].PreToolUse[0].hooks[0].command, /approval-hook\.js'$/);
  } finally {
    process.env.HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
