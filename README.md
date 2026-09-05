# ChatSanity

YouTube Live Chat向けのManifest V3 Chrome拡張です。日本語チャットをルールベースで分類し、必要な場合だけLM StudioのローカルLLMへ曖昧なコメントを送ります。

## 開発

```powershell
pnpm install
pnpm dev
```

Chromeの `chrome://extensions` で「デベロッパー モード」を有効にし、WXTが生成した `.output/chrome-mv3-dev` を「パッケージ化されていない拡張機能を読み込む」から選択します。

本番用ビルドは次のコマンドで `.output/chrome-mv3` に生成されます。

```powershell
pnpm build
```

## LM Studio

1. LM Studioでモデルを読み込み、Developer画面からローカルサーバーを開始します。
2. ChatSanityの詳細設定で「LM Studioを使用する」を有効にします。
3. ローカル接続の権限を許可し、モデルを選択して設定を保存します。

初期接続先は `http://127.0.0.1:1234` です。コメント本文はlocalhost以外へ送信せず、履歴も永続保存しません。LM Studioが利用できない場合はルールベース判定へ戻ります。

## 検証

```powershell
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

対象画面はYouTubeのライブチャット、ポップアウトチャット、アーカイブのチャットリプレイです。通常動画のコメント欄は対象外です。
