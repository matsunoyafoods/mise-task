// netlify/functions/line-webhook.js
// 業者がLINE公式アカウントを友だち追加したとき、
// URLパラメータのtokenと紐付けてUser IDを保存する

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: "Invalid JSON" };
  }

  // LINEからのWebhookイベントを処理
  const events = body.events || [];

  for (const ev of events) {
    // 友だち追加イベント（follow）
    if (ev.type === "follow") {
      const userId = ev.source?.userId;
      if (!userId) continue;

      // Netlify Blob / KV にUser IDを保存する
      // ここではNetlify Environment Variables経由でDBなしで動かすため
      // 実際の本番ではNetlify BlobsやSupabaseを使う
      // 今はUser IDをLINEに返信して本部に知らせる方式
      await notifyHonbu(userId);
    }
  }

  // LINEには必ず200を返す
  return { statusCode: 200, body: JSON.stringify({ status: "ok" }) };
};

async function notifyHonbu(userId) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) return;

  // 友だち追加した業者に「登録URLを送ってください」と返信
  await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify({
      to: userId,
      messages: [{
        type: "text",
        text: `✅ 友だち追加ありがとうございます！\n\n発注システムとの連携を完了するには、お店から送られた登録URLを開いてください。\n\nあなたのLINE連携コード:\n${userId}\n\n（このコードは登録URLを開くと自動で設定されます）`,
      }],
    }),
  });
}
