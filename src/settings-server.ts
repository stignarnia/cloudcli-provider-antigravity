import http from 'node:http';

import { readPermissionRules, writePermissionRules } from './permissions.js';

/**
 * The plugin's server entry (manifest `server`): CloudCLI starts it as a
 * child process and proxies the settings panel's `api.rpc()` calls to it.
 *
 *   GET /rules  -> { allow, deny, skipPermissions }
 *   PUT /rules  <- { allow, deny, skipPermissions }
 */

const stringList = (value: unknown): string[] => (
  Array.isArray(value)
    ? Array.from(new Set(value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)))
    : []
);

const readBody = (req: http.IncomingMessage): Promise<string> => new Promise((resolve, reject) => {
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  req.on('error', reject);
});

const send = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
};

const server = http.createServer((req, res) => {
  void (async () => {
    try {
      const route = new URL(req.url ?? '/', 'http://localhost').pathname.replace(/\/+$/, '');
      if (route !== '/rules') {
        send(res, 404, { error: 'Not found' });
        return;
      }
      if (req.method === 'GET') {
        send(res, 200, await readPermissionRules());
        return;
      }
      if (req.method === 'PUT') {
        const body = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>;
        send(res, 200, await writePermissionRules({
          allow: stringList(body.allow),
          deny: stringList(body.deny),
          ...(typeof body.skipPermissions === 'boolean' ? { skipPermissions: body.skipPermissions } : {}),
        }));
        return;
      }
      send(res, 405, { error: 'Method not allowed' });
    } catch (error) {
      send(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  })();
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (address && typeof address === 'object') {
    // CloudCLI waits for this line to learn the port.
    console.log(JSON.stringify({ ready: true, port: address.port }));
  }
});
