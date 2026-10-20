import { escapeHTML } from "bun" with { type: "macro" };
import { describe, expect, test } from "bun:test";
import { bunEnv, bunExe, tempDir } from "harness";
import { existsSync } from "node:fs";
import path from "node:path";
import defaultMacro, {
  addStrings,
  addStringsUTF16,
  default as defaultMacroAlias,
  escape,
  identity,
  identity as identity1,
  identity as identity2,
  ireturnapromise,
  symbolKeys,
} from "./macro.ts" with { type: "macro" };

import * as macros from "./macro.ts" with { type: "macro" };

test("bun builtins can be used in macros", async () => {
  expect(escapeHTML("abc!")).toBe("abc!");
});

test("latin1 string", () => {
  expect(identity("©")).toBe("©");
});

test("ascii string", () => {
  expect(identity("abc")).toBe("abc");
});

test("type coercion", () => {
  expect(identity({ a: 1 })).toEqual({ a: 1 });
  expect(identity([1, 2, 3])).toEqual([1, 2, 3]);
  expect(identity(undefined)).toBe(undefined);
  expect(identity(null)).toBe(null);
  expect(identity(1.5)).toBe(1.5);
  expect(identity(1)).toBe(1);
  expect(identity(true)).toBe(true);
});

// A Symbol key has no source form. The inlined object keeps the string keys
// only, like JSON.stringify, instead of a string key named by the description.
test("object with Symbol keys", () => {
  const value = symbolKeys();
  expect(value).toEqual({ v: 2 });
  expect(Reflect.ownKeys(value)).toEqual(["v"]);
});

test("escaping", () => {
  expect(identity("\\")).toBe("\\");
  expect(identity("\f")).toBe("\f");
  expect(identity("\n")).toBe("\n");
  expect(identity("\r")).toBe("\r");
  expect(identity("\t")).toBe("\t");
  expect(identity("\v")).toBe("\v");
  expect(identity("\0")).toBe("\0");
  expect(identity("'")).toBe("'");
  expect(identity('"')).toBe('"');
  expect(identity("`")).toBe("`");
  // prettier-ignore
  expect(identity("\'")).toBe("\'");
  // prettier-ignore
  expect(identity('\"')).toBe('\"');
  // prettier-ignore
  expect(identity("\`")).toBe("\`");
  expect(identity("$")).toBe("$");
  expect(identity("\x00")).toBe("\x00");
  expect(identity("\x0B")).toBe("\x0B");
  expect(identity("\x0C")).toBe("\x0C");

  expect(identity("\\")).toBe("\\");

  expect(escape()).toBe("\\\f\n\r\t\v\0'\"`$\x00\x0B\x0C");

  expect(addStrings("abc")).toBe("abc\\\f\n\r\t\v\0'\"`$\x00\x0B\x0C©");
  expect(addStrings("\n")).toBe("\n\\\f\n\r\t\v\0'\"`$\x00\x0B\x0C©");
  expect(addStrings("\r")).toBe("\r\\\f\n\r\t\v\0'\"`$\x00\x0B\x0C©");
  expect(addStrings("\t")).toBe("\t\\\f\n\r\t\v\0'\"`$\x00\x0B\x0C©");
  expect(addStrings("©")).toBe("©\\\f\n\r\t\v\0'\"`$\x00\x0B\x0C©");
  expect(addStrings("\x00")).toBe("\x00\\\f\n\r\t\v\0'\"`$\x00\x0B\x0C©");
  expect(addStrings("\x0B")).toBe("\x0B\\\f\n\r\t\v\0'\"`$\x00\x0B\x0C©");
  expect(addStrings("\x0C")).toBe("\x0C\\\f\n\r\t\v\0'\"`$\x00\x0B\x0C©");
  expect(addStrings("\\")).toBe("\\\\\f\n\r\t\v\0'\"`$\x00\x0B\x0C©");
  expect(addStrings("\f")).toBe("\f\\\f\n\r\t\v\0'\"`$\x00\x0B\x0C©");
  expect(addStrings("\v")).toBe("\v\\\f\n\r\t\v\0'\"`$\x00\x0B\x0C©");
  expect(addStrings("\0")).toBe("\0\\\f\n\r\t\v\0'\"`$\x00\x0B\x0C©");
  expect(addStrings("'")).toBe("'\\\f\n\r\t\v\0'\"`$\x00\x0B\x0C©");
  expect(addStrings('"')).toBe('"\\\f\n\r\t\v\0\'"`$\x00\x0B\x0C©');
  expect(addStrings("`")).toBe("`\\\f\n\r\t\v\0'\"`$\x00\x0B\x0C©");
  expect(addStrings("😊")).toBe("😊\\\f\n\r\t\v\0'\"`$\x00\x0B\x0C©");

  expect(addStringsUTF16("abc")).toBe("abc\\\f\n\r\t\v\0'\"`$\x00\x0B\x0C😊");
  expect(addStringsUTF16("\n")).toBe("\n\\\f\n\r\t\v\0'\"`$\x00\x0B\x0C😊");
  expect(addStringsUTF16("\r")).toBe("\r\\\f\n\r\t\v\0'\"`$\x00\x0B\x0C😊");
  expect(addStringsUTF16("\t")).toBe("\t\\\f\n\r\t\v\0'\"`$\x00\x0B\x0C😊");
  expect(addStringsUTF16("©")).toBe("©\\\f\n\r\t\v\0'\"`$\x00\x0B\x0C😊");
  expect(addStringsUTF16("\x00")).toBe("\x00\\\f\n\r\t\v\0'\"`$\x00\x0B\x0C😊");
  expect(addStringsUTF16("\x0B")).toBe("\x0B\\\f\n\r\t\v\0'\"`$\x00\x0B\x0C😊");
  expect(addStringsUTF16("\x0C")).toBe("\x0C\\\f\n\r\t\v\0'\"`$\x00\x0B\x0C😊");
  expect(addStringsUTF16("\\")).toBe("\\\\\f\n\r\t\v\0'\"`$\x00\x0B\x0C😊");
  expect(addStringsUTF16("\f")).toBe("\f\\\f\n\r\t\v\0'\"`$\x00\x0B\x0C😊");
  expect(addStringsUTF16("\v")).toBe("\v\\\f\n\r\t\v\0'\"`$\x00\x0B\x0C😊");
  expect(addStringsUTF16("\0")).toBe("\0\\\f\n\r\t\v\0'\"`$\x00\x0B\x0C😊");
  expect(addStringsUTF16("'")).toBe("'\\\f\n\r\t\v\0'\"`$\x00\x0B\x0C😊");
  expect(addStringsUTF16('"')).toBe('"\\\f\n\r\t\v\0\'"`$\x00\x0B\x0C😊');
  expect(addStringsUTF16("`")).toBe("`\\\f\n\r\t\v\0'\"`$\x00\x0B\x0C😊");
  expect(addStringsUTF16("😊")).toBe("😊\\\f\n\r\t\v\0'\"`$\x00\x0B\x0C😊");
});

test("utf16 string", () => {
  expect(identity("😊 Smiling Face with Smiling Eyes Emoji")).toBe("😊 Smiling Face with Smiling Eyes Emoji");
});

test("import aliases", () => {
  expect(identity1({ a: 1 })).toEqual({ a: 1 });
  expect(identity1([1, 2, 3])).toEqual([1, 2, 3]);
  expect(identity2({ a: 1 })).toEqual({ a: 1 });
  expect(identity2([1, 2, 3])).toEqual([1, 2, 3]);
});

test("default import", () => {
  expect(defaultMacro()).toBe("defaultdefaultdefault");
  expect(defaultMacroAlias()).toBe("defaultdefaultdefault");
});

test("namespace import", () => {
  expect(macros.identity({ a: 1 })).toEqual({ a: 1 });
  expect(macros.identity([1, 2, 3])).toEqual([1, 2, 3]);
  expect(macros.escape()).toBe("\\\f\n\r\t\v\0'\"`$\x00\x0B\x0C");
});

// test("template string ascii", () => {
//   expect(identity(`A${""}`)).toBe("A");
// });

// test("template string latin1", () => {
//   expect(identity(`©${""}`)).toBe("©");
// });

test("ireturnapromise", async () => {
  expect(await ireturnapromise()).toEqual("aaa");
});

// This file used `assert` for its own imports until TypeScript 7 made that a syntax error (TS2880).
test("the `assert { type: 'macro' }` spelling works for every form of import", async () => {
  using dir = tempDir("macro-import-assertion", {
    "macro.ts": `export function identity(arg: any) {\n  return arg;\n}\nexport default function () {\n  return "default";\n}\n`,
    "index.ts": `
      import { escapeHTML } from "bun" assert { type: "macro" };
      import defaultMacro, { identity, identity as alias, default as defaultAlias } from "./macro.ts" assert { type: "macro" };
      import * as macros from "./macro.ts" assert { type: "macro" };
      console.log(JSON.stringify([escapeHTML("<a>"), defaultMacro(), identity(1), alias(2), defaultAlias(), macros.identity(3)]));
    `,
  });
  await using proc = Bun.spawn({
    cmd: [bunExe(), "build", "--no-bundle", "index.ts"],
    env: bunEnv,
    cwd: String(dir),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  // Every call is replaced by its result, so the macros ran at transpile time. Debug builds print
  // "[macro] call identity" to stdout first, so only the tail of stdout is matched.
  expect({ stdout: stdout.trim(), stderr, exitCode }).toMatchObject({
    stdout: expect.stringMatching(
      /console\.log\(JSON\.stringify\(\["&lt;a&gt;", "default", 1, 2, "default", 3\]\)\);$/,
    ),
    exitCode: 0,
  });
});

// A numeric key >= 100000 (JSC's MIN_SPARSE_ARRAY_INDEX) makes the property put inside
// JSC__JSValue__putToPropertyKey take a path that can throw, so the binding must check for
// an exception. BUN_JSC_validateExceptionChecks=1 aborts the child if the check is missing.
test("object argument with a sparse numeric key", async () => {
  using dir = tempDir("macro-sparse-key", {
    "take.ts": `export function take(o: any) {\n  return Object.keys(o).join(",");\n}\n`,
    "index.ts": `import { take } from "./take.ts" with { type: "macro" };\nconsole.log(take({ 200000: 1 }));\n`,
  });
  await using proc = Bun.spawn({
    cmd: [bunExe(), "run", "index.ts"],
    env: { ...bunEnv, BUN_JSC_validateExceptionChecks: "1" },
    cwd: String(dir),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  // One combined assertion so stderr (where JSC prints the exception check failure) shows up in
  // the diff if the child aborts. Debug builds print "[macro] call take" to stdout before the
  // script's own output, so only the tail of stdout is matched.
  expect({ stdout, stderr, exitCode, signalCode: proc.signalCode }).toMatchObject({
    stdout: expect.stringMatching(/200000\n$/),
    exitCode: 0,
    signalCode: null,
  });
});

test("object destructuring of a macro result keeps every bound property regardless of key order or repeated keys", async () => {
  using dir = tempDir("macro-destructure-object", {
    "m.ts": `export function m() {\n  return { a: 1, c: 2 };\n}\n`,
    "index.ts": [
      `import { m } from "./m.ts" with { type: "macro" };`,
      `const { c, a } = m();`,
      `const { a: x, a: y, c: z } = m();`,
      `console.log(JSON.stringify([c, a, x, y, z]));`,
      ``,
    ].join("\n"),
  });
  await using proc = Bun.spawn({
    cmd: [bunExe(), "run", "index.ts"],
    env: bunEnv,
    cwd: String(dir),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  expect({ lastLine: stdout.trim().split("\n").pop(), stderr }).toEqual({ lastLine: "[2,1,1,1,2]", stderr: "" });
  expect(exitCode).toBe(0);
});

// A Response or Blob returned from a macro is inlined by its content type: JSON is parsed into an object
// literal, text becomes a string, anything else becomes a base64 data URL. The type has to be classified
// with its parameters stripped: `Response.json()` and most servers send `application/json;charset=utf-8`.
test("a macro that returns a JSON or text Response or Blob is inlined by its content type", async () => {
  await using server = Bun.serve({ port: 0, fetch: () => Response.json({ from: "server" }) });
  using dir = tempDir("macro-response-content-type", {
    "m.ts": [
      `export function json() {`,
      `  return Response.json({ a: 1, b: [true, null, "x"] });`,
      `}`,
      `export function jsonHeader() {`,
      `  return new Response('{"b":2}', { headers: { "content-type": "application/json" } });`,
      `}`,
      `export function fetched() {`,
      `  return fetch(process.env.MACRO_TEST_URL!);`,
      `}`,
      `export function text() {`,
      `  return new Response("hello", { headers: { "content-type": "text/plain; charset=utf-8" } });`,
      `}`,
      `export function blobJson() {`,
      `  return new Blob(['{"c":3}'], { type: "application/json; charset=utf-8" });`,
      `}`,
      `export function binary() {`,
      `  return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "application/octet-stream" } });`,
      `}`,
    ].join("\n"),
    "index.ts": [
      `import { json, jsonHeader, fetched, text, blobJson, binary } from "./m.ts" with { type: "macro" };`,
      `console.log(JSON.stringify([json(), jsonHeader(), fetched(), text(), blobJson(), binary()]));`,
      ``,
    ].join("\n"),
  });
  await using proc = Bun.spawn({
    cmd: [bunExe(), "run", "index.ts"],
    env: { ...bunEnv, MACRO_TEST_URL: server.url.href },
    cwd: String(dir),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  // Debug builds print "[macro] call <name>" to stdout before the script's own output.
  expect({ lastLine: stdout.trim().split("\n").pop(), stderr }).toEqual({
    lastLine: JSON.stringify([
      { a: 1, b: [true, null, "x"] },
      { b: 2 },
      { from: "server" },
      "hello",
      { c: 3 },
      "data:application/octet-stream;base64,AQID",
    ]),
    stderr: "",
  });
  expect(exitCode).toBe(0);
});

// The classification follows the MIME essence, not the category table the runtime uses for blob types:
// any `+json` suffix or `/json` subtype is JSON, and the JavaScript and XML `application/*` types are text.
// The data URL keeps the raw content type, parameters included.
test("a Response or Blob returned from a macro is classified by its MIME essence", async () => {
  const json = '{"a":1}';
  const cases: [type: string, body: string, expected: unknown][] = [
    ["application/json", json, { a: 1 }],
    ["application/json; charset=utf-8", json, { a: 1 }],
    ["application/vnd.api+json", json, { a: 1 }],
    ["application/ld+json", json, { a: 1 }],
    ["application/ld+json; charset=utf-8", json, { a: 1 }],
    ["application/manifest+json", json, { a: 1 }],
    ["application/geo+json", json, { a: 1 }],
    ["text/json", json, { a: 1 }],
    ["application/javascript", "1+1", "1+1"],
    ["application/javascript; charset=utf-8", "1+1", "1+1"],
    ["application/x-javascript", "1+1", "1+1"],
    ["application/ecmascript", "1+1", "1+1"],
    ["application/xml", "<a/>", "<a/>"],
    ["text/plain", "hi", "hi"],
    ["text/html", "<b>hi</b>", "<b>hi</b>"],
    ["text/javascript", "1+1", "1+1"],
    ["text/xml", "<a/>", "<a/>"],
    ["image/png", "png", "data:image/png;base64,cG5n"],
    ["application/octet-stream", "bin", "data:application/octet-stream;base64,Ymlu"],
    ["application/wasm", "wasm", "data:application/wasm;base64,d2FzbQ=="],
    ["application/x-ndjson", '{"a":1}\n{"a":2}\n', "data:application/x-ndjson;base64,eyJhIjoxfQp7ImEiOjJ9Cg=="],
  ];
  using dir = tempDir("macro-mime-essence", {
    "m.ts": [
      `export function resp(type: string, body: string) {`,
      `  return new Response(body, { headers: { "content-type": type } });`,
      `}`,
      `export function blob(type: string, body: string) {`,
      `  return new Blob([body], { type });`,
      `}`,
    ].join("\n"),
    "index.ts": [
      `import { resp, blob } from "./m.ts" with { type: "macro" };`,
      `console.log(JSON.stringify([`,
      ...cases.map(([type, body]) => `  resp(${JSON.stringify(type)}, ${JSON.stringify(body)}),`),
      ...cases.map(([type, body]) => `  blob(${JSON.stringify(type)}, ${JSON.stringify(body)}),`),
      `]));`,
      ``,
    ].join("\n"),
  });
  await using proc = Bun.spawn({
    cmd: [bunExe(), "run", "index.ts"],
    env: bunEnv,
    cwd: String(dir),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  const expected = cases.map(([, , expected]) => expected);
  // Debug builds print "[macro] call <name>" to stdout before the script's own output.
  expect({ lastLine: stdout.trim().split("\n").pop(), stderr }).toEqual({
    lastLine: JSON.stringify([...expected, ...expected]),
    stderr: "",
  });
  expect(exitCode).toBe(0);
});

// A macro's `await` is serviced by the VM's macro event loop, so completions have to be routed by which
// loop was current when their work started: what the macro started goes to the macro loop (or the wait
// hangs), what the program started stays on the regular loop (or program callbacks run mid-transpile),
// and whatever a macro started but did not await is adopted by the regular loop once the macro returns
// (or it is stranded and its keep-alive holds the process open). These run the macro in the main VM:
// the entry file's macros, or a module require()d so it transpiles on the main thread.
describe("event loop routing around macros", () => {
  async function run(files: Record<string, string>, env: Record<string, string> = {}) {
    using dir = tempDir("macro-loops", files);
    await using proc = Bun.spawn({
      cmd: [bunExe(), "run", "index.ts"],
      env: { ...bunEnv, ...env },
      cwd: String(dir),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    // Debug builds also print "[macro] call <name>" to stdout.
    const lines = stdout
      .trim()
      .split("\n")
      .filter(line => !line.startsWith("[macro]"));
    return { lines, stderr, exitCode };
  }

  const unawaited: [name: string, macroSource: string][] = [
    [
      "an fs.promises call inside the macro",
      [
        `import { promises as fs } from "node:fs";`,
        `export function m() {`,
        `  fs.stat(import.meta.dir).then(() => console.log("settled"));`,
        `  return 1;`,
        `}`,
      ].join("\n"),
    ],
    [
      "an fs.promises call at the macro module's top level",
      [
        `import { promises as fs } from "node:fs";`,
        `fs.stat(import.meta.dir).then(() => console.log("settled"));`,
        `export function m() {`,
        `  return 1;`,
        `}`,
      ].join("\n"),
    ],
    [
      "a fetch() inside the macro",
      [
        `export function m() {`,
        `  fetch(process.env.MACRO_TEST_URL!).then(res => res.text()).then(body => console.log(body));`,
        `  return 1;`,
        `}`,
      ].join("\n"),
    ],
    [
      // 64 bytes or more are hashed on the WebCrypto work queue; its reply and keep-alive release come
      // back through the pool task's ticket rather than a thread-pool job like the cases above.
      "a crypto.subtle.digest() inside the macro",
      [
        `export function m() {`,
        `  crypto.subtle.digest("SHA-256", new Uint8Array(4096)).then(() => console.log("settled"));`,
        `  return 1;`,
        `}`,
      ].join("\n"),
    ],
    [
      // JSC's DeferredWorkTimer: the keep-alive and the completion are registered against the loop
      // current at WebAssembly.compile() and delivered from a JSC helper thread.
      "a WebAssembly.compile() inside the macro",
      [
        `export function m() {`,
        `  WebAssembly.compile(new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0])).then(() => console.log("settled"));`,
        `  return 1;`,
        `}`,
      ].join("\n"),
    ],
  ];

  test.concurrent.each(unawaited)(
    "%s that it does not await still lets the process exit",
    async (_name, macroSource) => {
      await using server = Bun.serve({ port: 0, fetch: () => new Response("settled") });
      const { lines, stderr, exitCode } = await run(
        {
          "m.ts": macroSource,
          "index.ts": `import { m } from "./m.ts" with { type: "macro" };\nconsole.log("value", m());\n`,
        },
        { MACRO_TEST_URL: server.url.href },
      );
      // The continuation runs on the macro loop if the work finishes while the macro is still being waited
      // on and on the regular loop otherwise, so its position relative to the entry module's output varies.
      expect({ lines: lines.sort(), stderr }).toEqual({ lines: ["settled", "value 1"], stderr: "" });
      expect(exitCode).toBe(0);
    },
  );

  // The program's digest finishes (microseconds, on the work queue) while the macro is parked in its
  // 200 ms wait. Its callback belongs to the program: it must run after require() returns, not inside
  // the macro's wait underneath the transpiler, so the macro never sees "program" in the log.
  test.concurrent("a program completion that arrives during a macro waits for the macro to return", async () => {
    const { lines, stderr, exitCode } = await run({
      "m.ts": [
        `export async function probe() {`,
        `  await Bun.sleep(200);`,
        `  return JSON.stringify(globalThis.log);`,
        `}`,
      ].join("\n"),
      "with-macro.ts": `import { probe } from "./m.ts" with { type: "macro" };\nexport const seen = probe();\n`,
      "index.ts": [
        `globalThis.log = [];`,
        `const digest = crypto.subtle.digest("SHA-256", new Uint8Array(4096)).then(() => globalThis.log.push("program"));`,
        `const { seen } = require("./with-macro.ts");`,
        `globalThis.log.push("required");`,
        `await digest;`,
        `console.log(seen, JSON.stringify(globalThis.log));`,
      ].join("\n"),
    });
    expect({ lines, stderr }).toEqual({ lines: [`[] ["required","program"]`], stderr: "" });
    expect(exitCode).toBe(0);
  });

  // If a program callback did run mid-macro, work it started there would be routed to the macro loop and,
  // finishing after the macro returned, would need the regular loop to adopt it. Either way the chain
  // must complete and the process must exit.
  test.concurrent("work chained off a program completion across a macro completes", async () => {
    const { lines, stderr, exitCode } = await run({
      "m.ts": `export async function probe() {\n  await Bun.sleep(200);\n  return 1;\n}\n`,
      "with-macro.ts": `import { probe } from "./m.ts" with { type: "macro" };\nexport const value = probe();\n`,
      "index.ts": [
        `import { promises as fs } from "node:fs";`,
        `const chained = crypto.subtle`,
        `  .digest("SHA-256", new Uint8Array(4096))`,
        `  .then(() => fs.stat(import.meta.dir))`,
        `  .then(() => "chained");`,
        `const { value } = require("./with-macro.ts");`,
        `console.log(value, await chained);`,
      ].join("\n"),
    });
    expect({ lines, stderr }).toEqual({ lines: ["1 chained"], stderr: "" });
    expect(exitCode).toBe(0);
  });
});

// A module that is not the entry point is transpiled on a worker thread, where no VM exists yet. The
// macro VM created there has to take the CLI's transform options, or the macro module never sees
// `--define`.
test("a macro in a module transpiled off the main thread sees --define", async () => {
  using dir = tempDir("macro-off-thread-define", {
    "m.ts": `export function mode() {\n  return process.env.MODE ?? "none";\n}\n`,
    "lib.ts": `import { mode } from "./m.ts" with { type: "macro" };\nexport const x = mode();\n`,
    "index.ts": `import { x } from "./lib.ts";\nconsole.log(x);\n`,
  });
  await using proc = Bun.spawn({
    cmd: [bunExe(), "--define", 'process.env.MODE:"prod"', "index.ts"],
    env: bunEnv,
    cwd: String(dir),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  expect({ lastLine: stdout.trim().split("\n").pop(), stderr }).toEqual({ lastLine: "prod", stderr: "" });
  expect(exitCode).toBe(0);
});

// `Bun.build()` parses on the process-wide worker pool. The macro VM a worker creates takes the
// options of the build that creates it and lives on after that build, so this runs in its own
// process: an earlier build in the same process would otherwise decide what the macro sees.
test("Bun.build() passes define and loader to the macro VM", async () => {
  using dir = tempDir("macro-build-api-options", {
    "entry.ts": `import { mode, banner } from "./macro.ts" with { type: "macro" };\nconsole.log(mode(), banner());\n`,
    "macro.ts": [
      `import banner_ from "./banner.dat";`,
      `export function mode() {\n  return process.env.MODE ?? "none";\n}`,
      `export function banner() {\n  return banner_;\n}`,
      ``,
    ].join("\n"),
    "banner.dat": "hello from a text loader",
    "build.ts": `
      const result = await Bun.build({
        entrypoints: ["./entry.ts"],
        target: "bun",
        define: { "process.env.MODE": '"prod"' },
        loader: { ".dat": "text" },
      });
      console.log(await result.outputs[0].text());
    `,
  });
  await using proc = Bun.spawn({
    cmd: [bunExe(), "run", "build.ts"],
    env: bunEnv,
    cwd: String(dir),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  expect({ lastLine: stdout.trim().split("\n").pop(), stderr }).toEqual({
    lastLine: `console.log("prod", "hello from a text loader");`,
    stderr: "",
  });
  expect(exitCode).toBe(0);
});

describe("--no-macros", () => {
  const files = {
    "macro.ts": `
      import { writeFileSync } from "node:fs";
      export function f() {
        writeFileSync("MACRO_RAN", "macro executed");
        return "INLINED_RESULT";
      }
    `,
    "entry.ts": `
      import { f } from "./macro.ts" with { type: "macro" };
      console.log(f());
    `,
  };

  test("bun build --no-macros refuses to run macros", async () => {
    using dir = tempDir("bundler-no-macros-cli", files);
    await using proc = Bun.spawn({
      cmd: [bunExe(), "build", "--no-macros", "./entry.ts", "--outdir", "dist"],
      env: bunEnv,
      cwd: String(dir),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect({ stdout, stderr, exitCode }).toMatchObject({
      stderr: expect.stringContaining("Macros are disabled"),
      exitCode: 1,
    });
    expect(existsSync(path.join(String(dir), "MACRO_RAN"))).toBe(false);
    expect(existsSync(path.join(String(dir), "dist", "entry.js"))).toBe(false);
  });

  test("Bun.build({ macros: false }) refuses to run macros", async () => {
    using dir = tempDir("bundler-no-macros-api", {
      ...files,
      "build.ts": `
        const result = await Bun.build({
          entrypoints: ["./entry.ts"],
          outdir: "./dist",
          macros: false,
          throw: false,
        });
        console.log(JSON.stringify({
          success: result.success,
          logs: result.logs.map(l => l.message),
        }));
      `,
    });
    await using proc = Bun.spawn({
      cmd: [bunExe(), "run", "build.ts"],
      env: bunEnv,
      cwd: String(dir),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    const parsed = JSON.parse(stdout.trim().split("\n").pop()!);
    expect({ parsed, stderr, exitCode }).toMatchObject({
      parsed: {
        success: false,
        logs: expect.arrayContaining([expect.stringContaining("Macros are disabled")]),
      },
      exitCode: 0,
    });
    expect(existsSync(path.join(String(dir), "MACRO_RAN"))).toBe(false);
  });

  test("bun build without --no-macros still runs macros", async () => {
    using dir = tempDir("bundler-macros-enabled", files);
    await using proc = Bun.spawn({
      cmd: [bunExe(), "build", "./entry.ts", "--outdir", "dist"],
      env: bunEnv,
      cwd: String(dir),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect({ stdout, stderr, exitCode }).toMatchObject({ exitCode: 0 });
    const out = await Bun.file(path.join(String(dir), "dist", "entry.js")).text();
    expect(out).toContain("INLINED_RESULT");
    expect(existsSync(path.join(String(dir), "MACRO_RAN"))).toBe(true);
  });
});

// Bun removes a macro import from the output and replaces only a call of it with the macro's result. Any other
// reference would name a binding that the output does not declare, so it is an error wherever the file is transpiled.
describe("a macro import that is used outside of a call", () => {
  const notDefined = (name: string) => `"${name}" is a macro import and is not defined at runtime`;
  const removed = (name: string) => `Bun removes this macro import of "${name}" from "./m.ts"`;
  const remedy = (name: string, how = "add a regular import of it") =>
    `Bun replaces each call of a macro with its result. To inline a value, call a macro that returns it. To use "${name}" at runtime, ${how}.`;

  const macroFile = [
    `export function m(x?: unknown) { return 42; }`,
    `export function o() { return { a: 1, b: 2 }; }`,
    `export default function d() { return 7; }`,
    `export const K = [1, 2, 3].join(",");`,
    ``,
  ].join("\n");
  const named = `import { m } from "./m.ts" with { type: "macro" };`;
  const star = `import * as ns from "./m.ts" with { type: "macro" };`;

  // [source, ...the binding that each error names, in source order]
  const refused: Record<string, [source: string, ...names: string[]]> = {
    "alias.ts": [`${named} const f = m; console.log(f("x"));`, "m"],
    "function-alias.ts": [`${named} function g() { const f = m; return f("x"); } console.log(g());`, "m"],
    "argument.ts": [`${named} console.log([1].map(m));`, "m"],
    "shorthand.ts": [`${named} console.log({ m });`, "m"],
    "property.ts": [`${named} console.log(m.name);`, "m"],
    "method-call.ts": [`${named} console.log(m.call(null));`, "m"],
    "new.ts": [`${named} console.log(new m());`, "m"],
    "typeof.ts": [`${named} console.log(typeof m);`, "m"],
    "typeof-guard.ts": [`${named} console.log(typeof m === "function" ? "fn" : m());`, "m"],
    "assignment.ts": [`${named} m = 1;`, "m"],
    "export-clause.ts": [`${named} export { m };`, "m"],
    "export-default.ts": [`${named} export default m;`, "m"],
    "uncalled-function.ts": [`${named} function uncalled() { return m; } console.log("loaded");`, "m"],
    "import-equals.ts": [`${named} import f = m; console.log(f);`, "m"],
    "two-uses.ts": [`${named} const f = m; const g = m; console.log(f, g);`, "m", "m"],
    "constant.ts": [`import { K } from "./m.ts" with { type: "macro" }; console.log(K);`, "K"],
    "default.ts": [`import d from "./m.ts" with { type: "macro" }; console.log(d);`, "d"],
    "renamed.ts": [`import { m as renamed } from "./m.ts" with { type: "macro" }; console.log(renamed);`, "renamed"],
    "assert.ts": [`import { m } from "./m.ts" assert { type: "macro" }; console.log(m);`, "m"],
    "namespace.ts": [`${star} console.log(Object.keys(ns));`, "ns"],
    "namespace-member.ts": [`${star} const f = ns.m; console.log(f());`, "ns"],
    "namespace-member-of-member.ts": [`${star} console.log(ns.m.call(null));`, "ns"],
    // A replaced call, live or dead, does not hide a use in another place.
    "use-before-call.ts": [`${named} console.log(m); console.log(m());`, "m"],
    "use-after-call.ts": [`${named} console.log(m()); console.log(m);`, "m"],
    "use-beside-call.ts": [`${named} console.log(m(), m);`, "m"],
    "use-after-dead-call.ts": [`${named} if (false) { console.log(m()); } console.log(m);`, "m"],
  };

  // Each of these prints one line, and keeps doing so.
  const accepted: Record<string, [source: string, stdout: string]> = {
    "call.ts": [`${named} console.log("call", m());`, "call 42"],
    "optional-call.ts": [`${named} console.log("optional-call", m?.());`, "optional-call 42"],
    "parenthesized-call.ts": [`${named} console.log("parenthesized-call", (m)());`, "parenthesized-call 42"],
    "type-assertions.ts": [
      `${named} console.log("type-assertions", (m as any)(), m!(), (<any>m)(), (m satisfies unknown)());`,
      "type-assertions 42 42 42 42",
    ],
    "default-call.ts": [
      `import d, { m as renamed } from "./m.ts" with { type: "macro" }; console.log("default-call", d(), renamed());`,
      "default-call 7 42",
    ],
    "assert-call.ts": [
      `import { m } from "./m.ts" assert { type: "macro" }; console.log("assert-call", m());`,
      "assert-call 42",
    ],
    "namespace-call.ts": [
      `${star} console.log("namespace-call", ns.m(), ns?.m(), ns.default());`,
      "namespace-call 42 42 7",
    ],
    "unused.ts": [`${named} ${star} console.log("unused");`, "unused"],
    "type-only.ts": [
      `${named} type T = ReturnType<typeof m>; const x: T = 1; let y: typeof m | undefined; console.log("type-only", x, y);`,
      "type-only 1 undefined",
    ],
    "shadowed.ts": [
      `${named} const len = (m: string) => m.length; console.log("shadowed", m(), len("abc"));`,
      "shadowed 42 3",
    ],
    "use-before-import.ts": [`console.log("use-before-import", m()); ${named}`, "use-before-import 42"],
    // A use in a branch that the visit pass knows is dead is not in the output.
    "dead-branch.ts": [
      `${named} if (false) console.log(typeof m, m); console.log("dead-branch", m());`,
      "dead-branch 42",
    ],
    "dead-call.ts": [
      `${named} if (false) { console.log(m()); } false && m(); console.log("dead-call", m());`,
      "dead-call 42",
    ],
    "nested-calls.ts": [
      `${named} console.log("nested-calls", m(m()), [m(), m()].length, { a: m() }.a, \`\${m()}\`);`,
      "nested-calls 42 2 42 42",
    ],
    "class-fields.ts": [
      `${named} class A { x = m(); static y = m(); #z = m(); get z() { return this.#z; } } const a = new A(); console.log("class-fields", a.x, A.y, a.z);`,
      "class-fields 42 42 42",
    ],
    "default-parameters.ts": [
      `${named} function f(a = m()) { return a; } const g = (a = m()) => a; console.log("default-parameters", f(), g());`,
      "default-parameters 42 42",
    ],
    "result-alias.ts": [
      `${named} const v = m(); const w = v; console.log("result-alias", v + w);`,
      "result-alias 84",
    ],
    "destructured-result.ts": [
      `import { o } from "./m.ts" with { type: "macro" }; const { a, b } = o(); const [c] = [o().a]; console.log("destructured-result", a, b, c);`,
      "destructured-result 1 2 1",
    ],
    "enum.ts": [`${named} enum E { A = m(), B = A + 1 } console.log("enum", E.A, E.B);`, "enum 42 43"],
    "namespace-block.ts": [
      `${named} namespace N { export const v = m(); } console.log("namespace-block", N.v);`,
      "namespace-block 42",
    ],
    "condition.ts": [
      `${named} console.log("condition", m() ? "yes" : "no", m() && 1, m() ?? 2);`,
      "condition yes 1 42",
    ],
  };

  const sourcesOf = (rows: Record<string, readonly [source: string, ...rest: string[]]>) =>
    Object.fromEntries(Object.entries(rows).map(([file, [source]]) => [file, source + "\n"]));
  const refusedErrors = Object.fromEntries(
    Object.entries(refused).map(([file, [, ...names]]) => [file, names.map(notDefined)]),
  );
  const acceptedStdout = Object.values(accepted).map(([, stdout]) => stdout);
  const files = {
    "m.ts": macroFile,
    ...sourcesOf(refused),
    ...sourcesOf(accepted),
    "accepted.ts": Object.keys(accepted)
      .map(file => `import "./${file}";`)
      .join("\n"),
    // Each prints, as its last line, what every file named on the command line did.
    "build.ts": `
      import { basename } from "node:path";
      const files = process.argv.slice(2);
      const build = await Bun.build({ entrypoints: files.map(file => "./" + file), target: "bun", throw: false });
      const errors: Record<string, string[]> = Object.fromEntries(files.map(file => [file, []]));
      for (const log of build.logs) errors[basename(log.position?.file ?? "")]?.push(log.message);
      console.log(JSON.stringify(errors));
    `,
    "import.ts": `
      const errors: Record<string, string[]> = {};
      for (const file of process.argv.slice(2)) {
        try {
          await import("./" + file);
          errors[file] = [];
        } catch (e: any) {
          errors[file] = (e?.errors ?? [e]).map((error: any) => error.message);
        }
      }
      console.log(JSON.stringify(errors));
    `,
    "transform.ts": `
      const transpiler = new Bun.Transpiler({ loader: "ts" });
      const errors: Record<string, string[]> = {};
      for (const file of process.argv.slice(2)) {
        try {
          transpiler.transformSync(await Bun.file(file).text());
          errors[file] = [];
        } catch (e: any) {
          errors[file] = (e?.errors ?? [e]).map((error: any) => error.message);
        }
      }
      console.log(JSON.stringify(errors));
    `,
  };

  async function run(cwd: string, ...args: string[]) {
    await using proc = Bun.spawn({ cmd: [bunExe(), ...args], env: bunEnv, cwd, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    // A debug build also prints "[macro] call <name>" to stdout.
    const lines = stdout
      .trim()
      .split("\n")
      .filter(line => !line.startsWith("[macro]"));
    return { lines, stderr, exitCode };
  }

  describe.each(["build.ts", "import.ts", "transform.ts"])("through %s", script => {
    test.concurrent("each reference that is not a call is an error", async () => {
      using dir = tempDir("macro-value-use", files);
      const { lines, stderr, exitCode } = await run(String(dir), script, ...Object.keys(refused));
      expect({ errors: JSON.parse(lines.at(-1)!), stderr }).toEqual({ errors: refusedErrors, stderr: "" });
      expect(exitCode).toBe(0);
    });

    test.concurrent("a call, an unused import and a use in dead code are not", async () => {
      using dir = tempDir("macro-value-use", files);
      const { lines, stderr, exitCode } = await run(String(dir), script, ...Object.keys(accepted));
      expect({ errors: JSON.parse(lines.at(-1)!), printed: lines.slice(0, -1), stderr }).toEqual({
        errors: Object.fromEntries(Object.keys(accepted).map(file => [file, []])),
        // Only the import runs the files.
        printed: script === "import.ts" ? acceptedStdout : [],
        stderr: "",
      });
      expect(exitCode).toBe(0);
    });
  });

  test.concurrent("a bundle of the accepted forms runs", async () => {
    using dir = tempDir("macro-value-use", files);
    const build = await run(String(dir), "build", "./accepted.ts", "--target=bun", "--outdir", "out");
    expect({ stderr: build.stderr, exitCode: build.exitCode }).toEqual({ stderr: "", exitCode: 0 });
    const { lines, stderr, exitCode } = await run(String(dir), "out/accepted.js");
    expect({ lines, stderr }).toEqual({ lines: acceptedStdout, stderr: "" });
    expect(exitCode).toBe(0);
  });

  // The error follows what the visit pass replaces. `(0, m)()` is a call of `m` once the comma is folded away, which
  // the runtime and --minify-syntax do before they look at the call.
  test.concurrent("a call that only some modes fold is an error where it is not folded", async () => {
    using dir = tempDir("macro-value-use", {
      "m.ts": macroFile,
      "comma-call.ts": `${named} console.log("comma-call", (0, m)());\n`,
    });
    const plain = await run(String(dir), "build", "./comma-call.ts", "--target=bun");
    expect(plain.stderr).toContain(notDefined("m"));
    expect(plain.exitCode).toBe(1);
    const minified = await run(String(dir), "build", "./comma-call.ts", "--target=bun", "--minify-syntax");
    expect({ lines: minified.lines.filter(line => line.includes("comma-call")), stderr: minified.stderr }).toEqual({
      lines: [`console.log("comma-call", 42);`],
      stderr: "",
    });
    expect(minified.exitCode).toBe(0);
    const ran = await run(String(dir), "comma-call.ts");
    expect({ lines: ran.lines, stderr: ran.stderr }).toEqual({ lines: ["comma-call 42"], stderr: "" });
    expect(ran.exitCode).toBe(0);
  });

  const detail = `
    const detail = (e: any) =>
      (e?.errors ?? [e]).map((error: any) => ({
        message: error.message,
        at: [error.position?.line, error.position?.column],
        notes: error.notes.map((note: any) => [note.message, note.position?.line ?? null, note.position?.column ?? null]),
      }));
  `;

  test.concurrent("the error is at the identifier, with a note at the import and a note that names the remedies", async () => {
    using dir = tempDir("macro-value-use", {
      "m.ts": macroFile,
      "where.ts": [
        `import fn, { m as renamed } from "./m.ts" with { type: "macro" };`,
        `import * as ns from "./m.ts" with { type: "macro" };`,
        `export function later() {`,
        `  return [renamed(), ns.m()].map(renamed);`,
        `}`,
        `export { fn };`,
        `console.log(typeof ns, fn());`,
        ``,
      ].join("\n"),
      "build.ts": `
        ${detail}
        const build = await Bun.build({ entrypoints: ["./where.ts"], target: "bun", throw: false });
        console.log(JSON.stringify(detail({ errors: build.logs })));
      `,
      "import.ts": `
        ${detail}
        try {
          await import("./where.ts");
        } catch (e) {
          console.log(JSON.stringify(detail(e)));
        }
      `,
    });
    const expected = [
      {
        message: notDefined("renamed"),
        at: [4, 34],
        notes: [
          [removed("renamed"), 1, 14],
          [remedy("renamed"), null, null],
        ],
      },
      {
        message: notDefined("fn"),
        at: [6, 10],
        notes: [
          [removed("fn"), 1, 8],
          [remedy("fn"), null, null],
        ],
      },
      {
        message: notDefined("ns"),
        at: [7, 20],
        notes: [
          [removed("ns"), 2, 13],
          [remedy("ns"), null, null],
        ],
      },
    ];
    for (const script of ["build.ts", "import.ts"]) {
      const { lines, stderr, exitCode } = await run(String(dir), script);
      expect({ script, errors: JSON.parse(lines.at(-1)!), stderr }).toEqual({ script, errors: expected, stderr: "" });
      expect(exitCode).toBe(0);
    }
  });

  // The visit pass counts a use before it removes the node that holds it. The count is what decides, so the error
  // stays, at the import.
  test.concurrent("a use whose node the visit pass removed is an error at the import", async () => {
    using dir = tempDir("macro-value-use", {
      "m.ts": macroFile,
      "void-in-function.ts": `${named}\nexport function g() {\n  void m;\n}\n`,
      "import.ts": `
        ${detail}
        try {
          await import("./void-in-function.ts");
        } catch (e) {
          console.log(JSON.stringify(detail(e)));
        }
      `,
    });
    const { lines, stderr, exitCode } = await run(String(dir), "import.ts");
    expect({ errors: JSON.parse(lines.at(-1)!), stderr }).toEqual({
      errors: [
        {
          message: `${notDefined("m")}, but this file uses it outside of a call`,
          at: [1, 10],
          notes: [[remedy("m"), null, null]],
        },
      ],
      stderr: "",
    });
    expect(exitCode).toBe(0);
  });

  // A statement that is only a reference has no effect, so the visit pass removes it with its use. Where each
  // statement is a part of its own, nothing of it is left to report.
  test.concurrent("a statement that the visit pass removes with its use is not an error", async () => {
    using dir = tempDir("macro-value-use", {
      "m.ts": macroFile,
      "void.ts": `${named}\nvoid m;\nm;\nconsole.log("void", m());\n`,
    });
    const { lines, stderr, exitCode } = await run(String(dir), "void.ts");
    expect({ lines, stderr }).toEqual({ lines: ["void 42"], stderr: "" });
    expect(exitCode).toBe(0);
    const built = await run(String(dir), "build", "./void.ts", "--target=bun");
    expect({ lines: built.lines.filter(line => line.includes("void")), stderr: built.stderr }).toEqual({
      lines: [`console.log("void", 42);`],
      stderr: "",
    });
    expect(built.exitCode).toBe(0);
  });

  // The place of the error is found by a walk that stops at a depth limit. The error itself does not depend on it.
  test.concurrent("a use in a long chain is found, and a use nested too deep is an error at the import", async () => {
    const depth = 600;
    using dir = tempDir("macro-value-use", {
      "m.ts": macroFile,
      "chain.ts": `${named}\nexport const sum = m${Buffer.alloc(2 * 20_000, "+x").toString()};\nvar x = 1;\n`,
      "deep.ts": `${named}\nconsole.log(${Buffer.alloc(depth, "[").toString()}m${Buffer.alloc(depth, "]").toString()});\n`,
      "import.ts": `
        ${detail}
        const errors: unknown[] = [];
        for (const file of ["./chain.ts", "./deep.ts"]) {
          try {
            await import(file);
            errors.push("loaded");
          } catch (e) {
            errors.push(detail(e).map(({ message, at }) => ({ message, at })));
          }
        }
        console.log(JSON.stringify(errors));
      `,
    });
    const { lines, stderr, exitCode } = await run(String(dir), "import.ts");
    expect({ errors: JSON.parse(lines.at(-1)!), stderr }).toEqual({
      errors: [
        [{ message: notDefined("m"), at: [2, 20] }],
        [{ message: `${notDefined("m")}, but this file uses it outside of a call`, at: [1, 10] }],
      ],
      stderr: "",
    });
    expect(exitCode).toBe(0);
  });

  // With --no-macros a call of a macro is an error. Any other reference is still the name of a removed binding.
  test.concurrent("a reference that is not a call is an error with --no-macros too", async () => {
    using dir = tempDir("macro-value-use", {
      "m.ts": macroFile,
      "alias.ts": refused["alias.ts"][0],
    });
    const { stderr, exitCode } = await run(String(dir), "build", "--no-macros", "./alias.ts", "--target=bun");
    expect(stderr).toContain(notDefined("m"));
    expect(exitCode).toBe(1);
  });

  // A type that is named like a macro import is not a reference to it. The metadata of a decorated member names the
  // type, and a macro import has no value there.
  test.concurrent("a type named like a macro import is not an error with emitDecoratorMetadata", async () => {
    const body = (label: string) => [
      `const types: Record<string, unknown> = {};`,
      `(Reflect as any).metadata = (key: string, value: unknown) => (_: unknown, name: string) => {`,
      `  if (key === "design:type") types[name] = value;`,
      `};`,
      `function field(..._: unknown[]) {}`,
      `class Holder {`,
      `  @field plain: Settings = Settings();`,
      `  @field dotted!: ns.Settings;`,
      `}`,
      `console.log("${label}", JSON.stringify(new Holder().plain), types.plain === Object, types.dotted === Object);`,
    ];
    const imports = [
      `import { Settings } from "./settings.ts" with { type: "macro" };`,
      `import * as ns from "./settings.ts" with { type: "macro" };`,
    ];
    using dir = tempDir("macro-value-use", {
      "tsconfig.json": JSON.stringify({
        compilerOptions: { experimentalDecorators: true, emitDecoratorMetadata: true },
      }),
      "settings.ts": `export interface Settings { a: number }\nexport function Settings(): Settings { return { a: 1 }; }\n`,
      "import-first.ts": [...imports, ...body("import-first"), ``].join("\n"),
      "type-first.ts": [...body("type-first"), ...imports, ``].join("\n"),
    });
    for (const file of ["import-first", "type-first"]) {
      const ran = await run(String(dir), `${file}.ts`);
      expect({ lines: ran.lines, stderr: ran.stderr }).toEqual({ lines: [`${file} {"a":1} true true`], stderr: "" });
      expect(ran.exitCode).toBe(0);
      const built = await run(String(dir), "build", `./${file}.ts`, "--target=bun", "--outdir", "out");
      expect({ stderr: built.stderr, exitCode: built.exitCode }).toEqual({ stderr: "", exitCode: 0 });
      const output = await Bun.file(path.join(String(dir), "out", `${file}.js`)).text();
      expect(output).not.toContain("typeof Settings");
      expect(output).not.toContain("typeof ns");
      const bundled = await run(String(dir), `out/${file}.js`);
      expect({ lines: bundled.lines, stderr: bundled.stderr }).toEqual({
        lines: [`${file} {"a":1} true true`],
        stderr: "",
      });
    }
  });

  describe("an import that a macro remap replaces", () => {
    const remapped = {
      "bunfig.toml": `[macros]\nfakepkg = { "m" = "./m.ts", "default" = "./m.ts" }\n`,
      "m.ts": macroFile,
      "node_modules/fakepkg/package.json": JSON.stringify({ name: "fakepkg", version: "1.0.0", type: "module" }),
      "node_modules/fakepkg/index.js": [
        `export function m() { return "m at runtime"; }`,
        `export function other() { return "other at runtime"; }`,
        `export default function () { return "default at runtime"; }`,
        ``,
      ].join("\n"),
    };

    test.concurrent("is an error when it is used outside of a call", async () => {
      using dir = tempDir("macro-value-use", {
        ...remapped,
        "value.ts": `import { m, other } from "fakepkg";\nconst f = m;\nconsole.log(f, other());\n`,
        "import.ts": `
          ${detail}
          try {
            await import("./value.ts");
          } catch (e) {
            console.log(JSON.stringify(detail(e)));
          }
        `,
      });
      const expected = [
        {
          message: notDefined("m"),
          at: [2, 11],
          notes: [
            [`Bun removes this import of "m" because a macro remap replaces it with "./m.ts"`, 1, 10],
            [remedy("m", "remove its macro remap"), null, null],
          ],
        },
      ];
      const { lines, stderr, exitCode } = await run(String(dir), "import.ts");
      expect({ errors: JSON.parse(lines.at(-1)!), stderr }).toEqual({ errors: expected, stderr: "" });
      expect(exitCode).toBe(0);
      const built = await run(String(dir), "build", "./value.ts", "--target=bun");
      expect(built.stderr).toContain(notDefined("m"));
      expect(built.exitCode).toBe(1);
    });

    // Only the default import is a macro here. The namespace is still imported at runtime.
    test.concurrent("keeps the namespace import beside it", async () => {
      using dir = tempDir("macro-value-use", {
        ...remapped,
        "namespace.ts": `import d, * as ns from "fakepkg";\nconsole.log(d(), ns.other());\n`,
      });
      const { lines, stderr, exitCode } = await run(String(dir), "namespace.ts");
      expect({ lines, stderr }).toEqual({ lines: ["7 other at runtime"], stderr: "" });
      expect(exitCode).toBe(0);
      const built = await run(String(dir), "build", "./namespace.ts", "--target=bun", "--outdir", "out");
      expect({ stderr: built.stderr, exitCode: built.exitCode }).toEqual({ stderr: "", exitCode: 0 });
      const bundled = await run(String(dir), "out/namespace.js");
      expect({ lines: bundled.lines, stderr: bundled.stderr }).toEqual({ lines: ["7 other at runtime"], stderr: "" });
      expect(bundled.exitCode).toBe(0);
    });
  });

  // Inside a macro no call is replaced, so a module that a macro loads is not checked. What is transpiled there still
  // names the macro import, so a later load outside of a macro must not read it from the transpiler cache.
  test.concurrent("a module that a macro loads is not checked, and is not cached for a load outside of a macro", async () => {
    using dir = tempDir("macro-value-use", {
      "m.ts": macroFile,
      "shared.ts": [
        named,
        `export function helper() { return "helper"; }`,
        `export function uncalled() { return m; }`,
        // Large enough for the transpiler cache to keep.
        `// ${Buffer.alloc(8 * 1024, "-").toString()}`,
        ``,
      ].join("\n"),
      "outer.ts": `import { helper } from "./shared.ts";\nexport function outer() { return helper(); }\n`,
      "inside.ts": `import { outer } from "./outer.ts" with { type: "macro" };\nconsole.log("inside", outer());\n`,
      "outside.ts": `import { helper } from "./shared.ts";\nconsole.log("outside", helper());\n`,
      "cache": {},
    });
    const env = { ...bunEnv, BUN_RUNTIME_TRANSPILER_CACHE_PATH: path.join(String(dir), "cache") };
    for (const [file, expected] of [
      ["inside.ts", { lines: ["inside helper"], stderr: "", exitCode: 0 }],
      ["outside.ts", { lines: [""], stderr: expect.stringContaining(notDefined("m")), exitCode: 1 }],
    ] as const) {
      await using proc = Bun.spawn({ cmd: [bunExe(), file], env, cwd: String(dir), stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
      const lines = stdout
        .trim()
        .split("\n")
        .filter(line => !line.startsWith("[macro]"));
      expect({ file, lines, stderr, exitCode }).toEqual({ file, ...expected });
    }
  });
});
