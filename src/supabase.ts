import { env } from "./config.js";
import type { Habitat, MarketScores, Organism, ProjectConfig, Snapshot } from "./types.js";
import { iso } from "./utils.js";

type Filter = { column: string; op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "in" | "is"; value: unknown };

type WorkerRequest = {
  action: "select" | "insert" | "upsert" | "update" | "delete";
  table: string;
  filters?: Filter[];
  rows?: unknown;
  values?: Record<string, unknown>;
  onConflict?: string;
  limit?: number;
  order?: { column: string; ascending?: boolean };
};

function unwrap<T>(payload: any): T {
  if (payload == null) return payload as T;
  if (payload.data !== undefined) return payload.data as T;
  if (payload.rows !== undefined) return payload.rows as T;
  if (payload.result !== undefined) return payload.result as T;
  return payload as T;
}

export class Store {
  private projectId: string | null = env.projectId;

  private async call<T>(body: WorkerRequest): Promise<T> {
    const response = await fetch(env.mendleApiUrl, {
      method: "POST",
      headers: {
        "authorization": `Bearer ${env.workerSecret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const text = await response.text();
    let payload: any = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = { message: text };
    }

    if (!response.ok) {
      const detail = payload?.error ?? payload?.message ?? payload ?? text;
      const rendered = typeof detail === "string" ? detail : JSON.stringify(detail);
      throw new Error(
        `Lovable worker API ${response.status} on ${body.action} ${body.table}: ${rendered}`
      );
    }
    return unwrap<T>(payload);
  }

  async healthcheck(): Promise<void> {
    const response = await fetch(env.mendleApiUrl, {
      headers: { "authorization": `Bearer ${env.workerSecret}` },
    });
    if (!response.ok) throw new Error(`Worker bridge healthcheck failed: ${response.status}`);
  }

  private async select<T = any>(
    table: string,
    filters: Filter[] = [],
    limit?: number,
  ): Promise<T[]> {
    const data = await this.call<any>({ action: "select", table, filters, limit });
    if (Array.isArray(data)) return data as T[];
    if (Array.isArray(data?.data)) return data.data as T[];
    if (Array.isArray(data?.rows)) return data.rows as T[];
    return data ? [data as T] : [];
  }

  private async insert<T = any>(table: string, rows: unknown): Promise<T[]> {
    const data = await this.call<any>({ action: "insert", table, rows });
    if (Array.isArray(data)) return data as T[];
    if (Array.isArray(data?.data)) return data.data as T[];
    if (Array.isArray(data?.rows)) return data.rows as T[];
    return data ? [data as T] : [];
  }

  private async update(table: string, values: Record<string, unknown>, filters: Filter[]): Promise<void> {
    if (!filters.length) throw new Error(`Refusing unfiltered update on ${table}`);
    await this.call({ action: "update", table, values, filters });
  }

  async project(): Promise<ProjectConfig> {
    if (this.projectId) {
      const rows = await this.select<ProjectConfig>("project_config", [{ column: "id", op: "eq", value: this.projectId }], 1);
      if (!rows[0]) throw new Error("MENDLE_PROJECT_ID does not exist");
      return rows[0];
    }

    const rows = await this.select<ProjectConfig>("project_config", [], 2);
    if (rows.length !== 1) {
      throw new Error(`Expected exactly one project_config row, found ${rows.length}. Set MENDLE_PROJECT_ID.`);
    }
    this.projectId = rows[0]!.id;
    return rows[0]!;
  }

  async projectIdValue(): Promise<string> {
    if (!this.projectId) await this.project();
    return this.projectId!;
  }

  async updateProject(patch: Record<string, unknown>): Promise<void> {
    const id = await this.projectIdValue();
    await this.update("project_config", patch, [{ column: "id", op: "eq", value: id }]);
  }

  async log(event: string, message: string, level = "info"): Promise<void> {
    const project_id = await this.projectIdValue();
    await this.insert("operator_logs", [{ project_id, level, event, message, created_at: iso() }]);
  }

  async setMarketState(state: Record<string, unknown>): Promise<void> {
    const project_id = await this.projectIdValue();
    const existing = await this.select<any>("market_state", [{ column: "project_id", op: "eq", value: project_id }], 1);
    if (existing[0]?.id) {
      await this.update("market_state", { ...state, updated_at: iso() }, [{ column: "id", op: "eq", value: existing[0].id }]);
    } else {
      await this.insert("market_state", [{ project_id, ...state, updated_at: iso() }]);
    }
  }

  async insertSnapshot(s: Snapshot): Promise<void> {
    const project_id = await this.projectIdValue();
    const total = Math.max(1, s.buys + s.sells);
    await this.insert("market_snapshots", [{
      project_id,
      timestamp: s.timestamp.toISOString(),
      price: s.price,
      volume_window: s.volumeWindow,
      liquidity: s.liquidity,
      buy_volume: s.volumeWindow * (s.buys / total),
      sell_volume: s.volumeWindow * (s.sells / total),
      trade_count: s.tradeCount,
    }]);
  }

  async recentSnapshots(minutes: number): Promise<any[]> {
    const project_id = await this.projectIdValue();
    const since = new Date(Date.now() - minutes * 60_000).toISOString();
    const rows = await this.select<any>(
      "market_snapshots",
      [
        { column: "project_id", op: "eq", value: project_id },
        { column: "timestamp", op: "gte", value: since },
      ],
      10000,
    );
    return rows.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  }

  async recentScores(limit = 12): Promise<any[]> {
    const project_id = await this.projectIdValue();
    const rows = await this.select<any>(
      "market_scores",
      [{ column: "project_id", op: "eq", value: project_id }],
      10000,
    );
    return rows.sort((a, b) => Number(b.generation) - Number(a.generation)).slice(0, limit);
  }

  async insertScores(generation: number, scores: MarketScores, start: Date, end: Date): Promise<void> {
    const project_id = await this.projectIdValue();
    await this.insert("market_scores", [{
      project_id,
      generation,
      ...scores,
      window_started_at: start.toISOString(),
      window_ended_at: end.toISOString(),
    }]);
  }

  async insertHabitat(generation: number, h: Habitat): Promise<void> {
    const project_id = await this.projectIdValue();
    await this.insert("habitats", [{ project_id, generation, ...h }]);
  }

  async aliveOrganisms(): Promise<Organism[]> {
    const project_id = await this.projectIdValue();
    return this.select<Organism>("organisms", [
      { column: "project_id", op: "eq", value: project_id },
      { column: "alive", op: "eq", value: true },
    ], 1000);
  }

  async allOrganismsForLineage(lineageId: string): Promise<Organism[]> {
    const project_id = await this.projectIdValue();
    return this.select<Organism>("organisms", [
      { column: "project_id", op: "eq", value: project_id },
      { column: "lineage_id", op: "eq", value: lineageId },
    ], 10000);
  }

  async nextOrganismNumber(): Promise<number> {
    const project_id = await this.projectIdValue();
    const rows = await this.select<any>("organisms", [{ column: "project_id", op: "eq", value: project_id }], 10000);
    return rows.reduce((max, r) => Math.max(max, Number(r.organism_number ?? 0)), 0) + 1;
  }

  async nextLineageNumber(): Promise<number> {
    const project_id = await this.projectIdValue();
    const rows = await this.select<any>("lineages", [{ column: "project_id", op: "eq", value: project_id }], 10000);
    return rows.reduce((max, r) => Math.max(max, Number(r.lineage_number ?? 0)), 0) + 1;
  }

  async createLineage(payload: Record<string, unknown>): Promise<string> {
    const project_id = await this.projectIdValue();
    const inserted = await this.insert<any>("lineages", [{ project_id, ...payload }]);
    if (inserted[0]?.id) return String(inserted[0].id);

    // Some bridge implementations acknowledge inserts without echoing rows.
    const lineageNumber = payload.lineage_number;
    const found = await this.select<any>("lineages", [
      { column: "project_id", op: "eq", value: project_id },
      { column: "lineage_number", op: "eq", value: lineageNumber },
    ], 1);
    if (!found[0]?.id) throw new Error("Could not resolve newly inserted lineage id");
    return String(found[0].id);
  }

  async insertOrganisms(rows: Record<string, unknown>[]): Promise<Organism[]> {
    const project_id = await this.projectIdValue();
    const inserted = await this.insert<Organism>("organisms", rows.map((r) => ({ project_id, ...r })));
    if (inserted.length === rows.length && inserted.every((r) => r.id)) return inserted;

    const numbers = rows.map((r) => Number(r.organism_number)).filter(Number.isFinite);
    if (!numbers.length) return inserted;
    return this.select<Organism>("organisms", [
      { column: "project_id", op: "eq", value: project_id },
      { column: "organism_number", op: "in", value: numbers },
    ], Math.max(numbers.length, 1));
  }

  async updateOrganism(id: string, patch: Record<string, unknown>): Promise<void> {
    await this.update("organisms", patch, [{ column: "id", op: "eq", value: id }]);
  }

  async updateLineage(id: string, patch: Record<string, unknown>): Promise<void> {
    await this.update("lineages", patch, [{ column: "id", op: "eq", value: id }]);
  }

  async insertGeneration(row: Record<string, unknown>): Promise<void> {
    const project_id = await this.projectIdValue();
    await this.insert("generations", [{ project_id, ...row }]);
  }

  async latestGeneration(): Promise<any | null> {
    const project_id = await this.projectIdValue();
    const rows = await this.select<any>(
      "generations",
      [{ column: "project_id", op: "eq", value: project_id }],
      10000,
    );
    rows.sort((a, b) => Number(b.generation) - Number(a.generation));
    return rows[0] ?? null;
  }

  async event(row: Record<string, unknown>): Promise<void> {
    const project_id = await this.projectIdValue();
    await this.insert("events", [{ project_id, ...row }]);
  }

  async activeEpoch(): Promise<any | null> {
    const project_id = await this.projectIdValue();
    const rows = await this.select<any>("epochs", [
      { column: "project_id", op: "eq", value: project_id },
      { column: "completed_at", op: "is", value: null },
    ], 100);
    rows.sort((a, b) => Number(b.epoch) - Number(a.epoch));
    return rows[0] ?? null;
  }

  async createEpoch(row: Record<string, unknown>): Promise<void> {
    const project_id = await this.projectIdValue();
    await this.insert("epochs", [{ project_id, ...row }]);
  }

  async updateEpoch(id: string, patch: Record<string, unknown>): Promise<void> {
    await this.update("epochs", patch, [{ column: "id", op: "eq", value: id }]);
  }

  async activeLineages(): Promise<any[]> {
    const project_id = await this.projectIdValue();
    return this.select<any>("lineages", [
      { column: "project_id", op: "eq", value: project_id },
      { column: "active", op: "eq", value: true },
    ], 10000);
  }

  async lineage(id: string): Promise<any | null> {
    const rows = await this.select<any>("lineages", [{ column: "id", op: "eq", value: id }], 1);
    return rows[0] ?? null;
  }
}
