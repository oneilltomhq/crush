import { initTerminalRenderer } from './renderer';

async function main() {
  const container = document.getElementById('terminal-container')!;
  await initTerminalRenderer(container);
}

main().catch(console.error);
