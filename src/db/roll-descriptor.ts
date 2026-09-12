/**
 * Extracting an item or affix record's roll metadata at database build time.
 *
 * The replay in `rolls.ts` needs the raw draw-affecting fields, and the indexed
 * `stats` map is not those: it has already dropped zeros, folded some fields and
 * discarded others. Re-opening the archives per item to get them back would
 * multiply the I/O and risk mixing two snapshots, so the descriptor is built
 * once, next to the record it describes.
 *
 * The descriptor is deliberately small: only the fields the traversal reads,
 * plus a note of anything active it does not model. A record that carries an
 * unmodelled draw-affecting field cannot be replayed at all, because one
 * unknown draw shifts every value after it.
 */

import { SLOT_FLAG_KEYS } from './slot-flags.js';
import { ROLL_ORDER } from './roll-order.js';
import { rollKeys, UNMODELLED_KINDS, type RollDescriptor } from './rolls.js';

/** Every key the traversal can read, expanded once. */
const DRAW_KEYS: ReadonlySet<string> = new Set(
  ROLL_ORDER.filter((e) => !UNMODELLED_KINDS.has(e.kind)).flatMap((e) => rollKeys(e.kind, e.field)),
);

/** Keys belonging to kinds we refuse: present in the table, not safe to replay. */
const REFUSED_KEYS: ReadonlySet<string> = new Set(
  ROLL_ORDER.filter((e) => UNMODELLED_KINDS.has(e.kind)).flatMap((e) => rollKeys(e.kind, e.field)),
);

/**
 * Stats the engine carries through untouched rather than rolling.
 *
 * Established from the reference's own FIXED set at the pinned revision. These
 * appear on ordinary gear - `defensiveProtection` is every armour piece's
 * rating - so treating them as unknown would refuse most of a character.
 */
const FIXED: ReadonlySet<string> = new Set([
  'characterBaseAttackSpeed', 'characterManaRegen', 'characterConstitution', 'characterAttackSpeed',
  'characterSpellCastSpeed', 'characterRunSpeed', 'characterIncreasedExperience', 'characterIncreasedGold',
  'characterLightRadius', 'characterGlobalReqReduction', 'characterLevelReqReduction', 'characterModifierPoints',
  'defensiveProtection',
]);

/**
 * Fields that never reach the stream: presentation, physics, loot-table
 * bookkeeping and the identity strings. Anything outside this list and outside
 * `DRAW_KEYS` is treated as unmodelled rather than assumed harmless.
 */
const IRRELEVANT = /^(actor|physics|mesh|bitmap|baseTexture|shader|scale$|maxTransparency|outlineThickness|castsShadows|drop|use|sound|fx|Class$|templateName|FileDescription|description|itemNameTag|itemText|itemClassification|itemLevel|itemCost|levelRequirement|lootRandomizer|marketAdjustmentPercent|itemSet|augmentSkill|augmentMastery|itemSkill|skillName|attributeScalePercent|completedRelicLevel|relic|artifact|blueprint|experience|expansion|craftingMaterial|soulbound|untradeable|medalVisible|forceWeaponAnimation|weaponType)/;

/** Use-on restriction flags: which slots a socketable accepts, never a stat. */
const SLOT_FLAGS: ReadonlySet<string> = new Set(SLOT_FLAG_KEYS);

/** Numeric-ish record value, or undefined when the field is not a number. */
function numeric(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

/**
 * Build the descriptor for one raw record.
 *
 * `jitter` is the affix's own `lootRandomizerJitter`; a base record has none and
 * the replay supplies the engine's constant instead.
 */
export function rollDescriptor(fields: Readonly<Record<string, unknown>>): RollDescriptor {
  const kept: Record<string, number> = {};
  const unsupported: string[] = [];

  for (const [key, raw] of Object.entries(fields)) {
    const value = numeric(raw);
    if (DRAW_KEYS.has(key)) {
      // A non-numeric value on a field that should draw is not something to
      // skip past: we cannot tell what the engine would do with it.
      if (value === undefined) { unsupported.push(key); continue; }
      // Zeros are dropped because a zero never draws, so it cannot move the
      // stream. Presence alone matters nowhere in the kinds we model; the kinds
      // where it does are refused outright below.
      if (value !== 0) kept[key] = value;
      continue;
    }
    // A field of a kind we do not model faithfully. Records carry the whole
    // template, so almost every one of these is present at zero; a zero draws
    // nothing and cannot move the stream, so only an active one is fatal.
    if (REFUSED_KEYS.has(key)) {
      if (value === undefined || value !== 0) unsupported.push(key);
      continue;
    }
    if (FIXED.has(key) || IRRELEVANT.test(key) || SLOT_FLAGS.has(key)) continue;
    // Conversion reads its type strings to decide whether to draw at all, and
    // conversion is a kind we refuse, so any of them makes the item unsafe.
    if (/^conversion/i.test(key)) { unsupported.push(key); continue; }
    // A non-numeric value cannot be rolled: meshes, textures, tags and table
    // names are description, and the engine has nothing to jitter there.
    if (value === undefined) continue;
    // An unknown numeric field that is actually set is the dangerous case: it
    // may or may not draw, and we cannot tell, so the record stops being
    // replayable rather than being replayed on an assumption.
    if (value !== 0) unsupported.push(key);
  }

  const jitter = numeric(fields['lootRandomizerJitter']);
  const itemClass = typeof fields['Class'] === 'string' ? fields['Class'] : undefined;
  return {
    fields: kept,
    ...(itemClass ? { itemClass } : {}),
    ...(jitter ? { jitter } : {}),
    ...(unsupported.length ? { unsupported: unsupported.sort() } : {}),
  };
}
