const REPEATED_CHARACTER = /(.)\1{3,}/gu;
const REPEATED_SYMBOLS = /([!?！？。、・])\1+/gu;
const JAPANESE_WHITESPACE =
  /(?<=[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}])\s+(?=[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}])/gu;

export function normalizeText(value: string): string {
  return (
    value
      .normalize('NFKC')
      .toLocaleLowerCase('ja-JP')
      .replace(/[\u200B-\u200D\uFEFF]/gu, '')
      .replace(/\s+/gu, ' ')
      // 「し ろ よ」のように、検知を避けるために日本語の語中へ入れた空白だけを除く。
      // 英単語や通常の文節を連結しないため、英語・日本語間の空白は残す。
      .replace(JAPANESE_WHITESPACE, '')
      .replace(REPEATED_CHARACTER, '$1$1')
      .replace(REPEATED_SYMBOLS, '$1')
      .trim()
  );
}
