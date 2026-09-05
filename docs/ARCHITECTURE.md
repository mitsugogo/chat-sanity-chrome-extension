# ChatSanity Architecture

## 処理フロー

```text
YouTube chat DOM
  -> YouTube Adapter
  -> Normalizer
  -> Rule Engine / Spam Detector
  -> ambiguous only: Service Worker -> LM Studio
  -> context modifier (conflict / author / recent risk)
  -> action selection
  -> Renderer
  -> original YouTube node
```

Content ScriptはYouTubeのチャットフレームで新着ノードを監視し、AdapterがDOMを`ChatMessage`へ変換します。Normalizer以降はDOMから独立したデータを扱います。

ルールだけで結果が確定するコメントは即時にRendererへ渡します。曖昧域のコメントは一時IDと正規化済み本文に、同一投稿者の直近リスク投稿・直近のリスク投稿・対立度だけを加えてService Workerへ送り、LM Studioの構造化結果とルール結果を合成します。投稿者名、チャンネル情報、DOM、メンバー状態は送信しません。

## 責務の境界

| 領域           | 主なファイル                                 | 責務                                          |
| -------------- | -------------------------------------------- | --------------------------------------------- |
| 拡張設定       | `wxt.config.ts`                              | Manifest共通設定、通常権限、任意ホスト権限    |
| Content Script | `entrypoints/content.ts`                     | DOM監視、重複防止、処理のオーケストレーション |
| Service Worker | `entrypoints/background.ts`                  | LM Studio通信とランタイムメッセージ処理       |
| 公開契約       | `lib/types.ts`                               | 設定、判定結果、診断、メッセージの型          |
| ルール判定     | `lib/filter/`                                | 正規化、カテゴリ、スパム、アクション決定      |
| AI通信         | `lib/batch-queue.ts`、`lib/lm-studio.ts`     | バッチ、タイムアウト、JSON Schema検証         |
| YouTube統合    | `lib/youtube/`                               | DOM抽出と非破壊Renderer                       |
| 設定保存       | `lib/settings.ts`、`lib/storage.ts`          | 既定値、検証、`storage.sync`永続化            |
| UI             | `entrypoints/popup/`、`entrypoints/options/` | 簡易操作と詳細設定                            |

## 状態と保存先

`chrome.storage.sync`へ保存するのは`SettingsV1`だけです。プリセット、閾値、語句、LM Studio設定を含み、`schemaVersion: 1`で将来の移行境界を示します。

判定履歴、処理済みDOM、同文キャッシュはチャットフレームのメモリ内にだけ保持し、タブ終了時に破棄します。デバッグ履歴は直近200件、同文キャッシュは最大500件で、キャッシュのTTLは10分です。

ポップアップ表示用の件数と接続状態だけは、Service Workerの休止をまたいで参照できるよう`chrome.storage.session`へ一時保存します。コメント本文や判定理由は含めず、タブの読み込み直し・終了時に削除します。

## 失敗時の設計

LM Studioは補助判定であり、必須依存ではありません。権限拒否、未起動、HTTPエラー、タイムアウト、不正JSON、非対応レスポンスのいずれでもルール結果へ戻ります。AI待機によってYouTubeチャット全体を停止させてはいけません。

RendererはYouTubeの元ノードを削除しません。属性とCSSで表示を制御するため、フィルター解除やユーザー操作による原文復元が可能です。`ぼかし`は本文だけ、`非表示`は同じぼかしをアイコンと発言者IDまで広げます。

## AI補助判定と一時学習

AIの対象は設定で狭められる0.35〜0.80の曖昧域です。無効化・配信者／モデレーター除外、許可語句、ブロック語句、カテゴリルール、スパムの順序を維持します。AI結果にもカテゴリの有効状態と重みを適用し、スパム判定はAIで打ち消しません。診断プレビューも共通の`mergeAiResult`を使用します。

200ms単位、最大20件のバッチを1つずつ実行します。待機上限は100件です。表示待機500msと推論待機`requestTimeoutMs`（既定10秒、1〜60秒）は分離し、時間のかかるローカルモデルでも先にルール表示した後から更新できます。HTTP応答本文の受信・解析までタイムアウトの対象です。JSON Schema、JSON Object、テキストのいずれも最終的なJSON検証は同じです。プロンプトに日本語の問題例・安全例を含め、コメント内の命令を分類データとして扱うよう指示します。明らかなリアクションはAIへ送らず、広いprefilterも候補抽出にだけ使います。

`sessionLearning`が有効な場合、AIの強い問題判定を現在のチャットフレーム内で再利用します。異なる3本文の共通文節で、文節単独でも同じカテゴリの高スコアをAIが返したものだけを一時ルールに昇格し、判定根拠として表示します。設定変更時はキャッシュ・学習状態を消去して古いキューを破棄し、古い非同期結果を適用しません。短時間スパム履歴は時刻に応じて期限切れにします。学習データは外部送信も永続保存もしません。

カテゴリごとの表示方法は設定したモードを優先し、`threshold`だけ通常のスコア閾値を使います。スパムの投稿頻度による証拠は内容カテゴリの表示設定で打ち消しません。デバッグモードの履歴は対応理由と判定元を確認するためだけに使い、外部送信や永続保存を行いません。

新しいAI設定は`schemaVersion: 1`の既存設定読み込み時に既定値で補完します。バッチ数、曖昧域、待ち時間は契約の上限・下限内へ正規化します。ローカルホスト権限の要求はAIを有効化するユーザー操作からだけ行い、接続確認は既存権限で動作します。
