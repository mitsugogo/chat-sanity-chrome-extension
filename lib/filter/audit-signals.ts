export interface AuditSignalMatch {
  boost: number;
  reason: string;
}

const AUDIT_SIGNALS: ReadonlyArray<{
  expression: RegExp;
  boost: number;
  reason: string;
}> = [
  { expression: /さっさと/u, boost: 0.25, reason: '急かす表現' },
  {
    expression: /いい加減/u,
    boost: 0.2,
    reason: '苛立ちを伴う可能性',
  },
  {
    expression: /いつまで.{0,12}(?:して|やって)/u,
    boost: 0.25,
    reason: '行動への圧力',
  },
  {
    expression: /まだ.{0,12}(?:してる|やってる)の/u,
    boost: 0.2,
    reason: '行動への批判的疑問',
  },
  {
    expression: /そろそろ.{0,20}(?:したら|すれば|して|行けば|進めば)/u,
    boost: 0.15,
    reason: '婉曲的な催促',
  },
  {
    expression: /.{1,20}(?:たら|[ぁ-ん]ば)[?？]?$/u,
    boost: 0.12,
    reason: '婉曲的な行動提案',
  },
  {
    expression: /(?:してほしい|してくれ)[?？!！]?$/u,
    boost: 0.18,
    reason: '行動要求の可能性',
  },
];

/** Signals only increase the chance of an AI audit; they never affect score. */
export function matchAuditSignals(text: string): AuditSignalMatch[] {
  return AUDIT_SIGNALS.filter(({ expression }) => expression.test(text)).map(
    ({ boost, reason }) => ({ boost, reason }),
  );
}
