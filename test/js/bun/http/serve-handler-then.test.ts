import { describe, expect, test } from "bun:test";
import { bunEnv, bunExe, tls } from "harness";
import { once } from "node:events";
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

type Work<T> = (resolve: (value: T) => void, reject: (reason: unknown) => void) => void;

/** Starts its work in then(), like `Bun.$` and a `Bun.SQL` query. The work settles the promise itself. */
class LazyPromise<T> extends Promise<T> {
  thenCalls = 0;
  #start: () => void;
  constructor(work: Work<T>) {
    let start!: () => void;
    super((resolve, reject) => {
      start = () => work(resolve, reject);
    });
    this.#start = start;
  }
  then(onFulfilled?: any, onRejected?: any): any {
    if (this.thenCalls++ === 0) this.#start();
    return super.then(onFulfilled, onRejected);
  }
  static get [Symbol.species]() {
    return Promise;
  }
}

/** Never settles itself: only then() delivers. */
class ForwardingPromise<T> extends Promise<T> {
  #work: Work<T>;
  #inner: Promise<T> | undefined;
  constructor(work: Work<T>) {
    super(() => {});
    this.#work = work;
  }
  then(onFulfilled?: any, onRejected?: any): any {
    return (this.#inner ??= new Promise(this.#work)).then(onFulfilled, onRejected);
  }
}

describe.each(Object.keys(kinds) as Kind[])("%s returns a pending promise with its own then()", kind => {
  test.concurrent("that starts its work in then()", async () => {
    const lazy = new LazyPromise<Response>(resolve => resolve(new Response("lazy")));
    expect(await answer(kind, () => lazy)).toEqual(ok("lazy"));
    expect(lazy.thenCalls).toBe(1);
  });

  test.concurrent("that starts its work in then() and settles later", async () => {
    const lazy = new LazyPromise<Response>(resolve => setImmediate(() => resolve(new Response("lazy, later"))));
    expect(await answer(kind, () => lazy)).toEqual(ok("lazy, later"));
    expect(lazy.thenCalls).toBe(1);
  });

  test.concurrent("that never settles itself", async () => {
    const make = () => new ForwardingPromise<Response>(resolve => resolve(new Response("forwarded")));
    expect(await answer(kind, make)).toEqual(ok("forwarded"));
  });

  test.concurrent("of another realm", async () => {
    const OtherLazy = vm.runInNewContext(`(class extends Promise {
      #start;
      constructor(work) {
        let start;
        super(resolve => { start = () => work(resolve); });
        this.#start = start;
      }
      then(onFulfilled, onRejected) {
        this.#start();
        return super.then(onFulfilled, onRejected);
      }
      static get [Symbol.species]() { return Promise; }
    })`);
    const make = () => new OtherLazy((resolve: (value: Response) => void) => resolve(new Response("other realm")));
    expect(await answer(kind, make)).toEqual(ok("other realm"));
  });
});

describe("a pending promise with its own then()", () => {
  test.concurrent("gets `then` read once and then() called once, with two functions", async () => {
    const log: string[] = [];
    class Spy extends Promise<Response> {
      get then() {
        log.push("get then");
        return (...args: unknown[]) => {
          log.push(`then(${args.map(arg => typeof arg).join(", ")})`);
          (args[0] as (value: Response) => void)(new Response("spied"));
        };
      }
    }
    expect(await answer("fetch", () => new Spy(() => {}))).toEqual(ok("spied"));
    expect(log).toEqual(["get then", "then(function, function)"]);
  });

  test.concurrent("answers a HEAD request", async () => {
    const make = () => new LazyPromise<Response>(resolve => resolve(new Response("lazy")));
    expect(await answer("fetch", make, { method: "HEAD" })).toEqual(ok(""));
    expect(await answer("a routes method object", make, { method: "HEAD" })).toEqual(ok(""));
  });

  test.concurrent("answers over HTTP/2", async () => {
    await using server = Bun.serve({
      port: 0,
      tls,
      http2: true,
      fetch: () => new LazyPromise<Response>(resolve => resolve(new Response("lazy"))),
    });
    const response = await fetch(server.url, { protocol: "http2", tls: { rejectUnauthorized: false } });
    expect({ status: response.status, body: await response.text() }).toEqual({ status: 200, body: "lazy" });
  });

  test.concurrent("is followed when error() returns it for a rejection that arrives later", async () => {
    await using server = Bun.serve({
      port: 0,
      development: false,
      fetch: () => later(() => Promise.reject(new Error("rejected later"))),
      error: () => new LazyPromise<Response>(resolve => resolve(new Response("lazy from error()"))),
    });
    const response = await fetch(server.url);
    expect({ status: response.status, body: await response.text() }).toEqual({
      status: 200,
      body: "lazy from error()",
    });
  });

  test.concurrent("that rejects reaches error()", async () => {
    const reason = new Error("rejected in then()");
    const lazy = new LazyPromise<Response>((_, reject) => reject(reason));
    expect(await answer("fetch", () => lazy)).toEqual({ status: 500, body: "from error()", errors: [reason] });
    expect(lazy.thenCalls).toBe(1);
  });

  // The next four answer 200 from the state of the promise in Bun 1.4.3. They now get the answer
  // of the same handler with `async` in front: `await` calls then() too.
  test.concurrent("whose then() throws reaches error()", async () => {
    const thrown = new Error("thrown by then()");
    class Throws extends Promise<Response> {
      then(): any {
        throw thrown;
      }
    }
    const make = () => new Throws(resolve => setImmediate(() => resolve(new Response("unused"))));
    expect(await answer("fetch", make)).toEqual({ status: 500, body: "from error()", errors: [thrown] });
  });

  test.concurrent("whose `then` getter throws reaches error()", async () => {
    const thrown = new Error("thrown by the getter");
    class Throws extends Promise<Response> {
      get then(): any {
        throw thrown;
      }
    }
    const make = () => new Throws(resolve => setImmediate(() => resolve(new Response("unused"))));
    expect(await answer("fetch", make)).toEqual({ status: 500, body: "from error()", errors: [thrown] });
  });

  test.concurrent("whose then() cannot construct its result reaches error()", async () => {
    class DeferredWithThen<T> extends Deferred<T> {
      then(onFulfilled?: any, onRejected?: any): any {
        return super.then(onFulfilled, onRejected);
      }
    }
    const make = () => {
      const deferred = new DeferredWithThen<Response>();
      setImmediate(() => deferred.resolve(new Response("unused")));
      return deferred;
    };
    expect(await answer("fetch", make)).toEqual({
      status: 500,
      body: "from error()",
      errors: [expect.any(TypeError)],
    });
  });

  test.concurrent("is answered by what then() reports, not by what settles it", async () => {
    class Mapping extends Promise<Response> {
      then(onFulfilled?: any, onRejected?: any): any {
        return super.then(() => new Response("from then()")).then(onFulfilled, onRejected);
      }
      static get [Symbol.species]() {
        return Promise;
      }
    }
    const make = () => new Mapping(resolve => setImmediate(() => resolve(new Response("from the state"))));
    expect(await answer("fetch", make)).toEqual(ok("from then()"));
  });
});

describe("a request that is gone", () => {
  test.concurrent("after server.upgrade(), then() is not called", async () => {
    const lazy = new LazyPromise<Response>(resolve => resolve(new Response("unused")));
    await using server = Bun.serve({
      port: 0,
      fetch(req, server) {
        server.upgrade(req);
        return lazy;
      },
      websocket: {
        open(ws) {
          ws.close();
        },
        message() {},
      },
    });
    const ws = new WebSocket(server.url.href.replace("http", "ws"));
    await once(ws, "close");
    expect(lazy.thenCalls).toBe(0);
  });

  test.concurrent("a then() that upgrades the request opens the WebSocket", async () => {
    await using server = Bun.serve({
      port: 0,
      fetch(req, server) {
        return new LazyPromise<Response>(resolve => {
          server.upgrade(req);
          resolve(new Response("unused"));
        });
      },
      websocket: {
        open(ws) {
          ws.send("upgraded in then()");
        },
        message() {},
      },
    });
    const ws = new WebSocket(server.url.href.replace("http", "ws"));
    const [message] = await once(ws, "message");
    expect(message.data).toBe("upgraded in then()");
    ws.close();
  });

  test.concurrent("a then() that upgrades the request and then rejects is reported", async () => {
    const { stdout, stderr, exitCode } = await run(`
      const reported = Promise.withResolvers();
      process.on("unhandledRejection", reason => reported.resolve(reason.message));
      class Lazy extends Promise {
        #start;
        constructor(work) {
          let start;
          super((resolve, reject) => { start = () => work(resolve, reject); });
          this.#start = start;
        }
        then(onFulfilled, onRejected) {
          this.#start();
          return super.then(onFulfilled, onRejected);
        }
        static get [Symbol.species]() { return Promise; }
      }
      const server = Bun.serve({
        port: 0,
        fetch: (req, server) =>
          new Lazy((resolve, reject) => {
            server.upgrade(req);
            reject(new Error("rejected after the upgrade"));
          }),
        websocket: {
          open(ws) { ws.send("open"); },
          message() {},
        },
      });
      const ws = new WebSocket(server.url.href.replace("http", "ws"));
      const opened = await new Promise(resolve => { ws.onmessage = event => resolve(event.data); });
      console.log(opened + ", " + (await reported.promise));
      ws.close();
      await server.stop(true);
    `);
    expect({ stdout, stderr, exitCode }).toEqual({
      stdout: "open, rejected after the upgrade\n",
      stderr: "",
      exitCode: 0,
    });
  });

  test.concurrent.each(["then()", "the `then` getter"])("%s can stop the server", async where => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        if (where === "then()") {
          return new LazyPromise<Response>(resolve => {
            server.stop(true);
            resolve(new Response("unused"));
          });
        }
        class Stops extends Promise<Response> {
          get then() {
            server.stop(true);
            return undefined;
          }
        }
        return new Stops(() => {});
      },
    });
    expect(
      await fetch(server.url).then(
        response => response.status,
        () => "closed",
      ),
    ).toBe("closed");
    expect(server.pendingRequests).toBe(0);
  });

  test.concurrent("a client that leaves while then() has not reported is released", async () => {
    const { promise: started, resolve: onStart } = Promise.withResolvers<void>();
    const server = Bun.serve({
      port: 0,
      idleTimeout: 0,
      fetch: () => new LazyPromise<Response>(() => onStart()),
    });
    const controller = new AbortController();
    const response = fetch(server.url, { signal: controller.signal });
    await started;
    controller.abort();
    expect(await response.catch(error => error.name)).toBe("AbortError");
    // Resolves only once no request is pending.
    await server.stop();
    expect(server.pendingRequests).toBe(0);
  });
});

describe("a pending promise with its own then() that gives no Response", () => {
  test.concurrent("Bun.$ returned by mistake runs and gets the diagnostic", async () => {
    const { stdout, stderr, exitCode } = await run(`
      const server = Bun.serve({ port: 0, development: false, fetch: () => Bun.$\`echo ran\`.quiet() });
      const response = await fetch(server.url);
      await server.stop(true);
      console.log(response.status);
    `);
    expect(stderr).toContain("Expected a Response object, but received");
    expect({ stdout, exitCode }).toEqual({ stdout: "204\n", exitCode: 0 });
  });

  // As for a placeholder above: the default page for the error that error() was called for.
  test.concurrent("from error()", async () => {
    const { stdout, stderr, exitCode } = await run(`
      class Lazy extends Promise {
        #start;
        constructor(work) {
          let start;
          super((resolve, reject) => { start = () => work(resolve, reject); });
          this.#start = start;
        }
        then(onFulfilled, onRejected) {
          this.#start();
          return super.then(onFulfilled, onRejected);
        }
        static get [Symbol.species]() { return Promise; }
      }
      const values = {
        "gives something else": () => new Lazy(resolve => resolve("not a Response")),
        "rejects": () => new Lazy((resolve, reject) => reject(new Error("rejected in then()"))),
      };
      for (const [name, value] of Object.entries(values)) {
        let errorCalls = 0;
        const server = Bun.serve({
          port: 0,
          development: false,
          fetch() { throw new Error("thrown by fetch for: " + name); },
          error() { errorCalls++; return value(); },
        });
        const response = await fetch(server.url);
        console.log(name + ":", response.status, await response.text(), errorCalls);
        await server.stop(true);
      }
    `);
    expect(stderr).toContain("thrown by fetch for: gives something else");
    expect(stderr).toContain("rejected in then()");
    expect({ stdout, exitCode }).toEqual({
      stdout: "gives something else: 500 Something went wrong! 1\nrejects: 500 Something went wrong! 1\n",
      exitCode: 1,
    });
  });
});

// A thenable is an object that is not a promise and has a then(): a promise of a library that
// replaces `Promise` (zone.js, Bluebird), a query builder.
describe.each(Object.keys(kinds) as Kind[])("%s returns a thenable", kind => {
  test.concurrent("that reports in then()", async () => {
    const thenable = { then: (resolve: (value: Response) => void) => resolve(new Response("thenable")) };
    expect(await answer(kind, () => thenable)).toEqual(ok("thenable"));
  });

  test.concurrent("that reports later", async () => {
    const thenable = {
      then: (resolve: (value: Response) => void) => void setImmediate(() => resolve(new Response("thenable, later"))),
    };
    expect(await answer(kind, () => thenable)).toEqual(ok("thenable, later"));
  });
});

describe("a thenable", () => {
  test.concurrent("gets `then` read once and then() called once, with two functions", async () => {
    const log: string[] = [];
    const thenable = {
      get then() {
        log.push("get then");
        return (...args: unknown[]) => {
          log.push(`then(${args.map(arg => typeof arg).join(", ")})`);
          (args[0] as (value: Response) => void)(new Response("spied"));
        };
      },
    };
    expect(await answer("fetch", () => thenable)).toEqual(ok("spied"));
    expect(log).toEqual(["get then", "then(function, function)"]);
  });

  test.concurrent("is followed to the thenable it reports", async () => {
    const inner = { then: (resolve: (value: Response) => void) => resolve(new Response("inner")) };
    const outer = { then: (resolve: (value: unknown) => void) => resolve(inner) };
    expect(await answer("fetch", () => outer)).toEqual(ok("inner"));
  });

  test.concurrent("is answered by its first report", async () => {
    const thenable = {
      then(resolve: (value: Response) => void, reject: (reason: unknown) => void) {
        resolve(new Response("first"));
        resolve(new Response("second"));
        reject(new Error("third"));
      },
    };
    expect(await answer("fetch", () => thenable)).toEqual(ok("first"));
  });

  test.concurrent("that rejects reaches error()", async () => {
    const reason = new Error("rejected by then()");
    const thenable = { then: (_: unknown, reject: (reason: unknown) => void) => reject(reason) };
    expect(await answer("fetch", () => thenable)).toEqual({ status: 500, body: "from error()", errors: [reason] });
  });

  test.concurrent("whose then() throws reaches error()", async () => {
    const thrown = new Error("thrown by then()");
    const thenable = {
      then() {
        throw thrown;
      },
    };
    expect(await answer("fetch", () => thenable)).toEqual({ status: 500, body: "from error()", errors: [thrown] });
  });

  test.concurrent("that never reports holds the request until the client leaves", async () => {
    const { promise: called, resolve: onCall } = Promise.withResolvers<void>();
    const server = Bun.serve({ port: 0, idleTimeout: 0, fetch: () => ({ then: () => onCall() }) as any });
    const controller = new AbortController();
    const response = fetch(server.url, { signal: controller.signal });
    await called;
    controller.abort();
    expect(await response.catch(error => error.name)).toBe("AbortError");
    await server.stop();
    expect(server.pendingRequests).toBe(0);
  });

  test.concurrent("a value without a then() to call still gets the diagnostic", async () => {
    const { stdout, stderr, exitCode } = await run(`
      const statuses = [];
      for (const value of [{ forgot: "new Response" }, { then: "not a function" }, [], "a string", 42]) {
        const server = Bun.serve({ port: 0, development: false, fetch: () => value });
        statuses.push((await fetch(server.url)).status);
        await server.stop(true);
      }
      console.log(JSON.stringify(statuses));
    `);
    expect(stderr.match(/Expected a Response object, but received/g)).toHaveLength(5);
    expect({ stdout, exitCode }).toEqual({ stdout: "[204,204,204,204,204]\n", exitCode: 0 });
  });
});
