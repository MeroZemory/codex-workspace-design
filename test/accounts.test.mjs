import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountManager, parseCredentials, forecast, normalizeUsage, dpapi } from '../src/runtime/accounts.mjs';

const jwt = (id = 'a', exp = 2000000000) => `header.${Buffer.from(JSON.stringify({ sub: 'person', exp, email: 'test@example.invalid', 'https://api.openai.com/auth': { chatgpt_account_id: id, chatgpt_plan_type: 'pro' } })).toString('base64url')}.signature`;
const credential = (id = 'a') => ({ tokens: { access_token: jwt(id), refresh_token: `synthetic-refresh-${id}`, account_id: id } });
const plainCrypto = async (_, buffer) => buffer;
async function setup(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'workspace-accounts-test-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const manager = new AccountManager({ dataDir, crypto: plainCrypto, ...options }); await manager.init();
  const path = join(dataDir, 'fixture.json'); await writeFile(path, JSON.stringify(credential())); await manager.importFile(path);
  return { manager, dataDir, path };
}

test('imports native auth and both OpenCodex store formats without source dependencies', async t => {
  const { manager, path } = await setup(t);
  await writeFile(path, JSON.stringify({ legacy: { accessToken: jwt('b'), refreshToken: 'refresh-b', chatgptAccountId: 'b', expiresAt: 2e12 }, wrapped: { generation: 2, credential: { accessToken: jwt('c'), refreshToken: 'refresh-c', chatgptAccountId: 'c' } } }));
  assert.deepEqual(await manager.importFile(path), { imported: 2, duplicates: 0 });
  assert.deepEqual(await manager.importFile(path), { imported: 0, duplicates: 2 });
  assert.equal(manager.list().length, 3);
  assert.ok(!JSON.stringify(manager.list()).includes('refresh-c'));
  assert.equal(parseCredentials({ tokens: { ...credential().tokens, account_id: 'wrong' } }).length, 0);
  await writeFile(path, JSON.stringify({ one: { accessToken: jwt(), refreshToken: '', chatgptAccountId: 'a', sourceAuthPath: 'never-read' } }));
  await assert.rejects(manager.importFile(path), /No independent/);
});

test('concurrent refreshes share one rotation and persist new grant before returning', async t => {
  let requests = 0;
  const { manager, dataDir } = await setup(t, { fetch: async (_, init) => { requests++; assert.ok(JSON.parse(init.body).refresh_token.startsWith('synthetic')); await new Promise(r => setTimeout(r, 20)); return { ok: true, json: async () => ({ access_token: jwt(), refresh_token: 'rotated', expires_in: 3600 }) }; } });
  const id = manager.list()[0].id;
  const auths = await Promise.all(Array.from({ length: 8 }, () => manager.refresh(id)));
  assert.equal(requests, 1); assert.equal(auths.length, 8);
  const saved = JSON.parse(await readFile(join(dataDir, 'accounts.dpapi'), 'utf8'));
  assert.equal(saved.accounts[0].refreshToken, 'rotated'); assert.equal(saved.accounts[0].refreshInFlight, false);
});

test('unknown refresh result survives restart and refuses repeat grant; new independent import repairs it', async t => {
  let requests = 0;
  const { manager, dataDir, path } = await setup(t, { fetch: async () => { requests++; throw new Error('secret-server-response'); } });
  const id = manager.list()[0].id;
  await assert.rejects(manager.refresh(id), /unknown outcome/);
  const second = new AccountManager({ dataDir, crypto: plainCrypto, fetch: async () => { requests++; } }); await second.init();
  await assert.rejects(second.getAuth(id), /fresh login/); assert.equal(requests, 1);
  assert.ok(!JSON.stringify(second.list()).includes('secret-server-response'));
  await writeFile(path, JSON.stringify({ tokens: { ...credential().tokens, refresh_token: 'fresh-login' } }));
  assert.equal((await second.importFile(path)).imported, 1);
  assert.equal((await second.getAuth(id)).chatgptAccountId, 'a');
});

test('reset rollover breaks trend and healthy current or pinned account takes precedence', async t => {
  let now = 1000000;
  const { manager, path } = await setup(t, { now: () => now });
  await writeFile(path, JSON.stringify(credential('b'))); await manager.importFile(path);
  const [a, b] = manager.list().map(a => a.id);
  const usage = (used, reset) => ({ rateLimits: { primary: { usedPercent: used, resetsAt: reset / 1000, windowDurationMins: 300 } } });
  await manager.updateUsage(a, usage(20, 3000000)); now += 60000; await manager.updateUsage(a, usage(30, 3000000));
  assert.notEqual(manager.list()[0].forecast.windows[0].remainingAtReset, null);
  now += 60000; await manager.updateUsage(a, usage(2, 6000000));
  assert.equal(manager.list()[0].forecast.windows[0].remainingAtReset, null);
  await manager.updateUsage(b, usage(40, 2000000));
  assert.equal(manager.choose(), b); assert.equal(manager.choose({ currentId: a }), a);
  await manager.updateUsage(a, usage(100, 6000000));
  assert.equal(manager.choose({ pinnedId: a }), null); assert.equal(manager.choose(), b);
  assert.deepEqual(forecast([]), { confidence: 'unknown', windows: [] });
  assert.equal(normalizeUsage({ rateLimits: {} }).windows.length, 0);
});

test('Windows DPAPI round-trip protects synthetic secret at rest', { skip: process.platform !== 'win32' }, async () => {
  const secret = Buffer.from('synthetic-secret-only'); const encrypted = await dpapi('encrypt', secret);
  assert.ok(!encrypted.includes(secret)); assert.deepEqual(await dpapi('decrypt', encrypted), secret);
});

test('pacing warns before consumption time plus response buffer exceeds the reset deadline', () => {
  const hour = 3600000, now = 20 * hour, resetAt = now + 10 * hour;
  const snapshot = (observedAt, usedPercent) => ({ observedAt, windows: [{ limitId: 'codex', kind: 'primary', usedPercent, remainingPercent: 100 - usedPercent, resetAt }] });
  const current = snapshot(now, 30);
  const history = [snapshot(now - hour, 25), current];
  const result = forecast(history, now);
  assert.equal(result.windows[0].remainingAtReset, 20);
  assert.equal(result.windows[0].suggestedBefore, now, '14 hours of consumption cannot fit in 10 hours; suggest now instead of near reset');
  assert.ok(result.windows[0].suggestedBefore <= Math.max(now, resetAt - 14 * hour - 15 * 60000));
  const stopped = forecast([snapshot(now - hour, 30), current], now);
  assert.equal(stopped.windows[0].suggestedBefore, now, 'zero observed consumption needs a nonblocking pacing check now');
  const unknown = forecast([current], now);
  assert.equal(unknown.confidence, 'unknown');
  assert.equal(unknown.windows[0].suggestedBefore, null);
});

test('usage query works without sessions, retries one 401 and preserves independent window units', async t => {
  let queries = 0; let refreshes = 0;
  const { manager } = await setup(t, { fetch: async (url, init) => {
    if (url.endsWith('/oauth/token')) { refreshes++; return { ok: true, json: async () => ({ access_token: jwt(), refresh_token: 'usage-rotated' }) }; }
    queries++; assert.equal(url, 'https://chatgpt.com/backend-api/wham/usage'); assert.equal(init.headers['ChatGPT-Account-Id'], 'a');
    assert.equal(init.headers.Authorization, `Bearer ${jwt()}`);
    if (queries === 1) return { ok: false, status: 401 };
    return { ok: true, json: async () => ({ account_id: 'a', plan_type: 'pro', rate_limit: { allowed: true, primary_window: { used_percent: 100, reset_at: 2000000000, limit_window_seconds: 18000 }, secondary_window: { used_percent: 40, reset_at: 2000500000, limit_window_seconds: 604800 } }, additional_rate_limits: [{ metered_feature: 'special-model', rate_limit: { primary_window: { used_percent: 100, reset_at: 2000000000, limit_window_seconds: 3600 } } }] }) };
  } });
  const id = manager.list()[0].id;
  const [result] = await Promise.all([manager.refreshUsage(id), manager.refreshUsage(id)]);
  assert.equal(queries, 2); assert.equal(refreshes, 1);
  assert.deepEqual(result.usage.windows.map(w => w.windowMinutes), [300, 10080, 60]);
  assert.equal(result.usage.windows[0].resetAt, 2000000000000);
  assert.equal(manager.choose(), id, 'backend allowed takes precedence over displayed 100 percent');
});

test('usage rejects another account identity without overwriting last known snapshot', async t => {
  const { manager } = await setup(t, { fetch: async () => ({ ok: true, json: async () => ({ account_id: 'wrong-account', plan_type: 'pro', rate_limit: null }) }) });
  const id = manager.list()[0].id;
  await assert.rejects(manager.refreshUsage(id), /different account/);
  assert.equal(manager.list()[0].usage, null);
});

test('expired imported token renews before first status request', async t => {
  const calls = [];
  const { manager, path } = await setup(t, { fetch: async url => { calls.push(url); return { ok: true, json: async () => url.endsWith('/oauth/token') ? { access_token: jwt('b'), refresh_token: 'renewed' } : { account_id: 'b', plan_type: 'pro', rate_limit: null } }; } });
  await writeFile(path, JSON.stringify({ tokens: { ...credential('b').tokens, access_token: jwt('b', 100) } }));
  await manager.importFile(path);
  await manager.refreshUsage(manager.list()[1].id);
  assert.deepEqual(calls, ['https://auth.openai.com/oauth/token', 'https://chatgpt.com/backend-api/wham/usage']);
});
