import { describe, it, expect } from 'vitest';
import { agencyInstallPaths } from './agency-install-paths.js';

describe('agencyInstallPaths', () => {
  it('uses the roaming AppData path on Windows when APPDATA is set', () => {
    const paths = agencyInstallPaths(
      'win32',
      { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' },
      'C:\\Users\\me',
    );
    expect(paths).toEqual([
      'C:\\Users\\me\\AppData\\Roaming\\agency\\CurrentVersion\\agency.exe',
    ]);
  });

  it('falls back to the home directory when APPDATA is empty on Windows', () => {
    const paths = agencyInstallPaths('win32', { APPDATA: '' }, 'C:\\Users\\me');
    expect(paths).toEqual([
      'C:\\Users\\me\\AppData\\Roaming\\agency\\CurrentVersion\\agency.exe',
    ]);
  });

  it('returns common bin locations on non-Windows platforms', () => {
    const paths = agencyInstallPaths('linux', {}, '/home/me');
    expect(paths).toEqual([
      '/home/me/.local/bin/agency',
      '/home/me/.agency/bin/agency',
      '/usr/local/bin/agency',
    ]);
  });
});
