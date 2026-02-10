/**
 * Chỉ chạy 2 cronjob. Listen chạy riêng (vd. npx tsx src/log-tx-events.ts) ghi tx-events-log.json.
 */
import fs from "fs";
import path from "path";
import cron from "node-cron";
import { ClobClient, Side, OrderType, TickSize, UserOrder } from "@polymarket/clob-client";
import { Wallet } from "ethers";
import dotenv from "dotenv";

dotenv.config();

const DRY_RUN = process.env.DRY_RUN !== "false";

const TX_EVENTS_LOG_PATH = path.join(process.cwd(), "tx-events-log.json");
const TX_EVENTS_CHECKED_PATH = path.join(process.cwd(), "tx-events-checked.json");
const PAID_ORDERS_PATH = path.join(process.cwd(), "paid-orders1.json");

const SLUG_FILTER = "btc-updown-15m";

/** Một dòng trong tx-events-log.json */
interface TxLogEntry {
  txHash: string;
  blockNumber: number;
  assetId: string;
  amountUsdc: string;
  sharesSize: string;
  conditionId: string;
  timestamp: string;
  price?: number;
}

/** Key duy nhất cho 1 activity để tránh check trùng */
function entryKey(e: TxLogEntry): string {
  return [e.txHash, e.conditionId, e.assetId, e.amountUsdc, e.sharesSize].join("|");
}

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

function loadTxEventsLog(): TxLogEntry[] {
  if (!fs.existsSync(TX_EVENTS_LOG_PATH)) return [];
  try {
    const raw = fs.readFileSync(TX_EVENTS_LOG_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as TxLogEntry[]) : [];
  } catch {
    return [];
  }
}

function loadCheckedKeys(): Set<string> {
  if (!fs.existsSync(TX_EVENTS_CHECKED_PATH)) return new Set();
  try {
    const raw = fs.readFileSync(TX_EVENTS_CHECKED_PATH, "utf-8");
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr as string[] : []);
  } catch {
    return new Set();
  }
}

function appendCheckedKeys(keys: string[]): void {
  const set = loadCheckedKeys();
  keys.forEach((k) => set.add(k));
  fs.writeFileSync(TX_EVENTS_CHECKED_PATH, JSON.stringify([...set], null, 2), "utf-8");
}

/** Order đã pay (giá trị thực lệnh) — append mỗi lần, Cron2 update winner */
interface PaidOrderRecord {
  conditionId: string;
  assetId: string;
  outcome: string;
  orderSize: number;
  orderUsdcSize: number;
  price: number;
  paidAt: string;
  orderID?: string;
  transactionHash?: string;
  winner?: boolean;
}

function loadPaidOrders(): PaidOrderRecord[] {
  if (!fs.existsSync(PAID_ORDERS_PATH)) return [];
  try {
    const raw = fs.readFileSync(PAID_ORDERS_PATH, "utf-8");
    return JSON.parse(raw) as PaidOrderRecord[];
  } catch {
    return [];
  }
}

function appendPaidOrder(record: PaidOrderRecord): void {
  const list = loadPaidOrders();
  list.push(record);
  fs.writeFileSync(PAID_ORDERS_PATH, JSON.stringify(list, null, 2), "utf-8");
}

function savePaidOrders(orders: PaidOrderRecord[]): void {
  fs.writeFileSync(PAID_ORDERS_PATH, JSON.stringify(orders, null, 2), "utf-8");
}

/** Pay một lệnh. Chỉ gọi API khi DRY_RUN=false */
async function payMoney(
  client: ClobClient,
  tokenId: string,
  price: number,
  orderSize: number,
  tickSize: number,
  negRisk: boolean
): Promise<{ orderID?: string; transactionHash?: string }> {
  if (DRY_RUN) {
    return {};
  }
  const userOrder: UserOrder = {
    tokenID: tokenId,
    price: roundPrice(price),
    size: orderSize,
    side: Side.BUY,
  };
  const signedOrder = await client.createOrder(userOrder, {
    tickSize: String(tickSize) as TickSize,
    negRisk,
  });
  const response = await client.postOrder(signedOrder, OrderType.GTC);
  const orderID = response?.orderID ?? response?.order_id;
  const txHash = Array.isArray(response?.transactionsHashes) && response.transactionsHashes.length > 0
    ? response.transactionsHashes[0]
    : orderID;
  return { orderID, transactionHash: txHash ?? orderID };
}

let cron1Running: Promise<boolean> = Promise.resolve(false);

async function runCron1(): Promise<boolean> {
  cron1Running = cron1Running
    .then(() => doCron1())
    .catch((err) => {
      console.error("[Cron1] Lỗi:", err);
      return false;
    });
  return cron1Running;
}

const GET_MARKET_CONCURRENCY = 10;
const PAY_CONCURRENCY = 5;

/** Trả về true nếu có xử lý (có unchecked), false nếu không có gì. */
async function doCron1(): Promise<boolean> {
  const logEntries = loadTxEventsLog();
  const checkedSet = loadCheckedKeys();

  const unchecked = logEntries.filter((e) => !checkedSet.has(entryKey(e)));
  if (unchecked.length === 0) return false;

  const client = await getClobClient();
  const conditionIds = [...new Set(unchecked.map((e) => e.conditionId))];
  const marketByCondition = new Map<string, MarketResult>();

  for (let i = 0; i < conditionIds.length; i += GET_MARKET_CONCURRENCY) {
    const chunk = conditionIds.slice(i, i + GET_MARKET_CONCURRENCY);
    const results = await Promise.all(
      chunk.map(async (cid) => {
        try {
          return await getMarket(client, cid);
        } catch (err) {
          console.warn("[Cron1] getMarket", cid, (err as Error)?.message);
          return null;
        }
      })
    );
    chunk.forEach((cid, j) => {
      if (results[j]) marketByCondition.set(cid, results[j]!);
    });
  }

  const validConditionIds = new Set(marketByCondition.keys());
  const validEntries = unchecked.filter((e) => validConditionIds.has(e.conditionId));

  const groupKey = (e: TxLogEntry): string => {
    const amountUsdc = Number(e.amountUsdc);
    const sharesSize = Number(e.sharesSize);
    const price = e.price ?? (sharesSize ? roundPrice(amountUsdc / sharesSize) : 0);
    return [e.conditionId, e.assetId, String(price)].join("|");
  };

  const groups = new Map<string, TxLogEntry[]>();
  for (const e of validEntries) {
    const key = groupKey(e);
    const list = groups.get(key) ?? [];
    list.push(e);
    groups.set(key, list);
  }

  const groupList = [...groups.entries()];
  const paidEntryKeys: string[] = [];
  // Chỉ thêm vào paidEntryKeys khi pay + appendPaidOrder thành công (kể cả DRY_RUN: mô phỏng vẫn ghi paid-orders và checked để test luồng).

  for (let i = 0; i < groupList.length; i += PAY_CONCURRENCY) {
    const chunk = groupList.slice(i, i + PAY_CONCURRENCY);
    await Promise.all(
      chunk.map(async ([, entries]) => {
        const totalShares = entries.reduce((s, e) => s + Number(e.sharesSize), 0);
        let orderSize = Math.round(totalShares / 15);
        if (orderSize < 5) orderSize = 5;
        const first = entries[0]!;
        const price = first.price ?? (Number(first.sharesSize) ? roundPrice(Number(first.amountUsdc) / Number(first.sharesSize)) : 0);
        const result = marketByCondition.get(first.conditionId);
        if (!result) return;
        const outcome = getOutcomeForAssetId(result.market, first.assetId);
        if (!outcome) return;
        const info = result.market[outcome];
        if (!info) return;
        try {
          const { orderID, transactionHash } = await payMoney(
            client,
            info.tokenId,
            price,
            orderSize,
            info.tickSize,
            info.negRisk
          );
          appendPaidOrder({
            conditionId: first.conditionId,
            assetId: first.assetId,
            outcome,
            orderSize,
            orderUsdcSize: roundPrice(orderSize * price),
            price,
            paidAt: new Date().toISOString(),
            orderID,
            transactionHash,
          });
          entries.forEach((e) => paidEntryKeys.push(entryKey(e)));
        } catch (err) {
          console.error("[Cron1] payMoney failed", first.conditionId, (err as Error)?.message);
        }
      })
    );
  }

  if (paidEntryKeys.length > 0) {
    appendCheckedKeys(paidEntryKeys);
    console.log(
      "[Cron1]",
      DRY_RUN ? "(DRY_RUN)" : "đã pay",
      groupList.length,
      "nhóm, đánh dấu",
      paidEntryKeys.length,
      "entry đã check.",
      DRY_RUN ? "→ test luồng, vẫn ghi checked." : ""
    );
  }
  return true;
}

async function runCron2(): Promise<void> {
  const orders = loadPaidOrders();
  if (orders.length === 0) return;

  const client = await getClobClient();
  const conditionIds = [...new Set(orders.map((o) => o.conditionId))];
  const winnerByCondition = new Map<string, string>();

  const results = await Promise.all(conditionIds.map((cid) => getMarket(client, cid).catch(() => null)));
  conditionIds.forEach((cid, i) => {
    const result = results[i];
    if (!result) return;
    for (const [outcome, info] of Object.entries(result.market)) {
      if (info.winner === true) {
        winnerByCondition.set(cid, outcome);
        break;
      }
    }
  });

  let updated = 0;
  const next = orders.map((o) => {
    const winnerOutcome = winnerByCondition.get(o.conditionId);
    const winner = winnerOutcome === undefined ? o.winner : o.outcome === winnerOutcome;
    if (o.winner !== winner) updated++;
    return { ...o, winner };
  });
  if (updated > 0) {
    savePaidOrders(next);
    console.log("[Cron2] Đã cập nhật winner cho", updated, "lệnh.");
  }
}

async function main(): Promise<void> {
  console.log("DRY_RUN =", DRY_RUN);
  console.log("Chỉ 2 cron (listen chạy riêng). Đọc từ", TX_EVENTS_LOG_PATH);

  cron.schedule("*/15 * * * *", () => runCron2());

  await runCron1();
  await runCron2();

  // Cron1 chạy liên tục: có việc thì chạy lại ngay, không việc thì nghỉ 50ms rồi đọc file lại (tối đa hóa tốc độ, giảm độ trễ listen → xử lý).
  console.log("Cron1 chạy liên tục (nghỉ 50ms khi rỗng). Cron2 mỗi 15 phút.");
  (async function loopCron1() {
    for (;;) {
      const hadWork = await runCron1();
      if (!hadWork) await new Promise((r) => setTimeout(r, 50));
    }
  })();
}

main();