import { describe, expect, it } from "vitest";
import { dateFromLastEntry, toRecord } from "../../src/core/log-index";

describe("log date", () => {
  it("uses the time of the last request, not the file name stamp", () => {
    const headings = ["Sumário", "21/10/2026 - 17:11 - Primeiro", "21/10/2026 - 18:26 - Último"];
    expect(dateFromLastEntry(headings)).toBe(new Date(2026, 9, 21, 18, 26).getTime());
    const r = toRecord({
      path: "Knowledge/Logs/21-10-2026 - 17h11 - X.md",
      basename: "21-10-2026 - 17h11 - X",
      tags: ["log", "claude"],
      frontmatter: {},
      headings,
      ctime: 0,
      mtime: 0,
    });
    expect(r?.date).toBe(new Date(2026, 9, 21, 18, 26).getTime());
  });

  it("falls back to the file name when there is no entry", () => {
    expect(dateFromLastEntry(["Sumário"])).toBeUndefined();
  });
});
