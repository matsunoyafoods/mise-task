-- ============================================================================
-- MISE TASK — 公開デモ専用テナント（架空データ）
--   目的: LPの「無料でデモを試す」用。実テナント(麺屋あぶらや)のデータを一切見せない。
--   食材・レシピ・取引業者・スタッフはすべて架空。デモはこのテナントに自動ログインする。
--   再実行で初期状態に戻る（ON CONFLICT DO UPDATE）。
--   店舗コード: MISEDEMO（フロントの ?demo=1 がこのコードでログイン）
-- ============================================================================

-- デモテナント本体
insert into public.tenants (id, name, plan, ai_option, status)
values ('00000000-0000-4000-8000-0000000000de', 'デモ飲食店', 'chain', true, 'active')
on conflict (id) do update set name = excluded.name;

-- 業務データ（KV）。架空データのみ。
insert into public.app_state (tenant_id, resource, data) values
('00000000-0000-4000-8000-0000000000de','stores',
 '[{"id":901,"name":"デモ中央店","code":"MISEDEMO"},{"id":902,"name":"デモ駅前店","code":"MISEDEMO2"}]'),

('00000000-0000-4000-8000-0000000000de','users',
 '[{"id":9000,"name":"管理者(デモ)","role":"本部","store":null,"color":"#6D28D9","avatar":"本"},
   {"id":9001,"name":"山本 れな","role":"店長","store":901,"color":"#E85D04","avatar":"山"},
   {"id":9002,"name":"高橋 だい","role":"スタッフ","store":901,"color":"#0077B6","avatar":"高"},
   {"id":9003,"name":"中村 あや","role":"スタッフ","store":902,"color":"#06C755","avatar":"中"}]'),

('00000000-0000-4000-8000-0000000000de','suppliers',
 '[{"id":"ds1","name":"サンプル青果","contactName":"営業担当","tel":"0120-000-001","token":"tok_demo_a","orderMethods":["email"],"selfRegistered":true,"registeredAt":"2026/01/10"},
   {"id":"ds2","name":"デモ食品卸","contactName":"営業担当","tel":"0120-000-002","token":"tok_demo_b","orderMethods":["line"],"selfRegistered":true,"registeredAt":"2026/01/10"},
   {"id":"ds3","name":"テスト酒販","contactName":"営業担当","tel":"0120-000-003","token":"tok_demo_c","orderMethods":["email"],"selfRegistered":false}]'),

('00000000-0000-4000-8000-0000000000de','inventory',
 '[{"id":"di1","name":"キャベツ","category":"野菜","storageGroup":"冷蔵庫A","unit":"玉","stock":12,"minStock":5,"orderQty":20,"unitPrice":180,"supplierId":"ds1","storeId":901},
   {"id":"di2","name":"玉ねぎ","category":"野菜","storageGroup":"常温棚","unit":"kg","stock":8,"minStock":5,"orderQty":15,"unitPrice":120,"supplierId":"ds1","storeId":901},
   {"id":"di3","name":"鶏もも肉","category":"肉","storageGroup":"冷蔵庫B","unit":"kg","stock":6,"minStock":4,"orderQty":10,"unitPrice":680,"supplierId":"ds2","storeId":901},
   {"id":"di4","name":"豚バラ肉","category":"肉","storageGroup":"冷蔵庫B","unit":"kg","stock":3,"minStock":4,"orderQty":8,"unitPrice":720,"supplierId":"ds2","storeId":901},
   {"id":"di5","name":"米","category":"米・麺","storageGroup":"常温棚","unit":"kg","stock":25,"minStock":10,"orderQty":30,"unitPrice":420,"supplierId":"ds2","storeId":901},
   {"id":"di6","name":"醤油","category":"調味料","storageGroup":"ドライ棚","unit":"L","stock":4,"minStock":2,"orderQty":6,"unitPrice":350,"supplierId":"ds2","storeId":901},
   {"id":"di7","name":"サラダ油","category":"調味料","storageGroup":"ドライ棚","unit":"L","stock":2,"minStock":3,"orderQty":6,"unitPrice":300,"supplierId":"ds2","storeId":901},
   {"id":"di8","name":"卵","category":"その他","storageGroup":"冷蔵庫A","unit":"パック","stock":10,"minStock":6,"orderQty":15,"unitPrice":260,"supplierId":"ds1","storeId":901},
   {"id":"di9","name":"生ビール樽","category":"ドリンク","storageGroup":"ドリンク冷蔵","unit":"樽","stock":2,"minStock":2,"orderQty":4,"unitPrice":12000,"supplierId":"ds3","storeId":901},
   {"id":"di10","name":"割り箸","category":"消耗品","storageGroup":"バックヤード","unit":"箱","stock":5,"minStock":3,"orderQty":10,"unitPrice":800,"supplierId":"ds2","storeId":901},
   {"id":"di11","name":"おしぼり","category":"消耗品","storageGroup":"バックヤード","unit":"箱","stock":4,"minStock":3,"orderQty":8,"unitPrice":1200,"supplierId":"ds2","storeId":901},
   {"id":"di12","name":"レモン","category":"野菜","storageGroup":"冷蔵庫A","unit":"kg","stock":1,"minStock":2,"orderQty":5,"unitPrice":500,"supplierId":"ds1","storeId":901}]'),

('00000000-0000-4000-8000-0000000000de','recipes',
 '[{"id":"dr1","name":"唐揚げの下味（サンプル）","category":"仕込み","yield":"約50個","description":"デモ用のサンプルレシピです","ingredients":[{"name":"鶏もも肉","amount":3,"unit":"kg"},{"name":"醤油","amount":200,"unit":"ml"},{"name":"おろしにんにく","amount":30,"unit":"g"}],"steps":["鶏肉を一口大に切る","調味料に漬け込む","30分以上寝かせる"]},
   {"id":"dr2","name":"和風だし（サンプル）","category":"仕込み","yield":"5L","description":"デモ用のサンプルレシピです","ingredients":[{"name":"水","amount":5,"unit":"L"},{"name":"昆布","amount":50,"unit":"g"},{"name":"かつお節","amount":100,"unit":"g"}],"steps":["昆布を水に浸す","沸騰前に昆布を取り出す","かつお節を加えて濾す"]},
   {"id":"dr3","name":"特製ドレッシング（サンプル）","category":"仕込み","yield":"1L","description":"デモ用のサンプルレシピです","ingredients":[{"name":"サラダ油","amount":500,"unit":"ml"},{"name":"醤油","amount":200,"unit":"ml"},{"name":"酢","amount":150,"unit":"ml"}],"steps":["材料を全て混ぜる","よく乳化させる"]}]'),

('00000000-0000-4000-8000-0000000000de','routines',
 '[{"id":"drt1","name":"唐揚げの下味仕込み","category":"prep","store":901,"freq":"daily","customDays":[],"onceDate":"","freeDates":[],"deadline":"10:00","assignedTo":null,"recipeId":"dr1","active":true,"order":0},
   {"id":"drt2","name":"和風だし仕込み","category":"prep","store":901,"freq":"daily","customDays":[],"onceDate":"","freeDates":[],"deadline":"10:30","assignedTo":null,"recipeId":"dr2","active":true,"order":1}]'),

('00000000-0000-4000-8000-0000000000de','prepTasks','[]'),

('00000000-0000-4000-8000-0000000000de','cleanTasks',
 '[{"id":"dc1","name":"床清掃","area":"フロア","deadline":"22:00","store":901,"assignedTo":null,"completedAt":null,"completedBy":null,"points":2},
   {"id":"dc2","name":"トイレ清掃","area":"トイレ","deadline":"22:00","store":901,"assignedTo":null,"completedAt":null,"completedBy":null,"points":2},
   {"id":"dc3","name":"製氷機まわりの清掃","area":"キッチン","deadline":"22:00","store":901,"assignedTo":null,"completedAt":null,"completedBy":null,"points":2}]'),

('00000000-0000-4000-8000-0000000000de','taskCats','[]'),

('00000000-0000-4000-8000-0000000000de','openItems',
 '[{"id":"do1","icon":"💡","label":"照明・看板の電源を入れる","note":"","group":"オープン準備","estMin":5,"needsValue":false,"unit":"","normalRange":null},
   {"id":"do2","icon":"🌡","label":"冷蔵庫の温度を確認","note":"","group":"温度確認","estMin":3,"needsValue":false,"unit":"","normalRange":null},
   {"id":"do3","icon":"🍚","label":"米を炊く","note":"","group":"キッチン","estMin":5,"needsValue":false,"unit":"","normalRange":null},
   {"id":"do4","icon":"🧹","label":"フロア清掃・テーブルセット","note":"","group":"ホール","estMin":10,"needsValue":false,"unit":"","normalRange":null},
   {"id":"do5","icon":"🚪","label":"開店（OPEN）","note":"","group":"オープン準備","estMin":1,"needsValue":false,"unit":"","normalRange":null}]'),

('00000000-0000-4000-8000-0000000000de','closeItems',
 '[{"id":"dcl1","icon":"🧼","label":"洗い物・厨房清掃","note":"","group":"キッチン","estMin":20,"needsValue":false,"unit":"","normalRange":null},
   {"id":"dcl2","icon":"💴","label":"レジ締め","note":"","group":"レジ・売上","estMin":10,"needsValue":false,"unit":"","normalRange":null},
   {"id":"dcl3","icon":"🗑","label":"ゴミ出し","note":"","group":"ホール","estMin":5,"needsValue":false,"unit":"","normalRange":null},
   {"id":"dcl4","icon":"🔥","label":"火の元チェック","note":"","group":"安全確認","estMin":3,"needsValue":false,"unit":"","normalRange":null},
   {"id":"dcl5","icon":"🔒","label":"施錠・消灯","note":"","group":"安全確認","estMin":2,"needsValue":false,"unit":"","normalRange":null}]'),

('00000000-0000-4000-8000-0000000000de','priceHistory','[]'),

('00000000-0000-4000-8000-0000000000de','hqTasks',
 '[{"id":"dh1","name":"月末の棚卸し報告","deadline":"","priority":"normal","assignedTo":null,"store":null,"completedAt":null,"completedBy":null,"createdAt":"2026-06-01"}]'),

('00000000-0000-4000-8000-0000000000de','pointConfig',
 '{"prepDone":10,"amountVerified":8,"cleanDone":10,"deviation":-5}'),

('00000000-0000-4000-8000-0000000000de','lastCarryDate','null')

on conflict (tenant_id, resource) do update set data = excluded.data, updated_at = now();
