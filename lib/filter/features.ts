import { isObviouslySafe } from './obvious-safe';

export type TargetType = 'person' | 'role' | 'game-object' | 'unknown';

export interface FeatureResult {
  matched: boolean;
  score: number;
  reason?: string;
  feature?: string;
}

export interface TargetMatch {
  matched: boolean;
  targetType: TargetType;
  value?: string;
}

export interface MetaConflictFeatures {
  detected: boolean;
  aggressive: boolean;
  peacekeeping: boolean;
  score: number;
  reasons: string[];
}

export interface ExtractedFeatures {
  target: TargetMatch;
  imperative: FeatureResult;
  blame: FeatureResult;
  abilityAttack: FeatureResult;
  personalAttack: FeatureResult;
  comparison: FeatureResult;
  metaConflict: MetaConflictFeatures;
  complaint: FeatureResult;
  safeContext: FeatureResult;
  question: FeatureResult;
  names: string[];
}

const ROLE_TARGET =
  /(?:リーダー|船長|先生|先輩|後輩|配信者|参加者|メンバー|みこち|ころね|ぺこら|ししろん)/u;
const PRONOUN_TARGET = /(?:お前|こいつ|あいつ|この人|あの人|君|あなた)/u;
const PERSON_GROUP_TARGET = /(?:別の?人|他の?人|誰か|メンバー)/u;
const PLACEHOLDER_TARGET = /(?:○○|△△|□□|☆☆|名前|某人)/u;
const NAME_SUFFIX_TARGET =
  /[ぁ-んァ-ヶ一-龠A-Za-z0-9]{2,16}(?:さん|ちゃん|くん|氏|先輩)/u;
const GAME_OBJECT =
  /(?:ゲーム|敵|虫|恐竜|ボス|モブ|npc|NPC|鳥|ドリ|ワニ|プテラ|レックス|パイロ|鉄|斧|武器|アイテム|装備|マップ|拠点|建物|キャラ|キャラクター|動き|操作|プレイ|説明|判断|戦い方)/u;
const META_TARGET = /(?:指示厨|自治厨|荒らし|指示コメ)/u;
const VIEWER_GROUP =
  /(?:俺ら|おれら|わいら|35p|みこぴー|視聴者|リスナー)のせい/u;
const BLAME_NEGATION = /のせい(?:では|じゃ)ない|のせいに(?:しない|するな)/u;

const STRONG_IMPERATIVE = [
  /(?:^|[、。])(?:しろ|やれ|行け|いけ|戻れ|急げ|見ろ|聞け|待て|使え|選べ|読め|やめろ|するな)(?:よ|な)?[!！。?？ｗw草笑〜～ー]*$/u,
  /(?:早く|はよ|ちゃんと|しっかり|さっさと|今すぐ).{0,24}(?:しろ|やれ|行け|いけ|戻れ|急げ|見ろ|聞け|待て|使え|選べ|読め|やめろ|するな)(?:よ|な)?[!！。?？ｗw草笑〜～ー]*$/u,
  /(?:慣れろ|食え|食べろ|逃げろ|探せ|気づけ|乗れ|降りろ|置け|捨てろ|持て|渡せ|入れろ)(?:よ|な)?[!！。?？ｗw草笑〜～ー]*$/u,
];
const FRIENDLY_IMPERATIVE =
  /(?:しなよ|やりなよ|行きなよ|戻りなよ|見なよ|探しなよ|使いなよ|食べなよ|確認しなよ)(?:[!！。?？ｗw草笑〜～ー]*)$/u;
const ACTION_SUGGESTIONS = [
  /(?:確認|共有|連絡|報告|参加|回収|準備|リスポーン|テイム|回復)(?:したら|してみたら|しといたら|しておいたら|すれば|してみれば)[?？]?$/u,
  /(?:見|聞|行|戻|使|探|食べ|逃げ|産ませ)(?:れば|けば|ったら)[?？]?$/u,
  /(?:入れ|置い|渡し|預け|持っ)(?:とけば|ておけば)[?？]?$/u,
];
const ACTION_ADVICE =
  /(?:確認|共有|連絡|報告|参加|回収|準備|リスポーン|テイム|回復|行動|探し|使い|見|聞|行っ|戻っ|置い|渡し|預け|持っ|食べ|逃げ|産ませ|やめ|止め)(?:た方|たほう)が(?:いい|良い)/u;
const SOFT_IMPERATIVE = [
  /(?:やめて|やめる|止めて).{0,8}(?:ください|ほしい)/u,
  /(?:してください|してほしい|してね|してあげて)(?:[!！。?？ｗw草笑〜～ー]*)$/u,
  /(?:して|やって|確認して|共有して|連絡して|報告して|食べて|食って|気づいて)くれ(?:[!！。?？ｗw草笑〜～ー]*)$/u,
  /(?:何してんの|何してるんだ|何してるの)[?？]?$/u,
  /(?:リーダー|船長|先生).{0,8}(?:頼む|お願い|頑張って|がんばって)[!！。?？ｗwぞよね]*$/u,
  /^ちゃんとして[よね]?[!！。?？ｗw草笑〜～ー]*$/u,
  /^(?:それでいいの|大丈夫か)[?？]?[ｗw]*$/u,
];
const ACTION_NEGATIVE_QUESTION =
  /(?:なんで|どうして).{0,20}(?:食べない|逃げない|探さない|使わない|産ませない|戻らない|確認しない|共有しない|連絡しない|しない|やらない|行かない|見ない)(?:の|ん|んだ|んや|のん)?[?？ｗw草笑〜～ー]*$/u;
const PRESSURE_REQUEST =
  /(?:頼むから|頼む).{0,24}(?:気づいて|食べて|食って|確認して|共有して|連絡して|報告して|行って|戻って|して|やって)くれ(?:[!！。?？ｗw草笑〜～ー]*)$/u;
const TENTATIVE =
  /(?:かも|かな|どうかな|と思う|てもいい|たらいいかも|方がいいかも)/u;
const BLAME_PREDICATE =
  /(?:のせい|(?:は|が)悪い|だからこうなった|戦犯|足を引っ張(?:る|ってる)|責任取(?:れ|って))/u;
const ABILITY_NEGATIVE =
  /(?:下手(?:すぎ|過ぎ)?|頭悪|理解してない|センスない|向いてない|何もできない|使えない|才能ない|無能|雑魚|ゴミ)/u;
const PERSONAL_INSULT = /(?:きもい|キモい|うざい)/u;
const COMPARISON_PATTERNS = [
  /なら.{0,16}(?:もっと|上手く|うまく|できる|マシ)/u,
  /より.{0,20}(?:の方が|のほうが).{0,16}(?:向いてる|向いている|上手い|うまい|下手|マシ|できる|いい|良い)/u,
  /(?:の方が|のほうが).{0,16}(?:向いてる|向いている|上手い|うまい|下手|マシ|できる|いい|良い)/u,
  /(?:に任せれば|に任せた方が).{0,12}(?:よかった|良かった|いい|良い)/u,
];
const AGGRESSIVE_META =
  /(?:指示厨|自治厨|荒らし|指示コメ).{0,16}(?:黙れ|黙ってくれ|うざい|多すぎ|沸いて|帰れ|消えろ|無視しろ|無視推奨|仕切るな|無能|バカ|馬鹿|アホ|頭悪|きもい|キモい)|(?:コメ欄|コメント欄).{0,16}(?:荒れてる|治安悪い|うるさい|地獄|最悪)|(?:ブロック推奨|通報推奨|無視推奨|仕切るな)/u;
const PEACEKEEPING_META =
  /(?:みんな仲良く|荒らし(?:は|を)?(?:無視|スルー|放置)|指示(?:コメ|コメント)?(?:は|を)?(?:やめ|控え)|自治(?:は|を)?(?:やめ|控え)|喧嘩(?:は|を)?(?:やめ|しない)|落ち着いて|文句.{0,16}(?:言う|言わ).{0,16}(?:応援|やりなよ))/u;
const COMPLAINT_SUBJECT =
  /(?:テンポ|ペース|流れ|展開|進行|待ち時間|ロード|準備|集合|説明|話)/u;
const COMPLAINT_PREDICATE =
  /(?:悪い|遅い|遅すぎ|微妙|つまら|だるい|ぐだ|進まない|長い|長すぎ|重い)/u;
const STREAM_STATE_COMPLAINT =
  /(?:画質悪い|音小さい|音量小さい|カクカク|ぐだってる|グダってる)/u;
const POSITIVE_COMPLAINT_CONTEXT = /(?:楽し|草|ｗ|w|好き|醍醐味)/iu;
const QUESTION = /[?？](?:[ｗw草笑]*)$/u;

/** Find a likely person, role, or game-object target without requiring a name list. */
export function detectTarget(
  text: string,
  knownNames: string[] = [],
): TargetMatch {
  const known = knownNames.find(
    (name) => name.length > 0 && text.includes(name),
  );
  if (known) return { matched: true, targetType: 'person', value: known };

  const role = text.match(ROLE_TARGET)?.[0];
  if (role) return { matched: true, targetType: 'role', value: role };
  const pronoun = text.match(PRONOUN_TARGET)?.[0];
  if (pronoun) return { matched: true, targetType: 'person', value: pronoun };
  const personGroup = text.match(PERSON_GROUP_TARGET)?.[0];
  if (personGroup)
    return { matched: true, targetType: 'person', value: personGroup };
  const placeholder = text.match(PLACEHOLDER_TARGET)?.[0];
  if (placeholder)
    return { matched: true, targetType: 'person', value: placeholder };
  const suffix = text.match(NAME_SUFFIX_TARGET)?.[0];
  if (suffix) return { matched: true, targetType: 'person', value: suffix };
  const object = text.match(GAME_OBJECT)?.[0];
  if (object)
    return { matched: true, targetType: 'game-object', value: object };

  const predicateTarget = text.match(
    /(?:^|[\s、])([ぁ-んァ-ヶ一-龠A-Za-z0-9○△□☆]{2,16})(?=(?:は|が|を|に|なら|より|の方が|のほうが|向いてない|が悪い))/u,
  )?.[1];
  if (predicateTarget && !GAME_OBJECT.test(predicateTarget))
    return { matched: true, targetType: 'person', value: predicateTarget };

  return { matched: false, targetType: 'unknown' };
}

export function detectImperative(text: string): FeatureResult {
  if (isObviouslySafe(text))
    return { matched: false, score: 0, feature: 'safe-context' };

  const commentAudience =
    META_TARGET.test(text) ||
    /(?:文句|指示(?:コメ|コメント)?|荒らし|自治).{0,24}(?:やりなよ|しなよ|言うな|やめ)/u.test(
      text,
    );
  if (commentAudience) return { matched: false, score: 0 };

  const tentative = TENTATIVE.test(text);
  if (STRONG_IMPERATIVE.some((pattern) => pattern.test(text))) {
    if (tentative)
      return {
        matched: true,
        score: 0.42,
        reason: '行動誘導の文脈確認候補',
        feature: 'tentative-imperative',
      };
    return {
      matched: true,
      score: 0.88,
      reason: '命令・催促の表現',
      feature: 'imperative',
    };
  }
  if (FRIENDLY_IMPERATIVE.test(text)) {
    return {
      matched: true,
      score: /(?:早く|はよ|ちゃんと|しっかり|さっさと|今すぐ)/u.test(text)
        ? 0.68
        : 0.62,
      reason: 'やわらかい命令・催促の表現',
      feature: 'soft-imperative',
    };
  }
  if (ACTION_NEGATIVE_QUESTION.test(text)) {
    return {
      matched: true,
      score: 0.62,
      reason: '行動を問いただす表現',
      feature: 'action-negative-question',
    };
  }
  if (
    ACTION_SUGGESTIONS.some((pattern) => pattern.test(text)) ||
    ACTION_ADVICE.test(text)
  ) {
    return {
      matched: true,
      score: 0.42,
      reason: '婉曲的な行動提案',
      feature: 'suggestion-pressure',
    };
  }
  if (PRESSURE_REQUEST.test(text)) {
    return {
      matched: true,
      score: 0.68,
      reason: '頼み込みによる行動要求',
      feature: 'action-pressure',
    };
  }
  if (SOFT_IMPERATIVE.some((pattern) => pattern.test(text))) {
    const ambiguous =
      /(?:何してんの|何してるんだ|何してるの|それでいいの|大丈夫か|リーダー|船長|^ちゃんとして)/u.test(
        text,
      );
    const requestEnding =
      /(?:して|やって|確認して|共有して|連絡して|報告して|食べて|食って|気づいて)くれ/u.test(
        text,
      );
    const lowConfidence =
      tentative ||
      ambiguous ||
      requestEnding ||
      /(?:やめて|やめる|止めて)/u.test(text);
    return {
      matched: true,
      score: lowConfidence ? 0.42 : 0.52,
      reason: lowConfidence
        ? '行動誘導の文脈確認候補'
        : '依頼・助言による行動誘導候補',
      feature: lowConfidence ? 'suggestion-pressure' : 'soft-imperative',
    };
  }
  return { matched: false, score: 0 };
}

export function detectBlame(
  text: string,
  target = detectTarget(text),
): FeatureResult {
  const standalone = /(?:戦犯|誰が悪い|どっちが悪い)/u.test(text);
  if (
    BLAME_NEGATION.test(text) ||
    VIEWER_GROUP.test(text) ||
    !BLAME_PREDICATE.test(text) ||
    (!standalone && target.targetType === 'game-object')
  )
    return { matched: false, score: 0 };
  if (!standalone && !target.matched) return { matched: false, score: 0 };
  return {
    matched: true,
    score: standalone ? 0.9 : 0.92,
    reason: '責任を特定対象へ押し付ける表現',
    feature: 'blame-predicate',
  };
}

export function detectAbilityAttack(
  text: string,
  target = detectTarget(text),
): FeatureResult {
  if (META_TARGET.test(text) || !ABILITY_NEGATIVE.test(text))
    return { matched: false, score: 0 };
  const explicitSubject =
    /(?:説明|プレイ|操作|判断|戦い方|動き|頭|性格|人間性)/u.test(text);
  const gameOnly =
    /(?:武器|アイテム|装備|敵|ボス|鳥|ドリ|虫|恐竜).{0,8}(?:使えない|下手|弱い)/u.test(
      text,
    );
  if (gameOnly && !target.matched) return { matched: false, score: 0 };
  if (!target.matched && !explicitSubject) return { matched: false, score: 0 };
  if (target.targetType === 'game-object' && !explicitSubject)
    return { matched: false, score: 0 };
  return {
    matched: true,
    score:
      target.targetType === 'person' || target.targetType === 'role'
        ? 0.92
        : 0.78,
    reason: '能力・人格を否定する表現',
    feature: 'ability-negative',
  };
}

export function detectPersonalAttack(
  text: string,
  target = detectTarget(text),
): FeatureResult {
  if (
    META_TARGET.test(text) ||
    !PERSONAL_INSULT.test(text) ||
    target.targetType === 'game-object'
  )
    return { matched: false, score: 0 };
  if (target.targetType === 'person' || target.targetType === 'role') {
    return {
      matched: true,
      score: 0.92,
      reason: '人物を侮辱する表現',
      feature: 'targeted-personal-insult',
    };
  }
  return {
    matched: true,
    score: 0.42,
    reason: '攻撃的な評価の文脈確認候補',
    feature: 'ambiguous-personal-insult',
  };
}

export function detectComparison(
  text: string,
  knownNames: string[] = [],
): FeatureResult {
  const target = detectTarget(text, knownNames);
  if (
    (target.targetType !== 'person' && target.targetType !== 'role') ||
    !COMPARISON_PATTERNS.some((pattern) => pattern.test(text))
  )
    return { matched: false, score: 0 };
  return {
    matched: true,
    score: 0.8,
    reason: '他者との比較・交代を促す表現',
    feature: 'comparison',
  };
}

export function detectMetaConflict(text: string): MetaConflictFeatures {
  const peacekeeping = PEACEKEEPING_META.test(text);
  const aggressive = AGGRESSIVE_META.test(text) && !peacekeeping;
  return {
    detected: aggressive || peacekeeping,
    aggressive,
    peacekeeping,
    score: aggressive ? 0.82 : peacekeeping ? 0.25 : 0,
    reasons: [
      ...(aggressive ? ['攻撃的なコメント欄介入'] : []),
      ...(peacekeeping ? ['平和化を促すコメント'] : []),
    ],
  };
}

export function detectComplaint(text: string): FeatureResult {
  const containsGuda = /(?:ぐだぐだ|グダグダ|gdgd)/iu.test(text);
  if (containsGuda && POSITIVE_COMPLAINT_CONTEXT.test(text))
    return { matched: false, score: 0 };
  if (STREAM_STATE_COMPLAINT.test(text)) {
    return {
      matched: true,
      score: 0.52,
      reason: '配信状態への不満',
      feature: 'complaint',
    };
  }
  if (COMPLAINT_SUBJECT.test(text) && COMPLAINT_PREDICATE.test(text)) {
    return {
      matched: true,
      score: 0.56,
      reason: '配信進行・状態への不満',
      feature: 'complaint',
    };
  }
  if (containsGuda) {
    return {
      matched: true,
      score: 0.42,
      reason: '配信進行への不満の文脈確認候補',
      feature: 'tentative-complaint',
    };
  }
  return { matched: false, score: 0 };
}

export function detectSafeContext(text: string): FeatureResult {
  const laughter = /(?:w|ｗ|草|笑)/iu.test(text);
  const question = QUESTION.test(text);
  const obvious = isObviouslySafe(text);
  if (!laughter && !question && !obvious) return { matched: false, score: 0 };
  return {
    matched: true,
    score: obvious ? 1 : 0.35,
    reason: obvious ? '明らかなリアクション' : '笑い・疑問形の文脈',
    feature: obvious ? 'strong-safe-context' : 'safe-context',
  };
}

export function extractFeatures(
  text: string,
  knownNames: string[] = [],
): ExtractedFeatures {
  const target = detectTarget(text, knownNames);
  const questionMatched = QUESTION.test(text);
  return {
    target,
    imperative: detectImperative(text),
    blame: detectBlame(text, target),
    abilityAttack: detectAbilityAttack(text, target),
    personalAttack: detectPersonalAttack(text, target),
    comparison: detectComparison(text, knownNames),
    metaConflict: detectMetaConflict(text),
    complaint: detectComplaint(text),
    safeContext: detectSafeContext(text),
    question: {
      matched: questionMatched,
      score: questionMatched ? 0.2 : 0,
      ...(questionMatched ? { feature: 'question' } : {}),
    },
    names: knownNames,
  };
}
