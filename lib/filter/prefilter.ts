import { isObviouslySafe } from './obvious-safe';

export type PrefilterResult =
  { type: 'safe' } | { type: 'suspicious'; reasons: string[] };

const CANDIDATE_PATTERNS: Array<[RegExp, string]> = [
  [
    /(?:死ね|しね|消えろ|黙れ|黙ってくれ|引退しろ|下手|ゴミ|クソ|バカ|馬鹿|アホ|無能|向いてない|頭悪|きもい|うざい|効いて|顔真っ赤|必死|信者|アンチ|お気持ち|イライラ|才能|雑魚|カス|クズ)/u,
    '評価・侮辱語の候補',
  ],
  [
    /(?:何して|なんで|早く|はよ|ちゃんと|しっかり|さっさと|しろ|するな|した方|すれば|行け|戻れ|仕事しろ|指示しろ|コメ読め|マップ|回復|交代|セーブ|装備|確認|リロード|集中|練習|勉強|コメント|やめて|やめる|してください|してほしい|そこじゃない|違うって|早くして)/u,
    '指示・催促構文の候補',
  ],
  [/^(?:それでいいの|大丈夫か)[?？]?/u, '曖昧な疑問・確認の候補'],
  [/(?:のせい|戦犯|責任|リーダー)/u, '責任追及の候補'],
  [
    /[ぁ-んァ-ヶ一-龠A-Za-z0-9○△□☆]{2,20}(?:は|が)悪い/u,
    '対象への責任追及候補',
  ],
  [
    /(?:指示|指示厨|自治厨|コメ欄|コメント欄|荒れて|治安悪|ブロック推奨|無視しろ|仕切るな)/u,
    'コメント欄の対立候補',
  ],
  [
    /(?:比較|より|なら|もっと|方が|向いてる|任せ|上手く|うまく|できる|マシ|微妙|ぐだ|テンポ悪|つまら|進まない|長すぎ|遅すぎ|重い|音小さい|音量小さい|やる気|炎上|ネタバレ|犯人|正体|他枠|別枠|視点|配信|枠)/u,
    '比較・不満・展開示唆の候補',
  ],
];

/** Broad candidate detection. It never decides the display action. */
export function prefilter(text: string): PrefilterResult {
  if (isObviouslySafe(text)) return { type: 'safe' };
  const reasons = CANDIDATE_PATTERNS.filter(([pattern]) =>
    pattern.test(text),
  ).map(([, reason]) => reason);
  return reasons.length > 0
    ? { type: 'suspicious', reasons }
    : { type: 'safe' };
}
