// The zip reader every 3MF and STL zip passes through (D-166, ARCHITECTURE.md
// section 11.1). A package from outside the opened workspace is untrusted:
// before any kernel sees its bytes the reader refuses an entry name with a
// `..` segment, a leading `/` or `\` or a drive letter, more than 4096
// entries, and a total inflated size over 256 MiB. The entry count is taken
// by walking the central directory before JSZip parses it, so a small zip of
// millions of records is refused before an object is built for each, and the
// count the end record claims is never trusted. The size is counted
// while inflating, so the read stops at the cap; the sizes the zip headers
// declare are never trusted. A refusal is E_SCHEMA naming the rule and the
// limit. Any other zip or inflate failure is E_SCHEMA with rule zip, so a
// hostile file never escapes as an uncaught throw (TESTING.md 4.2.1).

import JSZip from "jszip";
import type { ThrownCommandError } from "../contracts.js";
import { exportError } from "../writer/template.js";

/** D-166 plan budgets (inferred); raising one takes a new decision entry. */
export const READER_LIMITS = {
  /** Entries in one zip, directories included. */
  entries: 4096,
  /** Total inflated bytes across every entry of one zip. */
  inflatedBytes: 256 * 2 ** 20,
} as const;

export type ReaderRule = "entries" | "entry-name" | "inflated-size" | "zip";

/** A `..` segment, a leading `/` or `\`, or a drive letter, with either separator. */
const BAD_NAME = /(^|[/\\])\.\.([/\\]|$)|^[/\\]|^[A-Za-z]:/;

/** True when a zip entry name breaks the D-166 name rule. */
export function unsafeEntryName(name: string): boolean {
  return BAD_NAME.test(name);
}

function refuse(rule: ReaderRule, got: unknown, expected: string, hint: string): ThrownCommandError {
  return exportError({ code: "E_SCHEMA", path: `/zip/${rule}`, got, expected, hint, record: `3mf-reader/${rule}` });
}

/** Text entries the validator parses; the rest stay bytes. */
const TEXT_ENTRY = /\.(model|rels|config|json|xml)$/;

interface StreamHelper {
  on(event: "data", cb: (chunk: Uint8Array) => void): StreamHelper;
  on(event: "end", cb: () => void): StreamHelper;
  on(event: "error", cb: (e: Error) => void): StreamHelper;
  resume(): StreamHelper;
  pause(): StreamHelper;
}

const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_ZIP64_END = 0x06064b50;
/** The end record is 22 bytes and its comment at most 65535, so it starts in the last 65557 bytes. */
const END_SEARCH = 22 + 0xffff;

function notZip(why: string): ThrownCommandError {
  return refuse("zip", why, "a readable zip", "the file is not a readable zip; export it again");
}

/**
 * Count central directory records by walking them from the offset the end
 * record (or the Zip64 end record) names, the way JSZip will, stopping as
 * soon as the count passes READER_LIMITS.entries. Only bytes are read; no
 * object is built per record. The entry counts the end records claim are
 * ignored, since JSZip parses every record whatever they say.
 */
function preflightCentral(bytes: Uint8Array): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const len = bytes.length;
  const sigAt = (at: number, sig: number): boolean => at >= 0 && at + 4 <= len && view.getUint32(at, true) === sig;
  let eocd = -1;
  for (let at = len - 22; at >= Math.max(0, len - END_SEARCH); at--) {
    if (sigAt(at, SIG_END)) { eocd = at; break; }
  }
  if (eocd < 0) throw notZip("no end of central directory record in the last 65557 bytes");
  let cdSize = view.getUint32(eocd + 12, true);
  let cdOffset = view.getUint32(eocd + 16, true);
  let endOfCentral = eocd;
  const zip64 = view.getUint16(eocd + 4, true) === 0xffff || view.getUint16(eocd + 6, true) === 0xffff
    || view.getUint16(eocd + 8, true) === 0xffff || view.getUint16(eocd + 10, true) === 0xffff
    || cdSize === 0xffffffff || cdOffset === 0xffffffff;
  if (zip64) {
    const loc = eocd - 20;
    if (!sigAt(loc, SIG_ZIP64_LOCATOR)) throw notZip("no Zip64 end of central directory locator");
    const named = view.getBigUint64(loc + 8, true);
    let rec = named <= BigInt(len) ? Number(named) : -1;
    if (!sigAt(rec, SIG_ZIP64_END) || rec + 56 > len) {
      // JSZip searches back for the record when the locator's offset misses it (bytes prepended to the zip).
      rec = -1;
      for (let at = loc - 56; at >= 0; at--) if (sigAt(at, SIG_ZIP64_END)) { rec = at; break; }
      if (rec < 0) throw notZip("no Zip64 end of central directory record");
    }
    const size = view.getBigUint64(rec + 40, true);
    const offset = view.getBigUint64(rec + 48, true);
    if (size > BigInt(len) || offset > BigInt(len)) throw notZip("the Zip64 end record names a central directory past the end of the file");
    cdSize = Number(size);
    cdOffset = Number(offset);
    endOfCentral = rec;
  }
  const extra = endOfCentral - (cdOffset + cdSize);
  if (extra < 0) throw notZip("the central directory runs past its end record");
  // Bytes prepended to the zip shift every offset by `extra`, as JSZip reads it.
  let at = extra > 0 && !sigAt(cdOffset, SIG_CENTRAL) ? cdOffset + extra : cdOffset;
  let count = 0;
  while (sigAt(at, SIG_CENTRAL)) {
    if (at + 46 > len) throw notZip(`central record ${count} runs past the end of the file`);
    const next = at + 46 + view.getUint16(at + 28, true) + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
    if (next > len) throw notZip(`central record ${count} runs past the end of the file`);
    count++;
    if (count > READER_LIMITS.entries) {
      throw refuse("entries", `more than ${READER_LIMITS.entries}`, `at most ${READER_LIMITS.entries} entries`, "the zip holds too many entries to be a 3MF package; refuse it");
    }
    at = next;
  }
}

/** Parse the central directory and apply the entry count and name rules; nothing is inflated yet. */
async function openZip(bytes: Uint8Array): Promise<JSZip> {
  preflightCentral(bytes);
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch (e) {
    throw refuse("zip", String(e instanceof Error ? e.message : e), "a readable zip", "the file is not a readable zip; export it again");
  }
  const files = Object.values(zip.files);
  // The walk above already bounds the count; this guards any record JSZip reads that the walk did not.
  if (files.length > READER_LIMITS.entries) {
    throw refuse("entries", files.length, `at most ${READER_LIMITS.entries} entries`, "the zip holds too many entries to be a 3MF package; refuse it");
  }
  for (const f of files) {
    // JSZip resolves `..` away in f.name; the name as stored is kept in unsafeOriginalName.
    for (const name of [f.name, f.unsafeOriginalName]) {
      if (name !== undefined && unsafeEntryName(name)) {
        throw refuse("entry-name", name, "a relative entry name with no .. segment, leading separator or drive letter",
          `the zip names an entry outside its root (${name}); refuse it`);
      }
    }
  }
  return zip;
}

/** One budget shared by every entry of a zip. */
interface Budget { used: number }

function inflate(file: JSZip.JSZipObject, budget: Budget): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let n = 0;
    let done = false;
    const stop = (err: ThrownCommandError, h: StreamHelper): void => {
      done = true;
      h.pause();
      reject(err);
    };
    let h: StreamHelper;
    try {
      h = (file as unknown as { internalStream(type: "uint8array"): StreamHelper }).internalStream("uint8array");
    } catch (e) {
      reject(refuse("zip", String(e instanceof Error ? e.message : e), "a readable entry", `entry ${file.name} cannot be read`));
      return;
    }
    h.on("data", (chunk) => {
      if (done) return;
      n += chunk.length;
      if (budget.used + n > READER_LIMITS.inflatedBytes) {
        stop(refuse("inflated-size", `over ${budget.used + n} bytes at ${file.name}`, `at most ${READER_LIMITS.inflatedBytes} bytes inflated in total`,
          "the zip inflates past the reader cap; refuse it"), h);
        return;
      }
      chunks.push(chunk);
    });
    h.on("error", (e) => {
      if (done) return;
      stop(refuse("zip", String(e.message), "a readable entry", `entry ${file.name} does not inflate; export it again`), h);
    });
    h.on("end", () => {
      if (done) return;
      done = true;
      budget.used += n;
      const out = new Uint8Array(n);
      let at = 0;
      for (const c of chunks) {
        out.set(c, at);
        at += c.length;
      }
      resolve(out);
    });
    h.resume();
  });
}

// JSZip's string output keeps a byte order mark; so does this decoder.
const UTF8 = new TextDecoder("utf-8", { ignoreBOM: true });

/** Unzip a package into an entry map under the D-166 rules: model, config and JSON entries as text, the rest as bytes. */
export async function readEntries(bytes: Uint8Array): Promise<Record<string, string | Uint8Array>> {
  const zip = await openZip(bytes);
  const budget: Budget = { used: 0 };
  // No prototype, so an entry named __proto__ is an own key like any other, never a silent prototype change.
  const out: Record<string, string | Uint8Array> = Object.create(null) as Record<string, string | Uint8Array>;
  for (const [name, file] of Object.entries(zip.files)) {
    if (file.dir) continue;
    const data = await inflate(file, budget);
    out[name] = TEXT_ENTRY.test(name) ? UTF8.decode(data) : data;
  }
  return out;
}

/** Member names of an STL zip, directories dropped, under the D-166 count and name rules. Nothing is inflated. */
export async function zipMemberNames(bytes: Uint8Array): Promise<string[]> {
  const zip = await openZip(bytes);
  return Object.values(zip.files).filter((f) => !f.dir).map((f) => f.name);
}
