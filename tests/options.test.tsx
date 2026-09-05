import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  request: vi.fn(),
  sendMessage: vi.fn(),
}));

vi.mock('wxt/browser', () => ({
  browser: {
    storage: {
      sync: { get: mocks.get, set: mocks.set },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    permissions: { request: mocks.request },
    runtime: { sendMessage: mocks.sendMessage },
  },
}));

import App from '../entrypoints/options/App';
import { DEFAULT_SETTINGS } from '../lib/settings';
import type { RuntimeMessage } from '../lib/types';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue({});
  mocks.set.mockResolvedValue(undefined);
  mocks.request.mockResolvedValue(true);
  mocks.sendMessage.mockImplementation(async (message: RuntimeMessage) =>
    message.type === 'debug:get'
      ? { ok: true, entries: [] }
      : { ok: true, models: ['qwen3-8b'] },
  );
});

describe('options', () => {
  it('主要設定を表示し保存できる', async () => {
    render(<App />);
    expect(
      await screen.findByRole('heading', { name: 'フィルター設定' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('table', { name: 'カテゴリ設定' }),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('指示・指示厨の重み'), {
      target: { value: '0.9' },
    });
    fireEvent.click(screen.getByRole('button', { name: '設定を保存' }));
    await waitFor(() => expect(mocks.set).toHaveBeenCalled());
    expect(screen.getByText(/設定を保存しました/)).toBeInTheDocument();
  });

  it('ユーザー操作からローカル権限を要求してモデルを取得する', async () => {
    render(<App />);
    await screen.findByRole('heading', { name: 'ローカルAI設定' });
    fireEvent.click(screen.getByLabelText('LM Studioを使用する'));
    await waitFor(() => expect(mocks.request).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(screen.getByText('接続済み')).toBeInTheDocument(),
    );
    expect(
      screen.getByRole('option', { name: 'qwen3-8b' }),
    ).toBeInTheDocument();
  });

  it('診断プレビューをルールエンジンで判定する', async () => {
    render(<App />);
    await screen.findByRole('heading', { name: '診断プレビュー' });
    fireEvent.click(screen.getByRole('button', { name: '判定を試す' }));
    const result = await screen.findByLabelText('診断結果');
    expect(within(result).getByText('判定理由')).toBeInTheDocument();
    expect(within(result).getByText('指示・指示厨')).toBeInTheDocument();
  });

  it('デバッグモードの履歴と理由を表示して消去できる', async () => {
    const stored = structuredClone(DEFAULT_SETTINGS);
    stored.debugMode = true;
    mocks.get.mockResolvedValue({ settings: stored });
    mocks.sendMessage.mockImplementation(async (message: RuntimeMessage) => {
      if (message.type === 'debug:get') {
        return {
          ok: true,
          entries: [
            {
              id: 'debug-1',
              text: '今すぐ回復しろ',
              category: 'backseat',
              score: 0.9,
              action: 'hide',
              reasons: ['命令口調'],
              source: 'rules',
              timestamp: 1000,
            },
          ],
        };
      }
      return { ok: true };
    });
    render(<App />);
    expect(await screen.findByText('今すぐ回復しろ')).toBeInTheDocument();
    expect(screen.getByText('ルール: 命令口調')).toBeInTheDocument();
    expect(screen.getByText('スコア 0.90')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '履歴を消去' }));
    await waitFor(() =>
      expect(mocks.sendMessage).toHaveBeenCalledWith({ type: 'debug:clear' }),
    );
    expect(
      screen.getByText('対応されたチャットはまだありません。'),
    ).toBeInTheDocument();
  });
});

it('接続確認だけでは権限を要求しない', async () => {
  render(<App />);
  await screen.findByRole('heading', { name: 'ローカルAI設定' });
  fireEvent.click(screen.getByRole('button', { name: '接続を確認' }));
  await waitFor(() => expect(mocks.sendMessage).toHaveBeenCalled());
  expect(mocks.request).not.toHaveBeenCalled();
});
it('AI失敗の診断はルール結果と失敗理由を表示する', async () => {
  render(<App />);
  await screen.findByRole('heading', { name: 'ローカルAI設定' });
  fireEvent.click(screen.getByLabelText('LM Studioを使用する'));
  await screen.findByText('接続済み');
  mocks.sendMessage.mockResolvedValue({ ok: false, error: 'HTTP 500' });
  fireEvent.change(screen.getByLabelText('サンプルコメント'), {
    target: { value: '回復した方がいい' },
  });
  fireEvent.click(screen.getByRole('button', { name: '判定を試す' }));
  await screen.findByText(/ルール（AI失敗）/);
  expect(screen.getByText(/HTTP 500/)).toBeInTheDocument();
  expect(mocks.sendMessage).toHaveBeenLastCalledWith(
    expect.objectContaining({
      timeoutMs: 10000,
      responseFormat: 'json_schema',
    }),
  );
});
