# MISE TASK Backend — Phase 1

ラーメン店向け SaaS「MISE TASK」のバックエンド。既存フロントの REST 契約（仕様書 §12）を Supabase 上で実装する。

## 構成（Phase 1 時点）

```
mise-task-backend/
├── .env.example                            # シークレット雛形（実値は入れない）
└── supabase/
    ├── config.toml                         # functions.api.verify_jwt=false（重要）
    ├── migrations/
    │   ├── 20260613000001_init_schema.sql   # テーブル定義（§11）
    │   ├── 20260613000002_rls_policies.sql  # RLS / マルチテナント分離（§11.3, F03）
    │   └── 20260613000003_seed_demo.sql     # デモ用シード（合成データのみ。本番不可）
    └── functions/
        ├── _shared/
        │   ├── cors.ts                      # CORS / レスポンス整形
        │   ├── db.ts                        # service_role / anon クライアント
        │   ├── auth.ts                      # アプリJWT 発行・検証（HS256）
        │   └── pin.ts                       # 店舗PIN ハッシュ・検証（PBKDF2）
        └── api/
            └── index.ts                     # REST ルーター（/auth/*, /bootstrap, /state）
```

## API（Phase 1 実装済み）

`API_BASE = https://<proj>.supabase.co/functions/v1/api`

| メソッド | パス | 認証 | 内容 |
|---|---|---|---|
| POST | `/auth/honbu-login` | 不要 | `{email,password}` → Supabase Auth検証 → hqトークン発行 |
| POST | `/auth/store-login` | 不要 | `{appUserId}` → PIN未設定なら即トークン発行 |
| POST | `/auth/pin-login` | 不要 | `{appUserId,pin}` → PIN検証 → トークン発行 |
| GET | `/bootstrap` | Bearer | スコープ済み全データ（hq=全店, manager/staff=自店） |
| GET | `/state/:resource` | Bearer | 単一リソース（stores/users/suppliers/inventory/orders/recipes/routines/tasks/ops） |

> 認可は `app_role` と `store_id` で関数内enforce。DB操作は service_role（RLS bypass）だが、全クエリで `tenant_id` を必ず付与している（F03）。

## 適用手順（Supabase SQL Editor）

matsunoya-dine と同方針で `supabase db push` は使わず、SQL Editor で順に実行する。

1. Supabase プロジェクトを作成
2. SQL Editor で以下を**この順番で**実行
   1. `20260613000001_init_schema.sql`
   2. `20260613000002_rls_policies.sql`
   3. （開発時のみ）`20260613000003_seed_demo.sql`
3. 本部ユーザーを Auth で作成し、`memberships` に `role='hq'` で紐づける（seed 末尾コメント参照）

## Edge Functions デプロイ手順

```bash
# 1) CLI 準備
npm i -g supabase
supabase login
supabase link --project-ref <project-ref>

# 2) シークレット登録（.env.example をコピーして実値を入れる）
cp .env.example .env   # 実値を記入
supabase secrets set --env-file .env

# 3) デプロイ（config.toml の verify_jwt=false が効く）
supabase functions deploy api

# 4) 動作確認（本部ログイン）
curl -X POST "https://<proj>.supabase.co/functions/v1/api/auth/honbu-login" \
  -H "Content-Type: application/json" \
  -d '{"email":"hq@example.com","password":"********"}'
# → { "token": "...", "role": "hq", "tenantId": "..." }

# 5) bootstrap
curl "https://<proj>.supabase.co/functions/v1/api/bootstrap" \
  -H "Authorization: Bearer <token>"
```

> ローカルは `supabase start` → `supabase functions serve api --no-verify-jwt`。
> ⚠️ 本リポジトリのTS型チェックは未実行（サンドボックスにDeno未導入）。
> 初回 `supabase functions deploy api` でDenoのtype checkが走るので、そこで確認すること。

## マルチテナント分離の考え方（重要）

- バックエンドAPIは **service_role** で動き RLS を bypass する。API 層で `tenant_id` を必ず検証する helper を必ず通すこと（F03）。
- RLS は「クライアントが anon/auth key で直アクセスした場合の最後の砦」。`hq` はテナント全体、`manager/staff` は自店舗(`store_id`)スコープ。
- `service_role` キーをクライアント bundle に絶対に含めない（CI でスキャン, §16）。

## 実装状況

- [x] **Phase 1**: スキーマ + RLS + `/auth/*` + `/bootstrap` + `/state/:resource`
- [x] **Phase 2**: 業務API（在庫/発注 send・inspect/棚卸/業者 register・issue-token/レシピ/ルーティン/タスク complete・assign/開閉店チェック/価格履歴/汎用CRUD）
- [ ] **Phase 3**: Stripe課金（現状 `/billing/*` は 501 スタブ）、AIプロキシ `/ai`
- [ ] **フロント統合**（下記。config だけでは動かない）

## ⚠️ フロント統合に必要な作業（重要）

`API対応版` フロントは **API移行が途中**で、以下の対応が必須:

1. **トークンを送っていない** — `api._fetch` に `Authorization: Bearer <token>` を付与し、ログイン応答の `token` を保持する仕組みを追加
2. **本部ログインUI** — 現状 `{password}` のみ送信。`{email, password}` を送るUIに変更（本部=メール+パスワードに確定）
3. **店舗ログイン** — `store-login {code}` → ユーザー選択 → `pin-login {storeId,userId,pin}` の2段で `token` を受け取り保持
4. **bootstrap 反映** — ログイン後 `/bootstrap` の結果で state を初期化（localStorage 依存の名残を置換）

→ バックエンドをデプロイ後、ライブAPIに対して上記を実装・確認するのが安全（このフェーズが次の本丸）。

## テスト残

- [ ] RLS 越境テスト（§23, F28）
- [ ] 発注→検品の在庫反映
- [ ] PIN 認証のレート制限（§15, F16）

## 確定済み方針（仕様書 §確定方針 / §2.3）

- 課金: 店舗数ベース（SOLO ¥24,900 / 追加店舗 ¥19,800 / AI ¥4,980×店舗数 / 買取×36、税抜）
- バックエンド: 既存 REST 契約を実装（フロント温存）
- ID: 全テーブル UUID + `tenant_id`
