import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { DEFAULT_SETTINGS } from '../lib/settings';
import type { RuntimeMessage, RuntimeResponse, SettingsV1 } from '../lib/types';

const mocks = vi.hoisted(() => ({
  loadSettings: vi.fn<() => Promise<SettingsV1>>(),
  subscribeSettings:
    vi.fn<(listener: (settings: SettingsV1) => void) => () => void>(),
  sendMessage: vi.fn<(message: RuntimeMessage) => Promise<RuntimeResponse>>(),
}));
vi.mock('../lib/storage', () => ({
  loadSettings: mocks.loadSettings,
  subscribeSettings: mocks.subscribeSettings,
}));
vi.mock('wxt/browser', () => ({
  browser: { runtime: { sendMessage: mocks.sendMessage } },
}));

type Context = { onInvalidated: (callback: () => void) => void };
let main: (context: Context) => Promise<void>;
let invalidate: (() => void) | undefined;
let settings: SettingsV1;
const requests: Array<{
  request: Extract<RuntimeMessage, { type: 'lm:classify' }>;
  resolve: (response: RuntimeResponse) => void;
}> = [];

beforeAll(async () => {
  vi.stubGlobal('defineContentScript', (definition: { main: typeof main }) => {
    main = definition.main;
    return definition;
  });
  await import('../entrypoints/content');
});
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  requests.length = 0;
  settings = structuredClone(DEFAULT_SETTINGS);
  settings.lmStudio.enabled = true;
  settings.lmStudio.model = 'local-test';
  mocks.loadSettings.mockResolvedValue(settings);
  mocks.subscribeSettings.mockReturnValue(vi.fn());
  mocks.sendMessage.mockImplementation((message) => {
    if (message.type === 'lm:classify')
      return new Promise((resolve) =>
        requests.push({ request: message, resolve }),
      );
    return Promise.resolve({ ok: true });
  });
  document.body.innerHTML = '<div id="items"></div>';
});
afterEach(() => {
  invalidate?.();
  invalidate = undefined;
  vi.clearAllTimers();
  vi.useRealTimers();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});
function append(id: string, text = '回復した方がいい') {
  const element = document.createElement('yt-live-chat-text-message-renderer');
  element.id = id;
  const author = document.createElement('span');
  author.id = 'author-name';
  author.textContent = `private-author-${id}`;
  const message = document.createElement('span');
  message.id = 'message';
  message.textContent = text;
  element.append(author, message);
  document.querySelector('#items')?.append(element);
  return element;
}
async function start() {
  await main({
    onInvalidated: (callback) => {
      invalidate = callback;
    },
  });
}
function resolveRequest(index: number, score: number) {
  const pending = requests[index];
  if (!pending) throw new Error('AI request missing');
  pending.resolve({
    ok: true,
    results: pending.request.items.map((item) => ({
      id: item.id,
      category: 'backseat',
      score,
    })),
  });
}
function changeSettings(next: SettingsV1) {
  const callback = mocks.subscribeSettings.mock.calls[0]?.[0];
  if (!callback) throw new Error('settings listener missing');
  callback(next);
}

describe('content integration', () => {
  it('Flow Chat連携は安全な行もfilteredで確定し危険な行を除外する', async () => {
    settings.flowChat.enabled = true;
    settings.lmStudio.enabled = false;
    const safe = append('flow-safe', 'こんにちは');
    const risky = append('flow-risk', '死ね');
    await start();

    expect(document.documentElement).toHaveClass('ylcfr-active');
    expect(safe).toHaveClass('ylcfr-filtered-message');
    expect(safe).not.toHaveClass('ylcfr-deleted-message');
    expect(risky).toHaveClass(
      'ylcfr-filtered-message',
      'ylcfr-deleted-message',
    );
  });

  it('Flow Chat連携は非チャット要素もfail-openで確定する', async () => {
    settings.flowChat.enabled = true;
    settings.lmStudio.enabled = false;
    const placeholder = document.createElement('div');
    placeholder.textContent = 'loading';
    document.querySelector('#items')?.append(placeholder);
    await start();

    expect(placeholder).toHaveClass('ylcfr-filtered-message');
    expect(placeholder).not.toHaveClass('ylcfr-deleted-message');
  });

  it('本文を解析できないrendererもfail-openで確定する', async () => {
    settings.flowChat.enabled = true;
    settings.lmStudio.enabled = false;
    const renderer = document.createElement(
      'yt-live-chat-membership-item-renderer',
    );
    document.querySelector('#items')?.append(renderer);
    await start();

    expect(renderer).toHaveClass('ylcfr-filtered-message');
    expect(renderer).not.toHaveClass('ylcfr-deleted-message');
  });

  it('有効化後に追加されたFlow Chat観測要素も即時確定する', async () => {
    settings.flowChat.enabled = true;
    settings.lmStudio.enabled = false;
    await start();
    const placeholder = document.createElement('div');
    document.querySelector('#items')?.append(placeholder);
    await Promise.resolve();

    expect(placeholder).toHaveClass('ylcfr-filtered-message');
  });

  it('同じDOM行が更新された場合はFlow Chat判定も再実行する', async () => {
    settings.flowChat.enabled = true;
    settings.lmStudio.enabled = false;
    const item = append('flow-reused', '死ね');
    await start();
    expect(item).toHaveClass('ylcfr-deleted-message');

    item.querySelector('#message')!.textContent = 'こんにちは';
    await Promise.resolve();

    expect(item).toHaveClass('ylcfr-filtered-message');
    expect(item).not.toHaveClass('ylcfr-deleted-message');
  });

  it('Flow Chat連携OFFではprotocolクラスを書き込まない', async () => {
    settings.flowChat.enabled = false;
    settings.lmStudio.enabled = false;
    document.documentElement.classList.add('ylcfr-active');
    const item = append('flow-off', '死ね');
    await start();

    expect(document.documentElement).not.toHaveClass('ylcfr-active');
    expect(item).not.toHaveClass(
      'ylcfr-filtered-message',
      'ylcfr-deleted-message',
    );
    expect(item).toHaveClass('chatsanity-hidden');
  });

  it('Flow Chat連携のON/OFF連打でpendingとprotocol状態をリセットする', async () => {
    settings.flowChat.enabled = true;
    const item = append('flow-toggle', '回復した方がいい');
    await start();
    expect(item).toHaveClass('ylcfr-filtered-message');

    const off = structuredClone(settings);
    off.flowChat.enabled = false;
    changeSettings(off);
    expect(document.documentElement).not.toHaveClass('ylcfr-active');
    expect(item).toHaveClass('ylcfr-filtered-message');

    const on = structuredClone(off);
    on.flowChat.enabled = true;
    changeSettings(on);
    expect(document.documentElement).toHaveClass('ylcfr-active');
    expect(item).toHaveClass('ylcfr-filtered-message');
  });

  it('遅れて届くAI結果はFlow Chatの確定済み除外を変更しない', async () => {
    settings.flowChat.enabled = true;
    const item = append('flow-late-ai');
    await start();
    expect(item).toHaveClass('ylcfr-filtered-message');
    expect(item).not.toHaveClass('ylcfr-deleted-message');

    await vi.advanceTimersByTimeAsync(200);
    resolveRequest(0, 0.95);
    await vi.advanceTimersByTimeAsync(0);

    expect(item).toHaveClass('chatsanity-hidden');
    expect(item).not.toHaveClass('ylcfr-deleted-message');
  });

  it('デバッグ時はスコアを表示して対応理由を履歴へ送る', async () => {
    settings.debugMode = true;
    settings.lmStudio.enabled = false;
    const item = append('debug-item', '死ね');
    await start();
    expect(item.querySelector('.chatsanity-debug-score')).toHaveTextContent(
      '0.98',
    );
    expect(mocks.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'debug:add',
        entry: expect.objectContaining({
          text: '死ね',
          action: 'hide',
          reasons: expect.arrayContaining(['人格を攻撃する表現']),
        }),
      }),
    );
  });

  it('500msでルールへ戻し遅れて成功したAI結果を反映する', async () => {
    const item = append('youtube-id');
    await start();
    expect(item).toHaveClass('chatsanity-pending');
    await vi.advanceTimersByTimeAsync(500);
    expect(requests).toHaveLength(1);
    expect(item).not.toHaveClass('chatsanity-pending', 'chatsanity-hidden');
    const payload = requests[0]?.request.items[0];
    expect(payload).toEqual({
      id: expect.any(String),
      text: '回復した方がいい',
      sameAuthorRecent: [],
      recentRiskyMessages: [],
      conflictLevel: 0,
    });
    expect(payload?.id).not.toBe('youtube-id');
    resolveRequest(0, 0.95);
    await vi.advanceTimersByTimeAsync(0);
    expect(item).toHaveClass('chatsanity-hidden');
    expect(item.querySelector('#message')).toHaveTextContent(
      '回復した方がいい',
    );
  });
  it('デバッグ時はAI待機ラベルを残し、遅い結果で更新する', async () => {
    settings.debugMode = true;
    const item = append('slow-ai');
    await start();
    expect(item.querySelector('.chatsanity-ai-status')).toHaveTextContent(
      'AI検閲中',
    );
    await vi.advanceTimersByTimeAsync(500);
    expect(item.querySelector('.chatsanity-ai-status')).toHaveTextContent(
      'AI検閲中',
    );
    expect(item.querySelector('.chatsanity-debug-score')).toHaveTextContent(
      '0.42',
    );
    resolveRequest(0, 0.4);
    await vi.advanceTimersByTimeAsync(0);
    expect(item.querySelector('.chatsanity-ai-status')).not.toBeInTheDocument();
    expect(item.querySelector('.chatsanity-debug-score')).toHaveTextContent(
      '0.40',
    );
  });
  it('設定変更後は古いAI応答を無視して新モデルと新しい一時IDを使う', async () => {
    const item = append('youtube-id');
    await start();
    await vi.advanceTimersByTimeAsync(200);
    const next = structuredClone(settings);
    next.lmStudio.model = 'new-local';
    changeSettings(next);
    await vi.advanceTimersByTimeAsync(200);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.request.model).toBe('new-local');
    expect(requests[1]?.request.items[0]?.id).not.toBe(
      requests[0]?.request.items[0]?.id,
    );
    resolveRequest(0, 0.95);
    await vi.advanceTimersByTimeAsync(0);
    expect(item).not.toHaveClass('chatsanity-hidden');
    resolveRequest(1, 0.4);
    await vi.advanceTimersByTimeAsync(0);
    expect(item).not.toHaveClass('chatsanity-hidden', 'chatsanity-pending');
  });
  it('学習済みの同文は追加送信せず設定変更で学習とキャッシュを消す', async () => {
    const first = append('first');
    await start();
    await vi.advanceTimersByTimeAsync(200);
    resolveRequest(0, 0.95);
    await vi.advanceTimersByTimeAsync(0);
    expect(first).toHaveClass('chatsanity-hidden');
    const second = append('second');
    await vi.advanceTimersByTimeAsync(200);
    expect(requests).toHaveLength(1);
    expect(second).toHaveClass('chatsanity-hidden');
    expect(second.querySelector('#message')).toHaveAttribute(
      'aria-label',
      expect.stringContaining('指示'),
    );
    changeSettings(structuredClone(settings));
    await vi.advanceTimersByTimeAsync(200);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.request.items).toHaveLength(2);
    expect(second).toHaveClass('chatsanity-pending');
  });
  it('AI結果の本文キャッシュはTTL内だけ再利用する', async () => {
    const first = append('cache-first');
    await start();
    await vi.advanceTimersByTimeAsync(200);
    resolveRequest(0, 0.4);
    await vi.advanceTimersByTimeAsync(0);
    expect(first).not.toHaveClass('chatsanity-pending');

    const second = append('cache-second');
    await vi.advanceTimersByTimeAsync(200);
    expect(requests).toHaveLength(1);
    expect(second).not.toHaveClass('chatsanity-pending');

    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1);
    const third = append('cache-third');
    await vi.advanceTimersByTimeAsync(200);
    expect(requests).toHaveLength(2);
    expect(third).toHaveClass('chatsanity-pending');
  });
  it('0点のルール未一致を抽選で監査し同文はキャッシュから再利用する', async () => {
    settings.debugMode = true;
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const first = append('audit-first', 'さっさと進んだら？');
    await start();
    expect(first).toHaveClass('chatsanity-pending');

    await vi.advanceTimersByTimeAsync(200);
    expect(requests).toHaveLength(1);
    resolveRequest(0, 0.95);
    await vi.advanceTimersByTimeAsync(0);
    expect(first).toHaveClass('chatsanity-hidden');
    expect(mocks.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'debug:add',
        entry: expect.objectContaining({
          source: 'lm-studio-audit',
          reasons: expect.arrayContaining(['Zero-score Audit', '急かす表現']),
        }),
      }),
    );

    const second = append('audit-second', 'さっさと進んだら？');
    await vi.advanceTimersByTimeAsync(0);
    expect(requests).toHaveLength(1);
    expect(second).toHaveClass('chatsanity-hidden');
  });

  it('監査抽選から外れた0点コメントは待機表示せず許可する', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    const item = append('audit-skip', 'さっさと進んだら？');
    await start();
    await vi.advanceTimersByTimeAsync(200);
    expect(requests).toHaveLength(0);
    expect(item).not.toHaveClass('chatsanity-pending', 'chatsanity-hidden');
  });

  it('許可語句に一致した0点コメントは監査しない', async () => {
    settings.allowedWords = ['さっさと進んだら？'];
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const item = append('audit-safe', 'さっさと進んだら？');
    await start();
    await vi.advanceTimersByTimeAsync(200);
    expect(requests).toHaveLength(0);
    expect(item).not.toHaveClass('chatsanity-pending', 'chatsanity-hidden');
  });
  it('監査通信の失敗はルール表示へ戻し30秒間再試行しない', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const first = append('audit-failure', 'さっさと進んだら？');
    await start();
    await vi.advanceTimersByTimeAsync(200);
    requests[0]?.resolve({ ok: false, error: 'offline' });
    await vi.advanceTimersByTimeAsync(0);
    expect(first).not.toHaveClass('chatsanity-pending', 'chatsanity-hidden');

    const second = append('audit-cooldown', 'いい加減気づいて');
    await vi.advanceTimersByTimeAsync(200);
    expect(requests).toHaveLength(1);
    expect(second).not.toHaveClass('chatsanity-pending', 'chatsanity-hidden');
  });
  it('AI無効化後に遅い応答が届いてもルール表示を維持する', async () => {
    const item = append('youtube-id');
    await start();
    await vi.advanceTimersByTimeAsync(200);
    const next = structuredClone(settings);
    next.lmStudio.enabled = false;
    changeSettings(next);
    resolveRequest(0, 0.95);
    await vi.advanceTimersByTimeAsync(500);
    expect(item).not.toHaveClass('chatsanity-hidden', 'chatsanity-pending');
    expect(requests).toHaveLength(1);
  });
});
