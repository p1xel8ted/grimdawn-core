/**
 * Where Grim Dawn keeps its saves on this machine.
 *
 * `GD_SAVE_DIR` wins, then the search, then a constant nobody should reach.
 * That constant is the developer's own CrossOver bottle, and while it was the
 * only fallback this function was wrong on every machine but one: `homedir()`
 * on Windows is the user profile, so joining a macOS Application Support path
 * onto it produced a hybrid that cannot exist. `findSaveDirs` was already
 * right and already what both apps resolve settings through, so this is the
 * same answer reached by the same road.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { documentRoots, safeReaddir, steamRoots, STEAM_APP_ID } from './platform.js';

/** Last resort: a real path on the machine this was written on, and nowhere else. */
const DEFAULT_SAVE_DIR = join(
  homedir(),
  'Library/Application Support/CrossOver/Bottles/Steam/drive_c',
  'Program Files (x86)/Steam/userdata/42909985/219990/remote/save',
);

let detected: string | undefined;
let searched = false;

/**
 * Root of the save tree: contains `main/<character>/`, `user/` and the shared
 * `.gst` files.
 *
 * The search runs once and is remembered: this is the default argument of five
 * path helpers below, and a drive scan per call is not what a caller asks for
 * by leaving a parameter off. Drives do not appear mid-process.
 */
export function saveDir(): string {
  if (process.env.GD_SAVE_DIR) return process.env.GD_SAVE_DIR;
  if (!searched) {
    detected = findSaveDirs()[0];
    searched = true;
  }
  return detected ?? DEFAULT_SAVE_DIR;
}

/**
 * Which tree a character lives in.
 *
 * `main` is the campaign. `user` is what the game's "Custom Game" writes —
 * characters made on a mod or a custom map (the mod's own account-wide stashes
 * sit beside the campaign's, in `save/<mod>/`). The two trees are independent
 * namespaces, and a name can exist in both: this machine has a `_Suchka` in
 * each. Only the campaign tree is a save directory's identity, which is why
 * `findSaveDirs` still looks for `main/`.
 */
export type SaveTree = 'main' | 'user';

export const SAVE_TREES: readonly SaveTree[] = ['main', 'user'];

export function characterSavePath(character: string, dir = saveDir(), tree: SaveTree = 'main'): string {
  return join(dir, tree, character, 'player.gdc');
}

/** Shared (softcore) transfer stash. Hardcore's `.gsh` twin is out of scope for now. */
export function transferStashPath(dir = saveDir()): string {
  return join(dir, 'transfer.gst');
}

/** Account-wide learned blueprints. */
export function formulasPath(dir = saveDir()): string {
  return join(dir, 'formulas.gst');
}

/**
 * Account-wide crafting materials **and loose components**. Every component not
 * installed in a piece of gear lives here rather than in a bag, which is why a
 * tool that never opened this file reported the user owning almost none.
 */
export function reagentsPath(dir = saveDir()): string {
  return join(dir, 'reagents.gst');
}

/** The potion recipe list. Same format as `reagents.gst`, no quantities. */
export function potionsPath(dir = saveDir()): string {
  return join(dir, 'potions.gst');
}

/**
 * Every save tree on this machine, best first.
 *
 * Two locations, and which one is real depends on the *store and its settings*
 * rather than on the platform:
 *
 *   - **Steam with cloud saves on** writes to `userdata/<accountId>/219990/
 *     remote/save`. That is the normal Steam setup and the one this machine uses.
 *   - **GOG, and Steam with cloud saves off**, write to
 *     `Documents/My Games/Grim Dawn/save` — inside the wrapper's fake Windows
 *     profile under CrossOver, in the real one on Windows.
 *
 * A directory counts only if it has a `main/` in it, which is where characters
 * live: an empty `save` folder is left behind by an uninstall and would otherwise
 * shadow the tree that has the saves in it.
 */
export function findSaveDirs(): string[] {
  const found: string[] = [];
  for (const steam of steamRoots()) {
    const userdata = join(steam, 'userdata');
    for (const account of safeReaddir(userdata)) {
      found.push(join(userdata, account, STEAM_APP_ID, 'remote/save'));
    }
  }
  for (const documents of documentRoots()) {
    found.push(join(documents, 'My Games/Grim Dawn/save'));
  }
  return [...new Set(found)].filter((dir) => existsSync(join(dir, 'main')));
}

/** The best save tree, or nothing. `GD_SAVE_DIR` wins over all of it. */
export function findSaveDir(): string | undefined {
  if (process.env.GD_SAVE_DIR) return process.env.GD_SAVE_DIR;
  return findSaveDirs()[0];
}

/**
 * Character directory names in one of the save trees — the campaign by default,
 * `user` for the characters a Custom Game writes. The default keeps a caller that
 * has no opinion (the advisor, the session) on the campaign, which is the only
 * tree that app models: a custom game's items come from a mod's database, and it
 * reads the installed game's. A tool that edits saves rather than reading items
 * has no such limit and asks for both.
 */
export function listCharacters(dir: string, tree: SaveTree = 'main'): string[] {
  return safeReaddir(join(dir, tree))
    .filter((name) => existsSync(join(dir, tree, name, 'player.gdc')))
    .sort();
}
