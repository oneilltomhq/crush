/**
 * Voice client — conversational mode with browser-side STT/TTS.
 *
 * Toggle model: click mic once to start conversation, click again to stop.
 * After TTS finishes, automatically resumes listening.
 *
 * State machine:  idle → listening → processing → speaking → listening → ...
 *                                                           ↘ idle (if toggled off)
 *
 * Browser connects directly to Deepgram (STT and TTS).
 * Server is a pure text-in/text-out LLM bridge. See ADR 005.
 */

// ---------------------------------------------------------------------------
// Server WS URL
// ---------------------------------------------------------------------------

function defaultTextWsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws/voice`;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VoiceState = 'idle' | 'listening' | 'processing' | 'speaking';

export interface VoiceClientOptions {
  wsUrl?: string;
  deepgramApiKey?: string;
  deepgramTtsModel?: string;

  onTranscript?: (text: string, isFinal: boolean) => void;
  onResponse?: (text: string) => void;
  onStateChange?: (state: VoiceState) => void;
  onError?: (message: string) => void;
  onConnected?: (connected: boolean) => void;
  onCommand?: (command: { name: string; input: Record<string, unknown> }) => void;
  onInit?: (data: { todo?: string; voiceCredentials?: { deepgramApiKey?: string } }) => void;
}

type ServerMessage =
  | { type: 'response'; text: string }
  | { type: 'thinking' }
  | { type: 'error'; message: string }
  | { type: 'command'; name: string; input: Record<string, unknown> }
  | { type: 'init'; todo?: string; voiceCredentials?: { deepgramApiKey?: string } };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEEPGRAM_WS_URL = 'wss://api.deepgram.com/v1/listen';
const DEEPGRAM_TTS_URL = 'https://api.deepgram.com/v1/speak';
const DEEPGRAM_TTS_MODEL = 'aura-asteria-en';

const DEEPGRAM_PARAMS: Record<string, string> = {
  model: 'nova-3',
  language: 'en',
  encoding: 'linear16',
  sample_rate: '16000',
  channels: '1',
  interim_results: 'true',
  utterance_end_ms: '1500',
  vad_events: 'true',
  endpointing: '800',
  punctuate: 'true',
  smart_format: 'true',
};

// ---------------------------------------------------------------------------
// VoiceClient
// ---------------------------------------------------------------------------

export class VoiceClient {
  private opts: VoiceClientOptions;
  private _state: VoiceState = 'idle';
  private _conversationActive = false;  // toggle: is conversation mode on?

  // Server WS
  private ws: WebSocket | null = null;
  private wsUrl: string;
  private reconnectTimer: number | null = null;

  // Deepgram STT
  private dgWs: WebSocket | null = null;
  private utteranceBuffer = '';

  // Mic (persistent across utterances)
  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private scriptProcessor: ScriptProcessorNode | null = null;
  private micReady = false;

  // TTS
  private abortTTS: AbortController | null = null;
  private currentAudio: HTMLAudioElement | null = null;

  constructor(opts: VoiceClientOptions = {}) {
    this.opts = opts;
    this.wsUrl = opts.wsUrl ?? defaultTextWsUrl();
  }

  /** Set voice credentials (received from server). */
  setCredentials(deepgramApiKey?: string): void {
    if (deepgramApiKey) this.opts.deepgramApiKey = deepgramApiKey;
  }

  // =========================================================================
  // State machine
  // =========================================================================

  private setState(s: VoiceState): void {
    if (this._state === s) return;
    console.log(`[voice] ${this._state} → ${s}`);
    this._state = s;
    this.opts.onStateChange?.(s);
  }

  get state(): VoiceState { return this._state; }
  get conversationActive(): boolean { return this._conversationActive; }

  // =========================================================================
  // Server connection
  // =========================================================================

  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;

    this.ws = new WebSocket(this.wsUrl);

    this.ws.onopen = () => {
      console.log('[voice] Server connected');
      this.opts.onConnected?.(true);
      if (this.reconnectTimer !== null) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    };

    this.ws.onmessage = (ev) => {
      try { this.handleServerMessage(JSON.parse(ev.data)); }
      catch (e) { console.error('[voice] Parse error:', e); }
    };

    this.ws.onclose = () => {
      console.log('[voice] Server disconnected');
      this.opts.onConnected?.(false);
      this.reconnectTimer = window.setTimeout(() => this.connect(), 3000);
    };

    this.ws.onerror = (err) => console.error('[voice] Server WS error:', err);
  }

  disconnect(): void {
    this.stopConversation();
    if (this.reconnectTimer !== null) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.ws) { this.ws.onclose = null; this.ws.close(); this.ws = null; }
    this.opts.onConnected?.(false);
  }

  // =========================================================================
  // Public API: toggle conversation
  // =========================================================================

  /** Toggle conversation mode on/off. */
  toggleConversation(): void {
    if (this._conversationActive) {
      this.stopConversation();
    } else {
      this.startConversation();
    }
  }

  async startConversation(): Promise<void> {
    if (this._conversationActive) return;
    this._conversationActive = true;
    try {
      await this.ensureMic();
      this.startListening();
    } catch (err) {
      console.error('[voice] Mic error:', err);
      this.opts.onError?.(`Mic error: ${err}`);
      this._conversationActive = false;
    }
  }

  stopConversation(): void {
    this._conversationActive = false;
    this.cancelTTS();
    this.closeDeepgram();
    this.teardownMic();
    this.setState('idle');
  }

  /** Tell server to initiate conversation (agent speaks first). */
  sendStartSignal(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: 'start' }));
    this.setState('processing');
  }

  /** Send text directly (skip STT). */
  sendText(text: string): void {
    if (this._state === 'processing' || this._state === 'speaking') {
      this.opts.onError?.('Wait for the current response to finish');
      return;
    }
    this.sendToServer(text);
  }

  // Legacy API compat for grid-scene
  async startRecording(): Promise<void> { await this.startConversation(); }
  stopRecording(): void {
    // In conversational mode, stopRecording is a no-op during listening.
    // The toggle model handles start/stop. But if called externally
    // (mouseup from old push-to-talk code), just ignore.
  }
  get isRecording(): boolean { return this._state === 'listening'; }
  get isPlaying(): boolean { return this._state === 'speaking'; }
  get isConnected(): boolean { return this.ws != null && this.ws.readyState === WebSocket.OPEN; }

  // =========================================================================
  // Mic capture — persistent across utterances
  // =========================================================================

  private async ensureMic(): Promise<void> {
    if (this.micReady && this.audioContext && this.mediaStream) return;

    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, sampleRate: 16000, echoCancellation: true, noiseSuppression: true },
    });

    this.audioContext = new AudioContext({ sampleRate: 16000 });
    const source = this.audioContext.createMediaStreamSource(this.mediaStream);

    this.scriptProcessor = this.audioContext.createScriptProcessor(4096, 1, 1);
    this.scriptProcessor.onaudioprocess = (e: AudioProcessingEvent) => {
      if (this._state !== 'listening' || !this.dgWs || this.dgWs.readyState !== WebSocket.OPEN) return;
      const float32 = e.inputBuffer.getChannelData(0);
      const int16 = new Int16Array(float32.length);
      for (let i = 0; i < float32.length; i++) {
        const s = Math.max(-1, Math.min(1, float32[i]));
        int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }
      this.dgWs!.send(int16.buffer);
    };

    source.connect(this.scriptProcessor);
    this.scriptProcessor.connect(this.audioContext.destination);
    this.micReady = true;
    console.log('[voice] Mic ready');
  }

  private teardownMic(): void {
    this.micReady = false;
    if (this.scriptProcessor) { this.scriptProcessor.disconnect(); this.scriptProcessor = null; }
    if (this.mediaStream) { this.mediaStream.getTracks().forEach(t => t.stop()); this.mediaStream = null; }
    if (this.audioContext) { this.audioContext.close(); this.audioContext = null; }
  }

  // =========================================================================
  // Deepgram STT — one connection per utterance
  // =========================================================================

  private startListening(): void {
    this.utteranceBuffer = '';
    this.openDeepgram();
    this.setState('listening');
  }

  private openDeepgram(): void {
    this.closeDeepgram();
    this.utteranceBuffer = '';

    const apiKey = this.opts.deepgramApiKey;
    if (!apiKey) { this.opts.onError?.('No Deepgram API key'); return; }

    const params = new URLSearchParams(DEEPGRAM_PARAMS);
    this.dgWs = new WebSocket(`${DEEPGRAM_WS_URL}?${params}`, ['token', apiKey]);

    this.dgWs.onopen = () => console.log('[voice] Deepgram connected');

    this.dgWs.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'Results') {
          const alt = msg.channel?.alternatives?.[0];
          if (alt?.transcript) {
            const isFinal = msg.is_final ?? false;
            this.opts.onTranscript?.(alt.transcript, isFinal);
            if (isFinal) {
              this.utteranceBuffer += (this.utteranceBuffer ? ' ' : '') + alt.transcript;
            }
          }
        } else if (msg.type === 'UtteranceEnd') {
          // Deepgram detected end of speech — finalize this utterance
          console.log('[voice] UtteranceEnd from Deepgram');
          this.finalizeUtterance();
        } else if (msg.type === 'Error') {
          console.error('[voice] Deepgram error:', msg.description || msg.message);
          this.opts.onError?.(`STT: ${msg.description || msg.message}`);
        }
      } catch (e) {
        console.error('[voice] Deepgram parse error:', e);
      }
    };

    this.dgWs.onerror = (err) => console.error('[voice] Deepgram WS error:', err);
    this.dgWs.onclose = (ev) => {
      console.log(`[voice] Deepgram closed (code=${ev.code})`);
      // If we're still in listening state and conversation is active,
      // this was an unexpected close — finalize what we have
      if (this._state === 'listening' && this.utteranceBuffer.trim()) {
        this.finalizeUtterance();
      }
    };
  }

  private closeDeepgram(): void {
    if (!this.dgWs) return;
    const ws = this.dgWs;
    this.dgWs = null;
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'CloseStream' }));
      setTimeout(() => { if (ws.readyState !== WebSocket.CLOSED) ws.close(); }, 500);
    } else if (ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
  }

  /**
   * Called when Deepgram signals UtteranceEnd (user stopped speaking).
   * Close the Deepgram connection and send accumulated text to the server.
   */
  private finalizeUtterance(): void {
    if (this._state !== 'listening') return;  // guard against double-fire

    const text = this.utteranceBuffer.trim();
    this.utteranceBuffer = '';
    this.closeDeepgram();

    if (text) {
      console.log(`[voice] Utterance: "${text}"`);
      this.sendToServer(text);
    } else {
      console.log('[voice] Empty utterance, resuming listening');
      // No speech detected — keep listening
      if (this._conversationActive) {
        this.startListening();
      } else {
        this.setState('idle');
      }
    }
  }

  // =========================================================================
  // Server text exchange
  // =========================================================================

  private sendToServer(text: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.opts.onError?.('Not connected to server');
      return;
    }
    this.setState('processing');
    this.ws.send(JSON.stringify({ type: 'text', text }));
  }

  private handleServerMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case 'thinking':
        // Already in 'processing' state
        break;

      case 'response':
        this.opts.onResponse?.(msg.text);
        if (msg.text && this.opts.deepgramApiKey) {
          this.speakTTS(msg.text);
        } else {
          // No TTS key — go straight back to listening or idle
          this.afterResponse();
        }
        break;

      case 'error':
        console.error('[voice] Server error:', msg.message);
        this.opts.onError?.(msg.message);
        this.afterResponse();
        break;

      case 'command':
        this.opts.onCommand?.(msg);
        break;

      case 'init':
        this.opts.onInit?.({
          todo: (msg as any).todo,
          voiceCredentials: (msg as any).voiceCredentials,
        });
        break;
    }
  }

  /** After a response is fully handled (TTS done or no TTS), decide next state. */
  private afterResponse(): void {
    if (this._conversationActive) {
      this.startListening();
    } else {
      this.setState('idle');
    }
  }

  // =========================================================================
  // Deepgram TTS
  // =========================================================================

  private cancelTTS(): void {
    this.abortTTS?.abort();
    this.abortTTS = null;
    if (this.currentAudio) {
      this.currentAudio.pause();
      this.currentAudio = null;
    }
  }

  private async speakTTS(text: string): Promise<void> {
    this.cancelTTS();
    this.setState('speaking');
    this.abortTTS = new AbortController();

    const model = this.opts.deepgramTtsModel ?? DEEPGRAM_TTS_MODEL;
    const apiKey = this.opts.deepgramApiKey!;

    try {
      const response = await fetch(`${DEEPGRAM_TTS_URL}?model=${model}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Token ${apiKey}`,
        },
        body: JSON.stringify({ text }),
        signal: this.abortTTS.signal,
      });

      if (!response.ok) {
        throw new Error(`TTS ${response.status}: ${await response.text()}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error('No TTS body');

      const chunks: ArrayBuffer[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value.buffer as ArrayBuffer);
      }

      const blob = new Blob(chunks, { type: 'audio/mpeg' });
      const audioUrl = URL.createObjectURL(blob);
      const audio = new Audio(audioUrl);
      this.currentAudio = audio;

      await new Promise<void>((resolve, reject) => {
        audio.onended = () => { URL.revokeObjectURL(audioUrl); resolve(); };
        audio.onerror = () => { URL.revokeObjectURL(audioUrl); reject(new Error('Playback error')); };
        audio.play().catch(reject);
      });
    } catch (err: any) {
      if (err.name === 'AbortError') return;  // cancelled, caller handles state
      console.error('[voice] TTS error:', err.message);
      this.opts.onError?.(`TTS: ${err.message}`);
    } finally {
      this.currentAudio = null;
      this.afterResponse();
    }
  }
}
