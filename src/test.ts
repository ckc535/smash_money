import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import { createClient } from "redis";
import { ClobClient, Side, OrderType, TickSize, UserOrder } from "@polymarket/clob-client";
import { Wallet } from "ethers";
import dotenv from "dotenv";

dotenv.config();

const DRY_RUN = process.env.DRY_RUN !== "false";
const SLUG_FILTER = "btc-updown-15m";
const GET_MARKET_CONCURRENCY = 10;
const PAY_CONCURRENCY = 5;
const ORDER_DUPLICATE_TTL_SECONDS = 15 * 60; // 15 phút
const WEBSOCKET_RECONNECT_DELAY = 5000; // 5 giây
// https://polygon-mainnet.g.alchemy.com/v2/UfHs23_J0v1h157mRpdDk
let provider = new ethers.providers.WebSocketProvider("wss://polygon-mainnet.g.alchemy.com/v2/XYYgx0YBjlQoRD6Oruftb");

const contractAbi = fs.readFileSync(path.join(__dirname, "abi", "abi.js"), "utf8");
const contractAddress = "0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e";
const MAKER_FILTER = "0x6031B6eed1C97e853c6e0F03Ad3ce3529351F96d".toLowerCase();
let contract = new ethers.Contract(contractAddress, contractAbi, provider);
const iface = new ethers.utils.Interface(contractAbi);

/** Topic0 của event chứa conditionId (giống log-tx-events.ts) */
const TOPIC0_CONDITION = "0x2e6bb91f8cbcda0c93623c54d0403a43514fabc40084ec96b6d5379a74786298";

type DecodedLog = { name: string; args: Record<string, string> };
type TxData = { allEventsInTx: DecodedLog[]; conditionId: string };
type EventRow = {
  transactionHash: string;
  blockNumber: number;
  blockHash: string;
  logIndex: number;
  transactionIndex: number;
  orderHash: string;
  maker: string;
  taker: string;
  assetId: string;
  usdcAmount: string;
  shareAmount: string;
  fee: string;
  conditionId: string;
  price: string;
};

const txEventsCache = new Map<string, TxData>();
const assetIdToConditionId = new Map<string, string>();

// Queue để gom events theo block
let eventQueue: EventRow[] = [];
let currentBlockNumber: number | null = null;
let queueTimer: NodeJS.Timeout | null = null;
let queueStartTime: number | null = null; // Thời điểm event đầu tiên vào queue
const QUEUE_TIMEOUT_MS = 200; // 0.5 giây


// Redis client
const redisClient = createClient({
  url: process.env.REDIS_URL || "redis-10932.crce194.ap-seast-1-1.ec2.cloud.redislabs.com:10932",
});

redisClient.on("error", (err: Error) => console.error("[Redis] Error:", err));

// Types từ index.ts
type MarketOutcomeInfo = {
  tokenId: string;
  price: number;
  tickSize: number;
  negRisk: boolean;
  winner?: boolean;
};

interface MarketResult {
  market: Record<string, MarketOutcomeInfo>;
  slug: string;
}

function toStr(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "object" && v !== null && "toString" in v) return String((v as { toString(): string }).toString());
  return String(v);
}

/** Lấy conditionId từ receipt.logs (giống log-tx-events.ts): log có topic0 = TOPIC0_CONDITION, conditionId = topics[3]. */
function getConditionIdFromReceipt(receipt: ethers.providers.TransactionReceipt): string {
  const condLog = receipt.logs?.find((l) => (l.topics[0] || "").toLowerCase() === TOPIC0_CONDITION && l.topics[3]);
  if (!condLog?.topics[3]) return "";
  const raw = condLog.topics[3];
  return (raw.startsWith("0x") ? raw : "0x" + raw).toLowerCase();
}

/** Retry getTransactionReceipt với 5 lần thử */
async function getTransactionReceiptWithRetry(txHash: string, maxRetries = 5): Promise<ethers.providers.TransactionReceipt | null> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const receipt = await provider.getTransactionReceipt(txHash);
      return receipt;
    } catch (err) {
      const error = err as { code?: number; message?: string };
      if (attempt < maxRetries) {
        console.log(`[getTransactionReceipt] Retry ${attempt}/${maxRetries} for txHash ${txHash}: ${error.message || error.code || err}`);
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt)); // Exponential backoff
      } else {
        console.error(`[getTransactionReceipt] Failed after ${maxRetries} attempts for txHash ${txHash}:`, error.message || error.code || err);
        return null;
      }
    }
  }
  return null;
}

/** Lấy tất cả event + conditionId trong cùng 1 giao dịch; cache theo txHash. */
async function getTxData(txHash: string): Promise<TxData> {
  const cached = txEventsCache.get(txHash);
  if (cached) return cached;

  const receipt = await getTransactionReceiptWithRetry(txHash);
  const conditionId = receipt ? getConditionIdFromReceipt(receipt) : "";

  const allEventsInTx: DecodedLog[] = [];
  if (receipt?.logs) {
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== contractAddress.toLowerCase()) continue;
      try {
        const parsed = iface.parseLog(log);
        if (parsed) {
          const args: Record<string, string> = {};
          for (const [k, v] of Object.entries(parsed.args)) {
            if (typeof k === "string" && !/^\d+$/.test(k)) args[k] = toStr(v);
          }
          allEventsInTx.push({ name: parsed.name, args });
        }
      } catch {
        allEventsInTx.push({ name: "Unknown", args: { data: log.data, topics: (log.topics ?? []).join(",") } });
      }
    }
  }
  const data: TxData = { allEventsInTx, conditionId };
  txEventsCache.set(txHash, data);
  return data;
}

// Functions từ index.ts
async function getClobClient(): Promise<ClobClient> {
  const HOST = "https://clob.polymarket.com";
  const CHAIN_ID = 137;
  const signer = new Wallet(process.env.PRIVATE_KEY!);
  const baseClient = new ClobClient(HOST, CHAIN_ID, signer);
  const userApiCreds = await baseClient.deriveApiKey();
  return new ClobClient(
    HOST,
    CHAIN_ID,
    signer,
    userApiCreds,
    1,
    "0x2765B2B2DD655169a9D34E21fd80229fEbF4dc7F"
  );
}

/** Chỉ trả về market khi market_slug include SLUG_FILTER */
async function getMarket(client: ClobClient, conditionId: string): Promise<MarketResult | null> {
  const market = await client.getMarket(conditionId);
  const slug = (market?.market_slug ?? market?.slug ?? "") as string;
  if (!slug.includes(SLUG_FILTER)) return null;
  const tickSize = 0.01;
  const negRisk = market?.neg_risk ?? false;
  const data: Record<string, MarketOutcomeInfo> = {};
  for (const token of market?.tokens ?? []) {
    const t = token as { token_id: string; outcome: string; price: number; winner?: boolean };
    data[t.outcome] = {
      tokenId: t.token_id,
      price: t.price,
      tickSize,
      negRisk,
      winner: t.winner,
    };
  }
  return { market: data, slug };
}

function normalizeTokenId(id: string): string {
  const s = String(id).trim();
  if (s.includes(".")) return s.split(".")[0] ?? s;
  if (s.startsWith("0x")) return BigInt(s).toString();
  return s;
}

function getOutcomeForAssetId(market: Record<string, MarketOutcomeInfo>, assetId: string): string | null {
  const normalized = normalizeTokenId(assetId);
  for (const [outcome, info] of Object.entries(market)) {
    if (normalizeTokenId(info.tokenId) === normalized) return outcome;
  }
  return null;
}

function roundPrice(p: number): number {
  return Math.round(Number(p) * 100) / 100;
}


/** Key để check duplicate order: txHash + logIndex + usdcAmount + shareAmount */
function getOrderDuplicateKey(txHash: string, logIndex: number, usdcAmount: string, shareAmount: string): string {
  return `order:dup:${txHash}:${logIndex}:${usdcAmount}:${shareAmount}`;
}

/** Kiểm tra xem order đã tồn tại chưa (trong 15 phút) */
async function isOrderDuplicate(txHash: string, logIndex: number, usdcAmount: string, shareAmount: string): Promise<boolean> {
  const key = getOrderDuplicateKey(txHash, logIndex, usdcAmount, shareAmount);
  const exists = await redisClient.exists(key);
  return exists === 1;
}

/** Ghi order vào Redis với expire 15 phút để chống duplicate */
async function markOrderAsProcessed(txHash: string, logIndex: number, usdcAmount: string, shareAmount: string): Promise<void> {
  const key = getOrderDuplicateKey(txHash, logIndex, usdcAmount, shareAmount);
  await redisClient.setEx(key, ORDER_DUPLICATE_TTL_SECONDS, "1");
}

/** Ghi event vào Redis (chỉ lưu key với expire 15 phút để check duplicate) */
async function saveEventToRedis(event: EventRow): Promise<void> {
  const key = `event:${event.transactionHash}:${event.logIndex}`;
  await redisClient.setEx(key, ORDER_DUPLICATE_TTL_SECONDS, "1");
}

/** Xử lý queue events */
async function flushQueue(): Promise<void> {
  if (eventQueue.length === 0) return;
  const eventsToProcess = [...eventQueue];
  eventQueue = [];
  currentBlockNumber = null;
  queueStartTime = null;
  if (queueTimer) {
    clearTimeout(queueTimer);
    queueTimer = null;
  }
  await processEvents(eventsToProcess);
}

/** Xử lý events: getMarket => validate => group => payMoney */
async function processEvents(events: EventRow[]): Promise<void> {
  if (events.length === 0) return;

  // Filter duplicate orders - Check all in parallel
  // const duplicateChecks = await Promise.all(
  //   events.map(event => isOrderDuplicate(event.transactionHash, event.logIndex, event.usdcAmount, event.shareAmount))
  // );
  // const uniqueEvents = events.filter((_, i) => !duplicateChecks[i]);
  // if (uniqueEvents.length === 0) return;
  
  const uniqueEvents = events; // Skip duplicate check for speed

  const client = await getClobClient();
  const conditionIds = [...new Set(uniqueEvents.map((e) => e.conditionId))];
  const marketByCondition = new Map<string, MarketResult>();

  // Get markets - All in parallel
  const marketResults = await Promise.all(
    conditionIds.map(async (cid) => {
      try {
        return { cid, market: await getMarket(client, cid) };
      } catch (err) {
        return { cid, market: null };
      }
    })
  );
  marketResults.forEach(({ cid, market }) => {
    if (market) marketByCondition.set(cid, market);
  });

  // Filter valid entries
  const validConditionIds = new Set(marketByCondition.keys());
  const validEntries = uniqueEvents.filter((e) => validConditionIds.has(e.conditionId));

  if (validEntries.length === 0) return;

  // Group entries
  const groupKey = (e: EventRow): string => {
    const amountUsdc = Number(e.usdcAmount);
    const sharesSize = Number(e.shareAmount);
    const price = sharesSize ? roundPrice(amountUsdc / sharesSize) : 0;
    return [e.conditionId, e.assetId, String(price)].join("|");
  };

  const groups = new Map<string, EventRow[]>();
  for (const e of validEntries) {
    const key = groupKey(e);
    const list = groups.get(key) ?? [];
    list.push(e);
    groups.set(key, list);
  }

  // Pay orders - Batch all orders
  if (DRY_RUN) return;
  
  const groupList = [...groups.entries()];

  // Tạo tất cả signed orders song song với Promise.all
  const signedOrderPromises = groupList.map(async ([, entries]) => {
    const totalShares = entries.reduce((s, e) => s + Number(e.shareAmount), 0);
    let orderSize = Math.round(totalShares / 10);
    orderSize = Number(ethers.utils.formatUnits(orderSize, 6));
    if (orderSize < 5) orderSize = 5;
    
    const first = entries[0]!;
    const price = Number(first.shareAmount) ? roundPrice(Number(first.usdcAmount) / Number(first.shareAmount)) : 0;
    const result = marketByCondition.get(first.conditionId);
    if (!result) return null;
    
    const outcome = getOutcomeForAssetId(result.market, first.assetId);
    if (!outcome) return null;
    
    const info = result.market[outcome];
    if (!info) return null;

    try {
      const userOrder: UserOrder = {
        tokenID: info.tokenId,
        price: roundPrice(price),
        size: orderSize,
        side: Side.BUY,
      };
      const signedOrder = await client.createOrder(userOrder, {
        tickSize: String(info.tickSize) as TickSize,
        negRisk: info.negRisk,
      });
      return { signedOrder, entries };
    } catch (err) {
      console.error("[processEvents] createOrder failed", first.conditionId, (err as Error)?.message);
      return null;
    }
  });

  const ordersToCreate = (await Promise.all(signedOrderPromises)).filter((o) => o !== null);

  // Batch post tất cả orders cùng lúc
  if (ordersToCreate.length > 0) {
    try {
      const signedOrders = ordersToCreate.map(o => ({ order: o.signedOrder, orderType: OrderType.GTC }));
      await client.postOrders(signedOrders);
      
      // Mark all entries as processed - Batch all Redis writes
      // const markPromises: Promise<void>[] = [];
      // for (const { entries } of ordersToCreate) {
      //   for (const entry of entries) {
      //     markPromises.push(markOrderAsProcessed(entry.transactionHash, entry.logIndex, entry.usdcAmount, entry.shareAmount));
      //   }
      // }
      // await Promise.all(markPromises);
    } catch (err) {
      console.error("[processEvents] postOrders failed", (err as Error)?.message);
    }
  }
}

contract.on("OrderFilled", async (orderHash: string, maker: string, taker: string, makerAssetId: number, takerAssetId: number, makerAmountFilled: number, takerAmountFilled: number, fee: number, ev: ethers.Event) => {
  if (toStr(maker).toLowerCase() !== MAKER_FILTER.toLowerCase()) return;

  const log = ev as unknown as { transactionHash?: string; blockHash?: string; logIndex?: number; transactionIndex?: number };
  const txHash = log.transactionHash ?? "";
  const makerId = toStr(makerAssetId);
  const takerId = toStr(takerAssetId);
  const assetId = takerId;

  let conditionId = assetIdToConditionId.get(assetId) ?? "";
  if (!conditionId) {
    const { conditionId: conditionIdFromReceipt } = await getTxData(txHash);
    conditionId = conditionIdFromReceipt;
    if (conditionId) {
      assetIdToConditionId.set(assetId, conditionId);
      if (makerId !== assetId) assetIdToConditionId.set(makerId, conditionId);
    }
  }
  //làm tròn 2 số thập phân
  let price = Math.round((makerAmountFilled / takerAmountFilled) * 100) / 100;
  if (price <= 0.95)  price += 0.04;
  const event: EventRow = {
    transactionHash: txHash,
    blockNumber: ev.blockNumber,
    blockHash: log.blockHash ?? "",
    logIndex: log.logIndex ?? 0,
    transactionIndex: log.transactionIndex ?? 0,
    orderHash: toStr(orderHash),
    maker: toStr(maker),
    taker: toStr(taker),
    assetId,
    usdcAmount: toStr(makerAmountFilled),
    shareAmount: toStr(takerAmountFilled),
    price: toStr(price),
    fee: toStr(fee),
    conditionId,
  };

  // Ghi vào Redis
  // await saveEventToRedis(event);

  // Xử lý queue theo block
  const eventBlockNumber = event.blockNumber;
  
  // Nếu blockNumber khác với block hiện tại, xử lý queue cũ trước
  if (currentBlockNumber !== null && eventBlockNumber !== currentBlockNumber) {
    await flushQueue();
  }
  
  // Thêm event vào queue
  eventQueue.push(event);
  currentBlockNumber = eventBlockNumber;
  
  // Đánh dấu thời điểm event đầu tiên vào queue
  if (queueStartTime === null) {
    queueStartTime = Date.now();
  }
  
  // Flush nếu queue đạt 5 events
  if (eventQueue.length >= 5) {
    await flushQueue();
    return;
  }
  
  // Reset timer: nếu quá 200ms không có event mới cùng block, xử lý queue
  if (queueTimer) {
    clearTimeout(queueTimer);
  }
  queueTimer = setTimeout(() => {
    flushQueue();
  }, QUEUE_TIMEOUT_MS);
});

/** Thiết lập event listener cho contract */
function setupContractListener(): void {
}

/** Xử lý lỗi WebSocket và reconnect */
function setupWebSocketErrorHandling(): void {
  provider._websocket.on("error", (error: Error) => {
    console.error("[WebSocket] Error:", error.message);
  });

  provider._websocket.on("close", (code: number) => {
    console.log(`[WebSocket] Connection closed with code ${code}. Reconnecting in ${WEBSOCKET_RECONNECT_DELAY}ms...`);
    
    setTimeout(() => {
      console.log("[WebSocket] Attempting to reconnect...");
      // Tạo provider mới
      provider = new ethers.providers.WebSocketProvider("wss://polygon-mainnet.g.alchemy.com/v2/UfHs23_J0v1h157mRpdDk");
      contract = new ethers.Contract(contractAddress, contractAbi, provider);
      
      // Setup lại listener
      setupContractListener();
      setupWebSocketErrorHandling();
      
      console.log("[WebSocket] Reconnected successfully");
    }, WEBSOCKET_RECONNECT_DELAY);
  });
}

// Main
async function main(): Promise<void> {
  await redisClient.connect();
  
  // Setup contract listener và WebSocket error handling
  setupContractListener();
  setupWebSocketErrorHandling();

  process.on("SIGINT", async () => {
    await flushQueue();
    await redisClient.quit();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    await flushQueue();
    await redisClient.quit();
    process.exit(0);
  });
}

main();
