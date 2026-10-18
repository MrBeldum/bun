// A connection closes while bytes of the client wait unread in the kernel, because the server
// stopped the reads of the connection before they came. The kernel turns a close over unread
// input into a reset, and a reset throws away the output that the kernel has not sent yet.
//
// usage: <tcp|tls|unix> <mode> [path of the unix socket]
// Prints one JSON line. Node.js runs this file too.
const { once } = require("node:events");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const path = require("node:path");
const tls = require("node:tls");

const [transport, mode, socketPath] = process.argv.slice(2);
const isTLS = transport === "tls";
const keys = path.join(__dirname, "..", "test", "fixtures", "keys");

const events = [];
process.on("uncaughtException", err => events.push(`uncaught: ${err.message}`));

const get = (url, headers = "", version = "1.1") => `GET ${url} HTTP/${version}\r\nHost: localhost\r\n${headers}\r\n`;
const post = (url, length) => `POST ${url} HTTP/1.1\r\nHost: localhost\r\nContent-Length: ${length}\r\n\r\n`;
const turn = () => new Promise(resolve => setImmediate(resolve));
// More than a socket buffer takes at once, so it backs up while the client does not read.
const bigLength = 8 * 1024 * 1024;
const big = Buffer.alloc(bigLength, "x");

// The client sends `requests` one at a time, each when the server has dispatched the one
// before. `late` is what it sends when the server has stopped the reads. With `fin` the client
// also ends its side there. With `held` the server waits for `late` before it sends `big`.
// `length` is how much of `big` the server sends, when that is not all of it.
//
// What stops the reads:
// - Flood prevention. The output is backed up when a request is dispatched: `big` is the
//   response to /first and /second is pipelined behind it, or (`raw`) a 'connection' listener
//   wrote `big` to the socket before the one request.
// - A request body that nothing reads ("unread-body"), the queue of pipelined responses
//   ("queued-bytes"), or a tunnel that nothing reads (`tunnel`).
const second = { requests: [get("/first"), get("/second")], late: get("/third") };
const modes = {
  // The dispatch of the queued request throws. The connection closes at its turn.
  "throw": second,
  // The queued response is destroyed. The connection closes at its turn too.
  "destroy": second,
  // The response in flight closes the connection.
  "response-close": second,
  // The queued response is the last one: it closes the connection. The server starts the reads
  // again in the call that sends it.
  "queued-request-close": { ...second, requests: [get("/first"), get("/second", "Connection: close\r\n")] },
  "queued-response-close": second,
  "queued-http10": { ...second, requests: [get("/first"), get("/second", "", "1.0")] },
  // socket.end() and socket.destroySoon() wait for the raw write, then close. The late body
  // of "socket-end" takes more than one read to drop.
  "socket-end": { raw: true, requests: [post("/first", 40_000)], late: Buffer.alloc(40_000, "h") },
  "socket-destroySoon": { raw: true, requests: [post("/first", 5)], late: "hello" },
  // The dispatch throws, and the client ends its side behind the late body.
  "client-fin": { raw: true, requests: [post("/first", 4096)], late: Buffer.alloc(4096, "h"), fin: true },
  // The same with nothing late: only the FIN of the client waits (over TLS, behind its close_notify).
  "client-fin-only": { raw: true, requests: [post("/first", 5)], late: "", fin: true },
  // The handler does not read the body of the request. The reads stop when its buffer is full,
  // and the end of the response starts them again. The response is short enough for the
  // kernel to take it in that call, so the connection closes there too.
  "unread-body": { requests: [post("/first", bigLength)], late: "hello", held: true, length: 1024 * 1024 },
  // The response to /second waits in the queue with 1 MiB, so the dispatch of /third stops the reads.
  "queued-bytes": { requests: [get("/first"), get("/second"), get("/third")], late: get("/fourth"), held: true },
  // A tunnel that nothing reads stops its reads when its buffer is full. destroySoon() then
  // closes behind what the server wrote.
  "tunnel-connect": {
    tunnel: "HTTP/1.1 200 Connection Established\r\n\r\n",
    requests: ["CONNECT localhost:443 HTTP/1.1\r\nHost: localhost:443\r\n\r\n"],
    late: "hello",
    held: true,
  },
  "tunnel-upgrade": {
    tunnel: "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n",
    requests: [get("/first", "Connection: Upgrade\r\nUpgrade: test\r\n")],
    late: "hello",
    held: true,
  },
};

(async () => {
  const { raw, tunnel, requests, late, fin, held, length = bigLength } = modes[mode];
  // One for each request, in the order of their dispatch.
  const dispatched = requests.map(() => Promise.withResolvers());
  let dispatches = 0;
  const lateSent = Promise.withResolvers();
  // "unread-body": the request whose body fills its buffer, and the 'pause' of its socket.
  let unread;
  const unreadPaused = Promise.withResolvers();

  const options = isTLS
    ? {
        key: fs.readFileSync(path.join(keys, "agent1-key.pem")),
        cert: fs.readFileSync(path.join(keys, "agent1-cert.pem")),
      }
    : {};
  const server = (isTLS ? https : http).createServer(options, (req, res) => {
    req.on("error", () => {});
    res.on("error", () => {});
    events.push(`request ${req.url}`);
    dispatched[dispatches++]?.resolve();
    if (raw) {
      if (mode === "socket-end") return void req.socket.end();
      if (mode === "socket-destroySoon") return void req.socket.destroySoon();
      throw new Error("first threw");
    }
    if (req.url === "/first") {
      if (mode === "unread-body") {
        unread = req;
        req.socket.once("pause", unreadPaused.resolve);
      }
      if (mode === "response-close" || held) res.setHeader("Connection", "close");
      res.setHeader("Content-Length", length);
      const body = big.subarray(0, length);
      return void (held ? lateSent.promise.then(() => res.end(body)) : res.end(body));
    }
    if (req.url === "/second") {
      if (mode === "throw") throw new Error("second threw");
      if (mode === "destroy") return void res.destroy();
      if (mode === "queued-response-close") res.setHeader("Connection", "close");
      if (mode === "queued-bytes") return void res.end(Buffer.alloc(1024 * 1024, "y"));
    }
    res.end(req.url.slice(1));
  });
  if (raw) {
    server.on(isTLS ? "secureConnection" : "connection", socket => {
      socket.on("error", () => {});
      socket.write(big);
    });
  }
  let tunnelSocket;
  if (tunnel) {
    const onTunnel = (req, socket) => {
      events.push(`${req.method === "CONNECT" ? "connect" : "upgrade"} ${req.url}`);
      socket.on("error", () => {});
      tunnelSocket = socket;
      dispatched[dispatches++].resolve();
      lateSent.promise.then(() => {
        socket.write(tunnel);
        socket.write(big);
        socket.destroySoon();
      });
    };
    server.on("connect", onTunnel);
    server.on("upgrade", onTunnel);
  }
  await once(server.listen(transport === "unix" ? socketPath : { port: 0, host: "127.0.0.1" }), "listening");

  const address = transport === "unix" ? { path: socketPath } : { port: server.address().port, host: "127.0.0.1" };
  const client = isTLS ? tls.connect({ ...address, rejectUnauthorized: false }) : net.connect(address);
  client.pause();
  // How the connection ended for the client: "end", or the code of its error.
  let end = "none";
  // The head of the response in front of `big`, until the client has all of it.
  let head = raw ? undefined : "";
  let bigBytes = 0;
  let bigIntact = true;
  let rest = "";
  const closed = Promise.withResolvers();
  client.on("error", err => (end = err.code));
  client.on("end", () => (end = "end"));
  client.on("close", closed.resolve);
  client.on("data", chunk => {
    // One chunk for each turn of the event loop. The kernel of the server then still holds
    // unsent bytes when the server closes, and a reset would throw them away.
    client.pause();
    setImmediate(() => client.resume());
    if (head !== undefined) {
      head += chunk.toString("latin1");
      const headEnd = head.indexOf("\r\n\r\n");
      if (headEnd === -1) return;
      chunk = Buffer.from(head.slice(headEnd + 4), "latin1");
      head = undefined;
    }
    const bigPart = Math.min(chunk.length, length - bigBytes);
    bigIntact &&= chunk.subarray(0, bigPart).equals(big.subarray(0, bigPart));
    bigBytes += bigPart;
    rest += chunk.toString("latin1", bigPart);
  });
  await once(client, isTLS ? "secureConnect" : "connect");

  for (let i = 0; i < requests.length; i++) {
    client.write(requests[i]);
    await dispatched[i].promise;
  }
  if (tunnel) {
    // The tunnel takes what fills its buffer, then it stops the reads.
    client.write(Buffer.alloc(tunnelSocket.readableHighWaterMark, "f"));
    while (tunnelSocket.readableLength < tunnelSocket.readableHighWaterMark) await turn();
  }
  if (unread) {
    client.write(Buffer.alloc(unread.readableHighWaterMark, "b"));
    await unreadPaused.promise;
  }
  // The server has stopped the reads by now: these bytes stay in its kernel.
  await new Promise(resolve => (fin ? client.end(late, resolve) : client.write(late, resolve)));
  lateSent.resolve();
  client.resume();
  await closed.promise;

  client.destroy();
  tunnelSocket?.destroy();
  server.close();
  server.closeAllConnections();
  console.log(
    JSON.stringify({
      mode,
      events,
      big: bigBytes === length && bigIntact ? "all" : bigBytes,
      rest: rest.replace(/Date: [^\r]+\r\n/g, ""),
      end,
    }),
  );
})();
