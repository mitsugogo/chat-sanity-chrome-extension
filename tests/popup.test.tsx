import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  query: vi.fn(),
  sendMessage: vi.fn(),
  openOptionsPage: vi.fn(),
}));

vi.mock('wxt/browser', () => ({
  browser: {
    storage: {
      sync: { get: mocks.get, set: mocks.set },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    tabs: { query: mocks.query },
    runtime: {
      sendMessage: mocks.sendMessage,
      openOptionsPage: mocks.openOptionsPage,
    },
  },
}));

import App from '../entrypoints/popup/App';
import { DEFAULT_SETTINGS } from '../lib/settings';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue({
    settings: {
      ...DEFAULT_SETTINGS,
      lmStudio: { ...DEFAULT_SETTINGS.lmStudio, enabled: true },
    },
  });
  mocks.query.mockResolvedValue([{ id: 10 }]);
  mocks.sendMessage.mockResolvedValue({
    ok: true,
    summary: {
      active: true,
      hidden: 24,
      blurred: 11,
      lmStudio: 'connected',
      localAi: { activeProvider: 'lm-studio', status: 'ready' },
    },
  });
  mocks.set.mockResolvedValue(undefined);
});

describe('popup', () => {
  it('セッション状態を表示してプリセットを保存する', async () => {
    render(<App />);
    expect(
      await screen.findByText('YouTubeチャットで動作中'),
    ).toBeInTheDocument();
    expect(screen.getByText('24')).toBeInTheDocument();
    expect(screen.getByText('LM Studio 利用可能')).toBeInTheDocument();
    expect(mocks.sendMessage).toHaveBeenCalledWith({
      type: 'session:get-summary',
      tabId: 10,
    });
    fireEvent.click(screen.getByRole('radio', { name: '通常' }));
    await waitFor(() => expect(mocks.set).toHaveBeenCalled());
    expect(screen.getByRole('radio', { name: '通常' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('詳細設定を開く', async () => {
    render(<App />);
    await screen.findByText('フィルタープリセット');
    fireEvent.click(screen.getByRole('button', { name: '詳細設定を開く' }));
    expect(mocks.openOptionsPage).toHaveBeenCalledOnce();
  });

  it('ローカルAIが無効な場合はAI状態を表示しない', async () => {
    mocks.get.mockResolvedValue({
      settings: { ...DEFAULT_SETTINGS, localAiMode: 'disabled' },
    });
    render(<App />);
    await screen.findByText('YouTubeチャットで動作中');
    expect(
      screen.queryByRole('region', { name: 'ローカルAIの状態' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('ローカルAI 無効')).not.toBeInTheDocument();
  });
});
