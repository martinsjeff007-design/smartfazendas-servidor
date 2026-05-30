// ============================================================
//  SmartFazendas — Servidor WhatsApp (API Oficial da Meta)
// ============================================================
const express = require("express");
const app = express();
app.use(express.json());

const CONFIG = {
  PORTA:             process.env.PORT              || 8080,
  CLAUDE_API_KEY:    process.env.CLAUDE_API_KEY,
  META_TOKEN:        process.env.META_TOKEN,
  META_PHONE_ID:     process.env.META_PHONE_ID,
  META_VERIFY_TOKEN: process.env.META_VERIFY_TOKEN || "smartfazendas2026",
  META_WABA_ID:      process.env.META_WABA_ID      || "1343670474335810",
};

// Versão da Graph API da Meta (estável em 2026)
const GRAPH_VERSION = "v23.0";

// ------------------------------------------------------------
//  Personalidade do agente (ajuste à vontade)
// ------------------------------------------------------------
const PROMPT_SISTEMA = `Você é o assistente virtual da SmartFazendas, uma corretora especializada em propriedades rurais (fazendas, sítios e terras agrícolas).

Seu papel:
- Atender clientes interessados em comprar, vender ou arrendar propriedades rurais.
- Responder dúvidas com simpatia, objetividade e linguagem simples.
- Qualificar o interesse: descobrir se a pessoa quer comprar/vender/arrendar, a região de interesse, o tamanho aproximado (hectares) e a faixa de orçamento.
- Quando o cliente demonstrar interesse real, coletar nome e dizer que um corretor entrará em contato.

Regras:
- Seja breve. Respostas de WhatsApp são curtas (2 a 4 frases).
- Não invente propriedades, preços ou dados que você não tem. Se não souber, diga que vai verificar com um corretor.
- Mantenha o foco em assuntos de imóveis rurais. Não atue como assistente de uso geral.
- Responda sempre em português do Brasil.`;

// ------------------------------------------------------------
//  1) Verificação do webhook (GET) — usado uma vez pela Meta
// ------------------------------------------------------------
app.get("/webhook/meta", (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === CONFIG.META_VERIFY_TOKEN) {
    console.log("✅ Webhook verificado pela Meta!");
    return res.status(200).send(challenge);
  }
  console.log("❌ Falha na verificação do webhook (token incorreto)");
  return res.sendStatus(403);
});

// ------------------------------------------------------------
//  2) Recebimento de mensagens (POST) — o coração do bot
// ------------------------------------------------------------
app.post("/webhook/meta", async (req, res) => {
  // Responde 200 imediatamente para a Meta não reenviar o evento
  res.sendStatus(200);

  try {
    const value   = req.body?.entry?.[0]?.changes?.[0]?.value;
    const mensagem = value?.messages?.[0];

    // Eventos de status (entregue/lido) não têm "messages" — ignoramos
    if (!mensagem) {
      console.log("ℹ️ Evento sem mensagem (status/leitura) — ignorado");
      return;
    }

    // Por enquanto só tratamos texto
    if (mensagem.type !== "text") {
      const de = mensagem.from;
      await enviarWhatsApp(de, "Por enquanto eu só consigo ler mensagens de texto. Pode me escrever sua dúvida? 😊");
      return;
    }

    const de    = mensagem.from;            // número de quem enviou
    const texto = mensagem.text.body;       // conteúdo da mensagem
    console.log(`📩 Mensagem de ${de}: ${texto}`);

    const resposta = await chamarClaude(texto);
    await enviarWhatsApp(de, resposta);
    console.log(`📤 Resposta enviada para ${de}`);

  } catch (erro) {
    console.error("🔥 Erro ao processar webhook:", erro.message);
  }
});

// ------------------------------------------------------------
//  Chama a API do Claude
// ------------------------------------------------------------
async function chamarClaude(mensagem) {
  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         CONFIG.CLAUDE_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model:      "claude-sonnet-4-6",   // troque por "claude-haiku-4-5-20251001" se quiser mais barato/rápido
        max_tokens: 1000,
        system:     PROMPT_SISTEMA,
        messages:   [{ role: "user", content: mensagem }],
      }),
    });

    const dados = await resp.json();

    if (dados.error) {
      console.error("🔥 Erro Claude:", JSON.stringify(dados.error));
      return "Desculpe, tive um probleminha técnico aqui. Pode repetir, por favor?";
    }
    return dados.content[0].text;

  } catch (erro) {
    console.error("🔥 Erro ao chamar Claude:", erro.message);
    return "Desculpe, tive um probleminha técnico aqui. Pode repetir, por favor?";
  }
}

// ------------------------------------------------------------
//  Envia mensagem pelo WhatsApp (Graph API da Meta)
// ------------------------------------------------------------
async function enviarWhatsApp(para, texto) {
  try {
    const resp = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${CONFIG.META_PHONE_ID}/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": `Bearer ${CONFIG.META_TOKEN}`,
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to:   para,
          type: "text",
          text: { body: texto },
        }),
      }
    );

    const dados = await resp.json();
    if (dados.error) {
      console.error("🔥 Erro ao enviar WhatsApp:", JSON.stringify(dados.error));
    }
    return dados;

  } catch (erro) {
    console.error("🔥 Erro de rede ao enviar WhatsApp:", erro.message);
  }
}

// ------------------------------------------------------------
//  Rota de configuração (rodar UMA vez): inscreve o app na
//  conta do WhatsApp para as mensagens chegarem no webhook.
//  Abrir no navegador: .../assinar-waba
// ------------------------------------------------------------
app.get("/assinar-waba", async (req, res) => {
  try {
    const resp = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${CONFIG.META_WABA_ID}/subscribed_apps`,
      {
        method: "POST",
        headers: { "Authorization": `Bearer ${CONFIG.META_TOKEN}` },
      }
    );
    const dados = await resp.json();
    console.log("Resultado assinar-waba:", JSON.stringify(dados));
    res.json(dados);
  } catch (erro) {
    console.error("Erro ao assinar WABA:", erro.message);
    res.status(500).json({ erro: erro.message });
  }
});

// ------------------------------------------------------------
//  Rota de saúde (abrir no navegador para ver se está no ar)
// ------------------------------------------------------------
app.get("/", (req, res) => res.send("SmartFazendas online! ✅"));

app.listen(CONFIG.PORTA, () => {
  console.log(`🚜 SmartFazendas rodando na porta ${CONFIG.PORTA}`);
});
