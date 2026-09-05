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
  it('自分の投稿は0.00で許可する', () => {
    const result = createFilterEngine()(
      createMessage('死ね', {
        isSelf: true,
        authorExternalChannelId: 'UC-self',
      }),
      settings(),
    );
    expect(result).toMatchObject({
      score: 0,
      action: 'allow',
      ruleDisposition: 'explicit-safe',
    });
    expect(result.reasons).toContain('自分の投稿');
  });

  it('ホワイトリストのユーザーは0.00で許可する', () => {
    const value = settings();
    value.whitelistedUsers = [
      { channelId: 'UC-friend', displayName: 'friend', addedAt: 1 },
    ];
    const result = createFilterEngine()(
      createMessage('死ね', { authorExternalChannelId: 'UC-friend' }),
      value,
    );
    expect(result).toMatchObject({
      score: 0,
      action: 'allow',
      ruleDisposition: 'explicit-safe',
    });
    expect(result.reasons).toContain('ホワイトリストのユーザー');
  });

  it('非表示ユーザーは本文に関係なく非表示にする', () => {
    const value = settings();
    value.hiddenUsers = [
      { channelId: 'UC-bad', displayName: '常習くん', addedAt: 1 },
    ];
    const result = createFilterEngine()(
      createMessage('こんにちは', { authorExternalChannelId: 'UC-bad' }),
      value,
    );
    expect(result).toMatchObject({
      score: 0.95,
      action: 'hide',
      categories: ['hidden_user'],
      needsAi: false,
    });
  });

  it('同一セッションの繰り返し加点で非表示側へ倒す', () => {
    const result = createFilterEngine()(
      createMessage('回復した方がいい'),
      settings(),
      null,
      { sessionBoost: 0.6 },
    );
    expect(result.score).toBeGreaterThanOrEqual(0.9);
    expect(result.action).toBe('hide');
    expect(
      result.reasons.some((reason) => reason.includes('同一セッション')),
    ).toBe(true);
  });

  it('配信者とモデレーターを常に許可する', () => {
    const evaluate = createFilterEngine();
    expect(
      evaluate(createMessage('死ね', { isOwner: true }), settings()),
    ).toMatchObject({ action: 'allow', ruleDisposition: 'excluded' });
    expect(
      evaluate(createMessage('死ね', { isModerator: true }), settings()),
    ).toMatchObject({ action: 'allow', ruleDisposition: 'excluded' });
  });

  it('許可語句をブロック語句より優先する', () => {
    const value = settings();
    value.allowedWords = ['これはネタです'];
    value.blockedWords = ['死ね'];
    expect(evaluate(createMessage('これはネタです 死ね'), value).action).toBe(
      'allow',
    );
    expect(
      evaluate(createMessage('これはネタです 死ね'), value).ruleDisposition,
    ).toBe('explicit-safe');

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
    expect(result.ruleDisposition).toBe('matched');
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

  it('メンバーシップスタンプだけの投稿は0.00で許可する', () => {
    const value = settings();
    value.blockedWords = ['しろ'];
    value.lmStudio.enabled = true;
    const result = createFilterEngine()(
      createMessage(':しろ:', { isStampOnly: true }),
      value,
    );
    expect(result).toMatchObject({
      score: 0,
      action: 'allow',
      categories: ['safe'],
      ruleDisposition: 'explicit-safe',
      needsAi: false,
    });
    expect(result.reasons).toContain('メンバーシップスタンプのみ');
  });

  it('日本語カスタム絵文字だけの投稿は明らかなリアクションとして許可する', () => {
    const result = createFilterEngine()(
      createMessage(':みこ草: :あくあ泣き:'),
      settings(),
    );
    expect(result).toMatchObject({
      score: 0,
      action: 'allow',
      categories: ['safe'],
      ruleDisposition: 'explicit-safe',
      needsAi: false,
    });
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
      ruleDisposition: 'unmatched',
    });
  });

  it('婉曲的な催促を0点のルール未一致として区別する', () => {
    expect(
      createFilterEngine()(createMessage('さっさと進んだら？'), settings()),
    ).toMatchObject({
      score: 0,
      action: 'allow',
      needsAi: false,
      ruleDisposition: 'unmatched',
    });
  });

  it.each([
    'いけー！ ',
    'いけいけー！',
    'いけええええ',
    '急げー！',
    '行けー！',
    '優勝いけー！',
    '世界一まで行けー！',
  ])('前向きな目標への応援「%s」を明示安全として扱う', (text) => {
    expect(createFilterEngine()(createMessage(text), settings())).toMatchObject(
      {
        score: 0,
        action: 'allow',
        ruleDisposition: 'explicit-safe',
      },
    );
  });

  it.each(['○○だしねぇ', '○○だしね'])(
    '理由・同意だけの「%s」を0点のまま許可する',
    (text) => {
      expect(
        createFilterEngine()(createMessage(text), settings()),
      ).toMatchObject({
        score: 0,
        action: 'allow',
        ruleDisposition: 'unmatched',
      });
    },
  );

  it.each(['急げ', '早く急げー！'])(
    '単独掛け声ではない催促「%s」は安全扱いへ逃がさない',
    (text) => {
      expect(
        createFilterEngine()(createMessage(text), settings()).ruleDisposition,
      ).toBe('matched');
    },
  );

  it.each([
    '休憩したら？',
    '一回戻ったら？',
    'そろそろ休んでもいいかも',
    'これ使えば？',
  ])('弱い監査シグナル「%s」だけでは表示を変えない', (text) => {
    expect(createFilterEngine()(createMessage(text), settings()).action).toBe(
      'allow',
    );
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
