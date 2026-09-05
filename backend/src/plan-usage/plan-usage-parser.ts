import type { PlanUsage } from './plan-usage-contract.js';

/**
 * Strips ANSI/VT control sequences (colours, cursor moves, OSC titles) from
 * captured terminal output so the plain text can be pattern-matched. Pure.
 */
export function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '');
}

function toNumber(raw: string): number {
  return Number(raw.replace(/,/g, ''));
}

/**
 * Extracts the AI-credit budget from the Copilot CLI `/usage` panel text. The
 * panel renders a line such as:
 *
 *   `Plan  ■■■■  2% used • resets in 26 days   25,000 / 10,00,000 AIC`
 *
 * plus an optional `Session: N AIC used` figure. ANSI codes and digit grouping
 * (including Indian grouping like `10,00,000`) are tolerated. Returns `null`
 * when the essential used/total AIC pair is absent, so callers can distinguish
 * "no data" from a genuine zero. Pure and fully deterministic given `capturedAt`.
 */
export function parsePlanUsage(
  text: string,
  capturedAt: string,
): PlanUsage | null {
  const plain = stripAnsi(text);

  const pair = plain.match(/([\d,]+)\s*\/\s*([\d,]+)\s*AIC/i);
  if (!pair) {
    return null;
  }
  const usedAic = toNumber(pair[1]);
  const totalAic = toNumber(pair[2]);

  const percentMatch = plain.match(/(\d+(?:\.\d+)?)\s*%\s*used/i);
  const percentUsed =
    percentMatch !== null
      ? Number(percentMatch[1])
      : totalAic > 0
        ? Math.round((usedAic / totalAic) * 100)
        : 0;

  const resetMatch = plain.match(/resets?\s+in\s+(\d+)\s*days?/i);
  const resetInDays = resetMatch !== null ? Number(resetMatch[1]) : null;

  const sessionMatch = plain.match(/Session:\s*([\d,]+)\s*AIC\s*used/i);
  const sessionAic =
    sessionMatch !== null ? toNumber(sessionMatch[1]) : null;

  return {
    percentUsed,
    usedAic,
    totalAic,
    availableAic: Math.max(0, totalAic - usedAic),
    resetInDays,
    sessionAic,
    capturedAt,
  };
}
