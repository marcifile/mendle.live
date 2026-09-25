import type { Habitat, MarketScores, PairState } from "./types.js";
import { clamp, mean, safeNumber } from "./utils.js";
import { env } from "./config.js";

function realizedVolatility(prices: number[]): number {
  const clean = prices.filter((p) => p > 0);
  if (clean.length < 2) return 0;
  const returns: number[] = [];
  for (let i = 1; i < clean.length; i++) {
    returns.push(Math.log(clean[i]! / clean[i - 1]!));
  }
  if (!returns.length) return 0;
  return Math.sqrt(mean(returns.map((r) => r * r)));
}

function ratioScore(current: number, baseline: number): number {
  if (current <= 0 && baseline <= 0) return 0;
  const safeBase = baseline > 0 ? baseline : Math.max(current, 1e-9);
  return clamp((current / safeBase) / 2);
}

export function calculateMarketScores(
  snapshots: any[],
  latest: PairState,
  priorScores: any[],
  generationWindowMinutes: number,
): MarketScores {
  const cutoff = Date.now() - generationWindowMinutes * 60_000;
  const current = snapshots.filter((s) => new Date(s.timestamp).getTime() >= cutoff);
  const baseline = snapshots.filter((s) => new Date(s.timestamp).getTime() < cutoff);

  const currentVol = realizedVolatility(current.map((s) => safeNumber(s.price)));
  const baselineVol = realizedVolatility(baseline.map((s) => safeNumber(s.price)));
  // During the very first observation window there is no earlier regime to compare
  // against. Treat the current window as its own provisional baseline instead of
  // forcing volatility to ~1.0.
  const volatility = currentVol === 0
    ? 0
    : baselineVol > 0
      ? clamp(currentVol / (currentVol + baselineVol))
      : 0.5;

  const baselineVolume = mean(baseline.map((s) => safeNumber(s.volume_window)).filter((v) => v > 0));
  const baselineTrades = mean(baseline.map((s) => safeNumber(s.trade_count)).filter((v) => v > 0));
  const volumeScore = ratioScore(latest.volumeM5, baselineVolume || latest.volumeM5);
  const tradeScore = ratioScore(latest.buysM5 + latest.sellsM5, baselineTrades || latest.buysM5 + latest.sellsM5);
  const activity = clamp(0.5 * volumeScore + 0.5 * tradeScore);

  const depthDenom = latest.liquidityUsd + latest.volumeM5 * env.depthVolumeMultiplier;
  const depth = depthDenom > 0 ? clamp(latest.liquidityUsd / depthDenom) : 0;

  // Prefer directional USD volume from the newest persisted snapshot. The
  // current DexScreener adapter estimates those side volumes from buy/sell
  // counts, but keeping the score volume-based here lets a richer market
  // adapter provide true side volume later without changing the genetics model.
  const newestSnapshot = current[current.length - 1];
  const buyVolume = safeNumber(newestSnapshot?.buy_volume);
  const sellVolume = safeNumber(newestSnapshot?.sell_volume);
  const directionalVolume = buyVolume + sellVolume;
  const txnTotal = latest.buysM5 + latest.sellsM5;
  const direction = directionalVolume > 0
    ? clamp((buyVolume - sellVolume) / directionalVolume, -1, 1)
    : txnTotal > 0
      ? clamp((latest.buysM5 - latest.sellsM5) / txnTotal, -1, 1)
      : 0;

  let disturbance = 0;
  if (priorScores.length) {
    const baseV = mean(priorScores.map((s) => safeNumber(s.volatility)));
    const baseA = mean(priorScores.map((s) => safeNumber(s.activity)));
    const baseD = mean(priorScores.map((s) => safeNumber(s.depth)));
    const baseR = mean(priorScores.map((s) => safeNumber(s.direction)));
    const delta = mean([
      Math.abs(volatility - baseV),
      Math.abs(activity - baseA),
      Math.abs(depth - baseD),
      Math.abs(direction - baseR) / 2,
    ]);
    disturbance = clamp(delta * env.disturbanceSensitivity);
  }

  return { volatility, activity, depth, direction, disturbance };
}

export function scoresToHabitat(scores: MarketScores): Habitat {
  return {
    temperature: scores.volatility,
    nutrients: scores.activity,
    capacity: scores.depth,
    current: scores.direction,
    disturbance: scores.disturbance,
  };
}
