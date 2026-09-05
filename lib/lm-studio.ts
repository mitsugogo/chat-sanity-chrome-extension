import type {
  LmClassificationItem,
  LmClassificationResult,
  LmResponseFormat,
} from './types';
import {
  CLASSIFICATION_SYSTEM_PROMPT,
  createClassificationInput,
  createClassificationSchema,
} from './local-ai/prompt';
import { validateResults } from './local-ai/validation';

export function validateLocalEndpoint(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost')
  ) {
    throw new Error('LM Studioの接続先はlocalhostのみ指定できます。');
  }
  url.pathname = url.pathname.replace(/\/$/u, '');
  url.search = '';
  url.hash = '';
  return url;
}

export async function listModels(
  endpoint: string,
  timeoutMs = 2_000,
): Promise<string[]> {
  const base = validateLocalEndpoint(endpoint);
  const response = await fetchWithTimeout(
    new URL('/v1/models', base).toString(),
    { method: 'GET' },
    timeoutMs,
  );
  if (!response.ok) {
    throw new Error(`LM Studioへの接続に失敗しました (${response.status})`);
  }
  const payload = response.payload as { data?: Array<{ id?: unknown }> };
  return (payload.data ?? [])
    .map((model) => model.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
}

export async function classifyWithLmStudio(
  endpoint: string,
  model: string,
  items: LmClassificationItem[],
  timeoutMs: number,
  responseFormat: LmResponseFormat = 'json_schema',
  signal?: AbortSignal,
): Promise<LmClassificationResult[]> {
  if (!model) throw new Error('LM Studioのモデルが選択されていません。');
  if (items.length === 0 || items.length > 20) {
    throw new Error('分類バッチは1〜20件で送信してください。');
  }
  const base = validateLocalEndpoint(endpoint);
  const response = await fetchWithTimeout(
    new URL('/v1/chat/completions', base).toString(),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        temperature: 0,
        stream: false,
        reasoning_effort: 'none',
        max_tokens: Math.max(400, items.length * 100),
        messages: [
          { role: 'system', content: CLASSIFICATION_SYSTEM_PROMPT },
          { role: 'user', content: createClassificationInput(items) },
        ],
        ...(responseFormat === 'text'
          ? {}
          : {
              response_format:
                responseFormat === 'json_object'
                  ? { type: 'json_object' }
                  : {
                      type: 'json_schema',
                      json_schema: {
                        name: 'chat_sanity_results',
                        strict: true,
                        schema: createClassificationSchema(items.length),
                      },
                    },
            }),
      }),
    },
    timeoutMs,
    signal,
  );
  if (!response.ok) {
    throw new Error(`LM Studioの分類に失敗しました (${response.status})`);
  }
  const payload = response.payload as {
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('LM Studioの応答が空です。');
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('LM Studioの応答JSONを解析できません。');
  }
  if (!parsed || typeof parsed !== 'object' || !('results' in parsed)) {
    throw new Error('LM Studioの応答形式が不正です。');
  }
  return validateResults(
    (parsed as { results: unknown }).results,
    items,
    'LM Studio',
  );
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<{ ok: boolean; status: number; payload: unknown }> {
  const controller = new AbortController();
  const abort = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) abort();
  else externalSignal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    const payload: unknown = response.ok ? await response.json() : null;
    return { ok: response.ok, status: response.status, payload };
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', abort);
  }
}
