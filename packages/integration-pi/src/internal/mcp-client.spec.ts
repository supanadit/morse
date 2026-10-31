import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { McpInspector, type McpServerSpec } from './mcp-client.js';

/**
 * The inspector is a client we own, so its framing is the thing to lock down:
 * newline-delimited JSON-RPC over stdio, and POST/JSON or POST/SSE over
 * Streamable HTTP. A fake server in each transport answers the lifecycle, and
 * the probe has to report what it found — or why it could not connect.
 */

const tempDirs: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

const FAKE_STDIO = `
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');
process.stderr.write('fake server booted\\n');
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {}, resources: {}, prompts: {} },
      serverInfo: { name: 'fake-stdio', version: '1.0.0' },
    } });
  } else if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'echo', description: 'Echo it' }] } });
  } else if (msg.method === 'resources/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { resources: [{ uri: 'file:///a.txt', name: 'a.txt' }] } });
  } else if (msg.method === 'resources/templates/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { resourceTemplates: [{ uriTemplate: 'file:///{path}' }] } });
  } else if (msg.method === 'prompts/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { prompts: [{ name: 'greet' }] } });
  } else if (msg.id !== undefined) {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } });
  }
});
`;

function stdioScript(): string {
  const dir = mkdtempSync(join(tmpdir(), 'morse-mcp-'));
  tempDirs.push(dir);
  const path = join(dir, 'server.cjs');
  writeFileSync(path, FAKE_STDIO);
  return path;
}

function stdioSpec(): McpServerSpec {
  return { type: 'stdio', command: process.execPath, args: [stdioScript()] };
}

/** An HTTP MCP server that answers with JSON, or SSE when asked. */
async function httpServer(
  options: { sse?: boolean; auth?: boolean } = {},
): Promise<{ url: string }> {
  const server = createServer((request, response) => {
    if (request.method === 'DELETE') {
      response.writeHead(204).end();
      return;
    }
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      if (options.auth) {
        response.writeHead(401, {
          'www-authenticate': 'Bearer resource_metadata="https://auth.example/.well-known/oauth-protected-resource"',
        }).end();
        return;
      }
      const message = JSON.parse(body) as { id?: number; method?: string };
      const result = resultFor(message.method);
      const payload = { jsonrpc: '2.0', id: message.id, ...(result === undefined ? { error: { code: -32601, message: 'nope' } } : { result }) };
      if (options.sse) {
        response.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 'session-1' });
        response.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
        response.end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'session-1' });
      response.end(JSON.stringify(payload));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return { url: `http://127.0.0.1:${port}/mcp` };
}

function resultFor(method: string | undefined): unknown {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {}, prompts: {} },
        serverInfo: { name: 'fake-http', version: '2.0.0' },
      };
    case 'tools/list':
      return { tools: [{ name: 'add', inputSchema: { type: 'object' } }] };
    case 'prompts/list':
      return { prompts: [{ name: 'review', arguments: [{ name: 'path', required: true }] }] };
    default:
      return undefined;
  }
}

describe('McpInspector stdio', () => {
  it('initializes, lists tools/resources/prompts, and keeps the stderr log', async () => {
    const result = await new McpInspector().inspect(stdioSpec(), { cwd: process.cwd() });

    expect(result.ok).toBe(true);
    expect(result.serverInfo).toEqual({ name: 'fake-stdio', version: '1.0.0' });
    expect(result.protocolVersion).toBe('2025-06-18');
    expect(result.tools.map((tool) => tool.name)).toEqual(['echo']);
    expect(result.resources.map((resource) => resource.uri)).toEqual(['file:///a.txt']);
    expect(result.resourceTemplates.map((template) => template.uriTemplate)).toEqual(['file:///{path}']);
    expect(result.prompts.map((prompt) => prompt.name)).toEqual(['greet']);
    expect(result.logs?.join('')).toContain('fake server booted');
  });

  it('reports a command that does not exist as a spawn failure, not a hang', async () => {
    const result = await new McpInspector().inspect(
      { type: 'stdio', command: join(tmpdir(), 'morse-no-such-mcp-binary') },
      { cwd: process.cwd(), timeoutMs: 4_000 },
    );

    expect(result.ok).toBe(false);
    expect(['spawn', 'unreachable']).toContain(result.error?.kind);
    expect(result.error?.message).toBeTruthy();
  });
});

describe('McpInspector streamable http', () => {
  it('connects over a JSON response', async () => {
    const { url } = await httpServer();
    const result = await new McpInspector().inspect({ type: 'http', url }, { cwd: process.cwd() });

    expect(result.ok).toBe(true);
    expect(result.serverInfo?.name).toBe('fake-http');
    expect(result.tools.map((tool) => tool.name)).toEqual(['add']);
    expect(result.prompts[0]?.arguments?.[0]).toMatchObject({ name: 'path', required: true });
  });

  it('connects when the server answers on an SSE stream', async () => {
    const { url } = await httpServer({ sse: true });
    const result = await new McpInspector().inspect({ type: 'http', url }, { cwd: process.cwd() });

    expect(result.ok).toBe(true);
    expect(result.tools.map((tool) => tool.name)).toEqual(['add']);
  });

  it('classifies a 401 as auth and carries the resource metadata URL', async () => {
    const { url } = await httpServer({ auth: true });
    const result = await new McpInspector().inspect({ type: 'http', url }, { cwd: process.cwd() });

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ kind: 'auth', status: 401 });
    expect(result.error?.authUrl).toContain('oauth-protected-resource');
  });

  it('reports an unreachable endpoint with the network code', async () => {
    const result = await new McpInspector().inspect(
      { type: 'http', url: 'http://127.0.0.1:1/mcp' },
      { cwd: process.cwd(), timeoutMs: 4_000 },
    );

    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('unreachable');
  });
});
