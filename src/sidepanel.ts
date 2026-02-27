import { initTerminalRenderer } from './renderer';
import { InputHandler } from './input';
import { LocalShell } from './shell';
import { cdpEventBus } from './events';
import { rpc } from './chrome-rpc';
import { OpfsWorkspaceFS } from './fs';


async function main() {
  const container = document.getElementById('terminal-container')!;
  const { ghostty, term, scene, container: renderContainer } = await initTerminalRenderer(container);

  // Filesystem for the shell
  const fs = new OpfsWorkspaceFS();

  // Local shell — sits between input and terminal
  const shell = new LocalShell({ term, chrome: rpc, fs, scene });
  shell.start();

  // Input handler — keyboard events → shell.feed()
  new InputHandler({
    ghostty,
    container: renderContainer,
    onData: (data) => shell.feed(data),
    getMode: (mode) => term.getMode(mode, false),
  });

  // Listen for messages from the service worker
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.target !== 'sidepanel') {
      return;
    }

    switch (message.type) {
      case 'cdp-detach':
        term.write(`\r\n\x1b[33mDebugger detached: ${message.reason}\x1b[0m\r\n`);
        break;
      case 'cdp-event':
        cdpEventBus.emit(message.method, message.params);
        break;
    }
  });


  // Focus the render canvas so keyboard events fire immediately
  renderContainer.focus();
}

main().catch(console.error);
