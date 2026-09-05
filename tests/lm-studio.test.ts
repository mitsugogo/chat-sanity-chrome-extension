import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  classifyWithLmStudio,
  listModels,
  validateLocalEndpoint,
} from '../lib/lm-studio';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('LM Studio client', () => {
  it('localhost以外の接続先を拒否する', () => {
    expect(() => validateLocalEndpoint('https://example.com')).toThrow(
      'localhost',
    );
    expect(validateLocalEndpoint('http://127.0.0.1:1234').origin).toBe(
      'http://127.0.0.1:1234',
    );
  });

  it('モデル一覧を取得する', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ data: [{ id: 'qwen3-8b' }] }), {
            status: 200,
          }),
      ),
    );
    await expect(listModels('http://localhost:1234')).resolves.toEqual([
      'qwen3-8b',
    ]);
  });

  it('構造化分類結果を検証する', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      results: [
                        { id: '1', category: 'instruction', score: 0.85 },
                      ],
                    }),
                  },
                },
              ],
            }),
            { status: 200 },
          ),
      ),
    );
    await expect(
      classifyWithLmStudio(
        'http://localhost:1234',
        'qwen3-8b',
        [{ id: '1', text: '行った方がいい' }],
        500,
      ),
    ).resolves.toEqual([{ id: '1', category: 'instruction', score: 0.85 }]);
  });

  it('新しいaction/confidence形式とカテゴリを検証する', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      results: [
                        {
                          id: '1',
                          category: 'backseat',
                          action: 'blur',
                          confidence: 0.86,
                        },
                      ],
                    }),
                  },
                },
              ],
            }),
          ),
      ),
    );
    await expect(
      classifyWithLmStudio(
        'http://localhost:1234',
        'qwen3-8b',
        [{ id: '1', text: 'ちゃんと指示して' }],
        500,
      ),
    ).resolves.toEqual([
      { id: '1', category: 'backseat', action: 'blur', confidence: 0.86 },
    ]);
  });

  it('不足した分類結果を拒否する', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [{ message: { content: '{"results":[]}' } }],
            }),
            { status: 200 },
          ),
      ),
    );
    await expect(
      classifyWithLmStudio(
        'http://localhost:1234',
        'qwen3-8b',
        [{ id: '1', text: 'test' }],
        500,
      ),
    ).rejects.toThrow('不足');
  });
});

describe('response compatibility', () => {
  it.each(['json_schema', 'json_object', 'text'] as const)(
    '%sで送信し本文と一時ID以外を送らない',
    async (format) => {
      const fetchMock = vi.fn<typeof fetch>(
        async () =>
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      results: [{ id: 'temp', category: 'safe', score: 0.1 }],
                    }),
                  },
                },
              ],
            }),
          ),
      );
      vi.stubGlobal('fetch', fetchMock);
      await classifyWithLmStudio(
        'http://localhost:1234',
        'local',
        [{ id: 'temp', text: 'ナイス' }],
        10000,
        format,
      );
      const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
      expect(JSON.parse(body.messages[1].content)).toEqual({
        messages: [
          {
            id: 'temp',
            text: 'ナイス',
            sameAuthorRecent: [],
            recentRiskyMessages: [],
            conflictLevel: 0,
          },
        ],
      });
      if (format === 'text') expect(body).not.toHaveProperty('response_format');
      else expect(body.response_format.type).toBe(format);
    },
  );
  it('互換形式でも不正JSONは受け入れない', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [{ message: { content: '分類結果です' } }],
            }),
          ),
      ),
    );
    await expect(
      classifyWithLmStudio(
        'http://localhost:1234',
        'local',
        [{ id: 'x', text: 'test' }],
        1000,
        'text',
      ),
    ).rejects.toThrow();
  });

  it('文脈を必要最小限に正規化し投稿者名やDOMを送らない', async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    results: [
                      {
                        id: 'temporary',
                        category: 'safe',
                        action: 'allow',
                        confidence: 0.1,
                      },
                    ],
                  }),
                },
              },
            ],
          }),
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    await classifyWithLmStudio(
      'http://localhost:1234',
      'local',
      [
        {
          id: 'temporary',
          text: ' し ろ よ ',
          sameAuthorRecent: ['前の攻撃', '二つ目', '三つ目', '四つ目'],
          recentRiskyMessages: ['一', '二', '三', '四'],
          conflictLevel: 1.4,
        },
      ],
      1000,
    );
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    const requestText = JSON.stringify(body);
    expect(requestText).not.toContain('viewer');
    expect(requestText).not.toContain('author-name');
    expect(requestText).not.toContain('<yt-');
    expect(JSON.parse(body.messages[1].content)).toEqual({
      messages: [
        {
          id: 'temporary',
          text: 'しろよ',
          sameAuthorRecent: ['二つ目', '三つ目', '四つ目'],
          recentRiskyMessages: ['二', '三', '四'],
          conflictLevel: 1,
        },
      ],
    });
  });
});

it('HTTPヘッダー受信後も本文が停止したらタイムアウトする', async () => {
  vi.useFakeTimers();
  const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
    expect(_input).toBe('http://localhost:1234/v1/chat/completions');
    const stream = new ReadableStream({
      start(controller) {
        init?.signal?.addEventListener('abort', () =>
          controller.error(new Error('body timeout')),
        );
      },
    });
    return new Response(stream);
  });
  vi.stubGlobal('fetch', fetchMock);
  const pending = classifyWithLmStudio(
    'http://localhost:1234',
    'local',
    [{ id: 'x', text: 'text' }],
    1000,
  );
  const assertion = expect(pending).rejects.toThrow('body timeout');
  await vi.advanceTimersByTimeAsync(1000);
  await assertion;
});
