// A TLS socket over a Duplex hands each ciphertext record to that Duplex's write() from inside its own send. A Duplex
// that emits 'drain' from write() must not make the socket send the bytes of that send again.
// The HTTP/2 side of this is in node-tls-connect.test.ts.
// Runs under node:test, so the same file runs on node (`node --test`) and on bun (`bun test`).
import assert from "node:assert";
import fs from "node:fs";
import { Duplex } from "node:stream";
import { test } from "node:test";
import tls from "node:tls";

const key = fs.readFileSync(new URL("./fixtures/agent1-key.pem", import.meta.url));
const cert = fs.readFileSync(new URL("./fixtures/agent1-cert.pem", import.meta.url));

test("a write queued before the handshake goes out once over a Duplex that emits 'drain' from write()", async () => {
  // Position-dependent bytes, so a repeated or reordered range shows up.
  const payload = Buffer.alloc(256 * 1024);
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 31 + (i >> 8)) & 0xff;

  // Two Duplexes wired to each other, so the exchange stays in this process.
  const clientSide = new Duplex({
    read() {},
    write(chunk, _encoding, callback) {
      this.emit("drain");
      serverSide.push(chunk);
      callback();
    },
    final(callback) {
      serverSide.push(null);
      callback();
    },
  });
  const serverSide = new Duplex({
    read() {},
    write(chunk, _encoding, callback) {
      clientSide.push(chunk);
      callback();
    },
    final(callback) {
      clientSide.push(null);
      callback();
    },
  });

  const received = [];
  const { promise: ended, resolve, reject } = Promise.withResolvers();
  const server = new tls.TLSSocket(serverSide, { isServer: true, key, cert });
  server.on("error", reject);
  // A no-op after 'end' has resolved.
  server.on("close", () => reject(new Error("the server socket closed before 'end'")));
  server.on("data", chunk => received.push(chunk));
  server.on("end", () => {
    server.end();
    resolve();
  });

  const client = tls.connect({ socket: clientSide, rejectUnauthorized: false });
  client.on("error", reject);
  // The handshake has not started yet, so the payload waits and the flush after the handshake sends it.
  client.write(payload, () => client.end());

  await ended;
  const all = Buffer.concat(received);
  assert.strictEqual(all.length, payload.length);
  assert.ok(all.equals(payload));
});
