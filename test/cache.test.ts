import { join, win32 } from 'node:path';
import { describe, expect, it } from 'vitest';

import { defaultCacheRoot } from '../src/db/cache.js';

describe('defaultCacheRoot', () => {
  it('shares the native roaming app-data cache on Windows', () => {
    expect(
      defaultCacheRoot({
        platform: 'win32',
        env: { APPDATA: 'D:\\Profiles\\Player\\AppData\\Roaming' },
        home: 'D:\\Profiles\\Player',
      }),
    ).toBe('D:\\Profiles\\Player\\AppData\\Roaming\\grimdawn-core\\cache');
  });

  it('falls back to the conventional roaming directory when APPDATA is absent', () => {
    expect(defaultCacheRoot({ platform: 'win32', env: {}, home: 'C:\\Users\\Player' })).toBe(
      win32.join('C:\\Users\\Player', 'AppData', 'Roaming', 'grimdawn-core', 'cache'),
    );
  });

  it('keeps the shared macOS Application Support cache', () => {
    expect(defaultCacheRoot({ platform: 'darwin', env: {}, home: '/Users/player' })).toBe(
      join('/Users/player', 'Library/Application Support/grimdawn-core/cache'),
    );
  });

  it('keeps cache-only and whole-run overrides ahead of the platform default', () => {
    expect(
      defaultCacheRoot({
        platform: 'win32',
        env: { GD_CACHE_DIR: 'X:\\cache-only', GD_DATA_DIR: 'X:\\whole-run' },
        home: 'C:\\Users\\Player',
      }),
    ).toBe('X:\\cache-only');
    expect(
      defaultCacheRoot({ platform: 'win32', env: { GD_DATA_DIR: 'X:\\whole-run' }, home: 'C:\\Users\\Player' }),
    ).toBe('X:\\whole-run\\cache');
  });
});
