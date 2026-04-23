require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());

const {
  AZURE_OPENAI_ENDPOINT,
  AZURE_OPENAI_KEY,
  AZURE_OPENAI_DEPLOYMENT,
  AZURE_OPENAI_API_VERSION,
  LIVE_AVATAR_API_KEY,
} = process.env;

const LLM_URL = `${AZURE_OPENAI_ENDPOINT}/openai/deployments/${AZURE_OPENAI_DEPLOYMENT}/chat/completions?api-version=${AZURE_OPENAI_API_VERSION}`;
const LIVE_AVATAR_BASE = 'https://api.liveavatar.com';
const DEFAULT_AVATAR_ID = '513fd1b7-7ef9-466d-9af2-344e51eeb833';

const MENU_FILE = path.join(__dirname, 'menu.txt');
const ORDERS_DIR = path.join(__dirname, 'orders');
if (!fs.existsSync(ORDERS_DIR)) fs.mkdirSync(ORDERS_DIR);

// Load menu from file — re-read on each request so edits take effect without restart
function loadMenu() {
  try {
    return fs.readFileSync(MENU_FILE, 'utf8');
  } catch {
    return 'Menu file not found.';
  }
}

function buildSystemPrompt() {
  return `You are OrderBuddy, a friendly and efficient fast-food ordering assistant.

MENU (loaded from menu.txt):
${loadMenu()}

The user message will include the current cart state as JSON followed by the customer's spoken request.
You MUST always respond with ONLY valid JSON — no extra text, no markdown, no code fences.
Response format:
{
  "speech": "<friendly spoken response to the customer>",
  "cart": [
    { "item": "<item name>", "qty": <number>, "size": "<sm|md|lg|null>", "mods": ["<mod>"], "price": <unit price as number> }
  ]
}

Rules:
- Keep the full cart on every response — include all items the customer has ordered so far
- Only include items that are on the menu
- "size" is null for burgers; use "sm", "md", or "lg" for fries, shakes, drinks
- "price" is the per-unit price from the menu
- When the cart is empty return "cart": []
- When the customer says "that's all", "checkout", or "place my order", read back the full order with subtotal and total (including 7% tax) in "speech", and keep cart unchanged`;
}

// Write order to orders/order_<id>.txt
function writeOrderFile(orderId, cart) {
  const TAX = 0.07;
  const subtotal = cart.reduce((s, i) => s + i.price * i.qty, 0);
  const tax = subtotal * TAX;
  const total = subtotal + tax;
  const now = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });

  const itemLines = cart.length === 0
    ? '  (no items yet)\n'
    : cart.map((item) => {
        const label = [item.qty + 'x', item.size || '', item.item, item.mods?.length ? `(${item.mods.join(', ')})` : '']
          .filter(Boolean).join(' ');
        const price = `$${(item.price * item.qty).toFixed(2)}`;
        return `  ${label.padEnd(36, '.')} ${price}`;
      }).join('\n') + '\n';

  const content = [
    `ORDER #${orderId}`,
    `Date: ${now}`,
    ``,
    `ITEMS`,
    `────────────────────────────────────────`,
    itemLines.trimEnd(),
    ``,
    `────────────────────────────────────────`,
    `  Subtotal: $${subtotal.toFixed(2)}`,
    `  Tax (7%): $${tax.toFixed(2)}`,
    `  TOTAL:    $${total.toFixed(2)}`,
    `────────────────────────────────────────`,
  ].join('\n');

  fs.writeFileSync(path.join(ORDERS_DIR, `order_${orderId}.txt`), content, 'utf8');
}

app.use(express.static(path.join(__dirname, '.')));

// ── Menu endpoint ──
app.get('/menu', (_req, res) => {
  res.type('text/plain').send(loadMenu());
});

// ── Order file endpoints ──
app.get('/order/:id', (req, res) => {
  const file = path.join(ORDERS_DIR, `order_${req.params.id}.txt`);
  if (!fs.existsSync(file)) return res.status(404).send('Order not found');
  res.type('text/plain').send(fs.readFileSync(file, 'utf8'));
});

// ── LiveAvatar session endpoint ──
app.post('/liveavatar-session', async (req, res) => {
  const avatarId = req.body.avatar_id || DEFAULT_AVATAR_ID;
  try {
    const tokenResp = await fetch(`${LIVE_AVATAR_BASE}/v1/sessions/token`, {
      method: 'POST',
      headers: { 'X-API-KEY': LIVE_AVATAR_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'FULL', avatar_id: avatarId, avatar_persona: {} }),
    });
    const tokenData = await tokenResp.json();
    if (!tokenResp.ok || !tokenData?.data?.session_token) {
      console.error('LiveAvatar token error:', tokenData);
      return res.status(500).json({ error: 'Failed to create session token', detail: tokenData });
    }
    const { session_token, session_id } = tokenData.data;

    const startResp = await fetch(`${LIVE_AVATAR_BASE}/v1/sessions/start`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${session_token}`, 'Content-Type': 'application/json' },
    });
    const startData = await startResp.json();
    if (!startResp.ok || !startData?.data?.livekit_url) {
      console.error('LiveAvatar start error:', startData);
      return res.status(500).json({ error: 'Failed to start session', detail: startData });
    }

    const { livekit_url, livekit_client_token } = startData.data;
    res.json({ livekit_url, livekit_client_token, session_id });
  } catch (err) {
    console.error('LiveAvatar session error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── LiveAvatar stop endpoint ──
app.post('/liveavatar-stop', async (req, res) => {
  const { session_id } = req.body;
  if (!session_id) return res.status(400).json({ error: 'session_id required' });
  try {
    const resp = await fetch(`${LIVE_AVATAR_BASE}/v1/sessions/stop`, {
      method: 'POST',
      headers: { 'X-API-KEY': LIVE_AVATAR_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id, reason: 'USER_CLOSED' }),
    });
    res.json(await resp.json());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── LLM + cart + file write endpoint ──
app.post('/openai/complete', async (req, res) => {
  try {
    const { prompt, cart, order_id } = req.body;
    const userMessage = `Current cart: ${JSON.stringify(cart || [])}\n\nCustomer says: ${prompt}`;

    const response = await fetch(LLM_URL, {
      method: 'POST',
      headers: { 'api-key': AZURE_OPENAI_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: buildSystemPrompt() },
          { role: 'user', content: userMessage },
        ],
        temperature: 0.4,
      }),
    });

    if (!response.ok) {
      console.error('Azure OpenAI error:', await response.text());
      return res.status(500).send('LLM request failed');
    }

    const data = await response.json();
    const raw = data.choices[0].message.content.trim();

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const cleaned = raw.replace(/^```json\s*/i, '').replace(/```$/, '').trim();
      parsed = JSON.parse(cleaned);
    }

    const newCart = parsed.cart || cart || [];

    // Write order to disk whenever we have an order_id
    if (order_id) {
      writeOrderFile(order_id, newCart);
    }

    res.json({ text: parsed.speech, cart: newCart });
  } catch (error) {
    console.error('Error in /openai/complete:', error);
    res.status(500).send('Error processing request');
  }
});

// ── Clear order ──
app.post('/order/clear', (req, res) => {
  const { order_id } = req.body;
  if (order_id) writeOrderFile(order_id, []);
  res.json({ cart: [] });
});

app.listen(3000, () => console.log('OrderBuddy running on http://localhost:3000'));
