import { describe, expect, it } from "vitest";
import { parseTranscript } from "../../src/core/transcript";

const line = (o: Record<string, unknown>) => JSON.stringify(o) + "\n";
const user = (text: string, extra: Record<string, unknown> = {}) =>
  line({ type: "user", timestamp: "2026-10-21T15:00:00.000Z", sessionId: "s1", message: { content: [{ type: "text", text }] }, ...extra });
const assistant = (text: string) =>
  line({ type: "assistant", timestamp: "2026-10-21T15:00:30.000Z", message: { stop_reason: "end_turn", content: [{ type: "text", text }] } });

describe("parseTranscript", () => {
  it("ignores the text the app injects when a skill loads", () => {
    const text =
      user("Quero um log") +
      assistant("ok") +
      user("Base directory for this skill: C:/x\n\n# Skill", { isMeta: true }) +
      assistant("seguindo a skill") +
      user("Base directory for this skill: C:/y", {}) +
      assistant("outra");
    const parsed = parseTranscript(text, -180);
    expect(parsed.turns.map((t) => t.userText)).toEqual(["Quero um log"]);
  });
});
