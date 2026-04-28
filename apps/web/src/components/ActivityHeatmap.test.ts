import { describe, expect, it } from "vitest";
import { buildDowHourHeatmap } from "./ActivityHeatmap";

describe("buildDowHourHeatmap", () => {
  it("keeps sparse active cells at low intensity instead of quantile max", () => {
    const { cells } = buildDowHourHeatmap([
      { dow: 1, hour: 9, totalTokens: 100, requestCount: 1 },
      { dow: 1, hour: 10, totalTokens: 500, requestCount: 1 },
      { dow: 2, hour: 9, totalTokens: 900, requestCount: 1 },
      { dow: 2, hour: 10, totalTokens: 1300, requestCount: 1 }
    ]);

    expect(Array.from(cells.values()).map((cell) => cell.level)).toEqual([1, 1, 1, 1]);
  });
});
