# ADR 005: Client-side voice I/O — STT and TTS in the browser

## Status

Accepted

## Context

The initial voice pipeline (commits `b0b9e09`–`f27a38d`) routed all audio through the server:

```
Browser mic → PCM over WS → server → Deepgram WS → transcript
transcript → LLM → response text
response text → ElevenLabs REST → MP3 chunks over WS → browser speakers
```

This created a large class of bugs that proved difficult to fix:

1. **Deepgram connection lifecycle.** The server opens a new WebSocket to Deepgram on each `voice_start`, buffers audio while the connection handshakes, drains final transcripts on `voice_stop` with timeout fallbacks. The state machine (`idle→listening→processing→speaking`) has race conditions at every transition — audio arriving before the WS opens, `voice_stop` before any audio sends, late-arriving transcripts after close. The uncommitted rewrite in `server/deepgram.ts` and `server/voice-relay.ts` was a second attempt to get this right.

2. **Added latency on a real-time path.** Every PCM chunk (4096 samples × 2 bytes = 8KB, ~60 times per second) takes an extra network hop through the server before reaching Deepgram. At ~256kbps, this is meaningful bandwidth on the server, and the added latency degrades Deepgram's endpointing and VAD — the timing assumptions that drive "is the user done speaking?" are calibrated for direct connections, not proxied ones.

3. **Endpointing appeared broken.** The user reported Deepgram "cutting off after a word or two" and not allowing continued speech. We raised endpointing from 300ms to 800ms and utterance_end_ms to 1500ms, but the root issue is that latency jitter from the proxy hop makes any endpointing threshold unreliable.

4. **TTS audio round-trip.** ElevenLabs streams MP3 chunks back to the server, which base64-encodes them and sends them over the client WebSocket. The browser then decodes, concatenates, and plays them via `new Audio()`. This works but adds latency to first byte of speech and wastes server bandwidth on audio pass-through.

Meanwhile, ADR 004 established the server as authoritative for agent runtime, PTY sessions, CDP, filesystem, and LLM calls. Audio capture and playback are browser-native capabilities — the mic and speakers are on the client. The server has no reason to touch the audio stream.

## Decision

STT and TTS move to the browser. The server's voice endpoint becomes a text-in/text-out LLM bridge.

New data flow:

```
Browser mic → Deepgram WS (browser connects directly) → transcript
transcript text → server WS → LLM → response text → server WS
response text → ElevenLabs (browser fetches directly) → browser speakers
```

The voice client (`src/voice-client.ts`) manages:
- Direct WebSocket to `wss://api.deepgram.com/v1/listen` with the user's API key
- Mic capture and PCM streaming to Deepgram (already implemented, just retarget)
- Transcript accumulation and push-to-talk state machine
- Text exchange with the server for LLM processing
- Direct fetch to ElevenLabs streaming TTS endpoint, or the ElevenLabs WebSocket API
- Audio playback (already implemented)

The server (`server/voice-relay.ts`) simplifies to:
- Receive `{ type: 'text', text }` messages
- Call Claude via the exe.dev gateway
- Return `{ type: 'response', text }` messages
- Manage conversation history and system prompt (todo file context)
- Handle todo file updates

`server/deepgram.ts` is deleted. `server/elevenlabs.ts` is deleted. The server has no audio dependencies.

API keys for Deepgram and ElevenLabs are stored in the browser (the client is a personal tool, not a multi-tenant service). The server needs no third-party API keys — only the exe.dev LLM gateway, which requires no key.

## Consequences

1. **Eliminates the audio proxy bug class entirely.** No server-side Deepgram connection management, no audio buffering races, no drain timeouts. The browser talks to Deepgram with the same direct connection that Deepgram's own SDK assumes.

2. **Lower latency.** Audio reaches Deepgram in one hop instead of two. TTS audio plays back without a server round-trip. First-word and first-byte latencies both improve.

3. **Simpler server.** `voice-relay.ts` drops from 512 lines to ~150. Two entire modules (`deepgram.ts`, `elevenlabs.ts`) are removed from the server. Server dependencies shrink.

4. **More complex client.** `voice-client.ts` grows to handle Deepgram and ElevenLabs connections directly. This is the right trade-off — the client already manages the mic and audio playback; adding the STT/TTS connection is natural.

5. **API keys in the browser.** Acceptable for a personal tool. If multi-tenancy ever matters, the server can issue short-lived Deepgram tokens via their `/v1/keys` API.

6. **Consistent with ADR 004.** The server owns intelligence (LLM, agent logic, tools). The browser owns peripherals (mic, speakers, display). Audio is a peripheral concern.
