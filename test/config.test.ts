import { describe, expect, it } from "vitest";
import { parseWarmPool } from "../src/config.js";

describe("parseWarmPool", () => {
  it("returns an empty pool for an empty string", () => {
    expect(parseWarmPool("")).toEqual({});
  });

  it("parses a single entry", () => {
    expect(parseWarmPool("minecraft=2")).toEqual({ minecraft: 2 });
  });

  it("parses multiple entries and tolerates whitespace", () => {
    expect(parseWarmPool(" minecraft=1 , valheim=0 ")).toEqual({
      minecraft: 1,
      valheim: 0,
    });
  });

  it("rejects unknown games", () => {
    expect(() => parseWarmPool("halo=1")).toThrow(/Invalid WARM_POOL entry/);
  });

  it("rejects entries without a count", () => {
    expect(() => parseWarmPool("minecraft")).toThrow(/Invalid WARM_POOL entry/);
  });

  it("rejects non-numeric counts", () => {
    expect(() => parseWarmPool("minecraft=lots")).toThrow(
      /Invalid WARM_POOL entry/,
    );
  });

  it("rejects negative counts", () => {
    expect(() => parseWarmPool("minecraft=-1")).toThrow(
      /Invalid WARM_POOL entry/,
    );
  });

  it("rejects fractional counts", () => {
    expect(() => parseWarmPool("minecraft=1.5")).toThrow(
      /Invalid WARM_POOL entry/,
    );
  });
});
