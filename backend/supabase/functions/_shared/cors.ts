// CORS ヘッダ（フロント = Netlify ドメインから呼ばれる）
// 本番では "*" を実ドメインに絞ること（§16）。
export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, idempotency-key",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

export function err(code: string, message: string, status = 400): Response {
  return json({ error: { code, message } }, status);
}
