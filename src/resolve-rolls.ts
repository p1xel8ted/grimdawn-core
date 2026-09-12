/**
 * The seed-replayed resistances for one saved item, when they can be had.
 *
 * Deliberately not part of `resolveItem`. Resolution is the path every consumer
 * already takes and its numbers are the record's own; this is an opt-in beside
 * it, so nothing changes for a caller that does not ask. A caller that does ask
 * gets a per-instance result it can use *instead of* the nominal resistances,
 * never merged into them, and a provenance saying which it received.
 */

import { replayItem, type ReplayResult } from './db/rolls.js';
import type { GameDb } from './db/types.js';
import type { ItemInstance } from './save/types.js';

/**
 * Replay one instance's resistances.
 *
 * **These replace the base, prefix and suffix contributions only.** A worn
 * item's resistances also come from its component, its augment, a completion
 * bonus and a set, and none of those are here: they do not roll, and the caller
 * adds them exactly as it does today. Treating the returned figures as the
 * item's whole resistance would quietly drop everything socketed into it.
 *
 * Falls back to `nominal` with a reason whenever anything is unknown: an
 * unindexed record, an affix we failed to read, a class whose draws differ, or
 * a fourth source. The caller keeps its own nominal figures in that case, which
 * is why the fallback carries no values of its own.
 */
export function replayItemResistances(inst: ItemInstance, db: GameDb): ReplayResult {
  const base = db.getItem(inst.baseName);
  if (!base) return { values: {}, provenance: 'nominal', reason: `no record for ${inst.baseName || '(empty)'}` };

  // An affix named by the save is a source whose draws happened. Not finding
  // its record, or finding one with no roll metadata, are the same problem: we
  // cannot see those draws, and replaying without them silently drops a whole
  // source rather than failing. Only an affix the save does not name is absent.
  for (const record of [inst.prefixName, inst.suffixName]) {
    if (!record) continue;
    const found = db.getAffix(record);
    if (!found) return { values: {}, provenance: 'nominal', reason: `affix ${record} is not in the database` };
    if (!found.rolls) return { values: {}, provenance: 'nominal', reason: `affix ${record} has no roll metadata` };
  }

  const affix = (record: string) => (record ? db.getAffix(record)?.rolls : undefined);
  return replayItem(inst.seed, base.rolls, affix(inst.prefixName), affix(inst.suffixName), {
    // A rare-monster modifier and a relic completion bonus are both a fourth
    // source the walk does not model.
    hasModifier: Boolean(inst.modifierName || inst.relicBonus),
  });
}
