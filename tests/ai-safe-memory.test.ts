import { describe, expect, it, vi } from 'vitest';
import {
  AI_SAFE_MEMORY_STORAGE_KEY,
  classifyWithSafeMemory,
  fingerprintText,
  PersistentAiSafeMemory,
  type SafeMemoryStorageArea,
} from '../lib/local-ai/safe-memory';
import type { LmClassificationItem } from '../lib/types';

class MemoryStorage implements SafeMemoryStorageArea {
  readonly values: Record<string, unknown> = {};

  async get(key: string): Promise<Record<string, unknown>> {
    return key in this.values
      ? { [key]: structuredClone(this.values[key]) }
      : {};
  }

  async set(items: Record<string, unknown>): Promise<void> {
    Object.assign(this.values, structuredClone(items));
  }
}

const fingerprint = async (text: string) => {
  let value = 2_166_136_261;
  for (const character of text) {
    value ^= character.codePointAt(0) ?? 0;
    value = Math.imul(value, 16_777_619);
  }
  return (value >>> 0).toString(16).padStart(8, '0').repeat(8);
};

const items: LmClassificationItem[] = [
  { id: 'safe-id', text: 'このゲームかわいいね' },
  { id: 'risk-id', text: '回復した方がいい' },
];

describe('PersistentAiSafeMemory', () => {
  it('正規化本文を標準のSHA-256へ変換する', async () => {
    await expect(fingerprintText('abc')).resolves.toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('本文を保存せずSHA-256形式の完全一致キーだけを配信間で再利用する', async () => {
    const storage = new MemoryStorage();
    const first = new PersistentAiSafeMemory(storage, fingerprint);

    await first.remember(
      'このゲームかわいいね',
      { id: 'safe-id', category: 'safe', action: 'allow', confidence: 0.97 },
      'lm-studio',
      10,
    );

    expect(JSON.stringify(storage.values)).not.toContain(
      'このゲームかわいいね',
    );
    expect(storage.values[AI_SAFE_MEMORY_STORAGE_KEY]).toEqual({
      version: 1,
      entries: [
        expect.objectContaining({
          fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
          providerId: 'lm-studio',
          action: 'allow',
          confidence: 0.97,
        }),
      ],
    });

    const nextStream = new PersistentAiSafeMemory(storage, fingerprint);
    await expect(
      nextStream.lookup('このゲームかわいいね'),
    ).resolves.toMatchObject({
      category: 'safe',
      action: 'allow',
      providerId: 'lm-studio',
      safeMemoryHit: true,
    });
    await expect(nextStream.lookup('このゲームかわいいよ')).resolves.toBeNull();
  });

  it('safe以外は保存せず、上限を超えると古い記憶から破棄する', async () => {
    const storage = new MemoryStorage();
    const memory = new PersistentAiSafeMemory(storage, fingerprint, 2);

    await expect(
      memory.remember(
        '危険判定',
        { id: 'risk', category: 'backseat', action: 'blur', confidence: 0.9 },
        'chrome-built-in',
      ),
    ).resolves.toBeNull();
    for (const [index, text] of ['一件目', '二件目', '三件目'].entries()) {
      await memory.remember(
        text,
        { id: String(index), category: 'safe', action: 'allow', confidence: 1 },
        'chrome-built-in',
        index,
      );
    }

    await expect(memory.lookup('一件目')).resolves.toBeNull();
    await expect(memory.lookup('二件目')).resolves.not.toBeNull();
    await expect(memory.lookup('三件目')).resolves.not.toBeNull();
  });

  it('記憶済みsafeをProviderへ送らず、未記憶本文だけ分類する', async () => {
    const storage = new MemoryStorage();
    const firstStream = new PersistentAiSafeMemory(storage, fingerprint);
    const classifyFirst = vi.fn(async (requested: LmClassificationItem[]) => ({
      providerId: 'lm-studio' as const,
      latencyMs: 25,
      results: requested.map((item) => ({
        id: item.id,
        category:
          item.id === 'safe-id' ? ('safe' as const) : ('backseat' as const),
        action: item.id === 'safe-id' ? ('allow' as const) : ('blur' as const),
        confidence: 0.95,
      })),
    }));

    await classifyWithSafeMemory(items, firstStream, classifyFirst);
    expect(classifyFirst).toHaveBeenCalledWith(items);

    const nextStream = new PersistentAiSafeMemory(storage, fingerprint);
    const classifyNext = vi.fn(async (requested: LmClassificationItem[]) => ({
      providerId: 'chrome-built-in' as const,
      latencyMs: 12,
      results: requested.map((item) => ({
        id: item.id,
        category: 'backseat' as const,
        action: 'blur' as const,
        confidence: 0.9,
      })),
    }));
    const result = await classifyWithSafeMemory(
      items,
      nextStream,
      classifyNext,
    );

    expect(classifyNext).toHaveBeenCalledWith([items[1]]);
    expect(result.results).toEqual([
      expect.objectContaining({
        id: 'safe-id',
        category: 'safe',
        safeMemoryHit: true,
        providerId: 'lm-studio',
      }),
      expect.objectContaining({
        id: 'risk-id',
        category: 'backseat',
        providerId: 'chrome-built-in',
      }),
    ]);
  });
});
