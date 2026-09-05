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
    /^(?:優勝|勝利|決勝|ゴール|てっぺん|世界一)(?:まで|へ)?(?:いけ|行け)[ｗw草笑!！?？〜～ー]*$/u.test(
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
