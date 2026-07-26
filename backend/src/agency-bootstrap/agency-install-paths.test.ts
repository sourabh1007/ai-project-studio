import { describe, it, expect } from 'vitest';
import {
  agencyInstallPaths,
  resolveAgencyExecutable,
} from './agency-install-paths.js';

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

  it('expands versioned install folders on Windows via listDir', () => {
    const paths = agencyInstallPaths(
      'win32',
      { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' },
      'C:\\Users\\me',
      (dir) => {
        expect(dir).toBe('C:\\Users\\me\\AppData\\Roaming\\agency');
        return ['2026.7.23.10', '2026.7.24.7', 'CurrentVersion'];
      },
    );
    expect(paths).toEqual([
      'C:\\Users\\me\\AppData\\Roaming\\agency\\CurrentVersion\\agency.exe',
      'C:\\Users\\me\\AppData\\Roaming\\agency\\2026.7.23.10\\agency.exe',
      'C:\\Users\\me\\AppData\\Roaming\\agency\\2026.7.24.7\\agency.exe',
    ]);
  });
});

describe('resolveAgencyExecutable', () => {
  it('returns the first existing candidate path', () => {
    const resolved = resolveAgencyExecutable(
      ['/a/agency', '/b/agency', '/c/agency'],
      (path) => path === '/b/agency' || path === '/c/agency',
    );
    expect(resolved).toBe('/b/agency');
  });

  it('returns null when no candidate exists', () => {
    expect(resolveAgencyExecutable(['/a', '/b'], () => false)).toBeNull();
  });
});
