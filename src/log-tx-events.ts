import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

// https://polygon-mainnet.g.alchemy.com/v2/UfHs23_J0v1h157mRpdDk
let provider = new ethers.providers.WebSocketProvider("wss://polygon-mainnet.g.alchemy.com/v2/XYYgx0YBjlQoRD6Oruftb");

const contractAbi = fs.readFileSync(path.join(__dirname, "abi", "abi.js"), "utf8");
const contractAddress = "0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e";
const MAKER_FILTER = "0x6031B6eed1C97e853c6e0F03Ad3ce3529351F96d".toLowerCase();
let contract = new ethers.Contract(contractAddress, contractAbi, provider);
const iface = new ethers.utils.Interface(contractAbi);

/** Topic0 của event chứa conditionId */
const TOPIC0_CONDITION = "0x2e6bb91f8cbcda0c93623c54d0403a43514fabc40084ec96b6d5379a74786298";

type DecodedLog = { name: string; args: Record<string, string> };
type TxData = { allEventsInTx: DecodedLog[]; conditionId: string };

const txEventsCache = new Map<string, TxData>();
const assetIdToConditionId = new Map<string, string>();

function toStr(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "object" && v !== null && "toString" in v) return String((v as { toString(): string }).toString());
  return String(v);
}

/** Lấy conditionId từ receipt.logs */
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
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
      } else {
        console.error(`[getTransactionReceipt] Failed after ${maxRetries} attempts for txHash ${txHash}:`, error.message || error.code || err);
        return null;
      }
    }
  }
  return null;
}

/** Lấy tất cả event + conditionId trong cùng 1 giao dịch */
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

// Listen OrderFilled events
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
  
  // Làm tròn 2 số thập phân
  let price = Math.round((makerAmountFilled / takerAmountFilled) * 100) / 100;
  if (price <= 0.97) price += 0.02;
  
  const event = {
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

  console.log("[OrderFilled]", JSON.stringify(event));
});

/** Xử lý lỗi WebSocket và reconnect */
function setupWebSocketErrorHandling(): void {
  provider._websocket.on("error", (error: Error) => {
    console.error("[WebSocket] Error:", error.message);
  });

  provider._websocket.on("close", (code: number) => {
    console.log(`[WebSocket] Connection closed with code ${code}. Reconnecting in 5s...`);
    
    setTimeout(() => {
      console.log("[WebSocket] Attempting to reconnect...");
      provider = new ethers.providers.WebSocketProvider("wss://polygon-mainnet.g.alchemy.com/v2/XYYgx0YBjlQoRD6Oruftb");
      contract = new ethers.Contract(contractAddress, contractAbi, provider);
      setupWebSocketErrorHandling();
      console.log("[WebSocket] Reconnected successfully");
    }, 5000);
  });
}

// Main
setupWebSocketErrorHandling();
console.log("[log-tx-events] Listening for OrderFilled events...");
