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

// Rules describe a phrase or a construction. A single substring such as
// 「しろ」「クソ」「バカ」 is deliberately never enough to trigger a rule.
const RULES: CategoryRule[] = [
  {
    category: 'personal_attack',
    patterns: [
      {
        expression:
          /(?:死ね|しね|消えろ|黙れ|黙ってくれ|無能|きもい|キモい|うざい|引退しろ)/u,
        score: 0.98,
        reason: '人格を攻撃する表現',
      },
      {
        expression:
          /(?:お前|こいつ|あいつ|[ぁ-んァ-ヶ一-龠A-Za-z0-9]{2,16}(?:さん|ちゃん|くん|氏)?)(?:は|が).{0,16}(?:下手|弱い|頭悪|向いてない|才能ない|雑魚|ゴミ)/u,
        score: 0.92,
        reason: '能力・人格を否定する表現',
      },
      {
        expression:
          /(?:説明|プレイ|操作|判断|戦い方|動き|頭|性格|人間性).{0,8}(?:下手(?:すぎ|過ぎ)?|頭悪|雑|ひどすぎ|酷すぎ|悪い|おかしい|終わってる)/u,
        score: 0.86,
        reason: '能力を攻撃する表現',
      },
      {
        expression:
          /(?:何回同じミス|やる気あ(?:る|んの)|効いてて草|効いてる|顔真っ赤|必死すぎ|信者乙|アンチ乙|お気持ち表明|イライラで草|そんなことも.{0,8}(?:できない|分からない|わからない))/u,
        score: 0.76,
        reason: '嘲笑・煽りの可能性',
      },
      {
        expression:
          /(?<![ぁ-んァ-ヶ一-龠])(?:馬鹿(?!正直)|バカ(?!ンス|正直)|アホ|クズ|カス|雑魚)(?![ぁ-んァ-ヶ一-龠])(?:だ|すぎ|じゃん|でしょ)?/u,
        score: 0.78,
        reason: '侮辱表現',
      },
    ],
  },
  {
    category: 'backseat',
    patterns: [
      {
        expression:
          /(?:ちゃんと|しっかり|早く|はよ|さっさと|今すぐ).{0,24}(?:しろ(?:よ)?|やれ(?:よ)?|行け|いけ|戻れ|急げ|見ろ|聞け|待て|使え|選べ|仕事しろ|指示しろ|読め)/u,
        score: 0.88,
        reason: '指示・催促の表現',
      },
      {
        expression:
          /(?:右|左|上|下|前|後ろ|そっち|あっち|一人ずつ|少しは|リーダー|みこち).{0,24}(?:行け|いけ|戻れ|見ろ|行って|一緒に行動しろ|指示しろ|仕事しろ)/u,
        score: 0.82,
        reason: '行動を具体的に指図する表現',
      },
      {
        expression:
          /[ぁ-んァ-ヶ一-龠A-Za-z0-9]{1,20}(?:に|へ)(?:行け(?!る)|いけ(?!る)|戻れ|行って)/u,
        score: 0.82,
        reason: '対象を指定して移動を指図する表現',
      },
      {
        expression:
          /(?:右|左|上|下|前|後ろ|そっち|あっち|一人ずつ|少しは|リーダー|みこち).{0,24}行った方が(?:いい|良い)/u,
        score: 0.68,
        reason: '行動を勧める表現',
      },
      {
        expression:
          /(?:マップ|回復|セーブ|装備|確認|リロード|交代|集中|練習|勉強|コメ|コメント).{0,10}(?:見て|見ろ|して|しなよ|しろ|読め|使え)/u,
        score: 0.74,
        reason: 'ゲーム進行への指示',
      },
      {
        expression:
          /(?:回復|マップ|セーブ|装備|確認|交代|行った|戻った|した|やった|使った|見た|読んだ|やめた|止めた)(?:ほう|方)が(?:いい|良い)|(?:回復|マップ|セーブ|装備).{0,8}したら[?？]?|(?:やめて|やめる|止めて).{0,8}(?:ください|ほしい)/u,
        score: 0.42,
        reason: '依頼・助言の文脈確認候補',
      },
      {
        expression:
          /(?:回復|移動|確認|マップ|コメ|コメント|一緒に|指示|説明).{0,10}(?:してください|してほしい|してね)/u,
        score: 0.52,
        reason: '丁寧な依頼による行動誘導候補',
      },
      {
        expression: /(?:しない|やらない|行かない|見ない|使わない)[のん]?[?？]/u,
        score: 0.42,
        reason: '行動を問いただす候補',
      },
      {
        expression:
          /(?:しろ|やれ|行け|いけ|戻れ|急げ|見ろ|聞け|待て|使え|選べ|読め|仕事しろ|指示しろ)よ?[!！。?？wｗ草笑〜～ー]*$/u,
        score: 0.9,
        reason: '命令口調',
      },
      {
        expression:
          /(?:指示|一緒に行動).{0,10}(?:しろ|して|してあげて)|(?:少しは|ちゃんと).{0,16}(?:しろよ|やれよ|見ろよ)/u,
        score: 0.86,
        reason: '強い指示・介入の表現',
      },
      {
        expression:
          /(?:なんで|どうして).{0,16}(?:しない|やらない|行かない|見ない)/u,
        score: 0.7,
        reason: '行動を責める表現',
      },
      {
        expression: /(?:そこじゃない|違うって|早くして)/u,
        score: 0.76,
        reason: '強い行動誘導',
      },
    ],
  },
  {
    category: 'blame',
    patterns: [
      {
        expression: /[^\s\r\n]{1,24}のせい(?:だ|だろ|じゃん|だよ|で|なんだ)?/u,
        score: 0.94,
        reason: '責任を特定人物へ押し付ける表現',
      },
      {
        expression:
          /[^\s\r\n]{1,24}をリーダーに(?:した|する)のが(?:悪い|ダメ)/u,
        score: 0.92,
        reason: '役割選択の責任を追及する表現',
      },
      {
        expression:
          /(?:リーダー|あの人|この人|お前|こいつ|あいつ).{0,16}(?:が悪い|のせい|戦犯)/u,
        score: 0.84,
        reason: '責任追及の可能性',
      },
      {
        expression:
          /(?:戦犯|足を引っ張(?:る|ってる)|責任取(?:れ|って)|誰が悪い|どっちが悪い)/u,
        score: 0.9,
        reason: '戦犯扱い・責任追及',
      },
    ],
  },
  {
    category: 'comparison',
    patterns: [
      {
        expression:
          /[^\s\r\n]{1,20}なら.{0,16}(?:もっと|上手く|うまく|できる|マシ)/u,
        score: 0.78,
        reason: '他者ならできると比較する表現',
      },
      {
        expression: /[^\s\r\n]{1,20}より[^\s\r\n]{1,20}(?:の方が|ほうが)/u,
        score: 0.68,
        reason: '他者との比較を煽る表現',
      },
      {
        expression:
          /[^\s\r\n]{1,20}(?:の方が|のほうが).{0,16}(?:向いてる|向いている|上手い|うまい|マシ|いい|良い)/u,
        score: 0.72,
        reason: '他者を持ち上げて比較する表現',
      },
      {
        expression:
          /[^\s\r\n]{1,20}(?:に任せれば|に任せた方が).{0,12}(?:よかった|良かった|いい|良い)/u,
        score: 0.76,
        reason: '担当者を比較・交代させる表現',
      },
    ],
  },
  {
    category: 'meta_conflict',
    patterns: [
      {
        expression:
          /(?:指示厨|自治厨|荒らし|指示コメ).{0,10}(?:黙れ|黙ってくれ|うざい|多すぎ|沸いて|帰れ|消えろ|無視しろ)/u,
        score: 0.9,
        reason: 'コメント欄の相手を攻撃する表現',
      },
      {
        expression:
          /(?:コメ欄|コメント欄).{0,16}(?:荒れてる|荒れてるな|治安悪い|うるさい|地獄|最悪)/u,
        score: 0.78,
        reason: 'コメント欄の荒れを話題にする表現',
      },
      {
        expression:
          /(?:ブロック推奨|通報推奨|無視しろ|無視推奨|自治すんな|仕切るな)/u,
        score: 0.74,
        reason: 'コメント欄の対処を煽る表現',
      },
      {
        expression:
          /(?:治安悪い|荒れてる|荒れてきた|喧嘩|雰囲気悪い).{0,8}(?:な|ね|わ|ぞ|ｗ|w|$)/u,
        score: 0.62,
        reason: 'チャットの対立状態を話題にする候補',
      },
    ],
  },
  {
    category: 'complaint',
    patterns: [
      {
        expression:
          /(?:この流れ|流れ|展開|進行).{0,8}(?:微妙|つまらない|だるい|ぐだぐだ|グダグダ)/u,
        score: 0.58,
        reason: '配信進行への不満',
      },
      {
        expression: /(?:テンポ|ペース).{0,8}(?:悪い|遅い|微妙)/u,
        score: 0.56,
        reason: '進行速度への不満',
      },
      {
        expression:
          /(?:ぐだってる|グダってる|カクカク|画質悪い|音小さい|音量小さい)/u,
        score: 0.52,
        reason: '配信状態への不満',
      },
      {
        expression:
          /(?:ぐだぐだ|グダグダ|gdgd|つまらん|つまらない|面白くない|おもんない|進まない|長すぎ|遅すぎ)/iu,
        score: 0.56,
        reason: '配信内容や進行への不満',
      },
      {
        expression:
          /(?:話|展開|流れ|進行|説明).{0,8}(?:長い|遅い|進まない|だるい|重い)/u,
        score: 0.54,
        reason: '進行や説明への不満',
      },
    ],
  },
  {
    // Kept for settings created before the semantic categories were added.
    category: 'pigeon',
    patterns: [
      {
        expression:
          /(?:他|別|[ぁ-んァ-ヶ一-龠]{2,12}(?:さん|ちゃん|くん|氏))?(?:の)?(?:視点|配信|枠)(?:では|だと|で).{0,24}(?:言ってた|見つけた|やってる|終わってる|始まった|来た)/u,
        score: 0.88,
        reason: '別視点の情報を持ち込む表現',
      },
      {
        expression:
          /(?:他枠|別枠|他の配信|別の配信)(?:が|は).{0,24}(?:もう|さっき).{0,20}(?:してる|終わった|見つけた|言ってた)/u,
        score: 0.72,
        reason: '他配信者の進行情報らしき表現',
      },
    ],
  },
  {
    category: 'spoiler',
    patterns: [
      {
        expression: /(?:犯人|正体|ラスボス|黒幕)(?:は|が).{0,20}/u,
        score: 0.9,
        reason: '先の展開を示す表現',
      },
      {
        expression:
          /ネタバレ.{0,12}(?:だけど|すると|は|です|注意)|(?:答え|攻略).{0,8}(?:は|を言うと)/u,
        score: 0.96,
        reason: 'ネタバレを明示する表現',
      },
      {
        expression:
          /(?:このあと|次|後半).{0,20}(?:死ぬ|裏切る|仲間になる|ボス|結末|エンディング|出てくる)/u,
        score: 0.72,
        reason: '先の展開を示唆する表現',
      },
    ],
  },
];

export function matchRules(text: string): RuleMatch[] {
  const matches: RuleMatch[] = [];
  for (const rule of RULES) {
    for (const pattern of rule.patterns) {
      const occurrence = pattern.expression.exec(text);
      if (!occurrence) continue;
      // 「指示厨黙れ」のようにコメント欄の相手へ向いた表現は、
      // 配信者への人格攻撃ではなく meta_conflict として扱う。
      if (
        rule.category === 'personal_attack' &&
        /^(?:指示厨|自治厨|荒らし|指示コメ|コメ欄|コメント欄)/u.test(text) &&
        /(?:黙れ|黙ってくれ|うざい|帰れ|消えろ|無視しろ)/u.test(text)
      )
        continue;
      const tail = text.slice(occurrence.index + occurrence[0].length);
      // Quoting an insult to discourage it should not become an insult itself.
      if (
        /^[」』”"']*(?:(?:とか|なんて|って|と)(?:は)?|(?:は|を)?)?(?:言わない|言うな|言わん|言っちゃだめ|言ってはいけない|言うのやめ)/u.test(
          tail,
        )
      )
        continue;
      matches.push({
        category: rule.category,
        score: pattern.score,
        reason: pattern.reason,
      });
    }
  }
  return matches;
}
