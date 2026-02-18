import { initTerminalRenderer } from './renderer';
import { InputHandler } from './input';
import { LocalShell } from './shell';

async function main() {
  const container = document.getElementById('terminal-container')!;
  const { ghostty, term, container: renderContainer } = await initTerminalRenderer(container);

  // Local shell — sits between input and terminal
  const shell = new LocalShell({ term });
  shell.start();

  // Input handler — keyboard events → shell.feed()
  new InputHandler({
    ghostty,
    container: renderContainer,
    onData: (data) => shell.feed(data),
    getMode: (mode) => term.getMode(mode, false),
  });

  // Focus the render canvas so keyboard events fire immediately
  renderContainer.focus();
}

main().catch(console.error);
