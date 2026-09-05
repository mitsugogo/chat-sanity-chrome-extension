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

  it('投稿者の外部IDとカスタム絵文字の代替文字を抽出する', () => {
    const root = document.createElement('div');
    root.innerHTML = `<yt-live-chat-text-message-renderer id="emoji">
      <span id="author-name" data-author-id="UC-test">viewer</span>
      <span id="message"><img alt=":mikoKusa:"></span>
    </yt-live-chat-text-message-renderer>`;
    const item = findChatItems(root)[0]!;

    expect(parseChatMessage(item)).toMatchObject({
      text: ':mikoKusa:',
      authorExternalChannelId: 'UC-test',
    });
  });

  it('本文とカスタム絵文字が混在しても順序を保つ', () => {
    const root = document.createElement('div');
    root.innerHTML = `<yt-live-chat-text-message-renderer id="mixed">
      <span id="message">草<img alt=":mikoKusa:"> ナイス</span>
    </yt-live-chat-text-message-renderer>`;
    const item = findChatItems(root)[0]!;

    expect(parseChatMessage(item)?.text).toBe('草 :mikoKusa: ナイス');
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
    expect(tracker.begin(item, chatMessageSignature(message))).not.toBeNull();
  });
});

describe('YouTube renderer', () => {
  it('判定中表示から行全体のぼかしへ更新し原文を一時表示できる', () => {
    const item = findChatItems(createChatItem())[0]!;
    renderPending(item);
    expect(item).toHaveClass('chatsanity-pending');
    expect(item.querySelector('.chatsanity-placeholder')).toHaveTextContent(
      '判定中',
    );

    renderResult(item, {
      score: 0.95,
      categories: ['backseat'],
      reasons: ['命令口調'],
      action: 'hide',
      needsAi: false,
    });
    expect(item).toHaveClass('chatsanity-hidden');
    expect(item.querySelector('#message')).toHaveTextContent(
      'そっちに行った方がいい',
    );
    expect(
      item.querySelector('.chatsanity-placeholder'),
    ).not.toBeInTheDocument();
    const message = item.querySelector<HTMLElement>('#message')!;
    expect(message).toHaveAttribute(
      'aria-label',
      '指示・指示厨として非表示。判定理由: 命令口調。クリックして原文を表示',
    );
    expect(message).toHaveAttribute(
      'title',
      '指示・指示厨: 命令口調。クリックして一時表示',
    );
    message.click();
    expect(item).toHaveClass('chatsanity-revealed');
  });

  it('デバッグ時だけAI検閲中ラベルと判定スコアを表示する', () => {
    const item = findChatItems(createChatItem())[0]!;
    renderPending(item, true);
    expect(item.querySelector('.chatsanity-ai-status')).toHaveTextContent(
      'AI検閲中',
    );
    renderResult(
      item,
      {
        score: 0.72,
        categories: ['backseat'],
        reasons: ['行動を指示する表現'],
        action: 'dim',
        needsAi: false,
      },
      undefined,
      true,
    );
    expect(item.querySelector('.chatsanity-ai-status')).not.toBeInTheDocument();
    expect(item.querySelector('.chatsanity-debug-score')).toHaveTextContent(
      '0.72',
    );
    expect(item.querySelector('.chatsanity-debug-score')).toHaveAttribute(
      'aria-label',
      '判定スコア 0.72',
    );
    renderResult(item, {
      score: 0,
      categories: ['safe'],
      reasons: ['ルールに一致しませんでした'],
      action: 'allow',
      needsAi: false,
    });
    expect(
      item.querySelector('.chatsanity-debug-score'),
    ).not.toBeInTheDocument();
    expect(item.querySelector('#message')).not.toHaveAttribute('aria-label');
  });
});
