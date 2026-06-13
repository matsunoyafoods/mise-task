# MISE TASK — エンジニア向けセットアップガイド

## 概要

ラーメン店舗管理SaaS「MISE TASK」のフロントエンドです。
**以下の3つを用意するだけで本番稼働できます。**

| # | やること | 設定箇所 |
|---|---------|---------|
| 1 | **DB構築 + REST API** | `CONFIG.API_BASE` |
| 2 | **Stripe連携** | `CONFIG.STRIPE_PUBLISHABLE_KEY` |
| 3 | **Claude AI プロキシ** | `CONFIG.AI_API_URL` |

---

## クイックスタート

### 1. CONFIG を編集（index.html 冒頭）

```js
const CONFIG = {
  API_BASE: "https://api.mise-task.app/v1",    // ← あなたのAPIサーバー
  AI_API_URL: "https://api.mise-task.app/v1/ai", // ← Claude APIプロキシ
  STRIPE_PUBLISHABLE_KEY: "pk_live_xxx",         // ← Stripeの公開キー
  USE_DEMO_DATA: false,  // ← false にする
};
```

### 2. デプロイ
```bash
# Netlify
netlify deploy --prod

# または任意の静的ホスティング
# index.html, supplier-reg.html を配置するだけ
```

---

## API仕様書

フロントエンドが呼び出す全エンドポイント一覧です。
`CONFIG.API_BASE` をプレフィックスとして付与されます。

### 認証

| Method | Endpoint | Request | Response |
|--------|----------|---------|----------|
| POST | `/auth/store-login` | `{code: "ABC123"}` | `{storeId, storeName, users: [{id,name,role,avatar,color}]}` |
| POST | `/auth/pin-login` | `{storeId, userId, pin}` | `{userId, token, user: {...}}` |
| POST | `/auth/honbu-login` | `{password}` | `{userId, token}` |

### ユーザー

| Method | Endpoint | Request/Params | Response |
|--------|----------|---------------|----------|
| GET | `/users?storeId=` | query: storeId | `[{id, name, role, avatar, color, store, pin}]` |
| POST | `/users` | `{name, role, store, color, pin}` | `{id, ...}` |
| PUT | `/users/:id` | `{name, role, store, ...}` | `{id, ...}` |
| DELETE | `/users/:id` | - | `{success: true}` |

### 店舗

| Method | Endpoint | Request | Response |
|--------|----------|---------|----------|
| GET | `/stores` | - | `[{id, name, code, storageGroups: [...]}]` |
| POST | `/stores` | `{name, code}` | `{id, ...}` |
| PUT | `/stores/:id` | `{name}` | `{id, ...}` |
| DELETE | `/stores/:id` | - | `{success: true}` |

### 在庫

| Method | Endpoint | Request/Params | Response |
|--------|----------|---------------|----------|
| GET | `/inventory?storeId=` | query: storeId | `[{id, name, category, storageGroup, unit, stock, minStock, orderQty, supplierId, unitPrice, bagSize, bagUnit}]` |
| PUT | `/inventory/:id` | `{stock, ...}` | `{id, ...}` |
| POST | `/inventory/stocktake` | `{storeId, items: [{id, stock}]}` | `{success: true}` |

### 業者

| Method | Endpoint | Request | Response |
|--------|----------|---------|----------|
| GET | `/suppliers` | - | `[{id, name, contact, sendMethod, lineId, fax, tel, token, orderMethods, selfRegistered}]` |
| POST | `/suppliers` | `{name, contact, ...}` | `{id, ...}` |
| PUT | `/suppliers/:id` | `{...}` | `{id, ...}` |
| POST | `/suppliers/issue-token` | `{name}` | `{token, registrationUrl}` |
| GET | `/suppliers/by-token/:token` | - | `{name, token, ...}` |
| POST | `/suppliers/register` | `{token, companyName, contactName, tel, methods, email, lineId, ...}` | `{success: true}` |

### 発注

| Method | Endpoint | Request | Response |
|--------|----------|---------|----------|
| GET | `/orders?storeId=` | query: storeId | `[{id, supplierId, storeId, items, status, sentAt, deliveredAt, sendMethod, inspected, inspectionLog}]` |
| POST | `/orders` | `{supplierId, storeId, items, sendMethod}` | `{id, ...}` |
| POST | `/orders/:id/send` | - | `{success: true}` ※LINE/メール送信も実行 |
| POST | `/orders/:id/inspect` | `{log: [{itemId, ordered, received, ok}]}` | `{success: true}` |

### レシピ

| Method | Endpoint | Request | Response |
|--------|----------|---------|----------|
| GET | `/recipes?storeId=` | query: storeId | `[{id, name, category, yield, description, image, ingredients, steps, allergens}]` |
| POST | `/recipes` | `{name, category, ...}` | `{id, ...}` |
| PUT | `/recipes/:id` | `{...}` | `{id, ...}` |

### タスク

| Method | Endpoint | Request/Params | Response |
|--------|----------|---------------|----------|
| GET | `/tasks/routines?storeId=` | query: storeId | `[{id, name, category, store, freq, customDays, deadline, assignedTo, recipeId, order, active}]` |
| POST | `/tasks/routines` | `{name, category, ...}` | `{id, ...}` |
| PUT | `/tasks/routines/:id` | `{...}` | `{id, ...}` |
| GET | `/tasks/prep?storeId=&date=` | query: storeId, date | `[{id, name, recipeId, deadline, store, assignedTo, date, completedAt, completedBy, amountVerified, amountLog}]` |
| GET | `/tasks/clean?storeId=` | query: storeId | `[{id, name, area, deadline, store, assignedTo, completedAt, completedBy, points}]` |
| POST | `/tasks/:id/complete` | `{completedBy, amountLog}` | `{success: true}` |
| POST | `/tasks/:id/assign` | `{userId}` | `{success: true}` |

### 開閉店チェック

| Method | Endpoint | Request | Response |
|--------|----------|---------|----------|
| GET | `/ops/checklist?type=open&storeId=` | query: type(open/close), storeId | `[{id, group, icon, label, note, estMin, normalRange, unit}]` |
| POST | `/ops/checklist` | `{type, storeId, items: [{id, completedAt, value, flag}]}` | `{success: true}` |

### AI（プロキシ）

`CONFIG.AI_API_URL` に対して呼び出します。

| Method | Endpoint | Request | Response |
|--------|----------|---------|----------|
| POST | `/chat` | `{messages: [...], system: "..."}` | Claude APIのレスポンスをそのまま返す `{content: [{type:"text", text:"..."}]}` |
| POST | `/analyze` | `{image: "base64...", mediaType: "image/jpeg", prompt: "...", system: "..."}` | 同上 |

**AIプロキシの実装例（Node.js）:**
```js
app.post("/v1/ai/chat", async (req, res) => {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      system: req.body.system,
      messages: req.body.messages,
    }),
  });
  const data = await response.json();
  res.json(data);
});
```

### 課金（Stripe）

| Method | Endpoint | Request | Response |
|--------|----------|---------|----------|
| GET | `/billing/plans` | - | `[{id, name, price, features}]` |
| GET | `/billing/current` | - | `{id, name, nextBillingDate}` or `null` |
| POST | `/billing/checkout` | `{planId}` | `{sessionId}` ※Stripe Checkout Session |
| POST | `/billing/portal` | - | `{url}` ※Stripe Customer Portal |

### 価格履歴

| Method | Endpoint | Response |
|--------|----------|----------|
| GET | `/price-history` | `[{id, supplierId, itemName, oldPrice, newPrice, changedAt, notifiedHonbu}]` |

---

## DBスキーマ案

技術選定は自由です（PostgreSQL, MySQL, MongoDB, Supabase, Firebase 等）。
以下は推奨テーブル構造です。

```sql
-- 組織
CREATE TABLE organizations (
  id          UUID PRIMARY KEY,
  name        TEXT NOT NULL,
  stripe_customer_id TEXT,
  plan        TEXT DEFAULT 'solo',  -- 'solo' | 'chain'
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- 店舗
CREATE TABLE stores (
  id          SERIAL PRIMARY KEY,
  org_id      UUID REFERENCES organizations(id),
  name        TEXT NOT NULL,
  code        TEXT UNIQUE NOT NULL,  -- 店舗ログインコード
  storage_groups JSONB DEFAULT '[]',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ユーザー
CREATE TABLE users (
  id          SERIAL PRIMARY KEY,
  store_id    INT REFERENCES stores(id),
  name        TEXT NOT NULL,
  role        TEXT NOT NULL,  -- '本部','店長','スタッフ','アルバイト'
  avatar      TEXT,
  color       TEXT,
  pin_hash    TEXT,  -- bcryptハッシュ
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- 業者
CREATE TABLE suppliers (
  id          TEXT PRIMARY KEY,
  org_id      UUID REFERENCES organizations(id),
  name        TEXT NOT NULL,
  contact     TEXT,
  send_method TEXT,
  line_id     TEXT,
  fax         TEXT,
  tel         TEXT,
  token       TEXT UNIQUE,
  order_methods JSONB DEFAULT '[]',
  self_registered BOOLEAN DEFAULT FALSE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- 在庫
CREATE TABLE inventory (
  id          TEXT PRIMARY KEY,
  store_id    INT REFERENCES stores(id),
  name        TEXT NOT NULL,
  category    TEXT,
  storage_group TEXT,
  unit        TEXT,
  stock       NUMERIC DEFAULT 0,
  min_stock   NUMERIC DEFAULT 0,
  order_qty   NUMERIC DEFAULT 0,
  supplier_id TEXT REFERENCES suppliers(id),
  unit_price  NUMERIC DEFAULT 0,
  bag_size    NUMERIC,
  bag_unit    TEXT
);

-- レシピ
CREATE TABLE recipes (
  id          TEXT PRIMARY KEY,
  store_id    INT REFERENCES stores(id),
  name        TEXT NOT NULL,
  category    TEXT,
  yield       TEXT,
  description TEXT,
  image       TEXT,
  ingredients JSONB DEFAULT '[]',
  steps       JSONB DEFAULT '[]',
  allergens   JSONB DEFAULT '[]'
);

-- 発注
CREATE TABLE orders (
  id          TEXT PRIMARY KEY,
  supplier_id TEXT REFERENCES suppliers(id),
  store_id    INT REFERENCES stores(id),
  items       JSONB NOT NULL,
  status      TEXT DEFAULT 'draft',  -- 'draft','sent','delivered'
  sent_at     TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  send_method TEXT,
  inspected   BOOLEAN DEFAULT FALSE,
  inspection_log JSONB DEFAULT '[]'
);

-- ルーティンタスク定義
CREATE TABLE routines (
  id          TEXT PRIMARY KEY,
  store_id    INT REFERENCES stores(id),
  name        TEXT NOT NULL,
  category    TEXT,  -- 'prep','clean','order','meet','maint'
  freq        TEXT,  -- 'daily','weekday','custom','once'
  custom_days JSONB DEFAULT '[]',
  once_date   TEXT,
  deadline    TEXT,
  assigned_to INT REFERENCES users(id),
  recipe_id   TEXT REFERENCES recipes(id),
  sort_order  INT DEFAULT 0,
  active      BOOLEAN DEFAULT TRUE
);

-- 仕込みタスク（日次）
CREATE TABLE prep_tasks (
  id          TEXT PRIMARY KEY,
  store_id    INT REFERENCES stores(id),
  name        TEXT NOT NULL,
  recipe_id   TEXT REFERENCES recipes(id),
  deadline    TEXT,
  assigned_to INT REFERENCES users(id),
  date        DATE NOT NULL,
  completed_at TEXT,
  completed_by INT REFERENCES users(id),
  amount_verified BOOLEAN DEFAULT FALSE,
  amount_log  JSONB DEFAULT '[]',
  carried_from TEXT
);

-- クリーンタスク
CREATE TABLE clean_tasks (
  id          TEXT PRIMARY KEY,
  store_id    INT REFERENCES stores(id),
  name        TEXT NOT NULL,
  area        TEXT,
  deadline    TEXT,
  assigned_to INT REFERENCES users(id),
  completed_at TEXT,
  completed_by INT REFERENCES users(id),
  points      INT DEFAULT 2
);

-- 開閉店チェックテンプレート
CREATE TABLE ops_templates (
  id          TEXT PRIMARY KEY,
  store_id    INT REFERENCES stores(id),
  type        TEXT NOT NULL,  -- 'open' | 'close'
  items       JSONB NOT NULL
);

-- 開閉店チェック記録
CREATE TABLE ops_records (
  id          SERIAL PRIMARY KEY,
  store_id    INT REFERENCES stores(id),
  type        TEXT NOT NULL,
  date        DATE NOT NULL,
  items       JSONB NOT NULL,
  submitted_by INT REFERENCES users(id),
  submitted_at TIMESTAMPTZ DEFAULT NOW()
);

-- 価格履歴
CREATE TABLE price_history (
  id          TEXT PRIMARY KEY,
  supplier_id TEXT REFERENCES suppliers(id),
  item_name   TEXT,
  old_price   NUMERIC,
  new_price   NUMERIC,
  changed_at  DATE,
  notified_honbu BOOLEAN DEFAULT FALSE
);

-- タスクカテゴリ
CREATE TABLE task_categories (
  id          TEXT PRIMARY KEY,
  org_id      UUID REFERENCES organizations(id),
  label       TEXT NOT NULL,
  icon        TEXT,
  color       TEXT,
  sort_order  INT DEFAULT 0
);
```

---

## Stripe連携手順

### 1. Stripe ダッシュボードで商品を作成
- **SOLO プラン**: 月額 ¥4,980（税別）
- **CHAIN プラン**: 月額 ¥9,980（税別）

### 2. Webhook エンドポイントを設定
```
POST /billing/webhook
```
処理するイベント:
- `checkout.session.completed` → 組織のplan更新
- `customer.subscription.updated` → プラン変更反映
- `customer.subscription.deleted` → プランを無効化

### 3. 環境変数
```env
STRIPE_SECRET_KEY=sk_live_xxx
STRIPE_WEBHOOK_SECRET=whsec_xxx
STRIPE_SOLO_PRICE_ID=price_xxx
STRIPE_CHAIN_PRICE_ID=price_xxx
```

### 4. フロントエンド設定
```js
CONFIG.STRIPE_PUBLISHABLE_KEY = "pk_live_xxx";
```

---

## Claude AI プロキシ設定

フロントエンドから直接 Anthropic API を呼ばず、サーバーサイドのプロキシ経由でAPIキーを安全に管理します。

### 環境変数
```env
ANTHROPIC_API_KEY=sk-ant-xxx
```

### エンドポイント
- `POST /v1/ai/chat` — テキストチャット
- `POST /v1/ai/analyze` — 画像解析（レシピ読み取り・納品書読み取り）

### フロントエンド設定
```js
CONFIG.AI_API_URL = "https://api.mise-task.app/v1/ai";
```

---

## 認証フロー

```
店舗コード入力 → スタッフ一覧表示 → PIN入力(4桁) → ログイン
         ↓
    "HONBU" → 本部パスワード → 全店舗アクセス
```

- 各店舗に一意の `code` を割り当て（例: `"SHOP01"`, `"SHOP02"`）
- PIN は bcrypt ハッシュで保存
- デモモードでは PIN = `1234` で全ユーザーログイン可能

---

## 環境変数一覧

| 変数名 | 用途 | 必須 |
|--------|------|------|
| `DATABASE_URL` | DB接続文字列 | ✅ |
| `ANTHROPIC_API_KEY` | Claude API キー | ✅（AI機能使用時）|
| `STRIPE_SECRET_KEY` | Stripe シークレットキー | ✅（課金機能使用時）|
| `STRIPE_WEBHOOK_SECRET` | Stripe Webhook署名検証 | ✅ |
| `STRIPE_SOLO_PRICE_ID` | SOLOプランのPrice ID | ✅ |
| `STRIPE_CHAIN_PRICE_ID` | CHAINプランのPrice ID | ✅ |
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE Messaging API | 任意（LINE発注時）|
| `JWT_SECRET` | 認証トークン署名 | ✅ |

---

## ファイル構成

```
├── index.html              # メインSPA（React + Babel）
├── supplier-reg.html       # 業者セルフ登録ページ
├── send-line.js            # Netlify Function: LINE発注送信
├── line-webhook.js         # Netlify Function: LINE Webhook
├── netlify.toml            # Netlify設定
└── docs/
    ├── ARCHITECTURE.md
    ├── DATA_MODELS.md
    ├── FEATURES.md
    ├── FUTURE_ROADMAP.md
    ├── README.md
    └── SETUP_GUIDE.md
```

---

## デモモードについて

`CONFIG.USE_DEMO_DATA = true` の状態では：
- 全データが localStorage に保存されます
- API呼び出しは行われません
- ダミーデータ（DEMO_DATA）が初期表示されます
- 店舗コード: `1`（1号店）/ `2`（2号店）/ `HONBU`（本部）
- PIN: `1234`（共通）

本番切り替え時は `USE_DEMO_DATA: false` に変更するだけです。
