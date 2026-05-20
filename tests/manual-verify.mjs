// Manual verification driver. Spawns the built MCP server and walks through
// codex_status -> codex_ask -> codex_review -> codex_implement. Writes a
// markdown transcript to docs/manual-verification.md.
//
// Requires the Codex CLI to be installed and signed in.
// Usage: node tests/manual-verify.mjs
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const serverPath = path.join(repoRoot, 'dist', 'index.js');

const TRANSCRIPT_PATH = path.join(repoRoot, 'docs', 'manual-verification.md');
const TIMEOUT_PER_CALL_MS = 180_000;

const child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'pipe'] });
let stdoutBuf = '';
let stderrBuf = '';
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', (c) => (stdoutBuf += c));
child.stderr.on('data', (c) => (stderrBuf += c));

const send = (msg) => child.stdin.write(JSON.stringify(msg) + '\n');
const pending = new Map();

function awaitResponse(id) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(() => {
      const lines = stdoutBuf.split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          if (obj.id === id) {
            clearInterval(timer);
            resolve(obj);
            return;
          }
        } catch {
          // protocol messages only; ignore non-JSON noise
        }
      }
      if (Date.now() - start > TIMEOUT_PER_CALL_MS) {
        clearInterval(timer);
        reject(new Error(`timeout waiting for id=${id}`));
      }
    }, 200);
  });
}

async function main() {
  // 1) initialize
  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'manual-verify', version: '0' } },
  });
  await awaitResponse(1);
  send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });

  const transcripts = [];

  // 2) codex_status
  console.log('Calling codex_status...');
  send({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'codex_status', arguments: {} } });
  const statusRes = await awaitResponse(10);
  transcripts.push({ tool: 'codex_status', input: {}, output: statusRes.result });

  // 3) codex_ask (read-only, trivial)
  console.log('Calling codex_ask...');
  send({
    jsonrpc: '2.0',
    id: 11,
    method: 'tools/call',
    params: {
      name: 'codex_ask',
      arguments: {
        prompt: 'In one sentence, explain what an MCP server is.',
      },
    },
  });
  const askRes = await awaitResponse(11);
  transcripts.push({
    tool: 'codex_ask',
    input: { prompt: 'In one sentence, explain what an MCP server is.' },
    output: askRes.result,
  });

  // 4) codex_review (review a tiny diff)
  console.log('Calling codex_review...');
  const sampleDiff = `--- a/greet.ts
+++ b/greet.ts
@@
-export function greet(name) {
-  return "Hello " + name;
+export function greet(name: string) {
+  return \`Hello \${name}\`;
}`;
  const reviewArgs = {
    diff: sampleDiff,
    focus_areas: ['type safety', 'edge cases'],
    context: 'Migrating a JavaScript greet function to TypeScript with template literals.',
  };
  send({
    jsonrpc: '2.0',
    id: 12,
    method: 'tools/call',
    params: { name: 'codex_review', arguments: reviewArgs },
  });
  const reviewRes = await awaitResponse(12);
  transcripts.push({ tool: 'codex_review', input: reviewArgs, output: reviewRes.result });

  // 5) codex_implement (in a throwaway tmp dir)
  console.log('Calling codex_implement...');
  const tmpRepo = mkdtempSync(path.join(tmpdir(), 'codex-impl-'));
  // Initialise the dir as a git repo so codex's default sandbox is happy.
  await new Promise((res, rej) => {
    const g = spawn('git', ['init', '-q'], { cwd: tmpRepo });
    g.on('close', (code) => (code === 0 ? res() : rej(new Error('git init failed'))));
  });
  await new Promise((res, rej) => {
    const g = spawn('git', ['commit', '--allow-empty', '-m', 'baseline'], { cwd: tmpRepo });
    g.on('close', () => res());
  });
  const implementArgs = {
    spec: 'Create a file named hello.txt containing exactly the text: hello world (no newline at end is fine).',
    working_directory: tmpRepo,
    approval_mode: 'workspace-write',
  };
  send({
    jsonrpc: '2.0',
    id: 13,
    method: 'tools/call',
    params: { name: 'codex_implement', arguments: implementArgs },
  });
  const implRes = await awaitResponse(13);
  transcripts.push({ tool: 'codex_implement', input: implementArgs, output: implRes.result });

  // Cleanup tmp repo.
  try {
    rmSync(tmpRepo, { recursive: true, force: true });
  } catch (e) {
    console.warn('tmp cleanup warning:', e.message);
  }

  // 6) Write transcript
  mkdirSync(path.dirname(TRANSCRIPT_PATH), { recursive: true });
  const md = renderMarkdown(transcripts);
  writeFileSync(TRANSCRIPT_PATH, md, 'utf8');
  console.log(`\nWrote ${TRANSCRIPT_PATH}`);

  child.kill();
  process.exit(0);
}

function renderMarkdown(items) {
  const lines = [];
  lines.push('# Manual Verification Log');
  lines.push('');
  lines.push(`Generated by \`node tests/manual-verify.mjs\` on ${new Date().toISOString()}.`);
  lines.push('');
  lines.push(
    'Each section below shows the real input and Codex response captured live against the built `dist/index.js` MCP server. The host machine had Codex CLI installed and signed in via `codex login`.',
  );
  lines.push('');
  for (const item of items) {
    lines.push(`## ${item.tool}`);
    lines.push('');
    lines.push('Input:');
    lines.push('```json');
    lines.push(JSON.stringify(item.input, null, 2));
    lines.push('```');
    lines.push('');
    const isError = item.output?.isError === true;
    lines.push(`Result${isError ? ' (isError: true)' : ''}:`);
    const text = item.output?.content?.[0]?.text ?? '(no text content)';
    lines.push('```');
    lines.push(text);
    lines.push('```');
    lines.push('');
  }
  return lines.join('\n');
}

main().catch((err) => {
  console.error('manual-verify failed:', err);
  console.error('---server stderr---');
  console.error(stderrBuf);
  child.kill();
  process.exit(1);
});
