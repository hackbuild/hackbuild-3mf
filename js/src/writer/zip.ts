// The zip container. Equal entries and epoch give equal bytes on every host
// (D-052): one mtime from SOURCE_DATE_EPOCH, no directory entries, names
// in sorted byte order, DEFLATE at level 6 for every entry.

import JSZip from "jszip";
import { utf8Bytes } from "../contracts.js";
import { clampEpoch } from "./fmt.js";
import type { Members } from "./hash.js";

/** zlib deflate level for every entry (D-052). */
export const DEFLATE_LEVEL = 6;

/** Entry names in sorted byte order; for ASCII names UTF-16 order is byte order. */
export function sortedNames(entries: Members): string[] {
  return Object.keys(entries).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * A name with each lone surrogate replaced by U+FFFD. JSZip encodes names
 * through node Buffer (U+FFFD) or its own encoder (three bytes per
 * surrogate) by runtime; a well-formed name encodes one way on both and
 * matches utf8Bytes, which artifactHash reads.
 */
export const wellFormedName = (name: string): string =>
  name.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "\ufffd");

export async function zipEntries(entries: Members, sourceDateEpoch: number): Promise<Uint8Array> {
  const zip = new JSZip();
  // JSZip writes DOS times from the UTC fields of this date, so the bytes
  // do not move with the host time zone.
  const date = new Date(clampEpoch(sourceDateEpoch) * 1000);
  const seen = new Set<string>();
  for (const name of sortedNames(entries)) {
    const member = wellFormedName(name);
    if (seen.has(member)) throw new RangeError(`zip member ${JSON.stringify(member)} repeats once lone surrogates are replaced`);
    seen.add(member);
    const v = entries[name]!;
    // Text goes in as spec utf8Bytes so the bytes do not depend on the
    // runtime encoder JSZip picks for strings.
    zip.file(member, typeof v === "string" ? utf8Bytes(v) : v, { date, createFolders: false, compression: "DEFLATE", compressionOptions: { level: DEFLATE_LEVEL } });
  }
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: DEFLATE_LEVEL }, platform: "UNIX" });
}
