// index.js
require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const http = require('http');
const https = require('https');

// Config (env override)
const WEBHOOK = process.env.discordwebhook;
const PORT = parseInt(process.env.PORT, 10) || 3000;
if (!WEBHOOK) {
  console.error('Missing environment variable: discordwebhook');
  process.exit(1);
}

const MIN_CONCURRENT = parseInt(process.env.MIN_CONCURRENT, 10) || 5;
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT, 10) || 60;
let concurrency = parseInt(process.env.MAX_CONCURRENT, 10) || 20; // starting point
const TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT_MS, 10) || 5000;
const TOKEN_RATE = parseFloat(process.env.TOKENS_PER_SEC, 10) || 200; // tokens per second
const MAX_TOKENS = parseInt(process.env.MAX_TOKENS, 10) || 500;

// Keep-alive agents shared across requests
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: MAX_CONCURRENT });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: MAX_CONCURRENT });

function getAgent(url) {
  return url.startsWith('https') ? httpsAgent : httpAgent;
}

// Simple token-bucket rate limiter
let tokens = MAX_TOKENS;
let lastRefill = Date.now();
function refillTokens() {
  const now = Date.now();
  const delta = (now - lastRefill) / 1000;
  if (delta <= 0) return;
  tokens = Math.min(MAX_TOKENS, tokens + delta * TOKEN_RATE);
  lastRefill = now;
}
function consumeToken(cost = 1) {
  refillTokens();
  if (tokens >= cost) {
    tokens -= cost;
    return true;
  }
  return false;
}

// Webhook queue worker with retries and exponential backoff
const webhookQueue = [];
let webhookWorkerRunning = false;
async function webhookWorker() {
  if (webhookWorkerRunning) return;
  webhookWorkerRunning = true;
  while (webhookQueue.length > 0) {
    const item = webhookQueue.shift();
    let attempt = 0;
    const maxAttempts = 5;
    while (attempt < maxAttempts) {
      try {
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), 5000);
        await fetch(WEBHOOK, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: item }),
          signal: ac.signal,
          agent: getAgent(WEBHOOK)
        });
        clearTimeout(t);
        break; // success
      } catch (err) {
        attempt++;
        const backoff = Math.pow(2, attempt) * 250; // ms
        await new Promise(res => setTimeout(res, backoff));
      }
    }
  }
  webhookWorkerRunning = false;
}
function enqueueWebhook(content) {
  webhookQueue.push(content);
  webhookWorker().catch(() => {});
}

// Helper: abortable fetch with timeout
async function fetchWithTimeout(url, opts = {}, ms = TIMEOUT_MS) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    const res = await fetch(url, { ...opts, signal: ac.signal, agent: getAgent(url) });
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// Random group id generator but biased toward lower ranges where groups are more likely
function randomGroupId() {
  // Mix strategy: 70% sample from lower ranges, 30% from full range
  if (Math.random() < 0.7) {
    // older groups (more likely to exist) - 7,000,000 .. 50,000,000
    return Math.floor(Math.random() * (50000000 - 7000000 + 1)) + 7000000;
  }
  return Math.floor(Math.random() * (999999999 - 9999999 + 1)) + 9999999;
}

// Check group via official API only
async function checkGroup(id) {
  const url = `https://groups.roblox.com/v1/groups/${id}`;
  try {
    if (!consumeToken()) {
      // not enough tokens - brief sleep
      await new Promise(r => setTimeout(r, 50));
      return null;
    }
    const res = await fetchWithTimeout(url, { method: 'GET', headers: { 'User-Agent': 'group-scanner/1' } }, TIMEOUT_MS);
    if (!res.ok) {
      // handle 404, 429 etc.
      if (res.status === 429) {
        // if rate limited by Roblox, wait longer
        await new Promise(r => setTimeout(r, 1000));
      }
      return null;
    }
    const j = await res.json();
    // If the response has owner field and publicEntryAllowed
    if ('owner' in j && j.owner === null && j.publicEntryAllowed === true) {
      return { hit: true, id };
    }
    return { hit: false, id };
  } catch (err) {
    return null;
  }
}

// Worker loop: each worker runs forever until process exits
let stopFlag = false;
async function workerLoop(workerId) {
  while (!stopFlag) {
    const id = randomGroupId();
    const start = Date.now();
    const r = await checkGroup(id);
    const duration = Date.now() - start;
    recordLatency(duration);
    if (r && r.hit) {
      const link = `https://www.roblox.com/groups/group.aspx?gid=${r.id}`;
      console.log(`[HIT] ${r.id}`);
      enqueueWebhook(link);
    }
    // tiny yield so loop doesn't spin too tight
    await new Promise(r => setTimeout(r, 0));
  }
}

// Latency tracking + auto-tune concurrency
const latencySamples = [];
function recordLatency(ms) {
  latencySamples.push(ms);
  if (latencySamples.length > 200) latencySamples.shift();
}
function median(arr) {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}
// Periodically adjust concurrency between MIN_CONCURRENT and MAX_CONCURRENT
setInterval(() => {
  const med = median(latencySamples);
  if (med === 0) return;
  // if median latency low (<200ms) increase concurrency, else decrease
  if (med < 250 && concurrency < MAX_CONCURRENT) {
    concurrency = Math.min(MAX_CONCURRENT, Math.floor(concurrency * 1.15) + 1);
    console.log('Auto-tune: increasing concurrency to', concurrency);
  } else if (med > 600 && concurrency > MIN_CONCURRENT) {
    concurrency = Math.max(MIN_CONCURRENT, Math.floor(concurrency * 0.85));
    console.log('Auto-tune: decreasing concurrency to', concurrency);
  }
  // Reconfigure agent maxSockets
  httpAgent.maxSockets = Math.max(httpAgent.maxSockets, concurrency);
  httpsAgent.maxSockets = Math.max(httpsAgent.maxSockets, concurrency);
}, 5000);

// Start worker pool manager
let workerPromises = [];
async function startWorkers() {
  stopFlag = false;
  // spawn initial workers up to current concurrency
  while (workerPromises.length < concurrency) {
    const id = workerPromises.length;
    const p = workerLoop(id);
    workerPromises.push(p);
  }
  // watch and respawn if concurrency increases
  (async function monitor() {
    while (!stopFlag) {
      if (workerPromises.length < concurrency) {
        const toSpawn = concurrency - workerPromises.length;
        for (let i = 0; i < toSpawn; i++) {
          const p = workerLoop(workerPromises.length + i);
          workerPromises.push(p);
        }
      }
      // Trim if concurrency decreased - we allow existing workers to exit by setting stopFlag and restarting
      await new Promise(r => setTimeout(r, 1000));
    }
  })();
}

// Express app for Render.com binding and health
const app = express();
app.get('/', (req, res) => res.send('group-scanner running'));
app.get('/health', (req, res) => res.json({ ok: true, concurrency, queueLength: webhookQueue.length }));

const server = app.listen(PORT, () => {
  console.log(`Listening on port ${PORT}`);
  startWorkers().catch(err => console.error(err));
});

process.on('SIGINT', async () => shutdown('SIGINT'));
process.on('SIGTERM', async () => shutdown('SIGTERM'));

async function shutdown(sig) {
  console.log('Shutting down', sig);
  stopFlag = true;
  // wait a short grace for webhook queue
  const shutdownStart = Date.now();
  while (webhookQueue.length > 0 && Date.now() - shutdownStart < 5000) {
    await new Promise(r => setTimeout(r, 200));
  }
  server.close(() => process.exit(0));
}
