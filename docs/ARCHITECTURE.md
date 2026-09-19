# ChatSanity Architecture

## 処理フロー

```text
YouTube chat DOM
  -> YouTube Adapter
  -> Normalizer
  -> Safe Fast Path (owner/mod/self/whitelist/stamps/allowed words)
  -> Hidden users
  -> Human Feedback Exact Memory (only reliable normalized-text consensus)
  -> Feature Extraction / Rule Scoring
  -> Context Modifier / Spam Detector / Session author boost
  -> ambiguous or sampled/all unmatched: Service Worker -> LocalAiResolver
       -> Chrome Built-in AI -> LM Studio -> Rules
  -> action selection
  -> Renderer (YouTube標準チャット)
  -> original YouTube node
  -> optional FlowChatBridge (DOM handshake)
```

Content ScriptはYouTubeのチャットフレームで新着ノードを監視し、AdapterがDOMを`ChatMessage`へ変換します。Normalizer以降はDOMから独立したデータを扱います。

配信者・モデレーター・自分の投稿・スーパーチャットは`excluded`としてルール判定、AI送信、インラインフィードバックの対象外にします。明らかなリアクションはSafe Fast Pathで終了し、それ以外は対象検出、命令形、責任追及、能力攻撃、比較、meta conflict、配信不満、安全文脈をfeature単位で抽出してRuleScoreへ集約します。ルール結果には`excluded`、`explicit-safe`、`matched`、`unmatched`のDispositionを付けます。ルールだけで結果が確定するコメントは即時にRendererへ渡します。曖昧域のコメントと、`unmatched`かつ0点からZero-score Auditに選ばれたコメントは、一時IDと正規化済み本文に、同一投稿者の直近リスク投稿・直近のリスク投稿・対立度だけを加えてService Workerへ送り、Local AI Providerの構造化結果とルール結果を合成します。Zero-score Auditは通常の抽選に加え、明示設定時だけ全件を選べます。投稿者名、チャンネル情報、DOM、メンバー状態は送信しません。

## 責務の境界

| 領域           | 主なファイル                                 | 責務                                                             |
| -------------- | -------------------------------------------- | ---------------------------------------------------------------- |
| 拡張設定       | `wxt.config.ts`                              | Manifest共通設定、通常権限、任意ホスト権限                       |
| Content Script | `entrypoints/content.ts`                     | DOM監視、重複防止、処理のオーケストレーション                    |
| Service Worker | `entrypoints/background.ts`                  | Local AI Provider選択、Chrome Prompt API・LM Studio通信          |
| 公開契約       | `lib/types.ts`                               | 設定、判定結果、診断、メッセージの型                             |
| ルール判定     | `lib/filter/`                                | 正規化、feature抽出、カテゴリスコア、スパム、アクション決定      |
| AI通信         | `lib/batch-queue.ts`、`lib/local-ai/`        | バッチ、Provider選択、session、timeout、safe記憶、構造化結果検証 |
| フィードバック | `lib/feedback/`                              | IndexedDB保存、同文exact memory、ルール別統計、JSONL出力         |
| YouTube統合    | `lib/youtube/`                               | DOM抽出と非破壊Renderer                                          |
| Flow Chat連携  | `lib/integrations/flow-chat/`                | `ylcfr-*` DOMプロトコル、締切、メトリクス                        |
| 設定保存       | `lib/settings.ts`、`lib/storage.ts`          | 既定値、検証、`storage.sync`永続化                               |
| UI             | `entrypoints/popup/`、`entrypoints/options/` | 簡易操作と詳細設定                                               |

## 状態と保存先

`chrome.storage.sync`へ保存するのは`SettingsV1`だけです。プリセット、閾値、語句、モデレーター投稿の固定表示、非表示ユーザーとホワイトリストのチャンネルID・表示名、Local AI mode、Chrome内蔵AI・LM Studio設定、Flow Chat連携のON/OFFと除外基準を含み、`schemaVersion: 1`で将来の移行境界を示します。通常のコメント本文・診断履歴・セッション集計は保存しません。AIが`safe`と確定した正規化本文だけは、本文そのものを保存せず、SHA-256フィンガープリント、Provider、confidence/score、学習時刻を`chrome.storage.local`へ最大1,000件保存します。投稿者、チャンネル、配信情報は含めません。

ユーザーが「正しい / 間違い」または「問題コメント」を明示的に送信した場合だけ、`chat-sanity-feedback` IndexedDBへフィードバックを保存します。`feedback`ストアにはその本文、正規化本文、予測・訂正カテゴリ、スコア、アクション、rule ID、feature、判定元、数値の文脈補正と時刻を保存します。`exactMemory`ストアは正規化本文ごとのカテゴリ票を、`ruleStats`ストアはrule IDごとの正解・誤判定・見逃し集計を持ちます。投稿者名・チャンネルID・周辺コメント履歴は保存しません。IndexedDBデータは同期されず、自動外部送信もしません。JSONL出力と全件消去はOptions画面の明示操作からだけ行います。

判定履歴、処理済みDOM、通常の同文キャッシュはチャットフレームのメモリ内にだけ保持し、タブ終了時に破棄します。デバッグ履歴は直近200件、通常キャッシュは最大500件で、TTLは10分です。例外としてAIのsafe完全一致記憶だけは、本文を含まないフィンガープリントとして配信をまたいで保持します。

ルールID・feature・カテゴリ別スコアは診断用の結果にだけ付加し、設定同期や外部サービスへ保存しません。評価用の`tests/evaluation/`には本文と匿名化した出典IDだけを置き、投稿者IDや生ログは含めません。

ポップアップ表示用の件数と接続状態だけは、Service Workerの休止をまたいで参照できるよう`chrome.storage.session`へ一時保存します。コメント本文や判定理由は含めず、タブの読み込み直し・終了時に削除します。

Flow Chat連携を有効にした場合だけ、Content Scriptが`html.ylcfr-active`を付けます。`#items`直下でFlow Chatが観測し得る要素は、ルール・文脈判定または解析対象外の即時許可で、700〜800msの締切より前に必ず`ylcfr-filtered-message`へ確定します。除外する要素は`ylcfr-deleted-message`を先に付けます。Flow Chatが未導入でもクラスは無害で、通常のYouTube表示判定とは独立しています。遅れて届くローカルAI結果がFlow Chatの除外基準へ上がった場合は、待機を再開せず、確定済み要素へ`ylcfr-deleted-message`を追加して流れている表示から除外します。安全側へ下がった結果では、一度除外した表示を再流入させません。メトリクスはデバッグモード中だけフレーム単位のメモリへ送り、Service Workerでは集計値だけを保持します。

## 失敗時の設計

Local AIは補助判定であり、必須依存ではありません。Prompt API不存在、モデル未準備、session作成失敗、Abort・Quotaエラー、LM Studioの権限拒否・未起動・HTTPエラー、timeout、不正JSON、非対応レスポンスのいずれでもルール結果へ戻ります。Auto modeではChrome内蔵AI、LM Studio、ルールの順にfallbackし、同じProviderが3回連続で失敗すると30秒間そのProviderを停止します。AI待機によってYouTubeチャット全体を停止させてはいけません。

RendererはYouTubeの元ノードを削除しません。属性とCSSで表示を制御するため、フィルター解除やユーザー操作による原文復元が可能です。`ぼかし`は本文だけ、`非表示`は同じぼかしをアイコンと発言者IDまで広げます。設定が有効な場合だけモデレーター投稿へ元ノードのままsticky表示を付け、DOM上で最後の投稿を最前面にします。固定行が存在する間はYouTubeの仮想スクロール用`#item-offset`のoverflowと`#items`のtransformをsticky向けに補正し、固定行がなくなると補正も解除します。設定を無効化した場合は既存のsticky表示も解除します。背景色はYouTubeのテーマ用CSS変数を使用し、ライト／ダークテーマに追従します。

Flow Chat側の連携クラスは`lib/integrations/flow-chat/constants.ts`へ隔離しています。現行の公開DOM契約（`ylcfr-active`、`ylcfr-filtered-message`、`ylcfr-deleted-message`）に依存するため、Flow Chat更新時はこのファイルとプロトコルテストを確認します。

## AI補助判定と一時学習

通常のAI対象は設定で狭められる0.35〜0.80の曖昧域です。これに加え、Local AIとZero-score Auditが有効な場合だけ、`unmatched`かつ0点を監査候補にします。通常はLM Studio単独で基礎確率3%・12件/分・同時20件を既定とし、Chrome内蔵AIを優先する構成では基礎確率1%・3件/分・同時2件を上限にします。10秒内の本文頻度、弱い監査シグナル、対立度を加味し、最終確率は最大50%です。`checkAllUnmatched`を有効にした場合は抽選・毎分上限・監査同時数を適用せず、すべての監査候補をAIキューへ渡します。ただしキュー自体のバッチ数・待機数・待機時間によるload sheddingは維持します。監査はContent Scriptで行い、ルールスコアへは影響しません。無効化・配信者／モデレーター／自分／スーパーチャット／ホワイトリスト除外、許可語句、ブロック語句、非表示ユーザー、カテゴリルール、スパム、セッション加重の順序を維持します。同一セッションでぼかし・非表示が続いた投稿者は後続コメントのスコアを上げ、閾値に達したチャンネルIDだけを非表示ユーザーへ記録します。AI結果にもカテゴリの有効状態と重みを適用し、スパム判定はAIで打ち消しません。診断プレビューも共通の`mergeAiResult`を使用します。

200ms単位でバッチを1つずつ実行します。Chrome内蔵AIを優先する自動モードとChrome内蔵AI単独では1バッチ最大8件、LM Studio単独では設定した最大20件を使います。実行中の待機は1バッチだけ保持し、満杯時は最古のpending項目をルール判定へ戻して最新項目を受け入れます。待機時間が1.25秒を超えた項目はAIへ送りません。これらのload sheddingはProvider障害として扱わず、診断時だけ混雑・期限切れを記録します。表示待機500ms、Chrome推論timeout（固定10秒）、LM Studioの`requestTimeoutMs`（既定10秒、1〜60秒）は分離し、先にルール表示した後からAI結果で更新できます。HTTP応答本文の受信・解析までLM Studio timeoutの対象です。Chrome Prompt APIは`responseConstraint`を使い、LM StudioのJSON Schema、JSON Object、テキスト互換形式とともにruntime validationを共通化しています。Chrome側はsystem promptだけのbase sessionをService Worker内で遅延作成し、batchごとにcloneして必ずdestroyします。Service Worker再起動時はsessionを再生成します。`downloadable`と`downloading`では通常分類から`create()`せず、Options画面のユーザー操作だけが初回モデル準備を開始します。プロンプトに日本語の問題例・安全例を含め、コメント内の命令を分類データとして扱うよう指示します。明らかなリアクションはAIへ送らず、広いprefilterも候補抽出にだけ使います。

`sessionLearning`が有効な場合、曖昧域に対するAIの強い問題判定を現在のチャットフレーム内で再利用します。異なる3本文の共通文節で、文節単独でも同じカテゴリの高スコアをAIが返したものだけを一時ルールに昇格し、判定根拠として表示します。問題判定とZero-score Auditの非safe結果は同一正規化本文のTTLキャッシュにだけ保存し、一時ルールの学習材料にはしません。safe結果はService WorkerでSHA-256フィンガープリントへ変換して保存し、次の配信ではLocal AIへ送らず完全一致の`explicit-safe`として利用します。Content Script間にはフィンガープリントだけを同期します。設定変更時は通常キャッシュ・一時学習・監査状態を消去して古いキューを破棄しますが、safe記憶は維持します。監査通信の失敗後は30秒停止し、短時間スパム履歴は時刻に応じて期限切れにします。

safe記憶の優先順位は、無効化・配信者／モデレーター／自分／スーパーチャット、ホワイトリスト、許可語句、ブロック語句、非表示ユーザー、Human Feedback exact memoryの後、通常のカテゴリルールより前です。したがって明示的なユーザー設定と人間による訂正は過去のAI判定を上書きできます。記憶にない本文を含むバッチだけをProviderへ送り、記憶済みsafeと未記憶結果を元の順序へ戻してContent Scriptへ返します。

## Human Feedback

Human Feedbackは、設定・ルール・AIセッション学習とは独立した層です。無効化、配信者／モデレーター／自分、ホワイトリスト、許可語句、ブロック語句、非表示ユーザーの既存優先順位を保った後、通常のルールより先にexact memoryを照合します。同じ正規化本文について一意の最多カテゴリがあり、支持率が60%以上の場合だけ利用します。`safe`は表示を維持し、問題カテゴリはサンプル数に応じた保守的なスコアで表示アクションを選びます。競合票、`unknown`、無効なカテゴリは通常のルール判定へ戻します。

exact memoryを使った結果には`HUMAN_FEEDBACK_EXACT_001`と`human-feedback-exact`を付け、診断で由来を識別できます。人間の訂正をもとに一般的なphraseルールを作ること、既存`rules.ts`を自動変更すること、保存済みのフィードバックをLocal AIへfew-shotとして自動送信することはv1では行いません。

カテゴリごとの表示方法は設定したモードを優先し、`threshold`だけ通常のスコア閾値を使います。スパムの投稿頻度による証拠は内容カテゴリの表示設定で打ち消しません。デバッグモードの履歴は対応理由と判定元を確認するためだけに使い、外部送信や永続保存を行いません。

新しいAI設定は`schemaVersion: 1`の既存設定読み込み時に`localAiMode: auto`とChrome内蔵AI有効を既定値として補完します。バッチ数、曖昧域、待ち時間は契約の上限・下限内へ正規化します。ローカルホスト権限の要求はAIを有効化するユーザー操作からだけ行い、接続確認は既存権限で動作します。
