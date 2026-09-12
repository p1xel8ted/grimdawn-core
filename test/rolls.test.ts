import { describe, expect, it } from 'vitest';

import { BASE_JITTER_PERCENT, replayItem, rollKeys, rollSources, type RollDescriptor } from '../src/db/rolls.js';
import { ROLL_ORDER } from '../src/db/roll-order.js';
import { rollDescriptor } from '../src/db/roll-descriptor.js';

/** The live ring this was derived against: seed, records and the game's own numbers. */
const RING = {
  seed: 110505858,
  base: { fields: { attributeScalePercent: 30, augmentSkillLevel1: 3, augmentSkillLevel2: 3, augmentSkillLevel3: 3, characterOffensiveAbility: 40, defensiveLife: 22, offensiveChaosModifier: 30, offensivePhysicalModifier: 30 } } as RollDescriptor,
  prefix: { fields: { defensiveAether: 18, defensiveChaos: 18, defensivePoison: 25 }, jitter: 18 } as RollDescriptor,
  suffix: { fields: { offensivePhysicalModifier: 45, offensiveSlowPhysicalModifier: 45 }, jitter: 10 } as RollDescriptor,
};

describe('the roll order table', () => {
  it('lists every field once, in one pass', () => {
    const seen = new Set(ROLL_ORDER.map((e) => `${e.kind}:${e.field}`));
    expect(seen.size).toBe(ROLL_ORDER.length);
  });

  it('draws the defensive block after the offensive one', () => {
    const firstDef = ROLL_ORDER.findIndex((e) => e.kind === 'Def');
    const lastDmg = ROLL_ORDER.map((e) => e.kind).lastIndexOf('Dmg');
    expect(firstDef).toBeGreaterThan(lastDmg);
  });
});

describe('rollKeys', () => {
  it('reads a flat damage field as a min and a max', () => {
    expect(rollKeys('Flat', 'offensiveFire')).toEqual(['offensiveFireMin', 'offensiveFireMax']);
  });

  it('never reads the bare name for a compound kind', () => {
    // `offensiveLifeLeechMin` is the field a record actually carries; looking
    // for `offensiveLifeLeech` finds nothing and silently skips its draw.
    expect(rollKeys('Leech', 'offensiveLifeLeech')).toEqual(['offensiveLifeLeechMin']);
    expect(rollKeys('OffSlow', 'offensiveSlowFire')).toEqual(['offensiveSlowFireMin', 'offensiveSlowFireDurationMin', 'offensiveSlowFireChance']);
  });

  it('reads a scalar kind as itself', () => {
    expect(rollKeys('Def', 'defensiveAether')).toEqual(['defensiveAether']);
  });
});

describe('rollSources', () => {
  it('draws the base last only for the two kinds that do', () => {
    expect(rollSources('Char')).toEqual(['prefix', 'suffix', 'base']);
    expect(rollSources('Skill')).toEqual(['prefix', 'suffix', 'base']);
    // RetalMod reads base-first in the scalar branch, despite sitting beside
    // Char in the store list; an earlier version of this test asserted the
    // opposite and was asserting the implementation rather than the engine.
    expect(rollSources('RetalMod')).toEqual(['base', 'prefix', 'suffix']);
    expect(rollSources('Def')).toEqual(['base', 'prefix', 'suffix']);
  });
});

describe('replayItem', () => {
  it('reproduces the four resistances the game shows on the reference ring', () => {
    const out = replayItem(RING.seed, RING.base, RING.prefix, RING.suffix);
    expect(out.provenance).toBe('seed-replayed');
    expect(out.values['defensiveLife']).toBe(21);
    expect(out.values['defensiveAether']).toBe(20);
    expect(out.values['defensiveChaos']).toBe(15);
    expect(out.values['defensivePoison']).toBe(22);
  });

  it('gives two seeds of one record two answers, without either touching the other', () => {
    const a = replayItem(RING.seed, RING.base, RING.prefix, RING.suffix);
    const b = replayItem(RING.seed + 1, RING.base, RING.prefix, RING.suffix);
    expect(a.values).not.toEqual(b.values);
    expect(RING.base.fields['defensiveLife']).toBe(22);
    const again = replayItem(RING.seed, RING.base, RING.prefix, RING.suffix);
    expect(again.values).toEqual(a.values);
  });

  it('falls back whole, with a reason, on an unmodelled field', () => {
    const out = replayItem(RING.seed, RING.base, { ...RING.prefix, unsupported: ['somethingNew'] }, RING.suffix);
    expect(out.provenance).toBe('nominal');
    expect(out.reason).toContain('somethingNew');
  });

  it('returns no values when it falls back, rather than a wrong aggregate', () => {
    // The ring's physical modifier is 30 on the base and 45 on the suffix. Any
    // fallback that merged the sources by key would report 45 and lose the 30;
    // the caller already holds a correct nominal sum, so this one says nothing.
    const out = replayItem(0, RING.base, RING.prefix, RING.suffix);
    expect(out.provenance).toBe('nominal');
    expect(out.values).toEqual({});
    expect(RING.base.fields['offensivePhysicalModifier']).toBe(30);
    expect(RING.suffix.fields['offensivePhysicalModifier']).toBe(45);
  });

  it('keeps a negative value negative rather than rolling it the wrong way', () => {
    // A drawback like -20% resistance truncates to a negative spread. Flooring
    // and clamping to 1 instead would roll it as though it were a small bonus.
    const out = replayItem(RING.seed, { fields: { defensiveFire: -20 } });
    expect(out.provenance).toBe('seed-replayed');
    expect(out.values['defensiveFire']).toBeLessThan(0);
  });

  it('falls back on seed 0 rather than handing out its minimums', () => {
    expect(replayItem(0, RING.base).reason).toContain('fixed point');
  });

  it('falls back when the base record has no roll metadata', () => {
    expect(replayItem(RING.seed, undefined).provenance).toBe('nominal');
  });

  it('handles an unsigned seed above 2^31 the way the generator does', () => {
    // 4294967295 is 2M+1, so it folds to 1 rather than being rejected.
    expect(replayItem(4294967295, RING.base).values).toEqual(replayItem(1, RING.base).values);
  });

  it('treats a base record as jittered even though it declares no percentage', () => {
    expect(BASE_JITTER_PERCENT).toBe(20);
    const flat = replayItem(RING.seed, { fields: { defensiveFire: 100 } });
    expect(flat.values['defensiveFire']).toBeGreaterThanOrEqual(80);
    expect(flat.values['defensiveFire']).toBeLessThanOrEqual(120);
  });
});

describe('rollDescriptor', () => {
  it('keeps the draw-affecting fields and drops the zeros that cannot draw', () => {
    const d = rollDescriptor({ defensiveAether: 18, defensiveChaos: 0, mesh: 'items/x.msh', lootRandomizerJitter: 18 });
    expect(d.fields).toEqual({ defensiveAether: 18 });
    expect(d.jitter).toBe(18);
    expect(d.unsupported).toBeUndefined();
  });

  it('passes over the stats the engine carries through without rolling', () => {
    // defensiveProtection is every armour piece's rating; treating it as an
    // unknown would refuse most of a character's gear.
    expect(rollDescriptor({ defensiveProtection: 1570, characterManaRegen: 3 }).unsupported).toBeUndefined();
  });

  it('refuses a record carrying a kind whose draws are not modelled', () => {
    expect(rollDescriptor({ conversionInType: 'Physical', conversionPercentage: 100 }).unsupported).toContain('conversionInType');
    expect(rollDescriptor({ offensiveSlowBleedingDurationMin: 3 }).unsupported).toContain('offensiveSlowBleedingDurationMin');
  });

  it('refuses an unknown numeric field rather than assuming it is harmless', () => {
    expect(rollDescriptor({ someNewStat: 12 }).unsupported).toEqual(['someNewStat']);
  });

  it('ignores an unknown field that is only present at zero', () => {
    // Records carry the whole template, so nearly every field is present and
    // zero. A zero draws nothing, so refusing on presence would refuse all gear.
    expect(rollDescriptor({ someNewStat: 0 }).unsupported).toBeUndefined();
  });

  it('ignores description, art and slot restrictions', () => {
    const d = rollDescriptor({ bitmap: 'a.tex', armorMaleMesh: 'b.msh', head: 1, untradeable: 1, itemNameTag: 'tagX' });
    expect(d.unsupported).toBeUndefined();
    expect(d.fields).toEqual({});
  });
});
