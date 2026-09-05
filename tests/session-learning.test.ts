import { describe, expect, it } from 'vitest';
import { SessionRuleLearner } from '../lib/filter/session-learning';
import type { LmClassificationResult } from '../lib/types';

const ai = (
  category: LmClassificationResult['category'],
  score: number,
): LmClassificationResult => ({ id: 'ai-id', category, score });

describe('SessionRuleLearner', () => {
  it('高確信の非safe・非spam判定だけを完全一致で再利用する', () => {
    const learner = new SessionRuleLearner();
    learner.observe('その言い方はやめてください', ai('backseat', 0.9));

    expect(learner.lookup('その言い方はやめてください')).toMatchObject({
      id: '',
      category: 'backseat',
      score: 0.9,
      action: 'blur',
      confidence: 0.9,
    });
    expect(learner.lookup('その言い方はやめて')).toBeNull();
    expect(learner.lookup('その言い方はやめてくださいね')).toBeNull();
  });

  it('同じ節を含む異なる3本文でのみ節を一般化する', () => {
    const learner = new SessionRuleLearner();
    const phrase = 'その言い方はやめてください';
    learner.observe(phrase, ai('backseat', 0.91));
    learner.observe(`${phrase}！今は配信中です`, ai('backseat', 0.88));
    expect(learner.lookup(`${phrase}！別の文章`)).toBeNull();

    learner.observe(`${phrase}！空気を悪くしないで`, ai('backseat', 0.86));
    expect(learner.lookup(`${phrase}！初見です`)).toMatchObject({
      id: '',
      category: 'backseat',
      score: 0.86,
      action: 'blur',
      confidence: 0.86,
    });
  });

  it('節以外が同じでも部分文字列では再利用しない', () => {
    const learner = new SessionRuleLearner();
    const phrase = 'その言い方はやめてください';
    learner.observe(phrase, ai('backseat', 0.9));
    for (const suffix of ['今は配信中です', 'みんなで楽しみましょう']) {
      learner.observe(`${phrase}！${suffix}`, ai('backseat', 0.9));
    }

    expect(learner.lookup('その言い方はやめてくださいね！初見です')).toBeNull();
    expect(learner.lookup('言い方はやめてください！初見です')).toBeNull();
  });

  it('safe判定は節の学習を取り消し、同じセッションでは再昇格させない', () => {
    const learner = new SessionRuleLearner();
    const phrase = 'その言い方はやめてください';
    learner.observe(phrase, ai('backseat', 0.9));
    for (const suffix of ['今は配信中です', 'みんなで楽しみましょう']) {
      learner.observe(`${phrase}！${suffix}`, ai('backseat', 0.9));
    }
    learner.observe(`${phrase}！丁寧なお願いです`, ai('safe', 0.1));

    expect(learner.lookup(`${phrase}！初見です`)).toBeNull();
    learner.observe(`${phrase}！強い表現です`, ai('backseat', 0.95));
    expect(learner.lookup(`${phrase}！初見です`)).toBeNull();
  });

  it('異なるカテゴリが同じ節へ付いた場合は一般化しない', () => {
    const learner = new SessionRuleLearner();
    const phrase = '次の展開を言わないで';
    learner.observe(`${phrase}！お願いします`, ai('backseat', 0.9));
    learner.observe(`${phrase}！本当に困ります`, ai('spoiler', 0.9));
    learner.observe(`${phrase}！空気を読んで`, ai('backseat', 0.9));
    learner.observe(`${phrase}！守ってください`, ai('backseat', 0.9));

    expect(learner.lookup(`${phrase}！初見です`)).toBeNull();
  });

  it('攻撃的な文との共起だけで挨拶の節を一般化しない', () => {
    const learner = new SessionRuleLearner();
    const greeting = 'こんにちは皆さん';
    for (const suffix of [
      '攻撃コメントその一',
      '攻撃コメントその二',
      '攻撃コメントその三',
    ]) {
      learner.observe(`${greeting}。${suffix}`, ai('personal_attack', 0.9));
    }

    expect(learner.lookup(`${greeting}。初見です`)).toBeNull();
  });

  it('低確信・safe・spamは学習しない', () => {
    const learner = new SessionRuleLearner();
    learner.observe('回復した方がいいかも', ai('backseat', 0.84));
    learner.observe('おつかれさまです', ai('safe', 0.9));
    learner.observe('連投です', ai('spam', 1));

    expect(learner.lookup('回復した方がいいかも')).toBeNull();
    expect(learner.lookup('おつかれさまです')).toBeNull();
    expect(learner.lookup('連投です')).toBeNull();
  });

  it('短いsafe本文も完全一致の再昇格を防止する', () => {
    const learner = new SessionRuleLearner();
    learner.observe('草', ai('safe', 0.1));
    learner.observe('草', ai('personal_attack', 0.95));

    expect(learner.lookup('草')).toBeNull();
  });

  it('新しいconfidence形式のsafe allowも安全 veto にする', () => {
    const learner = new SessionRuleLearner();
    const phrase = 'その言い方はやめてください';
    learner.observe(phrase, ai('backseat', 0.9));
    learner.observe(phrase, {
      id: 'safe-id',
      category: 'safe',
      action: 'allow',
      confidence: 0.95,
    });

    expect(learner.lookup(phrase)).toBeNull();
  });

  it('clearで全てのセッション学習を破棄する', () => {
    const learner = new SessionRuleLearner();
    learner.observe('その言い方はやめてください', ai('backseat', 0.9));
    learner.clear();

    expect(learner.lookup('その言い方はやめてください')).toBeNull();
  });

  it('完全一致と節の候補は古い順に500件へ制限する', () => {
    const learner = new SessionRuleLearner();
    const first = '指示コメント000';
    learner.observe(first, ai('backseat', 0.9));
    for (let index = 1; index <= 500; index += 1) {
      learner.observe(`指示コメント${index}`, ai('backseat', 0.9));
    }

    expect(learner.lookup(first)).toBeNull();
    expect(learner.lookup('指示コメント500')).toMatchObject({
      category: 'backseat',
      score: 0.9,
    });
  });
});
