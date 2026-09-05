import { describe, expect, it } from 'vitest';
import { AuditSampler } from '../lib/filter/audit-sampler';
import { DEFAULT_SETTINGS } from '../lib/settings';
import type { FilterResult, RuleDisposition } from '../lib/types';

function settings() {
  const value = structuredClone(DEFAULT_SETTINGS);
  value.lmStudio.enabled = true;
  value.lmStudio.model = 'local';
  return value;
}

function base(ruleDisposition: RuleDisposition): FilterResult {
  return {
    score: 0,
    categories: ['safe'],
    reasons: ['ルールに一致しませんでした'],
    action: 'allow',
    needsAi: false,
    ruleDisposition,
  };
}

describe('AuditSampler', () => {
  it.each([
    ['unmatched', true],
    ['matched', false],
    ['explicit-safe', false],
    ['excluded', false],
  ] as const)('%sのeligibleは%s', (disposition, eligible) => {
    const decision = new AuditSampler(() => 0.99).evaluate({
      normalized: '未知の本文',
      base: base(disposition),
      settings: settings(),
      now: 1_000,
    });
    expect(decision.eligible).toBe(eligible);
  });

  it('注入した乱数で監査とskipを再現できる', () => {
    const input = {
      normalized: '未知の本文',
      base: base('unmatched'),
      settings: settings(),
      now: 1_000,
    };
    expect(new AuditSampler(() => 0.01).evaluate(input).shouldAudit).toBe(true);
    expect(new AuditSampler(() => 0.99).evaluate(input).shouldAudit).toBe(
      false,
    );
  });

  it('弱いシグナルで監査確率を上げるが最大0.5に制限する', () => {
    const sampler = new AuditSampler(() => 0.99);
    const plain = sampler.evaluate({
      normalized: '未知の本文',
      base: base('unmatched'),
      settings: settings(),
      now: 1_000,
    });
    const signaled = sampler.evaluate({
      normalized: 'さっさと進んだら？',
      base: base('unmatched'),
      settings: settings(),
      now: 2_000,
    });
    expect(signaled.probability).toBeGreaterThan(plain.probability);
    expect(signaled.probability).toBe(0.35);
    expect(signaled.probability).toBeLessThanOrEqual(0.5);
  });

  it('同文が短時間に頻出すると確率を下げるが0にはしない', () => {
    const sampler = new AuditSampler(() => 0.99);
    let first = 0;
    let latest = 0;
    for (let index = 0; index < 5; index += 1) {
      const decision = sampler.evaluate({
        normalized: 'さっさと進んだら？',
        base: base('unmatched'),
        settings: settings(),
        now: 1_000 + index,
      });
      if (index === 0) first = decision.probability;
      latest = decision.probability;
    }
    expect(latest).toBeGreaterThan(0);
    expect(latest).toBeLessThan(first);
  });

  it('1分あたりの監査上限を超えない', () => {
    const value = settings();
    value.lmStudio.zeroScoreAudit.maxPerMinute = 2;
    const sampler = new AuditSampler(() => 0);
    const decisions = [0, 1, 2].map((index) =>
      sampler.evaluate({
        normalized: `未知の本文${index}`,
        base: base('unmatched'),
        settings: value,
        now: 1_000 + index,
      }),
    );
    expect(decisions.map((decision) => decision.shouldAudit)).toEqual([
      true,
      true,
      false,
    ]);
  });

  it('同時監査上限を守り完了後は次を受け付ける', () => {
    const value = settings();
    value.lmStudio.zeroScoreAudit.maxPending = 1;
    const sampler = new AuditSampler(() => 0);
    const evaluate = (normalized: string) =>
      sampler.evaluate({
        normalized,
        base: base('unmatched'),
        settings: value,
        now: 1_000,
      });
    expect(evaluate('一件目').shouldAudit).toBe(true);
    expect(evaluate('二件目').shouldAudit).toBe(false);
    sampler.complete();
    expect(evaluate('三件目').shouldAudit).toBe(true);
  });
});
