// Compact formatting of the token counters (chat selector, project header): the raw numbers
// (often six digits once the cache kicks in) would be unreadable on a narrow sidebar row.
import type { ChatTokens } from "../types";

export function totalTokens(t: ChatTokens | undefined): number {
  if (!t) return 0;
  return t.input + t.output + t.cache_read + t.cache_write;
}

// 999 -> "999", 1000 -> "1k", 128456 -> "128.5k", 1500000 -> "1.5M".
// One decimal at most, dropped when it is a pointless zero (128000 -> "128k", not "128.0k").
export function formatTokens(n: number): string {
  const v = n || 0;
  if (v < 1000) return String(Math.round(v));
  if (v < 1_000_000) return `${trimTrailingZero(v / 1000)}k`;
  return `${trimTrailingZero(v / 1_000_000)}M`;
}

function trimTrailingZero(v: number): string {
  const rounded = Math.round(v * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}
