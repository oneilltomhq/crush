/**
 * Voice client — browser-side STT (Deepgram) + TTS (ElevenLabs)
 *
 * The browser owns audio I/O and talks directly to STT/TTS providers.
 * The server is a pure text-in/text-out LLM bridge.
 *
 * Flow:
 *   mic → Deepgram WS (direct) → transcript
 *   transcript → server WS → LLM → response text
 *   response text → ElevenLabs (direct) → speakers
 *
 * See ADR 005.
 */

// ---------------------------------------------------------------------------
// Server WS URL (for LLM text exchange only)
// ---------------------------------------------------------------------------

function defaultTextWsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws/voice`;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VoiceClientOptions {
  /** Server WebSocket URL for LLM text exchange */
  wsUrl?: string;
  /** Deepgram API key (stored in browser) */
  deepgramApiKey?: string;
  /** ElevenLabs API key (stored in browser) */
  elevenlabsApiKey?: string;
  /** ElevenLabs voice ID */
  elevenlabsVoiceId?: string;

  onTranscript?: (text: string, isFinal: boolean) => void;
  onResponse?: (text: string) => void;
  onThinking?: () => void;
  onSpeaking?: (playing: boolean) => void;
  onError?: (message: string) => void;
  onConnected?: (connected: boolean) => void;
}

type ServerMessage = {
  type: 'response'; text: string;
} | {
  type: 'thinking';
} | {
  type: 'error'; message: string;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEEPGRAM_WS_URL = 'wss://api.deepgram.com/v1/listen';
const ELEVENLABS_TTS_URL = 'https://api.elevenlabs.io/v1/text-to-speech';
const ELEVENLABS_VOICE_CHARLIE = 'IKne3meq5aSn9XLyUdCD';

// Deepgram streaming params — tuned for conversational push-to-talk
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

  // Server WS (text only)
  private ws: WebSocket | null = null;
  private wsUrl: string;
  private reconnectTimer: number | null = null;

  // Deepgram STT (browser → Deepgram direct)
  private dgWs: WebSocket | null = null;
  private utteranceBuffer = '';

  // Mic capture
  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private scriptProcessor: ScriptProcessorNode | null = null;
  private _isRecording = false;
  private micReady = false;  // mic acquired, reused across presses

  // TTS playback
  private _isPlaying = false;
  private abortTTS: AbortController | null = null;

  constructor(opts: VoiceClientOptions = {}) {
    this.opts = opts;
    this.wsUrl = opts.wsUrl ?? defaultTextWsUrl();
  }

  // =========================================================================
  // Server connection (text LLM bridge)
  // =========================================================================

  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this.ws = new WebSocket(this.wsUrl);

    this.ws.onopen = () => {
      console.log('[voice] Server connected');
      this.opts.onConnected?.(true);
      if (this.reconnectTimer !== null) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
    };

    this.ws.onmessage = (event) => {
      try {
        const msg: ServerMessage = JSON.parse(event.data);
        this.handleServerMessage(msg);
      } catch (e) {
        console.error('[voice] Server parse error:', e);
      }
    };

    this.ws.onclose = () => {
      console.log('[voice] Server disconnected');
      this.opts.onConnected?.(false);
      this.reconnectTimer = window.setTimeout(() => this.connect(), 3000);
    };

    this.ws.onerror = (err) => {
      console.error('[voice] Server WS error:', err);
    };
  }

  disconnect(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    this.teardownMic();
    this.opts.onConnected?.(false);
  }

  // =========================================================================
  // Mic capture — reuse across presses, no teardown/recreation
  // =========================================================================

  private async ensureMic(): Promise<void> {
    if (this.micReady && this.audioContext && this.mediaStream) return;

    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: 16000,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });

    this.audioContext = new AudioContext({ sampleRate: 16000 });
    const source = this.audioContext.createMediaStreamSource(this.mediaStream);

    // ScriptProcessor (deprecated but universal). Captures PCM 16-bit LE.
    this.scriptProcessor = this.audioContext.createScriptProcessor(4096, 1, 1);
    this.scriptProcessor.onaudioprocess = (e: AudioProcessingEvent) => {
      if (!this._isRecording || !this.dgWs || this.dgWs.readyState !== WebSocket.OPEN) return;
      const float32 = e.inputBuffer.getChannelData(0);
      const int16 = new Int16Array(float32.length);
      for (let i = 0; i < float32.length; i++) {
        const s = Math.max(-1, Math.min(1, float32[i]));
        int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }
      // Send raw binary PCM directly to Deepgram (no base64!)
      this.dgWs.send(int16.buffer);
    };

    source.connect(this.scriptProcessor);
    this.scriptProcessor.connect(this.audioContext.destination);
    this.micReady = true;
    console.log('[voice] Mic ready');
  }

  private teardownMic(): void {
    this.micReady = false;
    this._isRecording = false;
    if (this.scriptProcessor) { this.scriptProcessor.disconnect(); this.scriptProcessor = null; }
    if (this.mediaStream) { this.mediaStream.getTracks().forEach(t => t.stop()); this.mediaStream = null; }
    if (this.audioContext) { this.audioContext.close(); this.audioContext = null; }
  }

  // =========================================================================
  // Deepgram STT — direct browser WebSocket
  // =========================================================================

  private openDeepgram(): void {
    this.closeDeepgram();
    this.utteranceBuffer = '';

    const apiKey = this.opts.deepgramApiKey;
    if (!apiKey) {
      this.opts.onError?.('No Deepgram API key configured');
      return;
    }

    const params = new URLSearchParams(DEEPGRAM_PARAMS);
    const url = `${DEEPGRAM_WS_URL}?${params}`;

    this.dgWs = new WebSocket(url, ['token', apiKey]);

    this.dgWs.onopen = () => {
      console.log('[voice] Deepgram connected');
    };

    this.dgWs.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
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
          // Deepgram signals utterance boundary
          this.opts.onTranscript?.('', true);
        } else if (msg.type === 'Error') {
          console.error('[voice] Deepgram error:', msg.description || msg.message);
          this.opts.onError?.(`STT: ${msg.description || msg.message}`);
        }
      } catch (e) {
        console.error('[voice] Deepgram parse error:', e);
      }
    };

    this.dgWs.onerror = (err) => {
      console.error('[voice] Deepgram WS error:', err);
    };

    this.dgWs.onclose = (ev) => {
      console.log(`[voice] Deepgram closed (code=${ev.code})`);
      this.dgWs = null;
    };
  }

  private closeDeepgram(): void {
    if (!this.dgWs) return;
    const ws = this.dgWs;
    this.dgWs = null;
    if (ws.readyState === WebSocket.OPEN) {
      // Deepgram protocol: send CloseStream, then close
      ws.send(JSON.stringify({ type: 'CloseStream' }));
      // Give it a moment to process final results, then close
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close();
        }
      }, 500);
    } else if (ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
  }

  // =========================================================================
  // Push-to-talk: startRecording / stopRecording
  // =========================================================================

  async startRecording(): Promise<void> {
    if (this._isRecording) return;

    try {
      await this.ensureMic();
      this.openDeepgram();
      this._isRecording = true;
      console.log('[voice] Recording started');
    } catch (err) {
      console.error('[voice] Start error:', err);
      this.opts.onError?.(`Mic error: ${err}`);
    }
  }

  stopRecording(): void {
    if (!this._isRecording) return;
    this._isRecording = false;
    console.log('[voice] Recording stopped');

    // Drain: wait a beat for final Deepgram transcripts, then close and send to LLM
    const dg = this.dgWs;
    if (dg && dg.readyState === WebSocket.OPEN) {
      // Send CloseStream and wait for final results
      dg.send(JSON.stringify({ type: 'CloseStream' }));
      this.dgWs = null;  // prevent more audio sends

      // Listen for remaining results until close
      const origOnMessage = dg.onmessage;
      const drainTimeout = setTimeout(() => {
        console.log('[voice] Drain timeout, sending what we have');
        dg.close();
        this.finishUtterance();
      }, 3000);

      dg.onclose = () => {
        clearTimeout(drainTimeout);
        this.finishUtterance();
      };
    } else {
      this.closeDeepgram();
      this.finishUtterance();
    }
  }

  private finishUtterance(): void {
    const text = this.utteranceBuffer.trim();
    this.utteranceBuffer = '';
    if (text) {
      console.log(`[voice] Utterance: "${text}"`);
      this.sendTextToServer(text);
    } else {
      console.log('[voice] No speech detected');
    }
  }

  // =========================================================================
  // Server text exchange
  // =========================================================================

  sendText(text: string): void {
    this.sendTextToServer(text);
  }

  private sendTextToServer(text: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'text', text }));
    } else {
      this.opts.onError?.('Not connected to server');
    }
  }

  private handleServerMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case 'response':
        this.opts.onResponse?.(msg.text);
        // Fire TTS directly from the browser
        if (msg.text) this.speakTTS(msg.text);
        break;

      case 'thinking':
        this.opts.onThinking?.();
        break;

      case 'error':
        console.error('[voice] Server error:', msg.message);
        this.opts.onError?.(msg.message);
        break;
    }
  }

  // =========================================================================
  // ElevenLabs TTS — direct browser fetch
  // =========================================================================

  private async speakTTS(text: string): Promise<void> {
    const apiKey = this.opts.elevenlabsApiKey;
    if (!apiKey) {
      // No TTS key — silent mode, just show text
      return;
    }

    // Abort any in-flight TTS
    this.abortTTS?.abort();
    this.abortTTS = new AbortController();

    const voiceId = this.opts.elevenlabsVoiceId ?? ELEVENLABS_VOICE_CHARLIE;
    const url = `${ELEVENLABS_TTS_URL}/${voiceId}/stream`;

    this._isPlaying = true;
    this.opts.onSpeaking?.(true);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'xi-api-key': apiKey,
        },
        body: JSON.stringify({
          text,
          model_id: 'eleven_turbo_v2_5',
          output_format: 'mp3_44100_128',
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
            style: 0,
          },
        }),
        signal: this.abortTTS.signal,
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`TTS ${response.status}: ${errText}`);
      }

      // Read the full stream into a blob and play it
      const reader = response.body?.getReader();
      if (!reader) throw new Error('No TTS response body');

      const chunks: ArrayBuffer[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value.buffer as ArrayBuffer);
      }

      const blob = new Blob(chunks, { type: 'audio/mpeg' });
      const audioUrl = URL.createObjectURL(blob);
      const audio = new Audio(audioUrl);

      await new Promise<void>((resolve, reject) => {
        audio.onended = () => { URL.revokeObjectURL(audioUrl); resolve(); };
        audio.onerror = () => { URL.revokeObjectURL(audioUrl); reject(new Error('Playback error')); };
        audio.play().catch(reject);
      });
    } catch (err: any) {
      if (err.name === 'AbortError') {
        // Interrupted by new TTS or disconnect — not an error
      } else {
        console.error('[voice] TTS error:', err.message);
        this.opts.onError?.(`TTS: ${err.message}`);
      }
    } finally {
      this._isPlaying = false;
      this.opts.onSpeaking?.(false);
    }
  }

  // =========================================================================
  // Public state
  // =========================================================================

  get isRecording(): boolean { return this._isRecording; }
  get isPlaying(): boolean { return this._isPlaying; }
  get isConnected(): boolean { return this.ws != null && this.ws.readyState === WebSocket.OPEN; }
}
