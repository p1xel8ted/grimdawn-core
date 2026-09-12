/**
 * Replaying an item's rolled stats from its save seed.
 *
 * A save stores an item as record paths plus a seed, and the engine derives the
 * numbers from that seed at drop time. `resolve.ts` deliberately reads the
 * record's own values instead, which are the middle of each range rather than
 * the roll on any one copy. This module derives the real values where it safely
 * can, and says so where it cannot.
 *
 * Nothing here is on the default resolution path. See `roll-order.ts` for the
 * field table and its provenance.
 */

import { ROLL_ORDER, type RollKind } from './roll-order.js';

/** Park-Miller MINSTD, by Schrage's method so every step stays in 32 bits. */
const A = 16807, M = 2147483647, Q = 127773, R = 2836;
const step = (s: number): number => {
  const hi = Math.trunc(s / Q), lo = s % Q;
  const r = A * lo - R * hi;
  return r < 0 ? r + M : r;
};

/**
 * The engine's stream. The seed primes it with one advance, and each draw
 * advances again before returning, so the first value is two steps out. A
 * stream that hands back the primed state instead is shifted by one draw, and
 * every field after the first then reads wrong while looking plausible.
 */
class Stream {
  private s: number;
  constructor(seed: number) { this.s = step(seed >>> 0); }
  next(): number { this.s = step(this.s); return this.s; }
}

/**
 * One rolled value.
 *
 * The spread is `floor(value * jitter / 100)`, at least 1, and the draw picks
 * uniformly across `2 * spread + 1` outcomes around the record's value. A zero
 * value or a zero jitter returns without touching the stream, which is load
 * bearing: a field that costs no draw shifts everything after it if you assume
 * it costs one.
 */
function rollValue(value: number, jitterPercent: number, draw: () => number): number {
  if (value === 0 || jitterPercent === 0) return value;
  const spread = Math.max(1, Math.floor((value * jitterPercent) / 100));
  const rolled = (draw() % (2 * spread + 1)) - spread + value;
  return Math.abs(rolled) < 1 ? value : rolled;
}

/** The keys a kind reads, in draw order. Compound kinds never use the bare name. */
export function rollKeys(kind: RollKind, field: string): readonly string[] {
  switch (kind) {
    case 'Flat': case 'SlowFlat': case 'RetalFlat': return [`${field}Min`, `${field}Max`];
    case 'RetalDur': case 'OffSlow': return [`${field}Min`, `${field}DurationMin`, `${field}Chance`];
    case 'RetalReflex': case 'OffReflex': return [`${field}Min`, `${field}Chance`];
    case 'OffReduc': return [`${field}Min`, `${field}DurationMin`];
    case 'Leech': return [`${field}Min`];
    default: return [field];
  }
}

/** Which sources a kind draws from, in order. Base is last for these three. */
const BASE_LAST = new Set<RollKind>(['Char', 'Skill', 'RetalMod']);
export const rollSources = (kind: RollKind): readonly ('prefix' | 'suffix' | 'base')[] =>
  BASE_LAST.has(kind) ? ['prefix', 'suffix', 'base'] : ['base', 'prefix', 'suffix'];

/** Base records carry no jitter field of their own; the engine uses this. */
export const BASE_JITTER_PERCENT = 20;

/** Where a replayed number came from, so a caller never mistakes one for the other. */
export type RollProvenance = 'seed-replayed' | 'nominal';

export interface RollDescriptor {
  /** Draw-affecting field values, including explicit zeros where they matter. */
  readonly fields: Readonly<Record<string, number>>;
  /** `lootRandomizerJitter` on an affix; absent on a base record. */
  readonly jitter?: number;
  /** Non-empty when the record carries something the traversal does not model. */
  readonly unsupported?: readonly string[];
}

export interface ReplayResult {
  /** Field values after the roll, for the fields the traversal produced. */
  readonly values: Readonly<Record<string, number>>;
  readonly provenance: RollProvenance;
  /** Why the item fell back, when it did. */
  readonly reason?: string;
}

/**
 * Replay one item instance.
 *
 * All or nothing per item, because the sources share one stream: a single
 * unmodelled field consumes an unknown number of draws and every value after it
 * is wrong. So anything unexpected returns the record's own values with
 * `nominal` provenance and a reason, rather than a partly-right answer.
 */
export function replayItem(
  seed: number,
  base: RollDescriptor | undefined,
  prefix?: RollDescriptor,
  suffix?: RollDescriptor,
): ReplayResult {
  const nominal = (reason: string): ReplayResult => ({
    values: { ...(base?.fields ?? {}), ...(prefix?.fields ?? {}), ...(suffix?.fields ?? {}) },
    provenance: 'nominal',
    reason,
  });

  if (!base) return nominal('no roll metadata for the base record');
  for (const [label, d] of [['base', base], ['prefix', prefix], ['suffix', suffix]] as const) {
    if (d?.unsupported?.length) return nominal(`${label} record carries unmodelled field ${d.unsupported[0]}`);
  }
  // A zero seed is a fixed point of the generator, so every field would take
  // its minimum. That is real engine behaviour rather than a broken instance,
  // but it is not something to hand out as a derived value without evidence.
  if ((seed >>> 0) === 0) return nominal('seed 0 is a fixed point of the generator');

  const src = {
    base: { fields: base.fields, jitter: BASE_JITTER_PERCENT },
    prefix: { fields: prefix?.fields ?? {}, jitter: prefix?.jitter ?? 0 },
    suffix: { fields: suffix?.fields ?? {}, jitter: suffix?.jitter ?? 0 },
  };
  const rng = new Stream(seed);
  const draw = () => rng.next();
  const values: Record<string, number> = {};
  const at = (s: 'base' | 'prefix' | 'suffix', f: string): number => src[s].fields[f] ?? 0;

  for (const { kind, field } of ROLL_ORDER) {
    const keys = rollKeys(kind, field);
    const sources = ['base', 'prefix', 'suffix'] as const;
    if (!keys.some((f) => sources.some((s) => at(s, f) !== 0))) continue;

    if (kind === 'Flat' || kind === 'SlowFlat' || kind === 'RetalFlat') {
      const [minF, maxF] = keys as [string, string];
      let min = 0, spread = 0;
      for (const s of sources) {
        const mn = at(s, minF), mx = at(s, maxF);
        if (mn === 0 && mx === 0) continue;
        const above = Math.max(0, mx - mn);
        min += rollValue(mn, src[s].jitter, draw);
        spread += rollValue(above, src[s].jitter, draw);
      }
      values[minF] = Math.trunc(min);
      values[maxF] = Math.trunc(min + spread);
      continue;
    }

    for (const key of keys) {
      let total = 0;
      for (const s of rollSources(kind)) {
        const v = at(s, key);
        if (v === 0) continue;
        total += rollValue(v, src[s].jitter, draw);
      }
      if (total !== 0) values[key] = total;
    }
  }
  return { values, provenance: 'seed-replayed' };
}
