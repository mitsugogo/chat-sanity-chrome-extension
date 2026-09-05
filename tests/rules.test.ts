import { describe, expect, it } from 'vitest';
import { normalizeText } from '../lib/filter/normalize';
import { matchRules } from '../lib/filter/rules';

const matchesFor = (text: string) => matchRules(normalizeText(text));
const categoriesFor = (text: string) =>
  matchesFor(text).map((match) => match.category);

describe('日本語チャットルール', () => {
  it.each([
    ['みこちは説明が下手なんだ', 'personal_attack'],
    ['頭悪いな', 'personal_attack'],
    ['リーダー仕事しろｗ', 'backseat'],
    ['しっかりしろリーダー', 'backseat'],
    ['少しは一緒に行動しろよ', 'backseat'],
    ['○○のせいだろ', 'blame'],
    ['みこちをリーダーにするのが悪い', 'blame'],
    ['○○ならもっと上手くやる', 'comparison'],
    ['△△の方がリーダー向いてる', 'comparison'],
    ['○○に行け', 'backseat'],
    ['指示厨黙ってくれ', 'meta_conflict'],
    ['コメ欄治安悪いな', 'meta_conflict'],
    ['テンポ悪い', 'complaint'],
    ['別枠でボスを見つけたらしい', 'pigeon'],
    ['ネタバレだけど犯人は彼です', 'spoiler'],
  ] as const)('「%s」を%sとして検出する', (text, category) => {
    expect(categoriesFor(text)).toContain(category);
  });

  it.each([
    'ししろんｗ',
    'おもしろいｗ',
    'さっきもそうだった',
    '帰れるかな？',
    'いけるいける',
    'クソ鳥か？ｗ',
    '指示ナイス',
    '何してんのｗｗｗ',
    'どうしたら？',
    'それ好きなの？',
    'このあとどうする？',
    'ゲーム内の敵がもう終わった',
    '答え合わせ楽しみ',
    'カスタム楽しみ',
    'バカンスに行きたい',
    '鳩行為はやめましょう',
    '死ねとか言わないで',
    '「死ね」って言わないで',
    'みんな仲良くしよう',
    '指示コメやめよう',
    '学校に行けるかな',
  ])('文脈のない一般的な表現「%s」を断定的に検出しない', (text) => {
    expect(categoriesFor(text)).toEqual([]);
  });

  it('曖昧な比較・助言・展開示唆はAI判定の対象にできるスコアにする', () => {
    const scores = [
      ...matchesFor('太郎さんより花子さんの方が上手い'),
      ...matchesFor('回復した方がいいかも'),
      ...matchesFor('このあとボスが出てくる'),
    ].map((match) => match.score);

    expect(scores).toEqual(expect.arrayContaining([0.68, 0.42, 0.72]));
    expect(scores.every((score) => score >= 0.35 && score <= 0.8)).toBe(true);
  });

  it('引用した攻撃語を注意する文は攻撃として扱わない', () => {
    expect(categoriesFor('暴言の「死ね」は言わないで')).toEqual([]);
  });
});
