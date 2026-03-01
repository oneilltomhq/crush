# Crush — self-hosted setup

Run Crush on your own VPS with your own browser.

## Prerequisites

- **Node.js 20+** (for server processes and build)
- **Chrome/Chromium** (for the extension and CDP browser automation)
- A VPS or local machine with a desktop environment (or headless Chrome via Xvfb)

## API keys

You need three API keys:

| Service | Purpose | Get one at |
|---|---|---|
| Anthropic | LLM (Claude) | https://console.anthropic.com |
| Deepgram | Speech-to-text | https://console.deepgram.com |
| ElevenLabs | Text-to-speech | https://elevenlabs.io |

Copy `.env.example` to `.env` and fill in your keys:

```bash
cp .env.example .env
# edit .env with your keys
```

## Install

```bash
npm install
npm run build
```

## Start the servers

Crush has four server processes. Run each in its own terminal (or use tmux):

```bash
# Load environment
set -a; source .env; set +a

# 1. PTY relay — gives shell panes real bash sessions
npx tsx server/pty-relay.ts          # ws://localhost:8091

# 2. CDP relay — proxies Chrome DevTools Protocol for browser panes
npx tsx server/cdp-relay.ts          # ws://localhost:8090

# 3. Voice relay — LLM bridge with tool use
npx tsx server/voice-relay.ts        # ws://localhost:8092

# 4. Vite dev server — serves the extension UI
npm run dev                          # http://localhost:3000
```

Or start them all in tmux:

```bash
set -a; source .env; set +a
tmux new-session -d -s ptyrelay  'npx tsx server/pty-relay.ts'
tmux new-session -d -s cdprelay  'npx tsx server/cdp-relay.ts'
tmux new-session -d -s voice     'npx tsx server/voice-relay.ts'
tmux new-session -d -s vite      'npm run dev'
```

## Start Chrome with CDP

The browser panes and browse tool need a Chrome instance with remote debugging enabled:

```bash
# Linux
google-chrome --remote-debugging-port=9222 &

# macOS
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222 &

# Headless (server/CI)
google-chrome --headless --remote-debugging-port=9222 &
```

## Load the extension

1. Open `chrome://extensions` in the Chrome instance
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** → select the Crush project root (the dir with `manifest.json`)
4. Click the Crush icon in the toolbar → side panel opens

For development, the side panel loads from Vite at `localhost:3000`, so you get hot reload.

For production, run `npm run build` first — the extension serves from `dist/`.

## Architecture overview

```
┌─────────────────────────────────────────────┐
│  Chrome                                     │
│  ┌──────────────────────────────────────┐    │
│  │  Side Panel (3D workspace)           │    │
│  │  - Three.js WebGPU renderer          │    │
│  │  - Voice client (Deepgram + 11Labs)  │    │
│  │  - Ghostty WASM terminal emulation   │    │
│  └──────────┬───────────────────────────┘    │
│             │ WebSocket                      │
└─────────────┼───────────────────────────────┘
              │
   ┌──────────┴──────────────┐
   │  Server processes       │
   │  - pty-relay   :8091    │ ← real bash via node-pty
   │  - cdp-relay   :8090    │ ← Chrome DevTools Protocol
   │  - voice-relay :8092    │ ← Claude tool-use loop
   │  - vite        :3000    │ ← dev server (proxies WS)
   └─────────────────────────┘
```

## Troubleshooting

**"Missing required env var"** — You forgot to source `.env` before starting servers.

**No voice** — Check that Deepgram and ElevenLabs keys are valid. The browser needs microphone permission for the side panel origin.

**Browser panes blank** — Make sure Chrome is running with `--remote-debugging-port=9222` and the CDP relay can reach it.

**WASM errors** — Run `npm install` again; `ghostty-web` includes the WASM binary as an npm package.
