import { describe, expect, test } from "bun:test";
import { bunEnv, bunExe, isASAN, isDebug, isWindows, tempDir } from "harness";
import { mkfifo } from "mkfifo";
import { exec } from "node:child_process";
import { closeSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";

test.concurrent("pipe does the right thing", async () => {
  // Note: Bun.spawnSync uses memfd_create on Linux for pipe, which means we see
  // it as a file instead of a tty
  const result = Bun.spawn({
    cmd: [bunExe(), "-e", "console.log(typeof process.stdin.ref)"],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
    env: bunEnv,
  });

  expect((await new Response(result.stdout).text()).trim()).toBe("function");
  expect(await result.exited).toBe(0);
});

test.concurrent("file does the right thing", async () => {
  const result = Bun.spawn({
    cmd: [bunExe(), "-e", "console.log(typeof process.stdin.ref)"],
    stdin: Bun.file(import.meta.path),
    stdout: "pipe",
    stderr: "pipe",
    env: bunEnv,
  });

  expect(await result.stdout.text()).toMatchInlineSnapshot(`
    "undefined
    "
  `);
  expect(await result.stderr.text()).toMatchInlineSnapshot(`""`);
  expect(await result.exited).toBe(0);
});

test.concurrent("stdin with 'readable' event handler should receive data when paused", async () => {
  const proc = Bun.spawn({
    cmd: [
      bunExe(),
      "-e",
      `
      const handleReadable = () => {
        let chunk;
        while ((chunk = process.stdin.read())) {
          console.log("got chunk", JSON.stringify(chunk));
        }
      };
      
      process.stdin.on("readable", handleReadable);
      process.stdin.pause();
      
      setTimeout(() => {
        process.exit(1);
      }, 1000);
      `,
    ],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: bunEnv,
  });

  proc.stdin.write("abc\n");
  proc.stdin.write("def\n");
  proc.stdin.end();

  await proc.exited;

  expect(await proc.stdout.text()).toMatchInlineSnapshot(`
    "got chunk {"type":"Buffer","data":[97,98,99,10,100,101,102,10]}
    "
  `);
  expect(await proc.stderr.text()).toMatchInlineSnapshot(`""`);
  expect(proc.exitCode).toBe(1);
});

test.concurrent("stdin with 'data' event handler should NOT receive data when paused", async () => {
  const proc = Bun.spawn({
    cmd: [
      bunExe(),
      "-e",
      `
      const handleData = chunk => {
        console.log("got chunk");
      };
      
      process.stdin.on("data", handleData);
      process.stdin.pause();
      
      setTimeout(() => {
        process.exit(1);
      }, 1000);
      `,
    ],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: bunEnv,
  });

  proc.stdin.write("abc\n");
  proc.stdin.write("def\n");
  proc.stdin.end();

  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

  expect(stdout).toMatchInlineSnapshot(`""`);
  expect(await proc.stderr.text()).toMatchInlineSnapshot(`""`);
  // Reusing the already-consumed stdout stream now rejects (the stream is disturbed).
  await expect(proc.stdout.text()).rejects.toThrow("ReadableStream has already been used");
  expect(exitCode).toBe(1);
});

// Drains the child; its stderr joins the comparison only when it failed, so a
// crash shows up in the diff without asserting stderr empty on success (debug
// builds write benign noise there).
type StdioResult = { stdout: string; exitCode: number; stderr?: string };
async function stdioResult(proc: Bun.Subprocess<"pipe", "pipe", "pipe">): Promise<StdioResult> {
  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  return { stdout, exitCode, stderr: exitCode === 0 ? undefined : stderr };
}

// A write to a child that is already gone fails with EPIPE. The assertions on the child's output cover that case.
function ignoreEpipe(err: any) {
  if (err?.code !== "EPIPE") throw err;
}

test.concurrent("paused mode read(n) returns the buffered remainder at EOF", async () => {
  // 8 bytes pulled 3 at a time: the final read(3) must return the 2 byte tail
  // once EOF is reached, and 'end' must mark readableEnded.
  const proc = Bun.spawn({
    cmd: [
      bunExe(),
      "-e",
      `const chunks = [];
      process.stdin.on("readable", () => {
        let chunk;
        while ((chunk = process.stdin.read(3)) !== null) chunks.push(chunk.toString());
      });
      process.stdin.on("end", () => {
        console.log(JSON.stringify({ chunks, readableEnded: process.stdin.readableEnded }));
      });`,
    ],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: bunEnv,
  });
  proc.stdin.write("abcdefgh");
  proc.stdin.end();

  expect(await stdioResult(proc)).toEqual({
    stdout: JSON.stringify({ chunks: ["abc", "def", "gh"], readableEnded: true }) + "\n",
    exitCode: 0,
  });
});

test.concurrent("explicit read(n) with no 'readable' listener still pulls from stdin", async () => {
  // read() must start the underlying stdin reader even when no 'readable'
  // listener or resume() ever ran.
  const proc = Bun.spawn({
    cmd: [
      bunExe(),
      "-e",
      `const chunks = [];
      process.stdin.on("end", () => {
        console.log(JSON.stringify({ chunks, readableEnded: process.stdin.readableEnded }));
      });
      let spins = 0;
      function poll() {
        let chunk;
        while ((chunk = process.stdin.read(3)) !== null) chunks.push(chunk.toString());
        if (process.stdin.readableEnded) return;
        // Bounded so a regression fails with output instead of spinning forever.
        if (++spins > 20000) {
          console.log(JSON.stringify({ chunks, readableEnded: false }));
          process.exit(1);
        }
        setImmediate(poll);
      }
      poll();`,
    ],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: bunEnv,
  });
  proc.stdin.write("abcdefgh");
  proc.stdin.end();

  expect(await stdioResult(proc)).toEqual({
    stdout: JSON.stringify({ chunks: ["abc", "def", "gh"], readableEnded: true }) + "\n",
    exitCode: 0,
  });
});

test.concurrent("a read() that throws does not keep the process alive", async () => {
  // stdin stays open for the child's whole lifetime: it only exits if the
  // failed read did not start (and ref) the native stdin reader.
  const proc = Bun.spawn({
    cmd: [
      bunExe(),
      "-e",
      `let code = "";
      try {
        process.stdin.read(2 ** 31);
      } catch (err) {
        code = err.code;
      }
      process.on("exit", () => console.log(code));`,
    ],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: bunEnv,
  });

  const result = await stdioResult(proc);
  proc.stdin.end();
  expect(result).toEqual({ stdout: "ERR_OUT_OF_RANGE\n", exitCode: 0 });
});

test.concurrent("touching stdin again after 'end' does not keep the process alive", async () => {
  const proc = Bun.spawn({
    cmd: [
      bunExe(),
      "-e",
      `process.stdin.on("data", () => {});
      process.stdin.on("end", () => {
        console.log("END");
        process.stdin.resume();
        process.stdin.ref();
        process.stdin.on("readable", () => {});
      });
      process.on("exit", () => console.log("EXIT"));`,
    ],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: bunEnv,
  });
  proc.stdin.write("abcdefgh");
  proc.stdin.end();

  expect(await stdioResult(proc)).toEqual({ stdout: "END\nEXIT\n", exitCode: 0 });
});

test.concurrent("resume() after 'end' does not reset readableEnded", async () => {
  const proc = Bun.spawn({
    cmd: [
      bunExe(),
      "-e",
      `const stdin = process.stdin;
      let ends = 0;
      stdin.on("data", () => {});
      stdin.on("end", () => {
        ends++;
        stdin.pause();
        stdin.resume();
        // One macrotask later the 'resume' event has run.
        setImmediate(() => {
          console.log(JSON.stringify({ ends, readableEnded: stdin.readableEnded, destroyed: stdin.destroyed }));
        });
      });`,
    ],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: bunEnv,
  });
  proc.stdin.write("abcdefgh");
  proc.stdin.end();

  expect(await stdioResult(proc)).toEqual({
    stdout: JSON.stringify({ ends: 1, readableEnded: true, destroyed: true }) + "\n",
    exitCode: 0,
  });
});

test.concurrent("'end' is not emitted when the buffer is never drained, and the process still exits", async () => {
  const proc = Bun.spawn({
    cmd: [
      bunExe(),
      "-e",
      `process.stdin.on("readable", () => {});
      process.stdin.on("end", () => console.log("END"));
      process.on("exit", () => console.log("EXIT " + process.stdin.readableLength));`,
    ],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: bunEnv,
  });
  proc.stdin.write("abcdefgh");
  proc.stdin.end();

  expect(await stdioResult(proc)).toEqual({ stdout: "EXIT 8\n", exitCode: 0 });
});

test.concurrent("resuming after EOF is buffered behind unread data still delivers the data and 'end'", async () => {
  // A consumer that pauses in 'data' and resumes later reaches this state when
  // the pipe closes in between. The child builds it without the race: it reads
  // nothing until push(null) has run, then switches to flowing mode.
  const proc = Bun.spawn({
    cmd: [
      bunExe(),
      "-e",
      `const stdin = process.stdin;
      const result = { buffered: 0, data: "", end: false };
      stdin.on("readable", function onReadable() {
        // EOF always emits 'readable'.
        if (!stdin._readableState.ended) return;
        result.buffered = stdin.readableLength;
        stdin.removeListener("readable", onReadable);
        stdin.on("data", chunk => (result.data += chunk));
        stdin.on("end", () => (result.end = true));
      });
      process.on("exit", () => console.log(JSON.stringify({ ...result, readableEnded: stdin.readableEnded })));`,
    ],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: bunEnv,
  });
  proc.stdin.write("abcdefgh");
  proc.stdin.end();

  expect(await stdioResult(proc)).toEqual({
    stdout: JSON.stringify({ buffered: 8, data: "abcdefgh", end: true, readableEnded: true }) + "\n",
    exitCode: 0,
  });
});

// process.stdin.destroy() is final. It releases the native reader, whatever listeners
// exist, and nothing takes the reader back. In each case the parent holds the writer of
// fd 0 open until the child is gone, so a child that exits did so because stdin let go
// of the event loop and not because of EOF.
describe("destroy()", () => {
  const kinds = isWindows ? (["pipe", "tty", "file"] as const) : (["pipe", "fifo", "tty", "file"] as const);
  type Kind = (typeof kinds)[number];
  // Pipe, socket and TTY stdin. File stdin does not hold the event loop.
  const socketLike = kinds.filter(kind => kind !== "file");
  type Feed = (data: string) => void;
  type Child = Bun.Subprocess<Bun.SpawnOptions.Writable, "pipe", "pipe">;

  // The child reports once, when it exits.
  function child(body: string) {
    return `
      const stdin = process.stdin;
      const events = [];
      const onData = () => events.push("data");
      const onReadable = () => events.push("readable");
      const onClose = () => events.push("close");
      process.on("uncaughtException", err => events.push("uncaught " + err.message));
      ${body}
      // Nothing reports that stdin still holds the event loop. This timer is unref'd,
      // so it only fires if something else keeps the process alive.
      setTimeout(() => {
        events.push("STILL_ALIVE");
        process.exit(1);
      }, 1500).unref();
      process.on("exit", () => console.log("RESULT " + JSON.stringify({ events, destroyed: stdin.destroyed })));
    `;
  }

  function report(output: string, stderr: string, proc: Bun.Subprocess) {
    const result = output.match(/RESULT (\{[^}]*\})/);
    // A child that did not report shows its raw output in the diff.
    return {
      ...(result ? JSON.parse(result[1]) : { output, stderr }),
      exitCode: proc.exitCode,
      signalCode: proc.signalCode,
    };
  }

  // Calls `onReady` when the child prints READY.
  async function collect(proc: Child, feed?: Feed, onReady?: (feed: Feed, proc: Child) => void) {
    let stdout = "";
    const decoder = new TextDecoder();
    const drain = async () => {
      for await (const chunk of proc.stdout) {
        stdout += decoder.decode(chunk, { stream: true });
        if (feed && onReady && stdout.includes("READY")) {
          onReady(feed, proc);
          onReady = undefined;
        }
      }
    };
    const [stderr] = await Promise.all([proc.stderr.text(), drain(), proc.exited]);
    return report(stdout, stderr, proc);
  }

  async function run(kind: Kind, body: string, onReady?: (feed: Feed, proc: Child) => void) {
    const cmd = [bunExe(), "-e", child(body)];
    if (kind === "pipe") {
      await using proc = Bun.spawn({ cmd, stdin: "pipe", stdout: "pipe", stderr: "pipe", env: bunEnv });
      const feed: Feed = data => {
        try {
          Promise.resolve(proc.stdin.write(data)).catch(ignoreEpipe);
          Promise.resolve(proc.stdin.flush()).catch(ignoreEpipe);
        } catch (err) {
          ignoreEpipe(err);
        }
      };
      return await collect(proc, feed, onReady);
    }
    if (kind === "tty") {
      let output = "";
      const decoder = new TextDecoder();
      const reported = Promise.withResolvers<void>();
      await using proc = Bun.spawn({
        cmd,
        env: bunEnv,
        terminal: {
          // Wide enough that ConPTY does not hard-wrap the RESULT line.
          cols: 200,
          rows: 24,
          data(_terminal, chunk) {
            output += decoder.decode(chunk, { stream: true });
            if (/RESULT \{[^}]*\}/.test(Bun.stripANSI(output))) reported.resolve();
          },
          exit() {
            reported.resolve();
          },
        },
      });
      await Promise.all([reported.promise, proc.exited]);
      proc.terminal?.close();
      // ConPTY puts VT sequences and CR around the line.
      return report(Bun.stripANSI(output).replace(/[\r\n]/g, ""), "", proc);
    }
    using dir = tempDir("stdin-destroy", { "input.txt": "hello\n" });
    if (kind === "file") {
      const stdin = Bun.file(join(String(dir), "input.txt"));
      await using proc = Bun.spawn({ cmd, stdin, stdout: "pipe", stderr: "pipe", env: bunEnv });
      return await collect(proc);
    }
    const fifo = join(String(dir), "fifo");
    mkfifo(fifo);
    // Read-write: the open does not wait for a writer, and the parent is one.
    const fd = openSync(fifo, "r+");
    try {
      const env = { ...bunEnv, STDIN_FIFO: fifo };
      await using proc = Bun.spawn({ cmd, stdin: fd, stdout: "pipe", stderr: "pipe", env });
      return await collect(proc, data => void writeSync(fd, data), onReady);
    } finally {
      closeSync(fd);
    }
  }

  const arming = {
    "on('data')": `stdin.on("data", onData);`,
    "on('readable')": `stdin.on("readable", onReadable);`,
    "resume()": `stdin.resume();`,
    "ref()": `stdin.ref();`,
    "read(n)": `stdin.read(1);`,
  };
  // [title, stdin kinds, code, events]
  const releases: [string, readonly Kind[], string, string[]][] = [];
  for (const [name, arm] of Object.entries(arming)) {
    // File stdin has no ref().
    const armKinds = name === "ref()" ? socketLike : kinds;
    releases.push([
      `${name} then destroy()`,
      armKinds,
      `stdin.on("close", onClose); ${arm} stdin.destroy();`,
      ["close"],
    ]);
    releases.push([
      `${name} then destroy(err)`,
      armKinds,
      `${arm} stdin.destroy(new Error("mine"));`,
      ["uncaught mine"],
    ]);
  }
  // These paths are the same JavaScript for every socket-like kind. The TTY class has its own constructor.
  const pipeAndTty = ["pipe", "tty"] as const;
  releases.push(
    [
      "resume(), removeAllListeners() then destroy()",
      pipeAndTty,
      `stdin.resume(); stdin.removeAllListeners(); stdin.destroy();`,
      [],
    ],
    [
      "on('data'), removeAllListeners('close') then destroy()",
      pipeAndTty,
      `stdin.on("data", onData); stdin.removeAllListeners("close"); stdin.destroy();`,
      [],
    ],
    [
      "on('data'), destroy() then removeAllListeners()",
      pipeAndTty,
      `stdin.on("data", onData); stdin.destroy(); stdin.removeAllListeners();`,
      [],
    ],
    [
      "destroy(err) with an 'error' listener that throws",
      pipeAndTty,
      `stdin.on("error", () => { throw new Error("from error listener"); });
       stdin.on("data", onData);
       stdin.destroy(new Error("mine"));`,
      ["uncaught from error listener"],
    ],
    [
      "destroy() with a 'close' listener that throws",
      pipeAndTty,
      `stdin.prependListener("close", () => { throw new Error("from close listener"); });
       stdin.on("data", onData);
       stdin.destroy();`,
      ["uncaught from close listener"],
    ],
    [
      "on('data') then push(null)",
      pipeAndTty,
      `stdin.on("end", () => events.push("end")); stdin.on("data", onData); stdin.push(null);`,
      ["end"],
    ],
    [
      "on('data'), emit('end') then destroy()",
      pipeAndTty,
      `stdin.on("data", onData); stdin.emit("end"); stdin.destroy();`,
      [],
    ],
    [
      "destroy(err) after the first turn",
      pipeAndTty,
      `stdin.on("data", onData); setImmediate(() => stdin.destroy(new Error("mine")));`,
      ["uncaught mine"],
    ],
    [
      "destroy() then removeAllListeners() after the first turn",
      pipeAndTty,
      `stdin.on("data", onData); setImmediate(() => { stdin.destroy(); stdin.removeAllListeners(); });`,
      [],
    ],
    // The four ways to take the native reader, and the listener that starts the flow.
    [
      "destroy() then resume()",
      ["pipe"],
      `stdin.on("data", onData); stdin.destroy(); setImmediate(() => stdin.resume());`,
      [],
    ],
    [
      "destroy() then ref()",
      ["pipe"],
      `stdin.on("data", onData); stdin.destroy(); setImmediate(() => stdin.ref());`,
      [],
    ],
    [
      "destroy() then read(n)",
      ["pipe"],
      `stdin.on("data", onData); stdin.destroy(); setImmediate(() => stdin.read(5));`,
      [],
    ],
    [
      "destroy() then on('readable')",
      ["pipe"],
      `stdin.destroy(); setImmediate(() => stdin.on("readable", onReadable));`,
      [],
    ],
    ["destroy() then on('data')", ["pipe"], `stdin.destroy(); setImmediate(() => stdin.on("data", onData));`, []],
  );

  test.concurrent.each(
    releases.flatMap(([title, rowKinds, body, events]) => rowKinds.map(kind => [kind, title, body, events] as const)),
  )("%s stdin: %s lets the process exit", async (kind, _title, body, events) => {
    expect(await run(kind, body)).toEqual({ events, destroyed: true, exitCode: 0, signalCode: null });
  });

  test.concurrent.each(kinds)("%s stdin: destroy() in the first turn runs _destroy before it returns", async kind => {
    // File stdin opens like any fs.ReadStream, so its _destroy waits for the construct ticks, as in Node.
    const sync = kind !== "file";
    const body = `
      let called = false;
      stdin.on("data", onData);
      stdin.destroy(null, () => { called = true; });
      events.push("callback=" + called, "closed=" + stdin.closed);
    `;
    expect(await run(kind, body)).toEqual({
      events: [`callback=${sync}`, `closed=${sync}`],
      destroyed: true,
      exitCode: 0,
      signalCode: null,
    });
  });

  test.concurrent.each(kinds)("%s stdin: on('data') after destroy() does not start the flow", async kind => {
    const body = `
      stdin.on("resume", () => events.push("resume"));
      stdin.destroy();
      stdin.on("data", onData);
      events.push("flowing=" + stdin.readableFlowing);
    `;
    expect(await run(kind, body)).toEqual({ events: ["flowing=null"], destroyed: true, exitCode: 0, signalCode: null });
  });

  test.concurrent("emit('close') by the user does not destroy stdin", async () => {
    const body = `
      stdin.on("data", chunk => {
        events.push("data " + chunk + " destroyed=" + stdin.destroyed);
        stdin.destroy();
      });
      stdin.emit("close");
      console.log("READY");
    `;
    expect(await run("pipe", body, feed => feed("hello"))).toEqual({
      events: ["data hello destroyed=false"],
      destroyed: true,
      exitCode: 0,
      signalCode: null,
    });
  });

  test.concurrent("destroy(err) with no 'error' listener and no uncaughtException handler is fatal", async () => {
    await using proc = Bun.spawn({
      cmd: [
        bunExe(),
        "-e",
        `process.stdin.on("data", () => {});
        process.stdin.destroy(new Error("mine"));
        process.on("exit", code => console.log("exit " + code));`,
      ],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: bunEnv,
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect(stdout).toBe("exit 1\n");
    expect(stderr).toContain("error: mine");
    expect(exitCode).toBe(1);
    expect(proc.signalCode).toBeNull();
  });

  // destroy() on a process.stdin that never read must not pause the source that Bun.stdin shares with it.
  describe.each(socketLike.filter(kind => kind !== "tty"))("%s stdin: Bun.stdin.stream() reads", kind => {
    test.concurrent.each([
      ["destroy()", `stdin.destroy();`, ["read hello"]],
      ["destroy(err)", `stdin.destroy(new Error("mine"));`, ["uncaught mine", "read hello"]],
    ] as const)("after %s on a process.stdin that never read", async (_title, destroy, events) => {
      const body = `
        ${destroy}
        setImmediate(async () => {
          const read = Bun.stdin.stream().getReader().read();
          console.log("READY");
          events.push("read " + Buffer.from((await read).value));
          process.exit(0);
        });
      `;
      expect(await run(kind, body, feed => feed("hello"))).toEqual({
        events: [...events],
        destroyed: true,
        exitCode: 0,
        signalCode: null,
      });
    });
  });

  describe.skipIf(isWindows)("POSIX", () => {
    // numPolls counts the polls of the event loop. On Windows the same field is libuv's active handle count.
    test.concurrent.each(["pipe", "fifo", "tty"] as const)(
      "%s stdin: destroy(err) removes the poll on fd 0",
      async kind => {
        const body = `
        const { getEventLoopStats } = require("bun:internal-for-testing");
        const idle = getEventLoopStats().numPolls;
        stdin.on("data", onData);
        const armed = getEventLoopStats().numPolls;
        stdin.destroy(new Error("mine"));
        events.push("armed=+" + (armed - idle), "destroyed=+" + (getEventLoopStats().numPolls - idle));
      `;
        expect(await run(kind, body)).toEqual({
          events: ["armed=+1", "destroyed=+0", "uncaught mine"],
          destroyed: true,
          exitCode: 0,
          signalCode: null,
        });
      },
    );

    test.concurrent("bytes written after destroy(err) stay in the pipe", async () => {
      const body = `
        const fs = require("node:fs");
        // The process outlives its stdin, as a server does.
        const alive = setInterval(() => {}, 1000);
        stdin.on("data", onData);
        stdin.destroy(new Error("mine"));
        process.on("SIGUSR2", () => {
          // The bytes were written before the signal. Two more turns of the loop: a reader that still watched fd 0 has taken them.
          setImmediate(() => setImmediate(() => {
            const fd = fs.openSync(process.env.STDIN_FIFO, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
            const buffer = Buffer.alloc(16);
            try {
              events.push("left " + buffer.toString("utf8", 0, fs.readSync(fd, buffer)));
            } catch (err) {
              events.push("left " + err.code);
            }
            clearInterval(alive);
          }));
        });
        console.log("READY");
      `;
      const onReady = (feed: Feed, proc: Child) => {
        feed("later");
        proc.kill("SIGUSR2");
      };
      expect(await run("fifo", body, onReady)).toEqual({
        events: ["uncaught mine", "left later"],
        destroyed: true,
        exitCode: 0,
        signalCode: null,
      });
    });
  });
});

test.concurrent("stdin should allow process to exit when paused", async () => {
  const proc = Bun.spawn({
    cmd: [
      bunExe(),
      "-e",
      `
        process.stdin.on("data", () => {});
        process.stdin.pause();
      `,
    ],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: bunEnv,
  });

  await proc.exited;
  expect(await proc.stdout.text()).toMatchInlineSnapshot(`""`);
  expect(await proc.stderr.text()).toMatchInlineSnapshot(`""`);
  expect(proc.exitCode).toBe(0);
});

test.concurrent("stdin should not allow process to exit when not paused", async () => {
  const proc = Bun.spawn({
    cmd: [
      bunExe(),
      "-e",
      `
      process.stdin.on("data", () => {});
      `,
    ],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: bunEnv,
  });

  await Bun.sleep(1000);
  expect(proc.exitCode).toBe(null);
  proc.kill();
  await proc.exited;
  expect(await proc.stdout.text()).toMatchInlineSnapshot(`""`);
  expect(await proc.stderr.text()).toMatchInlineSnapshot(`""`);
});

// unref() drops stdin's hold on the event loop and ref() takes it back: after
// the pair the child has nothing else pending and must still receive every
// later byte up to EOF.
test.concurrent("stdin.ref() after unref() keeps the process alive until EOF", async () => {
  await using proc = Bun.spawn({
    cmd: [
      bunExe(),
      "-e",
      `
      let total = 0;
      process.stdin.on("data", chunk => {
        if (total === 0) {
          process.stdin.unref();
          process.stdin.ref();
          process.stdout.write("ready\\n");
        }
        total += chunk.length;
      });
      process.stdin.on("end", () => {
        process.stdout.write("TOTAL " + total + "\\n");
      });
      `,
    ],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: bunEnv,
  });
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let stdout = "";
  proc.stdin.write("x");
  while (!stdout.includes("ready\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    stdout += decoder.decode(value);
  }
  // The child is idle again with only stdin to wait for; these bytes must still reach it.
  const rest = Buffer.alloc(64 * 1024, "y");
  proc.stdin.write(rest);
  await proc.stdin.end();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    stdout += decoder.decode(value);
  }
  const [stderr, exitCode] = await Promise.all([proc.stderr.text(), proc.exited]);
  expect(stderr).toBe("");
  expect(stdout).toBe(`ready\nTOTAL ${1 + rest.length}\n`);
  expect(exitCode).toBe(0);
});

test.concurrent("a throw from a 'data' listener is an uncaughtException, and stdin keeps reading", async () => {
  await using proc = Bun.spawn({
    cmd: [
      bunExe(),
      "-e",
      `const seen = [];
      process.on("uncaughtException", (e, origin) => seen.push("uncaughtException:" + e.message + ":" + origin));
      process.stdin.on("error", e => seen.push("stream-error:" + e.message));
      let n = 0;
      process.stdin.on("data", d => {
        seen.push("data:" + d.toString());
        if (++n === 1) { console.log("GOT1"); throw new Error("handler-throw"); }
      });
      process.stdin.on("end", () => {
        console.log(JSON.stringify({ seen, destroyed: process.stdin.destroyed }));
      });`,
    ],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: bunEnv,
  });
  proc.stdin.write("one");
  await proc.stdin.flush();
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let stdout = "";
  for (let r; !(r = await reader.read()).done;) {
    stdout += decoder.decode(r.value, { stream: true });
    if (stdout.includes("GOT1")) break;
  }
  proc.stdin.write("two");
  await proc.stdin.end();
  for (let r; !(r = await reader.read()).done;) stdout += decoder.decode(r.value, { stream: true });

  const [stderr, exitCode] = await Promise.all([proc.stderr.text(), proc.exited]);
  expect({ stdout, exitCode, ...(exitCode === 0 ? {} : { stderr }) }).toEqual({
    stdout:
      "GOT1\n" +
      JSON.stringify({
        seen: ["data:one", "uncaughtException:handler-throw:uncaughtException", "data:two"],
        destroyed: false,
      }) +
      "\n",
    exitCode: 0,
  });
});

test.concurrent("a throw from a 'readable' listener is an uncaughtException, including the EOF emission", async () => {
  await using proc = Bun.spawn({
    cmd: [
      bunExe(),
      "-e",
      `const seen = [];
      process.on("uncaughtException", e => seen.push("uncaughtException:" + e.message));
      process.stdin.on("error", e => seen.push("stream-error:" + e.message));
      let n = 0;
      process.stdin.on("readable", () => {
        n++;
        let chunk;
        while ((chunk = process.stdin.read()) !== null) seen.push("readable:" + chunk.toString());
        throw new Error("readable-throw-" + n);
      });
      process.stdin.on("end", () => seen.push("end"));
      process.on("exit", () => console.log(JSON.stringify(seen)));`,
    ],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: bunEnv,
  });
  proc.stdin.write("hello");
  await proc.stdin.end();

  expect(await stdioResult(proc)).toEqual({
    stdout:
      JSON.stringify([
        "readable:hello",
        "uncaughtException:readable-throw-1",
        "end",
        "uncaughtException:readable-throw-2",
      ]) + "\n",
    exitCode: 0,
  });
});

test.concurrent("pause() and resume() churn while data is in flight never destroys stdin", async () => {
  await using proc = Bun.spawn({
    cmd: [
      bunExe(),
      "-e",
      `
      let total = 0;
      process.stdin.on("data", d => { total += d.length; });
      process.stdin.on("error", err => { console.log("ERROR " + (err?.code || err?.message)); process.exit(1); });
      process.stdin.on("end", () => { console.log("TOTAL " + total); });
      const churn = setInterval(() => { process.stdin.pause(); process.stdin.resume(); }, 5);
      churn.unref();
      `,
    ],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: bunEnv,
  });
  for (let i = 0; i < 20; i++) {
    proc.stdin.write("x".repeat(1024));
    await Bun.sleep(10);
  }
  await proc.stdin.end();
  const [stdout, exitCode] = await Promise.all([proc.stdout.text(), proc.exited]);
  expect(stdout.trim()).toBe(`TOTAL ${20 * 1024}`);
  expect(exitCode).toBe(0);
});

// The native FileReader source over a pollable pipe used to drain the fd to
// EAGAIN regardless of JS demand, so an idle consumer still ingested the whole
// pipe into an internal buffer. The kernel pipe buffer filling up is the
// backpressure signal; these tests feed far more than that and check the
// child's resident set does not grow to match.
describe.skipIf(isWindows)("pipe backpressure", () => {
  const feedMB = 40;
  // With no backpressure the child buffers the whole feed (Vec growth roughly
  // doubles that in RSS). With backpressure only the highwater mark plus the
  // kernel pipe buffer are resident in the child.
  const maxDeltaMB = isASAN || isDebug ? 24 : 16;

  async function run(consumer: string) {
    await using proc = Bun.spawn({
      cmd: [bunExe(), "-e", consumer],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: bunEnv,
    });
    // The child exits under backpressure having accepted only a few KB, so
    // the queued writes here fail with EPIPE; that is the expected outcome.
    const chunk = Buffer.alloc(1024 * 1024, 0x78);
    for (let i = 0; i < feedMB; i++) {
      const r = proc.stdin.write(chunk);
      if (r && typeof (r as any).then === "function") (r as Promise<number>).catch(ignoreEpipe);
    }
    Promise.resolve(proc.stdin.flush()).catch(ignoreEpipe);
    Promise.resolve(proc.stdin.end()).catch(ignoreEpipe);
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect(stderr).toBe("");
    const result = JSON.parse(stdout.trim());
    expect(exitCode).toBe(0);
    return result;
  }

  test.concurrent("Bun.stdin.stream(): a single read does not ingest the whole pipe", async () => {
    const { first, deltaMB } = await run(`
      const rss = process.memoryUsage.rss;
      const rd = Bun.stdin.stream().getReader();
      const c = await rd.read();
      const base = rss();
      // Give the event loop time to (incorrectly) drain the pipe. The loop is
      // native (no JS on the no-pending path), so debug/ASAN overhead is small.
      await new Promise(r => setTimeout(r, 1500));
      const deltaMB = Math.round((rss() - base) / 1048576);
      process.stdout.write(JSON.stringify({ first: c.value?.length ?? 0, deltaMB }));
      process.exit(0);
    `);
    expect(first).toBeGreaterThan(0);
    expect(deltaMB).toBeLessThan(maxDeltaMB);
  });

  test.concurrent("process.stdin.pause() stops the fd from being read", async () => {
    const { bytesAfter, deltaMB } = await run(`
      const rss = process.memoryUsage.rss;
      let bytes = 0, pausedAt = 0;
      process.stdin.on("data", chunk => {
        bytes += chunk.length;
        if (!pausedAt && bytes >= 1 << 20) {
          pausedAt = bytes;
          process.stdin.pause();
          const base = rss();
          setTimeout(() => {
            const deltaMB = Math.round((rss() - base) / 1048576);
            process.stdout.write(JSON.stringify({ bytesAtPause: pausedAt, bytesAfter: bytes, deltaMB }));
            process.exit(0);
          }, 1500);
        }
      });
    `);
    expect(bytesAfter).toBeLessThan(feedMB * 1024 * 1024);
    expect(deltaMB).toBeLessThan(maxDeltaMB);
  });

  // Stopped at the backstop, the reader's one-shot poll is left unarmed until
  // the next read, so it can observe nothing (not even the writer going away)
  // and must not keep the event loop alive on its own. Node behaves the same:
  // readStop() at the highWaterMark leaves the handle inactive.
  test.concurrent("a reader stopped at the highwater backstop does not keep the process alive", async () => {
    const { first } = await run(`
      const rd = Bun.stdin.stream().getReader();
      const c = await rd.read();
      process.stdout.write(JSON.stringify({ first: (c.value?.length ?? 0) > 0 }));
      // No further read and no exit(): once the backstop engages nothing is pending.
    `);
    expect(first).toBe(true);
  });

  // The same over an anonymous pipe (the blocking-pipe read path; Bun.spawn
  // stdio above is a socketpair). The writer keeps the pipe full until the
  // reader is gone, so EOF can never be what lets the reader exit.
  test.concurrent("over a shell pipe, a reader stopped at the backstop does not keep the process alive", async () => {
    using dir = tempDir("stdin-backstop-pipe", {
      "writer.js": `
        const chunk = Buffer.alloc(65536, 0x78);
        process.stdout.on("error", () => process.exit(0));
        (function pump() {
          while (process.stdout.write(chunk)) {}
          process.stdout.once("drain", pump);
        })();
      `,
      "reader.js": `
        const reader = Bun.stdin.stream().getReader();
        const { value } = await reader.read();
        process.on("exit", () => console.log("EXIT"));
        console.log("FIRST " + (value.byteLength > 0));
      `,
    });
    const { promise, resolve } = Promise.withResolvers<{ err: Error | null; stdout: string; stderr: string }>();
    exec(
      `"${bunExe()}" writer.js | "${bunExe()}" reader.js`,
      { cwd: String(dir), env: bunEnv },
      (err, stdout, stderr) => resolve({ err, stdout, stderr }),
    );
    expect(await promise).toEqual({ err: null, stdout: "FIRST true\nEXIT\n", stderr: "" });
  });

  // Stopping unregisters a fired one-shot poll without a syscall, which leaves
  // its disarmed registration in the kernel. Cancelling the stream must still
  // take it out: fd 0 stays open, and the next poll on it would hit EEXIST.
  test.concurrent("a reader cancelled at the highwater backstop frees fd 0 for the next reader", async () => {
    const { second } = await run(`
      const { getEventLoopStats } = require("bun:internal-for-testing");
      // Not top-level await: an unsettled entry-module promise would keep the process alive by itself.
      (async () => {
        const reader = Bun.stdin.stream().getReader();
        await reader.read();
        // The parent keeps the pipe full, so the reader soon stops and lets go of the loop.
        while (getEventLoopStats().loopActive) await new Promise(resolve => setImmediate(resolve));
        await reader.cancel();
        const next = await Bun.file(0).stream().getReader().read();
        process.stdout.write(JSON.stringify({ second: (next.value?.length ?? 0) > 0 }));
        process.exit(0);
      })();
    `);
    expect(second).toBe(true);
  });

  test.concurrent("reading resumes after the highwater backstop", async () => {
    // Stop reading long enough for the backstop to engage, then drain to EOF
    // and make sure every byte written by the parent is delivered.
    await using proc = Bun.spawn({
      cmd: [
        bunExe(),
        "-e",
        `
        const rd = Bun.stdin.stream().getReader();
        await rd.read().then(c => { globalThis.total = c.value?.length ?? 0; });
        await new Promise(r => setTimeout(r, 200));
        while (true) {
          const { value, done } = await rd.read();
          if (value) total += value.length;
          if (done) break;
        }
        process.stdout.write(String(total));
        `,
      ],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: bunEnv,
    });
    const chunk = Buffer.alloc(64 * 1024, 0x79);
    const n = 64;
    for (let i = 0; i < n; i++) proc.stdin.write(chunk);
    await proc.stdin.end();
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect(stderr).toBe("");
    expect(stdout).toBe(String(n * chunk.length));
    expect(exitCode).toBe(0);
  });
});

test("process.stdin over an anonymous pipe delivers each byte exactly once", async () => {
  const total = 10 * 1024 * 1024;
  using dir = tempDir("stdin-pipe-exactly-once", {
    "writer.js": `const chunk = Buffer.alloc(65536); let left = ${total}; (function pump() { while (left > 0) { left -= chunk.length; if (!process.stdout.write(chunk)) return process.stdout.once("drain", pump); } })();`,
    "reader.js": `const h = new Bun.CryptoHasher("sha1"); let n = 0; process.stdin.on("data", d => { n += d.length; h.update(d); }); process.stdin.on("close", () => process.stdout.write(n + " " + h.digest("hex")));`,
  });
  const { promise, resolve } = Promise.withResolvers<{ err: Error | null; stdout: string; stderr: string }>();
  exec(`"${bunExe()}" writer.js | "${bunExe()}" reader.js`, { cwd: String(dir), env: bunEnv }, (err, stdout, stderr) =>
    resolve({ err, stdout, stderr }),
  );
  const { err, stdout, stderr } = await promise;
  expect(stderr).toBe("");
  const expected = new Bun.CryptoHasher("sha1").update(Buffer.alloc(total)).digest("hex");
  expect(stdout).toBe(`${total} ${expected}`);
  expect(err).toBeNull();
});
