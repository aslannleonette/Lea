// Ouve o Telegram (rodado a cada ~5 min pelo GitHub Actions) e entrega o digest
// quando você tocar no botão "📰 Notícias agora" ou mandar /noticias.
// Só atende o chat configurado em TELEGRAM_CHAT_ID.
import { spawnSync } from "node:child_process";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT = String(process.env.TELEGRAM_CHAT_ID || "");
if (!TOKEN || !CHAT) {
  console.error("Falta TELEGRAM_BOT_TOKEN ou TELEGRAM_CHAT_ID");
  process.exit(1);
}

const BOTAO = "📰 Notícias agora";
const TECLADO = { keyboard: [[{ text: BOTAO }]], resize_keyboard: true, is_persistent: true };

async function api(metodo, corpo = {}) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${metodo}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(corpo),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(`${metodo}: ${j.description}`);
  return j.result;
}

const enviar = (text, extra = {}) => api("sendMessage", { chat_id: CHAT, text, ...extra });

async function main() {
  const updates = await api("getUpdates", { timeout: 0, allowed_updates: ["message"] });
  if (!updates.length) return console.log("Nenhuma mensagem nova.");

  // Confirma tudo no Telegram antes de agir, para não repetir o pedido no próximo ciclo.
  const ultimo = Math.max(...updates.map((u) => u.update_id));
  await api("getUpdates", { offset: ultimo + 1, timeout: 0 });

  const textos = updates
    .map((u) => u.message)
    .filter((m) => m && String(m.chat?.id) === CHAT && typeof m.text === "string")
    .map((m) => m.text.trim());
  console.log(`${updates.length} atualização(ões); ${textos.length} do seu chat.`);

  const quer = textos.some((t) => t === BOTAO || /^\/noticias(@\w+)?$/i.test(t));
  const inicio = textos.some((t) => /^\/start(@\w+)?$/i.test(t));

  if (inicio) {
    await api("setMyCommands", { commands: [{ command: "noticias", description: "Receber as notícias agora" }] });
    await enviar(
      "Olá! Eu mando o resumo de notícias do setor todo dia às 12:00.\nPara pedir na hora, toque em “📰 Notícias agora” (a resposta leva até uns 5 minutos).",
      { reply_markup: TECLADO },
    );
  }

  if (quer) {
    await enviar("Buscando as notícias… 🔎", { reply_markup: TECLADO });
    const r = spawnSync(process.execPath, ["noticias.mjs"], { stdio: "inherit", env: process.env });
    if (r.status !== 0) {
      await enviar("Não consegui montar o resumo agora. Tente de novo daqui a pouco.");
      process.exit(r.status || 1);
    }
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
