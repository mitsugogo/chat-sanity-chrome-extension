import { describe, expect, it } from 'vitest';
import { trimChatItems } from '../lib/youtube/chat-retention';

describe('chat retention', () => {
  it('古いチャット行だけを除き、新しい行と構造要素を残す', () => {
    const container = document.createElement('div');
    const structural = document.createElement('div');
    structural.id = 'sentinel';
    const first = document.createElement('yt-live-chat-text-message-renderer');
    const second = document.createElement('yt-live-chat-paid-message-renderer');
    const third = document.createElement('yt-live-chat-paid-sticker-renderer');
    container.append(first, structural, second, third);

    expect(trimChatItems(container, 2)).toBe(1);
    expect(Array.from(container.children)).toEqual([structural, second, third]);
    expect(trimChatItems(container, 2)).toBe(0);
  });

  it('対象がない場合と無効な上限ではDOMを変更しない', () => {
    const container = document.createElement('div');
    const item = document.createElement('yt-live-chat-text-message-renderer');
    container.append(item);

    expect(trimChatItems(null)).toBe(0);
    expect(trimChatItems(container, 0)).toBe(0);
    expect(container.firstElementChild).toBe(item);
  });
});
