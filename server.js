const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

const CONFIG = {
  CLAUDE_API_KEY: process.env.CLAUDE_API_KEY || "sua-chave-aqui",
  META_TOKEN: process.env.META_TOKEN || "",
  META_PHONE_ID: process.env.META_PHONE_ID || "",
  META_VERIFY_TOKEN: process.env.META_VERIFY_TOKEN || "smartfazendas2026",
  PORTA: process.env.PORT || 3000,
};

const DB_FILE = path.join("/tmp", "propriedades.json");

const PROPRIEDADES_DEFAULT = {
  "554796932487": {
    corretor: "João Silva",
    instancia: "Jeferson",
    propriedades: [
      {
        id: 1,
        nome: "Fazenda Boa Vista",
        tamanho: "320 hectares",
        preco: "R$ 4.800.000",
        pagamento: "À vista com desconto ou financiamento em até 60x",
        solo: "Solo argiloso de alta fertilidade, apto para soja, milho e pecuária",
        infraestrutura: "Casa sede, 2 represas, energia elétrica, curral completo, galpão de 800m²",
        localizacao: "Município de Rondonópolis - MT, a 45 km da cidade, asfalto até a porteira",
        mostrarLocalizacao: true,
        ativa: true,
      },
    ],
  },
};

function carregarPropriedades() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const data = fs.readFileSync(DB_FILE, "utf8");
      return JSON.parse(data);
    }
  } catch (err) {
    console.error("Erro ao carregar propriedades:", err.message);
  }
  return PROPRIEDADES_DEFAULT;
}

function salvarPropriedades(dados) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(dados, null, 2), "utf8");
  } catch (err) {
    console.error("Erro ao salvar propriedades:", err.message);
  }
}

let PROPRIEDADES = carregarPropriedades();
const historico = {};

async function enviarMensagemMeta(numeroDestino, texto) {
  console.log("Enviando via Meta API para:", numeroDestino);
  const resp = await axios.post(
    `https://graph.facebook.com/v18.0/${CONFIG.META_PHONE_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to: numeroDestino,
      type: "text",
      text: { body: texto },
    },
    {
      headers: {
        Authorization: `Bearer ${CONFIG.META_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );
  console.log("Mensagem enviada via Meta! Status:", resp.status);
}

async function chamarAgente(mensagens, propriedade, nomeCorretor) {
  console.log("Chamando Claude API...");
  const response = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      system: `Você é o assistente de atendimento de WhatsApp do corretor rural ${nomeCorretor}. Responda como se fosse o próprio ${nomeCorretor} digitando — de forma natural, direta e humana, sem formalidades excessivas. Use linguagem simples, do jeito que um corretor experiente fala no dia a dia.

PROPRIEDADE:
Nome: ${propriedade.nome}
Tamanho: ${propriedade.tamanho}
Preço: ${propriedade.preco}
Formas de pagamento: ${propriedade.pagamento}
Solo e aptidão: ${propriedade.solo}
Infraestrutura: ${propriedade.infraestrutura}
${propriedade.mostrarLocalizacao
  ? `Localização e acesso: ${propriedade.localizacao}`
  : `Localização: INFORMAÇÃO PROTEGIDA — Se perguntado, explique com naturalidade que a localização exata é passada só na hora de agendar a visita.`}

REGRAS:
- Nunca use emojis. Nenhum.
- Frases curtas e diretas, como no WhatsApp
- Não use saudações formais a cada mensagem
- Responda só o que foi perguntado
- Nunca invente dados que não estejam acima
- Se o cliente quiser falar com o corretor, colete nome e melhor horário`,
      messages: mensagens,
    },
    {
      headers: {
        "x-api-key": CONFIG.CLAUDE_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
    }
  );
  console.log("Claude respondeu!");
  return response.data.content[0].text;
}

// Webhook Meta - verificação
app.get("/webhook/meta", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === CONFIG.META_VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Webhook Meta - receber mensagens
app.post("/webhook/meta", async (req, res) => {
  res.sendStatus(200);
  try {
    const body = req.body;
    if (body.object !== "whatsapp_business_account") return;
    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const messages = value?.messages;
    if (!messages || messages.length === 0) return;

    const msg = messages[0];
    if (msg.type !== "text") return;

    const numeroCliente = msg.from;
    const textoRecebido = msg.text?.body || "";

    console.log("Mensagem de:", numeroCliente, "->", textoRecebido);

    const corretorConfig = Object.values(PROPRIEDADES)[0];
    if (!corretorConfig) return;

    const chave = `meta:${numeroCliente}`;
    if (!historico[chave]) historico[chave] = [];

    let propriedade = historico[chave].propriedade;
    if (!propriedade) {
      propriedade = corretorConfig.propriedades.find(p => p.ativa) || corretorConfig.propriedades[0];
      historico[chave].propriedade = propriedade;
    }

    historico[chave].push({ role: "user", content: textoRecebido });
    const mensagensParaAPI = historico[chave].filter(m => m.role).slice(-20);

    const resposta = await chamarAgente(mensagensParaAPI, propriedade, corretorConfig.corretor);
    historico[chave].push({ role: "assistant", content: resposta });

    await enviarMensagemMeta(numeroCliente, resposta);
    console.log("Resposta enviada:", resposta.substring(0, 100));

  } catch (err) {
    console.error("Erro no webhook Meta:", err.message);
    if (err.response) {
      console.error("Detalhes:", err.response.status, JSON.stringify(err.response.data));
    }
  }
});

app.post("/chat", async (req, res) => {
  try {
    const { mensagens, propriedade, nomeCorretor } = req.body;
    const resposta = await chamarAgente(mensagens, propriedade, nomeCorretor);
    res.json({ resposta });
  } catch (err) {
    console.error("Erro no chat:", err.message);
    res.status(500).json({ erro: err.message });
  }
});

app.get("/propriedades/:instancia", (req, res) => {
  const { instancia } = req.params;
  const config = Object.values(PROPRIEDADES).find(c => c.instancia === instancia);
  if (!config) return res.status(404).json({ erro: "Instância não encontrada" });
  res.json({ corretor: config.corretor, propriedades: config.propriedades });
});

app.get("/", (req, res) => {
  res.json({ status: "SmartFazendas online", versao: "2.0.0" });
});

app.listen(CONFIG.PORTA, () => {
  console.log(`SmartFazendas rodando na porta ${CONFIG.PORTA}`);
});
