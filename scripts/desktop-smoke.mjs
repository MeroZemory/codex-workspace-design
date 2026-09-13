import { chromium } from '@playwright/test';
import electronPath from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runtimePaths } from '../src/runtime/paths.mjs';
import { connectIpc } from '../src/runtime/ipc.mjs';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cw-desktop-'));
const env = { ...process.env, CODEX_WORKSPACE_DATA_DIR: dataDir }; delete env.ELECTRON_RUN_AS_NODE;
let app, client;
const closedApplications = [];
async function launch() {
  const executable = process.env.CODEX_WORKSPACE_TEST_EXECUTABLE || electronPath;
  const args = process.env.CODEX_WORKSPACE_TEST_EXECUTABLE ? [] : [root];
  const child = spawn(executable, [...args, '--remote-debugging-port=0'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const endpoint = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Electron debugging endpoint did not start')), 30000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Electron exited during startup: ${code}`)); });
    child.stderr.on('data', chunk => {
      output = (output + chunk.toString()).slice(-65536);
      const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
  // Chromium CDP controls the renderer without attaching a Node debugger to
  // Electron's main process, so ordinary user window shutdown is unmodified.
  const application = await chromium.connectOverCDP(endpoint);
  const context = application.contexts()[0];
  const page = context.pages()[0] || await context.waitForEvent('page');
  return { application, mainPid: child.pid, page };
}
async function closeWindow(application) {
  const start = Date.now();
  if (application.page.isClosed()) return;
  const closed = application.page.waitForEvent('close', { timeout: 10000 });
  try { await application.page.evaluate(() => window.close()); }
  catch (error) { if (!/Target .*closed/.test(error.message)) throw error; }
  await closed;
  closedApplications.push(application);
  console.log(`Window closed in ${Date.now() - start} ms; verifying immediate reopen before process cleanup.`);
}
async function waitForExit(application) {
  const start = Date.now();
  while (true) {
    try { process.kill(application.mainPid, 0); }
    catch (error) { if (error.code === 'ESRCH') break; throw error; }
    if (Date.now() - start > 30000) throw new Error(`UI process ${application.mainPid} failed to finish cleanup`);
    await delay(100);
  }
  console.log(`UI process ${application.mainPid} cleanup observed after ${Date.now() - start} ms.`);
}
try {
  app = await launch();
  const page = app.page;
  page.setDefaultTimeout(15000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => document.querySelector('#connection')?.textContent.includes('연결됨'), { timeout: 30000 });
  await fs.mkdir(path.join(root, 'artifacts'), { recursive: true });
  await page.screenshot({ path: path.join(root, 'artifacts', 'desktop-empty.png') });
  await page.locator('#accounts-button').click();
  await page.locator('#accounts-drawer').waitFor({ state: 'visible' });
  await page.locator('#close-accounts').click();
  await page.locator('#new-tab').click();
  await page.locator('#rename-tab').click();
  await page.locator('#form-dialog').waitFor({ state: 'visible' });
  const fields = page.locator('#dialog-fields input');
  await fields.first().fill('검수 작업'); await page.locator('#dialog-submit').click();
  await page.waitForFunction(() => document.querySelector('#tabs')?.textContent.includes('검수 작업'));
  const first = await page.evaluate(() => window.workspace.invoke('snapshot'));
  if (first.workspace.tabs.length !== 2) throw new Error('Work tab was not persisted');
  console.log('Desktop interactions passed; closing window.');
  await closeWindow(app); app = null;
  const paths = runtimePaths(dataDir);
  client = await connectIpc(paths.pipe, await fs.readFile(paths.token, 'utf8'));
  const alive = await client.invoke('snapshot');
  if (alive.workspace.tabs.length !== 2) throw new Error('Runtime did not survive UI close');
  app = await launch();
  const reopened = app.page;
  await reopened.waitForFunction(() => document.querySelector('#tabs')?.textContent.includes('검수 작업'));
  if (errors.length) throw new Error(errors.join('\n'));

} catch (error) { console.error(error); throw error; } finally {
  if (app) await closeWindow(app);
  for (const closed of closedApplications) await waitForExit(closed);
  if (!client) { try { const p = runtimePaths(dataDir); client = await connectIpc(p.pipe, await fs.readFile(p.token, 'utf8')); } catch {} }
  if (client) { try { await client.invoke('runtime.shutdown'); } finally { client.close(); } }
  await new Promise(resolve => setTimeout(resolve, 500));
  // Only the test-created, resolved temporary directory is removed.
  if (path.dirname(dataDir) === path.resolve(os.tmpdir()) && path.basename(dataDir).startsWith('cw-desktop-')) await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
console.log('PASS: Electron preload, persisted tabs, detached runtime survives close, reopen reconnects.');
process.exit(0);
