// Builders of synthetic Antigravity steps (protobuf by hand) and an in-memory ConversationDbPort for tests.
// Nothing here comes from a real conversation.
import type { ConversationDbPort, ConversationDbStep, ConversationSummary } from "../../src/core/ports";

const enc = new TextEncoder();

export function varint(n: number): number[] {
  const out: number[] = [];
  let rest = n;
  while (rest >= 128) {
    out.push((rest % 128) | 0x80);
    rest = Math.floor(rest / 128);
  }
  out.push(rest);
  return out;
}

const tag = (field: number, wire: number): number[] => varint(field * 8 + wire);
const concat = (...parts: Uint8Array[]): Uint8Array => Uint8Array.from(parts.flatMap((p) => [...p]));

export const pbVarint = (field: number, n: number): Uint8Array => Uint8Array.from([...tag(field, 0), ...varint(n)]);
export const pbBytes = (field: number, bytes: Uint8Array): Uint8Array => Uint8Array.from([...tag(field, 2), ...varint(bytes.length), ...bytes]);
export const pbText = (field: number, text: string): Uint8Array => pbBytes(field, enc.encode(text));
export const pbMessage = (field: number, ...parts: Uint8Array[]): Uint8Array => pbBytes(field, concat(...parts));

/** Protobuf Timestamp {1: seconds, 2: nanos} in field 5.1 of a step. */
const stamp = (iso: string): Uint8Array => pbMessage(5, pbMessage(1, pbVarint(1, Math.floor(Date.parse(iso) / 1000)), pbVarint(2, 123)));

export function userStep(text: string, iso: string, images = 0): ConversationDbStep {
  const message = [pbText(2, text), pbMessage(3, pbText(1, text))];
  for (let i = 0; i < images; i++) message.push(pbMessage(9, pbText(1, "image.png")));
  return { stepType: 14, payload: concat(pbVarint(1, 14), pbVarint(4, 3), stamp(iso), pbMessage(19, ...message)) };
}

export interface FakeCall {
  name: string;
  args: Record<string, unknown>;
}

/** An answer of the model: visible text and/or tool calls (an answer with calls is not the final one). */
export function modelStep(text: string, iso: string, calls: FakeCall[] = []): ConversationDbStep {
  const parts: Uint8Array[] = [];
  if (text) parts.push(pbText(1, text), pbText(3, "thinking that must not be logged"));
  for (const call of calls) parts.push(pbMessage(7, pbText(1, "call-1"), pbText(2, call.name), pbText(3, JSON.stringify(call.args))));
  parts.push(pbVarint(12, 2));
  return { stepType: 15, payload: concat(pbVarint(1, 15), pbVarint(4, 3), stamp(iso), pbMessage(20, ...parts)) };
}

export interface FakeConversation {
  steps: ConversationDbStep[];
  /** Blob of trajectory_metadata_blob: field 7 holds the workspace URI. */
  workspaceUri?: string;
}

/** In-memory ConversationDbPort: databases and `conversation_summaries.db` files are registered by path. */
export class FakeConversationDb implements ConversationDbPort {
  conversations = new Map<string, FakeConversation>();
  summaries = new Map<string, ConversationSummary[]>();
  reads = 0;
  summaryReads = 0;

  async readSteps(dbPath: string, stepTypes: number[]): Promise<ConversationDbStep[]> {
    this.reads++;
    const c = this.conversations.get(dbPath);
    if (!c) throw new Error(`unable to open database file ${dbPath}`);
    return c.steps.filter((s) => stepTypes.includes(s.stepType));
  }

  async readMetadata(dbPath: string): Promise<Uint8Array | undefined> {
    const uri = this.conversations.get(dbPath)?.workspaceUri;
    return uri ? pbText(7, uri) : undefined;
  }

  async readSummaries(summariesPath: string): Promise<ConversationSummary[]> {
    this.summaryReads++;
    return this.summaries.get(summariesPath) ?? [];
  }
}
