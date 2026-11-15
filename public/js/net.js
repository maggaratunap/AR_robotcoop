// Thin WebSocket client for the room relay in server.js.
export class Net {
  constructor() {
    this.ws = null;
    this.onmsg = () => {};
    this.onclose = () => {};
  }

  get open() { return !!this.ws && this.ws.readyState === 1; }

  connect() {
    if (this.open) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/ws`);
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error('Server did not answer. It may be waking up, try again in a moment.')), 12000);
      ws.onopen = () => { clearTimeout(timer); resolve(); };
      ws.onerror = () => { clearTimeout(timer); reject(new Error('Could not reach the game server.')); };
      ws.onclose = () => { this.onclose(); };
      ws.onmessage = (ev) => {
        let m;
        try { m = JSON.parse(ev.data); } catch { return; }
        this.onmsg(m);
      };
    });
  }

  send(obj) { if (this.open) this.ws.send(JSON.stringify(obj)); }

  // Send a request and wait for the server's 'room' or 'err' reply.
  request(obj) {
    return new Promise((resolve, reject) => {
      const prev = this.onmsg;
      const timer = setTimeout(() => { this.onmsg = prev; reject(new Error('No reply from server.')); }, 8000);
      this.onmsg = (m) => {
        if (m.t === 'room') { clearTimeout(timer); this.onmsg = prev; resolve(m); }
        else if (m.t === 'err') { clearTimeout(timer); this.onmsg = prev; reject(new Error(m.msg)); }
        else prev(m);
      };
      this.send(obj);
    });
  }

  close() { if (this.ws) { this.ws.onclose = null; this.ws.close(); this.ws = null; } }
}
