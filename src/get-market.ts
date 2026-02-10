import dotenv from "dotenv";
import { ClobClient } from "@polymarket/clob-client";
import { Wallet } from "ethers";

dotenv.config();

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

async function main() {
  const client = await getClobClient();
  //bỏ viết in hoa conditionId

  const market = await client.getMarket("0xe320a663261b9eee9e530d569c92b8ba3baaea04b6be8eaf00a6441a7e23262a")
  console.log(JSON.stringify(market, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
