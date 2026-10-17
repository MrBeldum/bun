import { parse } from "acorn";
import { expect, test } from "bun:test";

// JavaScriptCore's RegExp parser decides which `v` class sets are a SyntaxError. acorn implements the same grammar
// and early errors on its own, so it says what each set should be. Every set is tried alone and in a pattern of more
// than 64 characters, which JavaScriptCore only syntax-checks when it creates the RegExp.

const operands = ["a", "\\x61", "\\d", "\\q{ab}", "\\q{}", "\\q{a|b}", "\\p{Emoji_Keycap_Sequence}", "[\\q{ab}]"];
const thirdOperands = ["a", "\\d", "\\q{ab}", "\\q{}"];
const operators = ["", "&&", "--"];

function classSets() {
  const sets: string[] = [];
  for (const negation of ["", "^"]) {
    for (const first of operands) {
      sets.push(`[${negation}${first}]`);
      for (const operator of operators) {
        for (const second of operands) {
          sets.push(`[${negation}${first}${operator}${second}]`);
          if (!thirdOperands.includes(first) || !thirdOperands.includes(second)) continue;
          for (const third of thirdOperands) sets.push(`[${negation}${first}${operator}${second}${operator}${third}]`);
        }
      }
    }
  }
  return sets;
}

// Sets where JavaScriptCore still differs from the grammar. Both are in the enumeration below through this list only.
const knownGaps = [
  // Operands with no operator between them, then an operator: not in the grammar, read as a union on the left.
  "[^a\\q{ab}&&\\d]",
  // A nested class starts in the parser state of the operand before it.
  "[\\q{ab}[a&&b]]",
];

function acornAccepts(set: string) {
  try {
    parse(`/${set}/v`, { ecmaVersion: "latest" });
    return true;
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
    return false;
  }
}

function engineVerdict(source: string) {
  let regExp: RegExp;
  try {
    regExp = new RegExp(source, "v");
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
    return "refused";
  }
  try {
    regExp.test("a");
  } catch (e) {
    return `created, then ${(e as Error).name} at the first match`;
  }
  return "accepted";
}

test("v class sets are a SyntaxError when the grammar says so, at any pattern length", () => {
  const padding = "(?:" + Buffer.alloc(70, "z").toString() + ")?";
  const sets = [...classSets(), ...knownGaps];
  const different: string[] = [];
  for (const set of sets) {
    const expected = acornAccepts(set) ? "accepted" : "refused";
    for (const [form, source] of [
      ["alone", set],
      ["in a long pattern", set + padding],
    ]) {
      const verdict = engineVerdict(source);
      if (verdict !== expected) different.push(`${set} ${form}: ${verdict}, the grammar says ${expected}`);
    }
  }

  expect(sets.length).toBe(786);
  expect(different).toEqual([
    "[^a\\q{ab}&&\\d] alone: accepted, the grammar says refused",
    "[^a\\q{ab}&&\\d] in a long pattern: accepted, the grammar says refused",
    "[\\q{ab}[a&&b]] alone: refused, the grammar says accepted",
    "[\\q{ab}[a&&b]] in a long pattern: refused, the grammar says accepted",
  ]);
});
