// TEMPORARY MEASUREMENT, removed before merge.
//
// `net.inet.tcp.pcbcount` is the macOS kernel's count of TCP sockets,
// including the ones no process owns any more. This file counts what three
// ways to dial leave behind: a literal address, a name dialed one address at a
// time (this change), and a name dialed every address at once (the code before
// this change, behind BUN_INTERNAL_TEMP_DIAL_ALL_AT_ONCE=1).
//
// The file name holds "stress" so that scripts/runner.node.ts never puts it in
// the parallel batch: no other test runs while it counts.
import { expect, test } from "bun:test";
import { bunEnv, bunExe, isMacOS } from "harness";

test.skipIf(!isMacOS)(
  "temp: kernel TCP sockets left behind per dial pattern",
  async () => {
    const run = (cmd: string[]) => Bun.spawnSync({ cmd }).stdout.toString().trim();
    const sysctl = (name: string) => run(["/usr/sbin/sysctl", "-n", name]);
    const pcbcount = () => Number(sysctl("net.inet.tcp.pcbcount"));
    const netstatTcpLines = () => run(["/usr/sbin/netstat", "-an", "-p", "tcp"]).split("\n").length;
    const started = Date.now();
    const sec = () => Math.round((Date.now() - started) / 1000);

    // One sample each 5 s: [seconds since the test started, count].
    async function sample(seconds: number, stopAt?: number) {
      const series: [number, number][] = [];
      for (let elapsed = 0; elapsed < seconds; elapsed += 5) {
        await Bun.sleep(5_000);
        const count = pcbcount();
        series.push([sec(), count]);
        // Back at the level before the loop, twice in a row, and TIME_WAIT (30 s) is over.
        if (stopAt !== undefined && elapsed >= 35 && series.length >= 2) {
          const [a, b] = series.slice(-2);
          if (Math.abs(a[1] - stopAt) <= 2 && Math.abs(b[1] - stopAt) <= 2) break;
        }
      }
      return series;
    }

    const loop = /* js */ `
      const body = Buffer.alloc(4 * 1024 * 1024, "x");
      const server = Bun.serve({ port: 0, fetch: () => new Response(body) });
      let errors = 0;
      const t0 = performance.now();
      for (let i = 0; i < 300; i++) {
        const ac = new AbortController();
        try {
          const res = await fetch("http://" + process.env.DIAL_HOST + ":" + server.port + "/", { signal: ac.signal });
          const reader = res.body.getReader();
          await reader.read();
          ac.abort();
          await reader.closed.catch(() => {});
        } catch {
          errors++;
        }
      }
      console.log(JSON.stringify({ ms: Math.round(performance.now() - t0), errors }));
      process.exit(0);
    `;

    async function arm(dial: string, host: string, allAtOnce: boolean, watchSeconds: number) {
      const before = pcbcount();
      const startedAt = sec();
      await using proc = Bun.spawn({
        cmd: [bunExe(), "-e", loop],
        env: {
          ...bunEnv,
          DIAL_HOST: host,
          BUN_INTERNAL_TEMP_DIAL_ALL_AT_ONCE: allAtOnce ? "1" : undefined,
          HTTP_PROXY: undefined,
          HTTPS_PROXY: undefined,
          http_proxy: undefined,
          https_proxy: undefined,
        },
        stderr: "pipe",
        stdout: "pipe",
      });
      const timer = setTimeout(() => proc.kill(), 120_000);
      const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
      clearTimeout(timer);
      const afterLoop = pcbcount();
      // The old pattern is watched for the whole window. The other two stop
      // once the count is back at the level before the loop.
      const series = await sample(watchSeconds, allAtOnce ? undefined : before);
      const last = series[series.length - 1][1];
      return {
        dial,
        host,
        startedAt,
        before,
        afterLoop,
        series,
        left: last - before,
        loop: stdout.trim(),
        stderr: stderr.trim().slice(0, 300),
        exitCode,
      };
    }

    const info = {
      macos: sysctl("kern.osproductversion"),
      kernel: sysctl("kern.osrelease"),
      arch: process.arch,
      host: sysctl("kern.hostname"),
      memsize: Number(sysctl("hw.memsize")),
      boottime: sysctl("kern.boottime"),
      msl: sysctl("net.inet.tcp.msl"),
      bun: run([bunExe(), "--revision"]),
      netstatTcpLinesAtStart: netstatTcpLines(),
    };

    // Wait until the sockets of earlier tests have left TIME_WAIT.
    const quiet = [[sec(), pcbcount()] as [number, number], ...(await sample(45))];

    // A second copy of this file (-b) gives a second round, on this host or
    // on the host of the other shard.
    const rows = [];
    rows.push(await arm("literal address", "127.0.0.1", false, 60));
    rows.push(await arm("one address at a time", "localhost", false, 60));
    rows.push(await arm("all addresses at once", "localhost", true, 100));
    const end = { at: sec(), pcbcount: pcbcount(), netstatTcpLines: netstatTcpLines() };
    console.log("TCP_PCB_CENSUS_V2 " + JSON.stringify({ info, quiet, rows, end }));
    expect(rows).toHaveLength(3);
  },
  900_000,
);
