# ChatSanity Architecture

## 処理フロー

```text
YouTube chat DOM
  -> YouTube Adapter
  -> Normalizer
  -> Rule Engine / Spam Detector
  -> ambiguous only: Service Worker -> LM Studio
  -> action selection
  -> Renderer
  -> original YouTube node
```

Content ScriptはYouTubeのチャットフレームで新着ノードを監視し、AdapterがDOMを`ChatMessage`へ変換します。Normalizer以降はDOMから独立したデータを扱います。

ルールだけで結果が確定するコメントは即時にRendererへ渡します。曖昧域のコメントは一時IDと正規化済み本文だけをService Workerへ送り、LM Studioの構造化結果とルール結果を合成します。

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

判定履歴、処理済みDOM、同文キャッシュはチャットフレームのメモリ内にだけ保持し、タブ終了時に破棄します。履歴は直近100件、同文キャッシュは最大500件です。

ポップアップ表示用の件数と接続状態だけは、Service Workerの休止をまたいで参照できるよう`chrome.storage.session`へ一時保存します。コメント本文や判定理由は含めず、タブの読み込み直し・終了時に削除します。

## 失敗時の設計

LM Studioは補助判定であり、必須依存ではありません。権限拒否、未起動、HTTPエラー、タイムアウト、不正JSON、非対応レスポンスのいずれでもルール結果へ戻ります。AI待機によってYouTubeチャット全体を停止させてはいけません。

RendererはYouTubeの元ノードを削除しません。属性とCSSで表示を制御するため、フィルター解除やユーザー操作による原文復元が可能です。
