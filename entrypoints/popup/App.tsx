import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { Logo } from '../../components/Logo';
import { Switch } from '../../components/Switch';
import {
  DEFAULT_SETTINGS,
  PRESET_DESCRIPTIONS,
  PRESET_LABELS,
} from '../../lib/settings';
import { loadSettings, saveSettings } from '../../lib/storage';
import type {
  PresetId,
  RuntimeMessage,
  RuntimeResponse,
  SessionSummary,
  SettingsV1,
} from '../../lib/types';

const EMPTY_SUMMARY: SessionSummary = {
  active: false,
  hidden: 0,
  blurred: 0,
  lmStudio: 'disabled',
};

export default function App() {
  const [settings, setSettings] = useState<SettingsV1>(DEFAULT_SETTINGS);
  const [summary, setSummary] = useState<SessionSummary>(EMPTY_SUMMARY);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const initialize = async () => {
      const [nextSettings, tabs] = await Promise.all([
        loadSettings(),
        browser.tabs.query({ active: true, currentWindow: true }),
      ]);
      if (cancelled) return;
      setSettings(nextSettings);
      const tabId = tabs[0]?.id;
      if (typeof tabId === 'number') {
        try {
          const response = (await browser.runtime.sendMessage({
            type: 'session:get-summary',
            tabId,
          } satisfies RuntimeMessage)) as RuntimeResponse;
          if (response.ok && 'summary' in response)
            setSummary(response.summary);
        } catch {
          setSummary({
            ...EMPTY_SUMMARY,
            lmStudio: nextSettings.lmStudio.enabled
              ? 'unavailable'
              : 'disabled',
          });
        }
      }
      setLoading(false);
    };
    void initialize();
    return () => {
      cancelled = true;
    };
  }, []);

  const update = async (patch: Partial<SettingsV1>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    await saveSettings(next);
  };

  const statusText = summary.active
    ? 'YouTubeチャットで動作中'
    : '対応するチャットを開いてください';
  const aiConnected = summary.lmStudio === 'connected';

  return (
    <main className="popup-shell" aria-busy={loading}>
      <header className="popup-header">
        <Logo />
        <div className="master-control">
          <span>有効</span>
          <Switch
            checked={settings.enabled}
            onChange={(enabled) => void update({ enabled })}
            label="フィルターを有効にする"
          />
        </div>
      </header>

      <div className="chat-status">
        <span
          className={`status-dot ${summary.active ? 'status-dot--online' : ''}`}
        />
        <span>{statusText}</span>
      </div>

      <section className="popup-section">
        <h1>フィルタープリセット</h1>
        <div
          className="preset-control"
          role="radiogroup"
          aria-label="フィルタープリセット"
        >
          {(Object.keys(PRESET_LABELS) as PresetId[]).map((preset) => (
            <button
              key={preset}
              type="button"
              role="radio"
              aria-checked={settings.activePreset === preset}
              className={settings.activePreset === preset ? 'is-active' : ''}
              onClick={() => void update({ activePreset: preset })}
            >
              {PRESET_LABELS[preset]}
            </button>
          ))}
        </div>
        <p className="preset-description">
          {PRESET_DESCRIPTIONS[settings.activePreset]}
        </p>
      </section>

      <section className="session-summary" aria-label="今回の処理">
        <strong>今回の処理</strong>
        <span className="summary-divider" />
        <span>
          非表示 <b>{summary.hidden}</b>
        </span>
        <span className="summary-divider" />
        <span>
          ぼかし <b>{summary.blurred}</b>
        </span>
      </section>

      {settings.lmStudio.enabled ? (
        <section className="ai-status" aria-label="ローカルAIの状態">
          <span
            className={`status-dot ${aiConnected ? 'status-dot--online' : 'status-dot--warning'}`}
          />
          <div>
            <strong>
              {aiConnected ? 'LM Studio 接続済み' : 'LM Studio 未接続'}
            </strong>
            <span>曖昧なコメントのみ判定</span>
          </div>
        </section>
      ) : null}

      <button
        className="options-button"
        type="button"
        onClick={() => void browser.runtime.openOptionsPage()}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M12 8.7a3.3 3.3 0 1 0 0 6.6 3.3 3.3 0 0 0 0-6.6Zm8.1 4.7 1.5 1.2-2 3.5-1.8-.7c-.6.5-1.3.9-2 1.2l-.3 1.9h-4l-.3-1.9a8 8 0 0 1-2-1.2l-1.8.7-2-3.5 1.5-1.2a8 8 0 0 1 0-2.3L5.4 9.9l2-3.5 1.8.7c.6-.5 1.3-.9 2-1.2l.3-1.9h4l.3 1.9c.7.3 1.4.7 2 1.2l1.8-.7 2 3.5-1.5 1.2a8 8 0 0 1 0 2.3Z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinejoin="round"
          />
        </svg>
        詳細設定を開く
      </button>
    </main>
  );
}
