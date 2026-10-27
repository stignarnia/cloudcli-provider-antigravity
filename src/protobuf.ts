/**
 * Schema-less protobuf reader for agy's conversation step blobs.
 *
 * agy stores each step of a conversation as a protobuf message without
 * publishing the schema. The fields this plugin needs sit at stable paths
 * (see history.ts), so a generic wire-format walk is enough: every
 * length-delimited field is recorded as a string (when it is valid UTF-8)
 * and, when it also parses as one, as a nested message.
 */

export type ProtoLeaf =
  | { path: string; kind: 'int'; value: bigint }
  | { path: string; kind: 'string'; value: string };

const MAX_DEPTH = 16;
const utf8 = new TextDecoder('utf-8', { fatal: true });

function readVarint(bytes: Uint8Array, start: number): [bigint, number] {
  let result = 0n;
  let shift = 0n;
  let index = start;
  for (;;) {
    if (index >= bytes.length || shift > 63n) {
      throw new RangeError('truncated varint');
    }
    const byte = bytes[index++];
    result |= BigInt(byte & 0x7f) << shift;
    shift += 7n;
    if (byte < 0x80) {
      return [result, index];
    }
  }
}

/** Parses `bytes` as one message; returns null when it is not a well-formed message. */
function walkMessage(bytes: Uint8Array, prefix: string, depth: number): ProtoLeaf[] | null {
  const leaves: ProtoLeaf[] = [];
  let index = 0;
  try {
    while (index < bytes.length) {
      const [key, afterKey] = readVarint(bytes, index);
      index = afterKey;
      const field = Number(key >> 3n);
      const wireType = Number(key & 7n);
      if (field === 0) {
        return null;
      }
      const path = prefix ? `${prefix}.${field}` : String(field);

      if (wireType === 0) {
        const [value, next] = readVarint(bytes, index);
        index = next;
        leaves.push({ path, kind: 'int', value });
      } else if (wireType === 1) {
        index += 8;
      } else if (wireType === 5) {
        index += 4;
      } else if (wireType === 2) {
        const [length, next] = readVarint(bytes, index);
        const end = next + Number(length);
        if (end > bytes.length) {
          return null;
        }
        const chunk = bytes.subarray(next, end);
        index = end;

        // Bytes can be valid as both text and a nested message ("hi" is
        // 0x68 0x69, which also reads as field 13 = 105), so both readings
        // are kept and each lookup asks for the one it expects.
        try {
          leaves.push({ path, kind: 'string', value: utf8.decode(chunk) });
        } catch {
          // Not text: only the nested reading below can apply.
        }
        const nested = depth < MAX_DEPTH && chunk.length > 1 ? walkMessage(chunk, path, depth + 1) : null;
        if (nested) {
          leaves.push(...nested);
        }
      } else {
        return null;
      }
    }
  } catch {
    return null;
  }

  return index === bytes.length ? leaves : null;
}

export function decodeProtoLeaves(bytes: Uint8Array): ProtoLeaf[] {
  return walkMessage(bytes, '', 0) ?? [];
}

/** Indexed view over a decoded message for path lookups. */
export class ProtoView {
  private readonly byPath = new Map<string, ProtoLeaf[]>();

  constructor(readonly leaves: ProtoLeaf[]) {
    for (const leaf of leaves) {
      const list = this.byPath.get(leaf.path);
      if (list) {
        list.push(leaf);
      } else {
        this.byPath.set(leaf.path, [leaf]);
      }
    }
  }

  static decode(bytes: Uint8Array | null | undefined): ProtoView {
    return new ProtoView(bytes ? decodeProtoLeaves(bytes) : []);
  }

  string(path: string): string | undefined {
    const leaf = this.byPath.get(path)?.find((entry) => entry.kind === 'string');
    return leaf?.kind === 'string' ? leaf.value : undefined;
  }

  strings(path: string): string[] {
    return (this.byPath.get(path) ?? [])
      .filter((entry): entry is Extract<ProtoLeaf, { kind: 'string' }> => entry.kind === 'string')
      .map((entry) => entry.value);
  }

  int(path: string): number | undefined {
    const leaf = this.byPath.get(path)?.find((entry) => entry.kind === 'int');
    return leaf?.kind === 'int' ? Number(leaf.value) : undefined;
  }

  /**
   * Repeated sub-messages at `path`, as one record of child paths per
   * occurrence. A new occurrence starts whenever a child field repeats.
   */
  groups(path: string, childFields: string[]): Array<Record<string, string>> {
    const groups: Array<Record<string, string>> = [];
    let current: Record<string, string> | null = null;
    for (const leaf of this.leaves) {
      if (leaf.kind !== 'string' || !leaf.path.startsWith(`${path}.`)) {
        continue;
      }
      const child = leaf.path.slice(path.length + 1);
      if (!childFields.includes(child)) {
        continue;
      }
      if (!current || child in current) {
        current = {};
        groups.push(current);
      }
      current[child] = leaf.value;
    }
    return groups;
  }
}
