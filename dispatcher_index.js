const http = require("http");

const TECNICOS_GROUP = "558694126569-1580854476@g.us";

const TARGETS = {
  "ecommerce":  "http://ecommerce-web:3000/api/webhook/whatsapp",
  "tecnicos":   "http://tecnicos-bot:3100/webhook",
  "default":    "http://api:3000/whatsapp/webhook",
};

function forward(url, body) {
  const data = JSON.stringify(body);
  const parsed = new URL(url);
  const req = http.request({
    hostname: parsed.hostname,
    port: parsed.port,
    path: parsed.pathname,
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
  }, (res) => {
    let respData = "";
    res.on("data", (c) => respData += c);
    res.on("end", () => {
      console.log(`[FWD] ${url} -> ${res.statusCode}`);
    });
  });
  req.on("error", (e) => console.error(`[FWD] Error ${url}: ${e.message}`));
  req.write(data);
  req.end();
}

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"ok":true}');

    try {
      const data = JSON.parse(body);
      const session = data.session || "";
      const event = data.event || "unknown";
      const msgData = data.data || data;
      const from = msgData.from || msgData.chatId || "?";
      const sender = msgData.sender?.id || msgData.sender || msgData.author || "";
      const notifyName = msgData.notifyName || msgData.sender?.pushname || "";
      const msgBody = (msgData.body || msgData.content || "").slice(0, 50);

      if (event === "onmessage") {
        console.log(`[MSG] session=${session} from=${from} sender=${sender} name=${notifyName} body="${msgBody}"`);
        if (from.includes("@lid")) {
          console.log(`[LID] Full payload keys: ${Object.keys(msgData).join(",")}`);
          console.log(`[LID] chatId=${msgData.chatId} from=${msgData.from} to=${msgData.to} author=${msgData.author}`);
          if (msgData.sender) console.log(`[LID] sender=${JSON.stringify(msgData.sender).slice(0, 200)}`);
        }
      } else {
        console.log(`[RECV] session=${session} event=${event}`);
      }

      // ROTEAMENTO
      // 1) Grupo dos tecnicos (prioridade alta): qualquer sessao, se vier do grupo alvo -> tecnicos-bot
      if (from === TECNICOS_GROUP && (event === "onmessage" || event === "unreadmessages")) {
        forward(TARGETS["tecnicos"], data);
        return;
      }

      // 2) Sessao ecommerce
      if (session === "ecommerce") {
        forward(TARGETS["ecommerce"], data);
        return;
      }

      // 3) Default (rifa-bot api)
      forward(TARGETS["default"], data);
    } catch (e) {
      console.error("[RECV] Parse error:", e.message);
    }
  });
});

server.listen(3099, "0.0.0.0", () => {
  console.log("Webhook dispatcher listening on :3099 (with tecnicos-bot routing)");
});
