const fs = require('fs');

async function getWsUrl() {
  const res = await fetch('http://localhost:9222/json/list');
  const targets = await res.json();
  let page = targets.find(t => t.type === 'page' && t.url.includes('localhost:5173'));
  if (!page) {
    page = targets.find(t => t.type === 'page');
  }
  return page.webSocketDebuggerUrl;
}

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 1;
    this.callbacks = new Map();
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
      this.ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.id && this.callbacks.has(msg.id)) {
          const cb = this.callbacks.get(msg.id);
          this.callbacks.delete(msg.id);
          if (msg.error) cb.reject(new Error(msg.error.message));
          else cb.resolve(msg.result);
        }
      };
    });
  }

  async send(method, params = {}) {
    const id = this.id++;
    return new Promise((resolve, reject) => {
      this.callbacks.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async navigate(url) {
    await this.send('Page.enable');
    return this.send('Page.navigate', { url });
  }

  async reload(ignoreCache = true) {
    return this.send('Page.reload', { ignoreCache });
  }

  async eval(expression) {
    await this.send('Runtime.enable');
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || 'Eval error');
    }
    return res.result?.value;
  }

  async screenshot(outputPath) {
    const res = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(outputPath, Buffer.from(res.data, 'base64'));
  }

  close() {
    this.ws.close();
  }
}

module.exports = { CDP, getWsUrl };
