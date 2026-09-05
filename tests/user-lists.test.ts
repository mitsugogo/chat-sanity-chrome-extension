import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../lib/settings';
import {
  addHiddenUser,
  isHiddenUser,
  isWhitelistedUser,
  removeHiddenUser,
  whitelistUser,
} from '../lib/user-lists';
import type { ChatMessage } from '../lib/types';

const message = (channelId: string, patch: Partial<ChatMessage> = {}) =>
  ({
    id: '1',
    author: 'viewer',
    text: 'test',
    isOwner: false,
    isModerator: false,
    isMember: false,
    isPaidMessage: false,
    timestamp: 1,
    authorExternalChannelId: channelId,
    ...patch,
  }) satisfies ChatMessage;

describe('user lists', () => {
  it('非表示ユーザーを追加しホワイトリストへ移す', () => {
    const added = addHiddenUser(DEFAULT_SETTINGS, {
      channelId: 'UC-bad',
      displayName: '常習くん',
      addedAt: 10,
    });
    expect(isHiddenUser(added, message('UC-bad'))).toBe(true);
    const listed = whitelistUser(added, 'UC-bad');
    expect(isHiddenUser(listed, message('UC-bad'))).toBe(false);
    expect(isWhitelistedUser(listed, message('UC-bad'))).toBe(true);
    expect(removeHiddenUser(added, 'UC-bad').hiddenUsers).toEqual([]);
  });

  it('自分の投稿はホワイトリスト扱いし、ホワイトリストは非表示より優先する', () => {
    const settings = addHiddenUser(DEFAULT_SETTINGS, {
      channelId: 'UC-self',
      displayName: 'me',
      addedAt: 1,
    });
    expect(
      isWhitelistedUser(settings, message('UC-self', { isSelf: true })),
    ).toBe(true);
    expect(isHiddenUser(settings, message('UC-self', { isSelf: true }))).toBe(
      false,
    );
  });
});
