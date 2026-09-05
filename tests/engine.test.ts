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
    expect(result.categories).toContain('backseat');
    expect(result.needsAi).toBe(true);
  });

  it('制止を促す表現を低確信の指示候補として判定する', () => {
    const result = createFilterEngine()(
      createMessage('君は間違ってるからやめた方がいい'),
      settings(),
    );
    expect(result).toMatchObject({ score: 0.42, action: 'allow' });
    expect(result.categories).toContain('backseat');
  });

  it.each(['しろよ', 'はよ～～しろよ'])(
    '箱ゲープリセットで「%s」を強い指示として検出する',
    (text) => {
      const result = createFilterEngine()(createMessage(text), settings());

      expect(result.score).toBeGreaterThanOrEqual(0.82);
      expect(result.categories).toContain('backseat');
    },
  );

  it('コメント欄への注意はmeta_conflictを主カテゴリにする', () => {
    const result = createFilterEngine()(
      createMessage('指示厨黙ってくれ'),
      settings(),
    );
    expect(result.categories[0]).toBe('meta_conflict');
  });

  it.each([
    ['頭悪いな', 'personal_attack'],
    ['○○に任せればよかった', 'comparison'],
    ['やめてください', 'backseat'],
  ] as const)('prefilter後も「%s」を%sへ渡す', (text, category) => {
    expect(
      createFilterEngine()(createMessage(text), settings()).categories,
    ).toContain(category);
  });

  it('prefilter候補だけでは危険理由を確定しない', () => {
    const result = createFilterEngine()(
      createMessage('バカンスに行きたい'),
      settings(),
    );
    expect(result).toMatchObject({
      categories: ['safe'],
      action: 'allow',
      reasons: ['ルールに一致しませんでした'],
    });
  });

  it('同一ユーザーの同文連投をスパム判定する', () => {
    const evaluate = createFilterEngine();
    const value = settings();
    evaluate(createMessage('しっかりしろ', { timestamp: 1_000 }), value);
    evaluate(
      createMessage('しっかりしろ', { id: '2', timestamp: 1_500 }),
      value,
    );
    const result = evaluate(
      createMessage('しっかりしろ', { id: '3', timestamp: 2_000 }),
      value,
    );
    expect(result.categories).toContain('spam');
    expect(result.action).toBe('hide');
  });
});
