// ============================================================================
// MISE TASK — API ルーター (Supabase Edge Function) — ハイブリッド構成
//   認証/テナント/課金: リレーショナル
//   業務データ: テナント別の KV 状態ストア(app_state)。フロントの配列同期に対応。
//
//   POST /auth/honbu-login   { email, password }              -> { token, userId, role, tenantId }
//   POST /auth/store-login   { code }                          -> { storeId, storeName, tenantId, users }
//   POST /auth/pin-login     { tenantId?, storeId, userId, pin } -> { userId, token, user }
//   POST /suppliers/register { token, ... }   (公開)
//   GET  /bootstrap          (Bearer) 全業務データ(KV) + tenant
//   GET  /state/:resource    (Bearer) 単一リソース
//   PUT  /state/:resource    (Bearer) { data } で配列まるごと保存
//   POST /bootstrap/reset     (Bearer, hq) KV を空に初期化
//   POST /billing/*           501 (Phase 3)
// ============================================================================
import { corsHeaders, err, json } from "../_shared/cors.ts";
import { admin, anon } from "../_shared/db.ts";
import { type AppClaims, getClaims, issue } from "../_shared/auth.ts";
import { verifyPin } from "../_shared/pin.ts";

const FN = "api";
const ROLE_JP: Record<string, AppClaims["app_role"]> = {
  "本部": "hq", "店長": "manager", "スタッフ": "staff", "アルバイト": "part",
};

// フロントが同期する業務リソース（KV）
const KV_RESOURCES = [
  "stores", "users", "suppliers", "inventory", "orders", "recipes", "routines",
  "prepTasks", "cleanTasks", "taskCats", "openItems", "closeItems",
  "priceHistory", "hqTasks", "pointConfig", "lastCarryDate",
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
async function setState(tenant: string, resource: string, data: unknown) {
  await admin().from("app_state")
    .upsert({ tenant_id: tenant, resource, data, updated_at: new Date().toISOString() },
      { onConflict: "tenant_id,resource" });
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
  const st = await getAllState(c.tenant_id);
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
    lastCarryDate: st.lastCarryDate ?? null,
  });
}

async function getStateRes(c: AppClaims, resource: string): Promise<Response> {
  if (!KV_RESOURCES.includes(resource)) return err("unknown_resource", `未対応: ${resource}`, 404);
  return json({ data: (await getState(c.tenant_id, resource)) ?? [] });
}

async function putStateRes(c: AppClaims, resource: string, req: Request): Promise<Response> {
  if (!KV_RESOURCES.includes(resource)) return err("unknown_resource", `未対応: ${resource}`, 404);
  const b = await body(req);
  await setState(c.tenant_id, resource, b.data ?? []);
  return json({ ok: true });
}

async function resetState(c: AppClaims): Promise<Response> {
  if (c.app_role !== "hq") return err("forbidden", "本部のみ実行できます", 403);
  for (const r of KV_RESOURCES) {
    await setState(c.tenant_id, r, r === "lastCarryDate" ? null : []);
  }
  return json({ data: { stores: [], users: [], suppliers: [], inventory: [], orders: [], recipes: [], routines: [], prepTasks: [], cleanTasks: [], taskCats: [], openItems: [], closeItems: [], priceHistory: [], hqTasks: [], lastCarryDate: null } });
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
      if (p[1] === "honbu-login") return await honbuLogin(req);
      if (p[1] === "store-login") return await storeLogin(req);
      if (p[1] === "pin-login")   return await pinLogin(req);
      return err("not_found", "未対応の認証エンドポイント", 404);
    }
    if (m === "POST" && p[0] === "suppliers" && p[1] === "register") return await supplierRegister(req);
    if (m === "POST" && p[0] === "suppliers" && p[1] === "price-update") return await supplierPriceUpdate(req);

    const claims = await getClaims(req);
    if (!claims) return err("unauthorized", "トークンが無効です", 401);

    if (m === "GET"  && p[0] === "bootstrap" && !p[1]) return await bootstrap(claims);
    if (m === "POST" && p[0] === "bootstrap" && p[1] === "reset") return await resetState(claims);
    if (m === "GET"  && p[0] === "state" && p[1]) return await getStateRes(claims, p[1]);
    if (m === "PUT"  && p[0] === "state" && p[1]) return await putStateRes(claims, p[1], req);

    if (m === "POST" && p[0] === "ai" && p[1] === "chat")    return await aiChat(req);
    if (m === "POST" && p[0] === "ai" && p[1] === "analyze") return await aiAnalyze(req);

    if (p[0] === "billing") return err("not_implemented", "課金は Phase 3 で実装予定です", 501);

    return err("not_found", `未対応: ${m} /${p.join("/")}`, 404);
  } catch (e) {
    console.error(e);
    return err("internal", String((e as Error)?.message ?? e), 500);
  }
});
