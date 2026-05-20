// Standalone smoke test: spawn the built MCP server, list tools, then call
// codex_status. Exits 0 on success, 1 otherwise. Not part of the vitest suite.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(__dirname, '..', 'dist', 'index.js');

const child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'inherit'] });

let stdoutBuf = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (c) => (stdoutBuf += c));

const send = (msg) => {
  child.stdin.write(JSON.stringify(msg) + '\n');
};

const messages = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } } },
  { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
  { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'codex_status', arguments: {} } },
];

for (const m of messages) send(m);

setTimeout(() => {
  child.kill();
  const lines = stdoutBuf.split('\n').filter(Boolean);
  const parsed = [];
  for (const line of lines) {
    try { parsed.push(JSON.parse(line)); } catch { parsed.push({ raw: line }); }
  }

  const toolsListResp = parsed.find((p) => p.id === 2);
  if (!toolsListResp || !toolsListResp.result || !Array.isArray(toolsListResp.result.tools)) {
    console.error('FAIL: no valid tools/list response');
    console.error(JSON.stringify(parsed, null, 2));
    process.exit(1);
  }
  const names = toolsListResp.result.tools.map((t) => t.name).sort();
  const expected = ['codex_ask', 'codex_implement', 'codex_review', 'codex_status'];
  if (names.join(',') !== expected.join(',')) {
    console.error(`FAIL: tool names mismatch. expected=${expected.join(',')} actual=${names.join(',')}`);
    process.exit(1);
  }

  const callResp = parsed.find((p) => p.id === 3);
  if (!callResp || !callResp.result || !Array.isArray(callResp.result.content)) {
    console.error('FAIL: no valid tools/call response for codex_status');
    console.error(JSON.stringify(parsed, null, 2));
    process.exit(1);
  }
  const text = callResp.result.content[0]?.text ?? '';
  if (!text.includes('Codex CLI:') || !text.includes('Auth:')) {
    console.error('FAIL: codex_status output missing expected fields');
    console.error(text);
    process.exit(1);
  }

  console.log(`OK: 4 tools registered (${names.join(',')}); codex_status call returned ${text.length} chars`);
  process.exit(0);
}, 20000);
