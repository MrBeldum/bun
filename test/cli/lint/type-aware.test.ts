// The rules that need types read the tree of the type checker, which TypeScript's parser makes. What oxlint prints about a file
// that oxc refuses does not depend on that tree: oxc's errors come first, in oxc's order, and tsgolint, which reads the file on
// its own, adds its reports. Under an .oxlintrc.json every expectation is what oxlint 1.88.0 prints with oxlint-tsgolint 7.0.2004.
import { afterAll, describe, expect, test } from "bun:test";
import { bunEnv, bunExe, isASAN, isDebug, normalizeBunSnapshot, tempDir } from "harness";
import { endChildren, spawn } from "../children";

afterAll(endChildren);

// Disable AI agent and CI detection regardless of the environment the tests run in.
const env = {
  ...bunEnv,
  AGENT: "0",
  CLAUDECODE: undefined,
  REPL_ID: undefined,
  GITHUB_ACTIONS: undefined,
  GITHUB_WORKSPACE: undefined,
  NO_COLOR: undefined,
  FORCE_COLOR: undefined,
};

// One thread lints the files one after the other. A debug build takes a second to start a thread for each core.
async function lint(files: Record<string, string>, args: string[]) {
  using dir = tempDir("bun-lint-type-aware", files);
  await using proc = spawn({
    cmd: [bunExe(), "lint", "--threads", "1", ...args],
    env,
    cwd: String(dir),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  return { stdout: normalizeBunSnapshot(stdout, String(dir)), stderr, exitCode };
}

/** What `-f unix` prints about each file, in its order. */
function reported(stdout: string) {
  const found: Record<string, string[]> = {};
  for (const line of stdout.split("\n")) {
    const [, name, said] = /(?:^|[\\/])([\w.]+):(\d+:\d+: .*\])$/.exec(line) ?? [];
    if (name) (found[name] ??= []).push(said);
  }
  return found;
}

// The smallest library that has `Promise.resolve`: a debug build takes long to read a larger one.
const compilerOptions = {
  strict: true,
  noEmit: true,
  lib: ["es2015"],
  types: [],
  allowJs: true,
  resolveJsonModule: true,
};
const tsconfig = JSON.stringify({
  compilerOptions: { ...compilerOptions, module: "esnext", moduleResolution: "bundler" },
});
// With no-unused-vars on, the names that are declared twice are found in the variables of the file.
const oxlintrc = (config: object = {}) =>
  JSON.stringify({
    plugins: ["typescript"],
    categories: { correctness: "off" },
    rules: { "no-unused-vars": "warn", "no-var": "error", "typescript/no-floating-promises": "error" },
    ...config,
  });
const floating = "Promises must be awaited, add void operator to ignore. [Error/typescript(no-floating-promises)]";
const redeclared = (name: string) => `Identifier \`${name}\` has already been declared [Error]`;
const redeclaredForChecker = "Cannot redeclare block-scoped variable 'a'. [Error/typescript(TS2451)]";

describe.concurrent("bun lint --type-aware, with a file that oxc refuses", () => {
  test("prints oxc's errors in oxc's order, and what the rules that need types report", async () => {
    const files = {
      "tsconfig.json": tsconfig,
      ".oxlintrc.json": oxlintrc(),
      "e.json": "{}\n",
      // Not in the order of the text.
      "a.ts": "let b = 1; let a = 1;\nlet a = 2; let b = 2;\nexport { a, b };\n",
      // TypeScript's parser has an error of its own for each of these two, which leaves its tree whole.
      "b.ts": "declare const p: Promise<number>;\nvar n = 010;\nlet a = 1; let a = 2;\np;\nexport { a, n };\n",
      "c.ts":
        'import a from "./e.json" assert { type: "json" };\ndeclare const p: Promise<number>;\n' +
        "function f(b: number, b: number) { return b; }\np;\nexport { a, f };\n",
      // oxlint says nothing about a file with `@flow` that oxc cannot parse.
      "d.js":
        "// @flow\nconst p = Promise.resolve(1);\np;\nfunction f(a: number) { return a; }\nvar z = f(1);\nString(z);\n",
    };
    const { stdout, exitCode } = await lint(files, ["--type-aware", "-f", "unix"]);
    expect(reported(stdout)).toEqual({
      "a.ts": [`1:16: ${redeclared("a")}`, `1:5: ${redeclared("b")}`],
      "b.ts": [
        "2:9: '0'-prefixed octal literals and octal escape sequences are deprecated [Error]",
        `3:5: ${redeclared("a")}`,
        `4:1: ${floating}`,
      ],
      "c.ts": [`3:12: ${redeclared("b")}`, `4:1: ${floating}`],
      "d.js": [`3:1: ${floating}`],
    });
    expect(exitCode).toBe(1);
  });

  test("--type-check adds what the type checker reports after oxc's errors", async () => {
    const code = 'export const n: number = "s";\nlet a = 1; let a = 2;\nexport { a };\n';
    const withoutValue = 'const x: number = "s";\nexport const y = ;\nexport { x };\n';
    const flags = ["--type-aware", "--type-check", "-f", "unix"];
    const [ofOxlint, ofNone] = await Promise.all([
      lint({ "tsconfig.json": tsconfig, ".oxlintrc.json": oxlintrc(), "a.ts": code }, flags),
      // ESLint's formats print a file's messages by their places.
      lint({ "tsconfig.json": tsconfig, "a.ts": withoutValue }, flags),
    ]);
    expect({ ofOxlint: reported(ofOxlint.stdout), ofNone: reported(ofNone.stdout) }).toEqual({
      ofOxlint: {
        "a.ts": [
          `2:5: ${redeclared("a")}`,
          "1:14: Type 'string' is not assignable to type 'number'. [Error/typescript(TS2322)]",
          `2:5: ${redeclaredForChecker}`,
          `2:16: ${redeclaredForChecker}`,
        ],
      },
      ofNone: {
        "a.ts": [
          "1:7: Type 'string' is not assignable to type 'number'. [Error/typescript/TS2322]",
          "2:17: Parsing error: Expression expected. [Error]",
          "2:18: Expression expected. [Error/typescript/TS1109]",
        ],
      },
    });
    expect({ ofOxlint: ofOxlint.exitCode, ofNone: ofNone.exitCode }).toEqual({ ofOxlint: 1, ofNone: 1 });
  });

  // TypeScript's parser has an error for `assert`, which oxc reads. The file that is linted first is the one that exports.
  test("the rules about imports know what a file exports that only TypeScript's parser has an error for", async () => {
    const rules = { "import/named": "error", "import/default": "error", "import/namespace": "error" };
    const files = {
      "tsconfig.json": tsconfig,
      ".oxlintrc.json": oxlintrc({
        plugins: ["import", "typescript"],
        rules: { ...rules, "typescript/no-floating-promises": "error" },
      }),
      "d.json": "{}\n",
      "a.js": 'import json from "./d.json" assert { type: "json" };\nexport const x = json;\n',
      "b.js":
        'import { missing } from "./a.js";\nimport def from "./a.js";\nimport * as ns from "./a.js";\n' +
        "export const y = [missing, def, ns.nope];\n",
    };
    const { stdout, exitCode } = await lint(files, ["--type-aware", "-f", "unix"]);
    expect(reported(stdout)).toEqual({
      "b.js": [
        '2:8: No default export found in imported module "./a.js" [Error/import(default)]',
        '1:10: named import "missing" not found [Error/import(named)]',
        '4:36: "nope" not found in imported namespace "./a.js". [Error/import(namespace)]',
      ],
    });
    expect(exitCode).toBe(1);
  });

  test("a file that oxc does not refuse is parsed once", async () => {
    const clean = "declare const p: Promise<number>;\nvoid p;\nexport {};\n";
    /** How many times the parser runs. */
    const parsed = async (files: Record<string, string>) => {
      const all = { "tsconfig.json": tsconfig, ".oxlintrc.json": oxlintrc(), ...files };
      const { stderr } = await lint(all, ["--type-aware", "--timing"]);
      return Number(/fast parser: (\d+) files/.exec(stderr)?.[1]);
    };
    const [one, two] = await Promise.all([parsed({ "a.ts": clean }), parsed({ "a.ts": clean, "b.ts": clean })]);
    expect(two - one).toBe(1);
  });

  // oxlint has no such warning. A debug build needs seconds to check a body that large.
  test.skipIf(isDebug || isASAN)("the warning about control flow analysis stays before oxc's errors", async () => {
    const files = {
      "tsconfig.json": tsconfig,
      ".oxlintrc.json": oxlintrc(),
      "a.ts":
        "declare const c: boolean, p: Promise<number>;\nlet x: number;\np;\n" +
        Buffer.alloc(1_100 * 18, "if (c) { x = 1; }\n").toString() +
        "let a = 1; let a = 2;\nexport { a, x };\n",
    };
    const [typed, checked] = await Promise.all([
      lint(files, ["--type-aware", "-f", "unix"]),
      lint(files, ["--type-aware", "--type-check", "-f", "unix"]),
    ]);
    const tooLarge =
      "1:1: This file is too large for control flow analysis. " +
      "Reports from rules that need type information may be wrong or incomplete. [Warning]";
    expect({ typed: reported(typed.stdout), checked: reported(checked.stdout) }).toEqual({
      typed: { "a.ts": [tooLarge, `1104:5: ${redeclared("a")}`, `3:1: ${floating}`] },
      checked: {
        "a.ts": [
          tooLarge,
          `1104:5: ${redeclared("a")}`,
          "1:1: The containing function or module body is too large for control flow analysis. [Error/typescript(TS2563)]",
          `3:1: ${floating}`,
          `1104:5: ${redeclaredForChecker}`,
          `1104:16: ${redeclaredForChecker}`,
        ],
      },
    });
    expect({ typed: typed.exitCode, checked: checked.exitCode }).toEqual({ typed: 1, checked: 1 });
  });
});
