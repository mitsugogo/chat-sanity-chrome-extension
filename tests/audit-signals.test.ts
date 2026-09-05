import { describe, expect, it } from 'vitest';
import { matchAuditSignals } from '../lib/filter/audit-signals';

describe('Zero-score Audit signals', () => {
  it.each([
    ['さっさと進んだら？', '急かす表現'],
    ['いい加減気づいて', '苛立ちを伴う可能性'],
    ['いつまでそれやってるの', '行動への圧力'],
    ['まだそれやってるの？', '行動への批判的疑問'],
    ['そろそろ行けば？', '婉曲的な催促'],
    ['もう進めば？', '婉曲的な行動提案'],
    ['説明してほしい', '行動要求の可能性'],
  ])('「%s」から%sを検出する', (text, reason) => {
    expect(matchAuditSignals(text).map((match) => match.reason)).toContain(
      reason,
    );
  });

  it.each(['休憩したら？', '一回戻ったら？', 'これ使えば？'])(
    '「%s」はシグナルだけでスコア判定しない',
    (text) => {
      expect(matchAuditSignals(text)).not.toEqual([]);
    },
  );
});
