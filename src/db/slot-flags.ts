/**
 * Which slots a socketable may be applied to.
 *
 * Template boolean fields on component and augment records, value 1 when the
 * socketable fits that piece of gear. They are restrictions rather than stats,
 * so the indexer lifts them out of `stats` and the roll descriptor knows they
 * never reach the random stream.
 */
export const SLOT_FLAG_KEYS = [
  'amulet',
  'medal',
  'ring',
  'head',
  'chest',
  'shoulders',
  'hands',
  'legs',
  'feet',
  'waist',
  'offhand',
  'shield',
  'sword',
  'sword2h',
  'axe',
  'axe2h',
  'mace',
  'mace2h',
  'dagger',
  'scepter',
  'spear2h',
  'ranged1h',
  'ranged2h',
] as const;
