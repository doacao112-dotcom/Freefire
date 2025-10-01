// server.js (SkalePay) — UTMify intacto

import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import crypto from 'node:crypto';

/* =========================
   Utils
========================= */
function toUtcString(d = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}
function getClientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  return (typeof xf === 'string' && xf.split(',')[0].trim()) || req.socket?.remoteAddress || '0.0.0.0';
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* =========================
   CALLBACK (postback)
========================= */
// Use seu domínio público aqui se quiser fixar. Para teste local com ngrok, troque esta constante.
const HARDCODED_CALLBACK = 'https://freefire.up.railway.app/webhooks/skalepay';

function normalizeCallbackUrl(raw) {
  if (!raw) return null;
  let url = raw.trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  url = url.replace(/\/+$/, '');
  if (!/\/webhooks\/skalepay$/i.test(url)) url += '/webhooks/skalepay';
  return url;
}
const CALLBACK_URL =
  normalizeCallbackUrl(HARDCODED_CALLBACK) ||
  normalizeCallbackUrl(process.env.PUBLIC_CALLBACK_URL);
if (!CALLBACK_URL) throw new Error('Callback URL inválida');

/* =========================
   App & Middlewares
========================= */
const app = express();

// CORS básico sem depender de lib
const allowed = (process.env.CORS_ORIGINS || '*')
  .split(',')
  .map(s => s.trim().replace(/\/$/, ''))
  .filter(Boolean);

app.use((req, res, next) => {
  const origin = (req.headers.origin || '').replace(/\/$/, '');
  res.header('Vary', 'Origin, Access-Control-Request-Headers');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS');

  if (allowed.includes('*')) {
    res.header('Access-Control-Allow-Origin', '*');
  } else if (origin && allowed.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(helmet());
app.use(express.json({ limit: '1mb' }));
app.use(rateLimit({ windowMs: 60_000, max: 60 }));

/* =========================
   "DB" simples (memória)
========================= */
const db = new Map(); // donationId -> registro

/* =========================
   SkalePay
========================= */
const SKALE_BASE = 'https://api.conta.skalepay.com.br/v1';
const SKALE_SECRET =
  process.env.SKALEPAY_SECRET ||
  'sk_live_v2hotIe7Vy330iHD9HvBrNJYPOXgQC6qSABvfpVBtB'; // fallback só p/ teste
const SKALE_AUTH_HEADER = 'Basic ' + Buffer.from(`${SKALE_SECRET}:x`).toString('base64');

async function skaleCreateTransaction({ amount, items, customer, postbackUrl }) {
  const payload = {
    paymentMethod: 'pix',
    amount,              // em centavos
    items,
    customer,
    postbackUrl: postbackUrl ?? CALLBACK_URL,
  };

  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = await fetch(`${SKALE_BASE}/transactions`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: SKALE_AUTH_HEADER,
      },
      body: JSON.stringify(payload),
    });
    const raw = await r.text();
    if (process.env.DEBUG_SKALEPAY === '1') {
      console.log(`[SkalePay][create][TRY ${attempt}]`, r.status, raw);
    }

    if (r.ok) {
      const data = JSON.parse(raw);
      return parseSkaleCreateResponse(data);
    }

    lastErr = new Error(`SkalePay create ${r.status}: ${raw}`);
    if (r.status >= 500 && attempt < 3) {
      await sleep(attempt * 1000);
      continue;
    }
    break;
  }
  throw lastErr;
}

function parseSkaleCreateResponse(data) {
  const transactionId = data?.id ?? data?.secureId ?? null;
  const status = data?.status ?? null;
  const secureUrl = data?.secureUrl ?? null;

  const pix = data?.pix || {};
  const copyPaste = typeof pix.qrcode === 'string' ? pix.qrcode : null; // EMV
  const qrCodeUrl = null; // Skale normalmente não envia imagem/URL do QR
  const expiresAt = pix?.expirationDate ?? null;

  if (!transactionId || (!copyPaste && !secureUrl)) {
    throw new Error(`Resposta SkalePay sem dados úteis: ${JSON.stringify(data)}`);
  }
  return { transactionId, status, secureUrl, copyPaste, qrCodeUrl, expiresAt };
}

async function skaleGetStatus(transactionId) {
  const r = await fetch(`${SKALE_BASE}/transactions/${transactionId}`, {
    method: 'GET',
    headers: { Accept: 'application/json', Authorization: SKALE_AUTH_HEADER },
  });
  const raw = await r.text();
  if (process.env.DEBUG_SKALEPAY === '1') console.log('[SkalePay][status]', r.status, raw);
  if (!r.ok) throw new Error(`SkalePay status ${r.status}: ${raw}`);
  const data = JSON.parse(raw);
  return data?.status ?? null; // waiting_payment | paid | refused | ...
}

/* =========================
   UTMify (inalterado)
========================= */
async function sendUtmifyOrder({
  apiToken,
  orderId,
  platform = 'produto teste',
  paymentMethod = 'pix',
  status, // 'waiting_payment' | 'paid'
  createdAtUtc,
  approvedDateUtc = null,
  amountInCents,
  transactionId,
  utm = null,
  isTest = false,
  customerEmail = 'anon@donations.local',
  customerIp = '0.0.0.0',
}) {
  const endpoint = 'https://api.utmify.com.br/api-credentials/orders';
  const body = {
    orderId,
    platform,
    paymentMethod,
    status,
    createdAt: createdAtUtc,
    approvedDate: approvedDateUtc,
    refundedAt: null,
    customer: {
      name: 'Doação Anônima',
      email: customerEmail,
      phone: null,
      document: null,
      country: 'BR',
      ip: customerIp,
    },
    products: [
      {
        id: transactionId,
        name: 'Doação',
        planId: 'doacao_unica',
        planName: 'Doação Única',
        quantity: 1,
        priceInCents: amountInCents,
      },
    ],
    trackingParameters: {
      src: null,
      sck: null,
      utm_source: utm?.source ?? null,
      utm_campaign: utm?.campaign ?? null,
      utm_medium: utm?.medium ?? null,
      utm_content: utm?.content ?? null,
      utm_term: utm?.term ?? null,
    },
    commission: {
      totalPriceInCents: amountInCents,
      gatewayFeeInCents: 0,
      userCommissionInCents: amountInCents,
    },
    isTest,
  };
  if (process.env.DEBUG_UTMIFY === '1') console.log('[UTMify][REQ]', JSON.stringify(body, null, 2));
  const r = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-token': apiToken },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (process.env.DEBUG_UTMIFY === '1') console.log('[UTMify][RES]', r.status, text);
  if (!r.ok) throw new Error(`UTMify ${r.status}: ${text}`);
}

/* =========================
   Rotas
========================= */
app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.get('/debug/skalepay-auth', (_req, res) => {
  const preview = (process.env.SKALEPAY_SECRET || '').slice(0, 10) || 'fallback_used';
  res.json({ ok: true, auth: 'basic', secretPreview: preview + '...' });
});

app.get('/debug/donations', (_req, res) => {
  const items = [];
  for (const [id, r] of db.entries()) {
    items.push({
      donationId: id,
      status: r.status,
      amount: r.amount,
      skalepayTxId: r.skalepayTxId,
      createdAtUtc: r.createdAtUtc,
    });
  }
  res.json({ count: items.length, items });
});

app.post('/debug/utmify-ping', async (req, res) => {
  try {
    const orderId = `debug_${crypto.randomUUID()}`;
    await sendUtmifyOrder({
      apiToken: process.env.UTMIFY_API_TOKEN,
      orderId,
      status: 'waiting_payment',
      createdAtUtc: toUtcString(),
      amountInCents: 100,
      transactionId: 'tx_debug',
      utm: { source: 'debug', medium: 'local', campaign: 'ping' },
      isTest: true,
      customerEmail: 'anon@donations.local',
      customerIp: getClientIp(req),
    });
    res.json({ ok: true, orderId });
  } catch (e) {
    res.status(502).json({ ok: false, error: String(e.message || e) });
  }
});

// Criar doação (PIX via SkalePay)
app.post('/donations', async (req, res) => {
  try {
    const amount = Number(req.body?.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: 'amount inválido' });
    }

    const utm = req.body?.utm || null;
    const donationId = crypto.randomUUID();
    const externalId = `donation_${donationId}`;
    const createdAtUtc = toUtcString();

    // Itens
    const items = [
      {
        title: 'Doação',
        unitPrice: Math.round(amount * 100),
        quantity: 1,
        tangible: false,
      },
    ];

    // Customer: aceita do body; senão usa default com CPF válido (sintático).
    const rawCustomer =
      req.body?.customer ?? {
        name: 'Cliente Teste',
        email: 'cliente@teste.com',
        phone: '11999999999',
        document: { type: 'cpf', number: '15350946056' },
      };
    // normaliza CPF -> somente dígitos
    const cpfDigits = String(rawCustomer?.document?.number ?? '').replace(/\D/g, '');
    const customer = {
      ...rawCustomer,
      document: { type: 'cpf', number: cpfDigits },
    };

    if (process.env.DEBUG_SKALEPAY === '1') {
      console.log(
        '[SkalePay][payload]',
        JSON.stringify(
          {
            amount: Math.round(amount * 100),
            items,
            customer,
            postbackUrl: CALLBACK_URL,
          },
          null,
          2
        )
      );
    }

    // Cria transação
    const tx = await skaleCreateTransaction({
      amount: Math.round(amount * 100),
      items,
      customer,
      postbackUrl: CALLBACK_URL,
    });

    // Salva no "DB"
    db.set(donationId, {
      amount,
      status: tx.status === 'paid' ? 'paid' : 'pending',
      skalepayTxId: tx.transactionId,
      qrCodeUrl: tx.qrCodeUrl ?? null,
      copyPaste: tx.copyPaste ?? null,
      secureUrl: tx.secureUrl ?? null,
      utm,
      createdAtUtc,
    });

    // UTMify -> waiting_payment (assíncrono, não bloqueia resposta)
    sendUtmifyOrder({
      apiToken: process.env.UTMIFY_API_TOKEN,
      orderId: externalId,
      status: 'waiting_payment',
      createdAtUtc,
      amountInCents: Math.round(amount * 100),
      transactionId: tx.transactionId,
      utm,
      isTest: false,
      customerEmail: 'anon@donations.local',
      customerIp: getClientIp(req),
    }).catch(e => console.error('UTMify waiting_payment error:', e?.message || e));

    res.status(201).json({
      donationId,
      transactionId: tx.transactionId,
      secureUrl: tx.secureUrl,
      copyPaste: tx.copyPaste,
      qrCodeUrl: tx.qrCodeUrl ?? null,
      expiresAt: tx.expiresAt ?? null,
      status: 'waiting_payment',
    });
  } catch (e) {
    console.error('POST /donations error:', e);
    res.status(502).json({ error: String(e.message || e) });
  }
});

// Consultar doação
app.get('/donations/:id', (req, res) => {
  const row = db.get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json({
    donationId: req.params.id,
    status: row.status,
    amount: row.amount,
    secureUrl: row.secureUrl ?? null,
    qrCodeUrl: row.qrCodeUrl ?? null,
    copyPaste: row.copyPaste ?? null,
  });
});

// Webhook SkalePay (marca pago quando status === 'paid')
app.post('/webhooks/skalepay', async (req, res) => {
  try {
    const ev = req.body || {};
    const txId = ev?.id || ev?.secureId || ev?.transactionId;
    if (!txId) return res.status(400).json({ error: 'payload sem id', received: ev });

    let donationId = null;
    let row = null;
    for (const [id, rec] of db.entries()) {
      if (rec.skalepayTxId === txId) {
        donationId = id;
        row = rec;
        break;
      }
    }
    if (!row) return res.status(404).json({ error: 'donation not found', received: ev });

    if (ev.status === 'paid' && row.status !== 'paid') {
      row.status = 'paid';
      db.set(donationId, row);
      // UTMify -> paid
      sendUtmifyOrder({
        apiToken: process.env.UTMIFY_API_TOKEN,
        orderId: `donation_${donationId}`,
        status: 'paid',
        createdAtUtc: row.createdAtUtc,
        approvedDateUtc: toUtcString(),
        amountInCents: Math.round(row.amount * 100),
        transactionId: row.skalepayTxId,
        utm: row.utm,
        isTest: false,
        customerEmail: 'anon@donations.local',
        customerIp: '0.0.0.0',
      }).catch(e => console.error('UTMify paid error:', e?.message || e));
    }
    res.json({ received: true });
  } catch (e) {
    console.error('Webhook error:', e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Sincronizar status manualmente
app.post('/donations/:id/sync', async (req, res) => {
  try {
    const row = db.get(req.params.id);
    if (!row?.skalepayTxId) return res.status(404).json({ error: 'not found' });

    const st = await skaleGetStatus(row.skalepayTxId);
    if (st === 'paid' && row.status !== 'paid') {
      row.status = 'paid';
      db.set(req.params.id, row);
      await sendUtmifyOrder({
        apiToken: process.env.UTMIFY_API_TOKEN,
        orderId: `donation_${req.params.id}`,
        status: 'paid',
        createdAtUtc: row.createdAtUtc,
        approvedDateUtc: toUtcString(),
        amountInCents: Math.round(row.amount * 100),
        transactionId: row.skalepayTxId,
        utm: row.utm,
        isTest: false,
        customerEmail: 'anon@donations.local',
        customerIp: '0.0.0.0',
      });
    }
    res.json({ donationId: req.params.id, status: row.status, skalepay: st });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

/* =========================
   Start
========================= */
const PORT = process.env.PORT || 10000;
const server = app.listen(PORT, () => console.log(`API up on :${PORT}`));

process.on('SIGTERM', () => {
  console.log('SIGTERM recebido, encerrando...');
  server.close(() => process.exit(0));
});
process.on('SIGINT', () => {
  console.log('SIGINT recebido, encerrando...');
  server.close(() => process.exit(0));
});
process.on('unhandledRejection', err => console.error('Unhandled rejection:', err));
process.on('uncaughtException', err => console.error('Uncaught exception:', err));
