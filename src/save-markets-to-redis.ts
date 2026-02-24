import { createClient } from "redis";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

// Helper function to delay
function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

interface MarketData {
    conditionId: string;
    slug: string;
    question: string;
    clobTokenIds: string;
    negRisk: boolean;
}

interface TokenData {
    conditionId: string;
    slug: string;
    question: string;
    tokenId: string;
    negRisk: boolean;
    outcome: "up" | "down"; // Index 0 = up, Index 1 = down
}

async function getMarketBySlug(slug: string): Promise<any | null> {
    try {
        const response = await axios.get(`https://gamma-api.polymarket.com/markets/slug/${slug}`);
        return response.data;
    } catch (error: any) {
        if (error.response?.status === 404) {
            console.log(new Date().toISOString(), `  ⚠️  Market not found: ${slug}`);
        } else {
            console.error(new Date().toISOString(), `  ❌ Error fetching ${slug}:`, error.message);
        }
        return null;
    }
}

function extractTimestampFromSlug(slug: string): number | null {
    const parts = slug.split('-');
    const lastPart = parts[parts.length - 1];
    const timestamp = parseInt(lastPart);
    
    if (isNaN(timestamp)) {
        console.error(`Invalid timestamp in slug: ${slug}`);
        return null;
    }
    
    return timestamp;
}

function generateSlug(baseSlug: string, timestamp: number): string {
    const parts = baseSlug.split('-');
    parts[parts.length - 1] = timestamp.toString();
    return parts.join('-');
}

async function fetchAndSaveMarketsToRedis(startSlug: string) {
    // Extract timestamp from start slug
    const startTimestamp = extractTimestampFromSlug(startSlug);
    if (!startTimestamp) {
        throw new Error("Invalid start slug format");
    }
    
    // Calculate number of markets needed
    const INTERVAL_SECONDS = 5 * 60; // 5 minutes
    const NUM_HOURS = 12;
    const NUM_MARKETS = (NUM_HOURS * 60) / 5;
    
    console.log(new Date().toISOString(), `🔍 Will fetch ${NUM_MARKETS} markets (${NUM_HOURS} hours of 5-minute intervals)`);
    console.log(new Date().toISOString(), `Start timestamp: ${startTimestamp} (${new Date(startTimestamp * 1000).toISOString()})`);
    
    const markets: MarketData[] = [];
    
    // Fetch markets sequentially
    for (let i = 0; i < NUM_MARKETS; i++) {
        const timestamp = startTimestamp + (i * INTERVAL_SECONDS);
        const slug = generateSlug(startSlug, timestamp);
        
        console.log(new Date().toISOString(), `[${i + 1}/${NUM_MARKETS}] Fetching: ${slug}`);
        
        const market = await getMarketBySlug(slug);
        
        if (market) {
            markets.push({
                conditionId: market.conditionId || "",
                slug: market.slug || slug,
                question: market.question || market.description || "",
                clobTokenIds: market.clobTokenIds || "",
                negRisk: market.negRisk || false
            });
            
            console.log(new Date().toISOString(), `  ✅ Success: ${market.question}`);
        }
        
        // Add delay between requests to avoid rate limiting
        await delay(100);
    }

    console.log(`\n📊 Fetched ${markets.length} markets`);

    // Connect to Redis
    const redis = createClient({
        url: process.env.REDIS_URL || "redis://localhost:6379"
    });

    await redis.connect();
    console.log("✅ Connected to Redis");

    let totalTokensSaved = 0;

    // Process each market
    for (const market of markets) {
        if (!market.clobTokenIds) {
            console.log(`⚠️  Skipping market without clobTokenIds: ${market.slug}`);
            continue;
        }

        // Parse clobTokenIds (format: "[\"token1\", \"token2\"]" - JSON array string)
        // Index 0 = UP, Index 1 = DOWN
        let tokenIds: string[];
        try {
            tokenIds = JSON.parse(market.clobTokenIds);
        } catch (error) {
            console.log(`⚠️  Invalid clobTokenIds JSON for ${market.slug}: ${market.clobTokenIds}`);
            continue;
        }

        if (!Array.isArray(tokenIds) || tokenIds.length !== 2) {
            console.log(`⚠️  Invalid clobTokenIds format for ${market.slug}: expected 2 tokens, got ${tokenIds.length}`);
            continue;
        }

        const [upTokenId, downTokenId] = tokenIds;

        // Create data for UP token (index 0)
        const upTokenData: TokenData = {
            conditionId: market.conditionId,
            slug: market.slug,
            question: market.question,
            tokenId: upTokenId,
            negRisk: market.negRisk,
            outcome: "up"
        };

        // Create data for DOWN token (index 1)
        const downTokenData: TokenData = {
            conditionId: market.conditionId,
            slug: market.slug,
            question: market.question,
            tokenId: downTokenId,
            negRisk: market.negRisk,
            outcome: "down"
        };

        // Save to Redis with keys: token:{tokenId} and 24 hour expiry (86400 seconds)
        const EXPIRY_SECONDS = 86400; // 24 hours
        await redis.set(`token:${upTokenId}`, JSON.stringify(upTokenData), { EX: EXPIRY_SECONDS });
        await redis.set(`token:${downTokenId}`, JSON.stringify(downTokenData), { EX: EXPIRY_SECONDS });

        totalTokensSaved += 2;

        console.log(`✅ Saved tokens for ${market.slug}: ${upTokenId} (up), ${downTokenId} (down)`);
    }

    console.log(`\n🎉 Successfully saved ${totalTokensSaved} tokens to Redis`);
    console.log(`📊 Markets processed: ${markets.length}`);
    console.log(`⏱️  Keys will expire in 24 hours (86400 seconds)`);

    await redis.disconnect();
}

// Query example function
async function queryTokenFromRedis(tokenId: string) {
    const redis = createClient({
        url: process.env.REDIS_URL || "redis://localhost:6379"
    });

    await redis.connect();

    const data = await redis.get(`token:${tokenId}`);
    
    await redis.disconnect();

    if (data) {
        const tokenData: TokenData = JSON.parse(data);
        console.log(`\n🔍 Found token ${tokenId}:`);
        console.log(tokenData);
        return tokenData;
    } else {
        console.log(`⚠️  Token ${tokenId} not found in Redis`);
        return null;
    }
}

// Main execution
async function main() {
    const command = process.argv[2];

    if (command === "query") {
        const tokenId = process.argv[3];
        if (!tokenId) {
            console.error("Usage: tsx src/save-markets-to-redis.ts query <tokenId>");
            process.exit(1);
        }
        await queryTokenFromRedis(tokenId);
    } else {
        // Fetch và save vào Redis
        const startSlug = process.argv[2] || "btc-updown-5m-1771837500";
        console.log(new Date().toISOString(), `Starting with slug: ${startSlug}`);
        await fetchAndSaveMarketsToRedis(startSlug);
    }
}

main().catch((error) => {
    console.error("❌ Fatal error:", error);
    process.exit(1);
});
