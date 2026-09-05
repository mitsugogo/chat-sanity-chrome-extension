import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FLOW_CHAT_CLASSES,
  resolveFlowChatThreshold,
} from '../lib/integrations/flow-chat/constants';
import { FlowChatBridge } from '../lib/integrations/flow-chat/bridge';
import {
  FlowChatMetrics,
  FlowChatMetricsStore,
} from '../lib/integrations/flow-chat/metrics';
import { DEFAULT_SETTINGS } from '../lib/settings';

describe('FlowChatBridge', () => {
  beforeEach(() => {
    document.documentElement.className = '';
  });

  afterEach(() => {
    vi.useRealTimers();
    document.documentElement.className = '';
  });

  it('有効化前はクラスを変更せず有効化後にactiveを付ける', () => {
    const bridge = new FlowChatBridge(document);
    const element = document.createElement('div');
    expect(bridge.finalizeAllowed(element)).toBe(false);
    expect(element).not.toHaveClass(FLOW_CHAT_CLASSES.filtered);
    expect(bridge.activate()).toBe(true);
    expect(document.documentElement).toHaveClass(FLOW_CHAT_CLASSES.active);
  });

  it('除外はdeletedを先に付けてからfilteredで確定する', () => {
    const bridge = new FlowChatBridge(document);
    bridge.activate();
    const element = document.createElement('div');
    const guard = bridge.begin(element);

    expect(
      guard.finalize({
        exclude: true,
        score: 0.9,
        threshold: 0.75,
        source: 'rule',
      }),
    ).toBe(true);
    expect(element).toHaveClass(
      FLOW_CHAT_CLASSES.deleted,
      FLOW_CHAT_CLASSES.filtered,
    );
    expect(bridge.isFinalized(element)).toBe(true);
    expect(guard.finalizeAllowed()).toBe(false);
  });

  it('deadlineでfail-openしpendingを残さない', () => {
    vi.useFakeTimers();
    const timeout = vi.fn();
    const bridge = new FlowChatBridge(document, {
      deadlineMs: 20,
      onTimeout: timeout,
    });
    bridge.activate();
    const element = document.createElement('div');
    bridge.begin(element);
    expect(bridge.getPendingCount()).toBe(1);

    vi.advanceTimersByTime(20);
    expect(timeout).toHaveBeenCalledOnce();
    expect(element).toHaveClass(FLOW_CHAT_CLASSES.filtered);
    expect(element).not.toHaveClass(FLOW_CHAT_CLASSES.deleted);
    expect(bridge.getPendingCount()).toBe(0);
  });

  it('deactivateでpendingを許可として確定しactiveを外す', () => {
    const bridge = new FlowChatBridge(document);
    bridge.activate();
    const element = document.createElement('div');
    bridge.begin(element);
    bridge.deactivate();

    expect(element).toHaveClass(FLOW_CHAT_CLASSES.filtered);
    expect(element).not.toHaveClass(FLOW_CHAT_CLASSES.deleted);
    expect(document.documentElement).not.toHaveClass(FLOW_CHAT_CLASSES.active);
    expect(bridge.getPendingCount()).toBe(0);
  });

  it('guardのcancelもfail-openで確定する', () => {
    const bridge = new FlowChatBridge(document);
    bridge.activate();
    const element = document.createElement('div');
    const guard = bridge.begin(element);
    guard.cancel();

    expect(element).toHaveClass(FLOW_CHAT_CLASSES.filtered);
    expect(bridge.getPendingCount()).toBe(0);
  });

  it('protocolクラスと状態を個別にクリアできる', () => {
    const bridge = new FlowChatBridge(document);
    bridge.activate();
    const element = document.createElement('div');
    bridge.finalizeAllowed(element);
    bridge.clearElement(element);

    expect(element).not.toHaveClass(FLOW_CHAT_CLASSES.filtered);
    expect(bridge.isFinalized(element)).toBe(false);
  });

  it('既存のfiltered要素を再処理しない', () => {
    const bridge = new FlowChatBridge(document);
    bridge.activate();
    const element = document.createElement('div');
    element.classList.add(FLOW_CHAT_CLASSES.filtered);

    expect(
      bridge.begin(element).finalize({
        exclude: true,
        score: 1,
        threshold: 0,
        source: 'rule',
      }),
    ).toBe(false);
    expect(element).not.toHaveClass(FLOW_CHAT_CLASSES.deleted);
  });

  it('Flow Chatの待機stubと互換する', async () => {
    const bridge = new FlowChatBridge(document);
    bridge.activate();
    const element = document.createElement('div');
    const result = flowChatStub(element);
    bridge.finalizeExcluded(element, 0.9, 0.75);
    await expect(result).resolves.toBe('DROP');
  });
});

describe('Flow Chat threshold and metrics', () => {
  it('blur/hide/customの基準を解決する', () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    expect(resolveFlowChatThreshold(settings)).toBe(0.75);
    settings.flowChat.exclusionLevel = 'hide';
    expect(resolveFlowChatThreshold(settings)).toBe(0.9);
    settings.flowChat.exclusionLevel = 'custom';
    settings.flowChat.customThreshold = 0.6;
    expect(resolveFlowChatThreshold(settings)).toBe(0.6);
  });

  it('メトリクスを集計しフレーム単位で合算する', () => {
    const first = new FlowChatMetrics();
    first.received();
    first.classified();
    first.finalized(true, 10);
    first.cacheHit();
    const second = new FlowChatMetrics();
    second.received();
    second.finalized(false, 30);
    second.timeout();

    const store = new FlowChatMetricsStore();
    store.update(1, 0, first.snapshot());
    store.update(1, 1, second.snapshot());
    expect(store.aggregate()).toMatchObject({
      received: 2,
      classified: 1,
      excluded: 1,
      allowed: 1,
      cacheHits: 1,
      timeouts: 1,
      averageLatency: 20,
      maxLatency: 30,
    });
  });
});

async function flowChatStub(
  element: HTMLElement,
  timeoutMs = 1_000,
): Promise<'DROP' | 'FLOW'> {
  if (!document.documentElement.classList.contains(FLOW_CHAT_CLASSES.active))
    return 'FLOW';
  const startedAt = Date.now();
  while (
    !element.classList.contains(FLOW_CHAT_CLASSES.filtered) &&
    Date.now() - startedAt < timeoutMs
  ) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return element.classList.contains(FLOW_CHAT_CLASSES.deleted)
    ? 'DROP'
    : 'FLOW';
}
