import express from "express";
import pg from "pg";
import fetch from "node-fetch";

const PORT            = process.env.PORT            || 3100;
const CHAT_ID         = process.env.CHAT_ID         || "558694126569-1580854476@g.us";
const WPP_HOST        = process.env.WPP_HOST        || "http://wppconnect:21465";
const WPP_SESSION     = process.env.WPP_SESSION     || "rifa-bot";
const WPP_SECRET      = process.env.WPP_SECRET      || "MAISINTERNET_SUPER_SECRET";
const GEMINI_KEY      = process.env.GEMINI_KEY      || "";
const GEMINI_MODEL    = process.env.GEMINI_MODEL    || "gemini-2.0-flash";
const GESPROV_URL     = process.env.GESPROV_URL     || "";   // ex: http://genius-acs:8080
const REPLY_ON_GROUP  = (process.env.REPLY_ON_GROUP || "true") === "true";

const pool = new pg.Pool({
  host: process.env.PGHOST || "postgres",
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || "postgres",
  password: process.env.PGPASSWORD || "postgres",
  database: process.env.PGDATABASE || "rifa_bot",
});

// --- WPPConnect token cache ---
let wppToken = null;
let wppTokenAt = 0;
async function wppTokenGet() {
  if (wppToken && Date.now() - wppTokenAt < 60 * 60 * 1000) return wppToken;
  const r = await fetch(`${WPP_HOST}/api/${WPP_SESSION}/${WPP_SECRET}/generate-token`, { method: "POST" });
  const j = await r.json();
  wppToken = j.token;
  wppTokenAt = Date.now();
  return wppToken;
}
async function wppCall(path, body) {
  const token = await wppTokenGet();
  const r = await fetch(`${WPP_HOST}/api/${WPP_SESSION}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return r.json();
}
async function wppSendText(chatId, text) {
  return wppCall("/send-message", { phone: chatId, message: text, isGroup: chatId.endsWith("@g.us") });
}

// --- Gemini Vision + NLP ---
const PROMPT = `Voce e um assistente que extrai dados de uma mensagem do WhatsApp de tecnicos de ISP.
Pode vir com uma foto de equipamento (roteador, ONT/ONU) e um texto descritivo.

Extraia em JSON EXATO com esses campos (use null quando nao tiver):
{
  "tipo": "instalacao" | "troca" | "manutencao" | "outros",
  "cliente_nome": string|null,
  "cliente_cpf": string|null,
  "cliente_login": string|null,
  "equipamento": "roteador" | "ont" | "onu" | "switch" | "outro" | null,
  "fabricante": string|null,
  "modelo": string|null,
  "serial": string|null,
  "mac": string|null,
  "equip_anterior": string|null,
  "observacoes": string|null
}

Regras:
- Serial (SN) e MAC sao impressos na etiqueta do equipamento. NAO invente valores.
- MAC tem formato AA:BB:CC:DD:EE:FF ou AABBCCDDEEFF.
- Se o texto disser "troca" ou "trocou" ou "substituicao" -> tipo=troca.
- Se "instalacao" ou "novo cliente" -> tipo=instalacao.
- Se "manutencao" ou "visita" ou "problema" -> tipo=manutencao.
- Responda SOMENTE com o JSON, sem markdown, sem explicacoes.`;

async function geminiExtract({ text, imageBase64, imageMime }) {
  if (!GEMINI_KEY) throw new Error("GEMINI_KEY ausente");
  const parts = [{ text: PROMPT }];
  if (text) parts.push({ text: `\n\nTexto da mensagem:\n${text}` });
  if (imageBase64) parts.push({ inline_data: { mime_type: imageMime || "image/jpeg", data: imageBase64 } });

  const models = [GEMINI_MODEL, "gemini-2.0-flash-lite", "gemini-2.0-flash", "gemini-2.5-flash-lite", "gemini-2.5-flash"];
  const seen = new Set();
  const body = {
    contents: [{ parts }],
    generationConfig: { temperature: 0.1, responseMimeType: "application/json" },
  };
  for (const model of models) {
    if (seen.has(model)) continue;
    seen.add(model);
    for (let attempt = 1; attempt <= 2; attempt++) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`;
      try {
        const r = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const j = await r.json();
        if (j.error) {
          console.error(`[GEMINI ERR] model=${model} try=${attempt} code=${j.error.code}: ${String(j.error.message).slice(0,150)}`);
          if (j.error.code === 503 && attempt === 1) {
            await new Promise(r => setTimeout(r, 1500));
            continue; // retry mesmo modelo
          }
          break; // proximo modelo
        }
        const raw = j.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
        console.log(`[GEMINI OK] model=${model} raw=${raw.slice(0,150)}`);
        try { return { raw, parsed: JSON.parse(raw) }; }
        catch (e) {
          console.error(`[GEMINI parse fail] ${e.message}`);
          return { raw, parsed: {} };
        }
      } catch (e) {
        console.error(`[GEMINI net err] model=${model} try=${attempt}: ${e.message}`);
      }
    }
  }
  return { raw: "{}", parsed: {} };
}

// --- Gesprov (opcional) ---
async function gesprovLookup(query) {
  if (!GESPROV_URL || !query) return null;
  try {
    const r = await fetch(`${GESPROV_URL}/api/gesprov/${encodeURIComponent(query)}`, { timeout: 5000 });
    if (!r.ok) return null;
    return r.json();
  } catch { return null; }
}

// --- Persistir evento ---
async function saveEvent(ev) {
  const q = `
    INSERT INTO tecnicos_eventos
      (message_id, chat_id, tecnico_numero, tecnico_nome, raw_text,
       tipo, cliente_nome, cliente_cpf, cliente_login,
       equipamento, fabricante, modelo, serial, mac, equip_anterior,
       observacoes, foto_filename, foto_mime, ai_raw_json, gesprov_cliente)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
    ON CONFLICT (message_id) DO NOTHING
    RETURNING id`;
  const vals = [
    ev.message_id, ev.chat_id, ev.tecnico_numero, ev.tecnico_nome, ev.raw_text,
    ev.tipo, ev.cliente_nome, ev.cliente_cpf, ev.cliente_login,
    ev.equipamento, ev.fabricante, ev.modelo, ev.serial, ev.mac, ev.equip_anterior,
    ev.observacoes, ev.foto_filename, ev.foto_mime, ev.ai_raw_json, ev.gesprov_cliente,
  ];
  const r = await pool.query(q, vals);
  return r.rows[0]?.id;
}

// --- Webhook handler ---
const app = express();
app.use(express.json({ limit: "30mb" }));
app.use(express.static("/app/painel")); // serve index.html em /

app.get("/health", (_req, res) => res.json({ ok: true, chat: CHAT_ID }));

app.get("/api/eventos", async (_req, res) => {
  try {
    const r = await pool.query(`
      SELECT id, received_at, tecnico_numero, tecnico_nome, raw_text, tipo,
             cliente_nome, cliente_cpf, cliente_login, equipamento, fabricante,
             modelo, serial, mac, equip_anterior, observacoes
      FROM tecnicos_eventos ORDER BY received_at DESC LIMIT 500`);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/export.csv", async (_req, res) => {
  try {
    const r = await pool.query(`
      SELECT id, received_at, tecnico_nome, tecnico_numero, tipo, cliente_nome, cliente_cpf, cliente_login,
             equipamento, fabricante, modelo, serial, mac, equip_anterior, observacoes, raw_text
      FROM tecnicos_eventos ORDER BY received_at DESC`);
    const cols = ["ID","Data/Hora","Tecnico","WhatsApp","Tipo","Cliente","CPF","Login PPPoE","Equipamento","Fabricante","Modelo","Serial","MAC","Equip.Anterior","Observacoes","Texto Original"];
    // Envolve em ="..." pra Excel tratar como texto literal (evita notacao cientifica em CPF/Serial/etc)
    const txt = (v) => {
      if (v == null || v === "") return "";
      const s = String(v).replace(/"/g, '""');
      return `="${s}"`;
    };
    const esc = (v) => {
      if (v == null) return "";
      const s = String(v).replace(/"/g, '""');
      return /[",\n;]/.test(s) ? `"${s}"` : s;
    };
    const fmt = (d) => d ? new Date(d).toLocaleString("pt-BR") : "";
    const truncate = (s, n=200) => (s && s.length > n ? s.slice(0, n) + "…" : s);
    const lines = [cols.join(";")];
    for (const row of r.rows) {
      const whatsapp = (row.tecnico_numero || "").replace(/@.*/, "");
      lines.push([
        row.id,                            // ID numerico ok
        fmt(row.received_at),              // data formatada texto
        esc(row.tecnico_nome),
        txt(whatsapp),                     // texto literal (numero grande)
        esc(row.tipo),
        esc(row.cliente_nome),
        txt(row.cliente_cpf),              // CPF como texto (senao vira E+10)
        esc(row.cliente_login),
        esc(row.equipamento),
        esc(row.fabricante),
        esc(row.modelo),
        txt(row.serial),                   // serial como texto
        txt(row.mac),                      // MAC como texto
        esc(row.equip_anterior),
        esc(row.observacoes),
        esc(truncate(row.raw_text, 300)),  // trunca pra nao virar gigante
      ].join(";"));
    }
    const csv = "﻿" + lines.join("\r\n"); // BOM UTF-8 pra Excel reconhecer acentos
    const filename = `instalacoes_${new Date().toISOString().slice(0,10)}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/webhook", async (req, res) => {
  res.json({ ok: true });
  const data = req.body || {};
  const event = data.event;
  const msg = data.data || data;
  const from = msg.from || msg.chatId || "";

  if (event !== "onmessage" && event !== "unreadmessages") return;
  if (from !== CHAT_ID) return; // so escuta o grupo alvo

  const messageId = msg.id || msg.messageId || `${from}_${msg.timestamp || Date.now()}`;
  const tecnicoNumero = msg.sender?.id?._serialized || msg.sender?.id || msg.author || "";
  const tecnicoNome = msg.sender?.pushname || msg.sender?.name || msg.notifyName || "";
  const mimetype = msg.mimetype || "";
  const hasMedia = !!msg.isMedia || !!msg.isMMS || msg.type === "image" || !!msg.mimetype;
  const isImage = hasMedia && mimetype.startsWith("image/");

  // Quando tem midia, o body eh base64 da imagem. A legenda vai em caption/content.
  let imageBase64 = null;
  let imageMime = null;
  let fotoFilename = null;
  let text = "";
  if (isImage) {
    imageMime = mimetype;
    imageBase64 = msg.body; // base64 da foto
    // Legenda vem em caption/content. NAO usar msg.text aqui porque frequentemente contem o proprio base64.
    text = msg.caption || msg.content || "";
    if (!imageBase64 || imageBase64.length < 500) {
      try {
        const dl = await wppCall("/download-media", { messageId });
        if (dl?.base64) imageBase64 = dl.base64;
      } catch (e) { console.error("download fail:", e.message); }
    }
    // Salvar foto em disco pra audit
    try {
      const fs = await import("node:fs/promises");
      await fs.mkdir("/app/fotos", { recursive: true });
      const ext = (mimetype.split("/")[1] || "jpg").split(";")[0];
      fotoFilename = `${Date.now()}_${messageId.replace(/[^a-zA-Z0-9]/g,"_").slice(0,40)}.${ext}`;
      await fs.writeFile(`/app/fotos/${fotoFilename}`, Buffer.from(imageBase64, "base64"));
      console.log(`[FOTO] salva /app/fotos/${fotoFilename} (${imageBase64.length}b)`);
    } catch (e) { console.error("save photo fail:", e.message); }
  } else {
    text = msg.body || msg.content || "";
  }

  console.log(`[MSG] ${tecnicoNumero} (${tecnicoNome}): text="${text.slice(0,80)}" image=${isImage} b64len=${imageBase64?.length||0}`);

  // so chama Gemini se tem foto OU texto com keyword
  const shouldProcess = isImage || /instala|troca|manuten|onu|ont|roteador/i.test(text);
  if (!shouldProcess) return;

  let ai = { raw: null, parsed: {} };
  try {
    ai = await geminiExtract({ text, imageBase64, imageMime });
  } catch (e) { console.error("gemini fail:", e.message); }

  const p = ai.parsed || {};

  // Gesprov lookup por CPF, login ou nome
  let gesprov = null;
  const query = p.cliente_cpf || p.cliente_login || p.cliente_nome;
  if (query) gesprov = await gesprovLookup(query);

  const ev = {
    message_id: messageId,
    chat_id: from,
    tecnico_numero: tecnicoNumero,
    tecnico_nome: tecnicoNome,
    raw_text: text,
    tipo: p.tipo || null,
    cliente_nome: p.cliente_nome || gesprov?.nome || null,
    cliente_cpf: p.cliente_cpf || gesprov?.cpf || null,
    cliente_login: p.cliente_login || null,
    equipamento: p.equipamento || null,
    fabricante: p.fabricante || null,
    modelo: p.modelo || null,
    serial: p.serial || null,
    mac: p.mac || null,
    equip_anterior: p.equip_anterior || null,
    observacoes: p.observacoes || null,
    foto_filename: fotoFilename,
    foto_mime: imageMime,
    ai_raw_json: ai.parsed,
    gesprov_cliente: gesprov,
  };

  try {
    const id = await saveEvent(ev);
    console.log(`[SAVED] id=${id} tipo=${ev.tipo} cliente=${ev.cliente_nome} modelo=${ev.modelo}`);

    if (REPLY_ON_GROUP && id) {
      const parts = [];
      parts.push(`✅ Registrado #${id}`);
      if (ev.tipo) parts.push(`Tipo: *${ev.tipo}*`);
      if (ev.cliente_nome) parts.push(`Cliente: ${ev.cliente_nome}`);
      if (ev.fabricante || ev.modelo) parts.push(`${[ev.fabricante, ev.modelo].filter(Boolean).join(" ")}`);
      if (ev.serial) parts.push(`SN: \`${ev.serial}\``);
      if (ev.mac) parts.push(`MAC: \`${ev.mac}\``);
      await wppSendText(CHAT_ID, parts.join("\n"));
    }
  } catch (e) { console.error("save fail:", e.message); }
});

app.listen(PORT, () => console.log(`tecnicos-bot worker listening on :${PORT}`));
