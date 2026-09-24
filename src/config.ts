import "dotenv/config";

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`Invalid numeric env ${name}`);
  return value;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required env ${name}`);
  return value;
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "production",
  supabaseUrl: required("SUPABASE_URL"),
  supabaseServiceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY"),
  projectId: process.env.MENDLE_PROJECT_ID?.trim() || null,
  solanaRpcUrl: required("SOLANA_RPC_URL"),
  marketPollIntervalMs: num("MARKET_POLL_INTERVAL_MS", 2000),
  generationIntervalSeconds: num("GENERATION_INTERVAL_SECONDS", 300),
  initialObservationSeconds: num("INITIAL_OBSERVATION_SECONDS", 300),
  populationTarget: num("POPULATION_TARGET", 128),
  generationsPerEpoch: num("GENERATIONS_PER_EPOCH", 24),
  baseMutationRate: num("BASE_MUTATION_RATE", 0.015),
  disturbanceMutationBonus: num("DISTURBANCE_MUTATION_BONUS", 0.02),
  geneMutationMaxDelta: num("GENE_MUTATION_MAX_DELTA", 8),
  minSurvivors: num("MIN_SURVIVORS", 40),
  maxSurvivors: num("MAX_SURVIVORS", 100),
  baselineWindowMinutes: num("BASELINE_WINDOW_MINUTES", 60),
  depthVolumeMultiplier: num("DEPTH_VOLUME_MULTIPLIER", 2),
  disturbanceSensitivity: num("DISTURBANCE_SENSITIVITY", 1.5),
  legacyEffect: num("LEGACY_EFFECT", 0.03),
  legacyMaxEffect: num("LEGACY_MAX_EFFECT", 0.05),
  legacyDurationEpochs: num("LEGACY_DURATION_EPOCHS", 2),
  logLevel: process.env.LOG_LEVEL ?? "info",
};

export function assertConfig(): void {
  if (env.marketPollIntervalMs < 1000) throw new Error("MARKET_POLL_INTERVAL_MS must be >= 1000");
  if (env.generationIntervalSeconds < 60) throw new Error("GENERATION_INTERVAL_SECONDS must be >= 60");
  if (env.populationTarget < 16) throw new Error("POPULATION_TARGET must be >= 16");
  if (env.minSurvivors >= env.maxSurvivors) throw new Error("MIN_SURVIVORS must be < MAX_SURVIVORS");
}
