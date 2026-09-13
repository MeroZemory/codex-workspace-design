import net from 'node:net';
import { timingSafeEqual, randomUUID } from 'node:crypto';

const MAX = 2 * 1024 * 1024;
function validToken(given, expected) {
  if (typeof given !== 'string') return false;
  const actual = Buffer.from(given), wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}
export function serveIpc({ pipe, token, dispatch, onDisconnect }) {
  const clients = new Set();
  const send = (socket, value) => {
    if (socket.destroyed) return;
    if (socket.writableLength > MAX) { socket.destroy(); return; }
    socket.write(JSON.stringify(value) + '\n');
  };
  const server = net.createServer(socket => {
    socket.setEncoding('utf8');
    let pending = '', authorized = false;
    const clientId = randomUUID();
    socket.setTimeout(10000, () => { if (!authorized) socket.destroy(); });
    socket.on('error', () => {});
    socket.on('close', () => { clients.delete(socket); onDisconnect?.(clientId); });
    socket.on('data', data => {
      pending += data.toString('utf8');
      if (Buffer.byteLength(pending) > MAX) return socket.destroy();
      let end;
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        let request;
        try { request = JSON.parse(line); } catch { socket.destroy(); return; }
        if (!request || typeof request !== 'object' || Array.isArray(request)) { socket.destroy(); return; }
        if (!validToken(request.token, token)) { socket.destroy(); return; }
        authorized = true; clients.add(socket); socket.setTimeout(0);
        Promise.resolve().then(() => dispatch(request.method, request.params || {}, { clientId })).then(
          result => send(socket, { id: request.id, result }),
          error => send(socket, { id: request.id, error: error.message || '요청 실패' })
        );
      }
    });
  });
  return { server, listen: () => new Promise((resolve, reject) => { server.once('error', reject); server.listen(pipe, () => { server.off('error', reject); resolve(); }); }),
    broadcast: event => { for (const socket of clients) send(socket, { event }); },
    close: () => { for (const socket of clients) socket.destroy(); return new Promise(resolve => server.close(resolve)); }
  };
}

export function connectIpc(pipe, token, onEvent = () => {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipe);
    socket.setEncoding('utf8');
    const calls = new Map(); let pending = '', nextId = 1;
    const rejectAll = error => { for (const call of calls.values()) { clearTimeout(call.timer); call.reject(error); } calls.clear(); };
    const client = {
      invoke(method, params = {}) {
        if (socket.destroyed) return Promise.reject(new Error('백그라운드 실행부와 연결이 끊겼습니다. 창을 다시 열어 연결하세요.'));
        const id = nextId++;
        return new Promise((res, rej) => {
          const timer = setTimeout(() => { calls.delete(id); rej(new Error('요청 응답 시간이 초과됐습니다. 현재 상태를 확인하세요.')); }, 45000);
          calls.set(id, { resolve: res, reject: rej, timer });
          socket.write(JSON.stringify({ id, method, params, token }) + '\n');
        });
      }, close() { socket.destroy(); }
    };
    socket.on('error', error => { reject(error); rejectAll(error); });
    socket.on('close', () => { rejectAll(new Error('실행부 연결 종료')); onEvent({ type: 'error', message: '실행부 연결이 끊겼습니다. 창을 다시 열어 연결하세요.' }); });
    socket.on('data', data => {
      pending += data.toString('utf8');
      if (Buffer.byteLength(pending) > 16 * MAX) { socket.destroy(); return; }
      let end;
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        let message; try { message = JSON.parse(line); } catch { socket.destroy(); return; }
        if (message.event) onEvent(message.event);
        else { const call = calls.get(message.id); if (call) { clearTimeout(call.timer); calls.delete(message.id); message.error ? call.reject(new Error(message.error)) : call.resolve(message.result); } }
      }
    });
    socket.once('connect', () => resolve(client));
  });
}
