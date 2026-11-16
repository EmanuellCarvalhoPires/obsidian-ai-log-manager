// Schemaless reader of the protobuf wire format. The Antigravity conversation database keeps its steps as
// protobuf blobs without a published schema, so the parser reads fields by number. It never throws: a blob
// that does not decode gives an empty list (or stops at the last field that did).

export interface PbField {
  field: number;
  wire: number;
  /** Varint (as a number; exact up to 2^53) for wire type 0, raw bytes for the others. */
  value: number | Uint8Array;
}

const decoder = new TextDecoder("utf-8");

function readVarint(buf: Uint8Array, start: number): { value: number; next: number } | undefined {
  let result = 0;
  let scale = 1;
  let i = start;
  while (i < buf.length) {
    const byte = buf[i++] ?? 0;
    result += (byte & 0x7f) * scale;
    if ((byte & 0x80) === 0) return { value: result, next: i };
    scale *= 128;
    if (scale > 2 ** 70) return undefined;
  }
  return undefined;
}

/** Fields of the first level of a message, in order. Empty when the bytes are not a valid message. */
export function pbFields(buf: Uint8Array): PbField[] {
  const out: PbField[] = [];
  let i = 0;
  while (i < buf.length) {
    const key = readVarint(buf, i);
    if (!key) return [];
    i = key.next;
    const field = Math.floor(key.value / 8);
    const wire = key.value % 8;
    if (field === 0) return [];
    if (wire === 0) {
      const v = readVarint(buf, i);
      if (!v) return [];
      out.push({ field, wire, value: v.value });
      i = v.next;
    } else if (wire === 1 || wire === 5) {
      const size = wire === 1 ? 8 : 4;
      if (i + size > buf.length) return [];
      out.push({ field, wire, value: buf.subarray(i, i + size) });
      i += size;
    } else if (wire === 2) {
      const len = readVarint(buf, i);
      if (!len || len.next + len.value > buf.length) return [];
      out.push({ field, wire, value: buf.subarray(len.next, len.next + len.value) });
      i = len.next + len.value;
    } else {
      return [];
    }
  }
  return out;
}

/** First value found following the path of field numbers (e.g. `pbGet(payload, 20, 1)`). */
export function pbGet(buf: Uint8Array | undefined, ...path: number[]): Uint8Array | number | undefined {
  let current: Uint8Array | number | undefined = buf;
  for (const field of path) {
    if (!(current instanceof Uint8Array)) return undefined;
    current = pbFields(current).find((f) => f.field === field)?.value;
    if (current === undefined) return undefined;
  }
  return current;
}

/** Every value of a repeated field of the first level. */
export function pbAll(buf: Uint8Array | number | undefined, field: number): Array<Uint8Array | number> {
  if (!(buf instanceof Uint8Array)) return [];
  return pbFields(buf)
    .filter((f) => f.field === field)
    .map((f) => f.value);
}

export function pbString(value: Uint8Array | number | undefined): string {
  return value instanceof Uint8Array ? decoder.decode(value) : "";
}

/** Seconds of a protobuf Timestamp message ({1: seconds, 2: nanos}), or undefined. */
export function pbSeconds(value: Uint8Array | number | undefined): number | undefined {
  const seconds = value instanceof Uint8Array ? pbGet(value, 1) : undefined;
  return typeof seconds === "number" ? seconds : undefined;
}
