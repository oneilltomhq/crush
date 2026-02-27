/**
 * Anthropic API client.
 *
 * Fetches from side panel, which has host permissions for api.anthropic.com.
 */

import { CrushAuthStorage } from './storage';

const API_VERSION = '2023-06-01';
const MODEL_NAME = 'claude-3-haiku-20240307'; // Fast and capable

let storage: CrushAuthStorage | null = null;
function getStorage() {
    if (!storage) {
        // Lazy initialization to avoid accessing localStorage in test environments
        storage = new CrushAuthStorage(localStorage);
    }
    return storage;
}

export async function getApiKey(): Promise<string | null> {
    return getStorage().getKey('anthropic');
}

export async function setApiKey(key: string): Promise<void> {
    return getStorage().setKey('anthropic', key);
}

export interface Message {
  role: 'user' | 'assistant';
  content: string;
}

export async function* streamCompletion(messages: Message[], systemPrompt: string, maxTokens = 4096) {
  const apiKey = await getApiKey();
  if (!apiKey) {
    throw new Error('Anthropic API key not set. Use `set-key anthropic <key>`');
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': API_VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL_NAME,
      messages,
      system: systemPrompt,
      max_tokens: maxTokens,
      stream: true,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Anthropic API error (${response.status}): ${errorBody}`);
  }

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop()!;

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const json = line.slice(6);
        const event = JSON.parse(json);
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          yield event.delta.text;
        }
      }
    }
  }
}
