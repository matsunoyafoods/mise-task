-- 棚卸し提出履歴（実数上書きの監査証跡）
--
--   ・在庫の実数上書きと提出履歴の保存は Edge Function `api`（service_role）経由でのみ行う。
--   ・RLS は有効化するが、pending_signups / processed_stripe_events と同じ「バックエンドのみ
--     アクセス可（ポリシーなし＝anon/authenticated からは既定で拒否）」パターンを踏襲する。
--     「RLSを有効化した＝分離完了」ではない点に注意し、tenant_id / store_id のスコープ検証は
--     必ず API 層（stocktakeSubmit / stocktakeHistory / stocktakeDelete）で行うこと。
--   ・store_id は既存の `stores`（uuid・レガシー未使用テーブル）ではなく、app_state 上の
--     KV「stores」リソースが持つ店舗ID（数値/文字列）に合わせるため text 型とする。

create table if not exists public.stocktake_submissions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  store_id text not null,
  store_name text,
  submitted_by_app_user_id text,
  submitted_by_name text not null default '担当者',
  submitted_at timestamptz not null default now(),
  item_count integer not null default 0,
  total_value integer not null default 0,
  alert_count integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.stocktake_items (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.stocktake_submissions(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  item_id text not null,
  item_name text not null,
  category text,
  unit text,
  theoretical_stock numeric not null default 0,
  actual_stock numeric not null default 0,
  diff numeric not null default 0,
  unit_price numeric not null default 0,
  value numeric not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists stocktake_submissions_tenant_store_idx
  on public.stocktake_submissions (tenant_id, store_id, submitted_at desc);
create index if not exists stocktake_items_submission_idx
  on public.stocktake_items (submission_id);

alter table public.stocktake_submissions enable row level security;
alter table public.stocktake_items enable row level security;
