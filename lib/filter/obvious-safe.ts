const CUSTOM_EMOJI = /:[^\s:]+:/gu;
const EMOJI = /\p{Extended_Pictographic}/gu;
const PUNCTUATION_ONLY = /^[\s\p{P}\p{S}]+$/u;
const LAUGHTER_ONLY = /^(?:w|ｗ|草|笑|ha|はは|アハ|あは)+[!！?？〜～ー]*$/iu;

const SAFE_REACTIONS = new Set([
  '草',
  'www',
  'ｗｗｗ',
  'ナイス',
  'ないす',
  'gg',
  'おつ',
  'おつかれ',
  'お疲れ様',
  'かわいい',
  'きた',
  'よし',
  'どんまい',
  'がんばれ',
  'がんばって',
  '指示ナイス',
  'ナイス指示',
]);

/** High-volume reactions that do not need semantic classification. */
export function isObviouslySafe(text: string): boolean {
  const value = text.trim();
  if (!value) return true;
  if (SAFE_REACTIONS.has(value.toLocaleLowerCase('ja-JP'))) return true;
  if (LAUGHTER_ONLY.test(value)) return true;
  if (PUNCTUATION_ONLY.test(value)) return true;
  if (isEmojiOnly(value)) return true;
  // These common game reactions contain terms that would otherwise be risky candidates.
  if (/^ししろん[ｗw草笑!！?？〜～ー]*$/u.test(value)) return true;
  if (/^おもしろい[ｗw草笑!！?？〜～ー]*$/u.test(value)) return true;
  if (/^帰れるかな[?？!！]*$/u.test(value)) return true;
  if (/^いける(?:いける)?[ｗw草笑!！?？〜～ー]*$/u.test(value)) return true;
  if (
    /^(?:(?:いけ|行け)(?:(?:いけ|行け)?[〜～ー]+|え{2,})|急げ[〜～ー]+)[ｗw草笑!！?？]*$/u.test(
      value,
    )
  )
    return true;
  // A clearly named positive goal followed by 「いけ」 is cheering, not an
  // instruction about the streamer's next action.
  if (
    /^(?:(?:優勝|勝利|決勝|ゴール|てっぺん|世界一|(?:[0-9０-９]+|[一二三四五六七八九十]+)位)(?:まで|へ)?|(?:強気で|勇気持って))(?:いけ|行け)[ｗw草笑!！?？〜～ー]*$/u.test(
      value,
    )
  )
    return true;
  // A name or team followed immediately by an elongated cheer is not a
  // directional instruction. Keep concrete paths such as「みこち右行け」out
  // of this exception by requiring the cheer to follow the target directly.
  if (
    !/(?:右|左|前|後ろ|拠点|会場|洞窟|海|山|そこ|あっち|こっち|プール|先に|[ぁ-んァ-ヶ一-龠A-Za-z0-9]+(?:に|へ|まで))/u.test(
      value,
    ) &&
    /^(?:みこち|みんな|皆|全員|[ぁ-んァ-ヶ一-龠A-Za-z0-9]{1,16}(?:チーム|ファミリア|組)|[ぁ-んァ-ヶ一-龠A-Za-z0-9]{2,16})(?:いけ|行け)(?:(?:いけ|行け)?[〜～ー]+|え{2,})[ｗw草笑!！?？]*$/u.test(
      value,
    )
  )
    return true;
  if (/^[ァ-ヶー]{2,16}(?:いけ|行け)[ｗw草笑!！?？〜～ー]*$/u.test(value))
    return true;
  if (
    /^(?:[ぁ-んァ-ヶ一-龠A-Za-z0-9]{1,16}(?:チーム|ファミリア|組))(?:がんばれ|頑張れ)[ｗw草笑!！?？〜～ー]*$/u.test(
      value,
    )
  )
    return true;
  if (/^クソ(?:鳥|ドリ)か[ｗw草笑!！?？〜～ー]*$/u.test(value)) return true;
  if (/^動き(?:も|が)いい[ｗw草笑!！?？〜～ー]*$/u.test(value)) return true;
  // A bare 「何してんの」 is an ambiguous question and remains eligible for
  // context/LLM review. Laughter-tagged variants are common reactions.
  if (/^何してんの[ｗw草笑!！?？〜～ー]+$/u.test(value)) return true;
  if (/^何してるんだ[ｗw草笑!！?？〜～ー]+$/u.test(value)) return true;
  return false;
}

function isEmojiOnly(value: string): boolean {
  const withoutCustom = value.replace(CUSTOM_EMOJI, '').replace(/[\s]/gu, '');
  if (!withoutCustom) return true;
  const withoutEmoji = withoutCustom
    .replace(EMOJI, '')
    .replace(/[\uFE0F\u200D]/gu, '');
  return withoutEmoji.length === 0;
}
