// netlify/functions/send-line.js
// LINE Messaging API Push送信

exports.handler = async (event) => {
  // POST以外は拒否
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!CHANNEL_ACCESS_TOKEN) {
    return { statusCode: 500, body: JSON.stringify({ error: "LINE token not configured" }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON" }) };
  }

  const { userId, orderText, supplierName } = body;

  if (!userId || !orderText) {
    return { statusCode: 400, body: JSON.stringify({ error: "userId and orderText are required" }) };
  }

  // LINEに送るメッセージを組み立て
  const message = {
    type: "text",
    text: orderText,
  };

  try {
    const res = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${CHANNEL_ACCESS_TOKEN}`,
      },
      body: JSON.stringify({
        to: userId,
        messages: [message],
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error("LINE API error:", err);
      return {
        statusCode: res.status,
        body: JSON.stringify({ error: "LINE API error", detail: err }),
      };
    }

    return {
      statusCode: 200,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ success: true, supplier: supplierName }),
    };

  } catch (err) {
    console.error("Fetch error:", err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
