// A chunked request body can cross maxRequestBodySize after the handler has
// answered. A request with no status written gets `413 Payload Too Large`. A
// response in flight cannot take its status back. It used to be ended as if it
// were complete: `Connection: close` and a blank line, then `Date` and
// `Transfer-Encoding` lines after that blank line, and a terminating chunk
// after whatever body was out. Now it gets what a failed body gets: no more
// bytes and a reset. The handler hears it in this order: `req.signal` aborts,
// a pending read of the request body rejects with the limit error, and the
// producer of the response body is cancelled.
import { describe, expect, test } from "bun:test";
import { bunEnv, bunExe, isWindows, tls as tlsCert } from "harness";
import { EventEmitter, once } from "node:events";
import net from "node:net";
import { join } from "node:path";
import { baseHeaders, F, frame, RawH2, T } from "./serve-http2-helpers";
import { END_OF_STATUS_LINE, get, LIMIT, released, upload, type Upload } from "./serve-response-in-flight-fixture";

const never = () => new Promise<never>(() => {});

type Context = {
  // Records what the handler heard, in order.
  heard: (what: string) => (reason?: unknown) => void;
  // Resolves when the client's connection has closed.
  clientClosed: Promise<void>;
  // The row's result waits for these.
  waitFor: Promise<unknown>[];
  server: import("bun").Server<undefined>;
};

type Row = Upload & {
  respond(req: Request, ctx: Context): Response | Promise<Response>;
  expected: Record<string, unknown>;
};

const aborted = "AbortError: The connection was closed.";
const tooLarge = "Error: Request body exceeded maxRequestBodySize";

// The outcomes. `heard` starts with the abort of `req.signal`.
const answered413 = (...heard: string[]) => ({
  statusLine: "HTTP/1.1 413 Payload Too Large",
  headersEnded: true,
  body: "",
  closed: "fin",
  heard: ["abort", ...heard],
  errorCb: 0,
  pendingRequests: 0,
  next: "HTTP/1.1 200 OK",
});
const resetBeforeBody = (...heard: string[]) => ({
  statusLine: "HTTP/1.1 200 OK",
  // Whether the header section ended is not the point: no body, no terminating chunk.
  headersEnded: expect.any(Boolean),
  body: "",
  closed: "reset",
  heard: ["abort", ...heard],
  errorCb: 0,
  pendingRequests: 0,
  next: "HTTP/1.1 200 OK",
});
const resetAfterChunk = (...heard: string[]) => ({
  ...resetBeforeBody(...heard),
  headersEnded: true,
  body: "7\r\nchunk-a\r\n",
});

// Three producers, each parked before its first chunk or right after it.
const producers: Record<string, { body(ctx: Context, chunk: boolean): any; heard: string[]; later: string[] }> = {
  "a default stream": {
    body: ({ heard }, chunk) =>
      new ReadableStream({
        pull(c) {
          if (chunk) c.enqueue("chunk-a");
          return never();
        },
        cancel: heard("cancel"),
      }),
    heard: [`cancel:${aborted}`],
    later: [],
  },
  "a direct stream": {
    body: ({ heard }, chunk) =>
      new ReadableStream({
        type: "direct",
        async pull(c: any) {
          if (chunk) {
            c.write("chunk-a");
            await c.flush();
          }
          await never();
        },
        cancel: heard("cancel"),
      } as any),
    heard: [`cancel:${aborted}`],
    later: [],
  },
  // A generator cannot be interrupted inside an `await`. It waits for the
  // client to see the close and then yields: a return() that the server
  // queued takes effect there, and the generator body does not continue. That
  // takes microtasks only, so one turn of the event loop is enough to see it.
  "an async generator": {
    body({ heard, clientClosed, waitFor }, chunk) {
      waitFor.push(clientClosed.then(() => new Promise(resolve => setImmediate(resolve))));
      return (async function* () {
        try {
          if (chunk) yield "chunk-a";
          await clientClosed;
          yield "late";
          heard("generator")("continued");
        } finally {
          heard("generator")("finally");
        }
      })();
    },
    heard: [],
    later: ["generator:finally"],
  },
};

// The handler reads the request body as a stream.
function readBody(req: Request, { heard }: Context) {
  const reader = req.body!.getReader();
  (async () => {
    while (!(await reader.read()).done);
  })().catch(heard("read"));
  return reader;
}

// An upstream that answers with `firstWrite` and then stays silent.
async function fetchFromSilentUpstream(firstWrite: string, { heard, server, clientClosed, waitFor }: Context) {
  const closed = Promise.withResolvers<void>();
  const upstream = net.createServer(socket => {
    socket.resume();
    socket.on("error", () => {});
    socket.on("close", () => {
      heard("upstream")("closed");
      upstream.close();
      closed.resolve();
    });
    socket.write(firstWrite);
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  // A request that the server released has let go of its upstream too. A
  // request that is still pending never does, so there is nothing to wait for.
  waitFor.push(clientClosed.then(() => (server.pendingRequests === 0 ? closed.promise : undefined)));
  return fetch(`http://127.0.0.1:${(upstream.address() as net.AddressInfo).port}/`);
}

const rewrite = (req: Request) =>
  new HTMLRewriter()
    .on("p", { element() {} })
    .transform(new Response(req.body, { headers: { "content-type": "text/html" } }));

// Reports how the request body stream ended: it feeds the response natively, so nothing else reads it.
const watched =
  (respond: (req: Request) => Response): Row["respond"] =>
  (req, { heard, clientClosed, waitFor }) => {
    const stream = req.body!;
    waitFor.push(clientClosed.then(() => heard("req.body")(/state: '(\w+)'/.exec(Bun.inspect(stream))?.[1])));
    return respond(req);
  };

const rows: Record<string, Row> = {
  // No status written: the 413, as before.
  "the handler has not answered": { marker: null, respond: never, expected: answered413() },
  // The server has answered for the handler: its wait on `req.signal` ends.
  "the handler waits on req.signal": {
    marker: null,
    async respond(req, { heard }) {
      const emitter = new EventEmitter();
      await once(emitter, "message", { signal: req.signal }).catch(e => {
        heard("wait")(`${e.name}, ${emitter.listenerCount("message")} listeners`);
      });
      return new Response("late");
    },
    expected: answered413("wait:AbortError, 0 listeners"),
  },
  // An HTMLRewriter body holds its status back until its first chunk. This
  // one used to reach error(), which answered on a connection that stayed open.
  "an HTMLRewriter over the request body has written nothing": {
    marker: null,
    respond: rewrite,
    expected: answered413(),
  },
  // This one got the 413 before, but its request stayed pending for ever.
  "an HTMLRewriter over another stream has written nothing": {
    marker: null,
    respond: (req, { heard }) =>
      new HTMLRewriter()
        .on("p", { element() {} })
        .transform(new Response(new ReadableStream({ pull: never, cancel: heard("cancel") }))),
    expected: answered413("cancel:AbortError: The operation was aborted."),
  },
};

// A response in flight whose body does not come from the request. The handler
// either leaves the request body alone or reads it as a stream: the limit is
// checked in a different place for each.
for (const [producer, { body, heard, later }] of Object.entries(producers)) {
  for (const chunk of [false, true]) {
    for (const reads of [false, true]) {
      const phase = chunk ? "has written a chunk" : "has written nothing";
      rows[`${producer} ${phase}${reads ? ", the handler reads req.body" : ""}`] = {
        marker: chunk ? "chunk-a" : END_OF_STATUS_LINE,
        respond(req, ctx) {
          if (reads) readBody(req, ctx);
          return new Response(body(ctx, chunk));
        },
        expected: (chunk ? resetAfterChunk : resetBeforeBody)(
          ...(reads ? [`read:${tooLarge}`] : []),
          ...heard,
          ...later,
        ),
      };
    }
  }
}

Object.assign(rows, {
  "req.text() is pending": {
    marker: END_OF_STATUS_LINE,
    respond(req, ctx) {
      req.text().catch(ctx.heard("text"));
      return new Response(producers["a default stream"].body(ctx, false));
    },
    expected: resetBeforeBody(`text:${tooLarge}`, `cancel:${aborted}`),
  },
  // The status line is still in the cork buffer, so nothing reaches the client.
  "the request head and the overflow arrive in one read": {
    marker: null,
    respond: (req, ctx) => new Response(producers["a default stream"].body(ctx, false)),
    expected: { ...resetBeforeBody(`cancel:${aborted}`), statusLine: "" },
  },
  // This chunk used to go out, followed by a terminating chunk. The stream
  // still takes it, and the response does not.
  "the rejection of the body read writes another chunk": {
    marker: "chunk-a",
    respond(req, { heard }) {
      let controller!: ReadableStreamDefaultController;
      const body = new ReadableStream({
        start(c) {
          controller = c;
          c.enqueue(new TextEncoder().encode("chunk-a"));
        },
      });
      req.text().catch(() => {
        try {
          controller.enqueue(new TextEncoder().encode("late"));
          heard("enqueue")("accepted");
        } catch (e: any) {
          heard("enqueue")(e.code);
        }
      });
      return new Response(body);
    },
    expected: resetAfterChunk("enqueue:accepted"),
  },
  // cancel() runs after the connection is closed and can do anything.
  "cancel() stops the server": {
    marker: END_OF_STATUS_LINE,
    respond: (req, { heard, server }) =>
      new Response(
        new ReadableStream({
          pull: never,
          cancel(reason) {
            heard("cancel")(reason);
            server.stop(true);
          },
        }),
      ),
    expected: { ...resetBeforeBody(`cancel:${aborted}`), next: "" },
  },
  // The read has heard the limit error by then: it does not end as if the body were complete.
  "cancel() cancels the reader of the request body": {
    marker: "chunk-a",
    respond(req, ctx) {
      const reader = readBody(req, ctx);
      return new Response(
        new ReadableStream({
          pull(c) {
            c.enqueue("chunk-a");
            return never();
          },
          cancel(reason) {
            ctx.heard("cancel")(reason);
            return reader.cancel(reason);
          },
        }),
      );
    },
    expected: resetAfterChunk(`read:${tooLarge}`, `cancel:${aborted}`),
  },
  // A body that the handler cancelled still counts against the limit.
  "the handler cancelled req.body": {
    marker: "chunk-a",
    async respond(req, ctx) {
      await req.body!.cancel();
      return new Response(producers["a default stream"].body(ctx, true));
    },
    expected: resetAfterChunk(`cancel:${aborted}`),
  },

  // The request body feeds the response body: through a JS stream, natively,
  // and through an HTMLRewriter. The first one used to end as a complete,
  // empty `200 OK`.
  "req.body.pipeThrough() has written nothing": {
    marker: END_OF_STATUS_LINE,
    respond: req => new Response(req.body!.pipeThrough(new TransformStream())),
    expected: resetBeforeBody(),
  },
  "req.body.pipeThrough() has written a chunk": {
    marker: "chunk-a",
    first: "7\r\nchunk-a\r\n",
    respond: req => new Response(req.body!.pipeThrough(new TransformStream())),
    expected: resetAfterChunk(),
  },
  "new Response(req.body) has written nothing": {
    marker: END_OF_STATUS_LINE,
    respond: watched(req => new Response(req.body)),
    expected: resetBeforeBody("req.body:errored"),
  },
  "new Response(req.body) has written a chunk": {
    marker: "chunk-a",
    first: "7\r\nchunk-a\r\n",
    respond: watched(req => new Response(req.body)),
    expected: resetAfterChunk("req.body:errored"),
  },
  "an HTMLRewriter over the request body has written a chunk": {
    marker: "chunk-a",
    first: "e\r\n<b>chunk-a</b>\r\n",
    respond: watched(rewrite),
    expected: { ...resetAfterChunk("req.body:errored"), body: "e\r\n<b>chunk-a</b>\r\n" },
  },

  // A natively piped body that the request does not feed. The request used
  // to stay pending for ever, with its upstream connection.
  "a proxied fetch() body has written nothing": {
    marker: END_OF_STATUS_LINE,
    respond: (req, ctx) => fetchFromSilentUpstream("HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n", ctx),
    expected: resetBeforeBody("upstream:closed"),
  },
  "a proxied fetch() body has written a chunk": {
    marker: "chunk-a",
    respond: (req, ctx) => fetchFromSilentUpstream("HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nchunk-a", ctx),
    expected: resetAfterChunk("upstream:closed"),
  },
} satisfies Record<string, Row>);

// `held`: the client reads the response on only when the server has let the request go.
async function run(row: Row, { development = false, secure = false, held = false } = {}) {
  const heard: string[] = [];
  const clientClosed = Promise.withResolvers<void>();
  const waitFor: Promise<unknown>[] = [];
  let errorCb = 0;
  using server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    tls: secure ? tlsCert : undefined,
    development,
    maxRequestBodySize: LIMIT,
    error() {
      errorCb++;
      return new Response("err-body", { status: 500 });
    },
    fetch(req, server) {
      if (req.method === "GET") return new Response("ok");
      req.signal.addEventListener("abort", () => void heard.push("abort"));
      return row.respond(req, {
        heard: what => reason => void heard.push(`${what}:${reason}`),
        clientClosed: clientClosed.promise,
        waitFor,
        server,
      });
    },
  });
  const request = held ? { ...row, hold: true, released: () => released(server) } : row;
  const { wire, closed } = await upload(server.port!, secure, request, clientClosed.resolve);
  await Promise.all(waitFor);
  const [head, ...rest] = wire.split("\r\n\r\n");
  return {
    head,
    statusLine: head.split("\r\n")[0],
    // The blank line that ends the header section arrived.
    headersEnded: rest.length > 0,
    body: rest.join("\r\n\r\n"),
    closed,
    heard,
    errorCb,
    pendingRequests: server.pendingRequests,
    // The server still answers.
    next: await get(server.port!, secure),
    // A request that never ends keeps a graceful stop pending.
    stopped: server.stop(),
  };
}

async function expectRow(row: Row, options?: { development?: boolean; secure?: boolean }) {
  const { head, stopped, ...result } = await run(row, options);
  expect(result).toEqual(row.expected as typeof result);
  await stopped;
}

const fixture = join(import.meta.dir, "serve-response-in-flight-fixture.ts");

// Runs scenarios of the fixture in one process. Each is announced on stderr.
async function scenarios(...names: string[]) {
  await using proc = Bun.spawn({ cmd: [bunExe(), fixture, ...names], env: bunEnv, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  return { stdout: stdout && JSON.parse(stdout), stderr, exitCode };
}
const announced = (...names: string[]) => names.map(name => `# ${name}\n`).join("");

// The tests run one after the other on purpose. The rows are CPU-bound in a
// debug build, so together they finish no sooner and each one takes longer.
// The scenario processes do not all start within the default timeout of a
// test when a debug build starts five of them at once.
describe("a chunked request body crosses maxRequestBodySize", () => {
  test.each(Object.entries(rows))("%s", async (_name, row) => {
    await expectRow(row);
  });

  // The other RequestContext instantiations: a development server, and TLS.
  const subset = [
    "the handler has not answered",
    "a default stream has written nothing",
    "a direct stream has written a chunk, the handler reads req.body",
    "new Response(req.body) has written a chunk",
  ];
  test.each(subset)("development: true: %s", async name => {
    await expectRow(rows[name], { development: true });
  });
  test.each(subset)("TLS: %s", async name => {
    await expectRow(rows[name], { secure: true });
  });

  // Bodies that the socket buffers cannot take whole while the client does not read.
  const large = Buffer.alloc(32 * 1024 * 1024, "y");
  const largeBody = async (respond: Row["respond"]) => {
    const row = { marker: END_OF_STATUS_LINE, respond, expected: {} };
    const { head, body, stopped, ...result } = await run(row, { held: true });
    await stopped;
    return { ...result, body: body.length, terminated: body.endsWith("0\r\n\r\n"), head };
  };

  // A response that has ended is complete, whatever the client has read of it:
  // it is delivered, and only the connection closes behind it.
  test("a direct stream that has ended and is still being sent", async () => {
    const { head, ...result } = await largeBody(
      () =>
        new Response(
          new ReadableStream({
            type: "direct",
            async pull(c: any) {
              c.write(large);
              c.end();
              await never();
            },
          } as any),
        ),
    );
    expect(result).toEqual({
      statusLine: "HTTP/1.1 200 OK",
      headersEnded: true,
      body: expect.any(Number),
      terminated: true,
      closed: "fin",
      heard: [],
      errorCb: 0,
      pendingRequests: 0,
      next: "HTTP/1.1 200 OK",
    });
    expect(result.body).toBeGreaterThan(large.length);
  });

  // The producer has closed its stream, but the pump into the response still
  // waits for the client to read the last chunk before it ends the response.
  // The server cannot tell this stream from one that still has chunks: it used
  // to put a terminating chunk behind the bytes it held, which completed this
  // body and silently cut the other. The first chunk fills the socket buffer,
  // so that the last one waits on every platform.
  test("a closed stream whose last chunk is still being sent", async () => {
    const { head, ...result } = await largeBody(
      (req, { heard }) =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(large.subarray(0, 1024 * 1024));
              c.enqueue(large);
              c.close();
            },
            cancel: heard("cancel"),
          }),
        ),
    );
    expect(result).toEqual({
      statusLine: "HTTP/1.1 200 OK",
      headersEnded: true,
      body: expect.any(Number),
      terminated: false,
      closed: "reset",
      heard: ["abort"],
      errorCb: 0,
      pendingRequests: 0,
      next: "HTTP/1.1 200 OK",
    });
    expect(result.body).toBeLessThan(large.length);
  });

  // A body with a Content-Length used to be cut with a FIN, short of its length.
  // Windows takes a write of any size into an empty socket buffer, so this body
  // is never in flight there. The HTTP/2 row holds it back on every platform.
  test.skipIf(isWindows)("a Buffer that is still being sent", async () => {
    const { head, ...result } = await largeBody(() => new Response(large));
    expect({ ...result, contentLength: /\r\ncontent-length: (\d+)/i.exec(head)?.[1] }).toEqual({
      statusLine: "HTTP/1.1 200 OK",
      contentLength: String(large.length),
      headersEnded: true,
      body: expect.any(Number),
      terminated: false,
      closed: "reset",
      heard: ["abort"],
      errorCb: 0,
      pendingRequests: 0,
      next: "HTTP/1.1 200 OK",
    });
    expect(result.body).toBeLessThan(large.length);
  });

  // A producer that waits on the sink is cancelled, and then its write settles.
  // The first chunk fills the socket buffer, so that the second write waits.
  // Windows Server 2019 takes both writes at once, so nothing waits there.
  test.skipIf(isWindows)("a direct stream that waits on a write", async () => {
    const { head, ...result } = await largeBody(
      (req, { heard }) =>
        new Response(
          new ReadableStream({
            type: "direct",
            async pull(c: any) {
              c.write(large.subarray(0, 1024 * 1024));
              heard("write")(await c.write(large));
            },
            cancel: heard("cancel"),
          } as any),
        ),
    );
    expect(result).toEqual({
      statusLine: "HTTP/1.1 200 OK",
      headersEnded: true,
      body: expect.any(Number),
      terminated: false,
      closed: "reset",
      heard: ["abort", `cancel:${aborted}`, `write:${large.length}`],
      errorCb: 0,
      pendingRequests: 0,
      next: "HTTP/1.1 200 OK",
    });
    expect(result.body).toBeLessThan(large.length);
  });

  const cancelled = `after the abort: ${aborted}`;
  // A loop that waits on the sink hears the cancel. One that has seen the abort by then ends its stream first.
  const stopped = {
    closed: "reset",
    heard: ["abort", "producer ended"],
    cancel: expect.stringMatching(/^(none|after the abort: AbortError: The connection was closed\.)$/),
    pendingRequests: 0,
    next: "HTTP/1.1 200 OK",
  };

  // A producer that watches `req.signal` stops. `write()` and `flush()` return 0
  // once the response is gone: without the abort, these loops never yield.
  test("a direct stream whose producer watches req.signal stops", async () => {
    const expected = {
      // while (!req.signal.aborted) await controller.write(chunk)
      "producer:write": stopped,
      // while (!req.signal.aborted) { controller.write(chunk); await controller.flush(true) }
      "producer:flush": stopped,
      // An abort listener stops the loop.
      "producer:listener": stopped,
      // A timer writes until req.signal.aborted: it is not in the stream when the cancel comes.
      "producer:timer": { ...stopped, cancel: cancelled },
    };
    expect(await scenarios(...Object.keys(expected))).toEqual({
      stdout: expected,
      stderr: announced(...Object.keys(expected)),
      exitCode: 0,
    });
  });

  // `write()` returns 0 once the destination has gone away: that is the
  // documented end of a producer. The first such write also cancels it.
  test("a direct stream whose producer watches for write() to return 0 stops", async () => {
    const expected = {
      // write() and flush() after the abort.
      "producer:late": {
        ...stopped,
        heard: ["abort", "write:0", "flush:0", "flush(true):0", "producer ended"],
        cancel: cancelled,
      },
      // while (controller.write(line) !== 0) await controller.flush(), after a failed read of the request body.
      "producer:zero": { ...stopped, cancel: cancelled },
    };
    expect(await scenarios(...Object.keys(expected))).toEqual({
      stdout: expected,
      stderr: announced(...Object.keys(expected)),
      exitCode: 0,
    });
  });

  // The generator of the streams guide waits with `{ signal: req.signal }`. A
  // handler that reports the failed upload in its own response has no `catch`
  // around its writes: the stream takes them, and the response does not.
  test("a handler that is written for a client that leaves stays quiet", async () => {
    const reported = {
      body: "1d\r\nprogress: reading the upload\n\r\n",
      closed: "reset",
      pendingRequests: 0,
      next: "HTTP/1.1 200 OK",
    };
    const expected = {
      "generator": { closed: "reset", heard: ["the client left"], listeners: 0, pendingRequests: 0 },
      "report:guarded": reported,
      "report:unguarded": reported,
      // The pump calls this pull() again as long as the sink takes a write: the write that reports cancels it.
      "report:from pull()": { ...reported, heard: [`cancel:${aborted}`] },
    };
    expect(await scenarios(...Object.keys(expected))).toEqual({
      stdout: expected,
      stderr: announced(...Object.keys(expected)),
      exitCode: 0,
    });
  });

  // The limit is the client's failure, not the server's: the response that the
  // request body feeds does not report it. A response of another request that
  // reads this body fails with the limit error, and reports it as its own.
  describe.each([false, true])("development: %p", development => {
    test("nothing is reported on stderr", async () => {
      const expected: Record<string, unknown> = {
        "new Response(req.body) has written nothing": "HTTP/1.1 200 OK, 0 pending",
        "new Response(req.body) has written a chunk": "HTTP/1.1 200 OK, 0 pending",
        "an HTMLRewriter over req.body has written nothing": "HTTP/1.1 413 Payload Too Large, 0 pending",
        "an HTMLRewriter over req.body has written a chunk": "HTTP/1.1 200 OK, 0 pending",
      };
      for (const name of Object.keys(expected)) {
        expected[`development: ${development}: ${name}`] = expected[name];
        delete expected[name];
      }
      expect(await scenarios(...Object.keys(expected))).toEqual({
        stdout: expected,
        stderr: announced(...Object.keys(expected)),
        exitCode: 0,
      });
    });
  });

  test("the request body is the body of another response", async () => {
    expect(await scenarios("relay")).toEqual({
      stdout: {
        relay: {
          a: "HTTP/1.1 413 Payload Too Large",
          b: { statusLine: "HTTP/1.1 200 OK", body: "7\r\nchunk-a\r\n", closed: "reset" },
          pendingRequests: 0,
        },
      },
      stderr: `# relay\nerror: ${tooLarge.slice("Error: ".length)}\n`,
      exitCode: 0,
    });
  });

  // X has not answered when its body crosses the limit. That body feeds the
  // response of Y through an HTMLRewriter that has written nothing, so Y's
  // `error()` runs while X is being rejected. It lets the handler of X go on,
  // and the close of Y drains microtasks: X answers with a stream that writes
  // a chunk, under the rejection that is still on the stack. The rejection
  // used to end that response as complete, under its stream.
  test("the handler answers with a stream while its request is being rejected", async () => {
    const heard: string[] = [];
    const answer = Promise.withResolvers<void>();
    const bodyOfX = Promise.withResolvers<ReadableStream>();
    const attached = Promise.withResolvers<void>();
    using server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      maxRequestBodySize: LIMIT,
      error(e) {
        heard.push(`error():${e}`);
        answer.resolve();
        return new Response("err", { status: 500 });
      },
      async fetch(req) {
        if (new URL(req.url).pathname === "/x") {
          bodyOfX.resolve(req.body!);
          await answer.promise;
          let controller: any;
          req.signal.addEventListener("abort", () => void heard.push(`abort, write:${controller.write("late")}`));
          return new Response(
            new ReadableStream({
              type: "direct",
              async pull(c: any) {
                controller = c;
                heard.push(`write:${c.write("chunk-a")}`);
                await c.flush();
                await never();
              },
              cancel: reason => void heard.push(`cancel:${reason}`),
            } as any),
          );
        }
        // A stream on the request body of Y: the close of Y fails it, and drains.
        req.body!.getReader();
        const other = await bodyOfX.promise;
        // One turn of the event loop: the server has taken the response of Y.
        setImmediate(attached.resolve);
        return new HTMLRewriter()
          .on("p", { element() {} })
          .transform(new Response(other, { headers: { "content-type": "text/html" } }));
      },
    });
    // A chunked upload that stays open. `overflow()` takes it over the limit.
    const post = (path: string) => {
      let body!: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({ start: c => void (body = c) });
      const done = new AbortController();
      const outcome = fetch(`http://127.0.0.1:${server.port}${path}`, {
        method: "POST",
        body: stream,
        duplex: "half",
        signal: done.signal,
      } as RequestInit).then(
        async res => ({ status: res.status, body: await res.text() }),
        e => ({ rejected: e.code }),
      );
      return { outcome, done, overflow: () => body.enqueue(new Uint8Array(48).fill(120)) };
    };
    const y = post("/y");
    const x = post("/x");
    await attached.promise;
    x.overflow();
    const result = { x: await x.outcome, y: await y.outcome, heard, pendingRequests: server.pendingRequests };
    y.done.abort();
    expect(result).toEqual({
      x: { rejected: "ECONNRESET" },
      y: { status: 500, body: "err" },
      // The write from the abort listener does not reach the response, and it cancels the producer.
      heard: [`error():${tooLarge}`, "write:7", `cancel:${aborted}`, "abort, write:0"],
      pendingRequests: 0,
    });
  });

  // HTTP/2 holds the status back until the first body byte, and a stream ends
  // with END_STREAM. The response in flight used to end that way: an empty
  // `200`, or the body so far, as a complete message. Now the stream is reset
  // and the connection carries on.
  describe("HTTP/2", () => {
    const INTERNAL_ERROR = 2;
    const WINDOW = 65535;

    // `written`: the DATA bytes the client waits for before it sends the overflow.
    async function expectStream(respond: Row["respond"], written: number, expected: Record<string, unknown>) {
      const heard: string[] = [];
      const clientClosed = Promise.withResolvers<void>();
      const waitFor: Promise<unknown>[] = [];
      using server = Bun.serve({
        port: 0,
        http2: true,
        maxRequestBodySize: LIMIT,
        fetch(req, server) {
          if (req.method === "GET") return new Response("ok");
          req.signal.addEventListener("abort", () => void heard.push("abort"));
          return respond(req, {
            heard: what => reason => void heard.push(`${what}:${reason}`),
            clientClosed: clientClosed.promise,
            waitFor,
            server,
          });
        },
      });
      const client = await RawH2.connect(server.port!, false);
      await client.waitFor(f => f.type === T.SETTINGS);
      client.headers(1, baseHeaders("/", "POST"), F.END_HEADERS);
      const data = () =>
        Buffer.concat(client.frames.filter(f => f.type === T.DATA && f.streamId === 1).map(f => f.payload));
      if (written) await client.waitFor(() => data().length >= written);
      client.write(frame(T.DATA, 0, 1, Buffer.alloc(48, "x")));
      // The stream ends with a RST_STREAM, or as a complete message.
      const end = await client.waitFor(
        f =>
          f.streamId === 1 &&
          (f.type === T.RST_STREAM || (f.type !== T.WINDOW_UPDATE && (f.flags & F.END_STREAM) !== 0)),
      );
      const code = end.type === T.RST_STREAM ? end.payload.readUInt32BE(0) : "END_STREAM";
      clientClosed.resolve();
      await Promise.all(waitFor);
      // The connection still serves the next stream.
      const credit = Buffer.alloc(4);
      credit.writeUInt32BE(WINDOW);
      client.write(frame(T.WINDOW_UPDATE, 0, 0, credit));
      client.headers(3, baseHeaders("/ok"));
      const next = await client.body(3);
      const onStream = client.frames.filter(f => f.streamId === 1);
      client.close();
      expect<Record<string, unknown>>({
        code,
        headers: onStream.filter(f => f.type === T.HEADERS).length,
        data: data().length,
        endStream: onStream.some(f => f.type !== T.RST_STREAM && (f.flags & F.END_STREAM) !== 0),
        heard,
        next: next.toString(),
        pendingRequests: server.pendingRequests,
      }).toEqual(expected);
      // A request that never ends keeps a graceful stop pending.
      await server.stop();
    }

    const reset = (data: number, ...heard: string[]) => ({
      code: INTERNAL_ERROR,
      headers: data ? 1 : 0,
      data,
      endStream: false,
      heard: ["abort", ...heard],
      next: "ok",
      pendingRequests: 0,
    });

    test.each([false, true])("a default stream, chunk written: %p", async chunk => {
      const written = chunk ? "chunk-a".length : 0;
      await expectStream(
        (req, ctx) => new Response(producers["a default stream"].body(ctx, chunk)),
        written,
        reset(written, `cancel:${aborted}`),
      );
    });

    test("a proxied fetch() body", async () => {
      await expectStream(
        (req, ctx) => fetchFromSilentUpstream("HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nchunk-a", ctx),
        "chunk-a".length,
        reset("chunk-a".length, "upstream:closed"),
      );
    });

    // It used to end with END_STREAM at the edge of the client's window.
    test("a Buffer that is still being sent", async () => {
      await expectStream(() => new Response(Buffer.alloc(1024 * 1024, "y")), WINDOW, reset(WINDOW));
    });

    // Two streams on one connection. The response body of X is the request
    // body of Y (a native pipe). The response of Y is an HTMLRewriter over the
    // request body of X, with its status held back. X crosses the limit: the
    // error reaches Y's rewriter, which has written nothing, so Y's `error()`
    // runs while X is still closing. It stops the server, which aborts X, and
    // collects the stream that X was writing from.
    test("the request body is the body of another response, whose error() stops the server", async () => {
      const heard: string[] = [];
      let bodies: Record<string, PromiseWithResolvers<ReadableStream>> | null = {
        "/x": Promise.withResolvers(),
        "/y": Promise.withResolvers(),
      };
      let attached = 0;
      const bothAttached = Promise.withResolvers<void>();
      using server = Bun.serve({
        port: 0,
        http2: true,
        maxRequestBodySize: LIMIT,
        error(e) {
          heard.push(`error():${e}`);
          server.stop(true);
          Bun.gc(true);
          return new Response("err", { status: 500 });
        },
        async fetch(req) {
          const path = new URL(req.url).pathname;
          req.signal.addEventListener("abort", () => void heard.push(`abort ${path}`));
          const mine = bodies![path];
          const theirs = bodies![path === "/x" ? "/y" : "/x"];
          mine.resolve(req.body!);
          // @ts-expect-error The handler keeps no reference to the request.
          req = null;
          let other: ReadableStream | null = await theirs.promise;
          const res =
            path === "/y"
              ? new HTMLRewriter()
                  .on("p", { element() {} })
                  .transform(new Response(other, { headers: { "content-type": "text/html" } }))
              : new Response(other);
          other = null;
          if (++attached === 2) {
            bodies = null;
            // One turn of the event loop: the server has taken both responses.
            setImmediate(bothAttached.resolve);
          }
          return res;
        },
      });
      const client = await RawH2.connect(server.port!, false);
      await client.waitFor(f => f.type === T.SETTINGS);
      client.headers(1, baseHeaders("/x", "POST"), F.END_HEADERS);
      client.headers(3, baseHeaders("/y", "POST"), F.END_HEADERS);
      client.write(frame(T.DATA, 0, 3, Buffer.from("chunk-y")));
      // The response of X carries the upload of Y.
      await client.waitFor(f => f.type === T.DATA && f.streamId === 1);
      await bothAttached.promise;
      Bun.gc(true);
      client.write(frame(T.DATA, 0, 1, Buffer.alloc(48, "x")));
      await client.waitForClose();
      const onX = client.frames.filter(f => f.streamId === 1);
      expect({
        x: Buffer.concat(onX.filter(f => f.type === T.DATA).map(f => f.payload)).toString(),
        endStream: onX.some(f => f.type !== T.RST_STREAM && (f.flags & F.END_STREAM) !== 0),
        heard,
        pendingRequests: server.pendingRequests,
      }).toEqual({
        x: "chunk-y",
        endStream: false,
        heard: [`error():${tooLarge}`, "abort /x", "abort /y"],
        pendingRequests: 0,
      });
    });
  });

  // HTTP/3 holds the status back like HTTP/2.
  describe("HTTP/3", () => {
    async function overLimit(chunk: boolean): Promise<Record<string, unknown>> {
      const heard: string[] = [];
      const handlerRan = Promise.withResolvers<void>();
      const cancelled = Promise.withResolvers<void>();
      using server = Bun.serve({
        port: 0,
        tls: tlsCert,
        http3: true,
        maxRequestBodySize: LIMIT,
        fetch(req) {
          if (req.method === "GET") return new Response("ok");
          req.signal.addEventListener("abort", () => void heard.push("abort"));
          handlerRan.resolve();
          return new Response(
            new ReadableStream({
              pull(c) {
                if (chunk) c.enqueue("chunk-a");
                return never();
              },
              cancel(reason) {
                heard.push(`cancel:${reason}`);
                cancelled.resolve();
              },
            }),
          );
        },
      });
      const url = `https://127.0.0.1:${server.port}/`;
      const init = { protocol: "http3", tls: { rejectUnauthorized: false } } as RequestInit;
      let body!: ReadableStreamDefaultController<Uint8Array>;
      const uploaded = new ReadableStream<Uint8Array>({
        start(c) {
          body = c;
          c.enqueue(new TextEncoder().encode("ab"));
        },
      });
      const response = fetch(url, { ...init, method: "POST", body: uploaded, duplex: "half" } as RequestInit);
      const overflow = new Uint8Array(48).fill(120);
      let outcome: Record<string, unknown>;
      if (chunk) {
        const res = await response;
        const reader = res.body!.getReader();
        const first = await reader.read();
        body.enqueue(overflow);
        const rest = await reader.read().then(
          r => (r.done ? "a clean end" : "more data"),
          e => e.code,
        );
        outcome = { status: res.status, first: new TextDecoder().decode(first.value), rest };
      } else {
        await handlerRan.promise;
        body.enqueue(overflow);
        outcome = await response.then(
          async res => ({ status: res.status, body: await res.text() }),
          e => ({ rejected: e.code }),
        );
      }
      await cancelled.promise;
      const next = await fetch(url, init).then(r => r.text());
      return { ...outcome, heard, next, pendingRequests: server.pendingRequests };
    }

    test("a stream that has written nothing", async () => {
      expect(await overLimit(false)).toEqual({
        rejected: "HTTP3StreamReset",
        heard: ["abort", `cancel:${aborted}`],
        next: "ok",
        pendingRequests: 0,
      });
    });

    // HTTP/3 closes a stream that has sent its headers with a FIN: the client
    // reads "a clean end" here.
    test.todo("a stream that has written a chunk", async () => {
      expect(await overLimit(true)).toEqual({
        status: 200,
        first: "chunk-a",
        rest: "HTTP3StreamReset",
        heard: ["abort", `cancel:${aborted}`],
        next: "ok",
        pendingRequests: 0,
      });
    });
  });
});
