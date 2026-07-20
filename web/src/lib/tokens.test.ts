import { describe, expect, it } from "vitest";
import { formatTokens, totalTokens } from "./tokens";

describe("formatTokens", () => {
  it("leaves small numbers untouched", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
  });

  it("switches to k from 1000 up, without pointless decimals", () => {
    expect(formatTokens(1000)).toBe("1k");
    expect(formatTokens(128000)).toBe("128k");
  });

  it("shows one decimal when it matters", () => {
    expect(formatTokens(128456)).toBe("128.5k");
  });

  it("switches to M from 1_000_000 up", () => {
    expect(formatTokens(1_500_000)).toBe("1.5M");
    expect(formatTokens(2_000_000)).toBe("2M");
  });
});

describe("totalTokens", () => {
  it("sums the 4 counters", () => {
    expect(totalTokens({ input: 100, output: 50, cache_read: 10, cache_write: 5 })).toBe(165);
  });

  it("returns 0 when the tokens are missing (a chat never used)", () => {
    expect(totalTokens(undefined)).toBe(0);
  });
});
