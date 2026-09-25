import type { PairState, Snapshot } from "./types.js";
import { safeNumber } from "./utils.js";

const DEX = "https://api.dexscreener.com";

async function dexFetch(url: string): Promise<Response> {
  let lastStatus = 0;
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
    });
    if (response.ok) return response;

    lastStatus = response.status;
    if (response.status !== 429 && response.status < 500) {
      throw new Error(`DexScreener HTTP ${response.status}`);
    }

    const retryAfter = Number(response.headers.get("retry-after"));
    const delayMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : Math.min(15000, 1500 * 2 ** attempt);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(`DexScreener HTTP ${lastStatus || 429} after retries`);
}

export async function validateSolanaMint(rpcUrl: string, mint: string): Promise<{ supply: number; decimals: number }> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getTokenSupply",
      params: [mint, { commitment: "confirmed" }],
    }),
  });
  if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
  const json = await response.json() as any;
  if (json.error) throw new Error(`Invalid mint or RPC error: ${json.error.message ?? JSON.stringify(json.error)}`);
  const value = json?.result?.value;
  if (!value) throw new Error("Mint returned no token supply");
  return {
    supply: safeNumber(value.uiAmountString ?? value.uiAmount, 0),
    decimals: safeNumber(value.decimals, 0),
  };
}

export async function discoverPair(mint: string): Promise<PairState | null> {
  const response = await dexFetch(`${DEX}/token-pairs/v1/solana/${mint}`);
  const pairs = await response.json() as any[];
  if (!Array.isArray(pairs) || !pairs.length) return null;

  const relevant = pairs.filter((p) =>
    p?.baseToken?.address === mint || p?.quoteToken?.address === mint
  );
  if (!relevant.length) return null;

  relevant.sort((a, b) => safeNumber(b?.liquidity?.usd) - safeNumber(a?.liquidity?.usd));
  return parsePair(relevant[0], mint);
}

export async function fetchPair(pairAddress: string, mint: string): Promise<PairState> {
  const response = await dexFetch(`${DEX}/latest/dex/pairs/solana/${pairAddress}`);
  const json = await response.json() as any;
  const pair = json?.pairs?.[0];
  if (!pair) throw new Error("Pair disappeared from DexScreener");
  return parsePair(pair, mint);
}

function parsePair(pair: any, mint: string): PairState {
  const buys = safeNumber(pair?.txns?.m5?.buys);
  const sells = safeNumber(pair?.txns?.m5?.sells);
  return {
    pairAddress: String(pair.pairAddress),
    dexId: String(pair.dexId ?? "unknown"),
    baseAddress: String(pair?.baseToken?.address ?? ""),
    quoteAddress: String(pair?.quoteToken?.address ?? ""),
    priceUsd: safeNumber(pair.priceUsd),
    marketCap: pair.marketCap == null ? null : safeNumber(pair.marketCap),
    fdv: pair.fdv == null ? null : safeNumber(pair.fdv),
    liquidityUsd: safeNumber(pair?.liquidity?.usd),
    volumeM5: safeNumber(pair?.volume?.m5),
    volumeH24: safeNumber(pair?.volume?.h24),
    buysM5: buys,
    sellsM5: sells,
    priceChangeH24: pair?.priceChange?.h24 == null ? null : safeNumber(pair.priceChange.h24),
  };
}

export function toSnapshot(pair: PairState): Snapshot {
  return {
    timestamp: new Date(),
    price: pair.priceUsd,
    volumeWindow: pair.volumeM5,
    liquidity: pair.liquidityUsd,
    buys: pair.buysM5,
    sells: pair.sellsM5,
    tradeCount: pair.buysM5 + pair.sellsM5,
  };
}
