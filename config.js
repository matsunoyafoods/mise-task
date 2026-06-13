(function initMiseTaskConfig() {
  // ── Supabase Edge Functions をバックエンドに使用 ──
  //   ローカルファイル(file://)で開いても本番APIに繋がるよう、常に本番を向ける。
  //   ローカルの supabase を使う場合はここを localhost:54321 に変更。
  const SUPABASE_PROJECT_REF = "befzwhjnwhfiweynqoyk";
  const apiBase = `https://${SUPABASE_PROJECT_REF}.supabase.co/functions/v1/api`;

  window.MISE_TASK_CONFIG = Object.assign(
    {
      API_BASE: apiBase,
      AI_API_URL: apiBase + "/ai",        // Phase 3 で実装（現状 501）
      STRIPE_PUBLISHABLE_KEY: "",         // Phase 3
      USE_DEMO_DATA: false,
    },
    window.MISE_TASK_CONFIG || {}
  );
})();
