# 今後の開発ロードマップ — MISE TASK

## 優先度 高

### 1. データベース移行（Supabase推奨）
現在 `localStorage` のみのため、複数端末・複数スタッフでの同時利用ができません。

**移行ステップ:**
1. Supabase プロジェクト作成
2. テーブル作成（`DATA_MODELS.md` のスキーマをそのまま使用可）
3. `useLS()` フックを `useSupabase()` に置き換え
4. Netlify Environment Variables に Supabase URL / API Key を追加

**Supabase テーブル例（SQL）:**
```sql
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  store_id INTEGER,
  color TEXT,
  avatar TEXT
);

CREATE TABLE suppliers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token TEXT UNIQUE NOT NULL,
  order_methods TEXT[],
  line_id TEXT,
  self_registered BOOLEAN DEFAULT FALSE,
  registered_at DATE
);

CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  supplier_id TEXT REFERENCES suppliers(id),
  store_id INTEGER,
  items JSONB,
  status TEXT DEFAULT 'sent',
  sent_at TIMESTAMPTZ DEFAULT NOW(),
  delivered_at TIMESTAMPTZ,
  inspected BOOLEAN DEFAULT FALSE
);
```

---

### 2. 認証強化
現在はパスワード1つのみ。スタッフごとの個別認証が必要。

**推奨:** Supabase Auth（メール/パスワード or LINEログイン）

---

## 優先度 中

### 3. PWA（Progressive Web App）化
- `manifest.json` と Service Worker を追加
- オフライン対応
- ホーム画面に追加可能

### 4. リアルタイム同期
- Supabase Realtime を使用
- 別の端末で操作した内容が即時反映

### 5. PDF発注書出力
- `pdf-lib` または `jsPDF` でPDF生成
- 発注書PDFを業者にメール添付

---

## 優先度 低

### 6. 通知機能
- ブラウザ Push Notification
- 在庫不足・タスク期限をプッシュ通知

### 7. 多言語対応
- i18n（日本語・英語・中国語）

### 8. レポート機能
- 月次在庫・発注コストのグラフ
- スタッフごとのタスク完了率

---

## API設計（将来のバックエンド分離時）

```
GET    /api/suppliers          業者一覧
POST   /api/suppliers          業者追加
GET    /api/suppliers/:id      業者詳細
PUT    /api/suppliers/:id      業者更新
DELETE /api/suppliers/:id      業者削除

GET    /api/orders             発注一覧
POST   /api/orders             発注作成
PUT    /api/orders/:id/inspect 検品完了

GET    /api/inventory          在庫一覧
PUT    /api/inventory/:id      在庫更新

POST   /api/line/push          LINE Push送信
POST   /api/line/webhook       LINE Webhook受信（既存のNetlify Functionを流用）
```

