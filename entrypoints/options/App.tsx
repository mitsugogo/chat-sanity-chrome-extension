import { useCallback, useEffect, useMemo, useState } from 'react';
import { browser } from 'wxt/browser';
import { Logo } from '../../components/Logo';
import { Switch } from '../../components/Switch';
import { mergeAiResult, createFilterEngine } from '../../lib/filter/engine';
import { normalizeText } from '../../lib/filter/normalize';
import {
  createFeedbackEntry,
  FEEDBACK_CATEGORY_CHOICES,
  type FeedbackEntry,
  type FeedbackJudgement,
  type ExactFeedbackResult,
  type FeedbackSummary,
  type RuleFeedbackStats,
} from '../../lib/feedback/types';
import { CLASSIFIER_PROMPT_VERSION } from '../../lib/local-ai/prompt';
import {
  getChromeBuiltInAvailability,
  prepareChromeBuiltInAi,
} from '../../lib/local-ai/providers/chrome-built-in';
import {
  CATEGORY_LABELS,
  CONFIGURABLE_CATEGORY_KEYS,
  DEFAULT_SETTINGS,
  PRESET_LABELS,
  cleanWords,
  normalizeFlowChat,
  normalizeLmStudio,
} from '../../lib/settings';
import { loadSettings, saveSettings } from '../../lib/storage';
import {
  normalizeTrackedUsers,
  removeHiddenUser,
  removeWhitelistedUser,
  whitelistUser,
} from '../../lib/user-lists';
import type {
  ConfigurableCategory,
  DiagnosticEntry,
  FilterCategory,
  FilterMode,
  PresetId,
  RuntimeMessage,
  RuntimeResponse,
  SettingsV1,
  FlowChatMetricsSnapshot,
  LocalAiAvailability,
  TrackedUser,
} from '../../lib/types';

const CATEGORY_DESCRIPTIONS: Record<ConfigurableCategory, string> = {
  backseat: '配信者や参加者への指示・指図',
  blame: '失敗や状況の責任を特定人物へ押し付ける表現',
  personal_attack: '能力・人格・適性への攻撃',
  meta_conflict: '自治・コメント欄の喧嘩や荒れの話題',
  complaint: '強い攻撃ではない進行・配信への不満',
  abuse: '暴言・罵倒・差別的表現など',
  instruction: '過度な指示・命令口調・支配的言動',
  pigeon: '別配信・別視点の情報持ち込み',
  comparison: '配信者同士の比較・責任追及',
  concern: '根拠のない不安・過度な心配',
  spoiler: '未視聴者への先の展開の明示',
};

const CATEGORY_KEYS = [...CONFIGURABLE_CATEGORY_KEYS] as ConfigurableCategory[];
const PERMISSION_ORIGINS = ['http://127.0.0.1/*', 'http://localhost/*'];
const ACTION_LABELS = {
  allow: '表示',
  dim: '薄く表示',
  blur: 'ぼかし',
  hide: '非表示',
} as const;
const MODE_LABELS: Record<FilterMode, string> = {
  threshold: 'スコアに従う',
  allow: '表示',
  dim: '薄く表示',
  blur: 'ぼかす',
  hide: '非表示',
};

export default function App() {
  const [settings, setSettings] = useState<SettingsV1>(DEFAULT_SETTINGS);
  const [models, setModels] = useState<string[]>([]);
  const [connection, setConnection] = useState<
    'idle' | 'testing' | 'online' | 'offline'
  >('idle');
  const [connectionMessage, setConnectionMessage] = useState('未確認');
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [testText, setTestText] = useState(
    'それは違うよ。君は間違ってるからやめた方がいい。',
  );
  const [diagnostic, setDiagnostic] = useState<DiagnosticEntry | null>(null);
  const [testing, setTesting] = useState(false);
  const [debugEntries, setDebugEntries] = useState<DiagnosticEntry[]>([]);
  const [debugError, setDebugError] = useState('');
  const [feedbackEntries, setFeedbackEntries] = useState<FeedbackEntry[]>([]);
  const [feedbackStats, setFeedbackStats] = useState<RuleFeedbackStats[]>([]);
  const [feedbackSummary, setFeedbackSummary] =
    useState<FeedbackSummary | null>(null);
  const [feedbackError, setFeedbackError] = useState('');
  const [feedbackLoading, setFeedbackLoading] = useState(false);
  const [flowMetrics, setFlowMetrics] =
    useState<FlowChatMetricsSnapshot | null>(null);
  const [chromeAiAvailability, setChromeAiAvailability] =
    useState<LocalAiAvailability>('unavailable');
  const [chromeAiProgress, setChromeAiProgress] = useState<number | null>(null);
  const [chromeAiMessage, setChromeAiMessage] =
    useState('状態を確認しています…');

  useEffect(() => {
    let cancelled = false;
    void loadSettings().then((stored) => {
      if (!cancelled) setSettings(stored);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void getChromeBuiltInAvailability().then((availability) => {
      if (cancelled) return;
      setChromeAiAvailability(availability);
      setChromeAiMessage(chromeAvailabilityLabel(availability));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshDebugHistory = useCallback(async () => {
    try {
      const response = (await browser.runtime.sendMessage({
        type: 'debug:get',
      } satisfies RuntimeMessage)) as RuntimeResponse;
      if (!response.ok || !('entries' in response)) {
        throw new Error(
          response.ok ? 'デバッグ履歴を取得できませんでした。' : response.error,
        );
      }
      setDebugEntries(response.entries);
      setFlowMetrics(response.flowMetrics ?? null);
      setDebugError('');
    } catch (error) {
      setDebugError(
        error instanceof Error
          ? error.message
          : 'デバッグ履歴を取得できませんでした。',
      );
    }
  }, []);

  const refreshFeedback = useCallback(async () => {
    setFeedbackLoading(true);
    try {
      const [entriesResponse, statsResponse] = (await Promise.all([
        browser.runtime.sendMessage({
          type: 'feedback:list',
        } satisfies RuntimeMessage),
        browser.runtime.sendMessage({
          type: 'feedback:stats',
        } satisfies RuntimeMessage),
      ])) as [RuntimeResponse, RuntimeResponse];
      if (!entriesResponse.ok || !('feedbackEntries' in entriesResponse)) {
        throw new Error(
          entriesResponse.ok
            ? 'フィードバック一覧を取得できませんでした。'
            : entriesResponse.error,
        );
      }
      if (
        !statsResponse.ok ||
        !('feedbackStats' in statsResponse) ||
        !('feedbackSummary' in statsResponse)
      ) {
        throw new Error(
          statsResponse.ok
            ? 'フィードバック統計を取得できませんでした。'
            : statsResponse.error,
        );
      }
      setFeedbackEntries(entriesResponse.feedbackEntries);
      setFeedbackStats(statsResponse.feedbackStats);
      setFeedbackSummary(statsResponse.feedbackSummary);
      setFeedbackError('');
    } catch (error) {
      setFeedbackError(
        error instanceof Error
          ? error.message
          : 'フィードバックを取得できませんでした。',
      );
    } finally {
      setFeedbackLoading(false);
    }
  }, []);

  const submitFeedback = useCallback(
    async (
      diagnosticEntry: DiagnosticEntry,
      judgement: FeedbackJudgement,
      correctCategory: FilterCategory,
    ) => {
      const entry = createFeedbackEntry({
        diagnostic: diagnosticEntry,
        normalizedText:
          diagnosticEntry.normalizedText ?? normalizeText(diagnosticEntry.text),
        judgement,
        correctCategory,
        messageId: diagnosticEntry.id,
      });
      const response = (await browser.runtime.sendMessage({
        type: 'feedback:add',
        entry,
      } satisfies RuntimeMessage)) as RuntimeResponse;
      if (!response.ok)
        throw new Error(
          response.error || 'フィードバックを保存できませんでした。',
        );
      await refreshFeedback();
    },
    [refreshFeedback],
  );

  const exportFeedback = useCallback(async () => {
    try {
      const response = (await browser.runtime.sendMessage({
        type: 'feedback:export',
      } satisfies RuntimeMessage)) as RuntimeResponse;
      if (!response.ok || !('jsonl' in response)) {
        throw new Error(
          response.ok
            ? 'フィードバックをエクスポートできませんでした。'
            : response.error,
        );
      }
      if (typeof URL.createObjectURL !== 'function')
        throw new Error('この画面ではダウンロードを開始できません。');
      const blob = new Blob([response.jsonl], {
        type: 'application/x-ndjson;charset=utf-8',
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `chat-sanity-feedback-${new Date().toISOString().slice(0, 10)}.jsonl`;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      setFeedbackError('');
    } catch (error) {
      setFeedbackError(
        error instanceof Error
          ? error.message
          : 'フィードバックをエクスポートできませんでした。',
      );
    }
  }, []);

  const clearFeedback = useCallback(async () => {
    if (!window.confirm('保存済みのフィードバックをすべて消去しますか？'))
      return;
    try {
      const response = (await browser.runtime.sendMessage({
        type: 'feedback:clear',
      } satisfies RuntimeMessage)) as RuntimeResponse;
      if (!response.ok)
        throw new Error(
          response.error || 'フィードバックを消去できませんでした。',
        );
      await refreshFeedback();
    } catch (error) {
      setFeedbackError(
        error instanceof Error
          ? error.message
          : 'フィードバックを消去できませんでした。',
      );
    }
  }, [refreshFeedback]);

  useEffect(() => {
    void refreshFeedback();
  }, [refreshFeedback]);

  useEffect(() => {
    if (!settings.debugMode) {
      setFlowMetrics(null);
      return;
    }
    void refreshDebugHistory();
    const interval = window.setInterval(() => {
      void refreshDebugHistory();
    }, 2_000);
    return () => window.clearInterval(interval);
  }, [refreshDebugHistory, settings.debugMode]);

  const profile = settings.profiles[settings.activePreset];
  const selectedModelOptions = useMemo(
    () =>
      Array.from(new Set([settings.lmStudio.model, ...models])).filter(Boolean),
    [models, settings.lmStudio.model],
  );

  const updateProfile = (nextProfile: typeof profile) => {
    setSettings((current) => ({
      ...current,
      profiles: { ...current.profiles, [current.activePreset]: nextProfile },
    }));
  };

  const testConnection = async (requestPermission: boolean) => {
    setConnection('testing');
    setConnectionMessage('接続を確認しています…');
    try {
      if (requestPermission) {
        const granted = await browser.permissions.request({
          origins: PERMISSION_ORIGINS,
        });
        if (!granted)
          throw new Error('ローカル接続の権限が許可されませんでした。');
      }
      const response = (await browser.runtime.sendMessage({
        type: 'lm:list-models',
        endpoint: settings.lmStudio.endpoint,
      } satisfies RuntimeMessage)) as RuntimeResponse;
      if (!response.ok || !('models' in response)) {
        throw new Error(
          response.ok ? 'モデル一覧を取得できませんでした。' : response.error,
        );
      }
      setModels(response.models);
      setSettings((current) => ({
        ...current,
        lmStudio: {
          ...current.lmStudio,
          model: current.lmStudio.model || response.models[0] || '',
        },
      }));
      setConnection('online');
      setConnectionMessage(
        response.models.length > 0 ? '接続済み' : '接続済み・モデル未読込',
      );
      return true;
    } catch (error) {
      setConnection('offline');
      setConnectionMessage(
        error instanceof Error ? error.message : '接続できませんでした。',
      );
      return false;
    }
  };

  const selectLocalAiMode = async (mode: SettingsV1['localAiMode']) => {
    setSettings((current) => ({
      ...current,
      localAiMode: mode,
      ...(mode === 'lm-studio'
        ? { lmStudio: { ...current.lmStudio, enabled: true } }
        : mode === 'chrome-built-in'
          ? { chromeBuiltIn: { enabled: true } }
          : {}),
    }));
    if (mode === 'lm-studio') {
      await testConnection(true);
    } else if (mode === 'disabled') {
      setConnection('idle');
      setConnectionMessage('無効');
    }
  };

  const prepareChromeAi = async () => {
    setChromeAiProgress(0);
    setChromeAiMessage('Chrome AIモデルをダウンロード中…');
    try {
      await prepareChromeBuiltInAi(setChromeAiProgress);
      setChromeAiAvailability('available');
      setChromeAiMessage('Chrome内蔵AIを利用できます');
    } catch (error) {
      setChromeAiAvailability('error');
      setChromeAiMessage(
        error instanceof Error
          ? error.message
          : 'Chrome内蔵AIの準備に失敗しました。',
      );
    } finally {
      setChromeAiProgress(null);
    }
  };

  const save = async () => {
    const safeSettings = sanitizeSettings(settings);
    setSettings(safeSettings);
    await saveSettings(safeSettings);
    if (!safeSettings.debugMode) {
      await browser.runtime.sendMessage({
        type: 'debug:clear',
      } satisfies RuntimeMessage);
      setDebugEntries([]);
      setFlowMetrics(null);
    }
    setSavedAt(new Date());
  };

  const clearDebugHistory = async () => {
    await browser.runtime.sendMessage({
      type: 'debug:clear',
    } satisfies RuntimeMessage);
    setDebugEntries([]);
    setFlowMetrics(null);
    setDebugError('');
  };

  const runDiagnostic = async () => {
    setTesting(true);
    const message = {
      id: crypto.randomUUID(),
      author: 'サンプル視聴者',
      text: testText,
      isOwner: false,
      isModerator: false,
      isMember: false,
      isPaidMessage: false,
      timestamp: Date.now(),
    };
    const diagnosticSettings = sanitizeSettings(settings);
    const normalizedText = normalizeText(testText);
    let exactFeedback: ExactFeedbackResult | null = null;
    try {
      const response = (await browser.runtime.sendMessage({
        type: 'feedback:lookup-exact',
        normalizedText,
      } satisfies RuntimeMessage)) as RuntimeResponse;
      if (response.ok && 'exactFeedback' in response)
        exactFeedback = response.exactFeedback;
    } catch {
      // A diagnostic must remain usable when IndexedDB or the worker is unavailable.
    }
    const base = createFilterEngine()(
      message,
      diagnosticSettings,
      undefined,
      undefined,
      exactFeedback,
    );
    let entry: DiagnosticEntry = {
      id: message.id,
      text: testText,
      normalizedText,
      category: base.categories[0] ?? 'safe',
      score: base.score,
      action: base.action,
      reasons: base.reasons,
      ...(base.ruleIds ? { ruleIds: base.ruleIds } : {}),
      ...(base.features ? { features: base.features } : {}),
      ...(typeof base.contextAdjustment === 'number'
        ? { contextAdjustment: base.contextAdjustment }
        : {}),
      source: base.source ?? 'rules',
      classifierPromptVersion: CLASSIFIER_PROMPT_VERSION,
      timestamp: message.timestamp,
    };

    if (base.needsAi) {
      try {
        const response = (await browser.runtime.sendMessage({
          type: 'local-ai:classify',
          items: [{ id: message.id, text: normalizeText(testText) }],
        } satisfies RuntimeMessage)) as RuntimeResponse;
        if (!response.ok || !('results' in response) || !response.results[0]) {
          throw new Error(
            response.ok ? '分類結果を取得できませんでした' : response.error,
          );
        }
        const merged = mergeAiResult(
          base,
          response.results[0],
          diagnosticSettings,
        );
        entry = {
          ...entry,
          category: merged.categories[0] ?? 'safe',
          score: merged.score,
          action: merged.action,
          reasons: merged.reasons,
          ...(merged.ruleIds ? { ruleIds: merged.ruleIds } : {}),
          ...(merged.features ? { features: merged.features } : {}),
          ...(typeof merged.contextAdjustment === 'number'
            ? { contextAdjustment: merged.contextAdjustment }
            : {}),
          source: 'local-ai',
          aiProvider: response.providerId,
          aiReason: 'uncertain-score',
          aiLatencyMs: response.latencyMs,
          ...(typeof (
            response.results[0].confidence ?? response.results[0].score
          ) === 'number'
            ? {
                aiConfidence:
                  response.results[0].confidence ?? response.results[0].score,
              }
            : {}),
        };
      } catch (error) {
        entry = {
          ...entry,
          source: 'fallback',
          reasons: [
            ...entry.reasons,
            `AI判定に失敗したためルール結果を表示: ${error instanceof Error ? error.message : '接続できませんでした'}`,
          ],
        };
      }
    }
    setDiagnostic(entry);
    setTesting(false);
  };

  const aiMode = settings.localAiMode;
  const showChromeAi = aiMode === 'auto' || aiMode === 'chrome-built-in';
  const showLmStudio = aiMode === 'lm-studio';
  const showSharedAi = aiMode !== 'disabled';

  return (
    <div className="options-shell">
      <aside className="sidebar">
        <Logo />
        <nav aria-label="設定メニュー">
          <a href="#filter" className="is-active">
            フィルター
          </a>
          <a href="#hidden-users">非表示ユーザー</a>
          <a href="#local-ai">ローカルAI</a>
          <a href="#flow-chat">Flow Chat連携</a>
          <a href="#diagnostic">診断</a>
          <a href="#feedback">フィードバック</a>
          <a href="#debug-history">デバッグ履歴</a>
        </nav>
        <div className="sidebar-footer">
          <span>設定はChrome同期に保存</span>
          <span>明示したフィードバックだけ端末内に保存</span>
        </div>
      </aside>

      <main className="options-main">
        <header className="page-header" id="filter">
          <div>
            <h1>フィルター設定</h1>
            <p>
              {PRESET_LABELS[settings.activePreset]}プリセットを編集しています
            </p>
          </div>
          <div className="header-toggle">
            <span>フィルターを有効にする</span>
            <Switch
              checked={settings.enabled}
              onChange={(enabled) =>
                setSettings((current) => ({ ...current, enabled }))
              }
              label="フィルターを有効にする"
            />
          </div>
        </header>

        <div className="content-grid">
          <div className="primary-column">
            <section className="panel behavior-panel">
              <div className="section-heading">
                <div>
                  <h2>動作設定</h2>
                  <p>スコアに応じてコメントの表示方法を決定します。</p>
                </div>
                <select
                  value={settings.activePreset}
                  onChange={(event) =>
                    setSettings((current) => ({
                      ...current,
                      activePreset: event.target.value as PresetId,
                    }))
                  }
                  aria-label="編集するプリセット"
                >
                  {(Object.keys(PRESET_LABELS) as PresetId[]).map((preset) => (
                    <option key={preset} value={preset}>
                      {PRESET_LABELS[preset]}
                    </option>
                  ))}
                </select>
              </div>
              <div className="threshold-grid">
                <div className="threshold threshold--allow">
                  <strong>表示</strong>
                  <span>0.00 以上</span>
                </div>
                <ThresholdInput
                  label="薄く表示"
                  value={profile.thresholds.dim}
                  tone="dim"
                  onChange={(dim) =>
                    updateProfile({
                      ...profile,
                      thresholds: { ...profile.thresholds, dim },
                    })
                  }
                />
                <ThresholdInput
                  label="ぼかし"
                  value={profile.thresholds.blur}
                  tone="blur"
                  onChange={(blur) =>
                    updateProfile({
                      ...profile,
                      thresholds: { ...profile.thresholds, blur },
                    })
                  }
                />
                <ThresholdInput
                  label="非表示"
                  value={profile.thresholds.hide}
                  tone="hide"
                  onChange={(hide) =>
                    updateProfile({
                      ...profile,
                      thresholds: { ...profile.thresholds, hide },
                    })
                  }
                />
              </div>
              <div className="spam-setting">
                <span>
                  <strong>連投スパムを抑える</strong>
                  <small>
                    同文連投、短時間の大量投稿、絵文字大量を判定します
                  </small>
                </span>
                <Switch
                  checked={profile.hideSpam}
                  onChange={(hideSpam) =>
                    updateProfile({ ...profile, hideSpam })
                  }
                  label="連投スパムを抑える"
                />
              </div>
              <div className="spam-setting">
                <span>
                  <strong>デバッグモード</strong>
                  <small>
                    保存後、チャットにスコアとAI検閲中ラベルを表示します
                  </small>
                </span>
                <Switch
                  checked={settings.debugMode}
                  onChange={(debugMode) =>
                    setSettings((current) => ({ ...current, debugMode }))
                  }
                  label="デバッグモード"
                />
              </div>
            </section>

            <section className="panel flow-chat-panel" id="flow-chat">
              <div className="section-heading">
                <div>
                  <h2>Flow Chat連携</h2>
                  <p>
                    Flow Chat for YouTube
                    Liveへ、ぼかし相当以上のコメントを流さないためのDOM連携です。
                  </p>
                </div>
              </div>
              <div className="setting-row">
                <span>
                  <strong>Flow Chat連携を有効にする</strong>
                  <small>Flow Chatが入っていない場合も動作に影響しません</small>
                </span>
                <Switch
                  checked={settings.flowChat.enabled}
                  onChange={(enabled) =>
                    setSettings((current) => ({
                      ...current,
                      flowChat: { ...current.flowChat, enabled },
                    }))
                  }
                  label="Flow Chat連携を有効にする"
                />
              </div>
              <label className="field">
                <span>Flow Chat側の除外基準</span>
                <select
                  value={settings.flowChat.exclusionLevel}
                  aria-label="Flow Chat側の除外基準"
                  onChange={(event) => {
                    const value = event.target.value;
                    if (
                      value !== 'blur' &&
                      value !== 'hide' &&
                      value !== 'custom'
                    )
                      return;
                    setSettings((current) => ({
                      ...current,
                      flowChat: {
                        ...current.flowChat,
                        exclusionLevel: value,
                      },
                    }));
                  }}
                >
                  <option value="blur">ぼかし以上（推奨）</option>
                  <option value="hide">非表示のみ</option>
                  <option value="custom">カスタムスコア</option>
                </select>
              </label>
              {settings.flowChat.exclusionLevel === 'custom' ? (
                <AiNumber
                  label="Flow Chat除外スコア"
                  value={settings.flowChat.customThreshold ?? 0.75}
                  min={0}
                  max={1}
                  step={0.05}
                  onChange={(customThreshold) =>
                    setSettings((current) => ({
                      ...current,
                      flowChat: { ...current.flowChat, customThreshold },
                    }))
                  }
                />
              ) : null}
              <p className="privacy-note">
                コメント本文や通信をFlow
                Chatへ渡しません。判定は既存のルールと文脈スコアで即時に確定し、遅れて届くローカルAI結果はFlow
                Chat側へ再適用しません。
              </p>
            </section>

            <section className="panel category-panel">
              <div className="section-heading">
                <div>
                  <h2>カテゴリ設定</h2>
                  <p>カテゴリごとの有効状態と判定の強さを調整します。</p>
                  <p className="category-note">
                    「非表示」は発言者のアイコンとIDを含む行全体をぼかします。
                  </p>
                </div>
              </div>
              <div
                className="category-table"
                role="table"
                aria-label="カテゴリ設定"
              >
                <div className="category-header" role="row">
                  <span>カテゴリ</span>
                  <span>有効</span>
                  <span>重み</span>
                  <span>表示方法</span>
                  <span>説明</span>
                </div>
                {CATEGORY_KEYS.map((category) => {
                  const value = profile.categories[category];
                  return (
                    <div className="category-row" role="row" key={category}>
                      <strong>{CATEGORY_LABELS[category]}</strong>
                      <Switch
                        checked={value.enabled}
                        onChange={(enabled) =>
                          updateProfile({
                            ...profile,
                            categories: {
                              ...profile.categories,
                              [category]: { ...value, enabled },
                            },
                          })
                        }
                        label={`${CATEGORY_LABELS[category]}を有効にする`}
                      />
                      <input
                        type="number"
                        min="0"
                        max="1"
                        step="0.05"
                        value={value.weight}
                        aria-label={`${CATEGORY_LABELS[category]}の重み`}
                        onChange={(event) =>
                          updateProfile({
                            ...profile,
                            categories: {
                              ...profile.categories,
                              [category]: {
                                ...value,
                                weight: Number(event.target.value),
                              },
                            },
                          })
                        }
                      />
                      <select
                        value={value.mode}
                        aria-label={`${CATEGORY_LABELS[category]}の表示方法`}
                        onChange={(event) => {
                          const mode = event.target.value as FilterMode;
                          if (!(mode in MODE_LABELS)) return;
                          updateProfile({
                            ...profile,
                            categories: {
                              ...profile.categories,
                              [category]: { ...value, mode },
                            },
                          });
                        }}
                      >
                        {(Object.keys(MODE_LABELS) as FilterMode[]).map(
                          (mode) => (
                            <option key={mode} value={mode}>
                              {MODE_LABELS[mode]}
                            </option>
                          ),
                        )}
                      </select>
                      <span>{CATEGORY_DESCRIPTIONS[category]}</span>
                    </div>
                  );
                })}
              </div>
            </section>

            <section className="panel word-panel">
              <WordList
                title="ブロックする語句"
                hint="含まれる場合は非表示にします（1行に1語句）"
                value={settings.blockedWords}
                onChange={(blockedWords) =>
                  setSettings((current) => ({ ...current, blockedWords }))
                }
              />
              <WordList
                title="許可する語句"
                hint="含まれる場合はフィルターしません（1行に1語句）"
                value={settings.allowedWords}
                onChange={(allowedWords) =>
                  setSettings((current) => ({ ...current, allowedWords }))
                }
              />
            </section>

            <TrackedUsersPanel
              hiddenUsers={settings.hiddenUsers}
              whitelistedUsers={settings.whitelistedUsers}
              onWhitelist={(channelId) =>
                setSettings((current) => whitelistUser(current, channelId))
              }
              onRemoveHidden={(channelId) =>
                setSettings((current) => removeHiddenUser(current, channelId))
              }
              onRemoveWhitelist={(channelId) =>
                setSettings((current) =>
                  removeWhitelistedUser(current, channelId),
                )
              }
            />
          </div>

          <div className="secondary-column">
            <section className="panel ai-panel" id="local-ai">
              <h2>ローカルAI設定</h2>
              <fieldset className="provider-options">
                <legend>AIプロバイダー</legend>
                {(
                  [
                    ['auto', '自動（推奨）'],
                    ['chrome-built-in', 'Chrome 内蔵AI'],
                    ['lm-studio', 'LM Studio'],
                    ['disabled', '使用しない'],
                  ] as const
                ).map(([value, label]) => (
                  <label key={value}>
                    <input
                      type="radio"
                      name="local-ai-mode"
                      value={value}
                      checked={settings.localAiMode === value}
                      onChange={() => void selectLocalAiMode(value)}
                    />
                    <span>{label}</span>
                  </label>
                ))}
              </fieldset>
              {showChromeAi ? (
                <div className="chrome-ai-card" aria-label="Chrome内蔵AIの状態">
                  <strong>Chrome 内蔵AI</strong>
                  <span>{chromeAiMessage}</span>
                  {chromeAiProgress !== null ? (
                    <progress
                      aria-label="Chrome AIモデルのダウンロード進捗"
                      max={100}
                      value={chromeAiProgress}
                    />
                  ) : null}
                  {chromeAiAvailability === 'downloadable' ? (
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={() => void prepareChromeAi()}
                    >
                      Chrome AIを準備する
                    </button>
                  ) : null}
                </div>
              ) : null}
              {showLmStudio ? (
                <>
                  <label className="field">
                    <span>エンドポイント</span>
                    <input
                      value={settings.lmStudio.endpoint}
                      onChange={(event) =>
                        setSettings((current) => ({
                          ...current,
                          lmStudio: {
                            ...current.lmStudio,
                            endpoint: event.target.value,
                          },
                        }))
                      }
                    />
                  </label>
                  <label className="field">
                    <span>モデル</span>
                    <select
                      value={settings.lmStudio.model}
                      onChange={(event) =>
                        setSettings((current) => ({
                          ...current,
                          lmStudio: {
                            ...current.lmStudio,
                            model: event.target.value,
                          },
                        }))
                      }
                    >
                      <option value="">モデルを選択</option>
                      {selectedModelOptions.map((model) => (
                        <option key={model}>{model}</option>
                      ))}
                    </select>
                  </label>
                  <button
                    className="secondary-button"
                    type="button"
                    disabled={connection === 'testing'}
                    onClick={() => void testConnection(false)}
                  >
                    接続を確認
                  </button>
                  <div className="connection-row">
                    <span
                      className={`status-dot ${connection === 'online' ? 'status-dot--online' : connection === 'offline' ? 'status-dot--warning' : ''}`}
                    />
                    <span>{connectionMessage}</span>
                  </div>
                  <label className="field">
                    <span>AI応答形式</span>
                    <select
                      value={settings.lmStudio.responseFormat}
                      onChange={(event) => {
                        const value = event.target.value;
                        if (
                          value === 'json_schema' ||
                          value === 'json_object' ||
                          value === 'text'
                        ) {
                          setSettings((current) => ({
                            ...current,
                            lmStudio: {
                              ...current.lmStudio,
                              responseFormat: value,
                            },
                          }));
                        }
                      }}
                    >
                      <option value="json_schema">JSON Schema（推奨）</option>
                      <option value="json_object">JSON Object（互換）</option>
                      <option value="text">テキストからJSONを検証</option>
                    </select>
                  </label>
                </>
              ) : null}
              {showSharedAi ? (
                <>
                  {showLmStudio ? (
                    <>
                      <AiNumber
                        label="LM Studio応答の待ち時間（秒）"
                        value={settings.lmStudio.requestTimeoutMs / 1000}
                        min={1}
                        max={60}
                        step={1}
                        onChange={(value) =>
                          setSettings((current) => ({
                            ...current,
                            lmStudio: {
                              ...current.lmStudio,
                              requestTimeoutMs: value * 1000,
                            },
                          }))
                        }
                      />
                      <AiNumber
                        label="LM Studioで1回に送る最大件数"
                        value={settings.lmStudio.batchSize}
                        min={1}
                        max={20}
                        step={1}
                        onChange={(value) =>
                          setSettings((current) => ({
                            ...current,
                            lmStudio: {
                              ...current.lmStudio,
                              batchSize: value,
                            },
                          }))
                        }
                      />
                    </>
                  ) : null}
                  <div className="ai-condition">
                    <strong>AIの使用条件</strong>
                    <p>
                      通常はルールスコア0.35〜0.80の曖昧なコメントを対象にします。
                    </p>
                    <AiNumber
                      label="AI対象の下限スコア"
                      value={settings.lmStudio.uncertainMin}
                      min={0.35}
                      max={0.8}
                      step={0.05}
                      onChange={(value) =>
                        setSettings((current) => ({
                          ...current,
                          lmStudio: {
                            ...current.lmStudio,
                            uncertainMin: value,
                          },
                        }))
                      }
                    />
                    <AiNumber
                      label="AI対象の上限スコア"
                      value={settings.lmStudio.uncertainMax}
                      min={0.35}
                      max={0.8}
                      step={0.05}
                      onChange={(value) =>
                        setSettings((current) => ({
                          ...current,
                          lmStudio: {
                            ...current.lmStudio,
                            uncertainMax: value,
                          },
                        }))
                      }
                    />
                    <p>
                      500msでルール結果を表示し、AIの応答が届けば更新します。
                      {showLmStudio
                        ? '遅い場合はLM Studioの件数を減らすか待ち時間を延ばしてください。形式エラーの場合は互換形式を試せます。'
                        : null}
                    </p>
                  </div>
                  <div className="setting-row">
                    <span>
                      <strong>未判定コメントをAIで再確認</strong>
                      <small>
                        ルールに一致しない0点コメントを通常は一部だけ監査します
                      </small>
                    </span>
                    <Switch
                      label="未判定コメントをAIで再確認"
                      checked={settings.lmStudio.zeroScoreAudit.enabled}
                      onChange={(enabled) =>
                        setSettings((current) => ({
                          ...current,
                          lmStudio: {
                            ...current.lmStudio,
                            zeroScoreAudit: {
                              ...current.lmStudio.zeroScoreAudit,
                              enabled,
                            },
                          },
                        }))
                      }
                    />
                  </div>
                  <div className="setting-row">
                    <span>
                      <strong>ルール未一致をすべてAIで確認</strong>
                      <small>
                        抽選と監査上限を使わず全件を送ります。混雑時は古い待機コメントをルール判定へ戻します
                      </small>
                    </span>
                    <Switch
                      label="ルール未一致をすべてAIで確認"
                      checked={
                        settings.lmStudio.zeroScoreAudit.checkAllUnmatched
                      }
                      disabled={!settings.lmStudio.zeroScoreAudit.enabled}
                      onChange={(checkAllUnmatched) =>
                        setSettings((current) => ({
                          ...current,
                          lmStudio: {
                            ...current.lmStudio,
                            zeroScoreAudit: {
                              ...current.lmStudio.zeroScoreAudit,
                              checkAllUnmatched,
                            },
                          },
                        }))
                      }
                    />
                  </div>
                  <div className="setting-row">
                    <strong>閲覧中のAI判定を一時ルールに活用</strong>
                    <Switch
                      label="閲覧中のAI判定を一時ルールに活用"
                      checked={settings.lmStudio.sessionLearning}
                      onChange={(sessionLearning) =>
                        setSettings((current) => ({
                          ...current,
                          lmStudio: { ...current.lmStudio, sessionLearning },
                        }))
                      }
                    />
                  </div>
                  <p>
                    強い問題と判定された同文を再利用します。異なる3本文で一致し、文節単独でも同じカテゴリの高スコアをAIが返した文節だけを一時ルールへ昇格します。再読み込み・設定変更でリセットされ、保存しません。
                  </p>
                  <p className="privacy-note">
                    コメントはローカル環境内だけで処理されます
                  </p>
                </>
              ) : null}
            </section>

            <section className="panel diagnostic-panel" id="diagnostic">
              <h2>診断プレビュー</h2>
              <label className="field">
                <span>サンプルコメント</span>
                <textarea
                  rows={3}
                  value={testText}
                  onChange={(event) => setTestText(event.target.value)}
                />
              </label>
              <button
                className="secondary-button"
                type="button"
                disabled={testing || !testText.trim()}
                onClick={() => void runDiagnostic()}
              >
                {testing ? '判定中…' : '判定を試す'}
              </button>
              {diagnostic ? (
                <DiagnosticResult
                  key={diagnostic.id}
                  entry={diagnostic}
                  onFeedback={submitFeedback}
                />
              ) : (
                <p className="empty-diagnostic">
                  コメントを入力して判定結果を確認できます。
                </p>
              )}
            </section>
          </div>
        </div>

        <DebugHistoryPanel
          enabled={settings.debugMode}
          entries={debugEntries}
          flowMetrics={flowMetrics}
          error={debugError}
          onRefresh={() => void refreshDebugHistory()}
          onClear={() => void clearDebugHistory()}
        />

        <FeedbackPanel
          entries={feedbackEntries}
          stats={feedbackStats}
          summary={feedbackSummary}
          error={feedbackError}
          loading={feedbackLoading}
          onRefresh={() => void refreshFeedback()}
          onExport={() => void exportFeedback()}
          onClear={() => void clearFeedback()}
        />

        <footer className="save-bar">
          <button type="button" onClick={() => void save()}>
            設定を保存
          </button>
          <span aria-live="polite">
            {savedAt
              ? `設定を保存しました（${savedAt.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}）`
              : '未保存の変更はこの画面を閉じると失われます'}
          </span>
        </footer>
      </main>
    </div>
  );
}

function AiNumber({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

function ThresholdInput({
  label,
  value,
  tone,
  onChange,
}: {
  label: string;
  value: number;
  tone: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className={`threshold threshold--${tone}`}>
      <strong>{label}</strong>
      <span>
        <input
          type="number"
          min="0"
          max="1"
          step="0.05"
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
          aria-label={`${label}の開始スコア`}
        />{' '}
        以上
      </span>
    </label>
  );
}

function TrackedUsersPanel({
  hiddenUsers,
  whitelistedUsers,
  onWhitelist,
  onRemoveHidden,
  onRemoveWhitelist,
}: {
  hiddenUsers: TrackedUser[];
  whitelistedUsers: TrackedUser[];
  onWhitelist: (channelId: string) => void;
  onRemoveHidden: (channelId: string) => void;
  onRemoveWhitelist: (channelId: string) => void;
}) {
  return (
    <section className="panel user-list-panel" id="hidden-users">
      <div className="section-heading">
        <div>
          <h2>非表示ユーザー</h2>
          <p>
            同じ配信でぼかし・非表示が続いたユーザーを、他の配信でも非表示にします。表示したい場合はホワイトリストへ移せます。自分の投稿は常に表示（0.00）です。
          </p>
        </div>
      </div>
      {hiddenUsers.length === 0 ? (
        <p className="empty-diagnostic">まだ登録されていません。</p>
      ) : (
        <ul className="tracked-user-list" aria-label="非表示ユーザー一覧">
          {hiddenUsers.map((user) => (
            <TrackedUserRow
              key={user.channelId}
              user={user}
              actions={[
                {
                  label: 'ホワイトリストへ',
                  onClick: () => onWhitelist(user.channelId),
                },
                {
                  label: '解除',
                  onClick: () => onRemoveHidden(user.channelId),
                },
              ]}
            />
          ))}
        </ul>
      )}
      <h3>ホワイトリスト</h3>
      {whitelistedUsers.length === 0 ? (
        <p className="empty-diagnostic">ホワイトリストのユーザーはいません。</p>
      ) : (
        <ul className="tracked-user-list" aria-label="ホワイトリスト">
          {whitelistedUsers.map((user) => (
            <TrackedUserRow
              key={user.channelId}
              user={user}
              actions={[
                {
                  label: '解除',
                  onClick: () => onRemoveWhitelist(user.channelId),
                },
              ]}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function TrackedUserRow({
  user,
  actions,
}: {
  user: TrackedUser;
  actions: Array<{ label: string; onClick: () => void }>;
}) {
  const name = user.displayName || user.channelId;
  return (
    <li>
      <div>
        <strong>{name}</strong>
        {user.displayName ? <small>{user.channelId}</small> : null}
      </div>
      <div className="tracked-user-actions">
        {actions.map((action) => (
          <button
            key={action.label}
            type="button"
            className="secondary-button"
            onClick={action.onClick}
            aria-label={`${name}を${action.label}`}
          >
            {action.label}
          </button>
        ))}
      </div>
    </li>
  );
}

function WordList({
  title,
  hint,
  value,
  onChange,
}: {
  title: string;
  hint: string;
  value: string[];
  onChange: (value: string[]) => void;
}) {
  return (
    <label className="word-list">
      <strong>{title}</strong>
      <span>{hint}</span>
      <textarea
        rows={7}
        value={value.join('\n')}
        onChange={(event) => onChange(event.target.value.split('\n'))}
        placeholder="語句を入力"
      />
    </label>
  );
}

function DiagnosticResult({
  entry,
  onFeedback,
}: {
  entry: DiagnosticEntry;
  onFeedback: (
    entry: DiagnosticEntry,
    judgement: FeedbackJudgement,
    correctCategory: FilterCategory,
  ) => Promise<void>;
}) {
  const category = categoryLabel(entry.category);
  const [correctionOpen, setCorrectionOpen] = useState(false);
  const [correctCategory, setCorrectCategory] = useState<FilterCategory | null>(
    null,
  );
  const [saving, setSaving] = useState(false);
  const [feedbackStatus, setFeedbackStatus] = useState('');

  const saveFeedback = async (
    judgement: FeedbackJudgement,
    selectedCategory: FilterCategory,
  ) => {
    setSaving(true);
    setFeedbackStatus('');
    try {
      await onFeedback(entry, judgement, selectedCategory);
      setCorrectionOpen(false);
      setCorrectCategory(null);
      setFeedbackStatus('フィードバックを記録しました。');
    } catch (error) {
      setFeedbackStatus(
        error instanceof Error
          ? error.message
          : 'フィードバックを保存できませんでした。',
      );
    } finally {
      setSaving(false);
    }
  };

  const submitCorrection = () => {
    if (!correctCategory) return;
    const judgement: FeedbackJudgement =
      entry.category === 'safe' && correctCategory !== 'safe'
        ? 'missed'
        : 'incorrect';
    void saveFeedback(judgement, correctCategory);
  };

  return (
    <div className="diagnostic-result" aria-label="診断結果">
      <dl>
        <div>
          <dt>カテゴリ</dt>
          <dd>{category}</dd>
        </div>
        <div>
          <dt>スコア</dt>
          <dd>{entry.score.toFixed(2)}</dd>
        </div>
        <div>
          <dt>アクション</dt>
          <dd>{ACTION_LABELS[entry.action]}</dd>
        </div>
      </dl>
      <p>
        判定元: {sourceLabel(entry.source, entry.aiReason, entry.aiSkipReason)}
      </p>
      {entry.aiProvider ? (
        <p>
          AI Provider:{' '}
          {entry.aiProvider === 'chrome-built-in'
            ? 'Chrome Built-in'
            : 'LM Studio'}
          {entry.aiReason ? ` / Reason: ${entry.aiReason}` : ''}
          {typeof entry.aiLatencyMs === 'number'
            ? ` / Latency: ${entry.aiLatencyMs.toFixed(0)}ms`
            : ''}
        </p>
      ) : null}
      <strong>判定理由</strong>
      <ul>
        {entry.reasons.map((reason) => (
          <li key={reason}>{reason}</li>
        ))}
      </ul>
      {entry.ruleIds && entry.ruleIds.length > 0 ? (
        <p className="diagnostic-features">
          ルールID: {entry.ruleIds.join('・')}
        </p>
      ) : null}
      {entry.features && entry.features.length > 0 ? (
        <p className="diagnostic-features">
          特徴: {entry.features.join('・')}
          {typeof entry.contextAdjustment === 'number' &&
          entry.contextAdjustment !== 0
            ? `（文脈補正 ${entry.contextAdjustment > 0 ? '+' : ''}${entry.contextAdjustment.toFixed(2)}）`
            : ''}
        </p>
      ) : null}
      <div
        className="diagnostic-feedback"
        aria-label="診断結果へのフィードバック"
      >
        {!correctionOpen ? (
          <>
            <button
              className="secondary-button"
              type="button"
              disabled={saving}
              onClick={() => void saveFeedback('correct', entry.category)}
            >
              正しい
            </button>
            <button
              className="secondary-button"
              type="button"
              disabled={saving}
              onClick={() => {
                setFeedbackStatus('');
                setCorrectionOpen(true);
              }}
            >
              間違い
            </button>
          </>
        ) : (
          <fieldset className="feedback-category-picker">
            <legend>本来のカテゴリ</legend>
            {FEEDBACK_CATEGORY_CHOICES.map((choice) => (
              <label key={choice}>
                <input
                  type="radio"
                  name="diagnostic-correct-category"
                  checked={correctCategory === choice}
                  onChange={() => setCorrectCategory(choice)}
                />
                <span>{categoryLabel(choice)}</span>
              </label>
            ))}
            <div className="feedback-picker-actions">
              <button
                className="secondary-button"
                type="button"
                disabled={saving || !correctCategory}
                onClick={submitCorrection}
              >
                このカテゴリで記録
              </button>
              <button
                className="secondary-button"
                type="button"
                disabled={saving}
                onClick={() => {
                  setCorrectionOpen(false);
                  setCorrectCategory(null);
                }}
              >
                キャンセル
              </button>
            </div>
          </fieldset>
        )}
        {feedbackStatus ? (
          <p
            className={
              feedbackStatus === 'フィードバックを記録しました。'
                ? 'feedback-success'
                : 'feedback-error'
            }
            role="status"
          >
            {feedbackStatus}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function FeedbackPanel({
  entries,
  stats,
  summary,
  error,
  loading,
  onRefresh,
  onExport,
  onClear,
}: {
  entries: FeedbackEntry[];
  stats: RuleFeedbackStats[];
  summary: FeedbackSummary | null;
  error: string;
  loading: boolean;
  onRefresh: () => void;
  onExport: () => void;
  onClear: () => void;
}) {
  const [kind, setKind] = useState<'all' | 'incorrect' | 'missed'>('all');
  const [category, setCategory] = useState<FilterCategory | 'all'>('all');
  const [ruleId, setRuleId] = useState('all');
  const [source, setSource] = useState<FeedbackEntry['source'] | 'all'>('all');
  const ruleIds = useMemo(
    () => Array.from(new Set(entries.flatMap((entry) => entry.ruleIds))).sort(),
    [entries],
  );
  const filteredEntries = useMemo(
    () =>
      entries.filter((entry) => {
        if (kind !== 'all' && entry.judgement !== kind) return false;
        if (
          category !== 'all' &&
          entry.correctCategory !== category &&
          entry.predictedCategory !== category
        )
          return false;
        if (ruleId !== 'all' && !entry.ruleIds.includes(ruleId)) return false;
        return source === 'all' || entry.source === source;
      }),
    [category, entries, kind, ruleId, source],
  );

  return (
    <section className="panel feedback-panel" id="feedback">
      <div className="section-heading">
        <div>
          <h2>フィードバック</h2>
          <p>
            訂正した判定を確認し、同一の正規化本文だけを次回の判定へ反映します。
          </p>
        </div>
        <div className="feedback-actions">
          <button type="button" onClick={onRefresh} disabled={loading}>
            更新
          </button>
          <button type="button" onClick={onExport} disabled={loading}>
            JSONLでエクスポート
          </button>
          <button
            type="button"
            onClick={onClear}
            disabled={loading || entries.length === 0}
          >
            すべて消去
          </button>
        </div>
      </div>
      {summary ? (
        <div className="feedback-summary" aria-label="フィードバック集計">
          <span>評価済 {summary.total}</span>
          <span>正しい {summary.correct}</span>
          <span>誤判定 {summary.incorrect}</span>
          <span>見逃し {summary.missed}</span>
        </div>
      ) : null}
      <p className="privacy-note">
        フィードバックデータはこのブラウザの拡張機能内に保存され、自動的に外部へ送信されません。JSONL出力はこのボタンを押した場合だけ行います。
      </p>
      {error ? (
        <p className="debug-history-error" role="alert">
          {error}
        </p>
      ) : (
        <>
          <div
            className="feedback-filters"
            aria-label="フィードバックの絞り込み"
          >
            <label>
              種類
              <select
                value={kind}
                onChange={(event) =>
                  setKind(
                    event.target.value === 'incorrect' ||
                      event.target.value === 'missed'
                      ? event.target.value
                      : 'all',
                  )
                }
              >
                <option value="all">All</option>
                <option value="incorrect">False Positive</option>
                <option value="missed">False Negative</option>
              </select>
            </label>
            <label>
              カテゴリ
              <select
                value={category}
                onChange={(event) => {
                  const value = event.target.value;
                  setCategory(isFeedbackCategory(value) ? value : 'all');
                }}
              >
                <option value="all">All</option>
                {FEEDBACK_CATEGORY_CHOICES.map((choice) => (
                  <option key={choice} value={choice}>
                    {categoryLabel(choice)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Rule ID
              <select
                value={ruleId}
                onChange={(event) => setRuleId(event.target.value)}
              >
                <option value="all">All</option>
                {ruleIds.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <label>
              判定元
              <select
                value={source}
                onChange={(event) => {
                  const value = event.target.value;
                  setSource(
                    value === 'rules' ||
                      value === 'local-ai' ||
                      value === 'human-feedback' ||
                      value === 'fallback'
                      ? value
                      : 'all',
                  );
                }}
              >
                <option value="all">All</option>
                <option value="rules">ルール</option>
                <option value="local-ai">ローカルAI</option>
                <option value="human-feedback">過去の訂正</option>
                <option value="fallback">AI失敗時のルール</option>
              </select>
            </label>
          </div>
          {filteredEntries.length === 0 ? (
            <p className="empty-diagnostic">
              {entries.length === 0
                ? 'まだフィードバックはありません。診断結果またはデバッグ中のチャットから記録できます。'
                : '条件に一致するフィードバックはありません。'}
            </p>
          ) : (
            <ol className="feedback-list" aria-label="フィードバック一覧">
              {filteredEntries.map((entry) => (
                <li key={entry.id}>
                  <div className="feedback-list-meta">
                    <strong>{feedbackJudgementLabel(entry.judgement)}</strong>
                    <span>{sourceLabel(entry.source, entry.aiReason)}</span>
                    <time dateTime={new Date(entry.createdAt).toISOString()}>
                      {new Date(entry.createdAt).toLocaleString('ja-JP')}
                    </time>
                  </div>
                  <p className="feedback-list-text">{entry.text}</p>
                  <p className="feedback-list-result">
                    {categoryLabel(entry.predictedCategory)}{' '}
                    {entry.predictedScore.toFixed(2)}（
                    {ACTION_LABELS[entry.predictedAction]}） →{' '}
                    {categoryLabel(entry.correctCategory)}
                  </p>
                  {entry.ruleIds.length > 0 ? (
                    <p className="debug-history-features">
                      ルールID: {entry.ruleIds.join('・')}
                    </p>
                  ) : null}
                  {entry.features.length > 0 ? (
                    <p className="debug-history-features">
                      特徴: {entry.features.join('・')}
                    </p>
                  ) : null}
                </li>
              ))}
            </ol>
          )}
        </>
      )}
      <div className="rule-feedback-stats">
        <h3>ルール別統計</h3>
        {stats.length === 0 ? (
          <p className="empty-diagnostic">評価されたルールはまだありません。</p>
        ) : (
          <ul aria-label="ルール別フィードバック統計">
            {stats.map((stat) => (
              <li key={stat.ruleId}>
                <strong>{stat.ruleId}</strong>
                <span>評価 {stat.evaluated}</span>
                <span>正解 {stat.correct}</span>
                <span>誤判定 {stat.incorrect}</span>
                <span>見逃し {stat.falseNegative}</span>
                <span>Precision {(stat.precision * 100).toFixed(1)}%</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function DebugHistoryPanel({
  enabled,
  entries,
  flowMetrics,
  error,
  onRefresh,
  onClear,
}: {
  enabled: boolean;
  entries: DiagnosticEntry[];
  flowMetrics: FlowChatMetricsSnapshot | null;
  error: string;
  onRefresh: () => void;
  onClear: () => void;
}) {
  return (
    <section className="panel debug-history-panel" id="debug-history">
      <div className="section-heading">
        <div>
          <h2>デバッグ履歴</h2>
          <p>薄く表示・ぼかし・非表示になったコメントを最大200件表示します。</p>
        </div>
        <div className="debug-history-actions">
          <button type="button" onClick={onRefresh} disabled={!enabled}>
            更新
          </button>
          <button
            type="button"
            onClick={onClear}
            disabled={!enabled || entries.length === 0}
          >
            履歴を消去
          </button>
        </div>
      </div>
      {!enabled ? (
        <p className="empty-diagnostic">
          デバッグモードをONにして設定を保存すると記録を開始します。
        </p>
      ) : error ? (
        <p className="debug-history-error" role="alert">
          {error}
        </p>
      ) : entries.length === 0 ? (
        <p className="empty-diagnostic">対応されたチャットはまだありません。</p>
      ) : (
        <ol className="debug-history-list" aria-label="対応されたチャット一覧">
          {entries.map((entry, index) => (
            <li key={`${entry.timestamp}-${entry.id}-${index}`}>
              <div className="debug-history-meta">
                <time dateTime={new Date(entry.timestamp).toISOString()}>
                  {new Date(entry.timestamp).toLocaleTimeString('ja-JP', {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                  })}
                </time>
                <strong>{ACTION_LABELS[entry.action]}</strong>
                <span>{categoryLabel(entry.category)}</span>
                <span>スコア {entry.score.toFixed(2)}</span>
              </div>
              <p className="debug-history-text">{entry.text}</p>
              <p className="debug-history-reason">
                {sourceLabel(entry.source, entry.aiReason, entry.aiSkipReason)}:{' '}
                {entry.reasons.join('・')}
              </p>
              {entry.aiProvider ? (
                <p className="debug-history-features">
                  AI Provider:{' '}
                  {entry.aiProvider === 'chrome-built-in'
                    ? 'Chrome Built-in'
                    : 'LM Studio'}
                  {entry.aiReason ? `・Reason: ${entry.aiReason}` : ''}
                  {typeof entry.aiLatencyMs === 'number'
                    ? `・Latency: ${entry.aiLatencyMs.toFixed(0)}ms`
                    : ''}
                </p>
              ) : null}
              {entry.ruleIds && entry.ruleIds.length > 0 ? (
                <p className="debug-history-features">
                  ルールID: {entry.ruleIds.join('・')}
                </p>
              ) : null}
              {entry.features && entry.features.length > 0 ? (
                <p className="debug-history-features">
                  特徴: {entry.features.join('・')}
                  {typeof entry.contextAdjustment === 'number' &&
                  entry.contextAdjustment !== 0
                    ? `（文脈補正 ${entry.contextAdjustment > 0 ? '+' : ''}${entry.contextAdjustment.toFixed(2)}）`
                    : ''}
                </p>
              ) : null}
              {entry.flow ? (
                <p className="debug-history-features">
                  Flow Chat: {entry.flow.excluded ? '除外' : '許可'}・
                  {flowSourceLabel(entry.flow.decisionSource)}・閾値{' '}
                  {entry.flow.threshold.toFixed(2)}・
                  {entry.flow.elapsedMs.toFixed(1)}ms
                </p>
              ) : null}
            </li>
          ))}
        </ol>
      )}
      {enabled && flowMetrics ? (
        <FlowMetricsSummary metrics={flowMetrics} />
      ) : null}
      <p className="privacy-note">
        履歴は拡張のメモリだけに保持し、タブの再読み込み・終了またはデバッグOFFで消去します。ユーザー名は記録しません。
      </p>
    </section>
  );
}

function categoryLabel(category: DiagnosticEntry['category']): string {
  if (category === 'safe') return '安全';
  if (category === 'spam') return 'スパム';
  if (category === 'hidden_user') return '非表示ユーザー';
  if (category === 'unknown') return '判定不能';
  return CATEGORY_LABELS[category];
}

function FlowMetricsSummary({ metrics }: { metrics: FlowChatMetricsSnapshot }) {
  return (
    <div className="flow-metrics" aria-label="Flow Chat連携メトリクス">
      <strong>Flow Chat連携メトリクス</strong>
      <span>受信 {metrics.received}</span>
      <span>分類 {metrics.classified}</span>
      <span>除外 {metrics.excluded}</span>
      <span>許可 {metrics.allowed}</span>
      <span>キャッシュ {metrics.cacheHits}</span>
      <span>タイムアウト {metrics.timeouts}</span>
      <span>エラー {metrics.errors}</span>
      <span>平均 {metrics.averageLatency.toFixed(1)}ms</span>
      <span>最大 {metrics.maxLatency.toFixed(1)}ms</span>
    </div>
  );
}

function sourceLabel(
  source: DiagnosticEntry['source'],
  aiReason?: DiagnosticEntry['aiReason'],
  aiSkipReason?: DiagnosticEntry['aiSkipReason'],
): string {
  if (source === 'local-ai')
    return aiReason === 'zero-score-audit'
      ? 'ローカルAI（Zero-score Audit）'
      : 'ローカルAI';
  if (source === 'human-feedback') return '過去のユーザー訂正';
  if (source === 'fallback') {
    if (aiSkipReason === 'overloaded') return 'ルール（AIスキップ: 混雑）';
    if (aiSkipReason === 'expired') return 'ルール（AIスキップ: 期限切れ）';
    if (aiSkipReason === 'disposed') return 'ルール（AIスキップ: 設定変更）';
    return 'ルール（AI失敗）';
  }
  return 'ルール';
}

function feedbackJudgementLabel(judgement: FeedbackJudgement): string {
  if (judgement === 'correct') return '正しい';
  if (judgement === 'missed') return '見逃し';
  return '誤判定';
}

function isFeedbackCategory(value: string): value is FilterCategory {
  return FEEDBACK_CATEGORY_CHOICES.some((category) => category === value);
}

function chromeAvailabilityLabel(availability: LocalAiAvailability): string {
  if (availability === 'available') return 'Chrome内蔵AIを利用できます';
  if (availability === 'downloadable') return 'モデルの準備が必要です';
  if (availability === 'downloading') return 'モデルをダウンロード中です';
  if (availability === 'error')
    return 'Chrome内蔵AIの状態を確認できませんでした';
  return 'このChromeでは内蔵AIを利用できません';
}

function flowSourceLabel(
  source: NonNullable<DiagnosticEntry['flow']>['decisionSource'],
): string {
  if (source === 'context') return '文脈';
  if (source === 'cache') return 'キャッシュ';
  if (source === 'llm-fast') return '高速AI';
  if (source === 'fail-open') return 'fail-open';
  return 'ルール';
}

function sanitizeSettings(value: SettingsV1): SettingsV1 {
  const next = structuredClone(value);
  next.lmStudio = normalizeLmStudio(next.lmStudio);
  next.flowChat = normalizeFlowChat(next.flowChat);
  next.blockedWords = cleanWords(next.blockedWords);
  next.allowedWords = cleanWords(next.allowedWords);
  next.whitelistedUsers = normalizeTrackedUsers(next.whitelistedUsers);
  const whitelistIds = new Set(
    next.whitelistedUsers.map((user) => user.channelId),
  );
  next.hiddenUsers = normalizeTrackedUsers(next.hiddenUsers).filter(
    (user) => !whitelistIds.has(user.channelId),
  );
  for (const preset of Object.keys(next.profiles) as PresetId[]) {
    const current = next.profiles[preset];
    current.thresholds.dim = clamp(current.thresholds.dim, 0.05, 0.9);
    current.thresholds.blur = clamp(
      current.thresholds.blur,
      current.thresholds.dim,
      0.95,
    );
    current.thresholds.hide = clamp(
      current.thresholds.hide,
      current.thresholds.blur,
      1,
    );
    for (const category of CATEGORY_KEYS)
      current.categories[category].weight = clamp(
        current.categories[category].weight,
        0,
        1,
      );
  }
  return next;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}
