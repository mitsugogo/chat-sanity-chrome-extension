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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue({});
  mocks.set.mockResolvedValue(undefined);
  mocks.request.mockResolvedValue(true);
  mocks.sendMessage.mockResolvedValue({ ok: true, models: ['qwen3-8b'] });
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
    fireEvent.change(screen.getByLabelText('指示の重み'), {
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
    expect(within(result).getByText('指示')).toBeInTheDocument();
  });
});
