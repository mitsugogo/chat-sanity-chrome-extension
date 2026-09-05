import { describe, expect, it } from 'vitest';
import { actionForScore, createFilterEngine } from '../lib/filter/engine';
import { DEFAULT_SETTINGS } from '../lib/settings';
import type { ChatMessage, SettingsV1 } from '../lib/types';

const createMessage = (
  text: string,
  patch: Partial<ChatMessage> = {},
): ChatMessage => ({
  id: 'message-1',
  author: 'viewer',
  text,
  isOwner: false,
  isModerator: false,
  isMember: false,
  isPaidMessage: false,
  timestamp: 1_000,
  ...patch,
});

const settings = (): SettingsV1 => structuredClone(DEFAULT_SETTINGS);

describe('actionForScore', () => {
  const thresholds = { dim: 0.5, blur: 0.75, hide: 0.9 };

  it.each([
    [0.49, 'allow'],
    [0.5, 'dim'],
    [0.75, 'blur'],
    [0.9, 'hide'],
  ] as const)('%sを%sへ変換する', (score, action) => {
    expect(actionForScore(score, thresholds)).toBe(action);
  });
});

describe('filter engine', () => {
  it('配信者とモデレーターを常に許可する', () => {
    const evaluate = createFilterEngine();
    expect(
      evaluate(createMessage('死ね', { isOwner: true }), settings()).action,
    ).toBe('allow');
    expect(
      evaluate(createMessage('死ね', { isModerator: true }), settings()).action,
    ).toBe('allow');
  });

  it('許可語句をブロック語句より優先する', () => {
    const value = settings();
    value.allowedWords = ['これはネタです'];
    value.blockedWords = ['死ね'];
    expect(evaluate(createMessage('これはネタです 死ね'), value).action).toBe(
      'allow',
    );

    function evaluate(message: ChatMessage, current: SettingsV1) {
      return createFilterEngine()(message, current);
    }
  });

  it('ブロック語句を即時非表示にする', () => {
    const value = settings();
    value.blockedWords = ['独自NG'];
    const result = createFilterEngine()(
      createMessage('これは独自ＮＧです'),
      value,
    );
    expect(result).toMatchObject({ score: 1, action: 'hide', needsAi: false });
  });

  it('箱ゲープリセットで曖昧な指示をAI対象にする', () => {
    const value = settings();
    value.lmStudio.enabled = true;
    const result = createFilterEngine()(
      createMessage('そっちに行った方がいい'),
      value,
    );
    expect(result.categories).toContain('instruction');
    expect(result.needsAi).toBe(true);
  });

  it('制止を促す表現をぼかし対象の指示として判定する', () => {
    const result = createFilterEngine()(
      createMessage('君は間違ってるからやめた方がいい'),
      settings(),
    );
    expect(result).toMatchObject({ score: 0.85, action: 'blur' });
    expect(result.categories).toContain('instruction');
  });

  it('同一ユーザーの同文連投をスパム判定する', () => {
    const evaluate = createFilterEngine();
    const value = settings();
    evaluate(createMessage('ないす', { timestamp: 1_000 }), value);
    evaluate(createMessage('ないす', { id: '2', timestamp: 1_500 }), value);
    const result = evaluate(
      createMessage('ないす', { id: '3', timestamp: 2_000 }),
      value,
    );
    expect(result.categories).toContain('spam');
    expect(result.action).toBe('hide');
  });
});
