// The RULES.md Language rules as code (D-004): the word lists, the banned
// character patterns and lintText. tools/lint-voice.mjs (the CLI and the
// git hooks) and CHK-LNT-01 and -02 both read this one file through
// @hackbuild/checks/voice. It is plain ESM with no imports and no build
// step, so the hooks run on a fresh checkout before tsc. Banned characters
// are built from code points, so this file passes its own dash, emoji and
// sparkle rules.

// RULES.md Language holds these lists; tools/test/lint-voice.test.mjs fails when they differ.
export const MARKETING = ["seamless", "powerful", "robust", "comprehensive", "beautiful", "blazing", "delightful", "elegant"];
export const FILLER = ["delve", "tapestry", "leverage", "utilize", "facilitate", "streamline", "empower", "unlock", "elevate", "crucial", "vital", "straightforward", "genuinely", "cutting-edge", "state-of-the-art"];
export const OPENERS = ["Let's", "Simply", "Just", "Note that", "In this section"];
export const BRAND_HEX = ["ff3366", "ff2d7b", "E91E8C", "f5f2eb"];
export const JSON_MESSAGE_KEYS = ["title", "what", "message", "help", "label", "hint", "description", "constraint"];

export const CHAR_RULES = ["dash", "emoji", "sparkle"];
export const WORD_RULES = ["marketing", "filler", "opener", "frame"];
export const ALLOWABLE_RULES = [...WORD_RULES, "brand-hex", "exclaim", "legacy-archive"];
/** Dashes beyond U+2012 to U+2015 and U+2212: two- and three-em dash, the small and fullwidth forms, the vertical forms. */
export const EXTRA_DASHES = [0x2e3a, 0x2e3b, 0xfe58, 0xfe63, 0xfe31, 0xfe32, 0xff0d];
/** Emoji presentation outside the dingbat block, the keycap, the joiner and the two double marks. */
export const EXTRA_EMOJI = [0x200d, 0x20e3, 0x203c, 0x2049, 0x231a, 0x231b, 0x23e9, 0x23ea, 0x23eb, 0x23ec, 0x23f0, 0x23f3, 0x25fd, 0x25fe, 0x2b1b, 0x2b1c, 0x2b50, 0x2b55];
export const KINDS = ["commit", "text", "dom"];

const cp = (n) => String.fromCodePoint(n);
const span = (a, b) => `${cp(a)}-${cp(b)}`;
const BS = "\\\\";
const hexOf = (n) => n.toString(16);

const hexAlt = (list) => list.map(hexOf).join("|");
const decAlt = (list) => list.map(String).join("|");

const RX = {
  // U+2012 to U+2015, U+2212 and EXTRA_DASHES, raw, JS escape, named and numeric entities
  dash: new RegExp(
    `[${span(0x2012, 0x2015)}${cp(0x2212)}${EXTRA_DASHES.map(cp).join("")}]` +
      `|${BS}u(?:201[2-5]|2212|${hexAlt(EXTRA_DASHES)})|${BS}u\\{(?:201[2-5]|2212|${hexAlt(EXTRA_DASHES)})\\}` +
      `|&(?:mdash|ndash|minus);` +
      `|&#(?:821[0-3]|8722|${decAlt(EXTRA_DASHES)});|&#x0*(?:201[2-5]|2212|${hexAlt(EXTRA_DASHES)});`,
    "giu",
  ),
  // U+2726 to U+2728
  sparkle: new RegExp(
    `[${span(0x2726, 0x2728)}]|${BS}u272[6-8]|${BS}u\\{272[6-8]\\}|&#(?:1001[4-6]);|&#x0*272[6-8];`,
    "giu",
  ),
  // U+2600 to U+27BF (sparkle has its own rule), U+1F000 to U+1FAFF, U+FE0F, EXTRA_EMOJI,
  // and any other character Unicode shows as emoji by default (Emoji_Presentation)
  emoji: new RegExp(
    `[${span(0x2600, 0x2725)}${span(0x2729, 0x27bf)}${span(0x1f000, 0x1faff)}${cp(0xfe0f)}${EXTRA_EMOJI.map(cp).join("")}]|\\p{Emoji_Presentation}` +
      `|${BS}u(?:2[67][0-9a-f]{2}|fe0f|${hexAlt(EXTRA_EMOJI)})|${BS}u\\{(?:2[67][0-9a-f]{2}|1f[0-9a][0-9a-f]{2}|fe0f|${hexAlt(EXTRA_EMOJI)})\\}` +
      `|${BS}ud83[cde]` +
      `|&#x0*(?:2[67][0-9a-f]{2}|1f[0-9a][0-9a-f]{2}|fe0f|${hexAlt(EXTRA_EMOJI)});` +
      `|&#(?:9[7-9][0-9]{2}|10[01][0-9]{2}|12[6-9][0-9]{3}|65039|${decAlt(EXTRA_EMOJI)});`,
    "giu",
  ),
  "brand-hex": new RegExp(`#(?:${BRAND_HEX.join("|")})(?![0-9a-f])`, "gi"),
  marketing: new RegExp(`\\b(?:${MARKETING.join("|")})\\b`, "gi"),
  filler: new RegExp(`(?<![\\w-])(?:${FILLER.join("|")})(?![\\w-])`, "gi"),
  opener: new RegExp(
    `(?:^[ \\t]*(?:[-*+>][ \\t]+|#{1,6}[ \\t]+|\\d+[.)][ \\t]+)?|[.?!:][ \\t]+)` +
      `(${OPENERS.map((w) => w.replace("'", "['" + cp(0x2019) + "]")).join("|")})\\b`,
    "gm",
  ),
  frame: /\bnot just\b|\bnot only\b|\bis not [^.]{1,60}[.;,] (?:it|this) is\b/gi,
  // any ! in prose but != and <!, and the ! that opens a Markdown image ![alt](src)
  exclaimProse: /(?<![!=<>])!+(?![=[])/gm,
  exclaimCode: /[a-z]!(?=["'`])/g,
  exclaimJson: new RegExp(`"(?:${JSON_MESSAGE_KEYS.join("|")})"\\s*:\\s*"(?:[^"\\\\]|\\\\.)*!`, "g"),
};

// U+2713 and U+2717 pass in test files and test output only.
const CHECK_MARKS = new Set([cp(0x2713), cp(0x2717), `\\u${hexOf(0x2713)}`, `\\u${hexOf(0x2717)}`]);

// Blank out fenced code blocks and inline code spans, keeping every offset.
export function maskMarkdown(text) {
  let fence = null;
  return text
    .split("\n")
    .map((line) => {
      const m = line.match(/^ {0,3}(`{3,}|~{3,})/);
      if (fence) {
        if (m && m[1][0] === fence[0] && m[1].length >= fence.length && line.trim() === m[1]) fence = null;
        return " ".repeat(line.length);
      }
      if (m) {
        fence = m[1];
        return " ".repeat(line.length);
      }
      return line.replace(/(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, (s) => " ".repeat(s.length));
    })
    .join("\n");
}

function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

function position(starts, idx) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= idx) lo = mid;
    else hi = mid - 1;
  }
  return [lo + 1, idx - starts[lo] + 1];
}

// The extension and file name of a path, as node:path extname and basename give them, so this file imports nothing.
const baseName = (path) => path.slice(path.lastIndexOf("/") + 1);
function extOf(path) {
  const b = baseName(path);
  const dot = b.lastIndexOf(".");
  return dot <= 0 ? "" : b.slice(dot + 1).toLowerCase();
}

// kind is null for a file, or one of KINDS for stdin text.
export function lintText(path, text, kind = null) {
  const ext = extOf(path);
  const prose = kind !== null || ext === "md" || ext === "txt";
  const isTest = /\.test\./.test(baseName(path));
  const words = ext === "md" ? maskMarkdown(text) : text;
  const starts = lineStarts(text);
  const found = [];
  const add = (rule, src, re, severity = "block", keep = null) => {
    re.lastIndex = 0;
    for (const m of src.matchAll(re)) {
      if (keep && !keep(m)) continue;
      const offset = rule === "opener" ? m[0].length - m[1].length : 0;
      const [line, col] = position(starts, m.index + offset);
      const shown = (rule === "opener" ? m[1] : m[0]).replace(/\s+/g, " ").trim().slice(0, 48);
      found.push({ path, line, col, rule, severity, text: shown });
    }
  };
  add("dash", text, RX.dash);
  add("sparkle", text, RX.sparkle);
  add("emoji", text, RX.emoji, "block", (m) => !(isTest && CHECK_MARKS.has(m[0].toLowerCase())));
  add("brand-hex", text, RX["brand-hex"]);
  add("marketing", words, RX.marketing);
  add("filler", words, RX.filler);
  if (prose) {
    add("opener", words, RX.opener);
    add("frame", words, RX.frame, "warn");
    add("exclaim", words, RX.exclaimProse);
  } else if (ext === "json" || ext === "jsonl") {
    add("exclaim", text, RX.exclaimJson);
  } else {
    add("exclaim", text, RX.exclaimCode);
  }
  found.sort((a, b) => a.line - b.line || a.col - b.col);
  return found;
}
