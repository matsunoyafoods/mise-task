// アプリ用 JWT の発行・検証（HS256, APP_JWT_SECRET で署名）
// claims に tenant_id / store_id / app_role / app_user_id を載せ、API のスコープ判定に使う。
import { create, getNumericDate, type Payload, verify } from "https://deno.land/x/djwt@v3.0.2/mod.ts";

export type AppRole = "hq" | "manager" | "staff" | "part";

export interface AppClaims {
  sub: string;          // auth.users.id（hq/manager）または app_users.id（staff）
  role: "authenticated"; // Supabase 互換
  app_role: AppRole;
  tenant_id: string;
  store_id: string | null;
  app_user_id: string | null;
  name?: string;
  exp?: number;
}

async function key(): Promise<CryptoKey> {
  const secret = Deno.env.get("APP_JWT_SECRET");
  if (!secret) throw new Error("APP_JWT_SECRET 未設定");
  return await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

// セッション有効期間（ロール別）
//   staff / part … 4時間（出勤中のみ。退勤後は再度店頭QRが必要）
//   hq / manager … 90日（本部・店舗タブレットはログインしたままにする運用）
const TTL_STAFF = 60 * 60 * 4;
const TTL_ADMIN = 60 * 60 * 24 * 90;

export async function issue(claims: Omit<AppClaims, "role" | "exp">): Promise<string> {
  const ttl = (claims.app_role === "staff" || claims.app_role === "part") ? TTL_STAFF : TTL_ADMIN;
  const payload: Payload = {
    ...claims,
    role: "authenticated",
    exp: getNumericDate(ttl),
  };
  return await create({ alg: "HS256", typ: "JWT" }, payload, await key());
}

export async function verifyToken(token: string): Promise<AppClaims> {
  return (await verify(token, await key())) as unknown as AppClaims;
}

// ── 店頭QR用の短命トークン（店舗タブレットで毎回発行） ──────────────────────
const QR_TTL_SECONDS = 90; // 90秒で失効（持ち出し対策）
export async function issueQr(tenant_id: string, store_id: string): Promise<{ token: string; exp: number }> {
  const exp = getNumericDate(QR_TTL_SECONDS);
  const token = await create(
    { alg: "HS256", typ: "JWT" },
    { kind: "qr", tenant_id, store_id, role: "authenticated", exp } as Payload,
    await key(),
  );
  return { token, exp };
}
export async function verifyQr(token: string): Promise<{ tenant_id: string; store_id: string }> {
  const p = (await verify(token, await key())) as Record<string, unknown>;
  if (p.kind !== "qr") throw new Error("not a qr token");
  return { tenant_id: String(p.tenant_id), store_id: String(p.store_id) };
}

// Authorization: Bearer <token> から claims を取り出す。失敗なら null。
export async function getClaims(req: Request): Promise<AppClaims | null> {
  const h = req.headers.get("authorization") ?? "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  try {
    return await verifyToken(m[1]);
  } catch {
    return null;
  }
}
