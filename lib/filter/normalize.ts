const REPEATED_CHARACTER = /(.)\1{3,}/gu;
const REPEATED_SYMBOLS = /([!?！？。、・])\1+/gu;

export function normalizeText(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('ja-JP')
    .replace(/[\u200B-\u200D\uFEFF]/gu, '')
    .replace(/\s+/gu, ' ')
    .replace(REPEATED_CHARACTER, '$1$1')
    .replace(REPEATED_SYMBOLS, '$1')
    .trim();
}
