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

const TTL_SECONDS = 60 * 60 * 12; // 12時間（店舗共用端末を考慮し短め, §15）

export async function issue(claims: Omit<AppClaims, "role" | "exp">): Promise<string> {
  const payload: Payload = {
    ...claims,
    role: "authenticated",
    exp: getNumericDate(TTL_SECONDS),
  };
  return await create({ alg: "HS256", typ: "JWT" }, payload, await key());
}

export async function verifyToken(token: string): Promise<AppClaims> {
  return (await verify(token, await key())) as unknown as AppClaims;
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
