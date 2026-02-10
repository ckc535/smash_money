/**
 * provider.on("block") → getBlockWithTransactions + getTransactionReceipt.
 * Lọc OrdersMatched (topic2) + conditionId, ghi tx-events-log.json.
 * Chạy: npx tsx src/log-tx-events.ts
 */

import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { ethers } from "ethers";

const fsPromises = fs.promises;
dotenv.config();

process.on("unhandledRejection", (r, p) => { console.error("[unhandledRejection]", r); });
process.on("uncaughtException", (e) => { console.error("[uncaughtException]", e); });

// --- config ---
const POLYGON_WSS = process.env.POLYGON_WSS || "wss://polygon-mainnet.g.alchemy.com/v2/UfHs23_J0v1h157mRpdDk";
const WATCH_ADDRESS = "0xE3f18aCc55091e2c48d883fc8C8413319d4Ab7b0";
const WATCH_LOWER = WATCH_ADDRESS.toLowerCase();
const TOPIC2_ADDRESS = "0x6031B6eed1C97e853c6e0F03Ad3ce3529351F96d";
const TOPIC0_MATCHED = "0xd0a08e8c493f9c94f29311604c9de1b4e8c8d4c06bd0c789af57f2d65bfec0f6";
const TOPIC0_CONDITION = "0x2e6bb91f8cbcda0c93623c54d0403a43514fabc40084ec96b6d5379a74786298";
const LOG_FILE = path.join(process.cwd(), "tx-events-log.json");
const RECONNECT_MS = 5000;
const KEEPALIVE_MS = 2 * 60 * 1000;
const MAX_SEEN = 300_000;

// --- state ---
let logEntries: MatchedEntry[] = [];
let writePromise = Promise.resolve();
let lastBlock = 0;
let reconnecting = false;
let provider: ethers.providers.WebSocketProvider | null = null;
const seenTx = new Set<string>();
const seenOrder: string[] = [];

interface MatchedEntry {
  txHash: string;
  blockNumber: number;
  assetId: string;
  amountUsdc: string;
  sharesSize: string;
  price: number;
  conditionId: string;
  timestamp: string;
}

function topic2IsAddr(topic: string, addr: string): boolean {
  if (!topic || topic.length < 66) return false;
  return topic.toLowerCase().slice(-40) === addr.toLowerCase().replace(/^0x/, "");
}

function parseData(data: string): { assetId: string; amountUsdc: number; sharesSize: number; price: number } | null {
  if (!data || data === "0x") return null;
  const hex = data.startsWith("0x") ? data.slice(2) : data;
  const chunks: string[] = [];
  for (let i = 0; i < hex.length; i += 64) chunks.push("0x" + hex.slice(i, i + 64));
  if (chunks.length < 4) return null;
  const assetId = chunks[1].toLowerCase();
  const amountUsdc = Number(ethers.BigNumber.from(chunks[2]));
  const sharesSize = Number(ethers.BigNumber.from(chunks[3]));
  return { assetId, amountUsdc, sharesSize, price: sharesSize ? Math.round((amountUsdc / sharesSize) * 100) / 100 : 0 };
}

/** Từ receipt.logs lấy conditionId (event TOPIC0_CONDITION) và các log OrdersMatched (topic2 = TOPIC2_ADDRESS), parse → entries. */
function processReceipt(receipt: ethers.providers.TransactionReceipt, blockTs: number): MatchedEntry[] {
  const logs = receipt.logs;
  const condLog = logs.find((l) => (l.topics[0] || "").toLowerCase() === TOPIC0_CONDITION && l.topics[3]);
  const conditionId = condLog
    ? (condLog.topics[3]!.startsWith("0x") ? condLog.topics[3]! : "0x" + condLog.topics[3]!).toLowerCase()
    : null;
  if (!conditionId) return [];

  const matched = logs.filter(
    (l) => (l.topics[0] || "").toLowerCase() === TOPIC0_MATCHED && l.topics[2] && topic2IsAddr(l.topics[2], TOPIC2_ADDRESS)
  );
  const entries: MatchedEntry[] = [];
  const ts = new Date(blockTs * 1000).toISOString();

  for (const log of matched) {
    const p = parseData(log.data);
    if (!p) continue;
    entries.push({
      txHash: receipt.transactionHash,
      blockNumber: receipt.blockNumber,
      assetId: ethers.utils.formatUnits(p.assetId, 6).replace(".", ""),
      amountUsdc: ethers.utils.formatUnits(p.amountUsdc, 6),
      sharesSize: ethers.utils.formatUnits(p.sharesSize, 6),
      price: p.price,
      conditionId,
      timestamp: ts,
    });
  }

  // merge cùng tx+conditionId+assetId+price
  const byKey = new Map<string, MatchedEntry[]>();
  for (const e of entries) {
    const k = [e.txHash, e.conditionId, e.assetId, e.price].join("|");
    const list = byKey.get(k) ?? [];
    list.push(e);
    byKey.set(k, list);
  }
  const out: MatchedEntry[] = [];
  for (const list of byKey.values()) {
    const f = list[0]!;
    if (list.length === 1) { out.push(f); continue; }
    let am = 0, sh = 0;
    for (const e of list) { am += Number(e.amountUsdc); sh += Number(e.sharesSize); }
    out.push({ ...f, amountUsdc: String(Math.round(am * 100) / 100), sharesSize: String(Math.round(sh * 100) / 100) });
  }
  return out;
}

function markSeen(txHash: string) {
  const h = txHash.toLowerCase();
  if (seenTx.has(h)) return;
  seenTx.add(h);
  seenOrder.push(h);
  while (seenOrder.length > MAX_SEEN) seenTx.delete(seenOrder.shift()!);
}

function append(entries: MatchedEntry[]) {
  if (!entries.length) return;
  logEntries.push(...entries);
  writePromise = writePromise.then(() => fsPromises.writeFile(LOG_FILE, JSON.stringify(logEntries, null, 2), "utf8")).catch((e) => console.error("Write error:", e));
}

function loadLog() {
  try {
    const raw = fs.readFileSync(LOG_FILE, "utf8").trim();
    if (!raw) { logEntries = []; return; }
    logEntries = raw.startsWith("[") ? JSON.parse(raw) : raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    logEntries = [];
  }
}

/** 1 block: getBlockWithTransactions → lọc tx to WATCH_ADDRESS → getTransactionReceipt từng tx → processReceipt → append. */
async function processBlock(prov: ethers.providers.WebSocketProvider, blockNum: number): Promise<void> {
  const block = await prov.getBlockWithTransactions(blockNum);
  if (!block?.transactions?.length) return;
  console.log("[processBlock]", blockNum, "txs", block.transactions.length);
  return

  const txs = block.transactions.filter((tx) => tx.to && (tx.to as string).toLowerCase() === WATCH_LOWER);
  if (!txs.length) return;

  const receipts = await Promise.all(txs.map((tx) => prov.getTransactionReceipt(tx.hash)));
  const ts = block.timestamp;

  for (const rec of receipts) {
    if (!rec || rec.status !== 1 || seenTx.has(rec.transactionHash.toLowerCase())) continue;
    const entries = processReceipt(rec, ts);
    if (!entries.length) continue;
    markSeen(rec.transactionHash);
    append(entries);
  }
}

function setup(prov: ethers.providers.WebSocketProvider) {
  provider = prov;
  prov.removeAllListeners();

  prov.on("error", (e) => console.error("[WS error]", e?.message ?? e));
  prov.on("close", (code, reason) => { 
    provider = null;
    console.error("[WS closed]", code, reason?.toString() ?? "", "— reconnect", RECONNECT_MS / 1000, "s");
    prov.removeAllListeners();
    if (!reconnecting) {
      reconnecting = true;
      setTimeout(() => void reconnect(), RECONNECT_MS);
    }
  });

  let chain = Promise.resolve();
  prov.on("block", (blockNum: number) => {
    lastBlock = blockNum;
    chain = chain.then(() => processBlock(prov, blockNum)).catch((e) => console.error("Block", blockNum, e));
  });
}

async function reconnect() {
  console.log("[Reconnect] ...");
  try {
    const prov = new ethers.providers.WebSocketProvider(POLYGON_WSS);
    const cur = await prov.getBlockNumber();
    if (lastBlock > 0 && cur > lastBlock) {
      for (let b = lastBlock + 1; b <= cur; b++) {
        try { await processBlock(prov, b); lastBlock = b; } catch (e) { console.error("Catch-up", b, e); }
      }
    }
    lastBlock = cur;
    setup(prov);
    console.log("[Reconnect] OK, block", cur);
  } catch (e) {
    console.error("[Reconnect]", e);
    setTimeout(() => void reconnect(), RECONNECT_MS);
    return;
  } finally {
    reconnecting = false;
  }
}

export async function startListen(): Promise<void> {
  const prov = new ethers.providers.WebSocketProvider(POLYGON_WSS);
  console.log("[Listen] WS:", POLYGON_WSS, "| Watch:", WATCH_ADDRESS, "->", LOG_FILE);

  try {
    lastBlock = await prov.getBlockNumber();
    console.log("[Listen] Block:", lastBlock);
  } catch (e) {
    console.error("[Listen]", e);
    setTimeout(startListen, RECONNECT_MS);
    return;
  }

  loadLog();
  setInterval(() => console.log("[alive]", new Date().toISOString(), "block", lastBlock), KEEPALIVE_MS);
  setup(prov);
}

// Chạy: npx tsx src/log-tx-events.ts
if ((typeof require !== "undefined" && require.main === module) || process.argv[1]?.includes("log-tx-events")) {
  startListen().catch((e) => { console.error(e); process.exit(1); });
}
