# ChatSanity Agent Guide

このファイルはリポジトリ全体に適用されます。ChatSanityを変更するエージェントは、ユーザーからの明示的な指示を最優先にしたうえで、以下の方針を守ってください。

## プロダクトの範囲

- Manifest V3のChrome拡張として実装する。初期版ではEdge、Chrome Web Store申請、通常動画のコメント欄を対象にしない。
- 対象はYouTube Live Chat、ポップアウトチャット、アーカイブのチャットリプレイ。
- UIは日本語を基本とし、採用済みの白・濃紺・ティールを中心とした簡素なデザインを維持する。
- クラウドAI、テレメトリ、外部分析、コメント履歴の永続保存を追加しない。

## アーキテクチャ

- `entrypoints/content.ts`: チャットフレーム内の処理を組み立てる。DOM抽出、判定、表示の詳細ロジックをここへ集約しない。
- `lib/youtube/adapter.ts`: YouTube DOMから`ChatMessage`を抽出する。ライブとリプレイの差分を吸収する。
- `lib/filter/normalize.ts`: コメント本文の純粋な正規化処理。
- `lib/filter/rules.ts`: カテゴリ別のルールとスコア。
- `lib/filter/spam.ts`: ユーザー単位の短時間投稿・同文・絵文字スパム判定。
- `lib/filter/engine.ts`: 判定順序、スコア合成、表示アクションを決める。
- `lib/youtube/renderer.ts`: 元ノードを削除せず、属性とCSSで薄表示・ぼかし・置換・復元を行う。
- `entrypoints/background.ts`: LM Studioとの外部通信を一元化する。Content Scriptから直接fetchしない。
- `entrypoints/popup/`: 有効化、プリセット、今回の件数、AI状態、詳細設定リンクだけを扱う。
- `entrypoints/options/`: 閾値、カテゴリ、語句、スパム、LM Studio、診断プレビューを扱う。
- 公開型とContent Script・Service Worker間のメッセージ型は`lib/types.ts`を正とする。

詳しいデータフローは`docs/ARCHITECTURE.md`を参照してください。

## 変更してはいけない契約

- 判定順序は「無効化・配信者／モデレーター除外 → 許可語句 → ブロック語句 → カテゴリルール → スパム → 必要時のみLM Studio」。
- 初期閾値は`< 0.50: 表示`、`0.50–0.74: 薄く表示`、`0.75–0.89: ぼかし`、`>= 0.90: 非表示`。
- AI対象はルールスコア`0.35–0.80`の曖昧域だけとする。
- LM Studioへ送信できるのは一時IDと正規化済み本文だけ。ユーザー名、チャンネル情報、DOM、履歴を送らない。
- AI返却値は`{ id, category, score }[]`。表示アクションは拡張側で決める。
- AIは最大20件・200ms単位でバッチ処理する。500msでルール結果を表示し、遅れて成功した場合だけ更新する。
- LM Studioが未接続、不正JSON、非対応、タイムアウト、HTTPエラーの場合は必ずルール結果へ戻す。
- 非表示コメントの元ノードを削除しない。「フィルター済み」行から原文・カテゴリ・理由を一時表示できる状態を保つ。
- `chrome.storage.sync`に保存するのは`schemaVersion: 1`の設定だけ。コメント本文、診断履歴、セッション集計を保存しない。
- ポップアップ用の件数と接続状態は、コメント本文を含めず`chrome.storage.session`へ一時保存してよい。タブの再読み込み・終了時に削除する。
- LM Studioのホスト権限は任意権限のままにし、ユーザーがAIを有効化した操作からのみ要求する。
- 各プリセットのカテゴリ設定は独立させ、詳細編集しても選択中のプリセットIDを維持する。

契約自体を変更する依頼では、実装、型、既定値、テスト、README、設計文書を同じ変更内で更新してください。

## WXTとManifest

- エントリーポイントはWXTの規約に従って`entrypoints/`へ置く。
- `options_ui.open_in_tab`は`entrypoints/options/index.html`の`manifest.open_in_tab`メタタグから生成される。`wxt.config.ts`へ重複定義しない。
- YouTubeのmatch patternと`all_frames: true`はContent Script側で管理する。
- 生成物の`.output/`と`.wxt/`は直接編集しない。
- 通常権限を増やさない。追加が必要な場合は用途と最小スコープを説明し、生成Manifestも確認する。

## 実装方針

- TypeScriptの型を維持し、曖昧な`any`、型アサーション、非nullアサーションで問題を隠さない。
- 判定ロジックは可能な限り純粋関数にし、DOM依存とChrome API依存を境界へ寄せる。
- YouTubeのDOMセレクタは一箇所に集約し、ライブとリプレイ両方の最小フィクスチャで検証する。
- 長寿命のDOMノードを通常の`Set`や`Map`へ保持しない。処理済みノードには`WeakSet`を使用する。
- UIコントロールには可視ラベルまたはアクセシブルネームを付け、キーボード操作を壊さない。
- 依存関係を更新しない変更では`pnpm install`を実行しない。ロックファイルの不要な差分を避ける。
- パッケージはpnpmを使用する。npmやyarnのロックファイルを追加しない。

## 検証

変更範囲に対応するテストを追加または更新し、最低限次を実行します。

```powershell
pnpm typecheck
pnpm lint
pnpm test
pnpm format:check
pnpm build
```

ビルド後は`.output/chrome-mv3/manifest.json`で次を確認します。

- `manifest_version`が3
- 通常権限が`storage`のみ
- localhostと127.0.0.1が`optional_host_permissions`
- YouTubeライブチャットとリプレイのmatch pattern
- Content Scriptの`all_frames: true`
- `options_ui.open_in_tab: true`

UIを変更した場合は、ポップアップの400px幅と詳細設定のデスクトップ／狭幅表示を実ブラウザで確認します。実際のYouTubeやLM Studioを確認できない場合は、未確認事項を完了報告で明示してください。

## 完了報告

- 変更した機能と主要ファイルを簡潔に示す。
- 実行した検証と結果を示す。
- 実配信、チャットリプレイ、LM Studio接続など未確認の外部状態を、確認済みと表現しない。
- 無関係な既存変更には触れず、上書きや削除をしない。
