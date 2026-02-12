import fs from "fs";
import path from "path";
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

async function fetchBTC15mMarkets(startSlug: string) {
    try {
        console.log(new Date().toISOString(), "🔍 Starting to fetch BTC 15m markets...");
        console.log(new Date().toISOString(), `Start slug: ${startSlug}`);
        
        // Extract timestamp from start slug
        const startTimestamp = extractTimestampFromSlug(startSlug);
        if (!startTimestamp) {
            throw new Error("Invalid start slug format");
        }
        
        // Calculate number of markets needed
        // 20 hours = 20 * 60 / 15 = 80 markets (15 minutes each)
        const INTERVAL_SECONDS = 15 * 60; // 15 minutes
        const NUM_HOURS = 20;
        const NUM_MARKETS = (NUM_HOURS * 60) / 15;
        
        console.log(new Date().toISOString(), `Will fetch ${NUM_MARKETS} markets (${NUM_HOURS} hours of 15-minute intervals)`);
        console.log(new Date().toISOString(), `Start timestamp: ${startTimestamp} (${new Date(startTimestamp * 1000).toISOString()})`);
        
        const markets: MarketData[] = [];
        
        // Fetch markets sequentially
        for (let i = 0; i < NUM_MARKETS; i++) {
            const timestamp = startTimestamp + (i * INTERVAL_SECONDS);
            const slug = generateSlug(startSlug, timestamp);
            
            console.log(new Date().toISOString(), `\n[${i + 1}/${NUM_MARKETS}] Fetching: ${slug}`);
            console.log(new Date().toISOString(), `  Timestamp: ${timestamp} (${new Date(timestamp * 1000).toISOString()})`);
            
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
                console.log(new Date().toISOString(), `     ConditionId: ${market.conditionId}`);
                console.log(new Date().toISOString(), `     ClobTokenIds: ${market.clobTokenIds}`);
                console.log(new Date().toISOString(), `     NegRisk: ${market.negRisk}`);
            }
            
            // Add delay between requests to avoid rate limiting
            await delay(500);
        }
        
        // Write results to file
        const outputFile = path.join(__dirname, "..", "btc-15m-markets.json");
        fs.writeFileSync(outputFile, JSON.stringify(markets, null, 2));
        
        console.log(new Date().toISOString(), `\n✅ Finished fetching markets`);
        console.log(new Date().toISOString(), `📝 Successfully fetched ${markets.length}/${NUM_MARKETS} markets`);
        console.log(new Date().toISOString(), `💾 Results saved to: ${outputFile}`);
        
    } catch (error) {
        console.error(new Date().toISOString(), "❌ Error fetching markets:", error);
    }
}

// Main execution
async function main() {
    // Example: btc-updown-15m-1770871500
    const startSlug = process.argv[2] || "btc-updown-15m-1770871500";
    
    console.log(new Date().toISOString(), `Starting with slug: ${startSlug}`);
    await fetchBTC15mMarkets(startSlug);
}

main().catch((error) => {
    console.error(new Date().toISOString(), "❌ Fatal error:", error);
    process.exit(1);
});
