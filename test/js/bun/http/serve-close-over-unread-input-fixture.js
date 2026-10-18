// Bun.serve closes a connection while bytes of the client wait unread in the kernel, on a
// connection whose reads it stopped once. The kernel turns a close over unread input into a
// reset, and a reset throws away the output that the kernel has not sent yet.
//
// Request 1 of a connection is an upload that the handler leaves alone: Bun.serve stops the
// reads of the connection when 1 MiB of the body is buffered. Request 2 is answered with
// `Connection: close`, and one short read takes its head only, so the request behind it stays
// in the kernel.
//
// usage: <tcp|tls>
// Prints one JSON line, with one result for each shape. Needs a build with socketFaultInjection.
import { socketFaultInjection as fault } from "bun:internal-for-testing";
import { once } from "node:events";
import net from "node:net";
import tls from "node:tls";

const isTLS = process.argv[2] === "tls";

const uploadLength = 1024 * 1024 + 256 * 1024;
// The kernel takes it in one write, so the response is complete when the handler returns.
const big = Buffer.alloc(256 * 1024, "x");
const turn = () => new Promise(resolve => setImmediate(resolve));
// Each shape closes the connection at another place in uWS.
const shapes = {
  // The end of the read that dispatched the request.
  sync: { head: "GET /sync HTTP/1.1", body: Buffer.from("sync") },
  // The end of the response.
  async: { head: "GET /async HTTP/1.1", body: big },
  // The end of a cork: a response with no body ends there.
  head: { head: "HEAD /async HTTP/1.1", body: Buffer.alloc(0) },
  // The answer to a request that the parser refuses.
  invalid: { head: "GET /async HTTP/9.9", body: Buffer.alloc(0) },
};
const closing = body => new Response(body, { headers: { Connection: "close" } });

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  idleTimeout: 0,
  tls: isTLS ? { key: process.env.KEY, cert: process.env.CERT } : undefined,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/upload") return upload(req, Number(url.searchParams.get("turns")));
    if (url.pathname === "/sync") return closing("sync");
    return turn().then(() => closing(big));
  },
});
// Leaves the body alone for `turns` turns of the event loop, then answers with the length of
// its first chunk: what Bun.serve had buffered by then.
async function upload(req, turns) {
  for (let i = 0; i < turns; i++) await turn();
  fault.clear();
  let firstChunk = 0;
  for await (const chunk of req.body) firstChunk ||= chunk.length;
  return new Response(`uploaded ${firstChunk}.`);
}

async function closeOverUnreadInput({ head, body: expectedBody }) {
  const client = isTLS
    ? tls.connect({ port: server.port, host: "127.0.0.1", rejectUnauthorized: false, allowHalfOpen: true })
    : net.connect({ port: server.port, host: "127.0.0.1", allowHalfOpen: true });
  // How the connection ended for the client: "end", or the code of its error.
  let end = "none";
  // A write behind the end: the kernel refuses it when the connection was reset.
  let afterEnd = "none";
  let received = Buffer.alloc(0);
  let uploaded;
  const closed = Promise.withResolvers();
  client.on("error", err => (end = end === "none" ? err.code : end));
  client.on("end", () => {
    end = "end";
    client.write("x", err => {
      afterEnd = err ? err.code : "written";
      client.destroy();
    });
  });
  client.on("close", closed.resolve);
  client.on("data", chunk => {
    received = Buffer.concat([received, chunk]);
    const answer = uploaded && /uploaded (\d+)\.$/.exec(received.toString("latin1"));
    if (answer) {
      received = Buffer.alloc(0);
      uploaded.resolve(Number(answer[1]));
      uploaded = undefined;
    }
  });
  await once(client, isTLS ? "secureConnect" : "connect");

  // Uploads until Bun.serve has stopped the reads once. It has then buffered 1 MiB or more of
  // the body, but not all of it. One read of the loop takes 64 KiB, so 17 turns of the loop
  // reach 1 MiB. A loop that is slower gets more turns.
  let buffered = 0;
  for (let turns = 32; buffered < 1024 * 1024 || buffered === uploadLength; turns *= 2) {
    uploaded = Promise.withResolvers();
    const answered = uploaded.promise;
    fault.set({ syscall: "recv", action: "short", bytes: 64 * 1024, repeat: -1 });
    client.write(`POST /upload?turns=${turns} HTTP/1.1\r\nHost: x\r\nContent-Length: ${uploadLength}\r\n\r\n`);
    client.write(Buffer.alloc(uploadLength, "u"));
    buffered = await answered;
  }

  const request = `${head}\r\nHost: x\r\n\r\n`;
  const behind = "GET /third HTTP/1.1\r\nHost: x\r\n\r\n";
  // The next read of the process is the server's read of this request, and it takes the head
  // only. Over TLS the two writes are two records: the read takes the first and a part of the second.
  fault.set({ syscall: "recv", action: "short", bytes: request.length + (isTLS ? 40 : 0), repeat: 1 });
  if (isTLS) {
    client.write(request);
    client.write(behind);
  } else {
    client.write(request + behind);
  }
  await closed.promise;
  fault.clear();

  const text = received.toString("latin1");
  const body = received.subarray(text.indexOf("\r\n\r\n") + 4);
  return {
    status: text.slice(0, text.indexOf("\r\n")),
    body: body.equals(expectedBody) ? "all" : body.length,
    end,
    afterEnd,
  };
}

const results = {};
for (const shape in shapes) results[shape] = await closeOverUnreadInput(shapes[shape]);
server.stop(true);
console.log(JSON.stringify(results));
