import { useEffect, useMemo, useState } from 'react';
import { browser } from 'wxt/browser';
import { Logo } from '../../components/Logo';
import { Switch } from '../../components/Switch';
import { actionForScore, createFilterEngine } from '../../lib/filter/engine';
import { normalizeText } from '../../lib/filter/normalize';
import {
  CATEGORY_LABELS,
  DEFAULT_SETTINGS,
  PRESET_LABELS,
  cleanWords,
} from '../../lib/settings';
import { loadSettings, saveSettings } from '../../lib/storage';
import type {
  ConfigurableCategory,
  DiagnosticEntry,
  PresetId,
  RuntimeMessage,
  RuntimeResponse,
  SettingsV1,
} from '../../lib/types';

const CATEGORY_DESCRIPTIONS: Record<ConfigurableCategory, string> = {
  abuse: '暴言・罵倒・差別的表現など',
  instruction: '過度な指示・命令口調・支配的言動',
  pigeon: '別配信・別視点の情報持ち込み',
  comparison: '配信者同士の比較・責任追及',
  concern: '根拠のない不安・過度な心配',
  spoiler: '未視聴者への先の展開の明示',
};

const CATEGORY_KEYS = Object.keys(CATEGORY_LABELS) as ConfigurableCategory[];
const PERMISSION_ORIGINS = ['http://127.0.0.1/*', 'http://localhost/*'];

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

  useEffect(() => {
    let cancelled = false;
    void loadSettings().then((stored) => {
      if (!cancelled) setSettings(stored);
    });
    return () => {
      cancelled = true;
    };
  }, []);

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

  const toggleLmStudio = async (enabled: boolean) => {
    if (!enabled) {
      setSettings((current) => ({
        ...current,
        lmStudio: { ...current.lmStudio, enabled: false },
      }));
      setConnection('idle');
      setConnectionMessage('無効');
      return;
    }
    const connected = await testConnection(true);
    if (connected) {
      setSettings((current) => ({
        ...current,
        lmStudio: { ...current.lmStudio, enabled: true },
      }));
    }
  };

  const save = async () => {
    const safeSettings = sanitizeSettings(settings);
    setSettings(safeSettings);
    await saveSettings(safeSettings);
    setSavedAt(new Date());
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
    const base = createFilterEngine()(message, settings);
    let entry: DiagnosticEntry = {
      id: message.id,
      text: testText,
      category: base.categories[0] ?? 'safe',
      score: base.score,
      action: base.action,
      reasons: base.reasons,
      source: 'rules',
      timestamp: message.timestamp,
    };

    if (base.needsAi && settings.lmStudio.model) {
      try {
        const response = (await browser.runtime.sendMessage({
          type: 'lm:classify',
          endpoint: settings.lmStudio.endpoint,
          model: settings.lmStudio.model,
          items: [{ id: message.id, text: normalizeText(testText) }],
          timeoutMs: Math.max(settings.lmStudio.timeoutMs * 4, 2_000),
        } satisfies RuntimeMessage)) as RuntimeResponse;
        if (response.ok && 'results' in response && response.results[0]) {
          const ai = response.results[0];
          entry = {
            ...entry,
            category: ai.category,
            score: ai.score,
            action: actionForScore(ai.score, profile.thresholds),
            reasons: [`LM Studioによる${ai.category}判定`],
            source: 'lm-studio',
          };
        }
      } catch {
        entry = {
          ...entry,
          source: 'fallback',
          reasons: [...entry.reasons, 'LM Studioへ接続できませんでした'],
        };
      }
    }
    setDiagnostic(entry);
    setTesting(false);
  };

  return (
    <div className="options-shell">
      <aside className="sidebar">
        <Logo />
        <nav aria-label="設定メニュー">
          <a href="#filter" className="is-active">
            フィルター
          </a>
          <a href="#local-ai">ローカルAI</a>
          <a href="#diagnostic">診断</a>
        </nav>
        <div className="sidebar-footer">
          <span>設定はChrome同期に保存</span>
          <span>コメント履歴は保存しません</span>
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
            </section>

            <section className="panel">
              <div className="section-heading">
                <div>
                  <h2>カテゴリ設定</h2>
                  <p>カテゴリごとの有効状態と判定の強さを調整します。</p>
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
          </div>

          <div className="secondary-column">
            <section className="panel ai-panel" id="local-ai">
              <h2>ローカルAI設定</h2>
              <div className="setting-row">
                <strong>LM Studioを使用する</strong>
                <Switch
                  checked={settings.lmStudio.enabled}
                  onChange={(enabled) => void toggleLmStudio(enabled)}
                  label="LM Studioを使用する"
                />
              </div>
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
                onClick={() => void testConnection(true)}
              >
                接続を確認
              </button>
              <div className="connection-row">
                <span
                  className={`status-dot ${connection === 'online' ? 'status-dot--online' : connection === 'offline' ? 'status-dot--warning' : ''}`}
                />
                <span>{connectionMessage}</span>
              </div>
              <div className="ai-condition">
                <strong>AIの使用条件</strong>
                <label>
                  <input type="radio" checked readOnly />
                  ルールで判断が曖昧なコメントのみ
                </label>
              </div>
              <p className="privacy-note">
                コメントはローカル環境内だけで処理されます
              </p>
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
                <DiagnosticResult entry={diagnostic} />
              ) : (
                <p className="empty-diagnostic">
                  コメントを入力して判定結果を確認できます。
                </p>
              )}
            </section>
          </div>
        </div>

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

function DiagnosticResult({ entry }: { entry: DiagnosticEntry }) {
  const category =
    entry.category === 'safe'
      ? '安全'
      : entry.category === 'spam'
        ? 'スパム'
        : CATEGORY_LABELS[entry.category];
  const actions = {
    allow: '表示',
    dim: '薄く表示',
    blur: 'ぼかし',
    hide: '非表示',
  } as const;
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
          <dd>{actions[entry.action]}</dd>
        </div>
      </dl>
      <strong>判定理由</strong>
      <ul>
        {entry.reasons.map((reason) => (
          <li key={reason}>{reason}</li>
        ))}
      </ul>
    </div>
  );
}

function sanitizeSettings(value: SettingsV1): SettingsV1 {
  const next = structuredClone(value);
  next.blockedWords = cleanWords(next.blockedWords);
  next.allowedWords = cleanWords(next.allowedWords);
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
