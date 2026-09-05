# ChatSanity Architecture

## 処理フロー

```text
YouTube chat DOM
  -> YouTube Adapter
  -> Normalizer
  -> Safe Fast Path
  -> Feature Extraction / Rule Scoring
  -> Context Modifier / Spam Detector
  -> ambiguous or sampled unmatched: Service Worker -> LocalAiResolver
       -> Chrome Built-in AI -> LM Studio -> Rules
  -> action selection
  -> Renderer (YouTube標準チャット)
  -> original YouTube node
  -> optional FlowChatBridge (DOM handshake)
```

Content ScriptはYouTubeのチャットフレームで新着ノードを監視し、AdapterがDOMを`ChatMessage`へ変換します。Normalizer以降はDOMから独立したデータを扱います。

明らかなリアクションはSafe Fast Pathで終了し、それ以外は対象検出、命令形、責任追及、能力攻撃、比較、meta conflict、配信不満、安全文脈をfeature単位で抽出してRuleScoreへ集約します。ルール結果には`excluded`、`explicit-safe`、`matched`、`unmatched`のDispositionを付けます。ルールだけで結果が確定するコメントは即時にRendererへ渡します。曖昧域のコメントと、`unmatched`かつ0点からZero-score Auditに抽選されたコメントは、一時IDと正規化済み本文に、同一投稿者の直近リスク投稿・直近のリスク投稿・対立度だけを加えてService Workerへ送り、LM Studioの構造化結果とルール結果を合成します。投稿者名、チャンネル情報、DOM、メンバー状態は送信しません。

## 責務の境界

| 領域           | 主なファイル                                 | 責務                                                        |
| -------------- | -------------------------------------------- | ----------------------------------------------------------- |
| 拡張設定       | `wxt.config.ts`                              | Manifest共通設定、通常権限、任意ホスト権限                  |
| Content Script | `entrypoints/content.ts`                     | DOM監視、重複防止、処理のオーケストレーション               |
| Service Worker | `entrypoints/background.ts`                  | Local AI Provider選択、Chrome Prompt API・LM Studio通信     |
| 公開契約       | `lib/types.ts`                               | 設定、判定結果、診断、メッセージの型                        |
| ルール判定     | `lib/filter/`                                | 正規化、feature抽出、カテゴリスコア、スパム、アクション決定 |
| AI通信         | `lib/batch-queue.ts`、`lib/local-ai/`        | バッチ、Provider選択、session、timeout、構造化結果検証      |
| YouTube統合    | `lib/youtube/`                               | DOM抽出と非破壊Renderer                                     |
| Flow Chat連携  | `lib/integrations/flow-chat/`                | `ylcfr-*` DOMプロトコル、締切、メトリクス                   |
| 設定保存       | `lib/settings.ts`、`lib/storage.ts`          | 既定値、検証、`storage.sync`永続化                          |
| UI             | `entrypoints/popup/`、`entrypoints/options/` | 簡易操作と詳細設定                                          |

## 状態と保存先

`chrome.storage.sync`へ保存するのは`SettingsV1`だけです。プリセット、閾値、語句、Local AI mode、Chrome内蔵AI・LM Studio設定、Flow Chat連携のON/OFFと除外基準を含み、`schemaVersion: 1`で将来の移行境界を示します。

判定履歴、処理済みDOM、同文キャッシュはチャットフレームのメモリ内にだけ保持し、タブ終了時に破棄します。デバッグ履歴は直近200件、同文キャッシュは最大500件で、キャッシュのTTLは10分です。

ルールID・feature・カテゴリ別スコアは診断用の結果にだけ付加し、設定同期や外部サービスへ保存しません。評価用の`tests/evaluation/`には本文と匿名化した出典IDだけを置き、投稿者IDや生ログは含めません。

ポップアップ表示用の件数と接続状態だけは、Service Workerの休止をまたいで参照できるよう`chrome.storage.session`へ一時保存します。コメント本文や判定理由は含めず、タブの読み込み直し・終了時に削除します。

Flow Chat連携を有効にした場合だけ、Content Scriptが`html.ylcfr-active`を付けます。`#items`直下でFlow Chatが観測し得る要素は、ルール・文脈判定または解析対象外の即時許可で、700〜800msの締切より前に必ず`ylcfr-filtered-message`へ確定します。除外する要素は`ylcfr-deleted-message`を先に付けます。Flow Chatが未導入でもクラスは無害で、通常のYouTube表示判定とは独立しています。遅れて届くLM Studio結果はYouTubeの表示だけを更新し、確定済みのFlow Chat結果へ再適用しません。メトリクスはデバッグモード中だけフレーム単位のメモリへ送り、Service Workerでは集計値だけを保持します。

## 失敗時の設計

Local AIは補助判定であり、必須依存ではありません。Prompt API不存在、モデル未準備、session作成失敗、Abort・Quotaエラー、LM Studioの権限拒否・未起動・HTTPエラー、timeout、不正JSON、非対応レスポンスのいずれでもルール結果へ戻ります。Auto modeではChrome内蔵AI、LM Studio、ルールの順にfallbackし、同じProviderが3回連続で失敗すると30秒間そのProviderを停止します。AI待機によってYouTubeチャット全体を停止させてはいけません。

RendererはYouTubeの元ノードを削除しません。属性とCSSで表示を制御するため、フィルター解除やユーザー操作による原文復元が可能です。`ぼかし`は本文だけ、`非表示`は同じぼかしをアイコンと発言者IDまで広げます。

Flow Chat側の連携クラスは`lib/integrations/flow-chat/constants.ts`へ隔離しています。現行の公開DOM契約（`ylcfr-active`、`ylcfr-filtered-message`、`ylcfr-deleted-message`）に依存するため、Flow Chat更新時はこのファイルとプロトコルテストを確認します。

## AI補助判定と一時学習

通常のAI対象は設定で狭められる0.35〜0.80の曖昧域です。これに加え、Local AIとZero-score Auditが有効な場合だけ、`unmatched`かつ0点の一部を監査します。基礎確率は3%で、10秒内の本文頻度、弱い監査シグナル、対立度を加味し、最大50%・12件/分・同時20件に制限します。監査はContent Scriptで行い、ルールスコアへは影響しません。無効化・配信者／モデレーター除外、許可語句、ブロック語句、カテゴリルール、スパムの順序を維持します。AI結果にもカテゴリの有効状態と重みを適用し、スパム判定はAIで打ち消しません。診断プレビューも共通の`mergeAiResult`を使用します。

200ms単位、最大20件のバッチを1つずつ実行します。Chrome内蔵AIはResolver内で最大8件へ分割し、LM Studioは最大20件を維持します。待機上限は100件です。表示待機500msと推論待機`requestTimeoutMs`（既定10秒、1〜60秒）は分離し、時間のかかるローカルモデルでも先にルール表示した後から更新できます。HTTP応答本文の受信・解析までタイムアウトの対象です。Chrome Prompt APIは`responseConstraint`を使い、LM StudioのJSON Schema、JSON Object、テキスト互換形式とともにruntime validationを共通化しています。Chrome側はsystem promptだけのbase sessionをService Worker内で遅延作成し、batchごとにcloneして必ずdestroyします。Service Worker再起動時はsessionを再生成します。`downloadable`と`downloading`では通常分類から`create()`せず、Options画面のユーザー操作だけが初回モデル準備を開始します。プロンプトに日本語の問題例・安全例を含め、コメント内の命令を分類データとして扱うよう指示します。明らかなリアクションはAIへ送らず、広いprefilterも候補抽出にだけ使います。

`sessionLearning`が有効な場合、曖昧域に対するAIの強い問題判定を現在のチャットフレーム内で再利用します。異なる3本文の共通文節で、文節単独でも同じカテゴリの高スコアをAIが返したものだけを一時ルールに昇格し、判定根拠として表示します。Zero-score Auditの結果は同一正規化本文のTTLキャッシュにだけ保存し、一時ルールの学習材料にはしません。設定変更時はキャッシュ・学習・監査状態を消去して古いキューを破棄し、古い非同期結果を適用しません。監査通信の失敗後は30秒停止し、短時間スパム履歴は時刻に応じて期限切れにします。学習データは外部送信も永続保存もしません。

カテゴリごとの表示方法は設定したモードを優先し、`threshold`だけ通常のスコア閾値を使います。スパムの投稿頻度による証拠は内容カテゴリの表示設定で打ち消しません。デバッグモードの履歴は対応理由と判定元を確認するためだけに使い、外部送信や永続保存を行いません。

新しいAI設定は`schemaVersion: 1`の既存設定読み込み時に`localAiMode: auto`とChrome内蔵AI有効を既定値として補完します。バッチ数、曖昧域、待ち時間は契約の上限・下限内へ正規化します。ローカルホスト権限の要求はAIを有効化するユーザー操作からだけ行い、接続確認は既存権限で動作します。
