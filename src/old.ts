import path from "path";
import cron from "node-cron";
import { createClient } from "redis";
import { ClobClient, Side, OrderType, TickSize } from "@polymarket/clob-client";
import {
  BuilderConfig,
  BuilderApiKeyCreds,
} from "@polymarket/builder-signing-sdk";
import { Wallet } from "ethers";
import axios from "axios";
import dotenv from "dotenv";
import { runRedeem } from "./redeem";

// Chọn file env: tsx src/old.ts ckc | harvey
const envProfile = process.argv[2];
if (envProfile === "ckc" || envProfile === "harvey") {
  dotenv.config({ path: path.join(process.cwd(), `.env.${envProfile}`) });
} else {
  dotenv.config();
}

const DRY_RUN = process.env.DRY_RUN !== "false";

const REDIS_KEY_PAID_ORDERS = "paid_orders";
const REDIS_EXPIRE_SEC = 3600;
// conditionId đã mua → không mua lại trong 1 tiếng
const REDIS_PAID_CONDITION_PREFIX = "paid_condition:";
const REDIS_PAID_CONDITION_TTL_SEC = 3600; // 1 tiếng
const CRON1_MAX_RETRIES = 10;

const PAY_PRICE = 0.4;
const PAY_SIZE = 100;

/** Tránh chạy 2 lần Cron1 song song (double pay). */
let cron1InProgress = false;

/** Slug match cả 5m và 15m. */
const SLUG_MATCH = (slug: string) =>
  slug?.includes("updown-5m") || slug?.includes("updown-15m");

/** Chỉ activity có slug timestamp >= MIN_SLUG_TIMESTAMP mới valid. */
const MIN_SLUG_TIMESTAMP = process.env.MIN_SLUG_TIMESTAMP
  ? parseInt(process.env.MIN_SLUG_TIMESTAMP, 10)
  : 0;

function getTimestampFromSlug(slug: string): number | null {
  const parts = String(slug ?? "").split("-");
  const last = parts[parts.length - 1];
  if (last == null) return null;
  const n = parseInt(last, 10);
  return Number.isNaN(n) ? null : n;
}

let redisClient: ReturnType<typeof createClient> | null = null;

interface Activity {
  slug: string;
  title?: string;
  conditionId?: string;
  size: number;
  usdcSize: number;
  price: number;
  asset: string;
  outcome: string;
  transactionHash?: string;
  [key: string]: unknown;
}

/** Kết quả tổng hợp theo conditionId: outcome có volume cao nhất được chọn. */
interface ConditionCandidate {
  conditionId: string;
  slug: string;
  title: string;
  outcome: string;   // outcome thắng volume
  totalUsdcSize: number;
}

interface PaidOrder {
  slug: string;
  title: string;
  outcome: string;
  conditionId: string;
  totalUsdcSize: number;
  asset: string;
  paidAt: string;
}

type MarketOutcomeInfo = {
  tokenId: string;
  price: number;
  tickSize: number;
  negRisk: boolean;
  winner?: boolean;
};

async function getRedis() {
  if (redisClient) return redisClient;
  redisClient = createClient({ url: process.env.REDIS_URL || "redis://localhost:6379" });
  redisClient.on("error", (err: Error) => console.error("[Redis]", err.message));
  await redisClient.connect();
  return redisClient;
}

async function getClobClient(): Promise<ClobClient> {
  const HOST = "https://clob.polymarket.com";
  const CHAIN_ID = 137;
  const signer = new Wallet(process.env.PRIVATE_KEY!);
  const baseClient = new ClobClient(HOST, CHAIN_ID, signer);
  const userApiCreds = await baseClient.deriveApiKey();
  const builderCreds: BuilderApiKeyCreds = {
    key: process.env.POLY_BUILDER_API_KEY!,
    secret: process.env.POLY_BUILDER_SECRET!,
    passphrase: process.env.POLY_BUILDER_PASSPHRASE!,
  };
  const builderConfig = new BuilderConfig({ localBuilderCreds: builderCreds });
  return new ClobClient(
    HOST,
    CHAIN_ID,
    signer,
    userApiCreds,
    1,
    process.env.PROXY_WALLET!,
    undefined,
    undefined,
    builderConfig
  );
}

async function getActivities(address: string): Promise<Activity[]> {
  try {
    const response = await axios.get(
      `https://data-api.polymarket.com/activity?user=${address}&limit=50&offset=0`,
      { timeout: 5000, validateStatus: () => true }
    );
    const body = response.data;
    const raw = Array.isArray(body) ? body : body?.data ?? [];
    const data: Activity[] = [];
    for (const activity of raw) {
      if (activity.type === "TRADE" && SLUG_MATCH(activity.slug) && activity.side === "BUY") {
        const slugTs = getTimestampFromSlug(activity.slug);
        if (slugTs != null && slugTs >= MIN_SLUG_TIMESTAMP) {
          const price = Math.round(Number(activity.price) * 100) / 100;
          data.push({ ...activity, price });
        }
      }
    }
    return data;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const code = err && typeof (err as { code?: string }).code === "string"
      ? (err as { code: string }).code : "";
    console.warn("[getActivities] Lỗi request (bỏ qua):", code || msg);
    return [];
  }
}

async function getMarket(
  client: ClobClient,
  conditionId: string
): Promise<Record<string, MarketOutcomeInfo>> {
  const market = await client.getMarket(conditionId);
  const tickSize = market.min_tick_size;
  const negRisk = market.neg_risk;
  const data: Record<string, MarketOutcomeInfo> = {};
  for (const token of market.tokens ?? []) {
    const t = token as { token_id: string; outcome: string; price: number; winner?: boolean };
    data[t.outcome] = { tokenId: t.token_id, price: t.price, tickSize, negRisk, winner: t.winner };
  }
  return data;
}

/**
 * Gộp activities theo conditionId.
 * Với mỗi conditionId: cộng dồn usdcSize theo từng outcome → chọn outcome có usdcSize cao nhất.
 */
function aggregateByConditionId(activities: Activity[]): ConditionCandidate[] {
  const byCondition = new Map<string, Map<string, { usdcSize: number; slug: string; title: string }>>();
  for (const a of activities) {
    const cid = String(a.conditionId ?? "");
    if (!cid) continue;
    const outcome = String(a.outcome ?? "");
    if (!byCondition.has(cid)) byCondition.set(cid, new Map());
    const outcomeMap = byCondition.get(cid)!;
    const existing = outcomeMap.get(outcome);
    if (existing) {
      existing.usdcSize += Number(a.usdcSize);
    } else {
      outcomeMap.set(outcome, { usdcSize: Number(a.usdcSize), slug: a.slug, title: String(a.title ?? "") });
    }
  }

  const result: ConditionCandidate[] = [];
  for (const [conditionId, outcomeMap] of byCondition.entries()) {
    let bestOutcome = "";
    let bestEntry: { usdcSize: number; slug: string; title: string } | null = null;
    for (const [outcome, entry] of outcomeMap.entries()) {
      if (!bestEntry || entry.usdcSize > bestEntry.usdcSize) {
        bestOutcome = outcome;
        bestEntry = entry;
      }
    }
    if (bestEntry) {
      result.push({
        conditionId,
        slug: bestEntry.slug,
        title: bestEntry.title,
        outcome: bestOutcome,
        totalUsdcSize: bestEntry.usdcSize,
      });
    }
  }
  return result;
}

async function loadPaidOrdersFromRedis(): Promise<PaidOrder[]> {
  const redis = await getRedis();
  const raw = await redis.get(REDIS_KEY_PAID_ORDERS);
  if (!raw) return [];
  try { return JSON.parse(raw) as PaidOrder[]; } catch { return []; }
}

async function savePaidOrdersToRedis(orders: PaidOrder[]): Promise<void> {
  const redis = await getRedis();
  await redis.set(REDIS_KEY_PAID_ORDERS, JSON.stringify(orders), { EX: REDIS_EXPIRE_SEC });
}

async function payMoney(
  client: ClobClient,
  tokenId: string,
  side: Side,
  price: number,
  size: number,
  negRisk: boolean,
  tickSize: number
): Promise<unknown> {
  if (DRY_RUN) {
    console.log("[DRY_RUN] payMoney simulated:", { tokenId, side, price, size, negRisk, tickSize });
    return { dryRun: true };
  }
  const maxRetries = 5;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await client.createAndPostOrder(
        {
          tokenID: tokenId,
          price,
          size,
          side,
          expiration: Math.floor(Date.now() / 1000) + 13 * 60,
        },
        { tickSize: String(0.01) as TickSize, negRisk },
        OrderType.GTD
      );
      console.log("[payMoney] result:", response);
      return response;
    } catch (err) {
      const e = err as unknown as {
        message?: string;
        response?: { status?: number; data?: { error?: string } | unknown };
      };
      const status = e.response?.status;
      const dataError =
        e.response && typeof e.response.data === "object"
          ? (e.response.data as { error?: string }).error
          : undefined;
      const msg = (dataError || e.message || "").toString();
      const isOrderbookMissing =
        status === 400 && msg.includes("orderbook") && msg.includes("does not exist");

      if (isOrderbookMissing && attempt < maxRetries) {
        console.warn(`[payMoney] orderbook not found (tokenId=${tokenId}), retry ${attempt}/${maxRetries}...`);
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      console.error("[payMoney] Lỗi createAndPostOrder:", status, dataError || e.message || e);
      throw err;
    }
  }
  throw new Error("payMoney: exhausted retries without success");
}

async function runCron1(client: ClobClient): Promise<void> {
  if (cron1InProgress) return;
  cron1InProgress = true;
  let lastErr: Error | undefined;
  try {
    for (let attempt = 1; attempt <= CRON1_MAX_RETRIES; attempt++) {
      try {
        const address = process.env.WALLET_ADDRESS ?? "0x88f46b9e5d86b4fb85be55ab0ec4004264b9d4db";
        const activities = await getActivities(address);
        if (activities.length === 0) return;

        const candidates = aggregateByConditionId(activities);
        if (candidates.length === 0) return;

        const redis = await getRedis();

        // Lọc conditionId đã mua (Redis TTL 1 tiếng)
        const unpaid: ConditionCandidate[] = [];
        for (const c of candidates) {
          const exists = await redis.get(REDIS_PAID_CONDITION_PREFIX + c.conditionId);
          if (!exists) unpaid.push(c);
        }
        if (unpaid.length === 0) {
          return;
        }

        const paidOrders = await loadPaidOrdersFromRedis();
        const newPaid: PaidOrder[] = [];

        for (const c of unpaid) {
          try {
            if (c.totalUsdcSize <= 50) {
              console.log(`[Cron1] Bỏ qua ${c.slug}: totalUsdcSize=${c.totalUsdcSize} <= 50`);
              continue;
            }
            const market = await getMarket(client, c.conditionId);
            const info = market[c.outcome];
            if (!info) {
              console.warn("[Cron1] Không tìm thấy outcome", c.outcome, "cho", c.slug);
              continue;
            }
            // Đánh dấu Redis trước khi pay để tránh race condition
            await redis.set(
              REDIS_PAID_CONDITION_PREFIX + c.conditionId,
              "1",
              { EX: REDIS_PAID_CONDITION_TTL_SEC }
            );
            await payMoney(client, info.tokenId, Side.BUY, PAY_PRICE, PAY_SIZE, info.negRisk, info.tickSize);
            newPaid.push({
              slug: c.slug,
              title: c.title,
              outcome: c.outcome,
              conditionId: c.conditionId,
              totalUsdcSize: c.totalUsdcSize,
              asset: "",
              paidAt: new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" }),
            });
          } catch (err) {
            console.error("[Cron1] Lỗi payMoney cho", c.slug, (err as Error)?.message);
          }
        }

        if (newPaid.length > 0) {
          const updated = [...paidOrders, ...newPaid];
          await savePaidOrdersToRedis(updated);
          console.log(`[Cron1] Đã pay ${newPaid.length} conditionId, lưu Redis ${REDIS_KEY_PAID_ORDERS} lúc ${new Date().toISOString()}`);
        }
        console.log("[Cron1] Xong.");
        return;
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        const code = err && typeof (err as { code?: string }).code === "string"
          ? (err as { code: string }).code : "";
        console.error(`[Cron1] Lỗi lần ${attempt}/${CRON1_MAX_RETRIES}:`, code || lastErr.message);
        if (attempt < CRON1_MAX_RETRIES) {
          console.log(`[Cron1] Thử lại sau 3s... (còn ${CRON1_MAX_RETRIES - attempt} lần)`);
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
    }
    console.error("[Cron1] Đã thử", CRON1_MAX_RETRIES, "lần không thành công. Lỗi cuối:", lastErr?.message ?? "unknown");
    process.exit(1);
  } finally {
    cron1InProgress = false;
  }
}

async function printCheckIp(): Promise<void> {
  try {
    const res = await axios.get("https://api.ipify.org?format=text", { timeout: 5000 });
    console.log("Check IP:", res.data?.trim() ?? "(unknown)");
  } catch (e) {
    console.log("Check IP: (failed)", e instanceof Error ? e.message : e);
  }
}

async function main(): Promise<void> {
  await printCheckIp();
  if (envProfile === "ckc" || envProfile === "harvey") {
    console.log("ENV file: .env." + envProfile);
  }
  console.log("DRY_RUN =", DRY_RUN);
  console.log("PROXY_WALLET =", process.env.PROXY_WALLET ?? "(chưa set)");
  console.log(`Pay: price=${PAY_PRICE}, size=${PAY_SIZE}. conditionId đã mua: Redis ${REDIS_PAID_CONDITION_PREFIX}<conditionId> TTL ${REDIS_PAID_CONDITION_TTL_SEC}s (1h)`);

  const client = await getClobClient();
  setInterval(() => runCron1(client), 10 * 1000);
  await runCron1(client);

  // Cron2 (redeem): chạy mỗi 5 phút
  cron.schedule("*/5 * * * *", () => {
    console.log("[Cron2] Chạy redeemPositions...");
    runRedeem().catch((e) => console.error("[Cron2] Lỗi redeem:", e instanceof Error ? e.message : e));
  });

  console.log("Cron1 mỗi 10s (pay). Cron2: redeem mỗi 5 phút. Slug: 5m + 15m.");
}

main();
