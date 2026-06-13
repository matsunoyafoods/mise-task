-- ============================================================================
-- MISE TASK — Phase 1 RLS（マルチテナント分離）
-- 仕様書 §11.3 / §16 / 落とし穴 F03, F12
--
-- 方針:
--   * バックエンドAPIは service_role で動くため RLS を bypass する。
--     RLS は「クライアントが anon/auth key で直アクセスした場合の最後の砦」。
--   * tenant_id による分離を全業務テーブルに適用。
--   * manager/staff は自店舗(store_id)スコープ、hq はテナント全体。
--   * service_role の操作は API 層の helper で tenant_id を必ず検証する（別途実装）。
-- ============================================================================

-- ── ヘルパー関数（SECURITY DEFINER で memberships への RLS 再帰を回避） ─────

-- 現在の auth ユーザーが所属するテナント一覧
create or replace function public.auth_tenant_ids()
returns setof uuid
language sql stable security definer set search_path = public as $$
  select tenant_id from public.memberships where user_id = auth.uid();
$$;

-- そのテナントにアクセス権があるか
create or replace function public.auth_has_tenant(p_tenant uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.memberships
    where user_id = auth.uid() and tenant_id = p_tenant
  );
$$;

-- テナント内での role
create or replace function public.auth_role_in_tenant(p_tenant uuid)
returns text
language sql stable security definer set search_path = public as $$
  select role from public.memberships
  where user_id = auth.uid() and tenant_id = p_tenant
  limit 1;
$$;

-- 店舗単位のアクセス可否（hq=テナント内全店, manager/staff=自店のみ）
create or replace function public.auth_can_access_store(p_tenant uuid, p_store uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.memberships m
    where m.user_id = auth.uid()
      and m.tenant_id = p_tenant
      and (m.role = 'hq' or m.store_id = p_store)
  );
$$;

-- ── RLS 有効化 ─────────────────────────────────────────────────────────────
alter table public.tenants                 enable row level security;
alter table public.memberships             enable row level security;
alter table public.stores                  enable row level security;
alter table public.app_users               enable row level security;
alter table public.suppliers               enable row level security;
alter table public.inventory               enable row level security;
alter table public.orders                  enable row level security;
alter table public.recipes                 enable row level security;
alter table public.routines                enable row level security;
alter table public.task_instances          enable row level security;
alter table public.ops_check_items         enable row level security;
alter table public.price_history           enable row level security;
alter table public.billing_periods         enable row level security;
alter table public.billing_store_snapshots enable row level security;
alter table public.legal_consents          enable row level security;
alter table public.audit_logs              enable row level security;
alter table public.pending_signups         enable row level security;
alter table public.processed_stripe_events enable row level security;

-- ── tenants: 所属テナントのみ閲覧。更新は API(service_role)経由のみ ─────────
drop policy if exists tenants_select on public.tenants;
create policy tenants_select on public.tenants
  for select to authenticated
  using (public.auth_has_tenant(id));

-- ── memberships: 自分の行のみ閲覧 ─────────────────────────────────────────
drop policy if exists memberships_select on public.memberships;
create policy memberships_select on public.memberships
  for select to authenticated
  using (user_id = auth.uid());

-- ── テナント単位のテーブル（hq/manager/staff いずれも所属テナントなら閲覧） ──
-- suppliers / recipes はテナント共有
do $$
declare t text;
begin
  foreach t in array array['suppliers','recipes'] loop
    execute format('drop policy if exists %I_tenant_rw on public.%I;', t, t);
    execute format($f$
      create policy %I_tenant_rw on public.%I
        for all to authenticated
        using (public.auth_has_tenant(tenant_id))
        with check (public.auth_has_tenant(tenant_id));
    $f$, t, t);
  end loop;
end $$;

-- ── 店舗スコープのテーブル（manager/staff は自店のみ、hq は全店） ───────────
do $$
declare t text;
begin
  foreach t in array array[
    'stores','app_users','inventory','orders','routines',
    'task_instances','ops_check_items'
  ] loop
    execute format('drop policy if exists %I_store_rw on public.%I;', t, t);
    if t = 'stores' then
      -- stores は id 自体が店舗
      execute format($f$
        create policy %I_store_rw on public.%I
          for all to authenticated
          using (public.auth_can_access_store(tenant_id, id))
          with check (public.auth_can_access_store(tenant_id, id));
      $f$, t, t);
    else
      execute format($f$
        create policy %I_store_rw on public.%I
          for all to authenticated
          using (public.auth_can_access_store(tenant_id, store_id))
          with check (public.auth_can_access_store(tenant_id, store_id));
      $f$, t, t);
    end if;
  end loop;
end $$;

-- ── price_history: 所属テナントなら閲覧（書き込みは API 経由） ───────────────
drop policy if exists price_history_select on public.price_history;
create policy price_history_select on public.price_history
  for select to authenticated
  using (public.auth_has_tenant(tenant_id));

-- ── billing_*: hq のみ閲覧（請求情報） ────────────────────────────────────
drop policy if exists billing_periods_hq on public.billing_periods;
create policy billing_periods_hq on public.billing_periods
  for select to authenticated
  using (public.auth_role_in_tenant(tenant_id) = 'hq');

drop policy if exists billing_snap_hq on public.billing_store_snapshots;
create policy billing_snap_hq on public.billing_store_snapshots
  for select to authenticated
  using (exists (
    select 1 from public.billing_periods bp
    where bp.id = billing_period_id
      and public.auth_role_in_tenant(bp.tenant_id) = 'hq'
  ));

-- ── audit_logs: hq のみ閲覧 ───────────────────────────────────────────────
drop policy if exists audit_hq on public.audit_logs;
create policy audit_hq on public.audit_logs
  for select to authenticated
  using (tenant_id is not null and public.auth_role_in_tenant(tenant_id) = 'hq');

-- ── legal_consents: 本人のみ閲覧 ──────────────────────────────────────────
drop policy if exists consents_self on public.legal_consents;
create policy consents_self on public.legal_consents
  for select to authenticated
  using (user_id = auth.uid());

-- ── pending_signups / processed_stripe_events: クライアント直アクセス不可 ──
--    （ポリシーを作らない = RLS 有効でポリシー無し → authenticated は全拒否。
--      アクセスは service_role のみ）

-- ============================================================================
-- 注意:
--   * INSERT/UPDATE/DELETE の大半は API(service_role)経由を想定。
--     上記 *_rw ポリシーはクライアント直アクセスを許す場合のフォールバック。
--   * 完全にAPI経由のみにするなら、書き込みは service_role に限定し、
--     クライアントには select のみ許可する設計に絞ってもよい（§26で確定）。
--   * RLS 越境テストを CI に必ず入れる（§23, F28）。
-- ============================================================================
