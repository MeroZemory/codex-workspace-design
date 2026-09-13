import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import fs from 'node:fs';

export function runtimePaths(dataDir = process.env.CODEX_WORKSPACE_DATA_DIR || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'CodexWorkspace')) {
  let identity = path.resolve(dataDir);
  try { identity = fs.realpathSync.native(identity); } catch {
    try { identity = path.join(fs.realpathSync.native(path.dirname(identity)), path.basename(identity)); } catch {}
  }
  if (process.platform === 'win32') identity = identity.toLowerCase();
  const key = createHash('sha256').update(identity).digest('hex').slice(0, 20);
  return { dataDir, pipe: process.platform === 'win32' ? `\\\\.\\pipe\\codex-workspace-${key}` : path.join(dataDir, 'runtime.sock'), token: path.join(dataDir, 'ipc-token'), lock: path.join(dataDir, 'startup.lock'), state: path.join(dataDir, 'workspace.json') };
}
