import pino from "pino";
import { env } from "./config.js";
import { Store } from "./supabase.js";
import { discoverPair, fetchPair, toSnapshot, validateSolanaMint } from "./market.js";
import { calculateMarketScores, scoresToHabitat } from "./metrics.js";
import {
  breed,
  chooseParent,
  diversity,
  fitness,
  organismGenes,
  randomGenes,
  selectSurvivors,
  strongestTrait,
} from "./genetics.js";
import type { LegacyEffect, Organism, PairState, ProjectConfig } from "./types.js";
import { clamp, iso } from "./utils.js";

const log = pino({ level: env.logLevel });

type ChildMeta = {
  number: number;
  parentA: Organism;
  parentB: Organism;
  inheritedLineage: string | null;
  mutations: ReturnType<typeof breed>["mutations"];
};

export class MendleEngine {
  private readonly store = new Store();
  private pair: PairState | null = null;
  private mint: string | null = null;
  private tokenSupply: number | null = null;
  private lastSnapshotAt = 0;

  async start(): Promise<void> {
    await this.store.healthcheck();
    await this.store.project();
    await this.store.log("worker_started", "mendle-engine connected");
    log.info("mendle-engine started");

    while (true) {
      try {
        await this.tick();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error({ err: error }, "engine tick failed");
        try {
          await this.store.updateProject({
            mode: "error",
            evolution_status: "error",
          });
          await this.store.log("worker_error", message, "error");
        } catch (nested) {
          log.error({ err: nested }, "failed to persist worker error");
        }
      }

      await new Promise((resolve) => setTimeout(resolve, env.marketPollIntervalMs));
    }
  }

  private async tick(): Promise<void> {
    const project = await this.store.project();
    const ca = project.contract_address?.trim() || null;

    if (!ca) {
      this.resetLocalMarket();
      return;
    }

    if (this.mint && this.mint !== ca) {
      this.resetLocalMarket();
    }

    if (project.mode === "validating_mint" ||
        project.mode === "locating_market" ||
        project.mode === "connecting_feed" ||
        project.mode === "seeding_population") {
      const ready = await this.initialize(project, ca);
      if (!ready) return;
    }

    // Recover after a Railway restart when the DB is already live.
    if (!this.pair && ["observation_window", "live", "paused"].includes(project.mode)) {
      this.mint = ca;
      const supply = await validateSolanaMint(env.solanaRpcUrl, ca);
      this.tokenSupply = supply.supply;
      this.pair = await discoverPair(ca);
      if (!this.pair) {
        await this.store.updateProject({ mode: "locating_market", market_feed_status: "locating" });
        return;
      }
      await this.store.log("market_reconnected", `reconnected to ${this.pair.dexId} pair ${this.pair.pairAddress}`);
    }

    if (!this.pair || !this.mint) return;

    await this.pollMarket(project);

    const refreshed = await this.store.project();

    if (refreshed.manual_generation_requested) {
      await this.store.updateProject({ manual_generation_requested: false });
      await this.store.log("manual_generation", "manual generation request accepted");
      await this.runGeneration(refreshed);
      return;
    }

    if (refreshed.is_paused) return;

    // /op5 RESUME intentionally only clears is_paused. The worker restores the running mode.
    if (refreshed.mode === "paused") {
      const restoredMode = refreshed.current_generation > 0 ? "live" : "observation_window";
      await this.store.updateProject({ mode: restoredMode, evolution_status: "running" });
      await this.store.log("resumed", "experiment resumed by operator");
      refreshed.mode = restoredMode;
    }

    if (!["observation_window", "live"].includes(refreshed.mode)) return;

    const anchor = refreshed.last_generation_at ?? refreshed.initialized_at;
    if (!anchor) return;

    const intervalMs = (refreshed.generation_interval_seconds || env.generationIntervalSeconds) * 1000;
    const due = Date.now() - new Date(anchor).getTime() >= intervalMs;
    if (due) await this.runGeneration(refreshed);
  }

  private resetLocalMarket(): void {
    this.pair = null;
    this.mint = null;
    this.tokenSupply = null;
    this.lastSnapshotAt = 0;
  }

  private async initialize(project: ProjectConfig, ca: string): Promise<boolean> {
    this.mint = ca;

    if (project.mode === "validating_mint") {
      await this.store.log("validating_mint", `validating mint ${ca}`);
      const token = await validateSolanaMint(env.solanaRpcUrl, ca);
      this.tokenSupply = token.supply;
      await this.store.updateProject({
        mode: "locating_market",
        market_feed_status: "locating",
        evolution_status: "waiting",
      });
      await this.store.log("mint_validated", `mint validated; supply ${token.supply}`);
    }

    const current = await this.store.project();
    if (current.mode === "locating_market") {
      const found = await discoverPair(ca);
      if (!found) return false;
      this.pair = found;
      await this.store.updateProject({ mode: "connecting_feed", market_feed_status: "connecting" });
      await this.store.log("market_located", `${found.dexId} pair ${found.pairAddress} selected by liquidity`);
    }

    const connecting = await this.store.project();
    if (connecting.mode === "connecting_feed") {
      if (!this.pair) {
        this.pair = await discoverPair(ca);
        if (!this.pair) {
          await this.store.updateProject({ mode: "locating_market", market_feed_status: "locating" });
          return false;
        }
      }
      const fresh = await fetchPair(this.pair.pairAddress, ca);
      this.pair = fresh;
      await this.persistMarket(fresh);
      await this.store.updateProject({
        mode: "seeding_population",
        market_feed_status: "live",
      });
      await this.store.log("market_connected", "market feed connected");
    }

    const seeding = await this.store.project();
    if (seeding.mode === "seeding_population") {
      const alive = await this.store.aliveOrganisms();
      if (alive.length === 0) {
        await this.seedGenerationZero(seeding);
      }
      const now = iso();
      await this.ensureEpochOne();
      await this.store.updateProject({
        mode: "observation_window",
        market_feed_status: "live",
        evolution_status: "running",
        current_generation: 0,
        current_epoch: 1,
        initialized_at: seeding.initialized_at ?? now,
        last_generation_at: seeding.last_generation_at ?? now,
        is_paused: false,
      });
      await this.store.log(
        "observation_window_started",
        `generation 000 seeded; first ${Math.round(env.initialObservationSeconds / 60)} minute observation window started`,
      );
    }

    return true;
  }

  private async pollMarket(project: ProjectConfig): Promise<void> {
    if (!this.pair || !this.mint) return;

    const fresh = await fetchPair(this.pair.pairAddress, this.mint);
    this.pair = fresh;
    await this.persistMarket(fresh);

    const snapshotIntervalMs = env.marketSnapshotIntervalSeconds * 1000;
    if (Date.now() - this.lastSnapshotAt >= snapshotIntervalMs) {
      await this.store.insertSnapshot(toSnapshot(fresh));
      this.lastSnapshotAt = Date.now();
    }

    if (project.market_feed_status !== "live") {
      await this.store.updateProject({ market_feed_status: "live" });
    }
  }

  private async persistMarket(pair: PairState): Promise<void> {
    const trades = Math.max(1, pair.buysM5 + pair.sellsM5);
    const buyVolume = pair.volumeM5 * (pair.buysM5 / trades);
    const sellVolume = pair.volumeM5 * (pair.sellsM5 / trades);
    const marketCap = pair.marketCap ?? (
      this.tokenSupply && pair.priceUsd ? this.tokenSupply * pair.priceUsd : pair.fdv
    );

    await this.store.setMarketState({
      price: pair.priceUsd || null,
      market_cap: marketCap ?? null,
      market_cap_change: pair.priceChangeH24,
      volume_24h: pair.volumeH24 || null,
      liquidity: pair.liquidityUsd || null,
      supply: this.tokenSupply,
      buy_volume: buyVolume || null,
      sell_volume: sellVolume || null,
      trade_count: pair.buysM5 + pair.sellsM5,
    });

    await this.store.updateProject({ last_market_update: iso() });
  }

  private async seedGenerationZero(project: ProjectConfig): Promise<void> {
    await this.store.log("seeding_population", `seeding ${project.population_target || env.populationTarget} organisms`);
    const target = project.population_target || env.populationTarget;
    let nextNumber = await this.store.nextOrganismNumber();

    for (let i = 0; i < target; i++) {
      const genes = randomGenes();
      const [organism] = await this.store.insertOrganisms([{
        organism_number: nextNumber++,
        generation_born: 0,
        generation_died: null,
        parent_a: null,
        parent_b: null,
        lineage_id: null,
        gene_a: genes.a,
        gene_b: genes.b,
        gene_c: genes.c,
        gene_d: genes.d,
        gene_e: genes.e,
        gene_f: genes.f,
        fitness: null,
        alive: true,
        mutation_count: 0,
      }]);
      if (!organism) throw new Error("Failed to seed organism");

      const lineageNumber = await this.store.nextLineageNumber();
      const lineageId = await this.store.createLineage({
        lineage_number: lineageNumber,
        founder_organism_id: organism.id,
        generation_started: 0,
        generation_extinct: null,
        living_descendants: 1,
        total_descendants: 1,
        peak_population_share: 1 / target,
        active: true,
      });
      await this.store.updateOrganism(organism.id, { lineage_id: lineageId });
    }

    await this.store.insertGeneration({
      generation: 0,
      epoch: 1,
      population_before: target,
      survivors: target,
      deaths: 0,
      births: target,
      mutations: 0,
      population_after: target,
      diversity: null,
      dominant_lineage_id: null,
      dominant_phenotype: "ancestral population",
      started_at: iso(),
      completed_at: iso(),
    });
  }

  private async ensureEpochOne(): Promise<void> {
    const active = await this.store.activeEpoch();
    if (active) return;
    await this.store.createEpoch({
      epoch: 1,
      starting_generation: 0,
      ending_generation: null,
      dominant_lineage_id: null,
      dominant_organism_id: null,
      legacy_trait: null,
      legacy_effect: null,
      legacy_expires_epoch: null,
      started_at: iso(),
      completed_at: null,
    });
  }

  private async activeLegacy(project: ProjectConfig): Promise<LegacyEffect | null> {
    const epoch = await this.store.activeEpoch();
    if (!epoch?.legacy_trait || !epoch?.legacy_effect) return null;
    if (epoch.legacy_expires_epoch != null && project.current_epoch > epoch.legacy_expires_epoch) return null;
    return {
      trait: epoch.legacy_trait as LegacyEffect["trait"],
      effect: clamp(Number(epoch.legacy_effect), 0, env.legacyMaxEffect),
    };
  }

  private async runGeneration(projectBefore: ProjectConfig): Promise<void> {
    if (!this.pair) throw new Error("Cannot run generation without a market pair");

    const start = new Date(projectBefore.last_generation_at ?? projectBefore.initialized_at ?? Date.now() - env.generationIntervalSeconds * 1000);
    const end = new Date();
    const generation = projectBefore.current_generation + 1;

    await this.store.updateProject({ evolution_status: "calculating" });
    await this.store.log("generation_started", `generation ${String(generation).padStart(3, "0")} started`);

    const snapshots = await this.store.recentSnapshots(env.baselineWindowMinutes);
    const priorScores = await this.store.recentScores(12);
    const scores = calculateMarketScores(
      snapshots,
      this.pair,
      priorScores,
      (projectBefore.generation_interval_seconds || env.generationIntervalSeconds) / 60,
    );
    const habitat = scoresToHabitat(scores);

    await this.store.insertScores(generation, scores, start, end);
    await this.store.insertHabitat(generation, habitat);

    const population = await this.store.aliveOrganisms();
    if (!population.length) throw new Error("No living population");

    const legacy = await this.activeLegacy(projectBefore);
    const scored = population.map((organism) => ({
      organism,
      fitness: fitness(organismGenes(organism), habitat, legacy).total,
    }));

    await Promise.all(scored.map(({ organism, fitness: value }) =>
      this.store.updateOrganism(organism.id, { fitness: value })
    ));

    const survivors = selectSurvivors(scored);
    const survivorIds = new Set(survivors.map((s) => s.organism.id));
    const deaths = scored.filter((s) => !survivorIds.has(s.organism.id));

    await Promise.all(deaths.map(({ organism }) =>
      this.store.updateOrganism(organism.id, {
        alive: false,
        generation_died: generation,
      })
    ));

    const target = projectBefore.population_target || env.populationTarget;
    const childCount = Math.max(0, target - survivors.length);
    let nextNumber = await this.store.nextOrganismNumber();
    const rows: Record<string, unknown>[] = [];
    const metas: ChildMeta[] = [];

    for (let i = 0; i < childCount; i++) {
      const a = chooseParent(survivors);
      let b = chooseParent(survivors);
      for (let tries = 0; tries < 5 && b.organism.id === a.organism.id; tries++) b = chooseParent(survivors);

      const result = breed(a.organism, b.organism, habitat.disturbance);
      const inherited = (a.fitness >= b.fitness ? a.organism.lineage_id : b.organism.lineage_id) ?? a.organism.lineage_id ?? b.organism.lineage_id;
      const number = nextNumber++;

      rows.push({
        organism_number: number,
        generation_born: generation,
        generation_died: null,
        parent_a: a.organism.id,
        parent_b: b.organism.id,
        lineage_id: inherited,
        gene_a: result.genes.a,
        gene_b: result.genes.b,
        gene_c: result.genes.c,
        gene_d: result.genes.d,
        gene_e: result.genes.e,
        gene_f: result.genes.f,
        fitness: null,
        alive: true,
        mutation_count: result.mutations.length,
      });
      metas.push({
        number,
        parentA: a.organism,
        parentB: b.organism,
        inheritedLineage: inherited,
        mutations: result.mutations,
      });
    }

    const children = rows.length ? await this.store.insertOrganisms(rows) : [];
    const childByNumber = new Map(children.map((c) => [Number(c.organism_number), c]));
    let mutationCount = 0;

    for (const meta of metas) {
      const child = childByNumber.get(meta.number);
      if (!child) continue;
      if (!meta.mutations.length) continue;
      mutationCount += meta.mutations.length;

      const major = meta.mutations.some((m) => Math.abs(m.delta) >= 5);
      let lineageId = child.lineage_id;

      if (major) {
        const lineageNumber = await this.store.nextLineageNumber();
        lineageId = await this.store.createLineage({
          lineage_number: lineageNumber,
          founder_organism_id: child.id,
          generation_started: generation,
          generation_extinct: null,
          living_descendants: 1,
          total_descendants: 1,
          peak_population_share: 1 / target,
          active: true,
        });
        await this.store.updateOrganism(child.id, { lineage_id: lineageId });
        child.lineage_id = lineageId;

        await this.store.event({
          generation,
          organism_id: child.id,
          lineage_id: lineageId,
          event_type: "lineage_split",
          title: "lineage split",
          description: `specimen #${meta.number} founded a new lineage after a major mutation`,
          metadata: { parent_lineage: meta.inheritedLineage, mutations: meta.mutations },
        });
      }

      await this.store.event({
        generation,
        organism_id: child.id,
        lineage_id: lineageId,
        event_type: "mutation",
        title: "mutation",
        description: meta.mutations
          .map((m) => `${m.locus.toUpperCase()}${m.from} → ${m.locus.toUpperCase()}${m.to}`)
          .join(", "),
        metadata: { mutations: meta.mutations },
      });
    }

    const postPopulation = [...survivors.map((s) => s.organism), ...children];
    const lineageCounts = new Map<string, number>();
    for (const o of postPopulation) {
      if (!o.lineage_id) continue;
      lineageCounts.set(o.lineage_id, (lineageCounts.get(o.lineage_id) ?? 0) + 1);
    }

    await this.refreshLineages(lineageCounts, target, generation);

    let dominantLineageId: string | null = null;
    let dominantCount = -1;
    for (const [id, count] of lineageCounts) {
      if (count > dominantCount) {
        dominantLineageId = id;
        dominantCount = count;
      }
    }

    const phenotype = this.dominantTraitLabel(postPopulation);
    const div = diversity(postPopulation);

    const previousGeneration = await this.store.latestGeneration();
    const priorDominant = previousGeneration?.dominant_lineage_id ?? null;

    await this.store.insertGeneration({
      generation,
      epoch: projectBefore.current_epoch || 1,
      population_before: population.length,
      survivors: survivors.length,
      deaths: deaths.length,
      births: children.length,
      mutations: mutationCount,
      population_after: postPopulation.length,
      diversity: div,
      dominant_lineage_id: dominantLineageId,
      dominant_phenotype: phenotype,
      started_at: start.toISOString(),
      completed_at: end.toISOString(),
    });

    if (dominantLineageId && priorDominant && dominantLineageId !== priorDominant) {
      await this.store.event({
        generation,
        organism_id: null,
        lineage_id: dominantLineageId,
        event_type: "dominance_shift",
        title: "dominance shift",
        description: "a different lineage now holds the largest share of the living population",
        metadata: { previous: priorDominant, current: dominantLineageId },
      });
    }

    await this.store.updateProject({
      current_generation: generation,
      last_generation_at: end.toISOString(),
      evolution_status: "running",
      mode: "live",
    });

    await this.maybeCloseEpoch(generation, dominantLineageId, postPopulation);

    await this.store.log(
      "generation_completed",
      `generation ${String(generation).padStart(3, "0")} completed · ${deaths.length} deaths · ${children.length} births · ${mutationCount} mutations · diversity ${div.toFixed(3)}`,
    );
  }

  private dominantTraitLabel(population: Organism[]): string {
    const counts = new Map<string, number>();
    for (const o of population) {
      const trait = strongestTrait(organismGenes(o));
      counts.set(trait, (counts.get(trait) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "mixed";
  }

  private async refreshLineages(counts: Map<string, number>, target: number, generation: number): Promise<void> {
    const active = await this.store.activeLineages();

    for (const lineage of active) {
      const living = counts.get(lineage.id) ?? 0;
      const all = await this.store.allOrganismsForLineage(lineage.id);
      const share = living / Math.max(1, target);
      const patch: Record<string, unknown> = {
        living_descendants: living,
        total_descendants: all.length,
        peak_population_share: Math.max(Number(lineage.peak_population_share ?? 0), share),
      };

      if (living === 0) {
        patch.active = false;
        patch.generation_extinct = generation;
        await this.store.event({
          generation,
          organism_id: null,
          lineage_id: lineage.id,
          event_type: "lineage_extinction",
          title: "lineage extinct",
          description: `lineage ${lineage.lineage_number} ended after ${generation - Number(lineage.generation_started)} generations`,
          metadata: { lineage_number: lineage.lineage_number },
        });
      }

      await this.store.updateLineage(lineage.id, patch);
    }
  }

  private async maybeCloseEpoch(generation: number, dominantLineageId: string | null, population: Organism[]): Promise<void> {
    if (generation === 0 || generation % env.generationsPerEpoch !== 0) return;

    const active = await this.store.activeEpoch();
    if (!active) return;

    let dominantOrganism: Organism | null = null;
    if (dominantLineageId) {
      dominantOrganism = population
        .filter((o) => o.lineage_id === dominantLineageId)
        .sort((a, b) => Number(b.fitness ?? 0) - Number(a.fitness ?? 0))[0] ?? null;
    }
    if (!dominantOrganism) {
      dominantOrganism = [...population].sort((a, b) => Number(b.fitness ?? 0) - Number(a.fitness ?? 0))[0] ?? null;
    }

    const trait = dominantOrganism ? strongestTrait(organismGenes(dominantOrganism)) : "resilience";
    const effect = Math.min(env.legacyEffect, env.legacyMaxEffect);
    const nextEpoch = Number(active.epoch) + 1;

    await this.store.updateEpoch(active.id, {
      ending_generation: generation,
      dominant_lineage_id: dominantLineageId,
      dominant_organism_id: dominantOrganism?.id ?? null,
      completed_at: iso(),
    });

    await this.store.event({
      generation,
      organism_id: dominantOrganism?.id ?? null,
      lineage_id: dominantLineageId,
      event_type: "dominant_strain",
      title: `dominant strain · epoch ${String(active.epoch).padStart(3, "0")}`,
      description: `${trait} was the strongest trait of the epoch's dominant strain`,
      metadata: { epoch: active.epoch, trait, effect },
    });

    await this.store.createEpoch({
      epoch: nextEpoch,
      starting_generation: generation + 1,
      ending_generation: null,
      dominant_lineage_id: null,
      dominant_organism_id: null,
      legacy_trait: trait,
      legacy_effect: effect,
      legacy_expires_epoch: nextEpoch + env.legacyDurationEpochs - 1,
      started_at: iso(),
      completed_at: null,
    });

    await this.store.event({
      generation,
      organism_id: dominantOrganism?.id ?? null,
      lineage_id: dominantLineageId,
      event_type: "legacy_activated",
      title: "legacy activated",
      description: `${trait} receives +${Math.round(effect * 100)}% influence for the next ${env.legacyDurationEpochs} epochs`,
      metadata: { trait, effect, expires_epoch: nextEpoch + env.legacyDurationEpochs - 1 },
    });

    await this.store.updateProject({ current_epoch: nextEpoch });
    await this.store.log("epoch_closed", `epoch ${active.epoch} closed; ${trait} legacy activated`);
  }
}
