import { describe, expect, it } from 'vitest';
import { DebugHistoryStore } from '../lib/debug-history';
import type { DiagnosticEntry } from '../lib/types';

const entry = (id: string): DiagnosticEntry => ({
  id,
  text: `comment-${id}`,
  category: 'backseat',
  score: 0.75,
  action: 'blur',
  reasons: ['命令口調'],
  source: 'rules',
  timestamp: Number(id),
});

describe('DebugHistoryStore', () => {
  it('新しい順に最大200件だけ保持する', () => {
    const store = new DebugHistoryStore();
    for (let index = 0; index < 205; index++) {
      store.add(1, 2, entry(String(index)));
    }
    expect(store.list()).toHaveLength(200);
    expect(store.list()[0]?.id).toBe('204');
    expect(store.list().at(-1)?.id).toBe('5');
  });

  it('フレーム・タブ単位または全体を消去する', () => {
    const store = new DebugHistoryStore();
    store.add(1, 1, entry('1'));
    store.add(1, 2, entry('2'));
    store.add(2, 1, entry('3'));
    store.removeFrame(1, 1);
    expect(store.list().map(({ id }) => id)).toEqual(['3', '2']);
    store.removeTab(1);
    expect(store.list().map(({ id }) => id)).toEqual(['3']);
    store.clear();
    expect(store.list()).toEqual([]);
  });

  it('同じコメントの遅延結果で履歴を更新し表示許可なら除去する', () => {
    const store = new DebugHistoryStore();
    store.add(1, 1, entry('same'));
    store.add(1, 1, { ...entry('same'), action: 'hide', score: 0.9 });
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]?.action).toBe('hide');
    store.add(1, 1, { ...entry('same'), action: 'allow', score: 0.1 });
    expect(store.list()).toEqual([]);
  });
});
