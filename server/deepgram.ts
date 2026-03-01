/**
 * Deepgram Streaming STT (Speech-to-Text)
 *
 * Opens a WebSocket to Deepgram's nova-3 model, streams PCM audio,
 * and emits transcript events as results come back.
 *
 * Audio format: PCM 16-bit LE, 16kHz, mono (linear16)
 */

import WebSocket from 'ws';

const DEEPGRAM_WS_URL = 'wss://api.deepgram.com/v1/listen';

const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || 'REDACTED_DEEPGRAM_KEY';

export interface TranscriptEvent {
  /** The transcribed text */
  text: string;
  /** Whether this is a final (committed) transcript vs. interim */
  isFinal: boolean;
  /** Confidence score 0-1 */
  confidence: number;
  /** Whether Deepgram considers this the end of an utterance (user stopped speaking) */
  speechFinal: boolean;
}

export interface DeepgramStreamOptions {
  apiKey?: string;
  model?: string;
  language?: string;
  encoding?: string;
  sampleRate?: number;
  channels?: number;
  interimResults?: boolean;
  utteranceEndMs?: number;
  vadEvents?: boolean;
  endpointing?: number;
  punctuate?: boolean;
  smartFormat?: boolean;
}

export interface DeepgramStream {
  /** Send raw PCM audio data to Deepgram */
  sendAudio(audio: Buffer): void;
  /** Gracefully close the Deepgram stream */
  close(): void;
  /** Whether the WebSocket is connected and ready */
  readonly connected: boolean;

  onTranscript: ((event: TranscriptEvent) => void) | null;
  onError: ((err: Error) => void) | null;
  onClose: (() => void) | null;
  onOpen: (() => void) | null;
}

/**
 * Create a streaming STT session with Deepgram.
 * Returns a handle to send audio and receive transcript events.
 */
export function createDeepgramStream(opts: DeepgramStreamOptions = {}): DeepgramStream {
  const apiKey = opts.apiKey ?? DEEPGRAM_API_KEY;

  const params = new URLSearchParams({
    model: opts.model ?? 'nova-3',
    language: opts.language ?? 'en',
    encoding: opts.encoding ?? 'linear16',
    sample_rate: String(opts.sampleRate ?? 16000),
    channels: String(opts.channels ?? 1),
    interim_results: String(opts.interimResults ?? true),
    utterance_end_ms: String(opts.utteranceEndMs ?? 1000),
    vad_events: String(opts.vadEvents ?? true),
    endpointing: String(opts.endpointing ?? 300),
    punctuate: String(opts.punctuate ?? true),
    smart_format: String(opts.smartFormat ?? true),
  });

  const url = `${DEEPGRAM_WS_URL}?${params}`;
  const ws = new WebSocket(url, {
    headers: { Authorization: `Token ${apiKey}` },
  });

  let isOpen = false;

  const stream: DeepgramStream = {
    onTranscript: null,
    onError: null,
    onClose: null,
    onOpen: null,

    sendAudio(audio: Buffer) {
      if (isOpen && ws.readyState === WebSocket.OPEN) {
        ws.send(audio);
      }
    },

    close() {
      if (ws.readyState === WebSocket.OPEN) {
        // Deepgram protocol: send CloseStream before closing
        ws.send(JSON.stringify({ type: 'CloseStream' }));
        setTimeout(() => {
          if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
            ws.close();
          }
        }, 500);
      }
    },

    get connected() {
      return isOpen;
    },
  };

  ws.on('open', () => {
    isOpen = true;
    console.log('[deepgram] Connected');
    stream.onOpen?.();
  });

  ws.on('message', (data: WebSocket.Data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === 'Results') {
        const alt = msg.channel?.alternatives?.[0];
        if (alt && alt.transcript) {
          stream.onTranscript?.({
            text: alt.transcript,
            isFinal: msg.is_final ?? false,
            confidence: alt.confidence ?? 0,
            speechFinal: msg.speech_final ?? false,
          });
        }
      } else if (msg.type === 'UtteranceEnd') {
        // Deepgram signals that the user stopped speaking
        stream.onTranscript?.({
          text: '',
          isFinal: true,
          confidence: 1,
          speechFinal: true,
        });
      } else if (msg.type === 'Error') {
        console.error('[deepgram] Server error:', msg.description || msg.message);
        stream.onError?.(new Error(msg.description || msg.message || 'Deepgram error'));
      }
    } catch (err) {
      console.error('[deepgram] Failed to parse message:', err);
    }
  });

  ws.on('error', (err: Error) => {
    console.error('[deepgram] WebSocket error:', err.message);
    stream.onError?.(err);
  });

  ws.on('close', (code: number, reason: Buffer) => {
    isOpen = false;
    console.log(`[deepgram] Closed (code=${code}, reason=${reason?.toString() || 'none'})`);
    stream.onClose?.();
  });

  return stream;
}
