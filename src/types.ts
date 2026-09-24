export type ProjectMode =
  | "pre-launch"
  | "validating_mint"
  | "locating_market"
  | "connecting_feed"
  | "seeding_population"
  | "observation_window"
  | "live"
  | "paused"
  | "error";

export interface ProjectConfig {
  id: string;
  contract_address: string | null;
  mode: ProjectMode;
  market_feed_status: string;
  evolution_status: string;
  current_generation: number;
  current_epoch: number;
  generation_interval_seconds: number;
  population_target: number;
  initialized_at: string | null;
  last_market_update: string | null;
  last_generation_at: string | null;
  is_paused: boolean;
  manual_generation_requested?: boolean;
}

export interface PairState {
  pairAddress: string;
  dexId: string;
  baseAddress: string;
  quoteAddress: string;
  priceUsd: number;
  marketCap: number | null;
  fdv: number | null;
  liquidityUsd: number;
  volumeM5: number;
  volumeH24: number;
  buysM5: number;
  sellsM5: number;
  priceChangeH24: number | null;
}

export interface Snapshot {
  timestamp: Date;
  price: number;
  volumeWindow: number;
  liquidity: number;
  buys: number;
  sells: number;
  tradeCount: number;
}

export interface MarketScores {
  volatility: number;
  activity: number;
  depth: number;
  direction: number;
  disturbance: number;
}

export interface Habitat {
  temperature: number;
  nutrients: number;
  capacity: number;
  current: number;
  disturbance: number;
}

export interface Genes {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export interface Organism {
  id: string;
  organism_number: number;
  generation_born: number;
  generation_died: number | null;
  parent_a: string | null;
  parent_b: string | null;
  lineage_id: string | null;
  gene_a: number;
  gene_b: number;
  gene_c: number;
  gene_d: number;
  gene_e: number;
  gene_f: number;
  fitness: number | null;
  alive: boolean;
  mutation_count: number;
}

export interface FitnessBreakdown {
  total: number;
  resilience: number;
  efficiency: number;
  mobility: number;
  fertility: number;
  size: number;
  plasticity: number;
}

export interface LegacyEffect {
  trait: "resilience" | "efficiency" | "mobility" | "fertility" | "size" | "plasticity";
  effect: number;
}
