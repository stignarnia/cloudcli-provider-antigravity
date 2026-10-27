/**
 * agy PreToolUse hook (installed into ~/.gemini/config/hooks.json by hooks.ts).
 *
 * Inside a CloudCLI run, CLOUDCLI_AGY_APPROVAL_URL points at the plugin's
 * approval endpoint: the tool call is posted there and the answer (which may
 * wait for the user to click Allow / Deny in the chat) is returned to agy.
 *
 * Anywhere else (agy started from a terminal) it answers "ask", which leaves
 * the decision to agy's normal permission handling, unchanged.
 *
 * Standalone: runs as `node approval-hook.js`, imports nothing from the plugin.
 */

const url = process.env.CLOUDCLI_AGY_APPROVAL_URL;

function reply(decision: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(decision));
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  const input = await readStdin();
  if (!url) {
    reply({ decision: 'ask' });
    return;
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: input,
    });
    const body = await response.json() as Record<string, unknown>;
    reply(typeof body.decision === 'string' ? body : { decision: 'deny', reason: 'CloudCLI returned no decision.' });
  } catch (error) {
    reply({
      decision: 'deny',
      reason: `CloudCLI could not be asked for approval: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

void main();
