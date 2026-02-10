import { ethers } from "ethers";
import fs from "fs";
import path from "path";

const provider = new ethers.providers.WebSocketProvider("wss://polygon-mainnet.g.alchemy.com/v2/UfHs23_J0v1h157mRpdDk");

const contractAbi = fs.readFileSync(path.join(__dirname, "abi", "abi.js"), "utf8");
const contractAddress = "0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e";
const MAKER_FILTER = "0x6031B6eed1C97e853c6e0F03Ad3ce3529351F96d".toLowerCase();
const contract = new ethers.Contract(contractAddress, contractAbi, provider);
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
};
const events: EventRow[] = [];
const txEventsCache = new Map<string, TxData>();
const assetIdToConditionId = new Map<string, string>();

const OUT_FILE = path.join(process.cwd(), "test-events.json");
/** Định kỳ flush (backup). */
const FLUSH_INTERVAL_MS = 2_000;
/** Sau mỗi event, hẹn flush sau N ms; event tiếp trong khoảng đó thì gộp 1 lần ghi (debounce). */
const FLUSH_DEBOUNCE_MS = 400;

let flushTimer: ReturnType<typeof setTimeout> | null = null;

function loadExistingEvents() {
  try {
    const raw = fs.readFileSync(OUT_FILE, "utf8").trim();
    if (raw) events.push(...JSON.parse(raw));
  } catch {
    /* bắt đầu từ trống */
  }
}

function flushToFile() {
  try {
    fs.writeFileSync(OUT_FILE, JSON.stringify(events, null, 2), "utf8");
  } catch (err) {
    console.error("[flush]", (err as Error)?.message ?? err);
  }
}

function scheduleFlush() {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushToFile();
  }, FLUSH_DEBOUNCE_MS);
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

/** Lấy tất cả event + conditionId trong cùng 1 giao dịch; cache theo txHash. */
async function getTxData(txHash: string): Promise<TxData> {
  const cached = txEventsCache.get(txHash);
  if (cached) return cached;

  const receipt = await provider.getTransactionReceipt(txHash);
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

contract.on("OrderFilled", async (orderHash: string, maker: string, taker: string, makerAssetId: unknown, takerAssetId: unknown, makerAmountFilled: unknown, takerAmountFilled: unknown, fee: unknown, ev: ethers.Event) => {
  if (toStr(maker).toLowerCase() !== MAKER_FILTER) return;

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

  events.push({
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
    fee: toStr(fee),
    conditionId,
  });
  scheduleFlush();
});

loadExistingEvents();
setInterval(flushToFile, FLUSH_INTERVAL_MS);
process.on("SIGINT", () => { flushToFile(); process.exit(0); });
process.on("SIGTERM", () => { flushToFile(); process.exit(0); });