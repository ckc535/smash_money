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

// Chọn file env: npm run run-old:ckc hoặc run-old:harvey, hoặc tsx src/old.ts ckc | harvey
const envProfile = process.argv[2];
if (envProfile === "ckc" || envProfile === "harvey") {
  dotenv.config({ path: path.join(process.cwd(), `.env.${envProfile}`) });
} else {
  dotenv.config();
}

const DRY_RUN = process.env.DRY_RUN !== "false";
const DIVISION_FACTOR = parseInt(process.env.DIVISION_FACTOR!);
console.log("DIVISION_FACTOR", DIVISION_FACTOR);

const REDIS_KEY_PAID_ORDERS = "paid_orders";
const REDIS_EXPIRE_SEC = 3600; // 1 tiếng (paid_orders)
const REDIS_PROCESSED_ACTIVITY_PREFIX = "processed_activity:";
const REDIS_PROCESSED_ACTIVITY_TTL_SEC = 120 * 60; // 2 tiếng — tránh trùng
const REDIS_EXTRA_PAY_TOKEN_PREFIX = "extra_pay_token:"; // .env.ckc: mỗi tokenId chỉ extra pay (0.2, 100) 1 lần
const REDIS_EXTRA_PAY_TOKEN_TTL_SEC = 30 * 60; // 30 phút
const CRON1_MAX_RETRIES = 10; // Cron1: thử tối đa 10 lần khi lỗi, không được thì thoát process

/** Tránh chạy 2 lần Cron1 song song (double pay). */
let cron1InProgress = false;



/** Slug match cả 5m và 15m (gộp 1 file). */
const SLUG_MATCH = (slug: string) =>
  slug?.includes("updown-5m") || slug?.includes("updown-15m");

/** Timestamp tối thiểu trong slug (slug dạng btc-updown-5m-1771909800). Chỉ activity có slug timestamp > biến này mới valid. */
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
  transactionHash?: string; // unique — dùng để check đã xử lí hay chưa (Redis 30p)
  [key: string]: unknown;
}

interface SlugSummary {
  slug: string;
  title: string;
  outcome: string;
  conditionId: string;
  totalSize: number;
  totalUsdcSize: number;
  avgPrice: number;
  asset: string;
}

/** Nhóm activities theo (conditionId, price, asset) — dùng để pay theo từng nhóm; giữ transactionHashes để đánh dấu đã xử lí. */
interface ActivityGroup {
  slug: string;
  title: string;
  outcome: string;
  conditionId: string;
  asset: string;
  price: number;
  totalSize: number;
  totalUsdcSize: number;
  transactionHashes: string[];
}

interface PaidOrder {
  slug: string;
  title: string;
  outcome: string;
  conditionId: string;
  totalSize: number;
  totalUsdcSize: number;
  asset: string;
  paidAt: string;
  winner?: boolean;
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

/** Khởi tạo ClobClient từ đầu: signer → derive API key → builder config → client. */
async function getClobClient(): Promise<ClobClient> {
  const HOST = "https://clob.polymarket.com";
  const CHAIN_ID = 137;

  // 1. Signer từ private key
  const signer = new Wallet(process.env.PRIVATE_KEY!);

  // 2. Client cơ bản chỉ để derive API key (nếu chưa có thì Polymarket tạo mới từ wallet)
  const baseClient = new ClobClient(HOST, CHAIN_ID, signer);
  const userApiCreds = await baseClient.deriveApiKey();

  // 3. Builder config (proxy wallet / builder API)
  const builderCreds: BuilderApiKeyCreds = {
    key: process.env.POLY_BUILDER_API_KEY!,
    secret: process.env.POLY_BUILDER_SECRET!,
    passphrase: process.env.POLY_BUILDER_PASSPHRASE!,
  };
  const builderConfig = new BuilderConfig({
    localBuilderCreds: builderCreds,
  });

  // 4. Client đầy đủ: host, chain, signer, api creds, proxy wallet, builder config
  const client = new ClobClient(
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

  return client;
}

async function getActivities(address: string): Promise<Activity[]> {
  try {
    const response = await axios.get(
      `https://data-api.polymarket.com/activity?user=${address}&limit=50&offset=0`,
      { timeout: 5000, validateStatus: () => true}
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
    const code = err && typeof (err as { code?: string }).code === "string" ? (err as { code: string }).code : "";
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
    data[t.outcome] = {
      tokenId: t.token_id,
      price: t.price,
      tickSize,
      negRisk,
      winner: t.winner,
    };
  }
  return data;
}

/** Lọc activities chưa được xử lí (transactionHash chưa có trong Redis). */
async function filterUnprocessedActivities(
  redis: Awaited<ReturnType<typeof getRedis>>,
  activities: Activity[]
): Promise<Activity[]> {
  const withTxHash = activities.filter((a) => a.transactionHash);
  if (withTxHash.length === 0) return [];
  const keys = withTxHash.map((a) => REDIS_PROCESSED_ACTIVITY_PREFIX + (a.transactionHash ?? ""));
  const existing = await redis.mGet(keys);
  const processedSet = new Set(
    keys.filter((_, i) => existing[i] != null)
  );
  return withTxHash.filter((a) => !processedSet.has(REDIS_PROCESSED_ACTIVITY_PREFIX + (a.transactionHash ?? "")));
}

/** Đánh dấu các activity (theo transactionHash) đã xử lí — Redis TTL 30 phút. Gọi trước pay để tránh race (cron chạy lại pay 2 lần). */
async function markActivitiesProcessed(
  redis: Awaited<ReturnType<typeof getRedis>>,
  transactionHashes: string[]
): Promise<void> {
  for (const tx of transactionHashes) {
    await redis.set(REDIS_PROCESSED_ACTIVITY_PREFIX + tx, "1", { EX: REDIS_PROCESSED_ACTIVITY_TTL_SEC });
  }
}

/** Gộp activities theo (conditionId, price, asset); tổng size và usdcSize; lưu danh sách transactionHash để đánh dấu sau khi pay. */
function aggregateByConditionIdPriceAsset(activities: Activity[]): ActivityGroup[] {
  const key = (a: Activity) =>
    `${String(a.conditionId ?? "")}\n${Number(a.price)}\n${String(a.asset ?? "")}`;
  const byKey = new Map<string, Activity[]>();
  for (const a of activities) {
    const k = key(a);
    const list = byKey.get(k) ?? [];
    list.push(a);
    byKey.set(k, list);
  }
  return Array.from(byKey.entries()).map(([, list]) => {
    const totalSize = list.reduce((s, a) => s + Number(a.size), 0);
    const totalUsdcSize = list.reduce((s, a) => s + Number(a.usdcSize), 0);
    const first = list[0]!;
    const transactionHashes = list
      .map((a) => a.transactionHash)
      .filter((t): t is string => Boolean(t));
    return {
      slug: first.slug,
      title: String(first.title ?? ""),
      outcome: String(first.outcome ?? ""),
      conditionId: String(first.conditionId ?? ""),
      asset: String(first.asset ?? ""),
      price: Number(first.price),
      totalSize,
      totalUsdcSize,
      transactionHashes,
    };
  });
}

/** Trả về tất cả nhóm để pay (không lọc theo min USDC). */
function pickCandidatesToPayFromGroups(groups: ActivityGroup[]): ActivityGroup[] {
  return groups;
}

async function loadPaidOrdersFromRedis(): Promise<PaidOrder[]> {
  const redis = await getRedis();
  const raw = await redis.get(REDIS_KEY_PAID_ORDERS);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as PaidOrder[];
  } catch {
    return [];
  }
}

async function savePaidOrdersToRedis(orders: PaidOrder[]): Promise<void> {
  const redis = await getRedis();
  await redis.set(REDIS_KEY_PAID_ORDERS, JSON.stringify(orders), { EX: REDIS_EXPIRE_SEC });
}

/** Pay một lệnh (createAndPostOrder) — size từ nhóm activity đã gộp. */
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
          //convert to 13 minutes from now
          expiration: Math.floor(Date.now() / 1000) + 13 * 60, // 13 minutes from now
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
        status === 400 &&
        typeof msg === "string" &&
        msg.includes("orderbook") &&
        msg.includes("does not exist");

      if (isOrderbookMissing && attempt < maxRetries) {
        console.warn(
          `[payMoney] orderbook not found (tokenId=${tokenId}), retry ${attempt}/${maxRetries - 1}...`
        );
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }

      console.error(
        "[payMoney] Lỗi createAndPostOrder:",
        status,
        dataError || e.message || e
      );
      throw err;
    }
  }
  throw new Error("payMoney: exhausted retries without success");
}

async function runCron1(client: ClobClient): Promise<void> {
  if (cron1InProgress) {
    return;
  }
  cron1InProgress = true;
  let lastErr: Error | undefined;
  try {
    for (let attempt = 1; attempt <= CRON1_MAX_RETRIES; attempt++) {
      try {
        const address = process.env.WALLET_ADDRESS ?? "0x88f46b9e5d86b4fb85be55ab0ec4004264b9d4db";
        const activities = await getActivities(address);
        const redis = await getRedis();
        const unprocessed = await filterUnprocessedActivities(redis, activities);
        if (unprocessed.length === 0) {
          return;
        }
        const groups = aggregateByConditionIdPriceAsset(unprocessed);
        const candidates = pickCandidatesToPayFromGroups(groups);
        if (candidates.length === 0) return;

        // Đánh dấu Redis sớm: tất cả txHash của tất cả candidate ngay lập tức,
        // để cron lần sau không lấy trùng (tránh double pay khi 2 run chồng lên nhau).
        const allTxHashes = candidates.flatMap((c) => c.transactionHashes);
        await markActivitiesProcessed(redis, allTxHashes);

        const paidOrders = await loadPaidOrdersFromRedis();
        const newPaid: PaidOrder[] = [];

        for (const c of candidates) {
          try {
            const market = await getMarket(client, c.conditionId);
            const info = market[c.outcome];
            if (!info) {
              console.warn("[Cron1] Không tìm thấy outcome", c.outcome, "cho", c.slug);
              continue;
            }
            let price = Math.round(c.price * 100) / 100;
            let size = Math.round((c.totalSize / DIVISION_FACTOR) * 10) / 10;
            if (size < 5) size = 5;
            await payMoney(client, info.tokenId, Side.BUY, price, size, info.negRisk, info.tickSize);
            // if (envProfile === "ckc") {
            //   const extraKey = REDIS_EXTRA_PAY_TOKEN_PREFIX + info.tokenId;
            //   const alreadyExtra = await redis.get(extraKey);
            //   if (!alreadyExtra) {
            //     await payMoney(client, info.tokenId, Side.BUY, 0.2, 100, info.negRisk, info.tickSize);
            //     await redis.set(extraKey, "1", { EX: REDIS_EXTRA_PAY_TOKEN_TTL_SEC });
            //   }
            // }
            newPaid.push({
              slug: c.slug,
              title: c.title,
              outcome: c.outcome,
              conditionId: c.conditionId,
              totalSize: c.totalSize,
              totalUsdcSize: c.totalUsdcSize,
              asset: c.asset,
              //log theo khung giờ GTM +7 (UTC+7)
              paidAt: new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString(),
            });
          } catch (err) {
            console.error("[Cron1] Lỗi payMoney cho", c.slug, (err as Error)?.message);
          }
        }

      if (newPaid.length > 0) {
        const updated = [...paidOrders, ...newPaid];
        await savePaidOrdersToRedis(updated);
        console.log(`[Cron1] Đã pay ${newPaid.length} nhóm, lưu Redis ${REDIS_KEY_PAID_ORDERS} vào lúc ${new Date().toISOString()}`);
      }
      console.log("[Cron1] Xong.");
      return;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      const code = err && typeof (err as { code?: string }).code === "string" ? (err as { code: string }).code : "";
      console.error(
        `[Cron1] Lỗi lần ${attempt}/${CRON1_MAX_RETRIES}:`,
        code || lastErr.message
      );
      if (attempt < CRON1_MAX_RETRIES) {
        console.log(`[Cron1] Thử lại sau 3s... (còn ${CRON1_MAX_RETRIES - attempt} lần)`);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }
  console.error(
    "[Cron1] Đã thử",
    CRON1_MAX_RETRIES,
    "lần không thành công. Lỗi cuối:",
    lastErr?.message ?? "unknown"
  );
  process.exit(1);
  } finally {
    cron1InProgress = false;
  }
}

async function main(): Promise<void> {
  if (envProfile === "ckc" || envProfile === "harvey") {
    console.log("ENV file: .env." + envProfile);
  }
  console.log("DRY_RUN =", DRY_RUN);
  console.log("PROXY_WALLET =", process.env.PROXY_WALLET ?? "(chưa set)");
  console.log("Paid orders: Redis", REDIS_KEY_PAID_ORDERS);
  console.log("Activity đã xử lí: Redis", REDIS_PROCESSED_ACTIVITY_PREFIX + "<txHash> TTL", REDIS_PROCESSED_ACTIVITY_TTL_SEC, "s (30p)");

  const client = await getClobClient();
  setInterval(() => runCron1(client), 3 * 1000);

  await runCron1(client);

  // Cron2 (redeem): chạy mỗi 1 tiếng
  cron.schedule("0 * * * *", () => {
    console.log("[Cron2] Chạy redeemPositions...");
    runRedeem().catch((e) => console.error("[Cron2] Lỗi redeem:", e instanceof Error ? e.message : e));
  });

  console.log("Cron1 mỗi 3s (pay). Cron2: redeem mỗi 1 tiếng. Slug: 5m + 15m.");
}

main();
