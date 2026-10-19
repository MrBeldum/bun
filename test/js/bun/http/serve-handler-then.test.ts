import { describe, expect, test } from "bun:test";
import { bunEnv, bunExe } from "harness";
import vm from "node:vm";

// A handler can return a promise whose class has its own then(). The state of such a promise is
// not its answer: Bun.serve asks then(), once, as `await` does.

/** Fulfilled at once with a placeholder, and then() delivers: an SDK's `APIPromise` (null), p-lazy (undefined). */
class PlaceholderPromise<T> extends Promise<T> {
  #inner: Promise<T>;
  constructor(placeholder: null | undefined, inner: Promise<T>) {
    super(resolve => resolve(placeholder as any));
    this.#inner = inner;
  }
  then(onFulfilled?: any, onRejected?: any): any {
    return this.#inner.then(onFulfilled, onRejected);
  }
}

/** Inherits then(). Its constructor drops the executor, so then() and `await` throw a TypeError on it. */
class Deferred<T> extends Promise<T> {
  resolve!: (value: T) => void;
  constructor() {
    let resolve!: (value: T) => void;
    super(r => {
      resolve = r;
    });
    this.resolve = resolve;
  }
}

class Eager<T> extends Promise<T> {}

const later = <T>(value: () => T) => new Promise<T>(resolve => setImmediate(() => resolve(value())));

type Make = (req: Request, server: Bun.Server<undefined>) => unknown;

const kinds = {
  "fetch": (make: Make) => ({ fetch: make }),
  "a routes function": (make: Make) => ({ routes: { "/": make } }),
  "a routes method object": (make: Make) => ({ routes: { "/": { GET: make } } }),
  "error()": (make: Make) => ({
    fetch() {
      throw new Error("thrown by fetch");
    },
    error: () => make(undefined!, undefined!),
  }),
};
type Kind = keyof typeof kinds;

/** One request to a server whose handler returns `make()`. `errors`: what reached the test's error(). */
async function answer(kind: Kind, make: Make, init?: RequestInit) {
  const errors: unknown[] = [];
  const options: any = { port: 0, development: false, ...kinds[kind](make) };
  options.error ??= (error: unknown) => {
    errors.push(error);
    return new Response("from error()", { status: 500 });
  };
  await using server = Bun.serve(options);
  const response = await fetch(server.url, init);
  return { status: response.status, body: await response.text(), errors };
}

const ok = (body: string) => ({ status: 200, body, errors: [] });

async function run(script: string) {
  await using proc = Bun.spawn({ cmd: [bunExe(), "-e", script], env: bunEnv, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  return { stdout, stderr, exitCode };
}

describe.each(Object.keys(kinds) as Kind[])("%s returns a promise that holds a placeholder", kind => {
  test.concurrent.each([null, undefined])("(%p) and gives the Response in then()", async placeholder => {
    const settled = () => new PlaceholderPromise(placeholder, Promise.resolve(new Response("from then()")));
    expect(await answer(kind, settled)).toEqual(ok("from then()"));
    const pending = () =>
      new PlaceholderPromise(
        placeholder,
        later(() => new Response("from then(), later")),
      );
    expect(await answer(kind, pending)).toEqual(ok("from then(), later"));
  });
});

describe("a promise that holds a placeholder", () => {
  test.concurrent("and rejects in then() reaches error()", async () => {
    const reason = new Error("rejected in then()");
    const make = () => new PlaceholderPromise<Response>(null, Promise.reject(reason));
    expect(await answer("fetch", make)).toEqual({ status: 500, body: "from error()", errors: [reason] });
  });

  // error() was called for an error. What it returns gives no Response: the default page for
  // that error is the answer, and the error is reported.
  test.concurrent("from error(), and gives no Response in then()", async () => {
    const { stdout, stderr, exitCode } = await run(`
      class Placeholder extends Promise {
        constructor() { super(resolve => resolve(null)); }
        then(onFulfilled, onRejected) { return Promise.resolve("not a Response").then(onFulfilled, onRejected); }
      }
      let errorCalls = 0;
      const server = Bun.serve({
        port: 0,
        development: false,
        fetch() { throw new Error("thrown by fetch"); },
        error() { errorCalls++; return new Placeholder(); },
      });
      const response = await fetch(server.url);
      const body = await response.text();
      await server.stop(true);
      console.log(response.status, body, errorCalls);
    `);
    expect(stderr).toContain("thrown by fetch");
    expect({ stdout, exitCode }).toEqual({ stdout: "500 Something went wrong! 1\n", exitCode: 1 });
  });
});

// The state of these promises is the answer, as in Bun 1.4.3: then() is not called.
describe("a promise is read by its state", () => {
  const rows: Record<string, () => unknown> = {
    "a subclass that inherits then(), fulfilled": () => Eager.resolve(new Response("ok")),
    "a subclass that inherits then(), pending": () =>
      new Eager<Response>(resolve => setImmediate(() => resolve(new Response("ok")))),
    "a subclass whose constructor drops the executor, fulfilled": () => {
      const deferred = new Deferred<Response>();
      deferred.resolve(new Response("ok"));
      return deferred;
    },
    "a subclass whose constructor drops the executor, pending": () => {
      const deferred = new Deferred<Response>();
      setImmediate(() => deferred.resolve(new Response("ok")));
      return deferred;
    },
    "a promise of another realm, fulfilled": () => vm.runInNewContext("Promise").resolve(new Response("ok")),
    "a promise of another realm, pending": () =>
      vm.runInNewContext("(later, value) => new Promise(resolve => later(() => resolve(value)))")(
        setImmediate,
        new Response("ok"),
      ),
    "a promise with own properties, pending": () =>
      Object.assign(
        later(() => new Response("ok")),
        { json: () => {}, text: () => {} },
      ),
  };
  describe.each(["fetch", "error()"] as Kind[])("from %s", kind => {
    test.concurrent.each(Object.keys(rows))("%s", async row => {
      expect(await answer(kind, rows[row])).toEqual(ok("ok"));
    });

    test.concurrent("a subclass with its own then() that already holds a Response", async () => {
      let thenCalls = 0;
      class Counting extends Promise<Response> {
        then(onFulfilled?: any, onRejected?: any): any {
          thenCalls++;
          return super.then(onFulfilled, onRejected);
        }
      }
      expect(await answer(kind, () => Counting.resolve(new Response("ok")))).toEqual(ok("ok"));
      expect(thenCalls).toBe(0);
    });
  });

  test.concurrent("a replaced Promise.prototype.then is not called", async () => {
    const { stdout, stderr, exitCode } = await run(`
      const then = Promise.prototype.then;
      let calls = 0;
      Promise.prototype.then = function (onFulfilled, onRejected) {
        calls++;
        return then.call(this, onFulfilled, onRejected);
      };
      const server = Bun.serve({
        port: 0,
        fetch: () => new Promise(resolve => setImmediate(() => resolve(new Response("ok")))),
      });
      const response = await fetch(server.url);
      const body = await response.text();
      const seen = calls;
      await server.stop(true);
      console.log(response.status, body, seen);
    `);
    expect({ stdout, stderr, exitCode }).toEqual({ stdout: "200 ok 0\n", stderr: "", exitCode: 0 });
  });
});
