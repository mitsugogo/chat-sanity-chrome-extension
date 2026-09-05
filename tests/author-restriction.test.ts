import { describe, expect, it } from 'vitest';
import {
  AuthorRestrictionTracker,
  HABITUAL_RESTRICT_COUNT,
  RESTRICT_BOOST_STEP,
} from '../lib/filter/author-restriction';

describe('AuthorRestrictionTracker', () => {
  it('ぼかし・非表示の回数に応じて加点し、同一投稿の更新では二重計上しない', () => {
    const tracker = new AuthorRestrictionTracker();
    expect(tracker.boost('UC-a')).toBe(0);
    expect(tracker.observe('UC-a', 'one', 'blur')).toBe(false);
    expect(tracker.boost('UC-a')).toBe(RESTRICT_BOOST_STEP);
    expect(tracker.observe('UC-a', 'one', 'blur')).toBe(false);
    expect(tracker.boost('UC-a')).toBe(RESTRICT_BOOST_STEP);
    expect(tracker.observe('UC-a', 'one', 'allow')).toBe(false);
    expect(tracker.boost('UC-a')).toBe(0);
  });

  it('閾値に達したタイミングだけ常習として返す', () => {
    const tracker = new AuthorRestrictionTracker();
    for (let index = 1; index < HABITUAL_RESTRICT_COUNT; index += 1) {
      expect(tracker.observe('UC-a', `m-${index}`, 'hide')).toBe(false);
    }
    expect(
      tracker.observe('UC-a', `m-${HABITUAL_RESTRICT_COUNT}`, 'hide'),
    ).toBe(true);
    expect(tracker.observe('UC-a', 'extra', 'hide')).toBe(false);
  });
});
