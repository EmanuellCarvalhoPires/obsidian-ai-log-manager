// Turns the steps of an Antigravity (Gemini) conversation database into the same `Turn`s the Claude Code
// transcript gives. Pure: the SQLite access is the `ConversationDbPort` (src/adapters/node-sqlite.ts).
//
// Format (found by inspection, there is no public schema): `<id>.db` is a SQLite file whose table `steps` has one
// row per step with a protobuf `step_payload`. Field 1 is the step type; 5.1 is the timestamp. Type 14 is the
// message of the person (field 19: 2 = text, 3.1 = the same text in items, 9 = images). Type 15 is an answer of
// the model (field 20: 1 = visible text, 3 = thinking, 7 = tool calls with 2 = name and 3 = arguments as JSON).
// The other types (tool results and so on) are not needed for the log.
import type { ConversationDbStep } from "./ports";
import { pbAll, pbGet, pbSeconds, pbString } from "./protobuf";
import { baseName } from "./text-utils";
import { cleanUserText, formatTimestamp, stripSystemBlocks } from "./transcript";
import type { Turn } from "./transcript";

export const STEP_USER = 14;
export const STEP_MODEL = 15;
/** Step types the log needs; the rest is skipped when reading the database. */
export const LOG_STEP_TYPES = [STEP_USER, STEP_MODEL];

export interface AntigravityConversation {
  turns: Turn[];
  firstTimestamp: Date | undefined;
}

const FILE_TOOLS = ["write_to_file", "replace_file_content", "multi_replace_file_content", "edit_file", "write_file"];
const COMMAND_TOOLS = ["run_command"];

function userMessage(payload: Uint8Array): { text: string; images: number } | undefined {
  const message = pbGet(payload, 19);
  if (!(message instanceof Uint8Array)) return undefined;
  let text = pbString(pbGet(message, 2)).trim();
  if (!text) {
    text = pbAll(message, 3)
      .map((item) => pbString(pbGet(item instanceof Uint8Array ? item : undefined, 1)))
      .join("\n")
      .trim();
  }
  return { text, images: pbAll(message, 9).length };
}

function parseArgs(json: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(json || "{}");
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Groups the steps (user and model, in order) into turns: request x response. */
export function parseAntigravitySteps(steps: ConversationDbStep[], tzOffsetMinutes?: number): AntigravityConversation {
  const turns: Turn[] = [];
  let current: Turn | undefined;
  let firstTimestamp: Date | undefined;

  for (const step of steps) {
    if (step.stepType !== STEP_USER && step.stepType !== STEP_MODEL) continue;
    const seconds = pbSeconds(pbGet(step.payload, 5, 1));
    const date = seconds === undefined ? new Date() : new Date(seconds * 1000);

    if (step.stepType === STEP_USER) {
      const message = userMessage(step.payload);
      if (!message) continue;
      let raw = stripSystemBlocks(message.text);
      const cleaned = cleanUserText(raw);
      const images = message.images + (raw.match(/\[Image:.*?\]/g) ?? []).length;
      if (!cleaned && images === 0) continue;
      firstTimestamp ??= date;
      raw = raw.trim();

      if (current && current.assistantTexts.length === 0 && current.tools.length === 0) {
        // Messages in a row with no answer in between are the same request.
        if (cleaned) current.userText = current.userText ? `${current.userText}\n${cleaned}` : cleaned;
        if (raw) current.rawText = current.rawText ? `${current.rawText}\n${raw}` : raw;
        current.imagesCount += images;
      } else {
        current = {
          timestamp: formatTimestamp(date, tzOffsetMinutes),
          date,
          userText: cleaned,
          rawText: raw,
          imagesCount: images,
          tools: [],
          filesModified: [],
          commands: [],
          assistantTexts: [],
          complete: false,
        };
        turns.push(current);
      }
      continue;
    }

    // A step of the model.
    const response = pbGet(step.payload, 20);
    if (!current || !(response instanceof Uint8Array)) continue;
    const text = pbString(pbGet(response, 1)).trim();
    if (text) current.assistantTexts.push(text);
    const calls = pbAll(response, 7);
    // The answer is final when the model stops asking for tools.
    current.complete = calls.length === 0;
    for (const call of calls) {
      if (!(call instanceof Uint8Array)) continue;
      const name = pbString(pbGet(call, 2));
      if (!name) continue;
      current.tools.push(name);
      const args = parseArgs(pbString(pbGet(call, 3)));
      if (FILE_TOOLS.includes(name)) {
        const target = str(args.TargetFile) || str(args.Path) || str(args.file_path);
        if (target) {
          const fname = baseName(target);
          if (!current.filesModified.includes(fname)) current.filesModified.push(fname);
        }
      } else if (COMMAND_TOOLS.includes(name)) {
        const cmd = str(args.CommandLine).trim();
        if (cmd) {
          const short = (cmd.split("\n")[0] ?? "").slice(0, 80);
          if (!current.commands.includes(short)) current.commands.push(short);
        }
      }
    }
  }

  turns.forEach((turn, i) => {
    if (i < turns.length - 1) turn.complete = true;
  });
  return { turns: turns.filter((t) => t.userText || t.imagesCount > 0 || t.rawText), firstTimestamp };
}

/** "c:/Users/x/proj" from "file:///c%3A/Users/x/proj" (a POSIX path keeps its leading slash). */
export function workspaceFromUri(uri: string): string | undefined {
  if (!uri) return undefined;
  let path = uri;
  try {
    path = decodeURIComponent(uri);
  } catch {
    // Keep the raw text: it is only used to compare folders.
  }
  if (!path.startsWith("file://")) return path.replace(/\\/g, "/");
  path = path.slice("file://".length);
  return (/^\/[A-Za-z]:/.test(path) ? path.slice(1) : path).replace(/\\/g, "/");
}

/** Workspace folder stored in the metadata blob of a conversation database (field 7), when it has one. */
export function workspaceFromMetadata(blob: Uint8Array | undefined): string | undefined {
  return workspaceFromUri(pbString(pbGet(blob, 7)));
}
