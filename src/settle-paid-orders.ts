/**
 * Đọc paid-orders.json → getMarket(conditionId) để biết winner → xác định từng order win/loss
 * → Tổng hợp thắng/thua theo pool 15m và 5m → in ra → xóa data trong paid-orders.json
 */
import fs from "fs";
import path from "path";
import { ClobClient } from "@polymarket/clob-client";
import { Wallet } from "ethers";
import dotenv from "dotenv";

dotenv.config();

const PAID_ORDERS_PATH = path.join(process.cwd(), "paid-orders.json");

interface PaidOrderEntry {
  slug: string;
  title: string;
  outcome: string;
  conditionId: string;
  totalSize: number;
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

async function getMarket(
  client: ClobClient,
  conditionId: string
): Promise<Record<string, MarketOutcomeInfo>> {
  const market = await client.getMarket(conditionId);
  const tickSize = (market as { min_tick_size?: number }).min_tick_size ?? 0.01;
  const negRisk = (market as { neg_risk?: boolean }).neg_risk ?? false;
  const data: Record<string, MarketOutcomeInfo> = {};
  for (const token of (market as { tokens?: unknown[] }).tokens ?? []) {
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

/** conditionId -> winner outcome (string) hoặc undefined nếu chưa resolve / lỗi */
async function getWinnerOutcome(
  client: ClobClient,
  conditionId: string
): Promise<string | undefined> {
  const market = await getMarket(client, conditionId);
  for (const [outcome, info] of Object.entries(market)) {
    if (info.winner === true) return outcome;
  }
  return undefined;
}

function loadPaidOrders(): PaidOrderEntry[] {
  if (!fs.existsSync(PAID_ORDERS_PATH)) return [];
  const raw = fs.readFileSync(PAID_ORDERS_PATH, "utf-8");
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as PaidOrderEntry[]) : [];
  } catch {
    return [];
  }
}

function clearPaidOrders(): void {
  fs.writeFileSync(PAID_ORDERS_PATH, "[]", "utf-8");
}

/** "15m" | "5m" | "other" */
function poolFromSlug(slug: string): "15m" | "5m" | "other" {
  if (slug.includes("btc-updown-15m")) return "15m";
  if (slug.includes("btc-updown-5m")) return "5m";
  return "other";
}

interface OrderWithResult extends PaidOrderEntry {
  winnerOutcome: string | undefined;
  win: boolean | null; // null = chưa resolve
}

interface PoolSummary {
  wins: number;
  losses: number;
  unresolved: number;
  totalUsdcWin: number;
  totalUsdcLoss: number;
  totalUsdcUnresolved: number;
}

async function main(): Promise<void> {
  const orders = loadPaidOrders();
  if (orders.length === 0) {
    console.log("paid-orders.json trống hoặc không tồn tại. Không làm gì.");
    return;
  }

  console.log("Tổng số paid orders:", orders.length);
  const uniqueConditionIds = [...new Set(orders.map((o) => o.conditionId))];
  console.log("Số conditionId duy nhất:", uniqueConditionIds.length);

  const client = await getClobClient();
  const winnerByCondition = new Map<string, string | undefined>();

  console.log("Đang gọi getMarket song song với Promise.all...");
  const winnerResults = await Promise.all(
    uniqueConditionIds.map(async (cid) => {
      try {
        const winner = await getWinnerOutcome(client, cid);
        return { cid, winner };
      } catch (err) {
        console.warn("getMarket lỗi", cid, (err as Error)?.message);
        return { cid, winner: undefined as string | undefined };
      }
    })
  );
  for (const { cid, winner } of winnerResults) {
    winnerByCondition.set(cid, winner);
  }

  const results: OrderWithResult[] = orders.map((o) => {
    const winnerOutcome = winnerByCondition.get(o.conditionId);
    const win =
      winnerOutcome === undefined ? null : o.outcome === winnerOutcome;
    return { ...o, winnerOutcome, win };
  });

  const summaryByPool: Record<"15m" | "5m" | "other", PoolSummary> = {
    "15m": { wins: 0, losses: 0, unresolved: 0, totalUsdcWin: 0, totalUsdcLoss: 0, totalUsdcUnresolved: 0 },
    "5m": { wins: 0, losses: 0, unresolved: 0, totalUsdcWin: 0, totalUsdcLoss: 0, totalUsdcUnresolved: 0 },
    other: { wins: 0, losses: 0, unresolved: 0, totalUsdcWin: 0, totalUsdcLoss: 0, totalUsdcUnresolved: 0 },
  };

  for (const r of results) {
    const pool = poolFromSlug(r.slug);
    const s = summaryByPool[pool];
    if (r.win === null) {
      s.unresolved++;
      s.totalUsdcUnresolved += r.totalUsdcSize;
    } else if (r.win) {
      s.wins++;
      s.totalUsdcWin += r.totalUsdcSize;
    } else {
      s.losses++;
      s.totalUsdcLoss += r.totalUsdcSize;
    }
  }

  console.log("\n--- Kết quả từng pool ---\n");
  for (const pool of ["15m", "5m", "other"] as const) {
    const s = summaryByPool[pool];
    if (s.wins + s.losses + s.unresolved === 0) continue;
    console.log(`Pool ${pool}:`);
    console.log("  Thắng:", s.wins, "| Tổng USDC thắng:", s.totalUsdcWin.toFixed(2));
    console.log("  Thua:", s.losses, "| Tổng USDC thua:", s.totalUsdcLoss.toFixed(2));
    if (s.unresolved > 0) {
      console.log("  Chưa resolve:", s.unresolved, "| USDC:", s.totalUsdcUnresolved.toFixed(2));
    }
    console.log("");
  }

  const total15m = summaryByPool["15m"];
  const total5m = summaryByPool["5m"];
  console.log("--- Tổng hợp 15m vs 5m ---");
  console.log("15m: Thắng", total15m.wins, "| Thua", total15m.losses, "| Chưa resolve", total15m.unresolved);
  console.log("     USDC thắng:", total15m.totalUsdcWin.toFixed(2), "| USDC thua:", total15m.totalUsdcLoss.toFixed(2));
  console.log("5m:  Thắng", total5m.wins, "| Thua", total5m.losses, "| Chưa resolve", total5m.unresolved);
  console.log("     USDC thắng:", total5m.totalUsdcWin.toFixed(2), "| USDC thua:", total5m.totalUsdcLoss.toFixed(2));

  console.log("\nĐang xóa data trong paid-orders.json...");
  clearPaidOrders();
  console.log("Đã xóa xong paid-orders.json.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
