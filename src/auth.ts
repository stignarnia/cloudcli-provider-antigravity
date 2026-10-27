import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';

import { AGY_BINARY, agyOAuthTokenPath, PROVIDER_ID } from './paths.js';

export type CliVersionProbe = { installed: boolean; exitCode: number | null; version: string | null };

/** `agy --version` prints a bare semver (`1.4.8`). */
export function parseAgyVersion(output: string): string | null {
  return /\b(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)\b/.exec(output)?.[1] ?? null;
}

/**
 * Runs `agy --version`. Synchronous because CloudCLI's IProviderAuth contract
 * (checkInstalled) is; agy answers in well under a second.
 */
export function checkInstalled(): CliVersionProbe {
  const result = spawnSync(AGY_BINARY, ['--version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 5000,
  });
  if (result.error) {
    // A timeout still means the binary is there.
    const timedOut = (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
    return { installed: timedOut, exitCode: null, version: null };
  }
  return {
    installed: true,
    exitCode: result.status,
    version: result.status === 0 ? parseAgyVersion(String(result.stdout ?? '')) : null,
  };
}

/**
 * Installed = `agy --version` runs. Signed in = agy's OAuth token file is
 * present and non-empty; agy refreshes it itself, and a stale one shows up
 * as an auth error in the chat on the next run.
 */
export function createAuth() {
  return {
    checkInstalled,

    async getStatus() {
      const probe = checkInstalled();
      if (!probe.installed) {
        return {
          installed: false,
          installedVersion: null,
          provider: PROVIDER_ID,
          authenticated: false,
          email: null,
          method: null,
          error: `The agy CLI was not found (looked for ${AGY_BINARY}).`,
        };
      }

      const authenticated = await fs.stat(agyOAuthTokenPath())
        .then((stats) => stats.isFile() && stats.size > 0)
        .catch(() => false);

      return {
        installed: true,
        installedVersion: probe.version,
        provider: PROVIDER_ID,
        authenticated,
        email: null,
        method: authenticated ? 'oauth' : null,
      };
    },
  };
}
