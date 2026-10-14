// didYouMean for the writer's E_REF refusals: up to three ids by edit
// distance (spec/errors.ts). The package stands alone (D-027), so it keeps
// its own copy of the rule packages/profile refError applies. The Python
// writer (tools/py/orca3mf.py did_you_mean) ranks the same way, and
// tools/py/test/test_agreement.py holds the two lists equal.

/** Levenshtein distance: insert, delete and substitute each cost 1. */
export function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const sub = prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1);
      cur.push(Math.min(prev[j]! + 1, cur[j - 1]! + 1, sub));
    }
    prev = cur;
  }
  return prev[b.length]!;
}

/**
 * The three ids nearest to got, nearest first; equal distances keep table
 * order. got itself is left out. A got that is not a string ranks against "".
 */
export function didYouMean(got: unknown, ids: readonly string[]): string[] {
  const g = typeof got === "string" ? got : "";
  return ids
    .filter((id) => id !== g)
    .map((id, i) => ({ id, i, d: editDistance(id, g) }))
    .sort((x, y) => x.d - y.d || x.i - y.i)
    .slice(0, 3)
    .map((x) => x.id);
}
