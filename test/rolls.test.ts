import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { readCachedDb, writeCachedDb } from '../src/db/cache.js';
import { DB_SCHEMA_VERSION, type NormalizedDb } from '../src/db/build.js';

import { BASE_JITTER_PERCENT, REPLAYED_RESISTANCES, SKIPPED_KINDS, replayItem, rollKeys, rollSources, type RollDescriptor } from '../src/db/rolls.js';
import { ROLL_ORDER } from '../src/db/roll-order.js';
import { rollDescriptor } from '../src/db/roll-descriptor.js';
import { replayItemResistances } from '../src/resolve-rolls.js';
import type { GameDb } from '../src/db/types.js';
import type { ItemInstance } from '../src/save/types.js';

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

  it('draws every reported resistance before the point the walk stops at', () => {
    // This is the whole argument for stopping instead of modelling conversion:
    // a draw taken after the last reported field cannot move one. If a future
    // table moves a reported field past the stop, the skip stops being exact
    // and this fails rather than quietly returning a wrong number.
    const stop = ROLL_ORDER.findIndex((e) => SKIPPED_KINDS.has(e.kind));
    expect(stop).toBeGreaterThan(-1);
    for (const field of REPLAYED_RESISTANCES) {
      const at = ROLL_ORDER.findIndex((e) => e.field === field);
      expect(at, `${field} is not in the table`).toBeGreaterThan(-1);
      expect(at, `${field} is drawn at or after the stop`).toBeLessThan(stop);
    }
    // Nothing but Def lies between the last reported field and the stop, so
    // there is no unmodelled kind hiding in the gap.
    const last = Math.max(...REPLAYED_RESISTANCES.map((f) => ROLL_ORDER.findIndex((e) => e.field === f)));
    expect([...new Set(ROLL_ORDER.slice(last + 1, stop).map((e) => e.kind))]).toEqual(['Def']);
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
    // OffSlow pairs a value with a duration and a chance, and none of the three
    // is reproduced here.
    expect(rollDescriptor({ offensiveSlowRunSpeedMin: 30 }).unsupported).toContain('offensiveSlowRunSpeedMin');
    // A skill field on an affix is drawn before the main walk, so it stays
    // refused even though the table lists it after the point the walk stops at.
    expect(rollDescriptor({ skillCooldownReduction: 2 }).unsupported).toContain('skillCooldownReduction');
  });

  it('carries the six conversion keys but refuses any other one', () => {
    const known = rollDescriptor({
      conversionInType: 'Physical', conversionOutType: 'Fire', conversionPercentage: 100,
      conversionInType2: 'Cold', conversionOutType2: 'Aether', conversionPercentage2: 50,
    });
    expect(known.unsupported).toBeUndefined();
    // Matching the whole prefix would wave through a key nobody has looked at.
    expect(rollDescriptor({ conversionSomethingNew: 12 }).unsupported).toEqual(['conversionSomethingNew']);
  });

  it('carries a slow-flat duration and chance, which are read but never rolled', () => {
    const d = rollDescriptor({ offensiveSlowBleedingMin: 20, offensiveSlowBleedingDurationMin: 3, offensiveSlowBleedingChance: 25 });
    expect(d.unsupported).toBeUndefined();
    expect(d.fields).toEqual({ offensiveSlowBleedingMin: 20 });
  });

  it('records the slow-flat families whose duration key is missing', () => {
    // Presence, not value: a Min of 0 closes the gate exactly as a 20 would,
    // and the pruned field map has already dropped the zero by this point.
    expect(rollDescriptor({ offensiveSlowFireMin: 0 }).slowFlatNoDuration).toEqual(['offensiveSlowFire']);
    expect(rollDescriptor({ offensiveSlowFireMin: 0, offensiveSlowFireDurationMin: 0 }).slowFlatNoDuration).toBeUndefined();
    expect(rollDescriptor({ defensiveAether: 100 }).slowFlatNoDuration).toBeUndefined();
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

describe('the boundaries a wrong answer would slip through', () => {
  // The three cases below share a prefix and a seed and differ only in which
  // keys the base record owns. The engine gates the slow-flat family on the
  // base owning a Min with no DurationMin beside it, so the first skips the
  // family and the other two draw it: 106 against 107 is that one draw. Every
  // figure is the pinned reference's own output for the same input.
  const SLOW_PREFIX = { offensiveSlowFireMin: 10, lootRandomizerJitter: 20 };

  it('skips a slow-flat family the base owns a Min for and no duration', () => {
    // The base value is 0 and the prefix's is 10, so a walk that went by value
    // would draw here and read every later field one draw out.
    const base = rollDescriptor({ offensiveSlowFireMin: 0, defensiveAether: 100 });
    const out = replayItem(12345, base, rollDescriptor(SLOW_PREFIX));
    expect(out.provenance).toBe('seed-replayed');
    expect(out.values['defensiveAether']).toBe(106);
  });

  it('draws the family when the duration key is there, even at zero', () => {
    const base = rollDescriptor({ offensiveSlowFireMin: 0, offensiveSlowFireDurationMin: 0, defensiveAether: 100 });
    expect(base.slowFlatNoDuration).toBeUndefined();
    expect(replayItem(12345, base, rollDescriptor(SLOW_PREFIX)).values['defensiveAether']).toBe(107);
  });

  it('draws the family when the base does not own the Min at all', () => {
    // An affix without a duration does not close the gate; only the base can.
    const base = rollDescriptor({ defensiveAether: 100 });
    expect(replayItem(12345, base, rollDescriptor(SLOW_PREFIX)).values['defensiveAether']).toBe(107);
  });

  it('reports the same resistances whether or not a record converts', () => {
    // Conversion is drawn after every reported resistance, so adding it to an
    // otherwise identical record must not move one.
    const plain = rollDescriptor({ defensiveAether: 100, defensiveFire: 40 });
    const converting = rollDescriptor({
      defensiveAether: 100, defensiveFire: 40,
      conversionInType: 'Physical', conversionOutType: 'Fire', conversionPercentage: 100,
    });
    expect(replayItem(12345, converting).values).toEqual(replayItem(12345, plain).values);
    expect(replayItem(12345, plain).values).toEqual({ defensiveAether: 107, defensiveFire: 42 });
  });

  it('refuses a weapon, whose base physical damage is fixed rather than rolled', () => {
    const base = rollDescriptor({ Class: 'WeaponMelee_Sword', offensivePhysicalMin: 10, offensivePhysicalMax: 20, defensiveAether: 100 });
    expect(base.itemClass).toBe('WeaponMelee_Sword');
    const out = replayItem(12345, base);
    expect(out.provenance).toBe('nominal');
    expect(out.reason).toContain('WeaponMelee_Sword');
  });

  it('refuses an off-hand and a relic for the same reason', () => {
    expect(replayItem(12345, rollDescriptor({ Class: 'ArmorProtective_Offhand', defensiveAether: 100 })).provenance).toBe('nominal');
    expect(replayItem(12345, rollDescriptor({ Class: 'ItemRelic', defensiveAether: 100 })).provenance).toBe('nominal');
  });

  it('refuses when a fourth source is present, which it does not model', () => {
    const out = replayItem(12345, rollDescriptor({ defensiveAether: 100 }), undefined, undefined, { hasModifier: true });
    expect(out.provenance).toBe('nominal');
    expect(out.reason).toContain('fourth source');
  });

  it('still replays an ordinary armour piece', () => {
    const out = replayItem(12345, rollDescriptor({ Class: 'ArmorProtective_Chest', defensiveAether: 100 }));
    expect(out.provenance).toBe('seed-replayed');
  });
});

describe('what the replay hands back', () => {
  it('reports resistances and keeps its working to itself', () => {
    // The walk has to compute offensive values to consume the right draws, but
    // they are unscaled intermediates - handing one out invites a caller to use
    // it as a stat.
    const out = replayItem(RING.seed, RING.base, RING.prefix, RING.suffix);
    expect(out.provenance).toBe('seed-replayed');
    expect(Object.keys(out.values).every((k) => REPLAYED_RESISTANCES.includes(k))).toBe(true);
    expect(out.values['offensivePhysicalModifier']).toBeUndefined();
    expect(out.values['characterOffensiveAbility']).toBeUndefined();
    // …while the resistances it does report are unchanged by the filtering.
    expect(out.values['defensiveAether']).toBe(20);
  });
});

describe('a record with no descriptor', () => {

  it('treats a record with no descriptor as unreplayable rather than as empty', () => {
    // A DbItem built in code, or one read from a cache written before the
    // descriptor existed, has none. Reading that as "no fields" would replay
    // an item whose draws we never saw.
    expect(replayItem(RING.seed, undefined).provenance).toBe('nominal');
  });

});

describe('replayItemResistances, through a database', () => {
  const armour = (rolls?: unknown) => ({ record: 'r/base.dbr', name: 'Coat', levelReq: 1, rarity: 'Rare', slot: 'ArmorProtective_Chest', iconPath: '', stats: {}, ...(rolls ? { rolls } : {}) });
  const stub = (opts: { base?: unknown; affix?: unknown; affixKnown?: boolean }) =>
    ({
      getItem: (r: string) => (r === 'r/base.dbr' ? opts.base : undefined),
      getAffix: (r: string) => (r === 'r/pfx.dbr' && opts.affixKnown !== false ? opts.affix : undefined),
    }) as unknown as GameDb;
  const inst = (prefixName = '') =>
    ({ baseName: 'r/base.dbr', prefixName, suffixName: '', modifierName: '', relicBonus: '', seed: 12345 }) as ItemInstance;

  it('replays an item whose base is indexed and which names no affix', () => {
    const out = replayItemResistances(inst(), stub({ base: armour(rollDescriptor({ defensiveAether: 100 })) }));
    expect(out.provenance).toBe('seed-replayed');
    expect(out.values['defensiveAether']).toBeGreaterThan(0);
  });

  it('declines when the base record is not in the database', () => {
    const out = replayItemResistances({ ...inst(), baseName: 'r/missing.dbr' }, stub({}));
    expect(out.provenance).toBe('nominal');
    expect(out.reason).toContain('no record');
  });

  it('declines when the base record has no roll metadata', () => {
    // A DbItem built in code, or read from a cache written before descriptors
    // existed. Replaying it would be replaying draws we never saw.
    const out = replayItemResistances(inst(), stub({ base: armour() }));
    expect(out.provenance).toBe('nominal');
    expect(out.reason).toContain('no roll metadata');
  });

  it('declines when a named affix has no roll metadata, rather than dropping the source', () => {
    // The affix record exists, so an existence check passes; without its
    // metadata the replay would run as though the item had no prefix at all
    // and quietly lose every draw that prefix made.
    const out = replayItemResistances(inst('r/pfx.dbr'), stub({
      base: armour(rollDescriptor({ defensiveAether: 100 })),
      affix: { record: 'r/pfx.dbr', stats: {} },
    }));
    expect(out.provenance).toBe('nominal');
    expect(out.reason).toContain('no roll metadata');
  });

  it('declines when a named affix is not in the database at all', () => {
    const out = replayItemResistances(inst('r/pfx.dbr'), stub({
      base: armour(rollDescriptor({ defensiveAether: 100 })), affixKnown: false,
    }));
    expect(out.provenance).toBe('nominal');
    expect(out.reason).toContain('not in the database');
  });

  it('a named affix with metadata changes the answer, which is why the others must decline', () => {
    const withAffix = replayItemResistances(inst('r/pfx.dbr'), stub({
      base: armour(rollDescriptor({ defensiveAether: 100 })),
      affix: { record: 'r/pfx.dbr', stats: {}, rolls: rollDescriptor({ defensiveAether: 40, lootRandomizerJitter: 20 }) },
    }));
    const without = replayItemResistances(inst(), stub({ base: armour(rollDescriptor({ defensiveAether: 100 })) }));
    expect(withAffix.provenance).toBe('seed-replayed');
    expect(withAffix.values['defensiveAether']).not.toBe(without.values['defensiveAether']);
  });
});

describe('roll metadata through the real cache', () => {
  const withCacheDir = <T>(fn: () => T): T => {
    const dir = mkdtempSync(join(tmpdir(), 'gd-rollcache-'));
    const had = process.env['GD_CACHE_DIR'];
    process.env['GD_CACHE_DIR'] = dir;
    try { return fn(); } finally {
      if (had === undefined) delete process.env['GD_CACHE_DIR']; else process.env['GD_CACHE_DIR'] = had;
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const db = (schemaVersion: number): NormalizedDb =>
    ({
      schemaVersion, gameVersion: 'v1.3.0.8', locale: 'en', locales: ['en'], fingerprint: 'rolltest',
      builtAt: new Date().toISOString(), archives: [], sets: {}, skills: {}, l10n: {},
      items: { 'r/base.dbr': { record: 'r/base.dbr', name: 'Coat', levelReq: 1, rarity: 'Rare', slot: 'ArmorProtective_Chest', iconPath: '', stats: {}, rolls: rollDescriptor({ Class: 'ArmorProtective_Chest', defensiveAether: 18, someNewStat: 4 }) } },
      affixes: { 'r/pfx.dbr': { record: 'r/pfx.dbr', stats: {}, rolls: rollDescriptor({ defensiveFire: 20, lootRandomizerJitter: 18 }) } },
    }) as unknown as NormalizedDb;

  it('keeps the fields, the class, the jitter and the refusal note across a write and read', () => {
    withCacheDir(() => {
      writeCachedDb(db(DB_SCHEMA_VERSION));
      const back = readCachedDb('rolltest', 'en');
      expect(back).toBeDefined();
      const item = back!.items['r/base.dbr']!;
      expect(item.rolls?.fields).toEqual({ defensiveAether: 18 });
      expect(item.rolls?.itemClass).toBe('ArmorProtective_Chest');
      expect(item.rolls?.unsupported).toEqual(['someNewStat']);
      expect(back!.affixes['r/pfx.dbr']!.rolls?.jitter).toBe(18);
    });
  });

  it('rejects a database written before the descriptor existed', () => {
    // Reading an 18 back would give items with no metadata, which is not
    // distinguishable from items with nothing to roll.
    withCacheDir(() => {
      writeCachedDb(db(18));
      expect(readCachedDb('rolltest', 'en')).toBeUndefined();
    });
  });
});
