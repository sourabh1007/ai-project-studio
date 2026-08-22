'use strict';

/**
 * Pure input-validation guards for the main-process IPC surface (Phase 1c).
 *
 * Every `ipcMain` handler already rejects messages that don't originate from our
 * own trusted frame (`isTrustedSender`). These guards are the second layer:
 * defence-in-depth validation of the *payload shape* so a compromised-but-
 * trusted renderer (e.g. via a supply-chain issue) still can't drive the main
 * process into unexpected OS calls. They are pure and dependency-free so they
 * stay trivially reviewable and testable in isolation.
 */

/**
 * Upper bound for any single string payload we accept over IPC. Real inputs
 * (theme names, URLs, file paths, clipboard text) are far smaller; this simply
 * caps pathological inputs so a giant string can't be forwarded to an OS API.
 */
const MAX_STRING_LENGTH = 32 * 1024;

/** True for a non-empty string within the accepted length bound. */
function isBoundedString(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_STRING_LENGTH
  );
}

/** Valid theme modes accepted by `theme:set`. */
function isThemeMode(value) {
  return value === 'light' || value === 'dark';
}

/**
 * True when `value` is a safe absolute path to reveal in the OS file explorer.
 * Requiring an absolute path (POSIX `/…` or Windows `C:\…` / UNC `\\…`) prevents
 * a relative or malformed string from resolving against an unexpected cwd.
 */
function isRevealablePath(value) {
  if (!isBoundedString(value)) {
    return false;
  }
  const isPosixAbsolute = value.startsWith('/');
  const isWindowsDrive = /^[A-Za-z]:[\\/]/.test(value);
  const isWindowsUnc = value.startsWith('\\\\');
  return isPosixAbsolute || isWindowsDrive || isWindowsUnc;
}

/** True when `value` is a URL safe to hand to `shell.openExternal`. */
function isExternalUrl(value) {
  if (!isBoundedString(value)) {
    return false;
  }
  try {
    const protocol = new URL(value).protocol;
    return (
      protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:'
    );
  } catch {
    return false;
  }
}

/** True when `value` is acceptable clipboard text. */
function isClipboardText(value) {
  return isBoundedString(value);
}

module.exports = {
  MAX_STRING_LENGTH,
  isBoundedString,
  isThemeMode,
  isRevealablePath,
  isExternalUrl,
  isClipboardText,
};
