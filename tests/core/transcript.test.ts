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

  it("ignores the summary the app writes when a conversation is compacted", () => {
    const text =
      user("Quero um log") +
      assistant("ok") +
      user("This session is being continued from a previous conversation... resumo longo", { isCompactSummary: true, isVisibleInTranscriptOnly: true }) +
      assistant("seguindo") +
      user("Outro pedido");
    const parsed = parseTranscript(text, -180);
    expect(parsed.turns.map((t) => t.userText)).toEqual(["Quero um log", "Outro pedido"]);
  });

  it("ignores every variation of the interruption marker", () => {
    const text =
      user("Quero um log") +
      assistant("ok") +
      user("[Request interrupted by user for tool use]") +
      user("[Request interrupted by user]") +
      user("Segue") +
      assistant("ok2");
    expect(parseTranscript(text, -180).turns.map((t) => t.userText)).toEqual(["Quero um log", "Segue"]);
  });

  it("turns the slash command XML into /name and its arguments", () => {
    const withArgs = "<command-message>plano</command-message>\n<command-name>/plano</command-name>\n<command-args>gera isso</command-args>";
    const noArgs = "<command-message>clear</command-message>\n<command-name>clear</command-name>\n<command-args></command-args>";
    const text = user(withArgs) + assistant("ok") + user(noArgs) + assistant("ok2");
    expect(parseTranscript(text, -180).turns.map((t) => t.userText)).toEqual(["/plano gera isso", "/clear"]);
  });

  it("still ignores the output of local commands", () => {
    const text = user("<local-command-stdout>feito</local-command-stdout>") + user("Pedido real") + assistant("ok");
    expect(parseTranscript(text, -180).turns.map((t) => t.userText)).toEqual(["Pedido real"]);
  });

  it("gives the same turns when the file is full of lines that are not messages", () => {
    const base = user("Quero um log") + assistant("ok") + user("Outro pedido") + assistant("feito");
    const noise =
      line({ type: "progress", timestamp: "2026-10-21T15:00:10.000Z", data: { big: "x".repeat(500) } }) +
      line({ type: "attachment", timestamp: "2026-10-21T15:00:11.000Z", attachment: { type: "hook" } }) +
      line({ type: "file-history-snapshot", snapshot: { files: ["a", "b"] } });
    expect(parseTranscript(noise + base + noise, -180)).toEqual(parseTranscript(base, -180));
  });

  it("takes cwd and sessionId from the message lines", () => {
    const text =
      line({ type: "attachment", cwd: "C:/Outro", sessionId: "outro" }) + user("Oi", { cwd: "C:/Dev/app" }) + assistant("ok");
    const parsed = parseTranscript(text, -180);
    expect(parsed.cwd).toBe("C:/Dev/app");
    expect(parsed.sessionId).toBe("s1");
  });

  it("still parses a tool result that mentions a message type in its text", () => {
    const toolResult = line({
      type: "user",
      timestamp: "2026-10-21T15:00:05.000Z",
      message: { content: [{ type: "tool_result", content: '{"type":"user"}' }] },
    });
    const text = user("Pedido") + toolResult + assistant("ok");
    expect(parseTranscript(text, -180).turns.map((t) => t.userText)).toEqual(["Pedido"]);
  });

  it("accepts JSON written with spaces after the colons", () => {
    const spaced = '{"type": "user", "timestamp": "2026-10-21T15:00:00.000Z", "message": {"content": "Com espaços"}}\n';
    expect(parseTranscript(spaced + assistant("ok"), -180).turns.map((t) => t.userText)).toEqual(["Com espaços"]);
  });
});
