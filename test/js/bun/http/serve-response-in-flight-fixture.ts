// The raw client of serve-response-in-flight.test.ts, and the scenarios of that
// file that need a process of their own: a producer that can spin the event
// loop, and a report on stderr. The process runs the scenarios it is given, in
// order, and announces each on stderr, so a report lands under its scenario.
import { EventEmitter, once } from "node:events";
import net from "node:net";
import tls from "node:tls";

export const LIMIT = 32;
// One chunk that takes every request body here over the limit.
export const OVERFLOW = `30\r\n${Buffer.alloc(48, "x").toString()}\r\n`;
// The first line break: the status line has arrived.
export const END_OF_STATUS_LINE = "\r\n";

export type Upload = {
  // What the client must have received before it sends the overflow, so the
  // response is provably in flight. `null`: the request head and the overflow
  // leave in one write, so the server finds both in one read.
  marker: string | null;
  // Body bytes (within the limit) sent with the request head.
  first?: string;
  path?: string;
  // For a response that can have megabytes in flight. Settles when the server
  // has let the request go: the FIN of the upload leaves then, not behind the
  // overflow. On macOS such a client is not always told of a reset when it
  // sends nothing afterwards, and this FIN is answered with a reset.
  released?: () => Promise<unknown>;
  // With `released`: the client also stops reading until then, so the response
  // stays in flight whatever the socket buffers can take.
  hold?: boolean;
};

// Settles when `server` has let every request go. With a deadline: a request
// that it never lets go shows in the result, not as a timeout.
export async function released(server: { pendingRequests: number }) {
  const deadline = Date.now() + 2000;
  while (server.pendingRequests > 0 && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve));
}

const connect = (port: number, secure: boolean, onConnect: () => void): net.Socket =>
  secure
    ? tls.connect({ port, host: "127.0.0.1", rejectUnauthorized: false }, onConnect)
    : net.connect(port, "127.0.0.1", onConnect);

// Uploads a chunked body: `first` with the head and, once `marker` has arrived,
// the chunk that takes the body over the limit. The overflow leaves from the
// data handler because a forced close is a RST, and a RST can discard what the
// client has not read yet. The client sends its FIN behind the overflow, so a
// server that answers and keeps the connection open still ends the upload.
// `closed` tells a forced close ("reset") from a graceful one ("fin").
export function upload(
  port: number,
  secure: boolean,
  { marker, first = "", path = "/", released, hold }: Upload,
  onClose = () => {},
) {
  const chunks: Buffer[] = [];
  let overflowed = marker === null;
  let closed = "fin";
  return new Promise<{ wire: string; closed: string }>(resolve => {
    const sock = connect(port, secure, () => {
      const head = `POST ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nTransfer-Encoding: chunked\r\n\r\n${first}`;
      if (overflowed) sock.end(head + OVERFLOW);
      else sock.write(head);
    });
    sock.on("data", (d: Buffer) => {
      chunks.push(d);
      if (overflowed || !Buffer.concat(chunks).includes(marker!)) return;
      overflowed = true;
      if (!released) return void sock.end(OVERFLOW);
      sock.write(OVERFLOW);
      if (hold) sock.pause();
      released().finally(() => {
        sock.resume();
        sock.end();
      });
    });
    sock.on("error", () => (closed = "reset"));
    sock.on("close", () => {
      onClose();
      resolve({ wire: Buffer.concat(chunks).toString("latin1"), closed });
    });
  });
}

// The status line of a GET on a connection of its own.
export function get(port: number, secure = false, path = "/ok"): Promise<string> {
  const chunks: Buffer[] = [];
  return new Promise(resolve => {
    const sock = connect(port, secure, () => {
      sock.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
    sock.on("data", (d: Buffer) => chunks.push(d));
    sock.on("error", () => {});
    sock.on("close", () => resolve(Buffer.concat(chunks).toString("latin1").split("\r\n")[0]));
  });
}

const body = (wire: string) => wire.split("\r\n\r\n").slice(1).join("\r\n\r\n");

// A direct stream whose producer writes until `req.signal` tells it to stop.
// `cancel` is apart from `heard`: a producer that is parked on the sink hears
// it, and one that has already seen the abort ends its stream first.
async function producer(run: (c: any, req: Request, heard: string[]) => Promise<void>) {
  const heard: string[] = [];
  let cancel = "none";
  using server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    maxRequestBodySize: LIMIT,
    fetch(req) {
      if (req.method === "GET") return new Response("ok");
      req.signal.addEventListener("abort", () => void heard.push("abort"));
      return new Response(
        new ReadableStream({
          type: "direct",
          pull: (c: any) =>
            run(c, req, heard).then(
              () => void heard.push("producer ended"),
              e => void heard.push(`producer threw:${e}`),
            ),
          cancel(reason: unknown) {
            cancel = `${heard.includes("abort") ? "after" : "before"} the abort: ${reason}`;
          },
        } as any),
      );
    },
  });
  const { closed } = await upload(server.port!, false, { marker: "chunk", released: () => released(server) });
  return { closed, heard, cancel, pendingRequests: server.pendingRequests, next: await get(server.port!) };
}

// A handler that reports a failed upload inside its own response, with no
// `catch` around its writes. `guarded`: it first checks that the request is
// still there.
async function report(guarded: boolean) {
  using server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    maxRequestBodySize: LIMIT,
    fetch(req) {
      if (req.method === "GET") return new Response("ok");
      let controller!: ReadableStreamDefaultController;
      const progress = new ReadableStream({
        start(c) {
          controller = c;
          c.enqueue("progress: reading the upload\n");
        },
      });
      req.text().then(
        text => {
          controller.enqueue(`done: ${text.length} bytes\n`);
          controller.close();
        },
        err => {
          if (guarded && req.signal.aborted) return;
          controller.enqueue(`upload failed: ${err.message}\n`);
          controller.close();
        },
      );
      return new Response(progress);
    },
  });
  const { wire, closed } = await upload(server.port!, false, { marker: "progress" });
  return { body: body(wire), closed, pendingRequests: server.pendingRequests, next: await get(server.port!) };
}

// A default stream that reports a failed read of the request body from
// `pull()`, and goes on: the next pull reads, fails and reports again.
async function reportFromPull() {
  const heard: string[] = [];
  using server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    maxRequestBodySize: LIMIT,
    fetch(req) {
      if (req.method === "GET") return new Response("ok");
      const reader = req.body!.getReader();
      let pulls = 0;
      return new Response(
        new ReadableStream({
          async pull(c) {
            if (pulls++ === 0) return c.enqueue("progress: reading the upload\n");
            try {
              const { done, value } = await reader.read();
              if (done) return c.close();
              c.enqueue(`read: ${value.length} bytes\n`);
            } catch (err) {
              c.enqueue(`upload failed: ${(err as Error).message}\n`);
            }
          },
          cancel: reason => void heard.push(`cancel:${reason}`),
        }),
      );
    },
  });
  const { wire, closed } = await upload(server.port!, false, { marker: "progress" });
  return { body: body(wire), closed, heard, pendingRequests: server.pendingRequests, next: await get(server.port!) };
}

const chunk = Buffer.alloc(16 * 1024, "chunk");

const scenarios: Record<string, () => Promise<unknown>> = {
  "producer:write": () =>
    producer(async (c, req) => {
      while (!req.signal.aborted) await c.write(chunk);
    }),
  "producer:flush": () =>
    producer(async (c, req) => {
      while (!req.signal.aborted) {
        c.write(chunk);
        await c.flush(true);
      }
    }),
  "producer:listener": () =>
    producer(async (c, req) => {
      let stop = false;
      req.signal.addEventListener("abort", () => (stop = true));
      while (!stop) await c.write(chunk);
    }),
  "producer:timer": () =>
    producer(
      (c, req) =>
        new Promise<void>(resolve => {
          const timer = setInterval(() => {
            if (req.signal.aborted) {
              clearInterval(timer);
              return resolve();
            }
            c.write(chunk);
            c.flush();
          }, 1);
        }),
    ),
  // What the controller answers once the response is gone. A write waits
  // until the producer is told, so a producer cannot run on against it.
  "producer:late": () =>
    producer(async (c, req, heard) => {
      c.write(chunk);
      await c.flush();
      await once(req.signal, "abort");
      const write = c.write(chunk);
      heard.push(`write:${write instanceof Promise ? "waits" : write}`, `flush:${c.flush()}`);
      heard.push(`write:${await write}`, `flush(true):${await c.flush(true)}`);
    }),

  // The generator of docs/runtime/streams.mdx, with a first chunk.
  async "generator"() {
    const emitter = new EventEmitter();
    const heard: string[] = [];
    using server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      maxRequestBodySize: LIMIT,
      fetch(req) {
        return new Response(
          (async function* () {
            try {
              yield "chunk-a";
              while (true) {
                // `req.signal` ends this wait when the client disconnects.
                const [message] = await once(emitter, "message", { signal: req.signal });
                yield message;
              }
            } finally {
              heard.push("the client left");
            }
          })() as any,
        );
      },
    });
    const { closed } = await upload(server.port!, false, { marker: "chunk-a" });
    return { closed, heard, listeners: emitter.listenerCount("message"), pendingRequests: server.pendingRequests };
  },

  "report:guarded": () => report(true),
  "report:unguarded": () => report(false),
  "report:from pull()": reportFromPull,

  // The body of request A is the response body of request B, which has written
  // a chunk. A crosses the limit: A gets the 413, and B's body fails with the
  // limit error, which is B's to report.
  async "relay"() {
    const bodyOfA = Promise.withResolvers<ReadableStream>();
    using server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      development: false,
      maxRequestBodySize: LIMIT,
      async fetch(req) {
        if (req.method === "GET") return new Response(await bodyOfA.promise);
        bodyOfA.resolve(req.body!);
        return new Promise<Response>(() => {});
      },
    });
    const relayed = Promise.withResolvers<void>();
    const b = new Promise<{ wire: string; closed: string }>(resolve => {
      const chunks: Buffer[] = [];
      let closed = "fin";
      const sock = net.connect(server.port!, "127.0.0.1", () => {
        sock.write("GET /b HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
      });
      sock.on("data", (d: Buffer) => {
        chunks.push(d);
        if (Buffer.concat(chunks).includes("chunk-a")) relayed.resolve();
      });
      sock.on("error", () => (closed = "reset"));
      sock.on("close", () => resolve({ wire: Buffer.concat(chunks).toString("latin1"), closed }));
    });
    // A sends its overflow once B has relayed A's first chunk.
    const a = await new Promise<string>(resolve => {
      const chunks: Buffer[] = [];
      const sock = net.connect(server.port!, "127.0.0.1", async () => {
        sock.write("POST /a HTTP/1.1\r\nHost: 127.0.0.1\r\nTransfer-Encoding: chunked\r\n\r\n7\r\nchunk-a\r\n");
        await relayed.promise;
        sock.end(OVERFLOW);
      });
      sock.on("data", (d: Buffer) => chunks.push(d));
      sock.on("error", () => {});
      sock.on("close", () => resolve(Buffer.concat(chunks).toString("latin1").split("\r\n")[0]));
    });
    const { wire, closed } = await b;
    return {
      a,
      b: { statusLine: wire.split("\r\n")[0], body: body(wire), closed },
      pendingRequests: server.pendingRequests,
    };
  },
};

// Every response that the request body feeds natively, in both modes.
const rewrite = (req: Request) =>
  new HTMLRewriter()
    .on("p", { element() {} })
    .transform(new Response(req.body, { headers: { "content-type": "text/html" } }));
const echo = (req: Request) => new Response(req.body);
const fed: Record<string, { respond(req: Request): Response } & Upload> = {
  "new Response(req.body) has written nothing": { respond: echo, marker: END_OF_STATUS_LINE },
  "new Response(req.body) has written a chunk": { respond: echo, marker: "chunk-a", first: "7\r\nchunk-a\r\n" },
  "an HTMLRewriter over req.body has written nothing": { respond: rewrite, marker: null },
  "an HTMLRewriter over req.body has written a chunk": {
    respond: rewrite,
    marker: "chunk-a",
    first: "e\r\n<b>chunk-a</b>\r\n",
  },
};
for (const development of [false, true]) {
  for (const [name, { respond, ...request }] of Object.entries(fed)) {
    scenarios[`development: ${development}: ${name}`] = async () => {
      using server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        development,
        maxRequestBodySize: LIMIT,
        fetch: respond,
      });
      const { wire } = await upload(server.port!, false, request);
      return `${wire.split("\r\n")[0]}, ${server.pendingRequests} pending`;
    };
  }
}

if (import.meta.main) {
  const results: Record<string, unknown> = {};
  for (const name of process.argv.slice(2)) {
    console.error(`# ${name}`);
    results[name] = await scenarios[name]();
  }
  console.log(JSON.stringify(results));
}
