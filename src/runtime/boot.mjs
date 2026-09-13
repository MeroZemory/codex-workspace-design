import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { runtimePaths } from './paths.mjs';
import { serveIpc } from './ipc.mjs';
import { WorkspaceService } from './service.mjs';
import { AccountManager } from './accounts.mjs';
import { CodexSession } from './codex.mjs';

export async function findCodex() {
  const paths = [process.env.CODEX_WORKSPACE_CODEX_PATH];
  const npmRoot = path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@openai', 'codex', 'node_modules');
  paths.push(path.join(npmRoot, '@openai', `codex-win32-${process.arch}`, 'vendor', `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-pc-windows-msvc`, 'bin', 'codex.exe'));
  for (const directory of (process.env.PATH || '').split(path.delimiter)) paths.push(path.join(directory, process.platform === 'win32' ? 'codex.exe' : 'codex'));
  for (const candidate of paths.filter(Boolean)) { try { if ((await fs.stat(candidate)).isFile()) return candidate; } catch {} }
  return null;
}

const paths = runtimePaths();
await fs.mkdir(paths.dataDir, { recursive: true, mode: 0o700 });
let token;
try { token = await fs.readFile(paths.token, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (!/^[0-9a-f]{64}$/.test(token || '')) token = randomBytes(32).toString('hex');
let service, timer;
let markReady;
const bootReady = new Promise(resolve => { markReady = resolve; });
const ipc = serveIpc({ pipe: paths.pipe, token, dispatch: async (...args) => {
  await bootReady;
  const result = await service.dispatch(...args);
  if (args[0] === 'runtime.shutdown' && result.shutdown) setTimeout(shutdown, 100);
  return result;
}, onDisconnect: id => service?.disconnect(id) });
async function shutdown() {
  clearInterval(timer); await service.save(); await ipc.close(); process.exit(0);
}
// The OS pipe bind is the singleton lock, acquired before any account/state writes.
// No PID-based process killing or stale startup-lock deletion is involved.
try { await ipc.listen(); }
catch (error) { if (error.code === 'EADDRINUSE') process.exit(0); throw error; }
try {
  const accounts = new AccountManager({ dataDir: paths.dataDir, onChange: () => service?.changed() });
  await accounts.init();
  const ready = new WorkspaceService({ paths, accounts, Session: CodexSession, codexPath: await findCodex(), broadcast: event => ipc.broadcast(event) });
  await ready.init(); service = ready;
  await fs.writeFile(paths.token, token, { mode: 0o600 });
  markReady();
  accounts.importOrca().catch(error => {
    accounts.orcaDiscovery = { status: 'error', error: error.message, found: 0, recognized: 0, imported: 0, duplicates: 0, invalid: 0 };
    service.changed();
  });
  timer = setInterval(() => service.refreshAccounts().catch(error => ipc.broadcast({ type: 'error', message: error.message })), 60000);
  console.log('Codex Workspace runtime ready');
} catch (error) {
  console.error(`Runtime startup failed: ${error.message}`); await ipc.close(); process.exit(1);
}
