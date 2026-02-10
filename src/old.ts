import axios from "axios";
import fs from "fs";
import path from "path";
import cron from "node-cron";
import { ClobClient, Side, OrderType, TickSize } from "@polymarket/clob-client";
import { Wallet } from "ethers";
import dotenv from "dotenv";
dotenv.config();

// true = chỉ mô phỏng (không gọi API payMoney). false = gọi payMoney thật.
const DRY_RUN = process.env.DRY_RUN !== "false";

const SUMMARY_PATH = path.join(process.cwd(), "summary-by-slug.json");
const PAID_ORDERS_PATH = path.join(process.cwd(), "paid-orders.json");

const MIN_USDC_SIZE = 100;

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
  paidAt: string; // ISO
  winner?: boolean;
}

type MarketOutcomeInfo = {
  tokenId: string;
  price: number;
  tickSize: number;
  negRisk: boolean;
  winner?: boolean;
};

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
  const response = await axios.get(
    `https://data-api.polymarket.com/activity?user=${address}&limit=50&offset=0`
  );
  const raw = Array.isArray(response.data) ? response.data : response.data?.data ?? [];
  const data: Activity[] = [];
  for (const activity of raw) {
    if (
      activity.type === "TRADE" &&
      activity.slug?.includes("btc-updown-15m") &&
      activity.side === "BUY"
    ) {
      data.push(activity);
    }
  }
  return data;
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

function loadPaidOrders(): PaidOrder[] {
  if (!fs.existsSync(PAID_ORDERS_PATH)) return [];
  const raw = fs.readFileSync(PAID_ORDERS_PATH, "utf-8");
  try {
    return JSON.parse(raw) as PaidOrder[];
  } catch {
    return [];
  }
}

function savePaidOrders(orders: PaidOrder[]): void {
  fs.writeFileSync(PAID_ORDERS_PATH, JSON.stringify(orders, null, 2), "utf-8");
}

/** Slug đã mua (bất kỳ outcome) thì bỏ qua. Trả về danh sách SlugSummary cần pay: mỗi slug tối đa 1 outcome (outcome có totalUsdcSize lớn hơn; nếu < MIN_USDC_SIZE thì bỏ qua). */
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
    if (chosen.totalUsdcSize < MIN_USDC_SIZE) continue;

    candidates.push(chosen);
  }
  return candidates;
}

async function payMoney(
  client: ClobClient,
  tokenId: string,
  side: Side,
  negRisk: boolean,
  tickSize: number
): Promise<unknown> {
  if (DRY_RUN) {
    console.log("[DRY_RUN] payMoney simulated:", { tokenId, side, negRisk, tickSize });
    return { dryRun: true };
  }
  const response = await client.createAndPostOrder(
    {
      tokenID: tokenId,
      price: 0.47,
      size: 75,
      side,
    },
    {
      tickSize: tickSize as unknown as TickSize,
      negRisk,
    },
    OrderType.GTC
  );
  console.log("payMoney result:", response);
  return response;
}

/** Cron 1: mỗi 3 phút — update summary-by-slug.json rồi chạy logic payMoney (có điều kiện). */
async function runCron1(): Promise<void> {
  console.log("[Cron1] Bắt đầu...");
  const address = process.env.WALLET_ADDRESS ?? "0x88f46b9e5d86b4fb85be55ab0ec4004264b9d4db";
  const activities = await getActivities(address);
  const summary = aggregateBySlugAndOutcome(activities);

  fs.writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2), "utf-8");
  console.log("[Cron1] Đã cập nhật", SUMMARY_PATH);

  const paidOrders = loadPaidOrders();
  const candidates = pickCandidatesToPay(summary, paidOrders);
  if (candidates.length === 0) {
    console.log("[Cron1] Không có slug nào đủ điều kiện pay.");
    return;
  }

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
      await payMoney(client, info.tokenId, Side.BUY, info.negRisk, info.tickSize);
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
      console.error("[Cron1] Lỗi payMoney cho", c.slug, err);
    }
  }

  if (newPaid.length > 0) {
    savePaidOrders([...paidOrders, ...newPaid]);
    console.log("[Cron1] Đã lưu", newPaid.length, "lệnh vào", PAID_ORDERS_PATH);
  }
  console.log("[Cron1] Xong.");
}

/** Cron 2: lấy winner từ market và cập nhật file paid-orders. */
async function runCron2(): Promise<void> {
  console.log("[Cron2] Cập nhật winner...");
  const paidOrders = loadPaidOrders();
  if (paidOrders.length === 0) {
    console.log("[Cron2] Chưa có lệnh nào.");
    return;
  }

  const client = await getClobClient();
  const conditionIds = [...new Set(paidOrders.map((p) => p.conditionId))];
  const winnerByCondition = new Map<string, string>(); // conditionId -> outcome (winner)

  // Chỉ khi market đã resolve thì API trả về đúng 1 outcome có winner === true.
  // Khi chưa có kết quả, cả 2 outcome đều winner === false hoặc undefined → không set winnerByCondition.
  for (const cid of conditionIds) {
    try {
      const market = await getMarket(client, cid);
      for (const [outcome, info] of Object.entries(market)) {
        if (info.winner === true) {
          winnerByCondition.set(cid, outcome);
          break;
        }
      }
    } catch (err) {
      console.warn("[Cron2] Không lấy được market", cid, err);
    }
  }

  let updated = 0;
  const next = paidOrders.map((o) => {
    const winnerOutcome = winnerByCondition.get(o.conditionId);
    // Chưa resolve: winnerOutcome === undefined → giữ nguyên, winner vẫn undefined (không ghi false).
    if (winnerOutcome === undefined) return o;
    const winner = o.outcome === winnerOutcome;
    if (o.winner !== winner) updated++;
    return { ...o, winner };
  });
  if (updated > 0) {
    savePaidOrders(next);
    console.log("[Cron2] Đã cập nhật winner cho", updated, "lệnh.");
  }
  console.log("[Cron2] Xong.");
}

async function main(): Promise<void> {
  console.log("DRY_RUN =", DRY_RUN, "(true = chỉ mô phỏng, không gọi payMoney thật)");

  setInterval(() => runCron1(), 30 * 1000); // Cron1: mỗi 30 giây (summary + pay)
  cron.schedule("*/10 * * * *", () => runCron2()); // Cron2: mỗi 10 phút (update winner)

  await runCron1();
  await runCron2();

  console.log("Cron đã lên lịch: Cron1 mỗi 30 giây, Cron2 mỗi 10 phút.");
}

main();
