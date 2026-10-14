// Strategic Aluminum Reserve — ATL BitLab buys your empty cans for sats.
// We pay 50% of COMEX melt value and pocket the spread. Test sats only (MutinyNet).
import http from "node:http";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";

const PORT = Number(process.env.PORT || 8080);
const VOLTAGE = process.env.VOLTAGE_BIN || `${process.env.HOME}/.local/bin/voltage`;
const WALLET = process.env.VOLTAGE_WALLET || ""; // MutinyNet wallet UUID; payouts disabled when empty
const ORG = process.env.VOLTAGE_ORG || "";
const ENV = process.env.VOLTAGE_ENV || "";
let walletNetwork = null; // must be "mutinynet" before any payout
const BUYBACK = 0.5; // the racket
const MAX_GRAMS = 60;
const RESERVE_BUDGET_SATS = Number(process.env.RESERVE_BUDGET_SATS || 2000);

let market = { aluminumUsdPerTonne: null, btcUsd: null, fetchedAt: 0 };
const quotes = new Map(); // id -> { grams, sats, status, paidAt, error }
const ledger = { cans: 0, grams: 0, satsPaid: 0, meltValueUsd: 0 };

async function refreshMarket() {
  if (Date.now() - market.fetchedAt < 60_000) return market;
  const [al, btc] = await Promise.all([
    fetch("https://query1.finance.yahoo.com/v8/finance/chart/ALI=F?range=1d&interval=1d", {
      headers: { "User-Agent": "Mozilla/5.0 strategic-aluminum-reserve" },
    }).then((r) => r.json()),
    fetch("https://mempool.space/api/v1/prices").then((r) => r.json()),
  ]);
  market = {
    aluminumUsdPerTonne: al.chart.result[0].meta.regularMarketPrice,
    btcUsd: btc.USD,
    fetchedAt: Date.now(),
  };
  return market;
}

function price(grams) {
  const meltUsd = (grams / 1e6) * market.aluminumUsdPerTonne;
  const offerUsd = meltUsd * BUYBACK;
  const sats = Math.max(1, Math.round((offerUsd / market.btcUsd) * 1e8));
  return { meltUsd, offerUsd, sats, spreadUsd: meltUsd - offerUsd };
}

// Minimal BOLT11 HRP check: signet/MutinyNet only (lntbs), returns amount in sats or null.
function invoiceSats(inv) {
  const m = /^lntbs(\d+)?([munp])?1/.exec(inv.toLowerCase());
  if (!m) return { error: "Only MutinyNet/signet invoices (lntbs...) accepted. No mainnet, nice try." };
  if (!m[1]) return { sats: null };
  const mult = { m: 1e5, u: 100, n: 0.1, p: 0.0001 }[m[2]] ?? 1e8;
  return { sats: Number(m[1]) * mult };
}

function pay(invoice, id) {
  return new Promise((resolve) => {
    execFile(
      VOLTAGE,
      ["payments", "send", "--org", ORG, "--env", ENV, "--wallet", WALLET, "--currency", "btc", "--invoice", invoice, "--id", id, "--wait", "completed", "--json", "--yes", "--timeout", "45"],
      { timeout: 60_000 },
      (err, stdout, stderr) => {
        let out = null;
        try { out = JSON.parse(stdout); } catch {}
        resolve({ ok: !err && out && !out.error, out, err: err ? (stderr || err.message).slice(0, 300) : null });
      },
    );
  });
}

const json = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

async function body(req) {
  let s = "";
  for await (const c of req) { s += c; if (s.length > 10_000) break; }
  try { return JSON.parse(s || "{}"); } catch { return {}; }
}

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/slides")) {
      const file = url.pathname === "/" ? "index.html" : "slides.html";
      const html = await readFile(new URL(file, import.meta.url)).catch(() => null);
      if (!html) return json(res, 404, { error: "not found" });
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(html);
    }
    if (req.method === "GET" && url.pathname === "/api/market") {
      await refreshMarket();
      return json(res, 200, { ...market, buyback: BUYBACK, perCan: price(14.9), ledger, payoutsEnabled: Boolean(WALLET) && walletNetwork === "mutinynet", reserveRemaining: RESERVE_BUDGET_SATS - ledger.satsPaid });
    }
    if (req.method === "POST" && url.pathname === "/api/quote") {
      await refreshMarket();
      const { grams } = await body(req);
      const g = Math.min(MAX_GRAMS, Math.max(0, Number(grams) || 0));
      if (g < 1) return json(res, 400, { error: "That's not aluminum. That's air." });
      const p = price(g);
      const id = randomUUID();
      quotes.set(id, { grams: g, sats: p.sats, status: "open", createdAt: Date.now() });
      return json(res, 200, { id, grams: g, ...p });
    }
    if (req.method === "POST" && url.pathname === "/api/redeem") {
      const { id, invoice } = await body(req);
      const q = quotes.get(id);
      if (!q) return json(res, 404, { error: "Unknown quote. The Reserve does not negotiate." });
      if (q.status !== "open") return json(res, 409, { error: `Quote already ${q.status}.`, status: q.status });
      if (Date.now() - q.createdAt > 5 * 60_000) { q.status = "expired"; return json(res, 410, { error: "Quote expired. Aluminum moves fast." }); }
      const inv = String(invoice || "").trim();
      const parsed = invoiceSats(inv);
      if (parsed.error) return json(res, 400, { error: parsed.error });
      if (parsed.sats !== q.sats) return json(res, 400, { error: `Invoice must be for exactly ${q.sats} sats (got ${parsed.sats ?? "no amount"}).` });
      if (!WALLET || walletNetwork !== "mutinynet") return json(res, 503, { error: "Reserve treasury offline (Voltage wallet not configured). No sats sent." });
      if (ledger.satsPaid + q.sats > RESERVE_BUDGET_SATS) return json(res, 503, { error: "The Reserve is tapped out." });
      q.status = "paying"; // single-flight: second redeem gets 409
      const r = await pay(inv, randomUUID());
      if (r.ok) {
        q.status = "paid";
        ledger.cans += Math.round(q.grams / 14.9) || 1;
        ledger.grams += q.grams;
        ledger.satsPaid += q.sats;
        ledger.meltValueUsd += price(q.grams).meltUsd;
        return json(res, 200, { status: "paid", sats: q.sats, payment: r.out?.data?.id ?? null });
      }
      q.status = "failed";
      return json(res, 502, { error: "Payout failed. The aluminum stays with us anyway.", detail: r.err || r.out?.error?.message });
    }
    json(res, 404, { error: "not found" });
  } catch (e) {
    if (res.headersSent) return res.end();
    json(res, 500, { error: String(e.message || e) });
  }
}).listen(PORT, "127.0.0.1", () => console.log(`Strategic Aluminum Reserve on http://127.0.0.1:${PORT}`));

// Safety: confirm the payout wallet is MutinyNet before enabling the treasury.
if (WALLET) {
  execFile(VOLTAGE, ["wallets", "get", WALLET, "--org", ORG, "--env", ENV, "--json"], (err, stdout) => {
    try { walletNetwork = JSON.parse(stdout).data.network; } catch {}
    console.log(`Treasury wallet network: ${walletNetwork} -> payouts ${walletNetwork === "mutinynet" ? "ENABLED" : "DISABLED"}`);
  });
}
