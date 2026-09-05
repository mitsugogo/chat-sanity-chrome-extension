import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('options', () => {
  it('自動を既定にしユーザー操作からChrome AIを準備する', async () => {
    const setupSession = { destroy: vi.fn() };
    const create = vi.fn(
      async (options: {
        monitor?: (monitor: {
          addEventListener: (
            type: 'downloadprogress',
            listener: (event: { loaded: number }) => void,
          ) => void;
        }) => void;
      }) => {
        options.monitor?.({
          addEventListener: (_type, listener) => listener({ loaded: 0.5 }),
        });
        return setupSession;
      },
    );
    vi.stubGlobal('LanguageModel', {
      availability: vi.fn(async () => 'downloadable'),
      create,
    });
    render(<App />);
    expect(await screen.findByLabelText('自動（推奨）')).toBeChecked();
    expect(create).not.toHaveBeenCalled();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Chrome AIを準備する' }),
    );
    await screen.findByText('Chrome内蔵AIを利用できます');
    expect(create).toHaveBeenCalledOnce();
    expect(setupSession.destroy).toHaveBeenCalledOnce();
  });

  it('主要設定を表示し保存できる', async () => {
    render(<App />);
    expect(
      await screen.findByRole('heading', { name: 'フィルター設定' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('table', { name: 'カテゴリ設定' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Flow Chat連携' }),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText('Flow Chat連携を有効にする'),
    ).not.toBeChecked();
    expect(screen.getByLabelText('デバッグモード')).not.toBeChecked();
    expect(screen.getByLabelText('LM Studio')).not.toBeChecked();
    expect(screen.queryByLabelText('エンドポイント')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('モデル')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('AI応答形式')).not.toBeInTheDocument();
    const auditSwitch =
      screen.getByLabelText('未判定コメントをときどきAIで再確認');
    expect(auditSwitch).toBeChecked();
    fireEvent.click(auditSwitch);
    fireEvent.change(screen.getByLabelText('指示・指示厨の重み'), {
      target: { value: '0.9' },
    });
    fireEvent.click(screen.getByRole('button', { name: '設定を保存' }));
    await waitFor(() => expect(mocks.set).toHaveBeenCalled());
    expect(mocks.set).toHaveBeenCalledWith({
      settings: expect.objectContaining({
        lmStudio: expect.objectContaining({
          zeroScoreAudit: expect.objectContaining({ enabled: false }),
        }),
      }),
    });
    expect(screen.getByText(/設定を保存しました/)).toBeInTheDocument();
  });

  it('ユーザー操作からローカル権限を要求してモデルを取得する', async () => {
    render(<App />);
    await screen.findByRole('heading', { name: 'ローカルAI設定' });
    fireEvent.click(screen.getByLabelText('LM Studio'));
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
  const stored = structuredClone(DEFAULT_SETTINGS);
  stored.localAiMode = 'lm-studio';
  stored.lmStudio.enabled = true;
  mocks.get.mockResolvedValue({ settings: stored });
  render(<App />);
  await screen.findByRole('heading', { name: 'ローカルAI設定' });
  fireEvent.click(screen.getByRole('button', { name: '接続を確認' }));
  await waitFor(() => expect(mocks.sendMessage).toHaveBeenCalled());
  expect(mocks.request).not.toHaveBeenCalled();
});
it('AI失敗の診断はルール結果と失敗理由を表示する', async () => {
  render(<App />);
  await screen.findByRole('heading', { name: 'ローカルAI設定' });
  fireEvent.click(screen.getByLabelText('LM Studio'));
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
      type: 'local-ai:classify',
      items: [expect.objectContaining({ text: '回復した方がいい' })],
    }),
  );
});

it('Chrome内蔵AIではLM Studio専用項目を出さず共通設定だけ出す', async () => {
  render(<App />);
  await screen.findByRole('heading', { name: 'ローカルAI設定' });
  fireEvent.click(screen.getByLabelText('Chrome 内蔵AI'));
  expect(screen.getByLabelText('Chrome内蔵AIの状態')).toBeInTheDocument();
  expect(screen.queryByLabelText('エンドポイント')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('モデル')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('AI応答形式')).not.toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: '接続を確認' }),
  ).not.toBeInTheDocument();
  expect(screen.getByLabelText('AI応答の待ち時間（秒）')).toBeInTheDocument();
  expect(screen.getByLabelText('1回に送る最大件数')).toBeInTheDocument();
  expect(
    screen.getByLabelText('未判定コメントをときどきAIで再確認'),
  ).toBeInTheDocument();
  expect(
    screen.queryByText(/形式エラーの場合は互換形式を試せます/),
  ).not.toBeInTheDocument();
});

it('LM StudioからChrome内蔵AIへ切り替えると接続設定を隠す', async () => {
  render(<App />);
  await screen.findByRole('heading', { name: 'ローカルAI設定' });
  fireEvent.click(screen.getByLabelText('LM Studio'));
  expect(await screen.findByLabelText('エンドポイント')).toBeInTheDocument();
  expect(screen.getByLabelText('モデル')).toBeInTheDocument();
  expect(screen.getByLabelText('AI応答形式')).toBeInTheDocument();
  expect(screen.queryByLabelText('Chrome内蔵AIの状態')).not.toBeInTheDocument();
  expect(
    screen.getByText(/形式エラーの場合は互換形式を試せます/),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByLabelText('Chrome 内蔵AI'));
  expect(screen.queryByLabelText('エンドポイント')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('モデル')).not.toBeInTheDocument();
  expect(screen.getByLabelText('Chrome内蔵AIの状態')).toBeInTheDocument();
});

it('非表示ユーザーをホワイトリストへ移して保存できる', async () => {
  const stored = structuredClone(DEFAULT_SETTINGS);
  stored.hiddenUsers = [
    { channelId: 'UC-bad', displayName: '常習くん', addedAt: 1 },
  ];
  mocks.get.mockResolvedValue({ settings: stored });
  render(<App />);
  expect(await screen.findByText('常習くん')).toBeInTheDocument();
  fireEvent.click(
    screen.getByRole('button', { name: '常習くんをホワイトリストへ' }),
  );
  fireEvent.click(screen.getByRole('button', { name: '設定を保存' }));
  await waitFor(() => expect(mocks.set).toHaveBeenCalled());
  expect(mocks.set).toHaveBeenCalledWith({
    settings: expect.objectContaining({
      hiddenUsers: [],
      whitelistedUsers: [
        expect.objectContaining({
          channelId: 'UC-bad',
          displayName: '常習くん',
        }),
      ],
    }),
  });
});

it('使用しないを選ぶとAI設定を隠す', async () => {
  render(<App />);
  await screen.findByRole('heading', { name: 'ローカルAI設定' });
  fireEvent.click(screen.getByLabelText('使用しない'));
  expect(screen.queryByLabelText('Chrome内蔵AIの状態')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('エンドポイント')).not.toBeInTheDocument();
  expect(
    screen.queryByLabelText('AI応答の待ち時間（秒）'),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByLabelText('未判定コメントをときどきAIで再確認'),
  ).not.toBeInTheDocument();
});
