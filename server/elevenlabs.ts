/**
 * ElevenLabs Streaming TTS (Text-to-Speech)
 *
 * Converts text to speech via ElevenLabs' streaming REST API.
 * Supports both full-buffer and streaming-chunk modes.
 *
 * Default: eleven_turbo_v2_5 model, mp3_44100_128 output, "charlie" voice.
 */

const ELEVENLABS_API_URL = 'https://api.elevenlabs.io';

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || 'REDACTED_ELEVENLABS_KEY';

/** Pre-configured voice IDs */
export const VOICES = {
  rachel: '21m00Tcm4TlvDq8ikWAM',
  drew: '29vD33N1CtxCmqQRPOHJ',
  clyde: '2EiwWnXFnvU5JabPnv8n',
  dave: 'CYw3kZ02Hs0563khs1Fj',
  dorothy: 'ThT5KcBeYPX3keUQqHPh',
  charlie: 'IKne3meq5aSn9XLyUdCD',
  james: 'ZQe5CZNOzWyzPSCn5a3c',
  aria: '9BWtsMINqrJLrRacOk9x',
  sarah: 'EXAVITQu4vr4xnSDxMaL',
} as const;

export type VoiceName = keyof typeof VOICES;

export interface TTSOptions {
  apiKey?: string;
  voiceId?: string;
  modelId?: string;
  outputFormat?: string;
  stability?: number;
  similarityBoost?: number;
  style?: number;
}

/**
 * Convert text to speech, returning the full audio as a Buffer.
 */
export async function textToSpeech(text: string, opts: TTSOptions = {}): Promise<Buffer> {
  const apiKey = opts.apiKey ?? ELEVENLABS_API_KEY;
  const voiceId = opts.voiceId ?? VOICES.charlie;
  const url = `${ELEVENLABS_API_URL}/v1/text-to-speech/${voiceId}/stream`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'xi-api-key': apiKey,
    },
    body: JSON.stringify({
      text,
      model_id: opts.modelId ?? 'eleven_turbo_v2_5',
      output_format: opts.outputFormat ?? 'mp3_44100_128',
      voice_settings: {
        stability: opts.stability ?? 0.5,
        similarity_boost: opts.similarityBoost ?? 0.75,
        style: opts.style ?? 0,
      },
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`ElevenLabs TTS error ${response.status}: ${errText}`);
  }

  const chunks: Uint8Array[] = [];
  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response body from ElevenLabs');

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  return Buffer.concat(chunks);
}

/**
 * Stream TTS audio in chunks, calling onChunk for each piece as it arrives.
 * Much lower time-to-first-byte than waiting for the full audio.
 */
export async function textToSpeechStream(
  text: string,
  opts: TTSOptions,
  onChunk: (chunk: Buffer) => void,
): Promise<void> {
  const apiKey = opts.apiKey ?? ELEVENLABS_API_KEY;
  const voiceId = opts.voiceId ?? VOICES.charlie;
  const url = `${ELEVENLABS_API_URL}/v1/text-to-speech/${voiceId}/stream`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'xi-api-key': apiKey,
    },
    body: JSON.stringify({
      text,
      model_id: opts.modelId ?? 'eleven_turbo_v2_5',
      output_format: opts.outputFormat ?? 'mp3_44100_128',
      voice_settings: {
        stability: opts.stability ?? 0.5,
        similarity_boost: opts.similarityBoost ?? 0.75,
        style: opts.style ?? 0,
      },
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`ElevenLabs TTS error ${response.status}: ${errText}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response body from ElevenLabs');

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    onChunk(Buffer.from(value));
  }
}
