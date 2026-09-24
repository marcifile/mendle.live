import { env } from "./config.js";
import type { FitnessBreakdown, Genes, Habitat, LegacyEffect, Organism } from "./types.js";
import { clamp, gaussian, gene, weightedPick } from "./utils.js";

export function randomGenes(): Genes {
  return {
    a: gene(gaussian()),
    b: gene(gaussian()),
    c: gene(gaussian()),
    d: gene(gaussian()),
    e: gene(gaussian()),
    f: gene(gaussian()),
  };
}

export function organismGenes(o: Organism): Genes {
  return { a: o.gene_a, b: o.gene_b, c: o.gene_c, d: o.gene_d, e: o.gene_e, f: o.gene_f };
}

function normalizedGenes(g: Genes, legacy?: LegacyEffect | null): Record<LegacyEffect["trait"], number> {
  const base = {
    resilience: g.a / 99,
    efficiency: g.b / 99,
    mobility: g.c / 99,
    fertility: g.d / 99,
    size: g.e / 99,
    plasticity: g.f / 99,
  };
  if (legacy) base[legacy.trait] = clamp(base[legacy.trait] * (1 + legacy.effect));
  return base;
}

export function fitness(g: Genes, h: Habitat, legacy?: LegacyEffect | null): FitnessBreakdown {
  const t = normalizedGenes(g, legacy);

  const resilience = t.resilience * h.temperature;
  const efficiency = t.efficiency * (1 - h.nutrients);
  const mobility = t.mobility * Math.abs(h.current);
  const fertility = t.fertility * h.nutrients * (1 - h.disturbance);
  const sizeTarget = (h.capacity + h.nutrients) / 2;
  const size = 1 - Math.abs(t.size - sizeTarget);
  const plasticity = t.plasticity * h.disturbance;

  const environmental =
    0.20 * resilience +
    0.18 * efficiency +
    0.17 * mobility +
    0.15 * fertility +
    0.15 * size +
    0.15 * plasticity;

  const baselineHealth = (
    t.resilience + t.efficiency + t.mobility + t.fertility + t.plasticity
  ) / 5;

  const total = clamp(0.90 * environmental + 0.10 * baselineHealth);
  return { total, resilience, efficiency, mobility, fertility, size, plasticity };
}

export function selectSurvivors(scored: Array<{ organism: Organism; fitness: number }>): Array<{ organism: Organism; fitness: number }> {
  const survivors = scored.filter(({ fitness }) => Math.random() < 0.15 + 0.75 * fitness);

  if (survivors.length < env.minSurvivors) {
    return [...scored].sort((a, b) => b.fitness - a.fitness).slice(0, env.minSurvivors);
  }
  if (survivors.length > env.maxSurvivors) {
    const pool = [...survivors];
    const kept: typeof survivors = [];
    while (kept.length < env.maxSurvivors && pool.length) {
      const chosen = weightedPick(pool, (x) => 0.05 + x.fitness * x.fitness);
      kept.push(chosen);
      pool.splice(pool.indexOf(chosen), 1);
    }
    return kept;
  }
  return survivors;
}

export function chooseParent(pool: Array<{ organism: Organism; fitness: number }>): { organism: Organism; fitness: number } {
  return weightedPick(pool, ({ organism, fitness }) => {
    const fertility = organism.gene_d / 99;
    return Math.max(0.0001, fitness * fitness * (0.5 + fertility));
  });
}

export interface ChildResult {
  genes: Genes;
  mutations: Array<{ locus: keyof Genes; from: number; to: number; delta: number }>;
}

export function breed(parentA: Organism, parentB: Organism, disturbance: number): ChildResult {
  const ga = organismGenes(parentA);
  const gb = organismGenes(parentB);
  const genes: Genes = {
    a: Math.random() < 0.5 ? ga.a : gb.a,
    b: Math.random() < 0.5 ? ga.b : gb.b,
    c: Math.random() < 0.5 ? ga.c : gb.c,
    d: Math.random() < 0.5 ? ga.d : gb.d,
    e: Math.random() < 0.5 ? ga.e : gb.e,
    f: Math.random() < 0.5 ? ga.f : gb.f,
  };

  const mutationRate = env.baseMutationRate + env.disturbanceMutationBonus * disturbance;
  const mutations: ChildResult["mutations"] = [];

  for (const locus of ["a", "b", "c", "d", "e", "f"] as const) {
    if (Math.random() >= mutationRate) continue;
    let delta = 0;
    while (delta === 0) {
      delta = Math.floor(Math.random() * (env.geneMutationMaxDelta * 2 + 1)) - env.geneMutationMaxDelta;
    }
    const from = genes[locus];
    const to = gene(from + delta);
    genes[locus] = to;
    mutations.push({ locus, from, to, delta: to - from });
  }

  return { genes, mutations };
}

export function strongestTrait(g: Genes): LegacyEffect["trait"] {
  const pairs: Array<[LegacyEffect["trait"], number]> = [
    ["resilience", g.a],
    ["efficiency", g.b],
    ["mobility", g.c],
    ["fertility", g.d],
    ["size", g.e],
    ["plasticity", g.f],
  ];
  pairs.sort((a, b) => b[1] - a[1]);
  return pairs[0]![0];
}

export function diversity(population: Organism[]): number {
  if (population.length < 2) return 0;
  const loci = ["gene_a", "gene_b", "gene_c", "gene_d", "gene_e", "gene_f"] as const;
  const variances = loci.map((key) => {
    const vals = population.map((o) => Number(o[key]));
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    const variance = vals.reduce((a, b) => a + (b - avg) ** 2, 0) / vals.length;
    // Max-ish useful variance for 0..99 is ~2450. Normalize to 0..1.
    return clamp(variance / 1200);
  });
  return clamp(variances.reduce((a, b) => a + b, 0) / variances.length);
}
