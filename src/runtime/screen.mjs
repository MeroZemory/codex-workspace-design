import headless from '@xterm/headless';
import serialize from '@xterm/addon-serialize';

export class Screen {
  constructor(onOutput, { cols = 100, rows = 30, onInput = () => {} } = {}) {
    this.term = new headless.Terminal({ cols, rows, scrollback: 2000, allowProposedApi: true });
    this.serializer = new serialize.SerializeAddon();
    this.term.loadAddon(this.serializer);
    this.term.onData(onInput);
    this.seq = 0;
    this.pending = 0;
    this.tail = Promise.resolve();
    this.onOutput = onOutput;
  }
  write(data) {
    if (this.closed) return;
    if (this.pending + data.length > 4 * 1024 * 1024) throw new Error('터미널 출력 처리 한도를 초과했습니다. 세션 출력을 확인하세요.');
    this.pending += data.length;
    this.tail = this.tail.then(() => new Promise(resolve => {
      if (this.closed) { this.pending -= data.length; return resolve(); }
      this.term.write(data, () => { this.pending -= data.length; this.onOutput({ data, seq: ++this.seq }); resolve(); });
    }));
  }
  async snapshot() {
    await this.tail;
    return { data: this.serializer.serialize(), seq: this.seq, cols: this.term.cols, rows: this.term.rows };
  }
  resize(cols, rows) { this.term.resize(cols, rows); }
  async dispose() { this.closed = true; await this.tail; this.term.dispose(); }
}
