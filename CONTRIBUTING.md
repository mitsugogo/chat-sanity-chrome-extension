# ChatSanityへのコントリビュート

## セットアップ

Node.jsとpnpmを用意し、リポジトリ直下で次を実行します。

```powershell
pnpm install
pnpm dev
```

Chromeの`chrome://extensions`でデベロッパーモードを有効にし、`.output/chrome-mv3-dev`を「パッケージ化されていない拡張機能を読み込む」から選択します。

## 変更の進め方

1. 判定ロジック、DOM操作、Chrome API、UIのどの層を変更するか確認します。
2. ロジックは`lib/`、拡張エントリーポイントは`entrypoints/`、表示用CSSは対応する画面または`styles/`へ配置します。
3. 変更内容に対応するVitestを`tests/`へ追加します。
4. `pnpm check`を実行します。
5. UI変更はChromeでポップアップと詳細設定を目視確認します。

プライバシー、判定順序、LM Studio通信、Manifest権限の具体的な制約は`AGENTS.md`を参照してください。

## テストの目安

- 正規化・ルール・スコア・閾値: `tests/normalize.test.ts`、`tests/engine.test.ts`
- バッチ・LM Studio: `tests/batch-queue.test.ts`、`tests/lm-studio.test.ts`
- YouTube DOMとRenderer: `tests/youtube.test.ts`
- ポップアップ・詳細設定: `tests/popup.test.tsx`、`tests/options.test.tsx`

不具合修正では、可能な限り先に再現テストを追加し、そのテストが修正後に成功することを確認してください。

## Production build

```powershell
pnpm build
```

Chromeへ読み込む成果物は`.output/chrome-mv3`です。`.output/`内は生成物なので直接編集しません。
