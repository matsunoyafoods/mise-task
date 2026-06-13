# セットアップガイド — MISE TASK

## 1. Netlify デプロイ手順

### ① Netlifyアカウントを作成
https://app.netlify.com にアクセスしてアカウントを作成してください。

### ② ファイルをアップロード
Netlify ダッシュボードの **「Sites」→「Add new site」→「Deploy manually」** を開き、
以下のフォルダ構成ごとドラッグ&ドロップしてください。

```
（デプロイするフォルダ）
├── index.html          ← src/ の中のファイル
├── supplier-reg.html   ← src/ の中のファイル
├── netlify.toml
└── netlify/
    └── functions/
        ├── send-line.js
        └── line-webhook.js
```

> ⚠️ `netlify.toml` とフォルダ `netlify/` は同じ階層に置いてください。

### ③ 環境変数を設定
Netlify ダッシュボード →「Site configuration」→「Environment variables」→「Add variable」

| Key | Value |
|-----|-------|
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE Messaging APIのChannel Access Token |

### ④ LINE Webhook URLを設定
[LINE Developers Console](https://developers.line.biz) →
Messaging API設定 → Webhook URL に以下を入力：

```
https://（あなたのサイト名）.netlify.app/.netlify/functions/line-webhook
```

「検証」ボタンを押して **成功** と表示されれば完了。

---

## 2. 初期設定

### 管理者パスワード
初期パスワードは `1234` です。
ログイン後、スタッフ管理画面の「🔑 PW変更」から変更してください。

### スタッフ登録手順
1. 「本部」ロールでログイン（PW: 1234）
2. 「スタッフ管理」→「＋ スタッフを追加」
3. 名前・ロール・所属店舗を設定して保存

### 業者登録手順
1. 「発注管理」→「＋ 業者登録 QR / URL 発行」
2. 業者名を入力して「QR / URL を発行する」
3. 表示されたQRコードまたはURLを業者に送付
4. 業者がURLを開いて自分で情報登録

---

## 3. LINE連携セットアップ（業者側）

業者がURLを開くと以下のステップで登録できます：

1. **会社情報入力**（会社名・担当者名・電話番号）
2. **受注方法選択**（LINE を選択）
3. **友だち追加**（画面のボタンから店舗のLINE公式アカウントを友だち追加）
4. **連携コード入力**（LINEに届いたUser IDをコピペ）

登録完了後、発注時に自動でLINEにメッセージが届くようになります。

---

## 4. データ移行（将来のSupabase移行時）

現在 `localStorage` に保存されているキーは以下の通りです：

```
mise_users / mise_stores / mise_suppliers / mise_orders
mise_inventory / mise_recipes / mise_routines
mise_prep_tasks / mise_clean_tasks
mise_open_items / mise_close_items
mise_task_cats / mise_admin_pw / mise_last_carry_date
```

移行時はこれらのキーをAPIに置き換えるだけで対応できます。

