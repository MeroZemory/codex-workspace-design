import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WorkspaceService } from '../src/runtime/service.mjs';
import { runtimePaths } from '../src/runtime/paths.mjs';
import { serveIpc } from '../src/runtime/ipc.mjs';

// Synthetic adapters isolate renderer/IPC behavior from paid requests and real credentials.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cw-workspace-e2e-'));
const paths = runtimePaths(dataDir), token = randomUUID();
const adapters = new Map();
class MockSession {
  constructor(options) { Object.assign(this, options); this.inputs = []; adapters.set(this.id, this); }
  async start() { this.onState({ status: 'idle', accountId: this.accountId, accountState: 'applied', accountVerification: 'identity', accountAppliedAt: Date.now() }); }
  async stop() { this.stopped = true; }
  resize(cols, rows) { this.dimensions = { cols, rows }; }
  input(data) { this.inputs.push(data); this.onOutput(data); }
  async getUsage() { return {}; }
}
const accounts = {
  list: () => ['primary', 'secondary', 'reserve'].map((id, index) => ({ id, label: `개인 계정 ${index + 1}`, email: `demo-${index + 1}@example.test`, plan: 'Pro', status: 'ready', usage: { windows: [{ kind: 'primary', usedPercent: 24 + index * 17, resetsAt: Date.now() + (index + 1) * 3600000 }] } })),
  choose: () => 'primary', getAuth: async () => ({}), updateUsage: async () => {},
};
let ipc, app;
const service = new WorkspaceService({ paths, accounts, Session: MockSession, codexPath: 'synthetic-test-adapter', broadcast: event => ipc?.broadcast(event) });
try {
  await service.init();
  const statuses = ['running', 'approval', 'input', 'idle', 'running', 'idle'];
  const names = ['인증 라우팅 구현', '변경사항 승인', '설계 질문 확인', '결과 검수', '터미널 출력 점검', '회귀 검사'];
  const sessions = [];
  for (let index = 0; index < 30; index++) {
    const session = await service.create({ cwd: root, title: `${names[index % 6]} ${Math.floor(index / 6) + 1}`, accountId: accounts.list()[index % 3].id });
    sessions.push(session);
    adapters.get(session.id).onState({ status: statuses[index % 6], ...(index % 6 === 3 ? { turnOutcome: 'completed' } : {}) });
    adapters.get(session.id).onOutput(`\x1b[1;36mCodex Workspace · UI fixture\x1b[0m\r\n\r\n${session.title}\r\n\x1b[90mSynthetic terminal — no live model requests\x1b[0m\r\n\r\n${index % 6 === 1 ? '◆ Waiting for your approval' : index % 6 === 2 ? '? Please review the proposed design' : index % 6 === 3 ? '✓ Changes ready for review' : '● Inspecting project files…'}\r\n\r\n› `);
  }
  const panel = (index, id) => ({ id, sessionId: sessions[index].id });
  service.workspace = { activeTabId: 'focus', tabs: [
    { id: 'focus', title: '집중 작업', columns: 2, panels: [panel(0, 'p0'), panel(1, 'p1'), panel(2, 'p2'), panel(3, 'p3')] },
    { id: 'mirror', title: '검수 모음', columns: 2, panels: [panel(0, 'mirror0'), panel(0, 'mirror1')] },
    { id: 'background', title: '백그라운드', columns: 2, panels: [panel(7, 'hidden-approval'), panel(8, 'hidden-input')] },
  ] };
  await service.save();
  await fs.writeFile(paths.token, token);
  ipc = serveIpc({ pipe: paths.pipe, token, dispatch: (...args) => service.dispatch(...args), onDisconnect: id => service.disconnect(id) });
  await ipc.listen();
  const env = { ...process.env, CODEX_WORKSPACE_DATA_DIR: dataDir }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [root], env, timeout: 30000 });
  const page = await app.firstWindow(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await expect(page.locator('#connection')).toContainText('연결됨');
  await expect(page.locator('#session-count')).toHaveText('30');
  await expect(page.getByRole('tab', { name: '백그라운드  · 2' })).toBeVisible();
  await expect(page.locator('.terminal-grid:visible .terminal-panel')).toHaveCount(4);
  await expect(page.locator('[data-panel-id="p0"] .xterm-rows')).toContainText('UI fixture');
  await expect(page.getByText('적용 계정 · 개인 계정 1', { exact: true }).first()).toBeVisible();
  await expect(page.locator('#error')).toBeHidden();
  await fs.mkdir(path.join(root, 'artifacts'), { recursive: true });
  await page.screenshot({ path: path.join(root, 'artifacts/workspace-30-sessions.png') });

  // Reading a completed turn clears unread, but only explicit review clears reviewNeeded.
  const reviewPanel = page.locator('[data-panel-id="p3"]');
  await reviewPanel.locator('.xterm-helper-textarea').focus();
  await expect.poll(() => service.sessions.get(sessions[3].id).unread).toBe(false);
  assert.equal(service.sessions.get(sessions[3].id).reviewNeeded, true);
  await reviewPanel.getByRole('button', { name: '검수 완료' }).click();
  await expect.poll(() => service.sessions.get(sessions[3].id).reviewNeeded).toBe(false);

  // Closing a view preserves the live session; an independent tab can show two mirrors.
  await page.locator('[data-panel-id="p0"]').getByTitle('패널 닫기 · 세션은 유지', { exact: true }).click();
  await expect.poll(() => service.workspace.tabs[0].panels.length).toBe(3);
  assert(service.sessions.has(sessions[0].id));
  assert.equal(adapters.get(sessions[0].id).stopped, undefined);
  await page.getByRole('tab', { name: '검수 모음', exact: true }).click();
  const first = page.locator('[data-panel-id="mirror0"]'), second = page.locator('[data-panel-id="mirror1"]');
  await first.locator('.xterm-helper-textarea').focus();
  await expect.poll(() => service.owners.get(sessions[0].id)?.viewId.endsWith(':mirror0')).toBe(true);
  await page.keyboard.type('first');
  await expect.poll(() => adapters.get(sessions[0].id).inputs.join('')).toBe('first');
  await second.locator('.xterm-helper-textarea').focus();
  await expect.poll(() => service.owners.get(sessions[0].id)?.viewId.endsWith(':mirror1')).toBe(true);
  await page.keyboard.type('second');
  await expect.poll(() => adapters.get(sessions[0].id).inputs.join('')).toBe('firstsecond');
  await expect(first).toHaveClass(/is-mirror/);
  await expect(second).not.toHaveClass(/is-mirror/);
  const screenSize = locator => locator.locator('.xterm-screen').evaluate(node => ({ width: node.style.width, height: node.style.height }));
  await expect.poll(async () => JSON.stringify(await screenSize(first))).toBe(JSON.stringify(await screenSize(second)));
  assert.equal(service.adapters.size, 30, 'Mirrors must not create a second process');

  // Keyboard resizing exercises the same persisted layout path as pointer resizing.
  const separator = page.getByRole('separator', { name: '1열 너비 조절' });
  await separator.focus(); await page.keyboard.press('ArrowRight');
  await expect.poll(() => service.workspace.tabs[1].widths?.[0]).toBe(1.1);
  const savedWidths = [...service.workspace.tabs[1].widths];
  await page.reload();
  await expect(page.getByRole('tab', { name: '검수 모음', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.terminal-grid:visible .terminal-panel')).toHaveCount(2);
  await expect(page.locator('[data-panel-id="mirror0"] .xterm-rows')).toContainText('firstsecond');
  assert.deepEqual(service.workspace.tabs[1].widths, savedWidths);
  await expect(page.locator('#error')).toBeHidden();
  assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(root, 'artifacts/workspace-mirrors.png') });
  console.log('PASS: 30 sessions, hidden attention, read/review separation, view-close survival, mirror input ownership, width persistence and reload. Synthetic adapters; production Electron/preload/IPC/service/xterm.');
} finally {
  if (app) await app.close();
  if (ipc) await ipc.close();
  for (const id of [...service.sessions.keys()]) await service.remove(id);
  await service.persistence;
  if (path.dirname(dataDir) === path.resolve(os.tmpdir()) && path.basename(dataDir).startsWith('cw-workspace-e2e-')) await fs.rm(dataDir, { recursive: true, force: true });
}
