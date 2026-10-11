// ============================================================================
// MISE TASK — API ルーター (Supabase Edge Function) — ハイブリッド構成
//   認証/テナント/課金: リレーショナル
//   業務データ: テナント別の KV 状態ストア(app_state)。フロントの配列同期に対応。
//   棚卸し提出: リレーショナル（stocktake_submissions / stocktake_items）。
//     在庫の実数上書きと提出履歴の保存はここだけが行う（service_role）。
//
//   POST /auth/honbu-login   { email, password }              -> { token, userId, role, tenantId }
//   POST /auth/store-login   { code }                          -> { storeId, storeName, tenantId, users }
//   POST /auth/pin-login     { tenantId?, storeId, userId, pin } -> { userId, token, user }
//   POST /suppliers/register { token, ... }   (公開)
//   GET  /bootstrap          (Bearer) 全業務データ(KV) + tenant
//   GET  /state/:resource    (Bearer) 単一リソース
//   PUT  /state/:resource    (Bearer) { data } で配列まるごと保存
//   POST /bootstrap/reset     (Bearer, hq) KV を空に初期化
//   POST /stocktake/submit    (Bearer) { storeId, counts:{itemId:実数} } -> 在庫を実数で上書き＋履歴保存
//   GET  /stocktake/history   (Bearer) ?storeId= -> 提出履歴（本部=全店 / それ以外=自店のみ）
//   DELETE /stocktake/:id     (Bearer, hq) 提出履歴を削除
//   POST /line/webhook/:tenantId/:storeId (公開・LINE署名検証) / POST /line/send / GET /line/quota (LINE発注bot)
//   POST /billing/*           501 (Phase 3)
// ============================================================================
import { corsHeaders, err, json } from "../_shared/cors.ts";
import { admin, anon } from "../_shared/db.ts";
import { type AppClaims, getClaims, issue, issueQr, verifyQr } from "../_shared/auth.ts";
import { hashPin, verifyPin } from "../_shared/pin.ts";

const FN = "api";
const ROLE_JP: Record<string, AppClaims["app_role"]> = {
  "本部": "hq", "店長": "manager", "スタッフ": "staff", "アルバイト": "part",
};

// フロントが同期する業務リソース（KV）
const KV_RESOURCES = [
  "stores", "users", "suppliers", "inventory", "orders", "recipes", "routines",
  "prepTasks", "cleanTasks", "taskCats", "openItems", "closeItems",
  "priceHistory", "hqTasks", "pointConfig", "demandConfig", "lastCarryDate",
];

function path(req: Request): string[] {
  const p = new URL(req.url).pathname.replace(/^\/+/, "").split("/");
  if (p[0] === FN) p.shift();
  if (p[0] === "functions") p.splice(0, 3);
  return p.filter((s) => s.length > 0);
}
async function body(req: Request): Promise<Record<string, any>> {
  try { return await req.json(); } catch { return {}; }
}

// ── KV ヘルパー ─────────────────────────────────────────────────────────────
async function getState(tenant: string, resource: string): Promise<unknown> {
  const { data } = await admin().from("app_state").select("data")
    .eq("tenant_id", tenant).eq("resource", resource).maybeSingle();
  return data?.data ?? null;
}
async function getAllState(tenant: string): Promise<Record<string, unknown>> {
  const { data } = await admin().from("app_state").select("resource, data")
    .eq("tenant_id", tenant);
  const out: Record<string, unknown> = {};
  for (const row of data ?? []) out[(row as any).resource] = (row as any).data;
  return out;
}
// data と version(updated_at) を両方返す（楽観的ロック用）
async function getAllStateMeta(tenant: string): Promise<{ data: Record<string, unknown>; versions: Record<string, string> }> {
  const { data } = await admin().from("app_state").select("resource, data, updated_at")
    .eq("tenant_id", tenant);
  const out: Record<string, unknown> = {};
  const versions: Record<string, string> = {};
  for (const row of data ?? []) {
    out[(row as any).resource] = (row as any).data;
    versions[(row as any).resource] = (row as any).updated_at;
  }
  return { data: out, versions };
}
async function getMeta(tenant: string, resource: string): Promise<{ data: unknown; version: string } | null> {
  const { data } = await admin().from("app_state").select("data, updated_at")
    .eq("tenant_id", tenant).eq("resource", resource).maybeSingle();
  if (!data) return null;
  return { data: (data as any).data, version: (data as any).updated_at };
}
// 保存して新しい version(updated_at) を返す。
//   DBに実際に保存された形式を読み戻して返す（フロントとDBで文字列形式を一致させる）
async function setState(tenant: string, resource: string, data: unknown): Promise<string> {
  const now = new Date().toISOString();
  await admin().from("app_state")
    .upsert({ tenant_id: tenant, resource, data, updated_at: now },
      { onConflict: "tenant_id,resource" });
  const m = await getMeta(tenant, resource);
  return m?.version ?? now;
}
// バージョン(タイムスタンプ)が同一かを「時刻」として比較（"...Z" と "...+00:00" を同一視）
function sameVersion(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const ta = Date.parse(a), tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return a === b;
  return ta === tb;
}

// ── 認証 ─────────────────────────────────────────────────────────────────────
async function honbuLogin(req: Request): Promise<Response> {
  const { email, password } = await body(req) as { email?: string; password?: string };
  if (!email || !password) return err("invalid_input", "email と password が必要です");

  const { data, error } = await anon().auth.signInWithPassword({ email, password });
  if (error || !data.user) return err("auth_failed", "メールまたはパスワードが違います", 401);

  const { data: m } = await admin().from("memberships")
    .select("tenant_id, role").eq("user_id", data.user.id).eq("role", "hq").maybeSingle();
  if (!m) return err("forbidden", "本部権限がありません", 403);

  const { data: appUser } = await admin().from("app_users")
    .select("id, name").eq("auth_user_id", data.user.id).eq("tenant_id", m.tenant_id).maybeSingle();

  const userId = appUser?.id ?? data.user.id;
  const token = await issue({
    sub: data.user.id, app_role: "hq", tenant_id: m.tenant_id,
    store_id: null, app_user_id: userId, name: appUser?.name ?? "管理者",
  });
  return json({ token, userId, role: "hq", tenantId: m.tenant_id });
}

// 店舗コード -> 店舗 + スタッフ一覧（KV から）。複数テナント横断で code を探索。
async function storeLogin(req: Request): Promise<Response> {
  const { code } = await body(req) as { code?: string };
  if (!code) return err("invalid_input", "店舗コードが必要です");

  const { data: rows } = await admin().from("app_state").select("tenant_id, data").eq("resource", "stores");
  for (const row of rows ?? []) {
    const stores = ((row as any).data ?? []) as any[];
    const store = stores.find((s) => String(s.code ?? "").toLowerCase() === code.trim().toLowerCase());
    if (store) {
      const tenantId = (row as any).tenant_id;
      const users = ((await getState(tenantId, "users")) ?? []) as any[];
      const storeUsers = users.filter((u) => u.store === store.id && u.role !== "本部")
        .map((u) => ({ id: u.id, name: u.name, role: u.role, avatar: u.avatar, color: u.color, hasPin: !!u.pinHash }));
      return json({ storeId: store.id, storeName: store.name, tenantId, users: storeUsers });
    }
  }
  return err("not_found", "店舗コードが見つかりません", 404);
}

async function pinLogin(req: Request): Promise<Response> {
  const b = await body(req) as { tenantId?: string; storeId?: unknown; userId?: unknown; pin?: string };
  if (b.userId == null) return err("invalid_input", "userId が必要です");

  // テナント解決
  let tenantId = b.tenantId;
  if (!tenantId) {
    const { data: rows } = await admin().from("app_state").select("tenant_id, data").eq("resource", "stores");
    for (const row of rows ?? []) {
      const stores = ((row as any).data ?? []) as any[];
      if (stores.some((s) => s.id === b.storeId)) { tenantId = (row as any).tenant_id; break; }
    }
  }
  if (!tenantId) return err("not_found", "店舗が見つかりません", 404);

  const users = ((await getState(tenantId, "users")) ?? []) as any[];
  const u = users.find((x) => x.id === b.userId);
  if (!u) return err("not_found", "ユーザーが見つかりません", 404);

  if (u.pinHash) {
    if (!b.pin) return err("pin_required", "PIN が必要です", 401);
    if (!(await verifyPin(b.pin, u.pinHash))) return err("auth_failed", "PIN が違います", 401);
  }

  const token = await issue({
    sub: String(u.id), app_role: ROLE_JP[u.role] ?? "staff", tenant_id: tenantId,
    store_id: u.store != null ? String(u.store) : null, app_user_id: String(u.id), name: u.name,
  });
  return json({ userId: u.id, token, user: { id: u.id, name: u.name, role: u.role, avatar: u.avatar, color: u.color, store: u.store } });
}

// ── 店頭QRログイン（店舗タブレットで毎回QR発行 → スタッフが自分の携帯でスキャン） ──
//   POST /qr/issue (要認証: 店長/本部) → { qrToken, expiresAt }   店舗端末が短命QRを発行
//   POST /qr/login (公開)            → 店舗 + スタッフ一覧（storeLogin と同形）
async function qrIssue(c: AppClaims, req: Request): Promise<Response> {
  if (c.app_role !== "hq" && c.app_role !== "manager") {
    return err("forbidden", "QR発行は店長/本部のみ可能です", 403);
  }
  let storeId = c.store_id;
  if (!storeId) {
    const b = await body(req);
    storeId = b.storeId != null ? String(b.storeId) : null;
  }
  if (!storeId) return err("invalid_input", "店舗が特定できません");
  // storeId がテナントに属するか軽く検証
  const stores = ((await getState(c.tenant_id, "stores")) ?? []) as any[];
  if (!stores.some((s) => String(s.id) === String(storeId))) {
    return err("not_found", "店舗が見つかりません", 404);
  }
  const { token, exp } = await issueQr(c.tenant_id, String(storeId));
  return json({ qrToken: token, expiresAt: exp });
}

async function qrLogin(req: Request): Promise<Response> {
  const { qrToken } = await body(req) as { qrToken?: string };
  if (!qrToken) return err("invalid_input", "qrToken が必要です");
  let info: { tenant_id: string; store_id: string };
  try {
    info = await verifyQr(qrToken);
  } catch {
    return err("qr_expired", "QRが無効または期限切れです。店舗で新しいQRを表示してください。", 401);
  }
  const stores = ((await getState(info.tenant_id, "stores")) ?? []) as any[];
  const store = stores.find((s) => String(s.id) === String(info.store_id));
  if (!store) return err("not_found", "店舗が見つかりません", 404);
  const users = ((await getState(info.tenant_id, "users")) ?? []) as any[];
  const storeUsers = users.filter((u) => u.store === store.id && u.role !== "本部")
    .map((u) => ({ id: u.id, name: u.name, role: u.role, avatar: u.avatar, color: u.color, hasPin: !!u.pinHash }));
  return json({ storeId: store.id, storeName: store.name, tenantId: info.tenant_id, users: storeUsers });
}

// ── 店長/本部のメール+パスワード認証（専用KV "managerCreds"。bootstrapには載せない） ──
//   POST /auth/manager-login {email,password} (公開) → token
//   POST /users/set-credentials {userId,email,password} (要hq/manager) 認証情報を設定
async function managerLogin(req: Request): Promise<Response> {
  const b = await body(req);
  const email = String(b.email || "").trim().toLowerCase();
  if (!email || !b.password) return err("invalid_input", "メールとパスワードが必要です");
  const { data: rows } = await admin().from("app_state").select("tenant_id, data").eq("resource", "managerCreds");
  for (const row of rows ?? []) {
    const cred = (((row as any).data ?? []) as any[]).find((x) => String(x.email).toLowerCase() === email);
    if (!cred) continue;
    if (!(await verifyPin(String(b.password), cred.pwHash))) return err("auth_failed", "メールまたはパスワードが違います", 401);
    const tenantId = (row as any).tenant_id;
    const users = ((await getState(tenantId, "users")) ?? []) as any[];
    const u = users.find((x) => String(x.id) === String(cred.userId));
    if (!u) return err("not_found", "ユーザーが見つかりません", 404);
    const token = await issue({
      sub: String(u.id), app_role: ROLE_JP[u.role] ?? "manager", tenant_id: tenantId,
      store_id: u.store != null ? String(u.store) : null, app_user_id: String(u.id), name: u.name,
    });
    return json({ token, userId: u.id, user: { id: u.id, name: u.name, role: u.role, avatar: u.avatar, color: u.color, store: u.store }, storeId: u.store, tenantId, role: ROLE_JP[u.role] ?? "manager" });
  }
  return err("auth_failed", "メールまたはパスワードが違います", 401);
}

async function setUserCredentials(c: AppClaims, req: Request): Promise<Response> {
  if (c.app_role !== "hq" && c.app_role !== "manager") return err("forbidden", "権限がありません", 403);
  const b = await body(req);
  if (b.userId == null || !b.email) return err("invalid_input", "userId と email が必要です");
  const email = String(b.email).trim().toLowerCase();
  // 他テナント含むメール重複チェック
  const { data: rows } = await admin().from("app_state").select("tenant_id, data").eq("resource", "managerCreds");
  for (const row of rows ?? []) {
    if (String((row as any).tenant_id) === String(c.tenant_id)) continue;
    if ((((row as any).data ?? []) as any[]).some((x) => String(x.email).toLowerCase() === email && String(x.userId) !== String(b.userId))) {
      return err("email_taken", "このメールアドレスは既に使われています", 409);
    }
  }
  const creds = ((await getState(c.tenant_id, "managerCreds")) ?? []) as any[];
  const idx = creds.findIndex((x) => String(x.userId) === String(b.userId));
  const entry: any = { userId: String(b.userId), email };
  if (b.password) entry.pwHash = await hashPin(String(b.password));
  else if (idx >= 0) entry.pwHash = creds[idx].pwHash;
  if (idx >= 0) creds[idx] = { ...creds[idx], ...entry }; else creds.push(entry);
  await setState(c.tenant_id, "managerCreds", creds);
  return json({ ok: true });
}

// ── 業者セルフ登録（KV の suppliers をトークンで更新。公開） ──────────────────
async function supplierRegister(req: Request): Promise<Response> {
  const b = await body(req);
  if (!b.token) return err("invalid_input", "token が必要です");
  const { data: rows } = await admin().from("app_state").select("tenant_id, data").eq("resource", "suppliers");
  for (const row of rows ?? []) {
    const suppliers = ((row as any).data ?? []) as any[];
    const idx = suppliers.findIndex((s) => s.token === b.token);
    if (idx >= 0) {
      suppliers[idx] = { ...suppliers[idx], ...b, token: suppliers[idx].token, selfRegistered: true, registeredAt: new Date().toISOString().slice(0, 10) };
      await setState((row as any).tenant_id, "suppliers", suppliers);
      return json({ ok: true, supplier: { id: suppliers[idx].id, name: suppliers[idx].name } });
    }
  }
  return err("invalid_token", "無効なトークンです", 404);
}

// ── 業者: 値上げ表アップロード → AIで単価更新（公開・トークン制） ────────────
function extractJson(text: string): any {
  let s = String(text||"").replace(/```json/gi,"").replace(/```/g,"").trim();
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a>=0 && b>a) s = s.slice(a, b+1);
  return JSON.parse(s);
}
async function supplierPriceUpdate(req: Request): Promise<Response> {
  const bd = await body(req);
  if (!bd.token || !bd.image) return err("invalid_input", "token と画像/PDFが必要です");
  // トークンから業者・テナントを特定
  const { data: rows } = await admin().from("app_state").select("tenant_id, data").eq("resource", "suppliers");
  let tenantId: string | null = null; let supplier: any = null;
  for (const row of rows ?? []) {
    const s = ((row as any).data ?? []).find((x: any) => x.token === bd.token);
    if (s) { tenantId = (row as any).tenant_id; supplier = s; break; }
  }
  if (!tenantId || !supplier) return err("invalid_token", "無効なトークンです", 404);
  // AIで単価表を読み取り（サーバー側でGemini/Claude）
  const isImg = String(bd.mediaType||"").startsWith("image/");
  const messages = [{ role:"user", content:[
    { type: isImg ? "image" : "document", source:{ media_type: bd.mediaType || "application/pdf", data: bd.image }},
    { type:"text", text:"この単価表（請求書）から商品名と単価を抽出。同じ商品は1つにまとめる。数量や合計は不要。JSONのみ。" },
  ]}];
  const sys = "仕入れ単価表 読み取りAI。商品名と単価(数値)のみ抽出。JSON形式のみ: {\"items\":[{\"name\":\"商品名\",\"unitPrice\":数値}]}";
  const aiRes = await runAI(sys, messages);
  if (!aiRes.ok && aiRes.status !== 200) {
    const e = await aiRes.json().catch(()=>({}));
    return json({ error: { code:"ai_failed", message:"AI解析に失敗しました", detail:e } }, 502);
  }
  const aiData = await aiRes.json();
  let parsed: any;
  try { parsed = extractJson((aiData.content||[]).map((c:any)=>c.text||"").join("")); }
  catch { return err("parse_failed", "単価表を読み取れませんでした", 422); }
  const items = (parsed.items || (Array.isArray(parsed) ? parsed : [])).filter((x:any)=>x && x.name);
  // 在庫の単価を更新（名前一致。値が変わったものだけ）
  const inv = ((await getState(tenantId, "inventory")) ?? []) as any[];
  const changes: any[] = [];
  const newInv = inv.map((it:any) => {
    const m = items.find((x:any)=> String(x.name).trim() === String(it.name).trim());
    const np = m ? Number(m.unitPrice) : NaN;
    if (m && np > 0 && np !== Number(it.unitPrice)) {
      changes.push({ name: it.name, old: Number(it.unitPrice)||0, new: np });
      return { ...it, unitPrice: np };
    }
    return it;
  });
  if (changes.length) {
    await setState(tenantId, "inventory", newInv);
    const ph = ((await getState(tenantId, "priceHistory")) ?? []) as any[];
    const now = new Date().toISOString().slice(0,10);
    const add = changes.map((c,i)=>({ id:"ph"+Date.now()+"_"+i, supplierId: supplier.id, supplierName: supplier.name, itemName:c.name, oldPrice:c.old, newPrice:c.new, changedAt: now, notifiedHonbu:false, source:"業者アップロード" }));
    await setState(tenantId, "priceHistory", [...ph, ...add]);
  }
  return json({ ok:true, supplier: supplier.name, readCount: items.length, changed: changes.map(c=>({ itemName:c.name, oldPrice:c.old, newPrice:c.new })) });
}

// ── bootstrap / state ────────────────────────────────────────────────────────
async function bootstrap(c: AppClaims): Promise<Response> {
  const { data: st, versions } = await getAllStateMeta(c.tenant_id);
  const { data: tenant } = await admin().from("tenants")
    .select("id, name, plan, ai_option, status").eq("id", c.tenant_id).maybeSingle();

  const users = (st.users ?? []) as any[];
  // hq ユーザーを users に必ず含める（currentUser 解決のため）
  if (c.app_role === "hq" && c.app_user_id && !users.some((u) => String(u.id) === String(c.app_user_id))) {
    users.push({ id: c.app_user_id, name: c.name ?? "管理者", role: "本部", store: null, color: "#E85D04", avatar: "本" });
  }

  return json({
    tenant, role: c.app_role, storeId: c.store_id,
    stores: st.stores ?? [], users,
    suppliers: st.suppliers ?? [], inventory: st.inventory ?? [],
    orders: st.orders ?? [], recipes: st.recipes ?? [], routines: st.routines ?? [],
    prepTasks: st.prepTasks ?? [], cleanTasks: st.cleanTasks ?? [],
    taskCats: st.taskCats ?? [], openItems: st.openItems ?? [], closeItems: st.closeItems ?? [],
    priceHistory: st.priceHistory ?? [], hqTasks: st.hqTasks ?? [],
    pointConfig: st.pointConfig ?? null,
    demandConfig: st.demandConfig ?? null,
    lastCarryDate: st.lastCarryDate ?? null,
    versions, // 楽観的ロック用（resource→updated_at）
  });
}

async function getStateRes(c: AppClaims, resource: string): Promise<Response> {
  if (!KV_RESOURCES.includes(resource)) return err("unknown_resource", `未対応: ${resource}`, 404);
  return json({ data: (await getState(c.tenant_id, resource)) ?? [] });
}

async function putStateRes(c: AppClaims, resource: string, req: Request): Promise<Response> {
  if (!KV_RESOURCES.includes(resource)) return err("unknown_resource", `未対応: ${resource}`, 404);
  const b = await body(req);
  const incoming = Array.isArray(b.data) ? b.data : null;
  // 楽観的ロック: baseVersion が現在の version と食い違う = 別端末が先に更新済み
  //   → 古いデータでの上書きを拒否し、サーバーの最新を返す（データ消失を防ぐ）
  if (b.baseVersion) {
    const cur = await getMeta(c.tenant_id, resource);
    if (cur && !sameVersion(cur.version, b.baseVersion)) {
      return json({
        error: { code: "conflict", message: "別の端末で更新されています。最新を反映しました。" },
        currentVersion: cur.version, data: cur.data,
      }, 409);
    }
  } else if (incoming && incoming.length === 0) {
    // baseVersion なし（古い/開きっぱなしのタブ等）からの「空で上書き」は破壊的なので拒否。
    //   既存が非空なら消さずに現状維持し、最新を返す（データ消失を防ぐ最後の砦）
    const cur = await getMeta(c.tenant_id, resource);
    const existing = Array.isArray(cur?.data) ? (cur!.data as unknown[]) : [];
    if (existing.length > 0) {
      return json({
        error: { code: "empty_blocked", message: "空データでの上書きを防止しました（古いタブの可能性）。最新を反映しました。" },
        currentVersion: cur!.version, data: cur!.data,
      }, 409);
    }
  }
  const version = await setState(c.tenant_id, resource, b.data ?? []);
  return json({ ok: true, version });
}

async function resetState(c: AppClaims): Promise<Response> {
  if (c.app_role !== "hq") return err("forbidden", "本部のみ実行できます", 403);
  for (const r of KV_RESOURCES) {
    await setState(c.tenant_id, r, r === "lastCarryDate" ? null : []);
  }
  return json({ data: { stores: [], users: [], suppliers: [], inventory: [], orders: [], recipes: [], routines: [], prepTasks: [], cleanTasks: [], taskCats: [], openItems: [], closeItems: [], priceHistory: [], hqTasks: [], lastCarryDate: null } });
}

// ── 棚卸し提出（実数で在庫を上書き。履歴はリレーショナルに保存） ──────────────
//   誰が(app_user_id/name)・いつ(submitted_at)・各品目の実数は JWT/サーバー側の
//   値のみを信頼する（クライアントから偽装できない）。承認フローはなし＝提出即反映。
function normStoreId(v: unknown): string { return String(v); }

async function stocktakeSubmit(c: AppClaims, req: Request): Promise<Response> {
  const b = await body(req) as { storeId?: unknown; counts?: Record<string, unknown> };
  if (b.storeId == null) return err("invalid_input", "storeId が必要です");
  const storeId = normStoreId(b.storeId);
  if (c.app_role !== "hq" && normStoreId(c.store_id) !== storeId) {
    return err("forbidden", "自店舗以外の棚卸しは提出できません", 403);
  }
  const counts = (b.counts && typeof b.counts === "object") ? b.counts as Record<string, unknown> : {};

  const inv = ((await getState(c.tenant_id, "inventory")) ?? []) as any[];
  const storeItems = inv.filter((it) => normStoreId(it.storeId) === storeId);
  if (!storeItems.length) return err("not_found", "対象の在庫がありません", 404);

  const stores = ((await getState(c.tenant_id, "stores")) ?? []) as any[];
  const store = stores.find((s) => normStoreId(s.id) === storeId);

  const lines: any[] = [];
  let totalValue = 0, alertCount = 0, changed = false;
  const newInv = inv.map((it) => {
    if (normStoreId(it.storeId) !== storeId) return it;
    const theo = Number(it.stock) || 0;
    const raw = counts[it.id];
    const hasEntry = raw !== undefined && raw !== null && String(raw).trim() !== "";
    const actual = hasEntry ? (Number(raw) || 0) : theo;
    const rawP = Number(it.unitPrice) || 0;
    const perU = (it.orderByCase && Number(it.bagSize) > 0) ? rawP / Number(it.bagSize) : rawP;
    const diff = actual - theo;
    const value = Math.round(actual * perU);
    totalValue += value;
    if (theo > 0 && Math.abs(diff / theo) > 0.10) alertCount++;
    lines.push({
      itemId: it.id, name: it.name, category: it.category || "未分類", unit: it.unit || "",
      theoretical: theo, actual, diff, unitPrice: Math.round(perU * 100) / 100, value,
    });
    if (hasEntry && actual !== theo) changed = true;
    return hasEntry ? { ...it, stock: actual } : it;
  });

  if (changed) await setState(c.tenant_id, "inventory", newInv);

  const { data: sub, error: subErr } = await admin().from("stocktake_submissions").insert({
    tenant_id: c.tenant_id, store_id: storeId, store_name: store?.name ?? "店舗",
    submitted_by_app_user_id: c.app_user_id, submitted_by_name: c.name ?? "担当者",
    item_count: lines.length, total_value: totalValue, alert_count: alertCount,
  }).select("id, submitted_at").single();
  if (subErr || !sub) { console.error(subErr); return err("internal", "提出履歴の保存に失敗しました", 500); }

  const itemRows = lines.map((l) => ({
    submission_id: sub.id, tenant_id: c.tenant_id, item_id: l.itemId, item_name: l.name,
    category: l.category, unit: l.unit, theoretical_stock: l.theoretical, actual_stock: l.actual,
    diff: l.diff, unit_price: l.unitPrice, value: l.value,
  }));
  const { error: itemsErr } = await admin().from("stocktake_items").insert(itemRows);
  if (itemsErr) console.error(itemsErr); // 明細保存の失敗は提出自体をロールバックしない（ログのみ）

  return json({
    ok: true,
    submission: {
      id: sub.id, storeId, storeName: store?.name ?? "店舗", submittedAt: sub.submitted_at,
      submittedBy: c.name ?? "担当者", lines, totalValue, alertCount, itemCount: lines.length,
    },
    inventory: changed ? newInv : undefined,
  });
}

async function stocktakeHistory(c: AppClaims, req: Request): Promise<Response> {
  const url = new URL(req.url);
  const storeId = url.searchParams.get("storeId");
  let q = admin().from("stocktake_submissions")
    .select("id, store_id, store_name, submitted_by_name, submitted_at, item_count, total_value, alert_count")
    .eq("tenant_id", c.tenant_id).order("submitted_at", { ascending: false }).limit(200);
  if (c.app_role !== "hq") {
    q = q.eq("store_id", normStoreId(c.store_id));
  } else if (storeId) {
    q = q.eq("store_id", storeId);
  }
  const { data: subs, error } = await q;
  if (error) { console.error(error); return err("internal", "履歴の取得に失敗しました", 500); }

  const ids = (subs ?? []).map((s: any) => s.id);
  const itemsBySub: Record<string, any[]> = {};
  if (ids.length) {
    const { data: items } = await admin().from("stocktake_items")
      .select("submission_id, item_id, item_name, category, unit, theoretical_stock, actual_stock, diff, unit_price, value")
      .in("submission_id", ids);
    for (const it of items ?? []) {
      const k = (it as any).submission_id;
      (itemsBySub[k] ??= []).push({
        itemId: (it as any).item_id, name: (it as any).item_name, category: (it as any).category,
        unit: (it as any).unit, theoretical: Number((it as any).theoretical_stock), actual: Number((it as any).actual_stock),
        diff: Number((it as any).diff), unitPrice: Number((it as any).unit_price), value: Number((it as any).value),
      });
    }
  }

  const result = (subs ?? []).map((s: any) => ({
    id: s.id, storeId: s.store_id, storeName: s.store_name, submittedAt: s.submitted_at,
    submittedBy: s.submitted_by_name, itemCount: s.item_count, totalValue: s.total_value,
    alertCount: s.alert_count, lines: itemsBySub[s.id] ?? [],
  }));
  return json({ data: result });
}

async function stocktakeDelete(c: AppClaims, id: string): Promise<Response> {
  if (c.app_role !== "hq") return err("forbidden", "本部のみ削除できます", 403);
  const { error } = await admin().from("stocktake_submissions").delete().eq("id", id).eq("tenant_id", c.tenant_id);
  if (error) { console.error(error); return err("internal", "削除に失敗しました", 500); }
  return json({ ok: true });
}

// ── LINE（店舗ごとのbotが、業者さんとのLINEグループに発注文を投稿する）──────────
//   シークレット: LINE_TOKEN_<店舗番号> / LINE_SECRET_<店舗番号>
//     （無ければ LINE_CHANNEL_ACCESS_TOKEN / LINE_CHANNEL_SECRET を共通で使う）
//   POST /line/webhook/:tenantId/:storeId  (公開・LINEの署名で検証) グループ参加・登録コード・通知先設定
//   POST /line/send   (要認証) { storeId, supplierId, text } → その業者のグループへbotが投稿
//   GET  /line/quota  (要認証) ?storeId= → 今月の送信数と上限
//   業者とグループの結び付き: suppliers[].lineCode（MT-1234）/ suppliers[].lineGroups[店舗番号] = groupId
//   店舗ごとの設定: KV "lineConfig" { [店舗番号]: { notifyGroupId, warnedMonth } }
const LINE_API = "https://api.line.me/v2/bot";
const lineToken = (storeId: string) =>
  Deno.env.get(`LINE_TOKEN_${storeId}`) || Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN") || "";
const lineSecret = (storeId: string) =>
  Deno.env.get(`LINE_SECRET_${storeId}`) || Deno.env.get("LINE_CHANNEL_SECRET") || "";
const jstMonth = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 7);

async function lineCall(storeId: string, path: string, init: RequestInit = {}): Promise<Response> {
  const t = lineToken(storeId);
  if (!t) throw new Error("line_unconfigured");
  return await fetch(LINE_API + path, {
    ...init,
    headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}
async function lineReply(storeId: string, replyToken: string, text: string) {
  try {
    await lineCall(storeId, "/message/reply", { method: "POST", body: JSON.stringify({ replyToken, messages: [{ type: "text", text }] }) });
  } catch (e) { console.error("line reply failed", e); }
}
async function linePush(storeId: string, to: string, text: string): Promise<Response> {
  return await lineCall(storeId, "/message/push", { method: "POST", body: JSON.stringify({ to, messages: [{ type: "text", text: text.slice(0, 4900) }] }) });
}
async function lineQuota(storeId: string): Promise<{ limit: number | null; used: number }> {
  const [q, c] = await Promise.all([lineCall(storeId, "/message/quota"), lineCall(storeId, "/message/quota/consumption")]);
  const qj = await q.json().catch(() => ({}));
  const cj = await c.json().catch(() => ({}));
  return { limit: qj?.type === "limited" ? Number(qj.value) : null, used: Number(cj?.totalUsage) || 0 };
}
async function verifyLineSignature(secret: string, raw: string, sig: string | null): Promise<boolean> {
  if (!secret || !sig) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)));
  const expected = btoa(String.fromCharCode(...mac));
  if (expected.length !== sig.length) return false;
  let d = 0;
  for (let i = 0; i < expected.length; i++) d |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return d === 0;
}
async function storeNameOf(tenantId: string, storeId: string): Promise<string> {
  const stores = ((await getState(tenantId, "stores")) ?? []) as any[];
  return stores.find((s) => String(s.id) === String(storeId))?.name ?? "店舗";
}

async function lineWebhook(req: Request, tenantId: string, storeId: string): Promise<Response> {
  const raw = await req.text();
  if (!(await verifyLineSignature(lineSecret(storeId), raw, req.headers.get("x-line-signature")))) {
    return err("bad_signature", "署名が一致しません", 401);
  }
  let payload: any = {};
  try { payload = JSON.parse(raw); } catch { /* 空 */ }
  for (const ev of payload?.events ?? []) {
    const groupId = ev?.source?.type === "group" ? ev.source.groupId : (ev?.source?.type === "room" ? ev.source.roomId : null);
    if (ev.type === "join" && groupId) {
      await lineReply(storeId, ev.replyToken,
        "参加しました。このグループを発注先として使うには、アプリの業者一覧「LINEグループ」に出ている登録コード（例: MT-1234）をこのグループに送ってください。");
      continue;
    }
    if (ev.type !== "message" || ev.message?.type !== "text" || !groupId) continue;
    const text = String(ev.message.text || "").trim();

    if (text === "通知先に設定") {
      const cfg = ((await getState(tenantId, "lineConfig")) ?? {}) as Record<string, any>;
      cfg[storeId] = { ...(cfg[storeId] ?? {}), notifyGroupId: groupId };
      await setState(tenantId, "lineConfig", cfg);
      await lineReply(storeId, ev.replyToken, "このグループを、送信数のお知らせ先に設定しました。");
      continue;
    }

    const m = text.match(/MT-?(\d{4})/i);
    if (!m) continue; // 通常の会話には反応しない
    const code = "MT-" + m[1];
    const suppliers = ((await getState(tenantId, "suppliers")) ?? []) as any[];
    const idx = suppliers.findIndex((s) => String(s.lineCode || "").toUpperCase() === code);
    if (idx < 0) {
      await lineReply(storeId, ev.replyToken, `登録コード ${code} が見つかりませんでした。アプリに出ているコードをご確認ください。`);
      continue;
    }
    const sp = suppliers[idx];
    suppliers[idx] = { ...sp, lineGroups: { ...(sp.lineGroups ?? {}), [storeId]: groupId } };
    await setState(tenantId, "suppliers", suppliers);
    const storeName = await storeNameOf(tenantId, storeId);
    await lineReply(storeId, ev.replyToken,
      `✓ このグループを「${sp.companyName || sp.name}」さんの発注グループとして登録しました（${storeName}）。今後の発注はここに届きます。`);
  }
  return json({ ok: true });
}

async function lineSend(c: AppClaims, req: Request): Promise<Response> {
  const b = await body(req) as { storeId?: unknown; supplierId?: unknown; text?: string };
  if (b.storeId == null || b.supplierId == null || !String(b.text || "").trim()) return err("invalid_input", "storeId / supplierId / text が必要です");
  const storeId = String(b.storeId);
  if (c.app_role !== "hq" && String(c.store_id) !== storeId) return err("forbidden", "自店舗以外からは送れません", 403);
  if (!lineToken(storeId)) return err("line_unconfigured", "この店舗のLINE botが設定されていません", 503);
  const suppliers = ((await getState(c.tenant_id, "suppliers")) ?? []) as any[];
  const sp = suppliers.find((s) => String(s.id) === String(b.supplierId));
  const groupId = sp?.lineGroups?.[storeId];
  if (!groupId) return err("line_not_linked", "この業者のLINEグループがまだ登録されていません", 409);

  let quota: { limit: number | null; used: number } | null = null;
  try { quota = await lineQuota(storeId); } catch (e) { console.error("quota check failed", e); }
  if (quota?.limit != null && quota.used >= quota.limit) {
    return json({ error: { code: "line_quota", message: "今月のLINE送信の上限に達しました" }, quota }, 429);
  }
  const r = await linePush(storeId, groupId, String(b.text));
  if (!r.ok) {
    const detail = await r.json().catch(() => ({}));
    console.error("line push failed", r.status, detail);
    return json({ error: { code: r.status === 429 ? "line_quota" : "line_failed", message: "LINEへの送信に失敗しました" }, status: r.status }, 502);
  }
  // 8割を超えたら、通知先グループに月1回だけお知らせ
  if (quota?.limit && (quota.used + 1) / quota.limit >= 0.8) {
    try {
      const cfg = ((await getState(c.tenant_id, "lineConfig")) ?? {}) as Record<string, any>;
      const sc = cfg[storeId] ?? {};
      const month = jstMonth();
      if (sc.notifyGroupId && sc.warnedMonth !== month) {
        const storeName = await storeNameOf(c.tenant_id, storeId);
        await linePush(storeId, sc.notifyGroupId,
          `【お知らせ】${storeName}のLINE発注の送信数が今月 ${quota.used + 1} / ${quota.limit} 通になりました。上限に達するとbotから送れなくなり、アプリでは手動送信に切り替わります。`);
        cfg[storeId] = { ...sc, warnedMonth: month };
        await setState(c.tenant_id, "lineConfig", cfg);
      }
    } catch (e) { console.error("quota notice failed", e); }
  }
  return json({ ok: true, quota: quota ? { ...quota, used: quota.used + 1 } : null });
}

async function lineQuotaRes(c: AppClaims, req: Request): Promise<Response> {
  const storeId = new URL(req.url).searchParams.get("storeId") || String(c.store_id ?? "");
  if (!storeId) return err("invalid_input", "storeId が必要です");
  if (!lineToken(storeId)) return json({ configured: false });
  try { return json({ configured: true, quota: await lineQuota(storeId) }); }
  catch { return json({ configured: true, quota: null }); }
}

// ── AI プロキシ（既定: Gemini / 切替: Claude）。キーはサーバー秘匿。要認証 ──
//   フロントは Anthropic 形式の {messages, system} を送り、{content:[{text}]} を期待。
//   どのプロバイダでもこの形に正規化して返す。
//   AI_PROVIDER = "gemini"(既定) | "claude"
const PROVIDER = (Deno.env.get("AI_PROVIDER") || "gemini").toLowerCase();
const GEMINI_MODEL = Deno.env.get("GEMINI_MODEL") || "gemini-2.5-flash";
const CLAUDE_MODEL = Deno.env.get("CLAUDE_MODEL") || "claude-sonnet-4-6";

type Block = { type: string; text?: string; source?: { media_type: string; data: string } };
type Msg = { role: string; content: Block[] | string };

async function callClaude(system: unknown, messages: Msg[]): Promise<Response> {
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) return err("ai_unconfigured", "ANTHROPIC_API_KEY が未設定です", 503);
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 16384, system, messages }),
  });
  const data = await r.json();
  return json(data, r.ok ? 200 : r.status); // 既に {content:[{text}]} 形式
}

async function callGemini(system: unknown, messages: Msg[]): Promise<Response> {
  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) return err("ai_unconfigured", "GEMINI_API_KEY が未設定です", 503);
  // Anthropic 形式 → Gemini 形式へ変換
  const contents = messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: (Array.isArray(m.content) ? m.content : [{ type: "text", text: String(m.content) }]).map((b) => {
      if ((b.type === "image" || b.type === "document") && b.source) {
        return { inline_data: { mime_type: b.source.media_type, data: b.source.data } };
      }
      return { text: b.text ?? "" };
    }),
  }));
  const reqBody: Record<string, unknown> = { contents, generationConfig: { maxOutputTokens: 16384 } };
  if (system) reqBody.systemInstruction = { parts: [{ text: String(system) }] };

  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(reqBody) },
  );
  const data = await r.json();
  if (!r.ok) return json(data, r.status);
  // Gemini 応答 → Anthropic 風 {content:[{type:"text",text}]} に正規化
  let text = (data?.candidates?.[0]?.content?.parts ?? [])
    .map((p: { text?: string }) => p.text ?? "").join("");
  // markdown コードフェンス/バッククォート/前後の余計な文字を除去（JSON抽出を安定化）
  text = text.trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .replace(/^`+|`+$/g, "")
    .trim();
  return json({ content: [{ type: "text", text }] });
}

async function runAI(system: unknown, messages: Msg[]): Promise<Response> {
  return PROVIDER === "claude" ? await callClaude(system, messages) : await callGemini(system, messages);
}

async function aiChat(req: Request): Promise<Response> {
  const { messages, system } = await body(req);
  if (!messages) return err("invalid_input", "messages が必要です");
  return await runAI(system, messages);
}
async function aiAnalyze(req: Request): Promise<Response> {
  const { image, mediaType, prompt, system } = await body(req);
  if (!image) return err("invalid_input", "image が必要です");
  const messages: Msg[] = [{
    role: "user",
    content: [
      { type: "image", source: { media_type: mediaType, data: image } },
      { type: "text", text: prompt ?? "この画像を解析してください。" },
    ],
  }];
  return await runAI(system, messages);
}

// ── ルーター ───────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const p = path(req);
  const m = req.method;
  try {
    if (m === "POST" && p[0] === "auth") {
      if (p[1] === "honbu-login")   return await honbuLogin(req);
      if (p[1] === "store-login")   return await storeLogin(req);
      if (p[1] === "pin-login")     return await pinLogin(req);
      if (p[1] === "manager-login") return await managerLogin(req);
      return err("not_found", "未対応の認証エンドポイント", 404);
    }
    if (m === "POST" && p[0] === "suppliers" && p[1] === "register") return await supplierRegister(req);
    if (m === "POST" && p[0] === "suppliers" && p[1] === "price-update") return await supplierPriceUpdate(req);
    if (m === "POST" && p[0] === "qr" && p[1] === "login") return await qrLogin(req);
    if (m === "POST" && p[0] === "line" && p[1] === "webhook" && p[2] && p[3]) return await lineWebhook(req, p[2], p[3]);

    const claims = await getClaims(req);
    if (!claims) return err("unauthorized", "トークンが無効です", 401);

    if (m === "POST" && p[0] === "qr" && p[1] === "issue") return await qrIssue(claims, req);
    if (m === "POST" && p[0] === "users" && p[1] === "set-credentials") return await setUserCredentials(claims, req);

    if (m === "GET"  && p[0] === "bootstrap" && !p[1]) return await bootstrap(claims);
    if (m === "POST" && p[0] === "bootstrap" && p[1] === "reset") return await resetState(claims);
    if (m === "GET"  && p[0] === "state" && p[1]) return await getStateRes(claims, p[1]);
    if (m === "PUT"  && p[0] === "state" && p[1]) return await putStateRes(claims, p[1], req);

    if (m === "POST"   && p[0] === "stocktake" && p[1] === "submit")  return await stocktakeSubmit(claims, req);
    if (m === "GET"    && p[0] === "stocktake" && p[1] === "history") return await stocktakeHistory(claims, req);
    if (m === "DELETE" && p[0] === "stocktake" && p[1])               return await stocktakeDelete(claims, p[1]);

    if (m === "POST" && p[0] === "ai" && p[1] === "chat")    return await aiChat(req);
    if (m === "POST" && p[0] === "ai" && p[1] === "analyze") return await aiAnalyze(req);

    if (m === "POST" && p[0] === "line" && p[1] === "send")  return await lineSend(claims, req);
    if (m === "GET"  && p[0] === "line" && p[1] === "quota") return await lineQuotaRes(claims, req);

    if (p[0] === "billing") return err("not_implemented", "課金は Phase 3 で実装予定です", 501);

    return err("not_found", `未対応: ${m} /${p.join("/")}`, 404);
  } catch (e) {
    console.error(e);
    return err("internal", String((e as Error)?.message ?? e), 500);
  }
});
