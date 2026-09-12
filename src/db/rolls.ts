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
  // Truncated, not floored: a negative value keeps a negative spread, and only
  // an exactly-zero spread is widened to one. Flooring instead would turn every
  // small negative into a spread of 1 and roll a drawback the wrong way.
  let spread = Math.trunc(value * jitterPercent * 0.01);
  if (spread === 0) spread = 1;
  let modulus = 2 * spread + 1;
  if (modulus === 0) modulus = 1;
  const rolled = (draw() % modulus) - spread + value;
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

/**
 * Which sources a kind draws from, in order.
 *
 * Only `Char` and `Skill` put the base last; everything else, `RetalMod`
 * included, draws base first.
 */
const BASE_LAST = new Set<RollKind>(['Char', 'Skill']);
export const rollSources = (kind: RollKind): readonly ('prefix' | 'suffix' | 'base')[] =>
  BASE_LAST.has(kind) ? ['prefix', 'suffix', 'base'] : ['base', 'prefix', 'suffix'];

/**
 * Kinds whose draw semantics this module does not reproduce yet.
 *
 * Skill and conversion use their own jitter rules, affix skill fields are drawn
 * before the main walk, and the slow families pair a modifier with a duration.
 * Any of those on a record makes the whole item unreplayable, because a
 * miscounted draw corrupts every value after it - including the resistances
 * this module exists to produce.
 */
export const UNMODELLED_KINDS: ReadonlySet<RollKind> = new Set([
  'Skill', 'Conv', 'OffSlow', 'RetalDur', 'RetalReflex', 'OffReflex', 'OffReduc',
  // SlowFlat reads presence rather than value: a source carrying the field at
  // an explicit zero changes which branch runs, and the descriptor drops zeros.
  // Keeping the zero would mean carrying presence for every field on every
  // record, so the family is refused instead.
  'SlowFlat',
]);

/** Base records carry no jitter field of their own; the engine uses this. */
export const BASE_JITTER_PERCENT = 20;

/** Where a replayed number came from, so a caller never mistakes one for the other. */
export type RollProvenance = 'seed-replayed' | 'nominal';

export interface RollDescriptor {
  /** Draw-affecting field values. Zeros are dropped: a zero never draws. */
  readonly fields: Readonly<Record<string, number>>;
  /**
   * The record's `Class`, which decides draws rather than describing the item:
   * a weapon's base physical damage is fixed instead of rolled, and an off-hand
   * skips sources entirely.
   */
  readonly itemClass?: string;
  /** `lootRandomizerJitter` on an affix; absent on a base record. */
  readonly jitter?: number;
  /** Non-empty when the record carries something the traversal does not model. */
  readonly unsupported?: readonly string[];
}

/**
 * The resistance fields this module reports.
 *
 * `defensiveElementalResistance` is one field the game expands to fire, cold
 * and lightning; the caller does that expansion, as it already does for the
 * nominal value.
 */
export const REPLAYED_RESISTANCES: readonly string[] = [
  'defensivePhysical', 'defensivePierce', 'defensiveFire', 'defensiveCold', 'defensiveLightning',
  'defensivePoison', 'defensiveLife', 'defensiveAether', 'defensiveChaos', 'defensiveBleeding',
  'defensiveElementalResistance',
];
const REPORTED: ReadonlySet<string> = new Set(REPLAYED_RESISTANCES);

export interface ReplayResult {
  /**
   * The rolled resistances, and nothing else.
   *
   * The walk computes offensive and retaliation values too, because it has to
   * in order to consume the right draws, but those are intermediate: they are
   * unscaled and some are held fixed, so handing them out would invite a caller
   * to treat a working number as a stat.
   */
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
/** Classes whose draw path differs in ways this module does not reproduce. */
const REFUSED_CLASS = /^(Weapon|.*Offhand|ItemRelic|ItemArtifact)/i;

export interface ReplayContext {
  /** True when the instance carries a rare-monster modifier or a completion bonus. */
  readonly hasModifier?: boolean;
}

export function replayItem(
  seed: number,
  base: RollDescriptor | undefined,
  prefix?: RollDescriptor,
  suffix?: RollDescriptor,
  context: ReplayContext = {},
): ReplayResult {
  // No values on fallback. Spreading the three sources together would let a
  // later one overwrite an earlier one on a shared key - the ring's 30 base and
  // 45 suffix physical modifier collapsing to 45 rather than summing - and the
  // caller already holds a correct nominal aggregate. Saying nothing is the
  // only honest answer this function can give.
  const nominal = (reason: string): ReplayResult => ({ values: {}, provenance: 'nominal', reason });

  if (!base) return nominal('no roll metadata for the base record');
  // A weapon holds its base physical damage fixed and an off-hand skips whole
  // sources, so the draw count differs before any field is read.
  if (base.itemClass && REFUSED_CLASS.test(base.itemClass)) return nominal(`class ${base.itemClass} draws differently`);
  if (context.hasModifier) return nominal('a modifier or completion bonus is a fourth source, which is not modelled');
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
  const reported: Record<string, number> = {};
  for (const [k, v] of Object.entries(values)) if (REPORTED.has(k)) reported[k] = v;
  return { values: reported, provenance: 'seed-replayed' };
}
