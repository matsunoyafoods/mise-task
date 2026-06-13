-- ============================================================================
-- MISE TASK — Phase 1 初期スキーマ
-- マルチテナント SaaS (店舗数ベース課金) / Supabase PostgreSQL
-- 仕様書: MISE_TASK_引き継ぎ仕様書.md §11
--
-- 実行方法: Supabase Dashboard → SQL Editor に貼り付けて実行
--   （matsunoya-dine と同方針: supabase db push は使わない）
-- 冪等: IF NOT EXISTS / OR REPLACE で再実行可能
-- ============================================================================

-- ── 拡張 ─────────────────────────────────────────────────────────────────
create extension if not exists "pgcrypto";   -- gen_random_uuid()

-- ============================================================================
-- 1. テナント・メンバーシップ・課金系
-- ============================================================================

-- テナント（=チェーン/会社。課金単位）
create table if not exists public.tenants (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null,
  plan               text not null default 'solo',      -- solo | chain | enterprise
  ai_option          boolean not null default false,
  status             text not null default 'active',     -- active | past_due | canceled
  stripe_customer_id text,
  created_at         timestamptz not null default now()
);

-- ユーザー(auth.users)とテナントの多対多（同一担当者が複数チェーン管理を許容, F26）
create table if not exists public.memberships (
  user_id    uuid not null references auth.users(id) on delete cascade,
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  role       text not null check (role in ('hq','manager','staff','part')),
  store_id   uuid,                                       -- manager/staff の所属店舗
  created_at timestamptz not null default now(),
  primary key (user_id, tenant_id)
);

-- 申込の一時保存（Stripe metadata に PII を入れない, F01）
create table if not exists public.pending_signups (
  id               uuid primary key default gen_random_uuid(),
  email            text not null,
  company_name     text,
  state            text not null default 'pending',      -- pending|paid|provisioning|active|failed
  idempotency_key  text unique,
  expires_at       timestamptz,
  created_at       timestamptz not null default now()
);

-- Stripe イベント重複防止（F06, F17）— event_id は NOT NULL UNIQUE
create table if not exists public.processed_stripe_events (
  event_id     text not null unique,
  event_type   text,
  object_id    text,
  processed_at timestamptz not null default now()
);

-- 課金期間（COUNT課金を避けスナップショット保存, F04/F22）— 課金基準=店舗数
create table if not exists public.billing_periods (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete cascade,
  as_of_at          timestamptz not null,
  period_start      date not null,
  period_end        date not null,
  store_count       int  not null,                       -- as_of_at 時点の有効店舗数
  base_fee_jpy      int  not null default 24900,         -- 1店舗目
  add_store_fee_jpy int  not null default 0,             -- 19800 ×(store_count-1)
  ai_option         boolean not null default false,
  ai_fee_jpy        int  not null default 0,             -- 4980 × store_count
  total_jpy         int  not null,                       -- 税抜合計
  stripe_invoice_id text,
  created_at        timestamptz not null default now(),
  unique (tenant_id, period_start)
);

-- 課金根拠スナップショット（どの店舗が as_of 時点で有効だったか）
create table if not exists public.billing_store_snapshots (
  id                uuid primary key default gen_random_uuid(),
  billing_period_id uuid not null references public.billing_periods(id) on delete cascade,
  store_id          uuid not null,
  store_name        text,
  created_at        date,
  deleted_at        date
);

-- 同意ログ（F19）
create table if not exists public.legal_consents (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid,
  signup_id        uuid,
  document_type    text not null,                        -- terms_of_service | privacy_policy | ...
  document_version text not null,
  document_hash    text not null,
  accepted_at      timestamptz not null default now(),
  ip_address       text,
  user_agent       text,
  locale           text,
  acquisition_path text
);

-- 監査ログ（発注送信・課金・AI・認証など）
create table if not exists public.audit_logs (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid,
  actor      text,                                       -- user_id / 'cron' / 'webhook' / 'system'
  action     text not null,
  target     text,
  detail     jsonb,
  created_at timestamptz not null default now()
);

-- ============================================================================
-- 2. 業務系（既存データモデル + tenant_id）
-- ============================================================================

create table if not exists public.stores (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  name       text not null,
  code       text unique,                                -- スタッフのログイン用コード（全社で一意）
  created_at timestamptz not null default now(),
  deleted_at timestamptz                                 -- 論理削除（課金スナップショット用）
);

-- 店舗スタッフの表示用レコード（auth.users とは別。表示名/色/アバター/PIN）
create table if not exists public.app_users (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  store_id     uuid references public.stores(id) on delete set null,
  auth_user_id uuid references auth.users(id) on delete set null,  -- 本部/店長のみ紐づく
  name         text not null,
  role         text not null,                            -- 本部|店長|スタッフ|アルバイト
  color        text,
  avatar       text,
  commission   numeric,
  pin_hash     text,                                     -- 店舗PIN（ハッシュ保存。平文は保存しない）
  created_at   timestamptz not null default now()
);

create table if not exists public.suppliers (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  name            text not null,
  contact_name    text,
  tel             text,
  token           text not null unique,                  -- QR/URL 用
  order_methods   text[] not null default '{}',          -- email|line|instagram|twitter|other
  contact         text,
  line_id         text,
  instagram_id    text,
  twitter_id      text,
  other_desc      text,
  self_registered boolean not null default false,
  registered_at   date,
  created_at      timestamptz not null default now()
);

create table if not exists public.inventory (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  store_id    uuid not null references public.stores(id) on delete cascade,
  name        text not null,
  unit        text,
  stock       numeric not null default 0,
  min_stock   numeric not null default 0,
  order_qty   numeric not null default 0,
  unit_price  int     not null default 0,
  supplier_id uuid references public.suppliers(id) on delete set null,
  created_at  timestamptz not null default now()
);

create table if not exists public.orders (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  store_id       uuid not null references public.stores(id) on delete cascade,
  supplier_id    uuid references public.suppliers(id) on delete set null,
  items          jsonb not null default '[]',
  status         text  not null default 'sent',          -- sent | delivered
  sent_at        timestamptz not null default now(),
  delivered_at   timestamptz,
  send_method    text,
  inspected      boolean not null default false,
  inspection_log jsonb   not null default '[]'
);

create table if not exists public.recipes (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  store_id   uuid references public.stores(id) on delete cascade,
  name       text,
  data       jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.routines (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  store_id    uuid references public.stores(id) on delete cascade,
  name        text,
  category    text,                                       -- prep | clean
  freq        text,                                       -- daily|weekday|custom|once
  custom_days int[],                                      -- 0=日..6=土
  once_date   date,
  deadline    text,
  assigned_to uuid references public.app_users(id) on delete set null,
  recipe_id   uuid references public.recipes(id) on delete set null,
  sort_order  int not null default 0,
  active      boolean not null default true
);

create table if not exists public.task_instances (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  store_id     uuid references public.stores(id) on delete cascade,
  routine_id   uuid references public.routines(id) on delete set null,
  category     text,                                      -- prep | clean
  name         text,
  date         date not null,
  deadline     text,
  assigned_to  uuid references public.app_users(id) on delete set null,
  recipe_id    uuid references public.recipes(id) on delete set null,
  completed_at timestamptz,
  completed_by uuid[],
  carried_from uuid
);

create table if not exists public.ops_check_items (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  store_id   uuid references public.stores(id) on delete cascade,
  label      text,
  category   text,                                        -- open | close
  checked_at timestamptz,
  checked_by uuid references public.app_users(id) on delete set null
);

create table if not exists public.price_history (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  item_id    uuid references public.inventory(id) on delete cascade,
  date       date not null default current_date,
  price      int  not null
);

-- ── インデックス（tenant_id / store_id で分離・高速化） ────────────────────
create index if not exists idx_memberships_user        on public.memberships(user_id);
create index if not exists idx_stores_tenant           on public.stores(tenant_id);
create index if not exists idx_app_users_tenant        on public.app_users(tenant_id);
create index if not exists idx_app_users_auth          on public.app_users(auth_user_id);
create index if not exists idx_suppliers_tenant        on public.suppliers(tenant_id);
create index if not exists idx_inventory_tenant_store  on public.inventory(tenant_id, store_id);
create index if not exists idx_orders_tenant_store     on public.orders(tenant_id, store_id);
create index if not exists idx_recipes_tenant          on public.recipes(tenant_id);
create index if not exists idx_routines_tenant_store   on public.routines(tenant_id, store_id);
create index if not exists idx_tasks_tenant_store_date on public.task_instances(tenant_id, store_id, date);
create index if not exists idx_ops_tenant_store        on public.ops_check_items(tenant_id, store_id);
create index if not exists idx_price_tenant_item       on public.price_history(tenant_id, item_id);
create index if not exists idx_billing_tenant          on public.billing_periods(tenant_id);
