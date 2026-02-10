#!/usr/bin/env node
/**
 * Đọc paid-orders.json, in ra tổng usdcSize và tổng số lệnh.
 * Chạy: npm run sum-paid  hoặc  node scripts/sum-paid-orders.js
 */

const fs = require("fs");
const path = require("path");

const filePath = path.join(__dirname, "..", "paid-orders.json");

if (!fs.existsSync(filePath)) {
  console.error("Không tìm thấy paid-orders.json");
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
const orders = Array.isArray(data) ? data : [];

const totalUsdcSize = orders.reduce((s, o) => s + (Number(o.usdcSize) || 0), 0);
const count = orders.length;

// Tổng theo từng outcome
const byOutcome = {};
for (const o of orders) {
  const out = String(o.outcome ?? "(no outcome)");
  if (!byOutcome[out]) byOutcome[out] = { count: 0, usdcSize: 0 };
  byOutcome[out].count += 1;
  byOutcome[out].usdcSize += Number(o.usdcSize) || 0;
}

console.log("paid-orders.json:");
console.log("  Tổng số lệnh:", count);
console.log("  Tổng usdcSize (USDC):", totalUsdcSize.toFixed(4));
console.log("");
console.log("Theo outcome:");
const outcomes = Object.keys(byOutcome).sort();
for (const out of outcomes) {
  const { count: n, usdcSize: sum } = byOutcome[out];
  console.log("  ", out + ":", n, "lệnh, usdcSize:", sum.toFixed(4), "USDC");
}
