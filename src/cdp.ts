// src/debugger.ts

export class CdpRpc {
  async attach() {
    return chrome.runtime.sendMessage({
      target: 'cdp',
      type: 'attach',
    });
  }

  async detach() {
    return chrome.runtime.sendMessage({
      target: 'cdp',
      type: 'detach',
    });
  }

  async sendCommand(method: string, params?: object) {
    return chrome.runtime.sendMessage({
      target: 'cdp',
      type: 'sendCommand',
      method,
      params,
    });
  }
}
