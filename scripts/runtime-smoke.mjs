import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runtimePaths } from '../src/runtime/paths.mjs';
import { connectIpc } from '../src/runtime/ipc.mjs';
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cw-singleton-'));
const paths = runtimePaths(dataDir), children = [];
let client;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  for (let i = 0; i < 2; i++) children.push(spawn(process.execPath, ['src/runtime/boot.mjs'], { windowsHide: true, stdio: 'ignore', env: { ...process.env, CODEX_WORKSPACE_DATA_DIR: dataDir } }));
  for (let i = 0; i < 100; i++) {
    try { client = await connectIpc(paths.pipe, await fs.readFile(paths.token, 'utf8')); break; } catch { await wait(100); }
  }
  assert.ok(client, 'One runtime must accept connections');
  const snapshot = await client.invoke('snapshot'); assert.equal(snapshot.sessions.length, 0);
  for (let i = 0; i < 30 && children.every(c => c.exitCode === null); i++) await wait(100);
  assert.equal(children.filter(c => c.exitCode === null).length, 1, 'OS pipe permits exactly one runtime writer');
  await client.invoke('runtime.shutdown'); client.close(); client = null;
  for (let i = 0; i < 50 && children.some(c => c.exitCode === null); i++) await wait(100);
  assert.ok(children.every(c => c.exitCode !== null), 'Explicit shutdown closes runtime');
  console.log('PASS: two concurrent runtime launches produce one writer and orderly shutdown.');
} finally {
  client?.close();
  for (const child of children) if (child.exitCode === null) child.kill();
  await wait(200);
  if (path.dirname(dataDir) === path.resolve(os.tmpdir()) && path.basename(dataDir).startsWith('cw-singleton-')) await fs.rm(dataDir, { recursive: true, force: true });
}
