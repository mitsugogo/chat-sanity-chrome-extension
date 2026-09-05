import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  classifyWithLmStudio,
  listModels,
  validateLocalEndpoint,
} from '../lib/lm-studio';

afterEach(() => {
  vi.unstubAllGlobals();
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
