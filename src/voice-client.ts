/**
 * Voice client — mic capture → WebSocket → server → TTS playback.
 *
 * Push-to-talk interface for the voice relay server.
 * Captures PCM 16-bit LE, 16kHz, mono audio from the mic,
 * streams it to the voice relay, and plays back TTS audio.
 */

const VOICE_WS_URL_DEFAULT = 'ws://localhost:8092';

// --- Protocol types ---

export interface VoiceClientOptions {
  wsUrl?: string;
  onTranscript?: (text: string, isFinal: boolean) => void;
  onResponse?: (text: string) => void;
  onThinking?: () => void;
  onSpeaking?: (playing: boolean) => void;
  onError?: (message: string) => void;
  onConnected?: (connected: boolean) => void;
}

type ServerMessage = {
  type: 'transcript'; text: string; isFinal: boolean;
} | {
  type: 'response'; text: string;
} | {
  type: 'thinking';
} | {
  type: 'tts_start';
} | {
  type: 'audio'; data: string;
} | {
  type: 'audio_end';
} | {
  type: 'error'; message: string;
};

export class VoiceClient {
  private ws: WebSocket | null = null;
  private wsUrl: string;
  private reconnectTimer: number | null = null;
  private opts: VoiceClientOptions;

  // Mic capture state
  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private scriptProcessor: ScriptProcessorNode | null = null;
  private _isRecording = false;

  // TTS playback state
  private audioQueue: string[] = [];  // base64 mp3 chunks
  private _isPlaying = false;

  constructor(opts: VoiceClientOptions = {}) {
    this.opts = opts;
    this.wsUrl = opts.wsUrl ?? VOICE_WS_URL_DEFAULT;
  }

  // --- Public API ---

  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this.ws = new WebSocket(this.wsUrl);

    this.ws.onopen = () => {
      console.log('[voice-client] Connected');
      this.opts.onConnected?.(true);
      if (this.reconnectTimer !== null) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
    };

    this.ws.onmessage = (event) => {
      try {
        const msg: ServerMessage = JSON.parse(event.data);
        this.handleMessage(msg);
      } catch (e) {
        console.error('[voice-client] Parse error:', e);
      }
    };

    this.ws.onclose = () => {
      console.log('[voice-client] Disconnected');
      this.opts.onConnected?.(false);
      this.reconnectTimer = window.setTimeout(() => this.connect(), 3000);
    };

    this.ws.onerror = (err) => {
      console.error('[voice-client] WebSocket error:', err);
    };
  }

  disconnect(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onclose = null;  // prevent reconnect
      this.ws.close();
      this.ws = null;
    }
    this.opts.onConnected?.(false);
  }

  async startRecording(): Promise<void> {
    if (this._isRecording) return;

    try {
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

      // Use ScriptProcessorNode (deprecated but universally supported)
      // AudioWorklet would be better but requires a separate file
      this.scriptProcessor = this.audioContext.createScriptProcessor(4096, 1, 1);

      this.scriptProcessor.onaudioprocess = (e: AudioProcessingEvent) => {
        if (!this._isRecording) return;
        const float32 = e.inputBuffer.getChannelData(0);
        const int16 = new Int16Array(float32.length);
        for (let i = 0; i < float32.length; i++) {
          const s = Math.max(-1, Math.min(1, float32[i]));
          int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        const bytes = new Uint8Array(int16.buffer);
        this.send({ type: 'audio', data: this.bufferToBase64(bytes) });
      };

      source.connect(this.scriptProcessor);
      this.scriptProcessor.connect(this.audioContext.destination);

      this._isRecording = true;
      this.send({ type: 'voice_start' });
      console.log('[voice-client] Recording started');
    } catch (err) {
      console.error('[voice-client] Mic error:', err);
      this.opts.onError?.(`Microphone error: ${err}`);
    }
  }

  stopRecording(): void {
    if (!this._isRecording) return;
    this._isRecording = false;

    if (this.scriptProcessor) {
      this.scriptProcessor.disconnect();
      this.scriptProcessor = null;
    }
    if (this.workletNode) {
      this.workletNode.disconnect();
      this.workletNode = null;
    }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(t => t.stop());
      this.mediaStream = null;
    }
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }

    this.send({ type: 'voice_stop' });
    console.log('[voice-client] Recording stopped');
  }

  sendText(text: string): void {
    this.send({ type: 'text', text });
  }

  get isRecording(): boolean { return this._isRecording; }
  get isPlaying(): boolean { return this._isPlaying; }
  get isConnected(): boolean { return this.ws != null && this.ws.readyState === WebSocket.OPEN; }

  // --- Message handling ---

  private handleMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case 'transcript':
        this.opts.onTranscript?.(msg.text, msg.isFinal);
        break;

      case 'response':
        this.opts.onResponse?.(msg.text);
        break;

      case 'thinking':
        this.opts.onThinking?.();
        break;

      case 'tts_start':
        this.audioQueue = [];
        break;

      case 'audio':
        this.audioQueue.push(msg.data);
        if (!this._isPlaying) this.playAudioQueue();
        break;

      case 'audio_end':
        // Audio queue will drain naturally
        break;

      case 'error':
        console.error('[voice-client] Server error:', msg.message);
        this.opts.onError?.(msg.message);
        break;
    }
  }

  // --- TTS playback ---

  private async playAudioQueue(): Promise<void> {
    if (this.audioQueue.length === 0) {
      this._isPlaying = false;
      this.opts.onSpeaking?.(false);
      return;
    }

    this._isPlaying = true;
    this.opts.onSpeaking?.(true);

    // Batch all available chunks (give a moment for more to arrive)
    await new Promise(r => setTimeout(r, 150));
    const chunks = this.audioQueue.splice(0);

    const binaryChunks = chunks.map(b64 => {
      const raw = atob(b64);
      const arr = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
      return arr;
    });

    const totalLen = binaryChunks.reduce((s, c) => s + c.length, 0);
    const combined = new Uint8Array(totalLen);
    let offset = 0;
    for (const chunk of binaryChunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }

    const blob = new Blob([combined], { type: 'audio/mpeg' });
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);

    audio.onended = () => {
      URL.revokeObjectURL(url);
      if (this.audioQueue.length > 0) {
        this.playAudioQueue();
      } else {
        this._isPlaying = false;
        this.opts.onSpeaking?.(false);
      }
    };

    audio.onerror = () => {
      URL.revokeObjectURL(url);
      this._isPlaying = false;
      this.opts.onSpeaking?.(false);
    };

    try {
      await audio.play();
    } catch (e) {
      console.error('[voice-client] Playback failed:', e);
      this._isPlaying = false;
      this.opts.onSpeaking?.(false);
    }
  }

  // --- Helpers ---

  private send(msg: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private bufferToBase64(bytes: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }
}
