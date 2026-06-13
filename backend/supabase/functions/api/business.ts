// ============================================================================
// MISE TASK — Phase 2 業務 API ハンドラ
// 在庫 / 発注(send/inspect) / 棚卸 / 業者 / レシピ / ルーティン / タスク /
// 開閉店チェック / 価格履歴 / 汎用CRUD。billing は Phase 3 スタブ。
//
// 全クエリで tenant_id を強制し、manager/staff は store スコープに限定する(F03/F12)。
// ============================================================================
import { err, json } from "../_shared/cors.ts";
import { admin } from "../_shared/db.ts";
import { type AppClaims } from "../_shared/auth.ts";

type Row = Record<string, any>;
const db = admin;

async function reqBody(req: Request): Promise<Row> {
  try { return await req.json(); } catch { return {}; }
}

// 書き込み権限: hq=全店, manager=自店, staff/part=不可（タスク完了等の例外は個別に許可）
function canWrite(c: AppClaims): boolean {
  return c.app_role === "hq" || c.app_role === "manager";
}

// 対象行が claims のテナント/店舗スコープ内か検証してから処理する
async function assertRowInScope(
  table: string, id: string, c: AppClaims, storeCol: string | null,
): Promise<Row | null> {
  const { data } = await db().from(table).select("*").eq("id", id)
    .eq("tenant_id", c.tenant_id).maybeSingle();
  if (!data) return null;
  if (c.app_role !== "hq" && storeCol && data[storeCol] && data[storeCol] !== c.store_id) {
    return null; // 自店外
  }
  return data;
}

// 汎用CRUD定義（list は index.ts 側 /state /bootstrap が担当。ここは create/update/delete）
const CRUD: Record<string, { table: string; storeCol: string | null }> = {
  users:     { table: "app_users", storeCol: "store_id" },
  stores:    { table: "stores",    storeCol: "id" },
  suppliers: { table: "suppliers", storeCol: null },
  inventory: { table: "inventory", storeCol: "store_id" },
  recipes:   { table: "recipes",   storeCol: "store_id" },
  routines:  { table: "routines",  storeCol: "store_id" },
};

// ── LINE 発注送信 ──────────────────────────────────────────────────────────
async function pushLine(userId: string, text: string): Promise<boolean> {
  const token = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN");
  if (!token || !userId) return false;
  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ to: userId, messages: [{ type: "text", text }] }),
  });
  return res.ok;
}

function buildOrderText(supplierName: string, items: Row[]): string {
  const lines = items.map((i) => `・${i.name}  ${i.qty}${i.unit ?? ""}`).join("\n");
  const today = new Date().toISOString().slice(0, 10);
  return `【発注書】${today}\n${supplierName} 御中\n\n${lines}\n\n以上、よろしくお願いいたします。`;
}

async function audit(c: AppClaims | null, action: string, target: string, detail: Row) {
  await db().from("audit_logs").insert({
    tenant_id: c?.tenant_id ?? null,
    actor: c?.app_user_id ?? c?.sub ?? "system",
    action, target, detail,
  });
}

// ============================================================================
// ルーター: 認証必須の業務エンドポイント
//   戻り値 null = このモジュールでは未処理（index.ts が 404 判定）
// ============================================================================
export async function handleBusiness(
  req: Request, c: AppClaims, p: string[], method: string,
): Promise<Response | null> {
  const [r0, r1, r2] = p;

  // ── 汎用 CRUD ─────────────────────────────────────────────────────────
  if (CRUD[r0] && !r2) {
    const { table, storeCol } = CRUD[r0];

    // POST /:resource  (create)
    if (method === "POST" && !r1) {
      if (!canWrite(c)) return err("forbidden", "作成権限がありません", 403);
      const b = await reqBody(req);
      const row: Row = { ...b, tenant_id: c.tenant_id };
      // manager は自店に強制
      if (c.app_role !== "hq" && storeCol && storeCol !== "id") row[storeCol] = c.store_id;
      const { data, error } = await db().from(table).insert(row).select().single();
      if (error) return err("db_error", error.message, 400);
      await audit(c, "create", `${r0}/${data.id}`, {});
      return json(data, 201);
    }

    // PUT /:resource/:id  (update)
    if (method === "PUT" && r1) {
      if (!canWrite(c)) return err("forbidden", "更新権限がありません", 403);
      const exists = await assertRowInScope(table, r1, c, storeCol);
      if (!exists) return err("not_found", "対象が見つかりません", 404);
      const b = await reqBody(req);
      delete b.tenant_id; delete b.id; // 改ざん防止
      const { data, error } = await db().from(table).update(b)
        .eq("id", r1).eq("tenant_id", c.tenant_id).select().single();
      if (error) return err("db_error", error.message, 400);
      return json(data);
    }

    // DELETE /:resource/:id
    if (method === "DELETE" && r1) {
      if (!canWrite(c)) return err("forbidden", "削除権限がありません", 403);
      const exists = await assertRowInScope(table, r1, c, storeCol);
      if (!exists) return err("not_found", "対象が見つかりません", 404);
      const { error } = await db().from(table).delete()
        .eq("id", r1).eq("tenant_id", c.tenant_id);
      if (error) return err("db_error", error.message, 400);
      await audit(c, "delete", `${r0}/${r1}`, {});
      return json({ ok: true });
    }
  }

  // ── 在庫: 棚卸 ────────────────────────────────────────────────────────
  if (r0 === "inventory" && r1 === "stocktake" && method === "POST") {
    if (!canWrite(c)) return err("forbidden", "権限がありません", 403);
    const { counts } = await reqBody(req) as { counts?: { id: string; stock: number }[] };
    if (!Array.isArray(counts)) return err("invalid_input", "counts が必要です");
    for (const ct of counts) {
      const row = await assertRowInScope("inventory", ct.id, c, "store_id");
      if (row) await db().from("inventory").update({ stock: ct.stock })
        .eq("id", ct.id).eq("tenant_id", c.tenant_id);
    }
    await audit(c, "stocktake", "inventory", { count: counts.length });
    return json({ ok: true, updated: counts.length });
  }

  // ── 業者: トークン発行 ────────────────────────────────────────────────
  if (r0 === "suppliers" && r1 === "issue-token" && method === "POST") {
    if (!canWrite(c)) return err("forbidden", "権限がありません", 403);
    const { name } = await reqBody(req) as { name?: string };
    const token = `tok_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const { data, error } = await db().from("suppliers")
      .insert({ tenant_id: c.tenant_id, name: name ?? "（未登録業者）", token, self_registered: false })
      .select().single();
    if (error) return err("db_error", error.message, 400);
    return json({ supplier: data, token, regUrl: `https://mise-task.app/supplier-reg?token=${token}` }, 201);
  }

  // ── 発注: 作成 ─────────────────────────────────────────────────────────
  if (r0 === "orders" && !r1 && method === "POST") {
    if (!canWrite(c)) return err("forbidden", "権限がありません", 403);
    const b = await reqBody(req);
    const storeId = c.app_role === "hq" ? b.storeId : c.store_id;
    if (!storeId) return err("invalid_input", "storeId が必要です");
    const { data, error } = await db().from("orders").insert({
      tenant_id: c.tenant_id, store_id: storeId, supplier_id: b.supplierId,
      items: b.items ?? [], status: "sent", send_method: b.sendMethod ?? null,
    }).select().single();
    if (error) return err("db_error", error.message, 400);
    return json(data, 201);
  }

  // ── 発注: LINE送信 ─────────────────────────────────────────────────────
  if (r0 === "orders" && r2 === "send" && method === "POST") {
    if (!canWrite(c)) return err("forbidden", "権限がありません", 403);
    const order = await assertRowInScope("orders", r1, c, "store_id");
    if (!order) return err("not_found", "発注が見つかりません", 404);
    const { data: sup } = await db().from("suppliers").select("name, line_id")
      .eq("id", order.supplier_id).eq("tenant_id", c.tenant_id).maybeSingle();
    const text = buildOrderText(sup?.name ?? "御中", order.items ?? []);
    let sent = false;
    if (sup?.line_id) sent = await pushLine(sup.line_id, text);
    await db().from("orders").update({ status: "sent", sent_at: new Date().toISOString() })
      .eq("id", r1).eq("tenant_id", c.tenant_id);
    await audit(c, "order_send", `orders/${r1}`, { sent, method: "line" });
    return json({ ok: true, lineSent: sent, orderText: text });
  }

  // ── 発注: 検品（在庫反映） ──────────────────────────────────────────────
  if (r0 === "orders" && r2 === "inspect" && method === "POST") {
    if (!canWrite(c)) return err("forbidden", "権限がありません", 403);
    const order = await assertRowInScope("orders", r1, c, "store_id");
    if (!order) return err("not_found", "発注が見つかりません", 404);
    const { log } = await reqBody(req) as { log?: { itemId: string; received: number }[] };
    for (const l of log ?? []) {
      const inv = await assertRowInScope("inventory", l.itemId, c, "store_id");
      if (inv) await db().from("inventory")
        .update({ stock: Number(inv.stock) + Number(l.received) })
        .eq("id", l.itemId).eq("tenant_id", c.tenant_id);
    }
    const { data, error } = await db().from("orders").update({
      inspected: true, status: "delivered",
      delivered_at: new Date().toISOString(), inspection_log: log ?? [],
    }).eq("id", r1).eq("tenant_id", c.tenant_id).select().single();
    if (error) return err("db_error", error.message, 400);
    await audit(c, "order_inspect", `orders/${r1}`, { items: (log ?? []).length });
    return json(data);
  }

  // ── タスク: prep / clean / routines 取得 ───────────────────────────────
  if (r0 === "tasks" && method === "GET") {
    if (r1 === "routines") return await listTasks(c, "routines");
    if (r1 === "prep")     return await listTaskInstances(c, "prep", new URL(req.url));
    if (r1 === "clean")    return await listTaskInstances(c, "clean", new URL(req.url));
  }

  // ── タスク: ルーティン作成/更新 ─────────────────────────────────────────
  if (r0 === "tasks" && r1 === "routines") {
    if (method === "POST" && !r2) {
      if (!canWrite(c)) return err("forbidden", "権限がありません", 403);
      const b = await reqBody(req);
      const row: Row = { ...b, tenant_id: c.tenant_id };
      if (c.app_role !== "hq") row.store_id = c.store_id;
      const { data, error } = await db().from("routines").insert(row).select().single();
      if (error) return err("db_error", error.message, 400);
      return json(data, 201);
    }
    if (method === "PUT" && r2) {
      if (!canWrite(c)) return err("forbidden", "権限がありません", 403);
      const exists = await assertRowInScope("routines", r2, c, "store_id");
      if (!exists) return err("not_found", "対象が見つかりません", 404);
      const b = await reqBody(req); delete b.tenant_id; delete b.id;
      const { data, error } = await db().from("routines").update(b)
        .eq("id", r2).eq("tenant_id", c.tenant_id).select().single();
      if (error) return err("db_error", error.message, 400);
      return json(data);
    }
  }

  // ── タスク: 完了 / 割当（staff も完了は可） ────────────────────────────
  if (r0 === "tasks" && r2 === "complete" && method === "POST") {
    const t = await assertRowInScope("task_instances", r1, c, "store_id");
    if (!t) return err("not_found", "タスクが見つかりません", 404);
    const by = c.app_user_id ? [c.app_user_id] : [];
    const { data, error } = await db().from("task_instances").update({
      completed_at: new Date().toISOString(), completed_by: by,
    }).eq("id", r1).eq("tenant_id", c.tenant_id).select().single();
    if (error) return err("db_error", error.message, 400);
    return json(data);
  }
  if (r0 === "tasks" && r2 === "assign" && method === "POST") {
    if (!canWrite(c)) return err("forbidden", "権限がありません", 403);
    const t = await assertRowInScope("task_instances", r1, c, "store_id");
    if (!t) return err("not_found", "タスクが見つかりません", 404);
    const { assignedTo } = await reqBody(req) as { assignedTo?: string };
    const { data, error } = await db().from("task_instances").update({ assigned_to: assignedTo ?? null })
      .eq("id", r1).eq("tenant_id", c.tenant_id).select().single();
    if (error) return err("db_error", error.message, 400);
    return json(data);
  }

  // ── 開閉店チェック ─────────────────────────────────────────────────────
  if (r0 === "ops" && r1 === "checklist") {
    if (method === "GET") {
      const url = new URL(req.url);
      const type = url.searchParams.get("type"); // open|close
      let q = db().from("ops_check_items").select("*").eq("tenant_id", c.tenant_id);
      if (c.app_role !== "hq" && c.store_id) q = q.eq("store_id", c.store_id);
      if (type) q = q.eq("category", type);
      const { data, error } = await q;
      if (error) return err("db_error", error.message, 400);
      return json({ data: data ?? [] });
    }
    if (method === "POST") {
      const b = await reqBody(req); // { id, checked } などでチェック状態更新
      if (b.id) {
        const item = await assertRowInScope("ops_check_items", b.id, c, "store_id");
        if (!item) return err("not_found", "項目が見つかりません", 404);
        const upd = b.checked
          ? { checked_at: new Date().toISOString(), checked_by: c.app_user_id ?? null }
          : { checked_at: null, checked_by: null };
        const { data, error } = await db().from("ops_check_items").update(upd)
          .eq("id", b.id).eq("tenant_id", c.tenant_id).select().single();
        if (error) return err("db_error", error.message, 400);
        return json(data);
      }
      // 新規項目（hq/manager のみ）
      if (!canWrite(c)) return err("forbidden", "権限がありません", 403);
      const row: Row = { tenant_id: c.tenant_id, label: b.label, category: b.category,
        store_id: c.app_role === "hq" ? b.storeId : c.store_id };
      const { data, error } = await db().from("ops_check_items").insert(row).select().single();
      if (error) return err("db_error", error.message, 400);
      return json(data, 201);
    }
  }

  // ── 価格履歴 ───────────────────────────────────────────────────────────
  if (r0 === "price-history" && method === "GET") {
    const { data, error } = await db().from("price_history").select("*")
      .eq("tenant_id", c.tenant_id).order("date", { ascending: false });
    if (error) return err("db_error", error.message, 400);
    return json({ data: data ?? [] });
  }

  // ── 課金 (Phase 3 スタブ) ──────────────────────────────────────────────
  if (r0 === "billing") {
    return err("not_implemented", "課金機能は Phase 3 で実装予定です", 501);
  }

  return null; // 未処理
}

// ── helper: routines / task_instances 取得 ──────────────────────────────────
async function listTasks(c: AppClaims, table: string): Promise<Response> {
  let q = db().from(table).select("*").eq("tenant_id", c.tenant_id);
  if (c.app_role !== "hq" && c.store_id) q = q.eq("store_id", c.store_id);
  const { data, error } = await q;
  if (error) return err("db_error", error.message, 400);
  return json({ data: data ?? [] });
}

async function listTaskInstances(c: AppClaims, category: string, url: URL): Promise<Response> {
  const date = url.searchParams.get("date") ?? new Date().toISOString().slice(0, 10);
  let q = db().from("task_instances").select("*")
    .eq("tenant_id", c.tenant_id).eq("category", category).eq("date", date);
  if (c.app_role !== "hq" && c.store_id) q = q.eq("store_id", c.store_id);
  const { data, error } = await q;
  if (error) return err("db_error", error.message, 400);
  return json({ data: data ?? [] });
}
