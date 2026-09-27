import { execFile } from 'node:child_process';
import { lstat, opendir, realpath, statfs, unlink } from 'node:fs/promises';
import { cpus } from 'node:os';
import type { ProcessReading, ProcessSample, ResourceFileSystem, ResourcesService } from './resources-contract.js';

export const resourceFileSystem: ResourceFileSystem = {
  realPath: realpath,
  async stat(path) {
    const stat = await lstat(path, { bigint: true });
    return {
      kind: stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other',
      size: Number(stat.size), identity: `${stat.dev}:${stat.ino}`, modifiedAt: Number(stat.mtimeMs), linkCount: Number(stat.nlink),
    };
  },
  async *entries(path) {
    const directory = await opendir(path);
    for await (const entry of directory) yield entry.name;
  },
  unlink,
  async volume(path) {
    const stat = await statfs(path, { bigint: true });
    return {
      totalBytes: Number(stat.blocks * stat.bsize), freeBytes: Number(stat.bfree * stat.bsize),
      availableBytes: Number(stat.bavail * stat.bsize),
    };
  },
};

/** No raw command lines leave the sampler: only a coarse role classification does. */
const WINDOWS_SAMPLE = `
$ErrorActionPreference='Stop'
$rows = @(Get-CimInstance Win32_Process | ForEach-Object {
  $role = 'child'
  if ($_.CommandLine -match '--type=renderer') { $role='renderer' }
  elseif ($_.CommandLine -match '--type=gpu-process') { $role='gpu' }
  elseif ($_.CommandLine -match '--type=utility') { $role='utility' }
  elseif ($_.Name -match '(agency|copilot)' -or $_.CommandLine -match '(agency|copilot)[\\\\/].*\\.(js|cjs|mjs)') { $role='cli' }
  $cpu = $null
  if ($null -ne $_.KernelModeTime -and $null -ne $_.UserModeTime) {
    $cpu = ([double]$_.KernelModeTime + [double]$_.UserModeTime) / 10000
  }
  $memory = $null
  if ($null -ne $_.WorkingSetSize) { $memory=[double]$_.WorkingSetSize }
  if ($null -ne $_.CreationDate) {
    @{
      pid=[int]$_.ProcessId; parentPid=[int]$_.ParentProcessId
      startedAt=([DateTimeOffset]$_.CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds()
      name=$_.Name; role=$role; cpuTimeMs=$cpu; memoryBytes=$memory
    }
  }
})
ConvertTo-Json -InputObject $rows -Compress
`;

export function createProcessSampler(timeoutMs: number): (signal: AbortSignal) => Promise<ProcessSample> {
  return (signal) => new Promise((resolve, reject) => {
    if (process.platform !== 'win32') {
      reject(new Error('App process-tree sampling is currently supported on Windows only; host pressure remains available.'));
      return;
    }
    const child = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_SAMPLE], {
      windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, signal,
    }, (error, stdout) => {
      if (error) { reject(error); return; }
      try {
        const rows = JSON.parse(stdout) as ProcessReading[];
        resolve({
          measuredAt: Date.now(), logicalCpuCount: cpus().length,
          processes: rows.filter((row) => row.pid !== child.pid && row.parentPid !== child.pid),
        });
      } catch (error) { reject(error); }
    });
  });
}

export function startResourceSampling(service: ResourcesService, intervalMs: number): () => void {
  void service.sample();
  service.refreshStorage();
  const timer = setInterval(() => { void service.sample(); }, intervalMs);
  timer.unref();
  return () => { clearInterval(timer); service.dispose(); };
}
