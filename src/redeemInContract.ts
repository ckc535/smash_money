import { ethers } from "ethers";
import axios from "axios";
import dotenv from "dotenv";
import { RelayClient } from "@polymarket/builder-relayer-client";
dotenv.config();

const CTF_CONTRACT_ADDRESS = "0x4d97dcd97ec945f40cf65f87097ace5ea0476045";
const USDCE_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const PROXY_WALLET = process.env.PROXY_WALLET!;
const PRIVATE_KEY = process.env.PRIVATE_KEY!;
const RPC_URL = process.env.RPC_URL || "https://polygon.drpc.org";
const RELAYER_URL = process.env.RELAYER_URL || process.env.POLYMARKET_RELAYER_URL!;
const POLYGON_CHAIN_ID = 137;

const RESOLVED_HIGH = 0.99; // Position won (price ~$1)
const RESOLVED_LOW = 0.01; // Position lost (price ~$0)
const ZERO_THRESHOLD = 0.0001;

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

// CTF Contract ABI (only the functions we need)
const CTF_ABI = [
  "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] calldata indexSets) external",
  "function balanceOf(address owner, uint256 tokenId) external view returns (uint256)",
  "function payoutDenominator(bytes32 conditionId) external view returns (uint256)",
  "function payoutNumerators(bytes32 conditionId, uint256 indexSet) external view returns (uint256)",
];

const loadPositions = async (address: string): Promise<Position[]> => {
  const url = `https://data-api.polymarket.com/positions?user=0x2765B2B2DD655169a9D34E21fd80229fEbF4dc7F&sizeThreshold=.1&redeemable=true&limit=100&offset=0${address}`;
  const response = await axios.get(url);
  const data = response.data;
  const positions = Array.isArray(data) ? (data as Position[]) : [];
  return positions.filter((pos) => (pos.size || 0) > ZERO_THRESHOLD);
};

/**
 * Normalize conditionId to ensure it's a valid hex string
 */
function normalizeConditionId(conditionId: string): string {
  if (!conditionId || typeof conditionId !== "string") {
    throw new Error(
      `Invalid conditionId: ${conditionId}. Must be a non-empty string.`
    );
  }

  // Remove any whitespace
  let normalized = conditionId.trim();

  // Ensure it starts with 0x
  if (!normalized.startsWith("0x")) {
    normalized = "0x" + normalized;
  }

  return normalized;
}

/**
 * Tạo redeem tx giống createRedeemTx trong magic-proxy-builder-example / redeem.ts.
 * Dùng indexSets [1, 2] để redeem cả YES và NO.
 */
function createRedeemTx(position: Position): { to: string; data: string; value: string } {
  const iface = new ethers.utils.Interface(CTF_ABI);
  const parentCollectionId = ethers.constants.HashZero;
  const normalizedConditionId = normalizeConditionId(position.conditionId);
  let hexWithoutPrefix = normalizedConditionId.startsWith("0x")
    ? normalizedConditionId.slice(2)
    : normalizedConditionId;
  hexWithoutPrefix = hexWithoutPrefix.padStart(64, "0");
  const conditionIdBytes32 = "0x" + hexWithoutPrefix;
  const indexSets = [1, 2];
  const data = iface.encodeFunctionData("redeemPositions", [
    USDCE_ADDRESS,
    parentCollectionId,
    conditionIdBytes32,
    indexSets,
  ]);
  return {
    to: CTF_CONTRACT_ADDRESS,
    data,
    value: "0",
  };
}

/**
 * Redeem một position qua Relay API (giống useRedeemPosition: createRedeemTx → relay execute).
 */
const redeemPosition = async (
  position: Position,
  relayClient: RelayClient
): Promise<{ success: boolean; error?: string }> => {
  try {
    console.log(`   Attempting redemption via relay API...`);
    console.log(`   Condition ID: ${position.conditionId}`);
    console.log(
      `   Position: ${position.title || position.slug || position.asset}`
    );
    console.log(`   Size: ${position.size.toFixed(2)} tokens`);

    const redeemTx = createRedeemTx(position);
    const description = `Redeem position for condition ${position.conditionId}`;

    const response = await relayClient.execute([redeemTx], description);
    if (!response || typeof response.wait !== "function") {
      throw new Error("Relay execute did not return a waitable response");
    }

    console.log(`   ⏳ Waiting for confirmation...`);
    const waitTimeout = new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error("Transaction confirmation timeout after 5 minutes")),
        300000
      );
    });
    const result = await Promise.race([response.wait(), waitTimeout]) as { transactionHash?: string; status?: number };

    if (result?.status === 0) {
      console.log(`   ❌ Transaction reverted`);
      return { success: false, error: "Transaction reverted" };
    }
    console.log(
      `   ✅ Redemption successful! Tx: ${result?.transactionHash ?? "unknown"}`
    );
    return { success: true };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const isAlreadyKnown =
      errorMessage.toLowerCase().includes("already exists") ||
      errorMessage.toLowerCase().includes("already known") ||
      errorMessage.includes("ALREADY_EXISTS");
    if (isAlreadyKnown) {
      console.log(`   ✅ Transaction already submitted (treating as success)`);
      return { success: true };
    }
    console.log(`   ❌ Redemption failed: ${errorMessage}`);
    return { success: false, error: errorMessage };
  }
};

export const runRedeem = async () => {
  console.log("🚀 Redeeming resolved positions");
  console.log("════════════════════════════════════════════════════");
  console.log(`Wallet: ${PROXY_WALLET}`);
  console.log(`CTF Contract: ${CTF_CONTRACT_ADDRESS}`);
  console.log(`Win threshold: price >= $${RESOLVED_HIGH}`);
  console.log(`Loss threshold: price <= $${RESOLVED_LOW}`);

  // Setup provider and signer
  const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

  console.log(`\n✅ Connected to Polygon RPC`);
  console.log(`Signer address: ${wallet.address}`);

  if (!RELAYER_URL) {
    throw new Error(
      "RELAYER_URL or POLYMARKET_RELAYER_URL is required. Set it in .env (see Polymarket builder-relayer docs)."
    );
  }
  const relayClient = new RelayClient(RELAYER_URL, POLYGON_CHAIN_ID, wallet);
  console.log(`   Relay: ${RELAYER_URL}`);

  if (wallet.address.toLowerCase() !== PROXY_WALLET.toLowerCase()) {
    console.log(
      `⚠️  Note: Signer (${wallet.address}) differs from proxy wallet (${PROXY_WALLET})`
    );
  }

  // Load positions
  const allPositions = await loadPositions(PROXY_WALLET);

  if (allPositions.length === 0) {
    console.log("\n🎉 No open positions detected for proxy wallet.");
    return;
  }

  // Filter for resolved and redeemable positions
  const redeemablePositions = allPositions.filter(
    (pos) =>
      (pos.curPrice >= RESOLVED_HIGH || pos.curPrice <= RESOLVED_LOW) &&
      pos.redeemable === true
  );

  const activePositions = allPositions.filter(
    (pos) => pos.curPrice > RESOLVED_LOW && pos.curPrice < RESOLVED_HIGH
  );

  console.log(`\n📊 Position statistics:`);
  console.log(`   Total positions: ${allPositions.length}`);
  console.log(`   ✅ Resolved and redeemable: ${redeemablePositions.length}`);
  console.log(`   ⏳ Active (not touching): ${activePositions.length}`);

  if (redeemablePositions.length === 0) {
    console.log("\n✅ No positions to redeem.");
    return;
  }

  console.log(`\n🔄 Redeeming ${redeemablePositions.length} positions...`);
  console.log(`⚠️  WARNING: Each redemption requires gas fees on Polygon`);

  let successCount = 0;
  let failCount = 0;
  let totalValue = 0;

  // Group positions by conditionId to avoid duplicate redemptions
  const positionsByCondition = new Map<string, Position[]>();
  redeemablePositions.forEach((pos) => {
    const existing = positionsByCondition.get(pos.conditionId) || [];
    existing.push(pos);
    positionsByCondition.set(pos.conditionId, existing);
  });

  console.log(
    `\n📦 Grouped into ${positionsByCondition.size} unique conditions`
  );

  let conditionIndex = 0;
  for (const [conditionId, positions] of positionsByCondition.entries()) {
    conditionIndex++;
    const totalPositionValue = positions.reduce(
      (sum, pos) => sum + pos.currentValue,
      0
    );

    console.log(`\n${"=".repeat(60)}`);
    console.log(`Condition ${conditionIndex}/${positionsByCondition.size}`);
    console.log(`Condition ID: ${conditionId}`);
    console.log(`Positions in this condition: ${positions.length}`);
    console.log(`Total expected value: $${totalPositionValue.toFixed(2)}`);

    // Show all positions for this condition
    positions.forEach((pos, idx) => {
      const status = pos.curPrice >= RESOLVED_HIGH ? "🎉" : "❌";
      console.log(
        `   ${status} ${pos.title || pos.slug} | ${
          pos.outcome
        } | ${pos.size.toFixed(2)} tokens | $${pos.currentValue.toFixed(2)}`
      );
    });

    const result = await redeemPosition(positions[0], relayClient);

    if (result.success) {
      successCount++;
      totalValue += totalPositionValue;
    } else {
      failCount++;
    }

    // Small delay between transactions
    if (conditionIndex < positionsByCondition.size) {
      console.log(`   ⏳ Waiting 2s before next transaction...`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  console.log("\n════════════════════════════════════════════════════");
  console.log("✅ Summary of position redemption");
  console.log(`Conditions processed: ${positionsByCondition.size}`);
  console.log(`Successful redemptions: ${successCount}`);
  console.log(`Failed: ${failCount}`);
  console.log(
    `Expected value of redeemed positions: $${totalValue.toFixed(2)}`
  );
  console.log("════════════════════════════════════════════════════\n");
};

//run Reddem
runRedeem();
