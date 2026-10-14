// artifactHash (D-052, C-08). sha256Hex and utf8Bytes are spec/jcs.ts, the
// one sha256 and UTF-8 encoder of every tier (D-206); zip.ts writes text
// entries through the same encoder, so the hash is over the bytes the zip
// holds on every runtime.

import type { ArtifactHash } from "../contracts.js";
import { sha256Hex, utf8Bytes } from "../contracts.js";

/** Package entries by path. */
export type Entries = Readonly<Record<string, string>>;
/** Zip members by path: text or bytes (the STL fallback holds bytes). */
export type Members = Readonly<Record<string, string | Uint8Array>>;

const MODEL = "3D/3dmodel.model";

const bytesOf = (v: string | Uint8Array): Uint8Array => (typeof v === "string" ? utf8Bytes(v) : v);

/**
 * sha256 over, for each entry in sorted name order, the UTF-8 name, 0x00,
 * the hex sha256 of the uncompressed bytes and 0x0A, with the CreationDate
 * and ModificationDate values of the root model blanked so the hash holds
 * across epochs.
 */
export function artifactHash(entries: Members): ArtifactHash {
  const lines: string[] = [];
  for (const name of Object.keys(entries).sort()) {
    let v = entries[name]!;
    if (name === MODEL && typeof v === "string") {
      v = v.replace(/(<metadata name="(?:CreationDate|ModificationDate)">)[^<]*/g, "$1");
    }
    lines.push(`${name}\u0000${sha256Hex(bytesOf(v))}\n`);
  }
  return sha256Hex(utf8Bytes(lines.join(""))) as ArtifactHash;
}
