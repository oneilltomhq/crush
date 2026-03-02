/**
 * Bridge Server — exposes the CDP bridge for user's local browser.
 *
 * Usage:
 *   npx tsx server/bridge-server.ts [--port 9230]
 *
 * The user runs bridge-client.js on their machine, connecting to this server.
 * Then patchright/stealth-browser can connect to the bridged CDP endpoint.
 */

import { CdpBridge } from './cdp-bridge';
import { createStealthSession, type StealthSession } from './stealth-browser';

const PORT = parseInt(process.argv.find((_, i, a) => a[i - 1] === '--port') || '9230');

const bridge = new CdpBridge();

async function main() {
  await bridge.start(PORT);
  console.log(`CDP Bridge listening on port ${PORT}`);
  console.log(`  Tunnel endpoint:  ws://localhost:${PORT}/tunnel`);
  console.log(`  CDP endpoint:     ${bridge.getEndpoint()}`);
  console.log();
  console.log('Waiting for bridge client connection...');
  console.log('User should run:');
  console.log(`  node bridge-client.js ws://<this-server>:${PORT}/tunnel`);

  // Poll for connection and test it
  const checkInterval = setInterval(async () => {
    if (bridge.isConnected()) {
      console.log('\n✓ Bridge client connected!');

      // Try to fetch browser version info
      try {
        const http = await import('http');
        const res = await new Promise<string>((resolve, reject) => {
          http.get(`http://localhost:${PORT}/json/version`, (r) => {
            let body = '';
            r.on('data', (c: Buffer) => { body += c; });
            r.on('end', () => resolve(body));
          }).on('error', reject);
        });
        const info = JSON.parse(res);
        console.log(`  Browser: ${info.Browser}`);
        console.log(`  User-Agent: ${info['User-Agent']}`);
      } catch (e: any) {
        console.log(`  (Could not fetch browser info: ${e.message})`);
      }

      clearInterval(checkInterval);
    }
  }, 1000);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  await bridge.stop();
  process.exit(0);
});
