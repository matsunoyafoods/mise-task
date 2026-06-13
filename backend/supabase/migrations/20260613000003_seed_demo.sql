-- ============================================================================
-- MISE TASK — デモ/開発用シード（合成データのみ, F25/F31）
-- 固定 UUID v4 を使用（デモ ID 型整合）。本番では実行しない。
-- 実行前提: 20260613000001 / 20260613000002 を適用済み
-- ============================================================================

-- デモテナント（固定 UUID）
insert into public.tenants (id, name, plan, ai_option, status)
values ('00000000-0000-4000-8000-000000000001', 'デモ・ラーメンチェーン', 'chain', true, 'active')
on conflict (id) do nothing;

-- デモ店舗（新宿本店 / 渋谷店）
insert into public.stores (id, tenant_id, name, code) values
  ('00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000001','新宿本店','DEMO1'),
  ('00000000-0000-4000-8000-000000000102','00000000-0000-4000-8000-000000000001','渋谷店','DEMO2')
on conflict (id) do nothing;

-- デモ スタッフ（auth 紐づけなし。表示用。PIN はハッシュ保存のため seed では null）
insert into public.app_users (id, tenant_id, store_id, name, role, color, avatar) values
  ('00000000-0000-4000-8000-000000000201','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000101','山田太郎','店長','#E85D04','山'),
  ('00000000-0000-4000-8000-000000000202','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000101','佐藤花子','スタッフ','#0077B6','佐')
on conflict (id) do nothing;

-- デモ業者
insert into public.suppliers (id, tenant_id, name, contact_name, tel, token, order_methods, self_registered, registered_at) values
  ('00000000-0000-4000-8000-000000000301','00000000-0000-4000-8000-000000000001','田中青果株式会社','田中一郎','090-1234-5678','tok_demo_0001', array['line','email'], true, current_date)
on conflict (id) do nothing;

-- デモ在庫（新宿本店）
insert into public.inventory (id, tenant_id, store_id, name, unit, stock, min_stock, order_qty, unit_price, supplier_id) values
  ('00000000-0000-4000-8000-000000000401','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000101','キャベツ','g',5000,3000,10000,150,'00000000-0000-4000-8000-000000000301'),
  ('00000000-0000-4000-8000-000000000402','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000101','長ネギ','本',2,5,20,80,'00000000-0000-4000-8000-000000000301')
on conflict (id) do nothing;

-- ※ 本部/店長の auth ユーザーは Supabase Auth で作成し、memberships に紐づける:
--   insert into public.memberships (user_id, tenant_id, role, store_id)
--   values ('<auth.users.id>', '00000000-0000-4000-8000-000000000001', 'hq', null);
