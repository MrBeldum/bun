// A `req.signal` abort listener writes to the controller of a direct stream
// while the client's abort tears the request down. The listener runs after the
// server has given the response up, so the write must not reach it. It waits
// until the producer is told, and then answers 0.
const heard: Record<string, unknown> = {};

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    let controller: any;
    req.signal.addEventListener("abort", () => {
      heard.write = controller.write("late");
      heard.flush = controller.flush();
    });
    return new Response(
      new ReadableStream({
        type: "direct",
        async pull(c: any) {
          controller = c;
          c.write("chunk-a");
          await c.flush();
          await new Promise(() => {});
        },
        cancel(reason: unknown) {
          heard.cancel = String(reason);
        },
      } as any),
    );
  },
});

const closed = Promise.withResolvers<void>();
await Bun.connect({
  hostname: "127.0.0.1",
  port: server.port!,
  socket: {
    open(socket) {
      socket.write("GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
    },
    data(socket, data) {
      if (data.includes("chunk-a")) socket.end();
    },
    error() {},
    close() {
      closed.resolve();
    },
  },
});
await closed.promise;
// The server hears the close on a later turn of the event loop, and frees the
// socket one turn after that.
while (server.pendingRequests > 0) await new Promise(resolve => setImmediate(resolve));
await new Promise(resolve => setImmediate(resolve));

console.log(JSON.stringify({ ...heard, write: await heard.write, pendingRequests: server.pendingRequests }));
server.stop(true);
