import { describe, expect, test } from "bun:test";
import { bunEnv, bunExe } from "harness";
import vm from "node:vm";

// A promise has its own then() when `then` is a function or an accessor on the promise or on a
// class of it. The state of such a promise is not its answer. Bun.serve reads `then` once and
// calls it once, with a resolve and a reject function.

/** Fulfilled at once with a placeholder, and then() delivers: an SDK's `APIPromise` (null), p-lazy (undefined). */
class PlaceholderPromise<T> extends Promise<T> {
  #inner: Promise<T>;
  constructor(placeholder: unknown, inner: Promise<T>) {
    super(resolve => resolve(placeholder as any));
    this.#inner = inner;
  }
  then(onFulfilled?: any, onRejected?: any): any {
    return this.#inner.then(onFulfilled, onRejected);
  }
}

const OtherPromise: PromiseConstructor = vm.runInNewContext("Promise");

const later = <T>(value: () => T) => new Promise<T>(resolve => setImmediate(() => resolve(value())));

type Make = (req: Request, server: Bun.Server<undefined>) => unknown;

const kinds = {
  "fetch": (make: Make) => ({ fetch: make }),
  "a routes function": (make: Make) => ({ routes: { "/": make } }),
  "a routes method object": (make: Make) => ({ routes: { "/": { GET: make } } }),
};
type Kind = keyof typeof kinds;

/** One request to a server whose handler returns `make()`. `errors`: what reached error(). */
async function answer(kind: Kind, make: Make, init?: RequestInit) {
  const errors: unknown[] = [];
  await using server = Bun.serve({
    port: 0,
    development: false,
    ...kinds[kind](make),
    error(error: unknown) {
      errors.push(error);
      return new Response("from error()", { status: 500 });
    },
  } as any);
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
  test.concurrent.each([null, undefined, 0, {}])("(%p) and gives the Response in then()", async placeholder => {
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

  test.concurrent("and gives no Response in then() gets the diagnostic", async () => {
    const { stdout, stderr, exitCode } = await run(`
      class Placeholder extends Promise {
        constructor() { super(resolve => resolve(null)); }
        then(onFulfilled, onRejected) { return Promise.resolve("not a Response").then(onFulfilled, onRejected); }
      }
      const server = Bun.serve({ port: 0, development: false, fetch: () => new Placeholder() });
      const response = await fetch(server.url);
      await server.stop(true);
      console.log(response.status);
    `);
    expect(stderr).toContain(`Expected a Response object, but received '"not a Response"'`);
    expect({ stdout, exitCode }).toEqual({ stdout: "204\n", exitCode: 0 });
  });
});

// What error() returns is read by its state, as in Bun 1.4.3.
describe("error() returns a promise with its own then()", () => {
  test.concurrent("that holds a placeholder: the default page for the error", async () => {
    const { stdout, stderr, exitCode } = await run(`
      let thenCalls = 0;
      class Placeholder extends Promise {
        constructor() { super(resolve => resolve(null)); }
        then(onFulfilled, onRejected) { thenCalls++; return Promise.resolve(new Response("unused")).then(onFulfilled, onRejected); }
      }
      const server = Bun.serve({
        port: 0,
        development: false,
        fetch() { throw new Error("thrown by fetch"); },
        error: () => new Placeholder(),
      });
      const response = await fetch(server.url);
      const body = await response.text();
      await server.stop(true);
      console.log(response.status, body, thenCalls);
    `);
    expect(stderr).toContain("thrown by fetch");
    expect({ stdout, exitCode }).toEqual({ stdout: "500 Something went wrong! 0\n", exitCode: 1 });
  });

  test.concurrent("that holds a Response: that Response", async () => {
    let thenCalls = 0;
    class Counting extends Promise<Response> {
      then(onFulfilled?: any, onRejected?: any): any {
        thenCalls++;
        return super.then(onFulfilled, onRejected);
      }
    }
    await using server = Bun.serve({
      port: 0,
      development: false,
      fetch() {
        throw new Error("thrown by fetch");
      },
      error: () => Counting.resolve(new Response("from the state")),
    });
    const response = await fetch(server.url);
    expect({ status: response.status, body: await response.text(), thenCalls }).toEqual({
      status: 200,
      body: "from the state",
      thenCalls: 0,
    });
  });
});

// The state of these promises is the answer, as in Bun 1.4.3: no then() is called.
describe("a promise is read by its state", () => {
  // `made` counts the promises of a class. A call of the then() it inherits makes one more.
  const rows: Record<string, () => { value: unknown; thenCalls: () => number }> = {
    "a subclass that inherits then()": () => {
      let made = 0;
      class Eager<T> extends Promise<T> {
        constructor(executor: ConstructorParameters<typeof Promise<T>>[0]) {
          made++;
          super(executor);
        }
      }
      return {
        value: new Eager<Response>(resolve => setImmediate(() => resolve(new Response("ok")))),
        thenCalls: () => made - 1,
      };
    },
    "a subclass of a subclass that inherits then()": () => {
      let made = 0;
      class Eager<T> extends Promise<T> {}
      class Eagerer<T> extends Eager<T> {
        constructor(executor: ConstructorParameters<typeof Promise<T>>[0]) {
          made++;
          super(executor);
        }
      }
      return {
        value: new Eagerer<Response>(resolve => setImmediate(() => resolve(new Response("ok")))),
        thenCalls: () => made - 1,
      };
    },
    "a subclass whose constructor drops the executor": () => {
      let made = 0;
      class Deferred<T> extends Promise<T> {
        resolve!: (value: T) => void;
        constructor() {
          made++;
          let resolve!: (value: T) => void;
          super(r => {
            resolve = r;
          });
          this.resolve = resolve;
        }
      }
      const deferred = new Deferred<Response>();
      setImmediate(() => deferred.resolve(new Response("ok")));
      return { value: deferred, thenCalls: () => made - 1 };
    },
    "a subclass, of this realm, of the Promise of another realm": () => {
      let made = 0;
      class Mixed<T> extends OtherPromise<T> {
        resolve!: (value: T) => void;
        constructor() {
          made++;
          let resolve!: (value: T) => void;
          super(r => {
            resolve = r;
          });
          this.resolve = resolve;
        }
      }
      const mixed = new Mixed<Response>();
      setImmediate(() => mixed.resolve(new Response("ok")));
      return { value: mixed, thenCalls: () => made - 1 };
    },
    "a subclass, of another realm, of the Promise of this realm": () => {
      const counter = { made: 0 };
      const Mixed = vm.runInNewContext(`(Base, counter) => class extends Base {
        constructor() {
          counter.made++;
          let resolve;
          super(r => { resolve = r; });
          this.resolve = resolve;
        }
      }`)(Promise, counter);
      const mixed = new Mixed();
      setImmediate(() => mixed.resolve(new Response("ok")));
      return { value: mixed, thenCalls: () => counter.made - 1 };
    },
    "a promise of another realm": () => {
      const counter = { thenCalls: 0 };
      const make = vm.runInNewContext(`(later, counter) => {
        const then = Promise.prototype.then;
        Promise.prototype.then = function (onFulfilled, onRejected) {
          counter.thenCalls++;
          return then.call(this, onFulfilled, onRejected);
        };
        return value => new Promise(resolve => later(() => resolve(value)));
      }`)(setImmediate, counter);
      return { value: make(new Response("ok")), thenCalls: () => counter.thenCalls };
    },
    "a promise with own properties": () => ({
      value: Object.assign(
        later(() => new Response("ok")),
        { json: () => {}, text: () => {} },
      ),
      thenCalls: () => 0,
    }),
    "a promise with a `then` property that is not a function": () => ({
      value: Object.assign(
        later(() => new Response("ok")),
        { then: "not a function" },
      ),
      thenCalls: () => 0,
    }),
    "a subclass with a `then` field that is not a function": () => {
      class WithField<T> extends Promise<T> {
        then: any = null;
        static get [Symbol.species]() {
          return Promise;
        }
      }
      return {
        value: new WithField<Response>(resolve => setImmediate(() => resolve(new Response("ok")))),
        thenCalls: () => 0,
      };
    },
    "a promise without a prototype": () => ({
      value: Object.setPrototypeOf(
        later(() => new Response("ok")),
        null,
      ),
      thenCalls: () => 0,
    }),
    "a subclass with its own then() that already holds a Response": () => {
      let thenCalls = 0;
      class Counting extends Promise<Response> {
        then(onFulfilled?: any, onRejected?: any): any {
          thenCalls++;
          return super.then(onFulfilled, onRejected);
        }
      }
      return { value: Counting.resolve(new Response("ok")), thenCalls: () => thenCalls };
    },
  };
  test.concurrent.each(Object.keys(rows))("%s", async name => {
    const row = rows[name]();
    expect(await answer("fetch", () => row.value)).toEqual(ok("ok"));
    expect(row.thenCalls()).toBe(0);
  });

  test.concurrent("a promise whose `then` accessor gives nothing to call", async () => {
    let reads = 0;
    class NothingToCall extends Promise<Response> {
      get then() {
        reads++;
        return undefined;
      }
    }
    const make = () => new NothingToCall(resolve => setImmediate(() => resolve(new Response("ok"))));
    expect(await answer("fetch", make)).toEqual(ok("ok"));
    expect(reads).toBeLessThanOrEqual(1);
  });

  test.concurrent("a replaced Promise.prototype.then is not called", async () => {
    const { stdout, stderr, exitCode } = await run(`
      const then = Promise.prototype.then;
      let calls = 0;
      Promise.prototype.then = function (onFulfilled, onRejected) {
        calls++;
        return then.call(this, onFulfilled, onRejected);
      };
      const pending = () => new Promise(resolve => setImmediate(() => resolve(new Response("ok"))));
      const values = {
        "a plain promise": pending,
        "a promise with own properties": () => Object.assign(pending(), { json() {}, text() {} }),
        "a promise with a then property that is not a function": () => Object.assign(pending(), { then: "not a function" }),
      };
      for (const [name, value] of Object.entries(values)) {
        const server = Bun.serve({ port: 0, fetch: value });
        const response = await fetch(server.url);
        const body = await response.text();
        console.log(name + ":", response.status, body, calls);
        await server.stop(true);
      }
    `);
    expect({ stdout, stderr, exitCode }).toEqual({
      stdout:
        "a plain promise: 200 ok 0\n" +
        "a promise with own properties: 200 ok 0\n" +
        "a promise with a then property that is not a function: 200 ok 0\n",
      stderr: "",
      exitCode: 0,
    });
  });
});
