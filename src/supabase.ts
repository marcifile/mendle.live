import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { env } from "./config.js";
import type { Habitat, MarketScores, Organism, ProjectConfig, Snapshot } from "./types.js";
import { iso } from "./utils.js";

export class Store {
  readonly db: SupabaseClient;
  private projectId: string | null = env.projectId;

  constructor() {
    this.db = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  async project(): Promise<ProjectConfig> {
    if (this.projectId) {
      const { data, error } = await this.db.from("project_config").select("*").eq("id", this.projectId).single();
      if (error) throw error;
      return data as ProjectConfig;
    }

    const { data, error } = await this.db.from("project_config").select("*").limit(2);
    if (error) throw error;
    if (!data || data.length !== 1) {
      throw new Error(`Expected exactly one project_config row, found ${data?.length ?? 0}. Set MENDLE_PROJECT_ID.`);
    }
    this.projectId = data[0]!.id;
    return data[0] as ProjectConfig;
  }

  async projectIdValue(): Promise<string> {
    if (!this.projectId) await this.project();
    return this.projectId!;
  }

  async updateProject(patch: Record<string, unknown>): Promise<void> {
    const id = await this.projectIdValue();
    const { error } = await this.db.from("project_config").update({ ...patch, updated_at: iso() }).eq("id", id);
    if (error) throw error;
  }

  async log(event: string, message: string, level = "info"): Promise<void> {
    const project_id = await this.projectIdValue();
    const { error } = await this.db.from("operator_logs").insert({ project_id, level, event, message });
    if (error) throw error;
  }

  async setMarketState(state: Record<string, unknown>): Promise<void> {
    const project_id = await this.projectIdValue();
    const { data, error } = await this.db.from("market_state").select("id").eq("project_id", project_id).limit(1);
    if (error) throw error;
    if (data?.[0]?.id) {
      const res = await this.db.from("market_state").update({ ...state, updated_at: iso() }).eq("id", data[0].id);
      if (res.error) throw res.error;
    } else {
      const res = await this.db.from("market_state").insert({ project_id, ...state, updated_at: iso() });
      if (res.error) throw res.error;
    }
  }

  async insertSnapshot(s: Snapshot): Promise<void> {
    const project_id = await this.projectIdValue();
    const total = Math.max(1, s.buys + s.sells);
    const estimatedBuyVolume = s.volumeWindow * (s.buys / total);
    const estimatedSellVolume = s.volumeWindow * (s.sells / total);
    const { error } = await this.db.from("market_snapshots").insert({
      project_id,
      timestamp: s.timestamp.toISOString(),
      price: s.price,
      volume_window: s.volumeWindow,
      liquidity: s.liquidity,
      buy_volume: estimatedBuyVolume,
      sell_volume: estimatedSellVolume,
      trade_count: s.tradeCount,
    });
    if (error) throw error;
  }

  async recentSnapshots(minutes: number): Promise<any[]> {
    const project_id = await this.projectIdValue();
    const since = new Date(Date.now() - minutes * 60_000).toISOString();
    const { data, error } = await this.db
      .from("market_snapshots")
      .select("*")
      .eq("project_id", project_id)
      .gte("timestamp", since)
      .order("timestamp", { ascending: true })
      .limit(10000);
    if (error) throw error;
    return data ?? [];
  }

  async recentScores(limit = 12): Promise<any[]> {
    const project_id = await this.projectIdValue();
    const { data, error } = await this.db
      .from("market_scores")
      .select("*")
      .eq("project_id", project_id)
      .order("generation", { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data ?? [];
  }

  async insertScores(generation: number, scores: MarketScores, start: Date, end: Date): Promise<void> {
    const project_id = await this.projectIdValue();
    const { error } = await this.db.from("market_scores").insert({
      project_id,
      generation,
      ...scores,
      window_started_at: start.toISOString(),
      window_ended_at: end.toISOString(),
    });
    if (error) throw error;
  }

  async insertHabitat(generation: number, h: Habitat): Promise<void> {
    const project_id = await this.projectIdValue();
    const { error } = await this.db.from("habitats").insert({ project_id, generation, ...h });
    if (error) throw error;
  }

  async aliveOrganisms(): Promise<Organism[]> {
    const project_id = await this.projectIdValue();
    const { data, error } = await this.db.from("organisms").select("*").eq("project_id", project_id).eq("alive", true);
    if (error) throw error;
    return (data ?? []) as Organism[];
  }

  async allOrganismsForLineage(lineageId: string): Promise<Organism[]> {
    const project_id = await this.projectIdValue();
    const { data, error } = await this.db.from("organisms").select("*").eq("project_id", project_id).eq("lineage_id", lineageId);
    if (error) throw error;
    return (data ?? []) as Organism[];
  }

  async nextOrganismNumber(): Promise<number> {
    const project_id = await this.projectIdValue();
    const { data, error } = await this.db
      .from("organisms")
      .select("organism_number")
      .eq("project_id", project_id)
      .order("organism_number", { ascending: false })
      .limit(1);
    if (error) throw error;
    return Number(data?.[0]?.organism_number ?? 0) + 1;
  }

  async nextLineageNumber(): Promise<number> {
    const project_id = await this.projectIdValue();
    const { data, error } = await this.db
      .from("lineages")
      .select("lineage_number")
      .eq("project_id", project_id)
      .order("lineage_number", { ascending: false })
      .limit(1);
    if (error) throw error;
    return Number(data?.[0]?.lineage_number ?? 0) + 1;
  }

  async createLineage(payload: Record<string, unknown>): Promise<string> {
    const project_id = await this.projectIdValue();
    const { data, error } = await this.db.from("lineages").insert({ project_id, ...payload }).select("id").single();
    if (error) throw error;
    return data.id as string;
  }

  async insertOrganisms(rows: Record<string, unknown>[]): Promise<Organism[]> {
    const project_id = await this.projectIdValue();
    const { data, error } = await this.db.from("organisms").insert(rows.map((r) => ({ project_id, ...r }))).select("*");
    if (error) throw error;
    return (data ?? []) as Organism[];
  }

  async updateOrganism(id: string, patch: Record<string, unknown>): Promise<void> {
    const { error } = await this.db.from("organisms").update(patch).eq("id", id);
    if (error) throw error;
  }

  async updateLineage(id: string, patch: Record<string, unknown>): Promise<void> {
    const { error } = await this.db.from("lineages").update(patch).eq("id", id);
    if (error) throw error;
  }

  async insertGeneration(row: Record<string, unknown>): Promise<void> {
    const project_id = await this.projectIdValue();
    const { error } = await this.db.from("generations").insert({ project_id, ...row });
    if (error) throw error;
  }

  async event(row: Record<string, unknown>): Promise<void> {
    const project_id = await this.projectIdValue();
    const { error } = await this.db.from("events").insert({ project_id, ...row });
    if (error) throw error;
  }

  async activeEpoch(): Promise<any | null> {
    const project_id = await this.projectIdValue();
    const { data, error } = await this.db
      .from("epochs")
      .select("*")
      .eq("project_id", project_id)
      .is("completed_at", null)
      .order("epoch", { ascending: false })
      .limit(1);
    if (error) throw error;
    return data?.[0] ?? null;
  }

  async createEpoch(row: Record<string, unknown>): Promise<void> {
    const project_id = await this.projectIdValue();
    const { error } = await this.db.from("epochs").insert({ project_id, ...row });
    if (error) throw error;
  }

  async updateEpoch(id: string, patch: Record<string, unknown>): Promise<void> {
    const { error } = await this.db.from("epochs").update(patch).eq("id", id);
    if (error) throw error;
  }

  async livingLineageCounts(): Promise<Map<string, number>> {
    const alive = await this.aliveOrganisms();
    const counts = new Map<string, number>();
    for (const o of alive) {
      if (!o.lineage_id) continue;
      counts.set(o.lineage_id, (counts.get(o.lineage_id) ?? 0) + 1);
    }
    return counts;
  }

  async lineage(id: string): Promise<any | null> {
    const { data, error } = await this.db.from("lineages").select("*").eq("id", id).maybeSingle();
    if (error) throw error;
    return data ?? null;
  }
}
