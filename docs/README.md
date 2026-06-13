# MISE TASK — ラーメン店舗管理システム

## 概要

ラーメン店の本部・店舗スタッフ向けタスク・発注管理システム。
Netlify上でホスティングするシングルページアプリケーション（SPA）。

---

## ファイル構成

```
mise-task-package/
├── src/
│   ├── index.html          # メインアプリ（全機能含む）
│   └── supplier-reg.html   # 業者セルフ登録ページ（QRリンク先）
├── netlify/
│   └── functions/
│       ├── send-line.js    # LINE Push送信 API
│       └── line-webhook.js # LINE 友だち追加 Webhook受信
├── netlify.toml            # Netlify設定ファイル
├── docs/
│   └── ARCHITECTURE.md     # システム構成・技術仕様
└── README.md               # このファイル
```

---

## 技術スタック

| 項目 | 内容 |
|------|------|
| フロントエンド | React 18 (CDN via Babel) |
| スタイリング | インラインスタイル（Tailwindなし） |
| ホスティング | Netlify |
| サーバー | Netlify Functions (AWS Lambda) |
| データ保存 | localStorage（現在） |
| 外部API | LINE Messaging API |
| フォント | Noto Sans JP（Google Fonts） |

---

## 主要機能

### 認証
- スタッフ選択（セレクトボックス）
- 本部アカウントにパスワード保護（デフォルト: `1234`）
- 店舗切り替えにもパスワード確認

### 店舗・スタッフ管理
- 店舗の追加・編集・削除
- スタッフの追加・編集・削除（アバターカラー選択）
- 本部 / 店長 / スタッフ / アルバイト の4ロール

### タスク管理
- ルーティンタスクのスケジューリング（毎日・平日・カスタム曜日・一回限り）
- 仕込みタスク・クリーニングタスク
- 本部タスク
- 未完了タスクの自動繰り越し

### 発注管理
- 在庫不足を自動検知して発注候補一覧を生成
- 業者ごとに発注まとめて送信
- LINE Messaging APIで業者のLINEに自動Push送信
- 検品チェック（発注 → 受取 → 在庫反映）

### 業者管理
- QR/URL発行で業者がセルフ登録
- 業者が受注方法（メール/LINE/Instagram/X/その他）を自分で設定
- LINE User IDをWebhookで自動取得

### 在庫管理
- 在庫数・最低在庫・発注量の管理
- 単価変更履歴

### 開閉店チェック
- 開店・閉店チェックリスト
- チェック項目のカスタマイズ

### その他
- ダッシュボード（本日の状況サマリー）
- AI自動入力（Anthropic Claude API）
- 評価・コミッション管理

---

## デプロイ手順

### 1. Netlifyにデプロイ

```bash
# Netlify CLIを使う場合
npm install -g netlify-cli
netlify deploy --prod --dir=src
```

またはNetlifyダッシュボードからドラッグ&ドロップ

### 2. 環境変数を設定

Netlify → Site configuration → Environment variables に追加：

| Key | Value |
|-----|-------|
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE Messaging APIのChannel Access Token |

### 3. LINE Webhook URLを設定

LINE Developers Console → Messaging API設定 → Webhook URL:

```
https://あなたのサイト.netlify.app/.netlify/functions/line-webhook
```

---

## データ保存について（現在の制約）

現在 `localStorage` を使用しているため：

- ✅ 同じブラウザ・端末なら再読み込みしても保存される
- ❌ 別の端末・ブラウザからは見えない
- ❌ プライベートモードでは保存されない

### 本番運用に向けた推奨移行先

| オプション | 特徴 |
|-----------|------|
| **Supabase** | PostgreSQL、認証、リアルタイム対応、無料枠あり（推奨） |
| **Firebase** | NoSQL、Googleアカウント連携、無料枠あり |
| **PlanetScale** | MySQL互換、スケーラブル |

---

## localStorageのキー一覧

| キー | 内容 |
|------|------|
| `mise_users` | スタッフ情報 |
| `mise_stores` | 店舗情報 |
| `mise_suppliers` | 業者情報 |
| `mise_orders` | 発注履歴 |
| `mise_inventory` | 在庫情報 |
| `mise_recipes` | レシピ |
| `mise_routines` | ルーティンタスク設定 |
| `mise_prep_tasks` | 仕込みタスク履歴 |
| `mise_clean_tasks` | クリーンタスク履歴 |
| `mise_open_items` | 開店チェックリスト |
| `mise_close_items` | 閉店チェックリスト |
| `mise_task_cats` | タスクカテゴリ |
| `mise_admin_pw` | 管理者パスワード |
| `mise_last_carry_date` | タスク繰り越し処理日 |

---

## ログイン情報（初期値）

| 項目 | 値 |
|------|-----|
| 管理者パスワード | `1234` |
| 本部アカウント | 「本部」ロールのユーザーを選択後にPW入力 |

---

## LINE連携の仕組み

```
業者にQR/URLを送付
      ↓
業者がURLを開く（supplier-reg.html）
      ↓
① 会社情報入力
② 受注方法選択（LINE選択）
③ LINE公式アカウントを友だち追加
      ↓
Webhook（line-webhook.js）が発火
      ↓
業者のLINEに「連携コード（User ID）」が届く
      ↓
業者がコードを入力欄にペースト → 登録完了
      ↓
発注時: send-line.js → LINE Messaging API → 業者のLINEに発注内容が届く
```

---

## 今後の開発ロードマップ（提案）

1. **データベース移行** — Supabaseでリアルタイム同期
2. **認証強化** — Supabase Auth でスタッフごとのログイン
3. **PWA化** — オフライン対応・ホーム画面追加
4. **通知機能** — プッシュ通知（在庫不足・タスク期限）
5. **帳票出力** — PDF発注書の自動生成
6. **多言語対応** — 日本語・英語切り替え

