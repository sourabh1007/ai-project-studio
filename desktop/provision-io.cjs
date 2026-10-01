'use strict';

// Shared IO primitives for provisioning external runtimes/binaries (Node, Git,
// GitHub CLI, …): HTTPS download with redirect/progress handling, checksum
// verification, and cross-platform archive extraction. Kept dependency-free and
// injectable so the provisioners that use it stay unit-testable.

const https = require('node:https');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const nodeFs = require('node:fs');
const nodePath = require('node:path');

/** GETs a URL as a UTF-8 string, following redirects (used for checksum files). */
function httpGetText(url, signal, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { signal }, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        if (redirectsLeft <= 0) {
          reject(new Error(`Too many redirects fetching ${url}`));
          return;
        }
        resolve(httpGetText(new URL(response.headers.location, url).toString(), signal, redirectsLeft - 1));
        return;
      }
      if (status !== 200) {
        response.resume();
        reject(new Error(`Unexpected status ${status} fetching ${url}`));
        return;
      }
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      response.on('error', reject);
    });
    request.on('error', reject);
    request.setTimeout(30000, () => request.destroy(new Error(`Timed out fetching ${url}`)));
  });
}

/**
 * Streams a URL to `destPath` (following redirects), reporting fractional
 * progress [0..1] when a content length is known. Writes to a temp sibling and
 * renames into place so an interrupted download never leaves a half file.
 */
function downloadToFile(url, destPath, onProgress, signal, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { signal }, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        if (redirectsLeft <= 0) {
          reject(new Error(`Too many redirects downloading ${url}`));
          return;
        }
        resolve(downloadToFile(new URL(response.headers.location, url).toString(), destPath, onProgress, signal, redirectsLeft - 1));
        return;
      }
      if (status !== 200) {
        response.resume();
        reject(new Error(`Unexpected status ${status} downloading ${url}`));
        return;
      }
      const total = Number(response.headers['content-length'] ?? 0);
      let received = 0;
      const partPath = `${destPath}.part`;
      const file = nodeFs.createWriteStream(partPath);
      response.on('data', (chunk) => {
        received += chunk.length;
        if (total > 0 && typeof onProgress === 'function') {
          onProgress(Math.min(1, received / total));
        }
      });
      response.pipe(file);
      file.on('finish', () => file.close((error) => {
        if (error) { reject(error); return; }
        try {
          nodeFs.renameSync(partPath, destPath);
          resolve();
        } catch (renameError) {
          reject(renameError);
        }
      }));
      file.on('error', reject);
      response.on('error', reject);
    });
    request.on('error', reject);
    request.setTimeout(300000, () => request.destroy(new Error(`Timed out downloading ${url}`)));
  });
}

/** Extracts a .zip or .tar.gz into destDir using the system `tar` (bsdtar on
 * Windows 10+ handles .zip too), falling back to PowerShell for .zip. */
function extractArchive(archivePath, destDir, platform) {
  const tar = spawnSync('tar', ['-xf', archivePath, '-C', destDir], { stdio: 'ignore' });
  if (!tar.error && tar.status === 0) return;
  if (platform === 'win32') {
    const ps = spawnSync('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${destDir}' -Force`,
    ], { stdio: 'ignore' });
    if (!ps.error && ps.status === 0) return;
  }
  throw new Error(`Failed to extract ${nodePath.basename(archivePath)}`);
}

/** sha256 hex of a file. */
function sha256File(filePath, fsImpl = nodeFs) {
  const hash = crypto.createHash('sha256');
  hash.update(fsImpl.readFileSync(filePath));
  return hash.digest('hex');
}

/** Finds the expected sha256 for `name` in a SHASUMS/checksums.txt body, or null. */
function checksumFor(shasums, name) {
  for (const line of String(shasums).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length >= 2 && parts[parts.length - 1].replace(/^[*]/, '') === name) {
      return parts[0].toLowerCase();
    }
  }
  return null;
}

module.exports = {
  httpGetText,
  downloadToFile,
  extractArchive,
  sha256File,
  checksumFor,
};
