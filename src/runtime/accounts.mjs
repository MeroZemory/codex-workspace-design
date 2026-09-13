import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, open, rename, stat, readdir, realpath } from 'node:fs/promises';
import { join, isAbsolute, resolve, sep } from 'node:path';

const AUTH_CLAIM = 'https://api.openai.com/auth';
const hash = value => createHash('sha256').update(value).digest('hex');
const claims = token => { try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url')); } catch { return {}; } };

// DPAPI secrets travel only over stdin/stdout pipes, never command arguments.
export function dpapi(operation, input) {
  if (process.platform !== 'win32') throw new Error('Secure account storage currently requires Windows.');
  return new Promise((resolve, reject) => {
    const script = `$ErrorActionPreference='Stop'; try { Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $r=[Security.Cryptography.ProtectedData]::${operation === 'encrypt' ? 'Protect' : 'Unprotect'}($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($r)) } catch { exit 1 }`;
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; let settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => { child.kill(); finish(new Error('Secure account storage timed out.')); }, 15000);
    child.stdout.on('data', data => { output += data; if (output.length > 24 * 1024 * 1024) { child.kill(); finish(new Error('Secure account storage exceeded size limit.')); } });
    child.stderr.resume();
    child.on('error', () => finish(new Error('Secure account storage could not start.')));
    child.stdin.on('error', () => finish(new Error('Secure account storage failed.')));
    child.on('close', code => {
      const encoded = output.trim();
      if (code !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return finish(new Error('Secure account storage failed.'));
      const decoded = Buffer.from(encoded, 'base64');
      finish(decoded.length ? null : new Error('Secure account storage failed.'), decoded);
    });
    child.stdin.end(Buffer.from(input).toString('base64'));
  });
}

export function parseCredentials(document) {
  const rows = Array.isArray(document) ? document : document?.tokens || document?.accessToken ? [document] : Array.isArray(document?.accounts) ? document.accounts : Object.values(document ?? {});
  const result = [];
  for (const entry of rows) {
    if (!entry || entry.deletedAt != null) continue;
    const value = entry.credential ?? entry.tokens ?? entry;
    const accessToken = value.accessToken ?? value.access_token;
    const refreshToken = value.refreshToken ?? value.refresh_token;
    if (typeof accessToken !== 'string' || !accessToken || typeof refreshToken !== 'string' || !refreshToken) continue;
    const payload = claims(accessToken); const auth = payload[AUTH_CLAIM] ?? {};
    const accountId = value.chatgptAccountId ?? value.account_id ?? auth.chatgpt_account_id;
    if (typeof accountId !== 'string' || !accountId || (auth.chatgpt_account_id && auth.chatgpt_account_id !== accountId)) continue;
    const idClaims = claims(value.id_token ?? '');
    result.push({ id: hash(`${accountId}:${payload.sub ?? idClaims.sub ?? ''}`).slice(0, 24), accountId, accessToken, refreshToken,
      subject: payload.sub ?? idClaims.sub ?? '', expiresAt: Number.isFinite(value.expiresAt) ? value.expiresAt : Number.isFinite(payload.exp) ? payload.exp * 1000 : 0,
      email: String(payload.email ?? idClaims.email ?? ''), plan: String(auth.chatgpt_plan_type ?? value.chatgptPlanType ?? 'unknown'),
      label: String(entry.label ?? entry.name ?? payload.email ?? idClaims.email ?? accountId).slice(0, 120), status: 'ready', history: [] });
  }
  return result;
}

export async function discoverOrcaAuthFiles({ appData = process.env.CODEX_WORKSPACE_ORCA_APPDATA || process.env.APPDATA } = {}) {
  if (typeof appData !== 'string' || !isAbsolute(appData) || (process.platform === 'win32' && appData.startsWith('\\\\'))) return [];
  const root = resolve(appData, 'orca', 'codex-accounts');
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  if (entries.length > 1024) throw new Error('Too many Orca account folders.');
  const realAppData = await realpath(appData); const realRoot = await realpath(root); const files = [];
  if (!realRoot.startsWith(realAppData + sep)) return [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const file = await realpath(join(root, entry.name, 'home', 'auth.json'));
      if (!file.startsWith(realRoot + sep) || !(await stat(file)).isFile()) continue;
      files.push(file);
    } catch { /* Missing or inaccessible account homes are not importable. */ }
  }
  return files.sort();
}

export function normalizeUsage(response, now = Date.now()) {
  const limits = response.rateLimitsByLimitId ? Object.entries(response.rateLimitsByLimitId) : [['codex', response.rateLimits ?? response]];
  const windows = [];
  for (const [limitId, limit] of limits) {
    for (const kind of ['primary', 'secondary']) {
      const w = limit?.[kind];
      if (!w || !Number.isFinite(w.usedPercent) || !Number.isFinite(w.resetsAt)) continue;
      windows.push({ limitId, kind, usedPercent: Math.max(0, Math.min(100, w.usedPercent)), remainingPercent: Math.max(0, 100 - w.usedPercent), resetAt: w.resetsAt * 1000, windowMinutes: w.windowDurationMins ?? null });
    }
  }
  return { observedAt: now, ordinaryUsageAllowed: response.ordinaryUsageAllowed, windows };
}

// Mirrors backend-client/src/client/rate_limit_resets.rs; passive reads do not opt into Reserve.
export function parseUsageResponse(payload) {
  if (!payload || typeof payload !== 'object' || (!('rate_limit' in payload) && !('plan_type' in payload))) throw new Error('Unsupported usage response.');
  const window = w => w ? { usedPercent: w.used_percent, resetsAt: w.reset_at, windowDurationMins: Number.isFinite(w.limit_window_seconds) ? Math.floor(w.limit_window_seconds / 60) : null } : null;
  const limit = value => ({ primary: window(value?.primary_window), secondary: window(value?.secondary_window) });
  const rateLimitsByLimitId = { codex: limit(payload.rate_limit) };
  for (const extra of payload.additional_rate_limits ?? []) {
    if (typeof extra.metered_feature === 'string' && !['__proto__', 'constructor', 'prototype'].includes(extra.metered_feature)) rateLimitsByLimitId[extra.metered_feature] = limit(extra.rate_limit);
  }
  return { accountId: payload.account_id, ordinaryUsageAllowed: typeof payload.rate_limit?.allowed === 'boolean' ? payload.rate_limit.allowed : undefined, rateLimitsByLimitId };
}

export function forecast(history, now = Date.now()) {
  const latest = history.at(-1);
  if (!latest) return { confidence: 'unknown', windows: [] };
  const windows = latest.windows.map(w => {
    const older = history.find(h => h.observedAt < latest.observedAt && h.windows.some(p => p.limitId === w.limitId && p.kind === w.kind && p.resetAt === w.resetAt && p.usedPercent <= w.usedPercent));
    const previous = older?.windows.find(p => p.limitId === w.limitId && p.kind === w.kind && p.resetAt === w.resetAt);
    const elapsed = older ? latest.observedAt - older.observedAt : 0;
    const rate = elapsed >= 60000 && latest.observedAt - older.observedAt <= 2 * 3600000 ? (w.usedPercent - previous.usedPercent) / elapsed : null;
    const remainingAtReset = rate == null || w.resetAt <= now ? null : Math.max(0, w.remainingPercent - rate * Math.max(0, w.resetAt - latest.observedAt));
    // Allow enough time to consume the remaining quota, with 15 minutes for the user to respond.
    const suggestedBefore = remainingAtReset > 5 ? (rate > 0 ? Math.max(now, w.resetAt - w.remainingPercent / rate - 15 * 60000) : now) : null;
    return { ...w, remainingAtReset, suggestedBefore };
  });
  return { confidence: !windows.some(w => w.remainingAtReset !== null) ? 'unknown' : now - latest.observedAt > 10 * 60000 ? 'stale' : 'estimate', windows };
}

export class AccountManager {
  constructor({ dataDir, onChange = () => {}, fetch: fetcher = globalThis.fetch, crypto = dpapi, now = Date.now }) {
    this.path = join(dataDir, 'accounts.dpapi'); this.dataDir = dataDir; this.onChange = onChange; this.fetcher = fetcher; this.crypto = crypto; this.now = now;
    this.accounts = []; this.queue = Promise.resolve(); this.flights = new Map(); this.usageFlights = new Map(); this.discoveryFlight = null;
    this.orcaDiscovery = { status: 'pending', found: 0, recognized: 0, imported: 0, duplicates: 0, invalid: 0 };
  }
  async init() {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    try {
      const saved = JSON.parse((await this.crypto('decrypt', await readFile(this.path))).toString('utf8'));
      if (saved.version !== 1 || !Array.isArray(saved.accounts)) throw new Error('Unsupported account vault.');
      this.accounts = saved.accounts;
      for (const account of this.accounts) if (account.refreshInFlight) { account.status = 'reauth_required'; account.error = 'Previous credential refresh had an unknown outcome. Import a fresh login.'; }
    } catch (error) { if (error.code !== 'ENOENT') throw new Error('Account vault could not be opened.'); }
  }
  mutate(action) { const result = this.queue.then(action); this.queue = result.catch(() => {}); return result; }
  async save() {
    const encrypted = await this.crypto('encrypt', Buffer.from(JSON.stringify({ version: 1, accounts: this.accounts })));
    const temp = `${this.path}.${randomUUID()}.tmp`; const file = await open(temp, 'wx', 0o600);
    try { await file.writeFile(encrypted); await file.sync(); } finally { await file.close(); }
    await rename(temp, this.path); this.onChange();
  }
  list() { return this.accounts.map(a => ({ id: a.id, label: a.label, email: a.email, plan: a.plan, source: a.source, status: a.status, error: a.error, usage: a.history.at(-1) ?? null, forecast: forecast(a.history, this.now()) })); }
  account(id) { const a = this.accounts.find(a => a.id === id); if (!a) throw new Error('Account not found.'); return a; }
  async importFile(path) {
    const read = async file => { if ((await stat(file)).size > 8 * 1024 * 1024) throw new Error('Account file exceeds size limit.'); try { return JSON.parse(await readFile(file, 'utf8')); } catch { throw new Error('Account JSON could not be read.'); } };
    let raw = await read(path);
    if (Array.isArray(raw?.settings?.codexManagedAccounts)) {
      if (raw.settings.codexManagedAccounts.length > 1024) throw new Error('Too many accounts.');
      const credentials = [];
      for (const entry of raw.settings.codexManagedAccounts) {
        if (entry.managedHomeRuntime && entry.managedHomeRuntime !== 'host') continue;
        if (typeof entry.managedHomePath !== 'string' || !isAbsolute(entry.managedHomePath) || entry.managedHomePath.startsWith('\\\\')) throw new Error('Unsupported Orca account location.');
        credentials.push(await read(join(entry.managedHomePath, 'auth.json')));
      }
      raw = credentials;
    }
    const candidates = parseCredentials(raw);
    if (!candidates.length) throw new Error('No independent ChatGPT credentials found. Select auth.json with a refresh token, or an Orca account registry. Source-linked OpenCodex entries alone cannot be migrated independently.');
    if (candidates.length > 1024) throw new Error('Too many accounts.');
    return this.importCandidates(candidates, { repairQuarantined: true });
  }
  importOrca(options = {}) {
    if (this.discoveryFlight) return this.discoveryFlight;
    const pending = this.scanOrca(options);
    this.discoveryFlight = pending; pending.finally(() => { if (this.discoveryFlight === pending) this.discoveryFlight = null; }).catch(() => {});
    return pending;
  }
  async scanOrca(options = {}) {
    const files = await discoverOrcaAuthFiles(options);
    const candidates = []; let invalid = 0; let totalBytes = 0;
    for (const file of files) {
      try {
        const size = (await stat(file)).size; totalBytes += size;
        if (size > 8 * 1024 * 1024 || totalBytes > 64 * 1024 * 1024) { invalid++; continue; }
        const parsed = parseCredentials(JSON.parse(await readFile(file, 'utf8')));
        if (!parsed.length || candidates.length + parsed.length > 1024) { invalid++; continue; }
        candidates.push(...parsed.map(candidate => ({ ...candidate, source: 'orca' })));
      } catch { invalid++; }
    }
    const result = candidates.length ? await this.importCandidates(candidates, { repairQuarantined: false }) : { imported: 0, duplicates: 0 };
    this.orcaDiscovery = { status: 'complete', searchedAt: this.now(), found: files.length, recognized: candidates.length, invalid, ...result };
    this.onChange();
    return this.orcaDiscovery;
  }
  importCandidates(candidates, { repairQuarantined = false } = {}) {
    return this.mutate(async () => {
      const previous = structuredClone(this.accounts);
      let imported = 0; let duplicates = 0;
      for (const candidate of candidates) {
        const existing = this.accounts.find(a => a.id === candidate.id || a.refreshToken === candidate.refreshToken);
        if (existing) {
          if (repairQuarantined && existing.status === 'reauth_required' && existing.refreshToken !== candidate.refreshToken) {
            Object.assign(existing, candidate, { history: existing.history, refreshInFlight: false }); delete existing.error; imported++;
          } else duplicates++;
          continue;
        }
        this.accounts.push(candidate); imported++;
      }
      try { await this.save(); } catch (error) { this.accounts = previous; throw error; }
      return { imported, duplicates };
    });
  }
  auth(a) { return { accessToken: a.accessToken, chatgptAccountId: a.accountId, chatgptPlanType: a.plan }; }
  async getAuth(id) { if (this.flights.has(id)) return this.flights.get(id); const a = this.account(id); if (a.refreshInFlight || a.status === 'reauth_required') throw new Error('Account requires a fresh login.'); return a.expiresAt <= this.now() + 60000 ? this.refresh(id) : this.auth(a); }
  refresh(id) {
    if (this.flights.has(id)) return this.flights.get(id);
    const pending = this.mutate(async () => {
      const a = this.account(id);
      if (a.refreshInFlight || a.status === 'reauth_required') throw new Error('Account requires a fresh login.');
      a.refreshInFlight = true; await this.save();
      try {
        const response = await this.fetcher('https://auth.openai.com/oauth/token', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ grant_type: 'refresh_token', client_id: 'app_EMoamEEZ73f0CkXaXp7hrann', refresh_token: a.refreshToken }) });
        if (!response.ok) throw new Error('Credential renewal was rejected.');
        const result = await response.json();
        if (typeof result.access_token !== 'string' || !result.access_token || (result.refresh_token != null && (typeof result.refresh_token !== 'string' || !result.refresh_token))) throw new Error('Invalid credential response.');
        const payload = claims(result.access_token); const identity = payload[AUTH_CLAIM]?.chatgpt_account_id;
        if (identity && identity !== a.accountId) throw new Error('Credential identity changed.');
        a.accessToken = result.access_token; a.refreshToken = result.refresh_token ?? a.refreshToken;
        a.expiresAt = Number.isFinite(payload.exp) ? payload.exp * 1000 : this.now() + (Number.isFinite(result.expires_in) ? result.expires_in : 3600) * 1000;
        a.refreshInFlight = false; a.status = 'ready'; delete a.error; await this.save(); return this.auth(a);
      } catch {
        a.refreshInFlight = true; a.status = 'reauth_required'; a.error = 'Credential refresh failed or had an unknown outcome. Import a fresh login.';
        await this.save().catch(() => {}); throw new Error(a.error);
      }
    });
    this.flights.set(id, pending); pending.finally(() => this.flights.delete(id)).catch(() => {}); return pending;
  }
  refreshUsage(id) {
    if (this.usageFlights.has(id)) return this.usageFlights.get(id);
    const pending = (async () => {
      let auth = await this.getAuth(id);
      for (let attempt = 0; attempt < 2; attempt++) {
        let response;
        try {
          response = await this.fetcher('https://chatgpt.com/backend-api/wham/usage', { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15000), headers: { Authorization: `Bearer ${auth.accessToken}`, 'ChatGPT-Account-Id': auth.chatgptAccountId, Accept: 'application/json' } });
        } catch { throw new Error('Account usage could not be refreshed.'); }
        if (response.status === 401 && attempt === 0) { auth = await this.refresh(id); continue; }
        if (!response.ok) throw new Error('Account usage query was rejected.');
        let payload; try { payload = await response.json(); } catch { throw new Error('Account usage response could not be read.'); }
        await this.updateUsage(id, parseUsageResponse(payload));
        return this.list().find(a => a.id === id);
      }
    })();
    this.usageFlights.set(id, pending); pending.finally(() => this.usageFlights.delete(id)).catch(() => {}); return pending;
  }
  updateUsage(id, response) { return this.mutate(async () => { const a = this.account(id); if (response.accountId && response.accountId !== a.accountId) throw new Error('Usage response belongs to a different account.'); a.history.push(normalizeUsage(response, this.now())); a.history = a.history.slice(-120); await this.save(); }); }
  setStatus(id, status, error) { return this.mutate(async () => { const a = this.account(id); a.status = status; a.error = error ? 'Account is temporarily unavailable.' : undefined; await this.save(); }); }
  choose({ exclude = [], currentId, pinnedId } = {}) {
    const eligible = a => !exclude.includes(a.id) && a.status === 'ready' && !a.refreshInFlight && a.history.at(-1)?.ordinaryUsageAllowed !== false && (a.history.at(-1)?.ordinaryUsageAllowed === true || !a.history.at(-1)?.windows.some(w => w.limitId === 'codex' && w.remainingPercent <= 0 && w.resetAt > this.now()));
    if (pinnedId) return this.accounts.some(a => a.id === pinnedId && eligible(a)) ? pinnedId : null;
    if (currentId && this.accounts.some(a => a.id === currentId && eligible(a))) return currentId;
    const nextReset = a => Math.min(...(a.history.at(-1)?.windows ?? []).filter(w => w.resetAt > this.now() && w.remainingPercent > 0).map(w => w.resetAt));
    return this.accounts.filter(eligible).sort((a, b) => nextReset(a) - nextReset(b))[0]?.id ?? null;
  }
  async close() { await Promise.allSettled([this.discoveryFlight, ...this.usageFlights.values()].filter(Boolean)); await this.queue; }
}
