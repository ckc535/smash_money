import { createWalletClient, Hex, http, encodeFunctionData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { RelayClient, RelayerTxType } from "@polymarket/builder-relayer-client";
import { BuilderConfig } from "@polymarket/builder-signing-sdk";
import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

const CTF_CONTRACT_ADDRESS = "0x4d97dcd97ec945f40cf65f87097ace5ea0476045";
const USDCE_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const PROXY_WALLET = process.env.PROXY_WALLET!;
const RESOLVED_HIGH = 0.99;
const RESOLVED_LOW = 0.01;
const ZERO_THRESHOLD = 0.0001;

const REDEEM_ABI = [
  {
    name: "redeemPositions",
    type: "function",
    inputs: [
      { name: "collateralToken", type: "address" },
      { name: "parentCollectionId", type: "bytes32" },
      { name: "conditionId", type: "bytes32" },
      { name: "indexSets", type: "uint256[]" },
    ],
    outputs: [],
  },
] as const;

interface Position {
  asset: string;
  conditionId: string;
  size: number;
  avgPrice: number;
  currentValue: number;
  curPrice: number;
  title?: string;
  outcome?: string;
  slug?: string;
  redeemable?: boolean;
}

async function loadPositions(address: string): Promise<Position[]> {
  const url = `https://data-api.polymarket.com/positions?user=${address}&sizeThreshold=.1&redeemable=true&limit=100&offset=0`;
  const response = await axios.get(url);
  const data = response.data;
  const positions = Array.isArray(data) ? (data as Position[]) : [];
  return positions.filter((pos) => (pos.size || 0) > ZERO_THRESHOLD);
}

function normalizeConditionId(conditionId: string): Hex {
  if (!conditionId || typeof conditionId !== "string") {
    throw new Error(`Invalid conditionId: ${conditionId}. Must be a non-empty string.`);
  }
  let normalized = conditionId.trim();
  if (!normalized.startsWith("0x")) {
    normalized = "0x" + normalized;
  }
  const hexWithoutPrefix = normalized.slice(2).padStart(64, "0");
  return ("0x" + hexWithoutPrefix) as Hex;
}

function createRedeemTx(conditionId: string): { to: `0x${string}`; data: Hex; value: string } {
  const parentCollectionId = ("0x" + "0".repeat(64)) as Hex;
  const conditionIdBytes32 = normalizeConditionId(conditionId);
  const indexSets = [1, 2];
  const data = encodeFunctionData({
    abi: REDEEM_ABI,
    functionName: "redeemPositions",
    args: [USDCE_ADDRESS as Hex, parentCollectionId, conditionIdBytes32, indexSets],
  });
  return {
    to: CTF_CONTRACT_ADDRESS as `0x${string}`,
    data,
    value: "0",
  };
}

export async function runRedeem(): Promise<void> {
  const relayerUrl = process.env.RELAYER_URL || process.env.POLYMARKET_RELAYER_URL!;
  const chainId = 137;
  const builderConfig = new BuilderConfig({
    localBuilderCreds: {
      key: process.env.POLY_BUILDER_API_KEY!,
      secret: process.env.POLY_BUILDER_SECRET!,
      passphrase: process.env.POLY_BUILDER_PASSPHRASE!,
    },
  });

  const account = privateKeyToAccount(process.env.PRIVATE_KEY as Hex);
  const wallet = createWalletClient({
    account,
    chain: polygon,
    transport: http(process.env.RPC_URL || "https://polygon.drpc.org"),
  });

  const client = new RelayClient(relayerUrl, chainId, wallet, builderConfig, RelayerTxType.PROXY);
//   console.log("client", client);

  console.log("🚀 Redeeming resolved positions");
  console.log("════════════════════════════════════════════════════");
  console.log(`Proxy wallet: ${PROXY_WALLET}`);
  console.log(`CTF Contract: ${CTF_CONTRACT_ADDRESS}`);

  const allPositions = await loadPositions(PROXY_WALLET);
  if (allPositions.length === 0) {
    console.log("\n🎉 No open positions for proxy wallet.");
    return;
  }

  const redeemablePositions = allPositions.filter(
    (pos) =>
      (pos.curPrice >= RESOLVED_HIGH) &&
      pos.redeemable === true
  );

  const positionsByCondition = new Map<string, Position[]>();
  redeemablePositions.forEach((pos) => {
    const existing = positionsByCondition.get(pos.conditionId) || [];
    existing.push(pos);
    positionsByCondition.set(pos.conditionId, existing);
  });

  if (positionsByCondition.size === 0) {
    console.log("\n✅ No positions to redeem.");
    return;
  }

  console.log(`\n📦 ${positionsByCondition.size} unique condition(s) to redeem`);
  console.log(`🔄 Calling redeemPositions for each condition...\n`);

  let successCount = 0;
  let failCount = 0;
  let conditionIndex = 0;

  for (const [conditionId, positions] of positionsByCondition.entries()) {
    conditionIndex++;
    const totalValue = positions.reduce((sum, pos) => sum + pos.currentValue, 0);

    console.log(`${"=".repeat(60)}`);
    console.log(`Condition ${conditionIndex}/${positionsByCondition.size}: ${conditionId}`);
    console.log(`  Positions: ${positions.length} | Expected value: $${totalValue.toFixed(2)}`);

    let txHash: string | undefined;
    let success = false;

    try {
      const redeemTx = createRedeemTx(conditionId);
      const response = await client.execute([redeemTx], `Redeem condition ${conditionId}`);
      if (response && typeof response.wait === "function") {
        const result = (await response.wait()) as { transactionHash?: string; status?: number };
        if (result?.status === 0) {
          console.log(`  ❌ Tx reverted`);
          failCount++;
        } else {
          txHash = result?.transactionHash;
          console.log(`  ✅ Redeemed. Tx: ${txHash ?? "unknown"}`);
          successCount++;
          success = true;
        }
      } else {
        console.log(`  ✅ Submitted`);
        successCount++;
        success = true;
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      const alreadyKnown =
        /already exists|already known|ALREADY_EXISTS/i.test(msg);
      if (alreadyKnown) {
        console.log(`  ✅ Already submitted (ok)`);
        successCount++;
        success = true;
      } else {
        console.log(`  ❌ Error: ${msg}`);
        failCount++;
      }
    }

    if (conditionIndex < positionsByCondition.size) {
      console.log(`  ⏳ Waiting 500ms before next condition...`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  console.log("\n════════════════════════════════════════════════════");
  console.log("✅ Summary");
  console.log(`  Conditions: ${positionsByCondition.size} | OK: ${successCount} | Failed: ${failCount}`);
  console.log("════════════════════════════════════════════════════\n");
}

