// Boletim diário de notícias do setor (construção, incorporação, loteamentos, condomínios).
// Sem banco e sem dependências: Node 20+. Lê feeds RSS, filtra por palavras-chave,
// (opcional) resume com OpenAI e envia no Telegram.
//
// Variáveis de ambiente:
//   TELEGRAM_BOT_TOKEN  token do bot (segredo)
//   TELEGRAM_CHAT_ID    chat que recebe o boletim
//   OPENAI_API_KEY      opcional; sem ela o boletim sai só com títulos e links
//
// Uso:
//   node noticias.mjs --pair      mostra o chat id (mande /start ao bot antes)
//   node noticias.mjs --dry       gera e imprime, sem enviar
//   node noticias.mjs             gera e envia
//   node noticias.mjs --hours 48  força a janela de notícias

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT = process.env.TELEGRAM_CHAT_ID || "";
const OPENAI = process.env.OPENAI_API_KEY || "";
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const argVal = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };

const OFF = 3 * 3600_000; // Natal/Fortaleza: UTC-3, sem horário de verão
const PER_FEED = 60;
const PICK_LOCAL = 6;
const PICK_BR = 6;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// A região é definida pela fonte, não pela IA.
const FEEDS = [
  { name: "g1 RN", url: "https://g1.globo.com/rss/g1/rn/rio-grande-do-norte/", scope: "local" },
  { name: "Tribuna do Norte", url: "https://tribunadonorte.com.br/feed/", scope: "local" },
  { name: "Agora RN", url: "https://agorarn.com.br/feed/", scope: "local" },
  { name: "CBIC", url: "https://cbic.org.br/feed/", scope: "br" },
  { name: "Agência Brasil", url: "https://agenciabrasil.ebc.com.br/rss/economia/feed.xml", scope: "br" },
  { name: "g1 Economia", url: "https://g1.globo.com/rss/g1/economia/", scope: "br" },
  { name: "InfoMoney", url: "https://www.infomoney.com.br/feed/", scope: "br" },
];

const KEYWORDS =
  /\b(construc|construtora|obras?|loteament|incorporac|incorporador|condomini|imobiliari|imove[il]|minha casa|mcmv|incc|habitac|moradia|pavimentac|drenagem|saneamento|terraplen|cimento|concreto|urbaniz|regularizacao fundiaria|plano diretor|engenharia|sinduscon|cbic|credito imobiliario|financiamento imobiliario|sbpe|fgts|licenciamento ambiental|alvara)/;

const norm = (s) =>
  s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

function decode(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ""; } })
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(+n); } catch { return ""; } })
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ").trim();
}

function parseRss(xml, name, scope) {
  const out = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    if (out.length >= PER_FEED) break;
    const b = m[1];
    const tag = (t) => { const r = b.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)); return r ? decode(r[1]) : ""; };
    const title = tag("title");
    const link = tag("link");
    const desc = tag("description").slice(0, 320);
    const ts = new Date(tag("pubDate")).getTime();
    if (!title || !/^https?:\/\//i.test(link) || !Number.isFinite(ts)) continue;
    out.push({ title, source: name, link, desc, ts, scope });
  }
  return out;
}

async function fetchFeed(f) {
  try {
    const r = await fetch(f.url, { headers: { "user-agent": UA, "accept-language": "pt-BR,pt;q=0.9" }, signal: AbortSignal.timeout(20000) });
    const items = r.ok ? parseRss(await r.text(), f.name, f.scope) : [];
    console.error(`${f.name}: HTTP ${r.status}, ${items.length} itens`);
    return items;
  } catch (e) {
    console.error(`${f.name}: erro ${String(e).slice(0, 100)}`);
    return [];
  }
}

// 25h nos dias úteis (boletim às 12h); segundas cobrem desde sexta às 12h (73h).
function windowHours() {
  const o = Number(argVal("--hours"));
  if (Number.isFinite(o) && o > 0) return Math.min(o, 168);
  return new Date(Date.now() - OFF).getUTCDay() === 1 ? 73 : 25;
}

async function collect(hours) {
  const flat = (await Promise.all(FEEDS.map(fetchFeed))).flat();
  const cutoff = Date.now() - hours * 3600_000;
  const matched = flat
    .filter((x) => x.ts >= cutoff && KEYWORDS.test(norm(x.title + " " + x.desc)))
    .sort((a, b) => b.ts - a.ts);
  const seen = new Set();
  const items = [];
  for (const it of matched) {
    const k = norm(it.title).slice(0, 70);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    items.push(it);
  }
  const local = items.filter((x) => x.scope === "local").slice(0, 30);
  const br = items.filter((x) => x.scope === "br").slice(0, 30);
  const all = [...local, ...br];
  all.forEach((it, i) => (it.i = i));
  console.error(`janela ${hours}h: ${flat.length} lidos, ${matched.length} com palavra-chave, ${all.length} candidatos`);
  return all;
}

async function curate(items) {
  if (!OPENAI || !items.length) return null;
  const payload = items.map((x) => ({ i: x.i, escopo: x.scope === "local" ? "RN" : "Brasil", titulo: x.title, fonte: x.source, trecho: x.desc || undefined }));
  const system =
    "Você é o editor de um boletim diário para um engenheiro civil do Rio Grande do Norte que atua com obras, loteamentos, condomínios, incorporação e obras públicas. " +
    "Receberá manchetes já pré-filtradas por palavras-chave (índice i, escopo, título, fonte, trecho opcional). Muitas não terão relação real com o setor. " +
    "Escolha apenas as que realmente interessam: construção civil, incorporação, loteamentos, condomínios, habitação (MCMV, FGTS), custos (INCC, materiais), crédito imobiliário, " +
    "regulação urbana/ambiental, obras públicas e infraestrutura (pavimentação, drenagem, saneamento). " +
    `Escolha até ${PICK_LOCAL} do escopo RN e até ${PICK_BR} do escopo Brasil, em ordem de relevância. Se menos do que isso for relevante, escolha menos; não complete a cota. ` +
    "Descarte: polícia e crimes, política partidária, esportes, religião, cultura e eventos, concursos de emprego, anúncios de imóveis à venda e qualquer coisa sem relação com o setor. " +
    "Se várias manchetes tratarem do mesmo fato, escolha só uma. " +
    "Para cada escolhida escreva 'resumo': 1 frase em português (máx. 180 caracteres) baseada APENAS no título e no trecho; não invente números, nomes, datas ou detalhes. " +
    "Não repita o título: se o trecho não acrescentar informação, devolva o resumo como string vazia. " +
    'Responda somente JSON no formato {"itens":[{"i":<indice>,"resumo":"<texto>"}]}. Se nada for relevante, devolva {"itens":[]}.';
  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.2,
        max_tokens: 2000,
        response_format: { type: "json_object" },
        messages: [{ role: "system", content: system }, { role: "user", content: JSON.stringify(payload) }],
      }),
      signal: AbortSignal.timeout(60000),
    });
    if (!r.ok) { console.error("OpenAI HTTP", r.status); return null; }
    const data = await r.json();
    const arr = JSON.parse(data.choices?.[0]?.message?.content ?? "{}").itens;
    const seen = new Set();
    const res = [];
    for (const x of Array.isArray(arr) ? arr : []) {
      if (!Number.isInteger(x?.i) || !items[x.i] || seen.has(x.i)) continue;
      seen.add(x.i);
      let resumo = typeof x.resumo === "string" ? x.resumo.trim().slice(0, 220) : "";
      if (norm(resumo).length < 15 || norm(resumo) === norm(items[x.i].title)) resumo = "";
      res.push({ i: x.i, resumo });
    }
    return res;
  } catch (e) {
    console.error("curadoria falhou:", String(e).slice(0, 100));
    return null;
  }
}

const fmt = (n, it, resumo) => `${n}. ${it.title} (${it.source})\n${resumo ? resumo + "\n" : ""}${it.link}`;

async function buildDigest() {
  const hours = windowHours();
  const span = hours > 30 ? "desde sexta" : "últimas 24h";
  const brt = new Date(Date.now() - OFF).toISOString();
  const head = `📰 Notícias do setor — ${brt.slice(8, 10)}/${brt.slice(5, 7)}`;
  const items = await collect(hours);
  if (!items.length) return `${head}\n\nNada sobre construção, incorporação, loteamentos ou condomínios nas fontes monitoradas (${span}).`;

  let picked = await curate(items);
  const noAI = picked === null;
  if (noAI) {
    picked = [
      ...items.filter((x) => x.scope === "local").slice(0, 4),
      ...items.filter((x) => x.scope === "br").slice(0, 4),
    ].map((x) => ({ i: x.i, resumo: "" }));
  }
  if (!picked.length) return `${head}\n\nNada relevante (${span}) para construção, incorporação, loteamentos e condomínios.`;

  const local = picked.filter((p) => items[p.i].scope === "local").slice(0, PICK_LOCAL);
  const br = picked.filter((p) => items[p.i].scope === "br").slice(0, PICK_BR);
  const blocks = [
    head,
    "📍 Rio Grande do Norte\n\n" + (local.length ? local.map((p, k) => fmt(k + 1, items[p.i], p.resumo)).join("\n\n") : `Nada relevante do RN (${span}).`),
    "🇧🇷 Brasil\n\n" + (br.length ? br.map((p, k) => fmt(k + 1, items[p.i], p.resumo)).join("\n\n") : `Nada relevante nacional (${span}).`),
    `Fontes: ${FEEDS.map((f) => f.name).join(", ")} · ${span}${noAI ? " · sem resumo (sem IA)" : ""}`,
  ];
  return blocks.join("\n\n――――――――――\n\n");
}

function chunk(text, max = 3800) {
  const parts = [];
  let cur = "";
  for (const para of text.split("\n\n")) {
    if ((cur + "\n\n" + para).length > max && cur) { parts.push(cur); cur = para; }
    else cur = cur ? cur + "\n\n" + para : para;
  }
  if (cur) parts.push(cur);
  return parts.map((p) => p.slice(0, 4000));
}

const tg = (m, body) =>
  fetch(`https://api.telegram.org/bot${TOKEN}/${m}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());

async function main() {
  if (has("--pair")) {
    if (!TOKEN) throw new Error("Defina TELEGRAM_BOT_TOKEN.");
    const r = await tg("getUpdates", { limit: 20 });
    const msgs = (r.result || []).filter((u) => u.message?.chat?.type === "private");
    if (!msgs.length) throw new Error("Nenhuma mensagem recebida: abra o bot, envie /start e rode de novo.");
    const m = msgs[msgs.length - 1].message;
    console.log(`Chat id: ${m.chat.id} (${m.from?.first_name ?? "?"}). Salve como TELEGRAM_CHAT_ID.`);
    return;
  }
  const text = await buildDigest();
  if (has("--dry")) { console.log(text); return; }
  if (!TOKEN || !CHAT) throw new Error("Defina TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID.");
  for (const part of chunk(text)) {
    const r = await tg("sendMessage", { chat_id: CHAT, text: part, disable_web_page_preview: true });
    if (!r.ok) throw new Error("Telegram recusou: " + JSON.stringify(r).slice(0, 200));
  }
  console.error("Enviado.");
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
