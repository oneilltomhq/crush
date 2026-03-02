# crush — ops guide

Operational procedures for running crush infrastructure.

## Authenticated browser tunnel

The agent automates the user's real browser (with cookies, sessions, logins) via an SSH reverse tunnel. No browser state lives on the server.

### Prerequisites (user's machine)

1. **Brave or Chrome** running with remote debugging:
   ```
   brave --remote-debugging-port=9222
   # or
   google-chrome --remote-debugging-port=9222
   ```
   On macOS with Brave:
   ```
   /Applications/Brave\ Browser.app/Contents/MacOS/Brave\ Browser --remote-debugging-port=9222
   ```

2. **SSH access** to the VM (`valley-silver.exe.xyz`).

### Establishing the tunnel

From the user's machine:
```bash
# Foreground (Ctrl+C to close) — good for short sessions
ssh -NR 9223:localhost:9222 valley-silver.exe.xyz
```

`-N` = no remote shell, tunnel only. `-R` = reverse-forward server:9223 → local:9222.

**Why port 9223?** Port 9222 on the server is used by the server's own Chromium instance. 9223 is the dedicated tunnel port for the user's browser.

### Long-running tunnel

For a full work session, use a control socket so you can manage it cleanly:

```bash
# Start (backgrounds immediately)
ssh -fNR 9223:localhost:9222 \
  -o ServerAliveInterval=60 \
  -o ServerAliveCountMax=3 \
  -o ExitOnForwardFailure=yes \
  -M -S /tmp/crush-tunnel \
  valley-silver.exe.xyz

# Check status
ssh -S /tmp/crush-tunnel -O check valley-silver.exe.xyz

# Close
ssh -S /tmp/crush-tunnel -O exit valley-silver.exe.xyz
```

Flags:
- `-f` = background after connecting
- `-M -S /tmp/crush-tunnel` = control socket for later management
- `ServerAliveInterval=60` = keepalive every 60s (survives Wi-Fi blips)
- `ExitOnForwardFailure=yes` = fail immediately if port 9223 is already bound

For truly persistent tunnels (auto-restart on disconnect), install `autossh`:
```bash
autossh -M 0 -fNR 9223:localhost:9222 \
  -o ServerAliveInterval=60 \
  -o ServerAliveCountMax=3 \
  valley-silver.exe.xyz
```

### Verifying the tunnel

On the server:
```bash
curl -s http://localhost:9223/json/version | jq .Browser
```
Should return the user's browser version (e.g. `"Chrome/145.0.7632.120"`).

### Using in code

```ts
import { createStealthSession } from './server/stealth-browser';

const session = await createStealthSession({
  cdpEndpoint: 'http://localhost:9223',
});

// session.page is a patchright Page connected to the user's browser
// session.human provides human-like mouse/keyboard/scroll behavior
// session.captcha auto-solves CAPTCHAs (requires CAPTCHA_API_KEY env var)
await session.goto('https://linkedin.com');
```

### Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `curl: (7) Failed to connect` | Tunnel not running | Re-run the `ssh -R` command |
| `curl` returns but patchright fails | Browser closed/crashed | Restart browser with `--remote-debugging-port=9222` |
| `Warning: remote port forwarding failed for listen port 9223` | Port already in use on server | Check `ss -tlnp \| grep 9223`, kill stale tunnel |
| Connection drops after idle | SSH timeout | Add `-o ServerAliveInterval=60` to the ssh command |

## Server services

| Service | Port | Description |
|---|---|---|
| Vite dev server | 3000 | 3D workspace UI |
| busybox httpd | 8000 | Static file serving |
| PTY relay | 8091 | Terminal WebSocket |
| Voice relay | 8092 | Voice → LLM → tools |
| Server Chromium | 9222 | Server-side browser (headless) |
| User browser tunnel | 9223 | SSH reverse tunnel to user's browser |
