import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import { createClient } from "redis";
import { ClobClient, Side, OrderType, TickSize, UserOrder } from "@polymarket/clob-client";
import { Wallet } from "ethers";
import dotenv from "dotenv";

dotenv.config();

const DRY_RUN = process.env.DRY_RUN !== "false";
const ORDER_DUPLICATE_TTL_SECONDS = 15 * 60; // 15 phút
const WEBSOCKET_RECONNECT_DELAY = 5000; // 5 giây
// https://polygon-mainnet.g.alchemy.com/v2/UfHs23_J0v1h157mRpdDk
let provider = new ethers.providers.WebSocketProvider("wss://polygon.drpc.org");

const contractAbi = fs.readFileSync(path.join(__dirname, "abi", "abi.js"), "utf8");
const contractAddress = "0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e";
const MAKER_FILTER = "0x6031B6eed1C97e853c6e0F03Ad3ce3529351F96d".toLowerCase();
let contract = new ethers.Contract(contractAddress, contractAbi, provider);

// Aggregated order data - không lưu từng event nữa, lưu tổng luôn
type AggregatedOrder = {
  conditionId: string;
  assetId: string;
  price: number;
  totalUsdcAmount: number; // Tổng USDC (đã parse)
  totalShareAmount: number; // Tổng shares (đã parse)
  tokenData: TokenData; // Info từ Redis
};

const assetIdToConditionId = new Map<string, TokenData>(); // Cache tokenData (preload từ Redis)

// Queue theo priceKey - mỗi (conditionId|assetId|price) có 1 aggregated order
const priceQueues = new Map<string, AggregatedOrder>(); // Map<priceKey, aggregatedOrder>
const priceTimers = new Map<string, NodeJS.Timeout>(); // Map<priceKey, timer>
const QUEUE_TIMEOUT_MS = 200; // 200ms

// ClobClient global - khởi tạo 1 lần
let clobClient: ClobClient;


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


type TokenData = {
  conditionId: string;
  slug: string;
  question: string;
  tokenId: string;
  pairedTokenId: string;
  negRisk: boolean;
};

function toStr(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "object" && v !== null && "toString" in v) return String((v as { toString(): string }).toString());
  return String(v);
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

function roundPrice(p: number): number {
  return Math.round(Number(p) * 100) / 100;
}

/** Flush queue của 1 priceKey cụ thể - pay order ngay */
async function flushPriceQueue(priceKey: string): Promise<void> {
  const order = priceQueues.get(priceKey);
  if (!order) return;
  
  priceQueues.delete(priceKey);
  
  const timer = priceTimers.get(priceKey);
  if (timer) {
    clearTimeout(timer);
    priceTimers.delete(priceKey);
  }
  
  try {
    await payOrder(order);
  } catch (err) {
    console.error("[flushPriceQueue] Error:", priceKey, (err as Error)?.message);
  }
}

/** Flush tất cả queues */
async function flushAllQueues(): Promise<void> {
  const prices = Array.from(priceQueues.keys());
  await Promise.all(prices.map(price => flushPriceQueue(price)));
}

/** Pay 1 order đã aggregate */
async function payOrder(order: AggregatedOrder): Promise<void> {
  let oldSize = 0;
  // Calculate orderSize từ total shares (làm tròn còn 1 chữ số thập phân sau dấu phẩy)
  let orderSize = Math.round(order.totalShareAmount * 10) / 10;
  orderSize = Number(orderSize);
  if (orderSize < 5) {
    oldSize = orderSize;
    orderSize = 5
  };

  if (DRY_RUN) {
    console.log(`[DRY_RUN] price=${order.price}, size=${orderSize}, oldSize=${oldSize}`);
    return;
  }
  
  // Determine outcome từ assetId
  const isYes = order.tokenData.tokenId === order.assetId;
  const tokenId = order.assetId;
  
  try {
    await clobClient.createAndPostOrder({
      tokenID: tokenId,
      price: roundPrice(order.price),
      size: orderSize,
      side: Side.BUY,
    }, {
      tickSize: String(0.01) as TickSize,
      negRisk: order.tokenData.negRisk,
    }, OrderType.GTC);
  } catch (err) {
    console.error("[payOrder] Failed", order.conditionId, (err as Error)?.message);
  }
}


/** Thiết lập event listener cho contract */
function setupContractListener(): void {
  contract.on("OrderFilled", (orderHash: string, maker: string, taker: string, makerAssetId: number, takerAssetId: number, makerAmountFilled: number, takerAmountFilled: number, fee: number, ev: ethers.Event) => {
    if (toStr(maker).toLowerCase() !== MAKER_FILTER.toLowerCase()) return;

    const assetId = toStr(takerAssetId);

    // Get tokenData từ cache (đã preload tất cả lúc startup)
    const tokenData = assetIdToConditionId.get(assetId);
    if (!tokenData) return; // Skip nếu không có trong cache

    // Calculate price (làm tròn 2 số thập phân)
    const price = Math.round((makerAmountFilled / takerAmountFilled) * 100) / 100;
    const priceKey = `${tokenData.conditionId}|${assetId}|${price}`;

    // Nếu có price mới HOẶC assetId mới → flush tất cả queues cũ
    // Tính trực tiếp từ priceQueues hiện tại (không maintain riêng)
    if (priceQueues.size > 0) {
      const currentQueues = Array.from(priceQueues.values());
      const hasThisPrice = currentQueues.some(o => o.price === price);
      const hasThisAsset = currentQueues.some(o => o.assetId === assetId);
      
      // Nếu price HOẶC assetId chưa có trong queue → flush tất cả
      if (!hasThisPrice || !hasThisAsset) {
        flushAllQueues(); // Fire and forget
      }
    }

    // Get hoặc create aggregated order cho priceKey này
    let order = priceQueues.get(priceKey);
    if (!order) {
      order = {
        conditionId: tokenData.conditionId,
        assetId: assetId,
        price: price,
        totalUsdcAmount: 0,
        totalShareAmount: 0,
        tokenData: tokenData,
      };
      priceQueues.set(priceKey, order);
    }

    // Aggregate: cộng dồn amounts
    order.totalUsdcAmount += Number(ethers.utils.formatUnits(makerAmountFilled, 6));
    order.totalShareAmount += Number(ethers.utils.formatUnits(takerAmountFilled, 6));

    // Reset timer: 200ms sau event cuối cùng sẽ flush
    const existingTimer = priceTimers.get(priceKey);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      flushPriceQueue(priceKey);
    }, QUEUE_TIMEOUT_MS);

    priceTimers.set(priceKey, timer);
  });
}

/** Xử lý lỗi WebSocket và reconnect */
function setupWebSocketErrorHandling(): void {
  provider._websocket.on("open", () => {
    console.log("[WebSocket] Connection opened successfully");
  });

  provider._websocket.on("error", (error: Error) => {
    console.error("[WebSocket] Error:", error.message);
  });

  provider._websocket.on("close", (code: number) => {
    console.log(`[WebSocket] Connection closed with code ${code}. Reconnecting in ${WEBSOCKET_RECONNECT_DELAY}ms...`);
    
    setTimeout(() => {
      console.log("[WebSocket] Attempting to reconnect...");
      // Tạo provider mới
      provider = new ethers.providers.WebSocketProvider("wss://polygon.drpc.org");
      contract = new ethers.Contract(contractAddress, contractAbi, provider);
      
      // Setup lại listener
      setupContractListener();
      setupWebSocketErrorHandling();
      
      console.log("[WebSocket] Reconnected successfully");
    }, WEBSOCKET_RECONNECT_DELAY);
  });
}

/** Pre-load tất cả tokens từ Redis vào cache */
async function preloadTokensFromRedis(): Promise<void> {
  console.log("[Redis] Pre-loading tokens into cache...");
  try {
    const keys = await redisClient.keys("token:*");
    console.log(`[Redis] Found ${keys.length} tokens`);
    
    // Load tất cả parallel với Promise.all
    const dataArray = await Promise.all(keys.map(key => redisClient.get(key)));
    
    let loaded = 0;
    for (let i = 0; i < dataArray.length; i++) {
      const data = dataArray[i];
      if (data) {
        const tokenData: TokenData = JSON.parse(data);
        assetIdToConditionId.set(tokenData.tokenId, tokenData);
        loaded++;
      }
    }
    console.log(`[Redis] Pre-loaded ${loaded} tokens into cache`);
  } catch (err) {
    console.error("[Redis] Pre-load failed:", (err as Error)?.message);
  }
}

// Main
async function main(): Promise<void> {
  await redisClient.connect();
  
  // Pre-load tất cả tokens vào cache để tránh await Redis trong event processing
  await preloadTokensFromRedis();
  
  // Khởi tạo ClobClient 1 lần
  clobClient = await getClobClient();
  
  // Setup contract listener và WebSocket error handling
  setupContractListener();
  setupWebSocketErrorHandling();

  process.on("SIGINT", async () => {
    await flushAllQueues();
    await redisClient.quit();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    await flushAllQueues();
    await redisClient.quit();
    process.exit(0);
  });
}

main();
