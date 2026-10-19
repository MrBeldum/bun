// `destroy()` after the app committed AND ended a response (which, under
// `onwanttrailers`, records `trailers_pending` rather than `fin_pending`)
// must deliver it with a FIN, never retract it with a RESET_STREAM.
import { describe, expect, test } from "bun:test";
import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { connect, listen, QuicEndpoint, type SessionOptions } from "node:quic";

const keysDir = join(import.meta.dir, "..", "test", "fixtures", "keys");
const key = createPrivateKey(readFileSync(join(keysDir, "agent1-key.pem")));
const cert = readFileSync(join(keysDir, "agent1-cert.pem"));

describe("QuicStream.destroy after the app ended the send side", () => {
  test("delivers the committed response instead of retracting it with RESET_STREAM", async () => {
    await using server = await listen(
      async serverSession => {
        serverSession.onstream = (stream: any) => {
          // `onwanttrailers` throwing destroys this stream; its `closed`
          // rejects with that error. Swallow it -- the client is the subject.
          stream.closed.catch(() => {});
        };
        await serverSession.closed.catch(() => {});
      },
      {
        sni: { "*": { keys: [key], certs: [cert] } },
        transportParams: { maxIdleTimeout: 1 },
        onheaders(this: any) {
          this.sendHeaders({ ":status": "200" });
          this.writer.writeSync(new TextEncoder().encode("body"));
          this.writer.endSync();
        },
        onwanttrailers() {
          throw new Error("onwanttrailers error");
        },
      },
    );

    const client = await connect(server.address!, {
      servername: "localhost",
      verifyPeer: "manual",
      transportParams: { maxIdleTimeout: 1 },
    } as SessionOptions);
    await client.opened;

    const gotHeaders = Promise.withResolvers<string>();
    const stream = await client.createBidirectionalStream({
      headers: { ":method": "GET", ":path": "/", ":scheme": "https", ":authority": "localhost" },
      onheaders(headers: Record<string, any>) {
        gotHeaders.resolve(headers[":status"]);
      },
    });

    // Read the response body to completion. This must end with the server's
    // FIN; a RESET_STREAM here makes the iterator throw ERR_QUIC_STREAM_RESET.
    let readError: any;
    let chunks = 0;
    try {
      for await (const _ of stream) chunks++;
    } catch (e) {
      readError = e;
    }

    client.close();
    expect(readError).toBeUndefined();
    expect(chunks).toBeGreaterThan(0);
    expect(await gotHeaders.promise).toBe("200");
  });
});

// H3 header octets are latin1 on the wire (as node's StringBytes LATIN1 write
// does), not UTF-8. The send and receive halves must be exact inverses, or any
// header value >= U+0080 comes back mojibake ("é" -> "Ã©").
describe("HTTP/3 header encoding", () => {
  test("round-trips non-ASCII header values byte-for-byte", async () => {
    const VALUE = "café-ÿ";
    await using server = await listen(
      async serverSession => {
        serverSession.onstream = (stream: any) => {
          stream.closed.catch(() => {});
        };
        await serverSession.closed.catch(() => {});
      },
      {
        sni: { "*": { keys: [key], certs: [cert] } },
        transportParams: { maxIdleTimeout: 1 },
        onheaders(this: any, headers: Record<string, any>) {
          // Echo what the server decoded straight back to the client.
          this.sendHeaders({ ":status": "200", "x-echo": headers["x-name"] });
          this.writer.endSync();
        },
      },
    );

    const client = await connect(server.address!, {
      servername: "localhost",
      verifyPeer: "manual",
      transportParams: { maxIdleTimeout: 1 },
    } as SessionOptions);
    await client.opened;

    const echoed = Promise.withResolvers<string>();
    await client.createBidirectionalStream({
      headers: {
        ":method": "GET",
        ":path": "/",
        ":scheme": "https",
        ":authority": "localhost",
        "x-name": VALUE,
      },
      onheaders(headers: Record<string, any>) {
        echoed.resolve(headers["x-echo"]);
      },
    });

    expect(await echoed.promise).toBe(VALUE);
    client.close();
  });

  // U+0100 truncates to 0x00 under that same latin1 write, so a plain
  // `value.indexOf("\0")` guard never fires: the encoded value carries the
  // `name\0value\0flags` delimiters itself and splices an extra header out of
  // one user-supplied string. The declared pair count is what rejects it
  // (node/src/node_http_common-inl.h bails the same way on `n >= count_`).
  test("rejects a value whose latin1 encoding splices in an extra header", async () => {
    const seen: Record<string, string>[] = [];
    await using server = await listen(
      async serverSession => {
        serverSession.onstream = (stream: any) => {
          stream.closed.catch(() => {});
        };
        await serverSession.closed.catch(() => {});
      },
      {
        sni: { "*": { keys: [key], certs: [cert] } },
        transportParams: { maxIdleTimeout: 1 },
        onheaders(this: any, headers: Record<string, any>) {
          seen.push(headers);
          this.sendHeaders({ ":status": "200" });
          this.writer.endSync();
        },
      },
    );

    const client = await connect(server.address!, {
      servername: "localhost",
      verifyPeer: "manual",
      transportParams: { maxIdleTimeout: 1 },
    } as SessionOptions);
    await client.opened;

    const attacker = await client.createBidirectionalStream();
    expect(
      attacker.sendHeaders({
        ":method": "GET",
        ":path": "/",
        ":scheme": "https",
        ":authority": "localhost",
        // Each Ā becomes a delimiter; the Z is eaten as the first field's
        // flags byte, aligning `authorization` onto a name boundary.
        "x-name": "safeĀZauthorizationĀBearer stolenĀ",
      }),
    ).toBe(false);

    // A benign request on the same connection proves the guard is narrow and
    // orders the assertion below: h3 delivers it after anything the attacker
    // stream managed to put on the wire.
    const answered = Promise.withResolvers<void>();
    await client.createBidirectionalStream({
      headers: { ":method": "GET", ":path": "/", ":scheme": "https", ":authority": "localhost" },
      onheaders() {
        answered.resolve();
      },
    });
    await answered.promise;
    client.close();

    expect(seen.length).toBe(1);
    expect(Object.keys(seen[0])).not.toContain("authorization");
  });
});

// lsquic decodes a header block that follows another one while the stream is
// read, not when its bytes arrive. The peer in these tests writes its header
// blocks in one call, so they share one STREAM frame and that is where the
// later blocks are decoded.
describe("HTTP/3 header blocks that follow another header block", () => {
  const encoder = new TextEncoder();
  const request = (path: string) => ({
    ":method": "POST",
    ":path": path,
    ":scheme": "https",
    ":authority": "localhost",
  });
  const connectTo = async (server: QuicEndpoint) => {
    const client = await connect(server.address!, {
      servername: "localhost",
      verifyPeer: "manual",
      transportParams: { maxIdleTimeout: 1 },
    } as SessionOptions);
    await client.opened;
    return client;
  };

  // Everything the client sees on one stream, in order.
  async function responseEvents(client: any, path: string, trailers?: Record<string, string>) {
    const events: string[] = [];
    const stream = await client.createBidirectionalStream({
      oninfo: (headers: Record<string, string>) => events.push("info " + headers[":status"]),
      onheaders: (headers: Record<string, string>) => events.push("headers " + headers[":status"]),
    });
    stream.closed.catch(() => {});
    stream.sendHeaders(request(path), { terminal: trailers === undefined });
    if (trailers) stream.sendTrailers(trailers);
    for await (const batch of stream) {
      for (const chunk of batch) events.push("data " + Buffer.from(chunk).toString("latin1"));
    }
    events.push("end");
    return events;
  }

  test("a client gets two interim responses and the final response in order", async () => {
    await using server = await listen(
      async serverSession => {
        serverSession.onstream = (stream: any) => {
          stream.closed.catch(() => {});
        };
        await serverSession.closed.catch(() => {});
      },
      {
        sni: { "*": { keys: [key], certs: [cert] } },
        transportParams: { maxIdleTimeout: 1 },
        onheaders(this: any, headers: Record<string, any>) {
          this.sendInformationalHeaders({ ":status": "100" });
          this.sendInformationalHeaders({ ":status": "103", link: "</style.css>; rel=preload" });
          if (headers[":path"] === "/no-body") {
            this.sendHeaders({ ":status": "204" }, { terminal: true });
            return;
          }
          this.sendHeaders({ ":status": "200" });
          this.writer.writeSync(encoder.encode("hello"));
          this.writer.endSync();
        },
      },
    );
    const client = await connectTo(server);
    const events = { noBody: await responseEvents(client, "/no-body"), body: await responseEvents(client, "/body") };
    client.close();
    expect(events).toEqual({
      noBody: ["info 100", "info 103", "headers 204", "end"],
      body: ["info 100", "info 103", "headers 200", "data hello", "end"],
    });
  });

  test("a server gets the trailers that follow the request headers", async () => {
    let requestTrailers: Record<string, string> | undefined;
    await using server = await listen(
      async serverSession => {
        serverSession.onstream = (stream: any) => {
          stream.closed.catch(() => {});
        };
        await serverSession.closed.catch(() => {});
      },
      {
        sni: { "*": { keys: [key], certs: [cert] } },
        transportParams: { maxIdleTimeout: 1 },
        onheaders(this: any) {
          this.sendHeaders({ ":status": "200" }, { terminal: true });
        },
        ontrailers(this: any, trailers: Record<string, any>) {
          requestTrailers = trailers;
        },
      },
    );
    const client = await connectTo(server);
    // The server queues the trailers event in the lsquic callback that reads
    // the request, ahead of the packet that carries its response.
    const response = await responseEvents(client, "/trailers", { "x-checksum": "abc123" });
    client.close();
    expect({ response, requestTrailers: { ...requestTrailers } }).toEqual({
      response: ["headers 200", "end"],
      requestTrailers: { "x-checksum": "abc123" },
    });
  });
});

describe("verifyClient", () => {
  test("a server requiring a client certificate never surfaces streams from a client that presented none", async () => {
    let announcedStreams = 0;
    const serverClosed = Promise.withResolvers<any>();
    await using server = await listen(
      (serverSession: any) => {
        serverSession.onerror = () => {};
        serverSession.onstream = (stream: any) => {
          announcedStreams++;
          stream.closed.catch(() => {});
        };
        serverSession.closed.then(
          () => serverClosed.resolve(undefined),
          (err: any) => serverClosed.resolve(err),
        );
      },
      {
        sni: { "*": { keys: [key], certs: [cert] } },
        alpn: ["quic-test"],
        verifyClient: true,
        transportParams: { maxIdleTimeout: 5 },
      },
    );

    const client = await connect(server.address!, {
      alpn: "quic-test",
      servername: "localhost",
      verifyPeer: "manual",
      transportParams: { maxIdleTimeout: 5 },
      onerror() {},
    } as SessionOptions);
    const clientClosed = client.closed.then(
      () => undefined,
      (err: any) => err,
    );
    client.opened.catch(() => {});
    const stream = await client.createBidirectionalStream({ body: new TextEncoder().encode("early body") });
    stream.closed.catch(() => {});

    const [serverError, clientError] = await Promise.all([serverClosed.promise, clientClosed]);
    expect({
      announcedStreams,
      server: serverError?.code,
      client: clientError?.code,
    }).toEqual({
      announcedStreams: 0,
      server: "ERR_QUIC_TRANSPORT_ERROR",
      client: "ERR_QUIC_TRANSPORT_ERROR",
    });
  });
});

describe("headers queued before the handshake", () => {
  // The HEADERS frame of a stream created before the handshake completes
  // must leave once lsquic opens the stream, not once the writer is used.
  test("reach the server without a write to the stream", async () => {
    const gotHeaders = Promise.withResolvers<string>();
    await using server = await listen(
      async serverSession => {
        serverSession.onstream = (stream: any) => {
          stream.closed.catch(() => {});
        };
        await serverSession.closed.catch(() => {});
      },
      {
        sni: { "*": { keys: [key], certs: [cert] } },
        transportParams: { maxIdleTimeout: 1 },
        onheaders(this: any, headers: Record<string, any>) {
          gotHeaders.resolve(headers[":path"]);
        },
      },
    );

    const client = await connect(server.address!, {
      servername: "localhost",
      verifyPeer: "manual",
      transportParams: { maxIdleTimeout: 1 },
    } as SessionOptions);
    const stream = await client.createBidirectionalStream({});
    stream.closed.catch(() => {});
    stream.sendHeaders({ ":method": "POST", ":path": "/queued", ":scheme": "https", ":authority": "localhost" });

    const closed = client.closed.then(
      () => "closed",
      () => "closed",
    );
    expect(await Promise.race([gotHeaders.promise, closed])).toBe("/queued");
    client.close();
  });
});

// The limit an endpoint enforces for the streams its peer opens, and the
// window it sizes MAX_STREAMS credit from, must be the limit it advertises in
// `initialMaxStreamsBidi` / `initialMaxStreamsUni`.
describe("limits for the streams the peer opens", () => {
  const encoder = new TextEncoder();

  // One server session and one client session. The client gets an endpoint of
  // its own: lsquic settings are per engine, so a reused endpoint keeps the
  // transport parameters of its first connect(). Both sides time out after a
  // second without packets, so a stream that never opens ends the test
  // through `closed` and not through the test timeout.
  async function connectPair(clientParams: object, serverParams: object = {}, alpn = "quic-test") {
    const accepted = Promise.withResolvers<any>();
    const server = await listen(
      (session: any) => {
        session.onerror = () => {};
        session.closed.catch(() => {});
        accepted.resolve(session);
      },
      {
        sni: { "*": { keys: [key], certs: [cert] } },
        alpn: [alpn],
        transportParams: { maxIdleTimeout: 1, ...serverParams },
      },
    );
    const endpoint = new QuicEndpoint();
    const closeEndpoints = () => Promise.all([endpoint.close(), server.close()]);
    try {
      const client: any = await connect(server.address!, {
        endpoint,
        alpn,
        servername: "localhost",
        verifyPeer: "manual",
        transportParams: { maxIdleTimeout: 1, ...clientParams },
        onerror() {},
      } as SessionOptions);
      const closed: Promise<string> = client.closed.then(
        () => "client closed",
        (err: any) => `client closed: ${err?.code}`,
      );
      await client.opened;
      const serverSession = await accepted.promise;
      await serverSession.opened;
      return {
        client,
        serverSession,
        closed,
        async [Symbol.asyncDispose]() {
          client.destroy();
          serverSession.destroy();
          await closeEndpoints();
        },
      };
    } catch (err) {
      await closeEndpoints();
      throw err;
    }
  }

  const streamLimits = (params: any) => ({ bidi: params.initialMaxStreamsBidi, uni: params.initialMaxStreamsUni });

  async function readAll(stream: any) {
    const chunks: Uint8Array[] = [];
    for await (const batch of stream) chunks.push(...batch);
    return Buffer.concat(chunks).toString();
  }

  test.each([
    { kind: "bidi", limit: 1, ids: ["1", "5", "9", "13", "17", "21"] },
    { kind: "bidi", limit: 2, ids: ["1", "5", "9", "13", "17", "21"] },
    { kind: "uni", limit: 1, ids: ["3", "7", "11", "15", "19", "23"] },
    { kind: "uni", limit: 2, ids: ["3", "7", "11", "15", "19", "23"] },
  ] as const)(
    "a client that allows $limit $kind stream(s) lets the server open six, one after another",
    async ({ kind, limit, ids }) => {
      await using pair = await connectPair(
        kind === "bidi" ? { initialMaxStreamsBidi: limit } : { initialMaxStreamsUni: limit },
      );
      const { client, serverSession } = pair;
      const advertised = streamLimits(serverSession.remoteTransportParams)[kind];

      // The client reads each stream to its end. On a bidirectional stream it
      // then echoes the body and ends its own side. Credit comes back only for
      // a stream that is closed in both directions.
      const received: string[] = [];
      let readByClient: PromiseWithResolvers<void>;
      client.onstream = async (stream: any) => {
        stream.closed.catch(() => {});
        const body = await readAll(stream);
        if (kind === "bidi") {
          stream.writer.writeSync(encoder.encode(body));
          stream.writer.endSync();
        }
        received.push(`${stream.id}:${body}`);
        readByClient.resolve();
      };

      const echoes: string[] = [];
      const openSix = async () => {
        for (let i = 0; i < ids.length; i++) {
          readByClient = Promise.withResolvers<void>();
          const body = encoder.encode(`s${i}`);
          const stream =
            kind === "bidi"
              ? await serverSession.createBidirectionalStream({ body })
              : await serverSession.createUnidirectionalStream({ body });
          stream.closed.catch(() => {});
          if (kind === "bidi") echoes.push(await readAll(stream));
          await readByClient.promise;
        }
        return "opened all";
      };

      expect({
        outcome: await Promise.race([openSix().catch(err => `server failed: ${err?.code ?? err}`), pair.closed]),
        advertised,
        received,
        echoes,
      }).toEqual({
        outcome: "opened all",
        advertised: BigInt(limit),
        received: ids.map((id, i) => `${id}:s${i}`),
        echoes: kind === "bidi" ? ids.map((_, i) => `s${i}`) : [],
      });
    },
  );

  test("a client accepts every stream its limit allows when the limit is above 100", async () => {
    const limit = 120;
    await using pair = await connectPair({ initialMaxStreamsBidi: limit });
    const { client, serverSession } = pair;

    let arrived = 0;
    const allArrived = Promise.withResolvers<string>();
    const oneMoreArrived = Promise.withResolvers<string>();
    client.onstream = async (stream: any) => {
      stream.closed.catch(() => {});
      arrived++;
      if (arrived === limit) allArrived.resolve("arrived");
      if (arrived === limit + 1) oneMoreArrived.resolve("arrived");
      await readAll(stream);
      stream.writer.endSync();
    };

    // The server holds `limit` streams open at once. One byte on each makes
    // the stream visible to the client.
    const held: any[] = [];
    for (let i = 0; i < limit; i++) {
      const stream = await serverSession.createBidirectionalStream();
      stream.closed.catch(() => {});
      stream.writer.writeSync(encoder.encode("x"));
      held.push(stream);
    }
    const pendingUnderLimit = held.filter(stream => stream.pending).length;
    const oneMore = await serverSession.createBidirectionalStream({ body: encoder.encode("x") });
    oneMore.closed.catch(() => {});
    const pendingOverLimit = oneMore.pending;

    const underLimit = await Promise.race([allArrived.promise, pair.closed]);
    // Once the held streams are closed in both directions, the client returns
    // credit and the stream over the limit opens.
    if (underLimit === "arrived") {
      for (const stream of held) stream.writer.endSync();
    }
    const overLimit = await Promise.race([oneMoreArrived.promise, pair.closed]);

    expect({ pendingUnderLimit, pendingOverLimit, underLimit, overLimit, arrived }).toEqual({
      pendingUnderLimit: 0,
      pendingOverLimit: true,
      underLimit: "arrived",
      overLimit: "arrived",
      arrived: limit + 1,
    });
  });

  // 2**30 streams is 2**32 as a stream ID, the first limit that does not fit in
  // the 32 bits lsquic computed it in.
  test.each(["client", "server"] as const)(
    "a %s that allows 2**30 streams accepts the first stream of each kind",
    async advertiser => {
      const huge = { initialMaxStreamsBidi: 2 ** 30, initialMaxStreamsUni: 2 ** 30 };
      await using pair = await connectPair(advertiser === "client" ? huge : {}, advertiser === "server" ? huge : {});
      const [accepting, opening] =
        advertiser === "client" ? [pair.client, pair.serverSession] : [pair.serverSession, pair.client];
      const advertised = streamLimits(opening.remoteTransportParams);

      const bodies: string[] = [];
      const bothRead = Promise.withResolvers<string>();
      accepting.onstream = async (stream: any) => {
        stream.closed.catch(() => {});
        bodies.push(await readAll(stream));
        if (bodies.length === 2) bothRead.resolve("accepted");
      };
      const bidi = await opening.createBidirectionalStream({ body: encoder.encode("bidi") });
      bidi.closed.catch(() => {});
      const uni = await opening.createUnidirectionalStream({ body: encoder.encode("uni") });
      uni.closed.catch(() => {});

      expect({
        outcome: await Promise.race([bothRead.promise, pair.closed]),
        advertised,
        bodies: bodies.sort(),
      }).toEqual({
        outcome: "accepted",
        advertised: { bidi: 2n ** 30n, uni: 2n ** 30n },
        bodies: ["bidi", "uni"],
      });
    },
  );

  test("a client's unidirectional limit does not follow its bidirectional limit", async () => {
    await using pair = await connectPair({ initialMaxStreamsBidi: 0, initialMaxStreamsUni: 2 });
    const { client, serverSession } = pair;

    const pending: boolean[] = [];
    for (const kind of ["bidi", "uni", "uni", "uni"]) {
      const stream =
        kind === "bidi"
          ? await serverSession.createBidirectionalStream()
          : await serverSession.createUnidirectionalStream();
      stream.closed.catch(() => {});
      pending.push(stream.pending);
    }

    expect({
      local: streamLimits(client.localTransportParams),
      remote: streamLimits(serverSession.remoteTransportParams),
      pending,
    }).toEqual({
      local: { bidi: 0n, uni: 2n },
      remote: { bidi: 0n, uni: 2n },
      pending: [true, false, false, true],
    });
  });

  // lsquic's HTTP/3 client advertises three unidirectional streams (the
  // server's control stream and its two QPACK streams) whatever the option says.
  test.each([
    { label: "by default", clientParams: {} },
    { label: "with initialMaxStreamsUni set", clientParams: { initialMaxStreamsUni: 7 } },
  ])("an HTTP/3 client reports the unidirectional limit it advertises, $label", async ({ clientParams }) => {
    await using pair = await connectPair(clientParams, {}, "h3");
    expect({
      local: pair.client.localTransportParams.initialMaxStreamsUni,
      remote: pair.serverSession.remoteTransportParams.initialMaxStreamsUni,
    }).toEqual({ local: 3n, remote: 3n });
  });

  // lsquic encodes a client's transport parameters into a 128-byte buffer.
  // These values give the longest encoding node:quic can ask for.
  test("a client connects with every numeric transport parameter at its largest encoding", async () => {
    const max = 2 ** 32 - 1;
    await using pair = await connectPair({
      maxIdleTimeout: max,
      initialMaxData: max,
      initialMaxStreamDataBidiLocal: max,
      initialMaxStreamDataBidiRemote: max,
      initialMaxStreamDataUni: max,
      initialMaxStreamsBidi: max,
      initialMaxStreamsUni: max,
      maxUdpPayloadSize: 65535,
      maxDatagramFrameSize: 65535,
      disableActiveMigration: true,
    });
    expect(streamLimits(pair.serverSession.remoteTransportParams)).toEqual({ bidi: BigInt(max), uni: BigInt(max) });
  });
});
