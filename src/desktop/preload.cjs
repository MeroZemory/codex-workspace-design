const { contextBridge, ipcRenderer } = require('electron');
const methods = new Set(['snapshot','session.create','session.delete','session.switch','session.pin','session.review','session.read','session.cancelRecovery','terminal.attach','terminal.input','terminal.resize','workspace.save','accounts.discover','accounts.repair','accounts.refresh','folder.pick','runtime.shutdown']);
for (const method of ['terminal.snapshot','clipboard.readText','clipboard.writeText']) methods.add(method);
contextBridge.exposeInMainWorld('workspace', {
  invoke(method, params = {}) {
    if (!methods.has(method)) return Promise.reject(new Error('지원하지 않는 명령입니다.'));
    return ipcRenderer.invoke('workspace:invoke', method, params);
  },
  onEvent(listener) {
    const handler = (_event, value) => listener(value);
    ipcRenderer.on('workspace:event', handler);
    return () => ipcRenderer.removeListener('workspace:event', handler);
  }
});
