import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicJson, readJson } from './storage.mjs';
import { Screen } from './screen.mjs';

const LIVE = new Set(['starting', 'running', 'approval', 'input', 'recovering']);
const text = (value, max = 240) => typeof value === 'string' && value.length <= max && !value.includes('\0');
export class WorkspaceService {
  constructor({ paths, accounts, Session, codexPath, broadcast = () => {} }) {
    Object.assign(this, { paths, accounts, Session, codexPath, broadcast });
    this.sessions = new Map(); this.adapters = new Map(); this.screens = new Map(); this.owners = new Map(); this.operations = new Map();
    this.workspace = { tabs: [{ id: randomUUID(), title: '작업 공간', panels: [], columns: 2 }], activeTabId: null };
    this.workspace.activeTabId = this.workspace.tabs[0].id;
    this.persistence = Promise.resolve(); this.closing = false; this.pendingCreates = 0; this.pendingStops = 0; this.reservations = new Set();
  }
  async init() {
    const saved = await readJson(this.paths.state, null);
    if (saved) {
      if (saved.version !== 1 || !Array.isArray(saved.sessions)) throw new Error('지원하지 않는 작업 공간 형식입니다. 원본 파일을 보존했습니다.');
      this.workspace = saved.workspace;
      for (const session of saved.sessions) this.sessions.set(session.id, { ...session, status: 'stopped', generation: (session.generation || 0) + 1, detail: '실행부가 종료됐습니다. 대화 ID로 새 세션에서 재개할 수 있습니다.' });
    }
  }
  snapshot() { return { sessions: [...this.sessions.values()].map(s => ({ ...s })), accounts: this.accounts.list(), workspace: this.workspace, runtime: { version: '0.1.1', protocol: 2, codexPath: this.codexPath, orcaDiscovery: this.accounts.orcaDiscovery } }; }
  changed() { this.broadcast({ type: 'snapshot', data: this.snapshot() }); }
  async save() {
    const value = { version: 1, sessions: [...this.sessions.values()].map(s => ({ ...s })), workspace: structuredClone(this.workspace) };
    const operation = this.persistence.then(() => atomicJson(this.paths.state, value));
    this.persistence = operation.catch(error => this.broadcast({ type: 'error', message: error.message }));
    await operation;
  }
  requireSession(id) { const session = this.sessions.get(id); if (!session) throw new Error('세션이 삭제됐거나 존재하지 않습니다.'); return session; }
  async exclusive(id, fn) {
    const previous = this.operations.get(id) || Promise.resolve();
    const operation = previous.catch(() => {}).then(fn);
    this.operations.set(id, operation);
    try { return await operation; } finally { if (this.operations.get(id) === operation) this.operations.delete(id); }
  }
  async create(params) {
    if (this.closing) throw new Error('실행부가 종료 중입니다.');
    if (params.resumeId && this.reservations.has(params.resumeId)) throw new Error('이 대화를 재개하는 중입니다.');
    if (params.resumeId) this.reservations.add(params.resumeId);
    this.pendingCreates++;
    try { return await this.createSession(params); }
    finally { this.pendingCreates--; if (params.resumeId) this.reservations.delete(params.resumeId); }
  }
  async createSession(params) {
    if (this.closing) throw new Error('실행부가 종료 중입니다.');
    if (!text(params.cwd, 32768) || !path.isAbsolute(params.cwd) || !(await fs.stat(params.cwd)).isDirectory()) throw new Error('존재하는 작업 폴더를 선택하세요.');
    if (params.title !== undefined && !text(params.title)) throw new Error('세션 이름이 너무 깁니다.');
    if (params.resumeId && !/^[0-9a-f-]{36}$/i.test(params.resumeId)) throw new Error('재개할 대화 ID 형식을 확인하세요.');
    if (params.resumeId && [...this.sessions.values()].some(s => s.threadId === params.resumeId && this.adapters.has(s.id))) throw new Error('이 대화는 이미 실행 중입니다. 세션 목록에서 패널에 추가하세요.');
    if (this.sessions.size >= 100) throw new Error('세션은 최대 100 개까지 보관할 수 있습니다.');
    if (!this.codexPath) throw new Error('Codex CLI를 찾지 못했습니다. Codex CLI 설치 후 앱을 다시 실행하세요.');
    const accountId = params.accountId || this.accounts.choose({ exclude: [] });
    if (!accountId) throw new Error('사용 가능한 계정이 없습니다. 인증정보를 가져오거나 사용량 갱신 후 다시 시도하세요.');
    await this.accounts.getAuth(accountId);
    if (this.closing) throw new Error('실행부가 종료 중입니다.');
    const id = randomUUID();
    const session = { id, title: params.title || path.basename(params.cwd), cwd: path.resolve(params.cwd), threadId: params.resumeId || null, accountId, accountState: 'applying', accountVerification: null, pinned: Boolean(params.pinned), status: 'starting', detail: '', unread: false, reviewNeeded: false, cols: 100, rows: 30, generation: 1 };
    this.sessions.set(id, session);
    const generation = session.generation;
    const screen = new Screen(output => this.broadcast({ type: 'terminal', id, ...output }), { onInput: data => {
      try { this.adapters.get(id)?.protocolInput?.(data); } catch (error) { this.broadcast({ type: 'error', message: error.message }); }
    } }); this.screens.set(id, screen);
    const adapter = new this.Session({ id, cwd: session.cwd, resumeId: params.resumeId, codexPath: this.codexPath, accounts: this.accounts, accountId,
      getPolicy: () => ({ pinned: session.pinned, generation: session.generation, autoRecovery: this.sessions.get(id)?.generation === generation && session.autoRecovery !== false }),
      onState: patch => {
        if (this.sessions.get(id)?.generation !== generation) return;
        Object.assign(session, patch);
        if (patch.status === 'running') session.autoRecovery = true;
        if (patch.turnOutcome === 'completed') { session.unread = true; session.reviewNeeded = true; }
        this.changed(); this.save().catch(() => {});
      },
      onOutput: data => {
        if (this.sessions.get(id)?.generation !== generation) return;
        try { screen.write(data); }
        catch (error) { session.status = 'error'; session.detail = error.message; this.changed(); adapter.stop().catch(() => {}); }
      }
    });
    this.adapters.set(id, adapter); this.changed(); await this.save();
    try { await adapter.start(); }
    catch (error) {
      if (this.sessions.get(id)?.generation === generation) { session.status = 'error'; session.accountState = 'failed'; session.detail = error.message; this.changed(); await this.save(); }
      await adapter.stop().catch(() => {});
      this.adapters.delete(id);
      throw error;
    }
    if (this.sessions.get(id)?.generation !== generation) { await adapter.stop(); return null; }
    this.refreshSessionUsage(id).catch(error => this.broadcast({ type: 'error', message: error.message }));
    return { ...session };
  }
  async remove(id) {
    const session = this.requireSession(id);
    this.pendingStops++;
    try {
    session.generation++; session.status = 'stopped';
    const adapter = this.adapters.get(id);
    // The tombstone takes effect before awaiting process teardown.
    this.sessions.delete(id); this.adapters.delete(id); this.owners.delete(id);
    for (const tab of this.workspace.tabs) tab.panels = tab.panels.filter(p => p.sessionId !== id);
    this.changed();
    try { await this.save(); }
    finally { try { await adapter?.stop(); } finally { await this.screens.get(id)?.dispose(); this.screens.delete(id); } }
    return true;
    } finally { this.pendingStops--; }
  }
  async switchAccount({ id, accountId, pinned }) {
    return this.exclusive(id, async () => {
      const session = this.requireSession(id), generation = session.generation;
      if (LIVE.has(session.status)) throw new Error('턴이 끝난 뒤 계정을 전환하세요. 진행 중인 작업은 유지됩니다.');
      const adapter = this.adapters.get(id); if (!adapter) throw new Error('종료된 세션입니다. 대화 ID로 재개하세요.');
      adapter.cancelRecovery?.();
      await adapter.switchAccount(accountId);
      if (this.sessions.get(id)?.generation !== generation) return false;
      session.accountId = accountId;
      if (pinned !== undefined) session.pinned = Boolean(pinned);
      session.detail = ''; this.changed(); await this.save(); return true;
    });
  }
  dimensions(params) {
    const { cols, rows } = params;
    if (!Number.isInteger(cols) || cols < 10 || cols > 500 || !Number.isInteger(rows) || rows < 3 || rows > 200) throw new Error('터미널 크기가 올바르지 않습니다.');
    return { cols, rows };
  }
  async refreshSessionUsage(id) {
    const session = this.sessions.get(id), adapter = this.adapters.get(id);
    if (!session?.accountId || !adapter) return;
    const accountId = session.accountId;
    const usage = await adapter.getUsage();
    if (this.sessions.get(id)?.accountId === accountId) await this.accounts.updateUsage(accountId, usage);
  }
  async refreshAccounts() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const errors = [];
      // Account module may implement direct status queries for inactive accounts.
      if (this.accounts.refreshUsage) {
        for (const account of this.accounts.list()) { try { await this.accounts.refreshUsage(account.id); } catch (error) { errors.push(error.message); } }
      } else {
        const seen = new Set();
        for (const session of this.sessions.values()) if (!seen.has(session.accountId) && this.adapters.has(session.id)) {
          seen.add(session.accountId); try { await this.refreshSessionUsage(session.id); } catch (error) { errors.push(error.message); }
        }
      }
      for (const adapter of this.adapters.values()) { try { await adapter.wakeRecovery?.(); } catch (error) { errors.push(error.message); } }
      this.changed(); return { errors };
    })();
    try { return await this.refreshing; } finally { this.refreshing = null; }
  }
  validateWorkspace(params) {
    if (!Array.isArray(params.tabs) || params.tabs.length < 1 || params.tabs.length > 40 || JSON.stringify(params).length > 256000) throw new Error('작업 탭은 1 ~ 40 개 범위로 저장하세요.');
    const tabs = new Set(), panels = new Set();
    for (const tab of params.tabs) {
      if (!text(tab.id) || !text(tab.title) || tabs.has(tab.id) || !Array.isArray(tab.panels) || tab.panels.length > 50) throw new Error('작업 탭 형식이 올바르지 않습니다.');
      tabs.add(tab.id);
      for (const panel of tab.panels) {
        if (!text(panel.id) || panels.has(panel.id) || !this.sessions.has(panel.sessionId)) throw new Error('패널이 중복됐거나 세션이 존재하지 않습니다.');
        panels.add(panel.id);
      }
    }
    if (!tabs.has(params.activeTabId)) throw new Error('선택한 작업 탭이 없습니다.');
    return structuredClone(params);
  }
  disconnect(clientId) { for (const [id, owner] of this.owners) if (owner.clientId === clientId) this.owners.delete(id); }
  async dispatch(method, params, { clientId = 'test' } = {}) {
    if (method === 'snapshot') return this.snapshot();
    if (method === 'session.create') return this.create(params);
    if (method === 'session.delete') return this.remove(params.id);
    if (method === 'session.switch') return this.switchAccount(params);
    if (method === 'session.pin' || method === 'session.review' || method === 'session.read' || method === 'session.cancelRecovery') {
      const session = this.requireSession(params.id);
      if (method === 'session.pin') { this.adapters.get(params.id)?.cancelRecovery?.(); session.pinned = Boolean(params.pinned); }
      if (method === 'session.review') session.reviewNeeded = false;
      if (method === 'session.read') session.unread = false;
      if (method === 'session.cancelRecovery') { session.autoRecovery = false; this.adapters.get(params.id)?.cancelRecovery?.(); session.detail = '자동 복구를 취소했습니다.'; }
      this.changed(); await this.save(); return true;
    }
    if (method === 'workspace.save') { this.workspace = this.validateWorkspace(params); await this.save(); this.changed(); return this.workspace; }
    if (method === 'accounts.import') { if (!text(params.path, 32768) || !path.isAbsolute(params.path)) throw new Error('인증 JSON 파일을 선택하세요.'); const result = await this.accounts.importFile(params.path); this.changed(); return result; }
    if (method === 'accounts.discover') { const result = await this.accounts.importOrca(); this.changed(); return result; }
    if (method === 'accounts.refresh') return this.refreshAccounts();
    if (method === 'runtime.shutdown') {
      if (this.adapters.size || this.operations.size || this.pendingCreates || this.pendingStops || this.refreshing) throw new Error('세션과 진행 중인 요청을 모두 종료한 뒤 실행부를 종료하세요.');
      this.closing = true; await this.accounts.close?.(); await this.save(); return { shutdown: true };
    }
    if (method.startsWith('terminal.')) {
      const session = this.requireSession(params.id), screen = this.screens.get(params.id), adapter = this.adapters.get(params.id);
      if (!screen || !adapter) throw new Error('종료된 터미널입니다. 대화 ID로 재개하세요.');
      if (method === 'terminal.snapshot') return screen.snapshot();
      if (!text(params.viewId)) throw new Error('패널 ID가 필요합니다.');
      if (method === 'terminal.attach') {
        const { cols, rows } = this.dimensions(params);
        this.owners.set(params.id, { clientId, viewId: params.viewId });
        screen.resize(cols, rows); adapter.resize(cols, rows); session.cols = cols; session.rows = rows;
        this.broadcast({ type: 'terminal.resize', id: params.id, cols, rows, ownerViewId: params.viewId });
        return screen.snapshot();
      }
      const owner = this.owners.get(params.id);
      if (!owner || owner.clientId !== clientId || owner.viewId !== params.viewId) throw new Error('다른 패널이 이 터미널을 사용 중입니다. 패널을 클릭해 다시 연결하세요.');
      if (method === 'terminal.input') {
        if (!text(params.data, 65536)) throw new Error('입력이 너무 크거나 올바르지 않습니다.');
        adapter.input(params.data); return true;
      }
      if (method === 'terminal.resize') { const { cols, rows } = this.dimensions(params); screen.resize(cols, rows); adapter.resize(cols, rows); session.cols = cols; session.rows = rows; this.broadcast({ type: 'terminal.resize', id: params.id, cols, rows, ownerViewId: params.viewId }); return true; }
    }
    throw new Error('지원하지 않는 명령입니다.');
  }
}
