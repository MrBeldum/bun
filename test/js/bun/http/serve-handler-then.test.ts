import { describe, expect, test } from "bun:test";
import { bunEnv, bunExe, tls } from "harness";
import { once } from "node:events";
import net from "node:net";
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

  test.concurrent("that is a plain promise with a then() of its own", async () => {
    const make = () => {
      let start!: () => void;
      const promise = new Promise<Response>(resolve => {
        start = () => resolve(new Response("own then()"));
      });
      const then = promise.then;
      promise.then = function (this: Promise<Response>, onFulfilled?: any, onRejected?: any) {
        start();
        return then.call(this, onFulfilled, onRejected);
      } as any;
      return promise;
    };
    expect(await answer(kind, make)).toEqual(ok("own then()"));
  });
});

const transports = {
  "HTTP/1.1": { serve: {}, fetch: {} },
  "HTTP/1.1 with TLS": { serve: { tls }, fetch: { tls: { rejectUnauthorized: false } } },
  "HTTP/2": { serve: { tls, http2: true }, fetch: { protocol: "http2", tls: { rejectUnauthorized: false } } },
  "HTTP/3": { serve: { tls, http3: true }, fetch: { protocol: "http3", tls: { rejectUnauthorized: false } } },
};

describe.each(Object.keys(transports) as (keyof typeof transports)[])("over %s", transport => {
  test.concurrent.each([false, true])(
    "a pending promise with its own then() answers (development: %p)",
    async development => {
      await using server = Bun.serve({
        port: 0,
        development,
        ...transports[transport].serve,
        fetch: () => new LazyPromise<Response>(resolve => resolve(new Response("lazy"))),
      } as any);
      const response = await fetch(server.url, transports[transport].fetch as RequestInit);
      expect({ status: response.status, body: await response.text() }).toEqual({ status: 200, body: "lazy" });
    },
  );
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

  test.concurrent("is asked through a Proxy in its prototype chain", async () => {
    let reads = 0;
    const prototype = new Proxy(Promise.prototype, {
      get(target, key, receiver) {
        if (key === "then") reads++;
        return Reflect.get(target, key, receiver);
      },
    });
    const make = () =>
      Object.setPrototypeOf(
        later(() => new Response("through the Proxy")),
        prototype,
      );
    expect(await answer("fetch", make)).toEqual(ok("through the Proxy"));
    expect(reads).toBe(1);
  });

  test.concurrent("answers a HEAD request", async () => {
    const make = () => new LazyPromise<Response>(resolve => resolve(new Response("lazy")));
    expect(await answer("fetch", make, { method: "HEAD" })).toEqual(ok(""));
    expect(await answer("a routes method object", make, { method: "HEAD" })).toEqual(ok(""));
  });

  test.concurrent("answers two requests that arrive in one write", async () => {
    await using server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: req => new LazyPromise<Response>(resolve => resolve(new Response(new URL(req.url).pathname))),
    });
    const { promise, resolve, reject } = Promise.withResolvers<string>();
    let reply = "";
    const get = (path: string) => `GET ${path} HTTP/1.1\r\nHost: x\r\n\r\n`;
    const socket = net.connect(server.port, "127.0.0.1", () => socket.write(get("/first") + get("/second")));
    socket.on("data", chunk => {
      reply += chunk.toString("latin1");
      if (reply.endsWith("/second")) socket.destroy();
    });
    socket.on("error", reject);
    socket.on("close", () => resolve(reply));
    const bodies = (await promise)
      .split(/HTTP\/1\.1 /)
      .map(part => part.slice(0, 6) + part.slice(part.indexOf("\r\n\r\n") + 4));
    expect(bodies).toEqual(["", "200 OK/first", "200 OK/second"]);
  });

  test.concurrent("that rejects reaches error()", async () => {
    const reason = new Error("rejected in then()");
    const lazy = new LazyPromise<Response>((_, reject) => reject(reason));
    expect(await answer("fetch", () => lazy)).toEqual({ status: 500, body: "from error()", errors: [reason] });
    expect(lazy.thenCalls).toBe(1);
  });

  // The next five answer from the state of the promise in Bun 1.4.3. They now get the answer of
  // the same handler with `async` in front, which asks then() too.
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

  test.concurrent("whose `then` accessor throws reaches error()", async () => {
    const thrown = new Error("thrown by the accessor");
    class Throws extends Promise<Response> {
      get then(): any {
        throw thrown;
      }
    }
    const make = () => new Throws(resolve => setImmediate(() => resolve(new Response("unused"))));
    expect(await answer("fetch", make)).toEqual({ status: 500, body: "from error()", errors: [thrown] });
  });

  test.concurrent("whose then() cannot construct its result reaches error()", async () => {
    class DeferredWithThen<T> extends Promise<T> {
      resolve!: (value: T) => void;
      constructor() {
        let resolve!: (value: T) => void;
        super(r => {
          resolve = r;
        });
        this.resolve = resolve;
      }
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

  test.concurrent("whose then() does not pass a rejection on leaves it unhandled", async () => {
    const { stdout, stderr, exitCode } = await run(`
      const reported = Promise.withResolvers();
      process.on("unhandledRejection", reason => reported.resolve(reason.message));
      class DropsReject extends Promise {
        then(onFulfilled) { return super.then(onFulfilled); }
      }
      let errorCalls = 0;
      const server = Bun.serve({
        port: 0,
        development: false,
        idleTimeout: 0,
        fetch: () => new DropsReject((resolve, reject) => setImmediate(() => reject(new Error("not passed on")))),
        error() { errorCalls++; return new Response("from error()", { status: 500 }); },
      });
      const controller = new AbortController();
      const response = fetch(server.url, { signal: controller.signal }).then(response => response.status, error => error.name);
      const reason = await reported.promise;
      controller.abort();
      console.log(reason + ", error() calls: " + errorCalls + ", client: " + (await response));
      await server.stop(true);
    `);
    expect({ stdout, stderr, exitCode }).toEqual({
      stdout: "not passed on, error() calls: 0, client: AbortError\n",
      stderr: "",
      exitCode: 0,
    });
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

  test.concurrent.each(["then()", "the `then` accessor"])("%s can stop the server", async where => {
    let stoppedBy = "";
    await using server = Bun.serve({
      port: 0,
      idleTimeout: 0,
      fetch() {
        const stop = () => {
          stoppedBy = where;
          server.stop(true);
        };
        if (where === "then()") {
          return new LazyPromise<Response>(resolve => {
            stop();
            resolve(new Response("unused"));
          });
        }
        class Stops extends Promise<Response> {
          get then() {
            stop();
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
    expect(stoppedBy).toBe(where);
    expect(server.pendingRequests).toBe(0);
  });

  test.concurrent("a client that leaves while then() has not reported is released", async () => {
    const { promise: started, resolve: onStart } = Promise.withResolvers<void>();
    await using server = Bun.serve({
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
});
