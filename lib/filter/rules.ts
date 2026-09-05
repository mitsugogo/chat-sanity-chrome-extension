import type { ConfigurableCategory } from '../types';

export interface RuleMatch {
  category: ConfigurableCategory;
  score: number;
  reason: string;
}

interface CategoryRule {
  category: ConfigurableCategory;
  patterns: Array<{ expression: RegExp; score: number; reason: string }>;
}

const RULES: CategoryRule[] = [
  {
    category: 'abuse',
    patterns: [
      {
        expression: /(死ね|しね|消えろ|無能|下手すぎ|きもい|うざい)/u,
        score: 0.98,
        reason: '攻撃的な表現',
      },
      {
        expression: /(馬鹿|バカ|アホ|クズ|カス)(だ|すぎ|じゃん|でしょ)?/u,
        score: 0.88,
        reason: '侮辱表現',
      },
    ],
  },
  {
    category: 'instruction',
    patterns: [
      {
        expression:
          /(行け|いけ|やれ|しろ|するな|戻れ|急げ)(よ|って)?[!！。]?$/u,
        score: 0.9,
        reason: '命令口調',
      },
      {
        expression: /(した|やった|行った|戻った)方がいい/u,
        score: 0.72,
        reason: '行動を指示する表現',
      },
      {
        expression: /(やめた|やめる|止めた|止める)方がいい/u,
        score: 0.85,
        reason: '行動を制止する表現',
      },
      {
        expression: /(なんで|どうして).{0,16}(しない|やらない|行かない)/u,
        score: 0.68,
        reason: '行動を責める表現',
      },
      {
        expression: /(そこじゃない|違うって|早くして)/u,
        score: 0.82,
        reason: '強い行動誘導',
      },
    ],
  },
  {
    category: 'pigeon',
    patterns: [
      {
        expression:
          /(視点|配信|枠)(では|だと|で).{0,24}(言ってた|見つけた|やってる|終わってる)/u,
        score: 0.88,
        reason: '別視点の情報を持ち込む表現',
      },
      {
        expression: /(.{1,12})(が|は)もう.{0,20}(してる|終わった|見つけた)/u,
        score: 0.66,
        reason: '他配信者の進行情報らしき表現',
      },
    ],
  },
  {
    category: 'comparison',
    patterns: [
      {
        expression: /(.{1,12})より(.{1,12})の方が/u,
        score: 0.78,
        reason: '比較を煽る表現',
      },
      {
        expression: /(.{1,12})のせい(だ|じゃん|で)/u,
        score: 0.9,
        reason: '責任を押し付ける表現',
      },
      {
        expression: /(誰|どっち|あいつ).{0,12}(悪い|戦犯)/u,
        score: 0.88,
        reason: '対立や責任追及を促す表現',
      },
    ],
  },
  {
    category: 'concern',
    patterns: [
      {
        expression: /(大丈夫|平気)[?？]{1,}/u,
        score: 0.48,
        reason: '過度な心配の可能性',
      },
      {
        expression: /(炎上|荒れ)(しそう|るぞ|ない)/u,
        score: 0.78,
        reason: '炎上への過度な懸念',
      },
      {
        expression:
          /(これ|それ).{0,8}(まずくない|危なくない|やばくない)[?？]?/u,
        score: 0.62,
        reason: '杞憂的な表現',
      },
      {
        expression: /(最近|前は).{0,20}(してくれない|良かった)/u,
        score: 0.64,
        reason: '過去との比較を含むお気持ち表現',
      },
    ],
  },
  {
    category: 'spoiler',
    patterns: [
      {
        expression: /(このあと|次に|犯人は|正体は|ラスボスは)/u,
        score: 0.9,
        reason: '先の展開を示す表現',
      },
      {
        expression: /(ネタバレ|答え)(だけど|すると|は)/u,
        score: 0.96,
        reason: 'ネタバレを明示する表現',
      },
    ],
  },
];

export function matchRules(text: string): RuleMatch[] {
  const matches: RuleMatch[] = [];
  for (const rule of RULES) {
    for (const pattern of rule.patterns) {
      if (pattern.expression.test(text)) {
        matches.push({
          category: rule.category,
          score: pattern.score,
          reason: pattern.reason,
        });
      }
    }
  }
  return matches;
}
