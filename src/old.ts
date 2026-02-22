import fs from "fs";
import path from "path";
import { createClient } from "redis";
import { ClobClient, Side, OrderType, TickSize } from "@polymarket/clob-client";
import { Wallet } from "ethers";
import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

const DRY_RUN = process.env.DRY_RUN !== "false";

const PAID_ORDERS_PATH = path.join(process.cwd(), "paid-orders.json");
const REDIS_KEY_PAID_ORDERS = "paid_orders";
const REDIS_EXPIRE_SEC = 3600; // 1 tiếng (paid_orders, paid:slug)
const CRON1_MAX_RETRIES = 10; // Cron1: thử tối đa 10 lần khi lỗi, không được thì thoát process

const MIN_USDC_SIZE_5M = 50;
const MIN_USDC_SIZE_15M = 100;
const ORDER_SIZE_5M = 100;
const ORDER_SIZE_15M = 150;

const is5m = (slug: string) => slug?.includes("btc-updown-5m");
const getMinUsdcSize = (slug: string) => (is5m(slug) ? MIN_USDC_SIZE_5M : MIN_USDC_SIZE_15M);
const getOrderSize = (slug: string) => (is5m(slug) ? ORDER_SIZE_5M : ORDER_SIZE_15M);

/** Slug match cả 5m và 15m (gộp 1 file). */
const SLUG_MATCH = (slug: string) =>
  slug?.includes("btc-updown-5m") || slug?.includes("btc-updown-15m");

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
        data.push(activity);
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

function aggregateBySlugAndOutcome(activities: Activity[]): SlugSummary[] {
  const key = (a: Activity) => `${a.slug}\n${String(a.outcome ?? "")}`;
  const bySlugOutcome = new Map<string, Activity[]>();
  for (const a of activities) {
    const k = key(a);
    const list = bySlugOutcome.get(k) ?? [];
    list.push(a);
    bySlugOutcome.set(k, list);
  }
  return Array.from(bySlugOutcome.entries()).map(([, list]) => {
    const totalSize = list.reduce((s, a) => s + Number(a.size), 0);
    const totalUsdcSize = list.reduce((s, a) => s + Number(a.usdcSize), 0);
    const avgPrice =
      list.length > 0
        ? list.reduce((s, a) => s + Number(a.price), 0) / list.length
        : 0;
    const first = list[0]!;
    return {
      slug: first.slug,
      title: String(first.title ?? ""),
      outcome: String(first.outcome ?? ""),
      conditionId: String(first.conditionId ?? ""),
      totalSize,
      totalUsdcSize,
      avgPrice,
      asset: String(first.asset ?? ""),
    };
  });
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

function savePaidOrdersToFile(orders: PaidOrder[]): void {
  fs.writeFileSync(PAID_ORDERS_PATH, JSON.stringify(orders, null, 2), "utf-8");
}

function pickCandidatesToPay(
  summary: SlugSummary[],
  paidOrders: PaidOrder[]
): SlugSummary[] {
  const paidSlugs = new Set(paidOrders.map((p) => p.slug));
  const bySlug = new Map<string, SlugSummary[]>();
  for (const s of summary) {
    const list = bySlug.get(s.slug) ?? [];
    list.push(s);
    bySlug.set(s.slug, list);
  }
  const candidates: SlugSummary[] = [];
  for (const [, list] of bySlug.entries()) {
    if (paidSlugs.has(list[0]!.slug)) continue;
    const withLargerUsdc = list.sort((a, b) => b.totalUsdcSize - a.totalUsdcSize);
    const chosen = withLargerUsdc[0]!;
    if (chosen.totalUsdcSize < getMinUsdcSize(chosen.slug)) continue;
    candidates.push(chosen);
  }
  return candidates;
}

/** Pay một lệnh (createAndPostOrder) — version cũ, từng order một. */
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
  const response = await client.createAndPostOrder(
    {
      tokenID: tokenId,
      price,
      size,
      side,
      //convert to 13 minutes from now
      expiration: Math.floor(Date.now() / 1000) + 13 * 60 // 13 minutes from now 
    },{tickSize: String(0.01) as TickSize, negRisk},
    OrderType.GTD
  );
  
  console.log("[payMoney] result:", response);
  return response;
}

async function runCron1(): Promise<void> {
  let lastErr: Error | undefined;
  for (let attempt = 1; attempt <= CRON1_MAX_RETRIES; attempt++) {
    try {
      const address = process.env.WALLET_ADDRESS ?? "0x88f46b9e5d86b4fb85be55ab0ec4004264b9d4db";
      const activities = await getActivities(address);
      const summary = aggregateBySlugAndOutcome(activities);

      const paidOrders = await loadPaidOrdersFromRedis();
      let candidates = pickCandidatesToPay(summary, paidOrders);
      if (candidates.length === 0) return;

      const redis = await getRedis();
      const stillNotInRedis: SlugSummary[] = [];
      for (const c of candidates) {
        const key = `paid:${c.slug}`;
        const exists = await redis.get(key);
        if (!exists) stillNotInRedis.push(c);
      }
      candidates = stillNotInRedis;
      if (candidates.length === 0) return;

      const client = await getClobClient();
      const newPaid: PaidOrder[] = [];

      for (const c of candidates) {
        try {
          const market = await getMarket(client, c.conditionId);
          const info = market[c.outcome];
          if (!info) {
            console.warn("[Cron1] Không tìm thấy outcome", c.outcome, "cho", c.slug);
            continue;
          }
          let price = Math.round(c.avgPrice * 100) / 100;
          const size = getOrderSize(c.slug);
          if (c.slug.includes("btc-updown-15m")) {
            price = 0.35;
          }
          await payMoney(client, info.tokenId, Side.BUY, price, size, info.negRisk, info.tickSize);
          newPaid.push({
            slug: c.slug,
            title: c.title,
            outcome: c.outcome,
            conditionId: c.conditionId,
            totalSize: c.totalSize,
            totalUsdcSize: c.totalUsdcSize,
            asset: c.asset,
            paidAt: new Date().toISOString(),
          });
        } catch (err) {
          console.error("[Cron1] Lỗi payMoney cho", c.slug, (err as Error)?.message);
        }
      }

      if (newPaid.length > 0) {
        const updated = [...paidOrders, ...newPaid];
        await savePaidOrdersToRedis(updated);
        savePaidOrdersToFile(updated);
        for (const o of newPaid) {
          await redis.setEx(`paid:${o.slug}`, REDIS_EXPIRE_SEC, "1");
        }
        console.log(`[Cron1] Đã lưu ${newPaid.length} lệnh vào Redis (paid_orders + paid:slug) và file ${PAID_ORDERS_PATH} vào lúc ${new Date().toISOString()}`);
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
}

async function main(): Promise<void> {
  console.log("DRY_RUN =", DRY_RUN);
  console.log("Paid orders: Redis", REDIS_KEY_PAID_ORDERS, "+ file", PAID_ORDERS_PATH, "| Dup: Redis paid:slug TTL", REDIS_EXPIRE_SEC, "s");

  setInterval(() => runCron1(), 10 * 1000);

  await runCron1();

  console.log("Cron: Cron1 mỗi 10s (pay). Slug: 5m + 15m.");
}

main();
