import { socketFaultInjection as fault } from "bun:internal-for-testing";
import { describe, expect, test } from "bun:test";
import { bunEnv, bunExe, isWindows, tls as tlsCert } from "harness";
import { once } from "node:events";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

// res.socket.end() half-closes the connection; the server must still release the
// socket (drain the unconsumed body on epoll, or take kqueue's EVFILT_WRITE
// EV_EOF from its own SHUT_WR) so server.close() resolves. On macOS that early
// close can RST the still-writing client, so the client's EPIPE is expected and
// the close wait must not be once(c, "close"), which would reject on it.
test("server.close() completes after res.socket.end() with a 2 MB upload in flight", async () => {
  await using proc = Bun.spawn({
    cmd: [
      bunExe(),
      "-e",
      `
        import { once } from "node:events";
        import http from "node:http";
        import net from "node:net";
        let sock;
        const handled = Promise.withResolvers();
        const server = http.createServer((req, res) => {
          res.writeHead(200, { Connection: "close" });
          sock = res.socket;
          res.socket.end();
          try { res.write("x"); } catch {}
          handled.resolve();
        });
        await once(server.listen(0, "127.0.0.1"), "listening");
        const port = server.address().port;
        const c = net.connect(port, "127.0.0.1");
        await once(c, "connect");
        const body = Buffer.alloc(2 * 1024 * 1024, 0x61);
        c.on("error", () => {});
        c.write("POST / HTTP/1.1\\r\\nHost: x\\r\\nContent-Length: " + body.length + "\\r\\nConnection: close\\r\\n\\r\\n");
        c.write(body);
        c.on("end", () => c.end());
        // Not once(c, "close"): that also registers an 'error' rejector, and on
        // macOS the 2 MB upload can hit EPIPE once the server's SHUT_WR +
        // resume drains the body. The write error is expected (and swallowed
        // above); rejecting socketClosed on it turned it into an uncaught
        // top-level rejection instead of exercising the drain/close path.
        const socketClosed = new Promise(r => c.once("close", r));
        await handled.promise;
        const serverClosed = new Promise(r => server.close(() => r()));
        const watchdog = setTimeout(() => {
          process.stdout.write("timeout destroyed=" + (sock?.destroyed ?? "none") + "\\n");
          process.exit(1);
        }, 10000);
        await Promise.all([socketClosed, serverClosed]);
        clearTimeout(watchdog);
        process.stdout.write("closed destroyed=" + sock.destroyed + "\\n");
      `,
    ],
    env: bunEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  expect({ stdout, stderr, exitCode }).toEqual({ stdout: "closed destroyed=true\n", stderr: "", exitCode: 0 });
});

// In Node the response and the raw socket share one net.Socket Writable, so the
// FIN of socket.end() / destroySoon() follows every byte the response wrote.
describe.each(["http", "https"] as const)("%s: the raw socket's FIN follows the bytes the response wrote", protocol => {
  type Handler = (req: IncomingMessage, res: ServerResponse) => void;
  const cases: [string, Handler, string][] = [
    [
      "res.write() then req.socket.destroySoon()",
      (req, res) => {
        res.write("PART1");
        req.socket.destroySoon();
      },
      "5\r\nPART1\r\n",
    ],
    [
      "res.write() then res.socket.end()",
      (req, res) => {
        res.write("PART1");
        res.socket!.end();
      },
      "5\r\nPART1\r\n",
    ],
    [
      "res.write() then res.socket.end() from a microtask",
      (req, res) => {
        res.write("PART1");
        queueMicrotask(() => res.socket!.end());
      },
      "5\r\nPART1\r\n",
    ],
    [
      "res.flushHeaders() then res.socket.end()",
      (req, res) => {
        res.flushHeaders();
        res.socket!.end();
      },
      "",
    ],
  ];

  test.concurrent.each(cases)("%s", async (_name, respond, body) => {
    const onRequest: Handler = (req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      respond(req, res);
    };
    await using server = protocol === "https" ? https.createServer(tlsCert, onRequest) : http.createServer(onRequest);
    await once(server.listen(0, "127.0.0.1"), "listening");
    const { port } = server.address() as net.AddressInfo;

    const client =
      protocol === "https"
        ? tls.connect({ port, host: "127.0.0.1", rejectUnauthorized: false })
        : net.connect(port, "127.0.0.1");
    const chunks: Buffer[] = [];
    client.on("data", (chunk: Buffer) => chunks.push(chunk));
    // The server can close before the client's own FIN lands; only the bytes matter here.
    client.on("error", () => {});
    const closed = new Promise(resolve => client.once("close", resolve));
    client.write("GET / HTTP/1.1\r\nHost: x\r\n\r\n");
    await closed;

    const received = Buffer.concat(chunks).toString("latin1");
    const headEnd = received.indexOf("\r\n\r\n");
    expect({
      statusLine: received.slice(0, received.indexOf("\r\n")),
      body: headEnd === -1 ? null : received.slice(headEnd + 4),
    }).toEqual({ statusLine: "HTTP/1.1 200 OK", body });
  });
});

// destroySoon() closes the connection behind its FIN. Over TLS a short send can leave the
// ciphertext of the last write in the TLS layer at that point, and here 5 bytes of the client
// also wait unread behind req.socket.pause(). The close waits for the ciphertext and drops the
// unread bytes, so it is a FIN: a close over unread input is a reset, and a reset throws away
// the output that the kernel has not sent yet.
test.concurrent.skipIf(!fault.available() || isWindows)(
  "https: req.socket.destroySoon() sends the TLS ciphertext that a short send left behind",
  async () => {
    await using proc = Bun.spawn({
      cmd: [
        bunExe(),
        "-e",
        `
          import { socketFaultInjection as fault } from "bun:internal-for-testing";
          import { once } from "node:events";
          import https from "node:https";
          import tls from "node:tls";
          const server = https.createServer({ key: process.env.KEY, cert: process.env.CERT });
          await once(server.listen(0, "127.0.0.1"), "listening");
          const client = tls.connect({ port: server.address().port, host: "127.0.0.1", rejectUnauthorized: false });
          client.pause();
          let received = 0;
          let end = "none";
          const closed = Promise.withResolvers();
          client.on("error", err => (end = err.code));
          client.on("end", () => (end = "end"));
          client.on("close", closed.resolve);
          client.on("data", chunk => {
            // One chunk for each turn of the event loop, so that a reset cuts the output short.
            client.pause();
            setImmediate(() => client.resume());
            received += chunk.length;
          });
          await once(client, "secureConnect");
          const handled = Promise.withResolvers();
          server.once("request", req => {
            req.socket.on("error", () => {});
            req.socket.pause();
            handled.resolve(req.socket);
          });
          client.write("POST / HTTP/1.1\\r\\nHost: x\\r\\nContent-Length: 5\\r\\n\\r\\n");
          const socket = await handled.promise;
          // The reads are paused: the body stays in the kernel of the server.
          await new Promise(resolve => client.write("hello", resolve));
          await new Promise(resolve => socket.write(Buffer.alloc(256 * 1024, "a"), resolve));
          // The kernel takes 1 byte of the next write. The rest of its ciphertext waits in the TLS layer.
          fault.set({ syscall: "send", action: "short", bytes: 1, repeat: -1 });
          socket.write(Buffer.alloc(64 * 1024, "b"));
          socket.destroySoon();
          await once(socket, "finish");
          fault.clear();
          client.resume();
          await closed.promise;
          server.close();
          process.stdout.write(JSON.stringify({ received, end }));
        `,
      ],
      env: { ...bunEnv, KEY: tlsCert.key, CERT: tlsCert.cert },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect({ stdout, stderr, exitCode }).toEqual({
      stdout: JSON.stringify({ received: 256 * 1024 + 64 * 1024, end: "end" }),
      stderr: "",
      exitCode: 0,
    });
  },
);
