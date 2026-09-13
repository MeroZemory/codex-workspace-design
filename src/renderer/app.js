import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import './style.css';

const $ = (selector) => document.querySelector(selector);
const bridge = window.workspace;
const states = { starting: ['◌', '시작 중'], running: ['●', '진행 중'], approval: ['◆', '승인 필요'], input: ['?', '입력 필요'], idle: ['○', '대기'], recovering: ['↻', '복구 중'], waiting: ['◷', '사용량 대기'], error: ['!', '오류'], unknown: ['?', '확인 중'], stopped: ['■', '종료'] };
let state = { sessions: [], accounts: [], workspace: { tabs: [], activeTabId: null }, runtime: {} };
let onlyAttention = false;
let layoutDirty = false;
let saveRevision = 0;
let saveChain = Promise.resolve();
const windowInstance = crypto.randomUUID();
const views = new Map();
const owners = new Map();
const tabNodes = new Map();
let representativeTabId = null;
const representatives = new Map();
const uid = () => crypto.randomUUID();
const sessionById = (id) => state.sessions.find((s) => s.id === id);
const activeTab = () => state.workspace.tabs.find((t) => t.id === state.workspace.activeTabId);
const needsAttention = (s) => ['approval', 'input', 'error', 'waiting'].includes(s.status) || s.unread || s.reviewNeeded;
function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
function button(text, action, className = '', title = text) { const node = el('button', className, text); node.type = 'button'; node.title = title; node.addEventListener('click', () => Promise.resolve().then(action).catch(showError)); return node; }
function showError(error) { $('#error span').textContent = error?.message || String(error); $('#error').hidden = false; }
async function invoke(method, params) { if (!bridge) throw new Error('데스크톱 연결을 사용할 수 없습니다. 앱을 다시 실행하세요.'); return bridge.invoke(method, params); }
async function action(method, params) { try { return await invoke(method, params); } catch (error) { showError(error); throw error; } }
function statusBadge(session) { const [icon, label] = states[session.status] || states.unknown; const badge = el('span', `state state-${session.status}`, `${icon} ${label}`); badge.title = session.detail || label; return badge; }
function accountName(id) { const a = state.accounts.find((item) => item.id === id); return a?.label || a?.email || (id ? '계정 확인 중' : '계정 미연결'); }
function appliedAccountLabel(session) {
  const name = accountName(session.accountId);
  if (session.accountState === 'applying') return `계정 적용 중 · ${name}`;
  if (session.accountState === 'failed') return `계정 적용 실패 · ${name}`;
  if (!session.accountId || session.accountState === 'unmanaged') return '적용 계정 · 미연결';
  if (session.status === 'stopped' && session.accountState !== 'applied') return `마지막 계정 · ${name}`;
  return `적용 계정 · ${name}`;
}
function basename(path) { return path?.split(/[\\/]/).filter(Boolean).pop() || '폴더 없음'; }
function saveLayout() {
  layoutDirty = true;
  const revision = ++saveRevision;
  const workspace = structuredClone(state.workspace);
  saveChain = saveChain.catch(() => {}).then(() => invoke('workspace.save', workspace)).then(() => {
    if (revision === saveRevision) layoutDirty = false;
  }).catch((error) => { if (revision === saveRevision) layoutDirty = false; showError(error); });
  return saveChain;
}
function selectTab(id) { state.workspace.activeTabId = id; renderWorkspace(); saveLayout(); }
function newTab(title = `작업 ${state.workspace.tabs.length + 1}`) { const tab = { id: uid(), title, panels: [], columns: 2 }; state.workspace.tabs.push(tab); state.workspace.activeTabId = tab.id; renderWorkspace(); saveLayout(); return tab; }
function addPanel(sessionId) { const tab = activeTab() || newTab(); tab.panels.push({ id: uid(), sessionId }); renderWorkspace(); saveLayout(); }
function revealSession(id) {
  const current = activeTab()?.panels.find((p) => p.sessionId === id);
  const tab = current ? activeTab() : state.workspace.tabs.find((t) => t.panels.some((p) => p.sessionId === id));
  if (tab) selectTab(tab.id); else addPanel(id);
  requestAnimationFrame(() => { const panel = activeTab()?.panels.find((p) => p.sessionId === id); if (panel) focusView(views.get(panel.id)); });
}
function renderSidebar() {
  const list = $('#session-list'); list.replaceChildren();
  const query = $('#search').value.toLocaleLowerCase();
  $('#session-count').textContent = state.sessions.length;
  $('#attention-filter span').textContent = state.sessions.filter(needsAttention).length;
  $('#attention-filter').classList.toggle('selected', onlyAttention);
  const groups = new Map();
  for (const session of state.sessions) {
    if (onlyAttention && !needsAttention(session)) continue;
    if (query && !`${session.title} ${session.cwd}`.toLocaleLowerCase().includes(query)) continue;
    const key = session.cwd || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(session);
  }
  for (const [cwd, sessions] of groups) {
    const heading = el('div', 'group-heading'); heading.title = cwd;
    heading.append(el('span', '', basename(cwd)), el('span', 'count', sessions.length)); list.append(heading);
    for (const session of sessions) {
      const row = button('', () => revealSession(session.id), 'session-row', `${session.title || basename(cwd)}\n${cwd}\n${session.detail || ''}`);
      const title = el('div', 'session-title'); title.append(el('span', '', session.title || basename(cwd)));
      if (session.unread) title.append(el('span', 'unread', '새 결과'));
      const info = el('div', 'session-info'); info.append(statusBadge(session));
      if (session.reviewNeeded) info.append(el('span', 'review-marker', '검수 전'));
      row.append(title, info); list.append(row);
    }
  }
  if (!groups.size) list.append(el('p', 'rail-empty', state.sessions.length ? '조건에 맞는 세션이 없습니다.' : '새 세션을 시작하면\n프로젝트별로 모아 볼 수 있습니다.'));
}
function renderWorkspace() {
  const tabs = $('#tabs'); tabs.replaceChildren();
  const validPanels = new Set();
  const validTabs = new Set(state.workspace.tabs.map((t) => t.id));
  for (const [id, node] of tabNodes) if (!validTabs.has(id)) { node.remove(); tabNodes.delete(id); }
  for (const tab of state.workspace.tabs) {
    const selected = tab.id === state.workspace.activeTabId;
    const tabItem = el('div', `tab-item${selected ? ' active' : ''}`);
    const attention = new Set(tab.panels.filter((p) => needsAttention(sessionById(p.sessionId) || {})).map((p) => p.sessionId)).size;
    const tabButton = button(`${tab.title}${attention ? `  · ${attention}` : ''}`, () => selectTab(tab.id), 'tab-select');
    tabButton.setAttribute('role', 'tab'); tabButton.setAttribute('aria-selected', String(selected));
    tabItem.append(tabButton, button('×', () => { state.workspace.tabs = state.workspace.tabs.filter((t) => t.id !== tab.id); if (!state.workspace.tabs.length) state.workspace.tabs.push({ id: uid(), title: '작업 공간', panels: [], columns: 2 }); if (selected) state.workspace.activeTabId = state.workspace.tabs[0].id; renderWorkspace(); saveLayout(); }, 'tab-close', '탭 닫기 · 세션은 유지'));
    tabs.append(tabItem);
    let grid = tabNodes.get(tab.id);
    if (!grid) { grid = el('div', 'terminal-grid'); tabNodes.set(tab.id, grid); $('#workspaces').append(grid); }
    grid.hidden = !selected;
    const columns = Math.min(4, Math.max(1, Number(tab.columns) || 2));
    grid.style.gridTemplateColumns = Array.from({ length: columns }, (_, i) => `${tab.widths?.[i] || 1}fr`).join(' ');
    grid.querySelectorAll(':scope > .empty-workspace, :scope > .column-handle').forEach((node) => node.remove());
    for (const panel of tab.panels) {
      const session = sessionById(panel.sessionId); if (!session) continue;
      validPanels.add(panel.id);
      let view = views.get(panel.id);
      if (!view) { view = createView(panel, tab.id); views.set(panel.id, view); }
      if (view.root.parentNode !== grid) grid.append(view.root);
      updateView(view, session, tab);
      view.visible = selected;
    }
    if (!tab.panels.some((p) => sessionById(p.sessionId))) grid.append(emptyWorkspace());
    if (selected) requestAnimationFrame(() => arrangeRepresentatives(tab));
    if (columns > 1 && tab.panels.length > 1) addColumnHandles(grid, tab, columns);
  }
  for (const [id, view] of views) if (!validPanels.has(id)) { view.observer.disconnect(); view.term.dispose(); view.root.remove(); views.delete(id); }
  let empty = $('#no-tabs');
  if (!state.workspace.tabs.length) { if (!empty) { empty = emptyWorkspace(); empty.id = 'no-tabs'; $('#workspaces').append(empty); } } else empty?.remove();
  $('#layout-title').textContent = activeTab() ? `${activeTab().panels.length}개 패널` : '작업 공간';
  $('#columns').value = activeTab()?.columns || 2;
  $('#columns').disabled = !activeTab(); $('#rename-tab').disabled = !activeTab();
}
async function arrangeRepresentatives(tab) {
  if (activeTab()?.id !== tab.id) return;
  if (representativeTabId !== tab.id) { representativeTabId = tab.id; representatives.clear(); }
  const grouped = new Map();
  for (const panel of tab.panels) {
    const view = views.get(panel.id);
    if (!view || sessionById(view.sessionId)?.status === 'stopped') continue;
    if (!grouped.has(view.sessionId)) grouped.set(view.sessionId, []);
    grouped.get(view.sessionId).push(view);
  }
  for (const [sessionId, group] of grouped) {
    const focused = group.find((view) => view.root.contains(document.activeElement));
    const previous = group.find((view) => view.id === representatives.get(sessionId));
    const representative = focused || previous || group[0];
    const changed = representatives.get(sessionId) !== representative.id;
    representatives.set(sessionId, representative.id);
    if (changed) await attachView(representative, true);
    else fitOwner(representative);
    if (activeTab()?.id !== tab.id) return;
    for (const view of group) if (!view.attached) await attachView(view, false);
  }
}
function emptyWorkspace() {
  const node = el('div', 'empty-workspace');
  node.append(el('div', 'empty-symbol', '▦'), el('h2', '', '필요한 터미널을 한 화면에'), el('p', '', '프로젝트가 달라도 함께 배치하세요.\n작업 탭마다 배치를 따로 저장합니다.'));
  const actions = el('div', 'empty-actions'); actions.append(button('＋ 새 세션', createSession, 'primary'), button('기존 세션 배치', chooseSession)); node.append(actions);
  if (!state.accounts.length) node.append(button('Orca 계정 확인', () => { $('#accounts-drawer').hidden = false; }, 'text-button'));
  return node;
}
function addColumnHandles(grid, tab, columns) {
  const widths = tab.widths?.length === columns ? [...tab.widths] : Array(columns).fill(1);
  const total = widths.reduce((sum, n) => sum + n, 0);
  for (let i = 0; i < columns - 1; i++) {
    const handle = el('div', 'column-handle'); handle.setAttribute('role', 'separator'); handle.setAttribute('aria-orientation', 'vertical'); handle.setAttribute('aria-label', `${i + 1}열 너비 조절`); handle.tabIndex = 0;
    handle.style.left = `${widths.slice(0, i + 1).reduce((sum, n) => sum + n, 0) / total * 100}%`;
    const adjust = (delta) => { const pair = widths[i] + widths[i + 1]; widths[i] = Math.max(pair * .15, Math.min(pair * .85, widths[i] + delta)); widths[i + 1] = pair - widths[i]; tab.widths = [...widths]; grid.style.gridTemplateColumns = widths.map((n) => `${n}fr`).join(' '); handle.style.left = `${widths.slice(0, i + 1).reduce((sum, n) => sum + n, 0) / total * 100}%`; };
    handle.addEventListener('pointerdown', (event) => { event.preventDefault(); handle.setPointerCapture(event.pointerId); let x = event.clientX; const move = (e) => { adjust((e.clientX - x) / grid.clientWidth * total); x = e.clientX; }; const end = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', end); handle.removeEventListener('pointercancel', end); saveLayout(); }; handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', end); handle.addEventListener('pointercancel', end); });
    handle.addEventListener('keydown', (event) => { if (['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); adjust(event.key === 'ArrowLeft' ? -.1 : .1); saveLayout(); } }); grid.append(handle);
  }
}
function createView(panel, tabId) {
  const root = el('section', 'terminal-panel'); root.dataset.panelId = panel.id; if (panel.height) root.style.height = `${panel.height}px`; root.addEventListener('pointerup', () => { const height = parseInt(root.style.height, 10); const current = state.workspace.tabs.find((tab) => tab.id === tabId)?.panels.find((item) => item.id === panel.id); if (current && Number.isFinite(height) && height !== current.height) { current.height = Math.max(280, height); saveLayout(); } });
  const header = el('header', 'panel-header'); const title = el('span', 'panel-title'); const status = el('span'); const controls = el('div', 'panel-controls'); header.append(title, status, controls);
  const meta = el('div', 'panel-meta'); const account = el('span'); const pin = button('', () => { const s = sessionById(panel.sessionId); return action('session.pin', { id: s.id, pinned: !s.pinned }); });
  meta.append(account, pin, button('전환', () => switchAccount(panel.sessionId), '', '계정 전환'), button('검수 완료', () => action('session.review', { id: panel.sessionId }), 'review-button'));
  const detail = el('div', 'panel-detail'); detail.hidden = true;
  const mirror = el('span', 'mirror-label', '미러 · 클릭하면 입력'); meta.append(mirror); const terminal = el('div', 'terminal-host'); root.append(header, meta, detail, terminal);
  const term = new Terminal({ fontFamily: 'Cascadia Mono, Consolas, monospace', fontSize: 13, cursorBlink: true, scrollback: 3000, allowProposedApi: false, theme: { background: '#14191f', foreground: '#dbe2ea', cursor: '#cadcf3', selectionBackground: '#355477' } });
  const fit = new FitAddon(); term.loadAddon(fit); term.open(terminal);
  const view = { id: panel.id, viewId: `${windowInstance}:${panel.id}`, sessionId: panel.sessionId, tabId, root, title, status, controls, meta, detail, mirror, terminal, account, pin, term, fit, seq: 0, attached: false, attaching: false, buffered: [], visible: false };
  term.onData((data) => {
    // Match runtime/codex.mjs isTerminalResponse: the canonical headless terminal
    // answers CPR/DA requests, so renderer mirrors must not answer them again.
    // Ordinary keys, pasted text, and mixed input continue to the session.
    if (data.length <= 128 && /^\x1b\[(?:\d{1,4};\d{1,4}R|[?>]?[\d;]{1,64}c)$/.test(data)) return;
    if (owners.get(view.sessionId) !== view.viewId || view.attaching) return;
    invoke('terminal.input', { id: view.sessionId, viewId: view.viewId, data }).catch(showError);
  });
  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown' || !event.ctrlKey || !event.shiftKey) return true;
    if (event.code === 'KeyC' && term.hasSelection()) {
      event.preventDefault(); invoke('clipboard.writeText', { text: term.getSelection() }).catch(showError); return false;
    }
    if (event.code === 'KeyV') {
      event.preventDefault();
      (async () => { const text = await invoke('clipboard.readText'); const attached = await attachView(view, true); if (attached && views.has(view.id) && owners.get(view.sessionId) === view.viewId && !view.attaching) term.paste(text); })().catch(showError);
      return false;
    }
    return true;
  });
  terminal.addEventListener('focusin', () => { if (sessionById(view.sessionId)?.status !== 'stopped') attachView(view); markRead(view.sessionId); });
  const observer = new ResizeObserver(() => { if (view.visible && owners.get(view.sessionId) === view.viewId && view.attached && !view.attaching) fitOwner(view); }); observer.observe(terminal); view.observer = observer;
  return view;
}
function updateView(view, session, tab) {
  view.title.textContent = session.title || basename(session.cwd); view.title.title = session.cwd;
  view.status.replaceChildren(statusBadge(session)); view.account.textContent = appliedAccountLabel(session); view.account.title = session.accountAppliedAt ? `Codex 적용 확인: ${new Date(session.accountAppliedAt).toLocaleTimeString('ko-KR')}` : session.detail || session.cwd;
  view.pin.textContent = session.pinned ? '● 고정됨' : '자동'; view.pin.title = session.pinned ? '계정 고정 해제' : '현재 계정 고정'; view.pin.disabled = !session.accountId;
  view.meta.querySelector('.review-button').hidden = !session.reviewNeeded;
  view.detail.textContent = session.detail || ''; view.detail.hidden = !session.detail;
  view.controls.replaceChildren();
  if (['waiting', 'recovering'].includes(session.status) && session.autoRecovery !== false) view.controls.append(button('자동 재시도 취소', () => action('session.cancelRecovery', { id: session.id })));
  if (session.status === 'stopped' && session.threadId) view.controls.append(button('대화 재개', () => createSession({ cwd: session.cwd, resumeId: session.threadId, title: session.title })));
  view.controls.append(button('←', () => movePanel(tab, view.id, -1), '', '패널 앞으로 이동'), button('→', () => movePanel(tab, view.id, 1), '', '패널 뒤로 이동'), button('종료', () => deleteSession(session), 'danger-text', '세션 종료 및 목록에서 삭제'), button('×', () => { tab.panels = tab.panels.filter((p) => p.id !== view.id); renderWorkspace(); saveLayout(); }, '', '패널 닫기 · 세션은 유지'));
}
function movePanel(tab, id, delta) { const index = tab.panels.findIndex((p) => p.id === id); const to = index + delta; if (to < 0 || to >= tab.panels.length) return; [tab.panels[index], tab.panels[to]] = [tab.panels[to], tab.panels[index]]; const grid = tabNodes.get(tab.id); for (const panel of tab.panels) { const view = views.get(panel.id); if (view) grid.append(view.root); } saveLayout(); }
function mirrorMode(view) {
  const mirror = owners.get(view.sessionId) !== view.viewId;
  view.root.classList.toggle('is-mirror', mirror); view.mirror.hidden = !mirror;
  const screen = view.term.element?.querySelector('.xterm-screen');
  view.term.element.style.minWidth = mirror ? screen?.style.width || '' : '';
  view.term.element.style.minHeight = mirror ? screen?.style.height || '' : '';
}
function applyCanonical(view, cols, rows) {
  if (Number.isInteger(cols) && Number.isInteger(rows) && cols > 0 && rows > 0) view.term.resize(cols, rows);
  mirrorMode(view);
}
function fitOwner(view) {
  if (!view.visible || owners.get(view.sessionId) !== view.viewId) return;
  mirrorMode(view);
  const before = `${view.term.cols}:${view.term.rows}`; view.fit.fit();
  if (view.attached && !view.attaching && before !== `${view.term.cols}:${view.term.rows}`) invoke('terminal.resize', { id: view.sessionId, viewId: view.viewId, cols: view.term.cols, rows: view.term.rows }).catch(showError);
}
async function attachView(view, claim = true) {
  if (!view.visible) return;
  if (view.attaching) { await view.attachFlight; return claim ? attachView(view, true) : view.attached; }
  view.attaching = true; view.buffered = [];
  let release; view.attachFlight = new Promise((resolve) => { release = resolve; });
  try {
    if (claim) { view.term.element.style.minWidth = ''; view.term.element.style.minHeight = ''; view.fit.fit(); }
    const snapshot = await invoke(claim ? 'terminal.attach' : 'terminal.snapshot', claim ? { id: view.sessionId, viewId: view.viewId, cols: view.term.cols, rows: view.term.rows } : { id: view.sessionId });
    if (!views.has(view.id)) return;
    if (claim) owners.set(view.sessionId, view.viewId);
    else if (snapshot.ownerViewId !== undefined) owners.set(view.sessionId, snapshot.ownerViewId);
    view.term.reset(); applyCanonical(view, snapshot.cols, snapshot.rows); view.term.write(snapshot.data || ''); view.seq = snapshot.seq || 0; view.attached = true;
    for (const event of view.buffered) {
      if (event.type === 'terminal.resize') applyCanonical(view, event.cols, event.rows);
      else if (event.seq > view.seq) { view.term.write(event.data); view.seq = event.seq; }
    }
    for (const other of views.values()) if (other.sessionId === view.sessionId) mirrorMode(other);
    return true;
  } catch (error) { showError(error); return false; } finally { view.attaching = false; view.buffered = []; release(); }
}
async function focusView(view) { if (!view || sessionById(view.sessionId)?.status === 'stopped') return; await attachView(view, true); if (views.has(view.id)) { view.term.focus(); markRead(view.sessionId); } }
function markRead(id) { if (sessionById(id)?.unread) invoke('session.read', { id }).catch(showError); }
function applySnapshot(next) { const local = state.workspace; state = { ...state, ...next }; state.sessions ||= []; state.accounts ||= []; state.workspace ||= local; if (layoutDirty) state.workspace = local; if (!state.workspace.tabs.some((t) => t.id === state.workspace.activeTabId)) state.workspace.activeTabId = state.workspace.tabs[0]?.id || null; renderSidebar(); renderWorkspace(); renderAccounts(); $('#connection').textContent = '● 연결됨'; $('#connection').className = 'connected'; $('#global-status').textContent = `${state.sessions.filter((s) => s.status === 'running').length}개 진행 중 · ${state.sessions.filter((s) => ['approval', 'input'].includes(s.status)).length}개 응답 필요 · ${state.sessions.filter((s) => s.reviewNeeded).length}개 검수 전`; if (next.error) showError(next.error); }
function dialog(title, fields, submitText = '확인') {
  const dialogNode = $('#form-dialog'); $('#dialog-title').textContent = title; $('#dialog-submit').textContent = submitText; $('#dialog-fields').replaceChildren(...fields); dialogNode.returnValue = ''; dialogNode.showModal();
  return new Promise((resolve) => dialogNode.addEventListener('close', () => resolve(dialogNode.returnValue === 'ok'), { once: true }));
}
function field(label, input) { const node = el('label', 'field'); node.append(el('span', '', label), input); return node; }
function input(value = '', placeholder = '') { const node = el('input'); node.value = value; node.placeholder = placeholder; return node; }
function accountSelect(automatic = true) { const select = el('select'); if (automatic) select.append(new Option('자동 선택', '')); for (const account of state.accounts) select.append(new Option(`${account.label || account.email} · ${account.plan || account.status}`, account.id)); return select; }
async function createSession(defaults = {}) {
  const cwd = input(defaults.cwd || '', 'C:\\projects\\my-project'); cwd.required = true;
  const folderRow = el('div', 'input-row'); folderRow.append(cwd, button('폴더 선택', async () => { const value = await invoke('folder.pick'); if (value) cwd.value = typeof value === 'string' ? value : value.path || ''; }));
  const title = input(defaults.title || '', '폴더 이름 사용'); const account = accountSelect(); const resume = input(defaults.resumeId || '', '새 대화로 시작');
  const fields = [field('작업 폴더', folderRow), field('세션 이름 (선택)', title), field('시작 계정', account), field('기존 대화 ID로 재개 (선택)', resume)];
  if (!state.accounts.length) fields.unshift(el('p', 'notice', 'Orca 계정을 찾지 못했습니다. 계정 · 사용량에서 Orca 다시 검색을 실행하세요.'));
  if (!await dialog('새 Codex 세션', fields, '시작')) return;
  const result = await action('session.create', { cwd: cwd.value.trim(), ...(title.value.trim() ? { title: title.value.trim() } : {}), ...(account.value ? { accountId: account.value } : {}), ...(resume.value.trim() ? { resumeId: resume.value.trim() } : {}) });
  const id = typeof result === 'string' ? result : result?.id || result?.session?.id;
  if (id) { const snapshot = await invoke('snapshot'); applySnapshot(snapshot); addPanel(id); }
}
async function chooseSession() { if (!state.sessions.length) return createSession(); const select = el('select'); for (const session of state.sessions) select.append(new Option(`${session.title || basename(session.cwd)} · ${states[session.status]?.[1] || session.status}`, session.id)); if (await dialog('기존 세션을 현재 탭에 배치', [field('세션', select), el('p', 'muted', '다른 탭에도 같은 세션을 배치할 수 있습니다. 실행 중인 대화는 하나로 유지됩니다.')], '배치')) addPanel(select.value); }
async function switchAccount(id) { const session = sessionById(id); const select = accountSelect(false); select.value = session.accountId || ''; const fields = [field('전환할 계정', select), el('p', 'muted', session.pinned ? '전환하면 기존 계정 고정을 해제하고 자동 선택으로 돌아갑니다.' : '진행 중인 턴이 끝난 뒤 전환할 수 있습니다. 선택한 계정은 고정되지 않습니다.')]; if (!select.options.length) return showError('가져온 계정이 없습니다. 계정을 먼저 가져와 주세요.'); if (await dialog('계정 전환', fields, session.pinned ? '고정 해제 후 전환' : '전환')) await action('session.switch', { id, accountId: select.value, pinned: false }); }
async function deleteSession(session) { if (await dialog('세션을 종료하고 삭제할까요?', [el('p', '', `“${session.title || basename(session.cwd)}”의 실행 중인 작업을 종료하고 모든 탭에서 제거합니다.`), el('p', 'muted', '대화 기록과 프로젝트 파일은 삭제하지 않습니다.')], '세션 종료 및 삭제')) await action('session.delete', { id: session.id }); }
function resetLabel(value) { if (!value) return '리셋 시점 미확인'; const date = new Date(typeof value === 'number' && value < 1e12 ? value * 1000 : value); if (!Number.isFinite(date.getTime())) return '리셋 시점 미확인'; const hours = (date.getTime() - Date.now()) / 36e5; return hours <= 0 ? '리셋 확인 필요' : `${hours < 1 ? `${Math.ceil(hours * 60)}분` : `${Math.floor(hours)}시간 ${Math.round(hours % 1 * 60)}분`} 후 리셋`; }
function renderAccounts() {
  const list = $('#accounts-list'); list.replaceChildren();
  const now = Date.now();
  const suggestedAccounts = state.accounts.filter((account) => account.forecast?.windows?.some((window) => window.suggestedBefore && window.suggestedBefore <= now)).length;
  const accountButton = $('#accounts-button');
  const accountButtonLabel = `계정 · 사용량${suggestedAccounts ? ` · ${suggestedAccounts}개 전환 검토` : ''}`;
  accountButton.textContent = accountButtonLabel;
  accountButton.title = accountButtonLabel;
  accountButton.setAttribute('aria-label', accountButtonLabel);
  accountButton.style.color = suggestedAccounts ? 'var(--amber)' : '';
  const discovery = state.runtime?.orcaDiscovery;
  const discoveryText = discovery?.status === 'error' ? ' · Orca 검색 오류' : discovery?.status === 'complete' ? ` · Orca ${discovery.recognized}개 인식` : '';
  $('#accounts-summary').textContent = `${state.accounts.length}개 계정 · ${state.accounts.filter((a) => a.status === 'ready' || a.status === 'active').length}개 사용 가능${discoveryText}`;
  if (!state.accounts.length) { list.append(el('div', 'account-empty', discovery?.status === 'error' ? `Orca 계정 검색 실패: ${discovery.error}` : 'Orca 표준 계정 폴더에서 인증정보를 찾지 못했습니다. Orca에서 계정을 등록한 뒤 다시 검색하세요.')); return; }
  for (const account of state.accounts) {
    const node = el('section', 'account-item'); node.append(el('h3', '', account.label || account.email || '계정'), el('p', 'muted', `${account.email || ''} · ${account.plan || '플랜 미확인'}${account.source === 'orca' ? ' · Orca 자동 인식' : ''}`));
    node.append(el('div', 'account-state', account.error || ({ ready: '사용 가능', active: '사용 가능', expired: '인증 만료', quarantined: '재인증 필요', reauth_required: '재인증 필요', unavailable: '사용 불가' }[account.status] || account.status || '상태 미확인')));
    const usage = account.usage?.rateLimits || account.usage;
    const windows = usage?.windows || ['primary', 'secondary'].filter((kind) => usage?.[kind]).map((kind) => ({ kind, ...usage[kind] }));
    let displayed = false;
    for (const window of windows) {
      const label = `${window.limitId && window.limitId !== 'codex' ? `${window.limitId} · ` : ''}${window.kind === 'secondary' ? '주간 사용량' : '단기 사용량'}`;
      const used = Number(window.usedPercent ?? window.used_percent); if (!Number.isFinite(used)) continue; displayed = true;
      const line = el('div', 'quota-label'); line.append(el('span', '', label), el('span', '', `${Math.max(0, 100 - used).toFixed(0)}% 남음`)); const meter = el('progress'); meter.max = 100; meter.value = Math.max(0, Math.min(100, used)); meter.setAttribute('aria-label', `${label} ${used}% 사용`); node.append(line, meter, el('p', 'reset-time', resetLabel(window.resetsAt ?? window.resets_at ?? window.resetAt)));
    }
    if (!displayed) node.append(el('p', 'muted', '사용량 확인 전'));
    if (usage?.observedAt) node.append(el('p', 'muted', `${new Date(usage.observedAt).toLocaleTimeString('ko-KR')} 조회`));
    const forecast = account.forecast;
    const predicted = forecast?.windows?.filter((w) => Number.isFinite(w.remainingAtReset)) || [];
    if (predicted.length) {
      for (const window of predicted) node.append(el('p', 'forecast', `${window.kind === 'secondary' ? '주간' : '단기'} 리셋 시 ${window.remainingAtReset.toFixed(0)}% 남을 전망${forecast.confidence === 'stale' ? ' · 오래된 관측값' : ' · 추정'}`));
      if (predicted.some((w) => w.suggestedBefore && w.suggestedBefore <= Date.now())) node.append(el('p', 'forecast', '리셋 전 남을 사용량이 있습니다. 다음 턴부터 이 계정으로 전환하는 것을 검토하세요.'));
    } else node.append(el('p', 'forecast', typeof forecast === 'string' ? forecast : forecast?.message || '리셋 전망: 관측 자료 수집 중'));
    const sessions = state.sessions.filter((s) => s.accountId === account.id); node.append(el('p', 'muted', `${sessions.length}개 세션 연결`)); list.append(node);
  }
}
$('#error button').onclick = () => { $('#error').hidden = true; };
$('#create-button').onclick = () => createSession().catch(showError);
$('#new-tab').onclick = () => newTab();
$('#add-session').onclick = () => chooseSession().catch(showError);
$('#search').oninput = renderSidebar;
$('#attention-filter').onclick = () => { onlyAttention = !onlyAttention; renderSidebar(); };
$('#columns').onchange = () => { const tab = activeTab(); if (tab) { tab.columns = Number($('#columns').value); delete tab.widths; renderWorkspace(); saveLayout(); } };
$('#rename-tab').onclick = async () => { const tab = activeTab(); if (!tab) return; const name = input(tab.title); name.required = true; if (await dialog('작업 탭 이름 변경', [field('이름', name)])) { tab.title = name.value.trim() || tab.title; renderWorkspace(); saveLayout(); } };
$('#accounts-button').onclick = () => { $('#accounts-drawer').hidden = !$('#accounts-drawer').hidden; };
$('#close-accounts').onclick = () => { $('#accounts-drawer').hidden = true; };
for (const [selector, method] of [['#import-accounts', 'accounts.discover'], ['#repair-account', 'accounts.repair'], ['#refresh-accounts', 'accounts.refresh']]) $(selector).onclick = async () => { const node = $(selector); node.disabled = true; try { await action(method); applySnapshot(await invoke('snapshot')); } catch {} finally { node.disabled = false; } };
window.addEventListener('error', (event) => showError(event.error || event.message));
window.addEventListener('unhandledrejection', (event) => { event.preventDefault(); showError(event.reason); });
window.addEventListener('focus', () => { for (const view of views.values()) if (view.visible && view.root.contains(document.activeElement) && sessionById(view.sessionId)?.status !== 'stopped') attachView(view); });
document.addEventListener('keydown', (event) => { if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 't') { event.preventDefault(); newTab(); } });
if (bridge) {
  bridge.onEvent((event) => {
    if (event.type === 'snapshot') applySnapshot(event.data);
    else if (event.type === 'error') showError(event.message);
    else if (event.type === 'terminal.resize') {
      if (event.ownerViewId !== undefined) owners.set(event.id, event.ownerViewId);
      for (const view of views.values()) if (view.sessionId === event.id) { if (view.attaching) view.buffered.push(event); else applyCanonical(view, event.cols, event.rows); }
    }
    else if (event.type === 'terminal') for (const view of views.values()) if (view.sessionId === event.id) {
      if (view.attaching) view.buffered.push(event);
      else if (view.attached && event.seq > view.seq) {
        if (event.seq !== view.seq + 1) { view.attached = false; if (view.visible) attachView(view, false); }
        else { view.term.write(event.data); view.seq = event.seq; }
      }
    }
  });
  invoke('snapshot').then(applySnapshot).catch((error) => { $('#connection').textContent = '연결 실패'; showError(error); });
} else { renderWorkspace(); showError('데스크톱 런타임 연결이 없습니다. Codex Workspace 앱에서 열어 주세요.'); }
