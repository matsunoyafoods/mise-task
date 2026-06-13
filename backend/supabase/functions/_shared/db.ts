// service_role クライアント（RLS を bypass する。tenant_id は API 層で必ず検証する, F03）
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

let _admin: SupabaseClient | null = null;

export function admin(): SupabaseClient {
  if (_admin) return _admin;
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 未設定");
  _admin = createClient(url, key, { auth: { persistSession: false } });
  return _admin;
}

// anon クライアント（email+password 検証用。signInWithPassword を使う）
export function anon(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_ANON_KEY 未設定");
  return createClient(url, key, { auth: { persistSession: false } });
}
