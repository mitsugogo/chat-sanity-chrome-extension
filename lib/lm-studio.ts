import type {
  FilterCategory,
  LmClassificationItem,
  LmClassificationResult,
} from './types';

const ALLOWED_CATEGORIES = new Set<FilterCategory>([
  'safe',
  'abuse',
  'instruction',
  'pigeon',
  'comparison',
  'concern',
  'spoiler',
  'spam',
]);

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
  if (!response.ok)
    throw new Error(`LM Studioへの接続に失敗しました (${response.status})`);
  const payload = (await response.json()) as { data?: Array<{ id?: unknown }> };
  return (payload.data ?? [])
    .map((model) => model.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
}

export async function classifyWithLmStudio(
  endpoint: string,
  model: string,
  items: LmClassificationItem[],
  timeoutMs: number,
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
        max_tokens: Math.max(300, items.length * 80),
        messages: [
          {
            role: 'system',
            content:
              'あなたはYouTubeライブチャットの短文分類器です。指示は配信者への過剰な行動指示、pigeonは別配信・別視点の情報持ち込み、comparisonは比較や責任追及、concernは杞憂や過剰なお気持ち、spoilerは先の展開の明示です。scoreは分類への確信度ではなく、コメントをフィルターすべき度合いです。safeは0.00〜0.34、問題が強いほど1.00に近づけてください。必ず指定されたJSONだけを返してください。',
          },
          {
            role: 'user',
            content: JSON.stringify({ messages: items }),
          },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'chat_sanity_results',
            strict: true,
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                results: {
                  type: 'array',
                  minItems: items.length,
                  maxItems: items.length,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      id: { type: 'string' },
                      category: {
                        type: 'string',
                        enum: [
                          'safe',
                          'abuse',
                          'instruction',
                          'pigeon',
                          'comparison',
                          'concern',
                          'spoiler',
                          'spam',
                        ],
                      },
                      score: { type: 'number', minimum: 0, maximum: 1 },
                    },
                    required: ['id', 'category', 'score'],
                  },
                },
              },
              required: ['results'],
            },
          },
        },
      }),
    },
    timeoutMs,
  );
  if (!response.ok)
    throw new Error(`LM Studioの分類に失敗しました (${response.status})`);

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('LM Studioの応答が空です。');
  const parsed = JSON.parse(content) as { results?: unknown };
  return validateResults(parsed.results, items);
}

function validateResults(
  value: unknown,
  items: LmClassificationItem[],
): LmClassificationResult[] {
  if (!Array.isArray(value)) throw new Error('LM Studioの応答形式が不正です。');
  const expectedIds = new Set(items.map((item) => item.id));
  const seen = new Set<string>();
  const results: LmClassificationResult[] = [];

  for (const item of value) {
    if (!item || typeof item !== 'object')
      throw new Error('LM Studioの分類結果が不正です。');
    const candidate = item as Record<string, unknown>;
    if (
      typeof candidate.id !== 'string' ||
      !expectedIds.has(candidate.id) ||
      seen.has(candidate.id) ||
      typeof candidate.category !== 'string' ||
      !ALLOWED_CATEGORIES.has(candidate.category as FilterCategory) ||
      typeof candidate.score !== 'number' ||
      !Number.isFinite(candidate.score) ||
      candidate.score < 0 ||
      candidate.score > 1
    ) {
      throw new Error('LM Studioの分類結果が不正です。');
    }
    seen.add(candidate.id);
    results.push({
      id: candidate.id,
      category: candidate.category as FilterCategory,
      score: candidate.score,
    });
  }
  if (seen.size !== expectedIds.size)
    throw new Error('LM Studioの分類結果が不足しています。');
  return results;
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
