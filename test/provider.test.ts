import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { parseAgyVersion } from '../src/auth.js';
import { stepsToMessages, type AgyStep } from '../src/history.js';
import { parseAgyModels } from '../src/models.js';
import { createStreamState, normalizeAgyEvent } from '../src/normalize.js';
import { ProtoView } from '../src/protobuf.js';
import { buildAgyArgs, buildUserInputLine, resolveEffortArgs } from '../src/runtime.js';
import { firstWorkspacePath, parseAgyTime } from '../src/sessions.js';
import { mapAgyTool } from '../src/tools.js';
import { createMessage, createTestHost, fixturePath, readNdjson } from './helpers.js';

const normalizeFixture = (name: string) => {
  const state = createStreamState();
  return readNdjson(name).flatMap((event) => normalizeAgyEvent(event, 'app-session', createMessage, state));
};

test('a tool step becomes one tool_use and one tool_result with the same id', () => {
  const messages = normalizeFixture('tools-default.ndjson');
  const toolUses = messages.filter((message) => message.kind === 'tool_use');
  const toolResults = messages.filter((message) => message.kind === 'tool_result');

  assert.deepEqual(toolUses.map((message) => message.toolName), ['Read', 'Write', 'Bash']);
  assert.equal(toolResults.length, 3);
  assert.deepEqual(toolResults.map((message) => message.toolId), toolUses.map((message) => message.toolId));
  assert.equal(toolUses[2].toolInput && (toolUses[2].toolInput as { command: string }).command, 'wc -l upper.txt');
  assert.ok(messages.every((message) => message.sessionId === 'app-session'));
});

test('tools agy auto-denied in a headless run are explained in the chat', () => {
  const errors = normalizeFixture('tools-default.ndjson').filter((message) => message.kind === 'error');
  assert.equal(errors.length, 1);
  assert.match(String(errors[0].content), /auto-denied RunCommand/);
});

test('a streamed answer is deltas closed by a stream_end, plus the turn token budget', () => {
  const messages = normalizeFixture('resume.ndjson');
  const text = messages.filter((message) => message.kind === 'stream_delta').map((message) => message.content).join('');
  assert.equal(text, 'The first command I ran was `ls -la && cat upper.txt`.\n');
  assert.equal(messages.filter((message) => message.kind === 'stream_end').length, 1);
  const status = messages.find((message) => message.kind === 'status');
  assert.ok(status && (status.tokenBudget as { used: number }).used > 0);
});

test('user input and system steps produce nothing (the client shows the prompt itself)', () => {
  const messages = normalizeFixture('resume.ndjson');
  assert.ok(!messages.some((message) => message.role === 'user'));
});

test('agy models are grouped by base id with their effort variants', () => {
  const models = parseAgyModels(fs.readFileSync(fixturePath('models.txt'), 'utf8'));
  const argon = models.OPTIONS.find((option) => option.value === 'gemini-4-argon');
  assert.ok(argon, 'gemini-4-argon is listed once');
  assert.equal(argon.label, 'Gemini 4 Argon');
  assert.deepEqual(argon.effort?.values.map((value) => value.value), ['low', 'medium', 'high']);
  assert.equal(argon.effort?.default, 'medium');
  assert.equal(models.DEFAULT, models.OPTIONS[0].value);
  assert.ok(!models.OPTIONS.some((option) => /-(low|medium|high)$/.test(option.value)));
});

test('agy arguments: resume, model with effort, permission mode', () => {
  assert.deepEqual(
    buildAgyArgs({
      providerSessionId: 'conv-1',
      model: 'gemini-4-argon',
      effortArgs: resolveEffortArgs('gemini-4-argon', 'high', ['low', 'medium', 'high']),
      permissionMode: 'bypassPermissions',
    }),
    [
      '--input-format', 'stream-json', '--output-format', 'stream-json',
      '--conversation', 'conv-1',
      '--model', 'gemini-4-argon', '--effort', 'high',
      '--dangerously-skip-permissions',
    ],
  );
  assert.deepEqual(resolveEffortArgs('gemini-4-argon', 'default', ['low']), []);
  assert.deepEqual(resolveEffortArgs('gemini-4-argon', 'max', ['low']), []);
  assert.deepEqual(buildAgyArgs({ providerSessionId: null, effortArgs: [], permissionMode: 'plan' }).slice(-2), ['--mode', 'plan']);
});

test('the prompt goes to agy as one stream-json user message', () => {
  const line = buildUserInputLine('hello\n"quoted"');
  assert.ok(line.endsWith('\n'));
  assert.deepEqual(JSON.parse(line), { event: 'user', message: { role: 'user', content: 'hello\n"quoted"' } });
});

test('history steps become normalized prompt, answer, and tool messages', () => {
  const host = createTestHost();
  const timestamp = '2026-10-26T18:39:09.522Z';
  const steps: AgyStep[] = [
    { kind: 'user', index: 1, timestamp, text: 'Summarize the project files.' },
    {
      kind: 'tool', index: 2, timestamp, name: 'run_command',
      args: JSON.stringify({ CommandLine: 'ls -la' }), output: 'Command exited with code 0.', denied: false,
    },
    { kind: 'agent', index: 3, timestamp, text: 'The project contains its source and documentation.' },
  ];
  const messages = stepsToMessages(host, 'conversation-test', 'app-session', steps);

  assert.deepEqual(messages.filter((message) => message.role === 'user').map((message) => message.content), [
    'Summarize the project files.',
  ]);
  const tool = messages.find((message) => message.kind === 'tool_use');
  assert.equal(tool?.toolName, 'Bash');
  assert.equal((tool?.toolInput as { command: string }).command, 'ls -la');
  assert.equal((tool?.toolResult as { content: string }).content, 'Command exited with code 0.');
  assert.equal(messages.find((message) => message.role === 'assistant')?.content, 'The project contains its source and documentation.');
  assert.ok(messages.every((message) => message.id.startsWith('conversation-test_')));
  assert.ok(messages.every((message) => message.timestamp === timestamp));
});

test('agy timestamps and workspace uris', () => {
  assert.equal(parseAgyTime('2026-10-26 18:39:09.522869202+00:00'), '2026-10-26T18:39:09.522Z');
  assert.equal(parseAgyTime('0001-01-01 00:00:00+00:00'), undefined);
  assert.equal(firstWorkspacePath('["file:///workspace/agy%20x/Test"]'), '/workspace/agy x/Test');
  assert.equal(firstWorkspacePath('[]'), undefined);
});

test('a short text that also parses as a protobuf message is still read as text', () => {
  // field 20 { field 1: "hi" }; "hi" = 0x68 0x69 is also a valid message (field 13 = 105).
  const view = ProtoView.decode(Uint8Array.from([0xa2, 0x01, 0x04, 0x0a, 0x02, 0x68, 0x69]));
  assert.equal(view.string('20.1'), 'hi');
});

test('agy --version output is parsed to a semver', () => {
  assert.equal(parseAgyVersion('1.4.8\n'), '1.4.8');
  assert.equal(parseAgyVersion('agy version 2.0.1-beta.3'), '2.0.1-beta.3');
  assert.equal(parseAgyVersion('dev build'), null);
});

test('unknown agy tools pass through untouched', () => {
  assert.deepEqual(mapAgyTool('browser_subagent', { Task: 'x' }), { toolName: 'browser_subagent', toolInput: { Task: 'x' } });
});
