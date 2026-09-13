import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { WorkspaceService } from '../src/runtime/service.mjs';
import { runtimePaths } from '../src/runtime/paths.mjs';
import { serveIpc, connectIpc } from '../src/runtime/ipc.mjs';
import { Screen } from '../src/runtime/screen.mjs';

async function fixture(t, Session) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cw-unit-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const accounts = { list: () => [{ id: 'a' }], choose: () => 'a', getAuth: async () => ({}) };
  const service = new WorkspaceService({ paths: runtimePaths(dir), accounts, Session, codexPath: 'mock' });
  await service.init(); return { service, dir };
}
class Session {
  constructor(options) { Object.assign(this, options); this.inputs = []; }
  async start() { this.onState({ status: 'idle', threadId: randomUUID() }); }
  async stop() { this.stopped = true; }
  async switchAccount() {}
  async getUsage() { throw new Error('No network fixture'); }
  input(data) { this.inputs.push(data); }
  resize() {}
}
test('deleting a starting session tombstones callbacks and never resurrects its process', async t => {
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  class Slow extends Session { async start() { started = this; await gate; this.onState({ status: 'running' }); } }
  const { service, dir } = await fixture(t, Slow);
  const creation = service.create({ cwd: dir });
  while (!started) await new Promise(resolve => setTimeout(resolve, 5));
  const id = [...service.sessions.keys()][0];
  await service.remove(id); release();
  assert.equal(await creation, null); assert.equal(service.sessions.size, 0); assert.equal(started.stopped, true);
});
test('closing a view does not end session; input ownership and review are independent', async t => {
  const { service, dir } = await fixture(t, Session);
  const session = await service.create({ cwd: dir });
  await service.dispatch('terminal.attach', { id: session.id, viewId: 'one', cols: 80, rows: 24 }, { clientId: 'first' });
  await service.dispatch('terminal.attach', { id: session.id, viewId: 'two', cols: 90, rows: 30 }, { clientId: 'second' });
  await assert.rejects(service.dispatch('terminal.input', { id: session.id, viewId: 'one', data: 'x' }, { clientId: 'first' }));
  await service.dispatch('terminal.input', { id: session.id, viewId: 'two', data: '가' }, { clientId: 'second' });
  assert.deepEqual(service.adapters.get(session.id).inputs, ['가']);
  service.requireSession(session.id).reviewNeeded = true; service.requireSession(session.id).unread = true;
  await service.dispatch('session.read', { id: session.id });
  assert.equal(service.requireSession(session.id).unread, false); assert.equal(service.requireSession(session.id).reviewNeeded, true);
  service.disconnect('second'); assert.equal(service.adapters.get(session.id).stopped, undefined);
  await service.remove(session.id);
});
test('IPC refuses wrong token without dispatching and survives split Unicode packets', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cw-ipc-'));
  const { pipe } = runtimePaths(dir); let calls = 0;
  const token = 'a'.repeat(64);
  const ipc = serveIpc({ pipe, token, dispatch: (_method, params) => { calls++; return params; } });
  await ipc.listen(); t.after(async () => { await ipc.close(); await fs.rm(dir, { recursive: true, force: true }); });
  for (const value of [{ token: 'wrong', method: 'x' }, { token: '한'.repeat(64), method: 'x' }, null]) {
    await new Promise(resolve => { const bad = net.createConnection(pipe, () => bad.write(JSON.stringify(value) + '\n')); bad.on('close', resolve); });
  }
  assert.equal(calls, 0);
  const client = await connectIpc(pipe, token); t.after(() => client.close());
  assert.deepEqual(await client.invoke('x', { text: '한글 테스트' }), { text: '한글 테스트' });
  const fragmented = await new Promise((resolve, reject) => {
    const socket = net.createConnection(pipe); let output = '';
    socket.setEncoding('utf8'); socket.on('error', reject);
    socket.on('data', data => { output += data; if (output.includes('\n')) { socket.destroy(); resolve(JSON.parse(output.trim())); } });
    socket.on('connect', () => {
      const request = Buffer.from(JSON.stringify({ id: 7, method: 'x', token, params: { text: '한글' } }) + '\n');
      const split = request.indexOf(Buffer.from('한')) + 1;
      socket.write(request.subarray(0, split));
      setTimeout(() => socket.write(request.subarray(split)), 10);
    });
  });
  assert.equal(fragmented.result.text, '한글'); assert.equal(calls, 2);
});
test('canonical screen attach has a consistent sequence and ANSI state', async () => {
  const chunks = [], screen = new Screen(output => chunks.push(output), { cols: 40, rows: 8 });
  screen.write('\x1b[31mHello'); screen.write('\r\n세계');
  const snapshot = await screen.snapshot();
  assert.equal(snapshot.seq, 2); assert.match(snapshot.data, /Hello/); assert.match(snapshot.data, /세계/);
  assert.deepEqual(chunks.map(c => c.seq), [1, 2]);
  await screen.dispose();
});
test('shutdown waits for account lookup and deletion still stops children when disk save fails', async t => {
  const { service, dir } = await fixture(t, Session);
  let release;
  service.accounts.getAuth = () => new Promise(resolve => { release = resolve; });
  const creation = service.create({ cwd: dir });
  while (!release) await new Promise(resolve => setTimeout(resolve, 5));
  await assert.rejects(service.dispatch('runtime.shutdown', {}), /진행 중/);
  release({}); const session = await creation;
  const adapter = service.adapters.get(session.id);
  service.save = async () => { throw new Error('simulated disk failure'); };
  await assert.rejects(service.remove(session.id), /disk failure/);
  assert.equal(adapter.stopped, true); assert.equal(service.pendingStops, 0);
});
test('canonical terminal answers cursor queries while every UI is disconnected', async () => {
  const replies = [];
  const screen = new Screen(() => {}, { cols: 80, rows: 24, onInput: data => replies.push(data) });
  screen.write('hello\x1b[6n'); await screen.snapshot();
  assert.deepEqual(replies, ['\x1b[1;6R']); await screen.dispose();
});
