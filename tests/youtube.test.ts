import { describe, expect, it } from 'vitest';
import {
  chatMessageSignature,
  findChatItems,
  parseChatMessage,
} from '../lib/youtube/adapter';
import { ChatProcessingTracker } from '../lib/youtube/processing-tracker';
import { renderPending, renderResult } from '../lib/youtube/renderer';

function createChatItem() {
  const root = document.createElement('div');
  root.innerHTML = `<yt-live-chat-text-message-renderer id="abc">
    <span id="author-name">viewer</span>
    <span id="message">そっちに行った方がいい</span>
  </yt-live-chat-text-message-renderer>`;
  return root;
}

describe('YouTube adapter', () => {
  it('追加ノードからチャット要素を探索して内部型へ変換する', () => {
    const root = createChatItem();
    const items = findChatItems(root);
    expect(items).toHaveLength(1);
    expect(parseChatMessage(items[0]!)).toMatchObject({
      id: 'abc',
      author: 'viewer',
      text: 'そっちに行った方がいい',
      isOwner: false,
      isModerator: false,
      isMember: false,
    });
  });

  it('YouTubeのバッジ属性を判別する', () => {
    const root = createChatItem();
    const item = findChatItems(root)[0]!;
    item.insertAdjacentHTML(
      'beforeend',
      '<span id="chat-badges"><span type="moderator"></span></span>',
    );
    expect(parseChatMessage(item)).toMatchObject({ isModerator: true });
  });

  it('後から追加された本文ノードから親のチャット要素を探索する', () => {
    const root = createChatItem();
    const message = root.querySelector('#message')!;

    expect(findChatItems(message.firstChild!)).toEqual([
      root.querySelector('yt-live-chat-text-message-renderer'),
    ]);
  });

  it('同じDOM要素が別の本文へ更新された場合は再処理する', () => {
    const item = findChatItems(createChatItem())[0]!;
    const tracker = new ChatProcessingTracker();
    const first = parseChatMessage(item)!;
    const firstToken = tracker.begin(item, chatMessageSignature(first));

    expect(firstToken).not.toBeNull();
    expect(tracker.begin(item, chatMessageSignature(first))).toBeNull();

    item.querySelector('#message')!.textContent = '別のコメント';
    const updated = parseChatMessage(item)!;
    const updatedToken = tracker.begin(item, chatMessageSignature(updated));

    expect(updatedToken).not.toBeNull();
    expect(tracker.isCurrent(firstToken!)).toBe(false);
    expect(tracker.isCurrent(updatedToken!)).toBe(true);
  });

  it('設定変更前に開始した非同期判定を無効化する', () => {
    const item = findChatItems(createChatItem())[0]!;
    const tracker = new ChatProcessingTracker();
    const message = parseChatMessage(item)!;
    const oldToken = tracker.begin(item, chatMessageSignature(message))!;

    tracker.reset();

    expect(tracker.isCurrent(oldToken)).toBe(false);
    expect(
      tracker.begin(item, chatMessageSignature(message)),
    ).not.toBeNull();
  });
});

describe('YouTube renderer', () => {
  it('判定中表示から控えめな非表示状態へ更新し原文を復元できる', () => {
    const item = findChatItems(createChatItem())[0]!;
    renderPending(item);
    expect(item).toHaveClass('chatsanity-pending');
    expect(item.querySelector('.chatsanity-placeholder')).toHaveTextContent(
      '判定中',
    );

    renderResult(item, {
      score: 0.95,
      categories: ['instruction'],
      reasons: ['命令口調'],
      action: 'hide',
      needsAi: false,
    });
    const placeholder = item.querySelector<HTMLButtonElement>(
      '.chatsanity-placeholder',
    )!;
    expect(item).toHaveClass('chatsanity-hidden');
    expect(item.querySelector('#message')).toHaveTextContent(
      'そっちに行った方がいい',
    );
    expect(placeholder).toHaveTextContent('非表示');
    expect(placeholder).toHaveAttribute(
      'aria-label',
      '指示として非表示。クリックして原文と判定理由を表示',
    );
    expect(placeholder).toHaveAttribute('aria-expanded', 'false');
    placeholder.click();
    expect(item).toHaveClass('chatsanity-revealed');
    expect(placeholder).toHaveTextContent('指示: 命令口調（再び隠す）');
    expect(placeholder).toHaveAttribute('aria-expanded', 'true');
  });
});
