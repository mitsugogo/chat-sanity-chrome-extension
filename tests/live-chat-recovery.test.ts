import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  canRecoverLiveChat,
  LIVE_CHAT_RECOVERY_COOLDOWN_MS,
  LIVE_CHAT_STALL_MS,
  LiveChatStallTracker,
  startLiveChatRecovery,
} from '../lib/youtube/live-chat-recovery';

function arm(tracker: LiveChatStallTracker, start = 0) {
  for (let index = 0; index <= 6; index += 1) {
    expect(tracker.sample(start + index * 5_000, `item-${index}`, true)).toBe(
      false,
    );
  }
  return start + 30_000;
}

describe('live chat stall tracker', () => {
  it('継続した更新の後に60秒止まった場合だけ復旧候補にする', () => {
    const tracker = new LiveChatStallTracker();
    const lastProgress = arm(tracker);
    expect(
      tracker.sample(lastProgress + LIVE_CHAT_STALL_MS - 1, 'item-6', true),
    ).toBe(false);
    expect(
      tracker.sample(lastProgress + LIVE_CHAT_STALL_MS, 'item-6', true),
    ).toBe(true);
    expect(
      tracker.sample(lastProgress + LIVE_CHAT_STALL_MS + 1, 'next', true),
    ).toBe(false);
  });

  it('無投稿・低速チャット・起動時の古い行・短い一斉投稿を停止扱いしない', () => {
    const tracker = new LiveChatStallTracker();
    expect(tracker.sample(0, null, true)).toBe(false);
    expect(tracker.sample(100_000, 'old', true)).toBe(false);
    expect(tracker.sample(200_000, 'old', true)).toBe(false);
    for (let index = 0; index < 7; index += 1) {
      tracker.sample(300_000 + index, `burst-${index}`, true);
    }
    expect(tracker.sample(400_000, 'burst-6', true)).toBe(false);
    tracker.reset();
    for (let index = 0; index < 7; index += 1) {
      tracker.sample(500_000 + index * 30_000, `slow-${index}`, true);
    }
    expect(tracker.sample(800_000, 'slow-6', true)).toBe(false);
  });

  it('過去ログ閲覧・非表示・入力中から戻った際は更新実績を集め直す', () => {
    const tracker = new LiveChatStallTracker();
    arm(tracker);
    expect(tracker.sample(90_000, 'item-6', false)).toBe(false);
    expect(tracker.sample(100_000, 'item-6', true)).toBe(false);
    expect(tracker.sample(200_000, 'item-6', true)).toBe(false);
  });

  it('試行後は再び更新が続くまで再試行せず5分の間隔を維持する', () => {
    const tracker = new LiveChatStallTracker();
    arm(tracker);
    tracker.attempted(90_000);
    expect(tracker.sample(100_000, 'item-6', true)).toBe(false);
    expect(tracker.sample(200_000, 'item-6', true)).toBe(false);
    const lastProgress = arm(tracker, 210_000);
    expect(
      tracker.sample(lastProgress + LIVE_CHAT_STALL_MS, 'item-6', true),
    ).toBe(false);
    expect(
      tracker.sample(90_000 + LIVE_CHAT_RECOVERY_COOLDOWN_MS, 'item-6', true),
    ).toBe(true);
  });
});

let stop: (() => void) | undefined;
let originalUrl: string;
let enabled: boolean;
let clicks: string[];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  originalUrl = window.location.href;
  window.history.replaceState(null, '', '/live_chat');
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  const rect = new DOMRect(0, 0, 320, 500);
  const rects: DOMRectList = {
    0: rect,
    length: 1,
    item: (index) => (index === 0 ? rect : null),
    [Symbol.iterator]: () => [rect].values(),
  };
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue(rects);
  enabled = true;
  clicks = [];
  document.body.innerHTML = `
    <yt-live-chat-header-renderer>
      <div id="live-chat-view-selector-sub-menu">
        <div id="label" role="button" aria-expanded="false"></div>
        <tp-yt-iron-dropdown aria-hidden="true">
          <a aria-selected="true"><span class="item">トップチャット</span><yt-reload-continuation></yt-reload-continuation></a>
          <a aria-selected="false"><span class="item">チャット</span><yt-reload-continuation></yt-reload-continuation></a>
        </tp-yt-iron-dropdown>
      </div>
    </yt-live-chat-header-renderer>
    <yt-live-chat-item-list-renderer>
      <div id="item-scroller"><div id="items"><yt-live-chat-text-message-renderer id="initial"></yt-live-chat-text-message-renderer></div></div>
    </yt-live-chat-item-list-renderer>
    <yt-live-chat-text-input-field-renderer><div contenteditable=""></div></yt-live-chat-text-input-field-renderer>`;
  const scroller = document.querySelector('#item-scroller');
  if (!scroller) throw new Error('scroller missing');
  Object.defineProperties(scroller, {
    clientHeight: { value: 500 },
    scrollHeight: { value: 1_000 },
    scrollTop: { value: 500, writable: true },
  });
  const trigger = document.querySelector<HTMLElement>('#label');
  if (!trigger) throw new Error('trigger missing');
  trigger.addEventListener('click', () => {
    trigger.setAttribute(
      'aria-expanded',
      String(trigger.getAttribute('aria-expanded') !== 'true'),
    );
    const dropdown = document.querySelector('tp-yt-iron-dropdown');
    if (trigger.getAttribute('aria-expanded') === 'true')
      dropdown?.removeAttribute('aria-hidden');
    else dropdown?.setAttribute('aria-hidden', 'true');
  });
  const options = document.querySelectorAll<HTMLElement>('a[aria-selected]');
  for (const option of options) {
    option.addEventListener('click', () => {
      clicks.push(option.querySelector('.item')?.textContent ?? '');
      for (const other of options)
        other.setAttribute('aria-selected', String(other === option));
      trigger.setAttribute('aria-expanded', 'false');
      document
        .querySelector('tp-yt-iron-dropdown')
        ?.setAttribute('aria-hidden', 'true');
    });
  }
});
afterEach(() => {
  stop?.();
  stop = undefined;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', originalUrl);
  document.body.innerHTML = '';
});

function appendItem(id: string) {
  const item = document.createElement('yt-live-chat-text-message-renderer');
  item.id = id;
  document.querySelector('#items')?.append(item);
}
async function healthyThenStalled() {
  stop = startLiveChatRecovery(document, () => enabled);
  await vi.advanceTimersByTimeAsync(5_000);
  for (let index = 0; index < 6; index += 1) {
    appendItem(`new-${index}`);
    await vi.advanceTimersByTimeAsync(5_000);
  }
}

describe('live chat recovery DOM boundary', () => {
  it('停止候補でモードを往復し元の選択へ戻す。無投稿で繰り返さない', async () => {
    await healthyThenStalled();
    await vi.advanceTimersByTimeAsync(LIVE_CHAT_STALL_MS - 1);
    expect(clicks).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(clicks).toEqual(['チャット']);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(clicks).toEqual(['チャット', 'トップチャット']);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(clicks).toHaveLength(2);
  });

  it('全件チャットを選んでいた場合も元のモードに戻す', async () => {
    const options = document.querySelectorAll('a');
    options[0]?.setAttribute('aria-selected', 'false');
    options[1]?.setAttribute('aria-selected', 'true');
    await healthyThenStalled();
    await vi.advanceTimersByTimeAsync(LIVE_CHAT_STALL_MS + 1_500);
    expect(clicks).toEqual(['トップチャット', 'チャット']);
  });

  it.each([
    'disabled',
    'hidden',
    'offline',
    'scrollback',
    'draft',
    'focus',
    'menu',
    'menu-stale-aria',
    'overlay',
  ])('%sの間は復旧操作をしない', async (condition) => {
    await healthyThenStalled();
    if (condition === 'disabled') enabled = false;
    if (condition === 'hidden')
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    if (condition === 'offline')
      vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    if (condition === 'scrollback') {
      const scroller = document.querySelector('#item-scroller');
      if (scroller) scroller.scrollTop = 100;
    }
    const input = document.querySelector<HTMLElement>('[contenteditable]');
    if (condition === 'draft' && input) input.textContent = '未送信';
    if (condition === 'focus') input?.focus();
    if (condition === 'menu')
      document.querySelector('#label')?.setAttribute('aria-expanded', 'true');
    if (condition === 'menu-stale-aria')
      document
        .querySelector('tp-yt-iron-dropdown')
        ?.removeAttribute('aria-hidden');
    if (condition === 'overlay') {
      const overlay = document.createElement('div');
      overlay.setAttribute('role', 'dialog');
      document.body.append(overlay);
    }
    await vi.advanceTimersByTimeAsync(LIVE_CHAT_STALL_MS + 1_500);
    expect(clicks).toEqual([]);
  });

  it('リプレイ・未取得・DOM非対応・非表示一覧を対象にしない', () => {
    expect(canRecoverLiveChat(document)).toBe(true);
    window.history.replaceState(null, '', '/live_chat_replay');
    expect(canRecoverLiveChat(document)).toBe(false);
    window.history.replaceState(null, '', '/live_chat');
    document.querySelector('#item-scroller')?.setAttribute('hidden', '');
    expect(canRecoverLiveChat(document)).toBe(false);
    document.querySelector('#item-scroller')?.removeAttribute('hidden');
    document.querySelector('a')?.remove();
    expect(canRecoverLiveChat(document)).toBe(false);
    document.body.innerHTML = '';
    expect(canRecoverLiveChat(document)).toBe(false);
  });

  it('一覧交換時は新しい一覧で更新実績を集め直す', async () => {
    await healthyThenStalled();
    const old = document.querySelector('#items');
    const replacement = document.createElement('div');
    replacement.id = 'items';
    const row = document.createElement('yt-live-chat-text-message-renderer');
    row.id = 'replacement';
    replacement.append(row);
    old?.replaceWith(replacement);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(clicks).toEqual([]);
  });

  it('contenteditableのtrue・空属性・plaintext-onlyを保護しfalseは除外する', () => {
    const input = document.querySelector<HTMLElement>('[contenteditable]');
    if (!input) throw new Error('input missing');
    input.textContent = '未送信の下書き';
    for (const value of ['', 'true', 'plaintext-only']) {
      input.setAttribute('contenteditable', value);
      expect(canRecoverLiveChat(document)).toBe(false);
    }
    input.setAttribute('contenteditable', 'false');
    expect(canRecoverLiveChat(document)).toBe(true);
  });

  it('途中でメニューが開かれた場合は遅延した復元で上書きしない', async () => {
    await healthyThenStalled();
    await vi.advanceTimersByTimeAsync(LIVE_CHAT_STALL_MS);
    document
      .querySelector('tp-yt-iron-dropdown')
      ?.removeAttribute('aria-hidden');
    await vi.advanceTimersByTimeAsync(1_500);
    expect(clicks).toEqual(['チャット']);
  });

  it('破棄時は監視と遅延したモード復元を停止する', async () => {
    await healthyThenStalled();
    await vi.advanceTimersByTimeAsync(LIVE_CHAT_STALL_MS);
    expect(clicks).toEqual(['チャット']);
    stop?.();
    stop = undefined;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(clicks).toEqual(['チャット']);
  });
});
