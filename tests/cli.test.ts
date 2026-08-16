// dutybell — CLI integration tests. Each test spins up the compiled CLI
// against a fresh temporary project root and asserts fail-closed exit codes.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const fsMktemp = require("node:fs").mkdtempSync;

const CLI = join(import.meta.dirname ?? process.cwd(), "..", "dist", "tools", "dutybell.js");
const { execSync } = require("node:child_process");

let root = "";
let exit: number;
let out = "";
let err = "";

function run(args: string[], opts: { code?: number; env?: Record<string, string> } = {}): string {
  exit = 0;
  out = "";
  err = "";
  try {
    const o = execFileSync("node", [CLI, ...args], {
      cwd: root,
      env: { ...process.env, ...(opts.env ?? {}) },
      encoding: "utf8",
    });
    out = o;
    return o;
  } catch (e: unknown) {
    exit = (e as { status: number }).status ?? -1;
    out = (e as { stdout?: string }).stdout ?? "";
    err = (e as { stderr?: string }).stderr ?? "";
    if (opts.code === undefined) throw e;
    return `${out}${err}`;
  }
}

beforeEach(() => {
  root = fsMktemp(join(tmpdir(), "dutybell-cli-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("dutybell CLI", () => {
  it("init creates the state directory and tolerates duplicates", () => {
    const o = run(["init"]);
    expect(existsSync(join(root, ".dutybell"))).toBe(true);
    expect(o).toMatch(/initialized/);
    // a second init is idempotent — it must not clobber existing state
    const o2 = run(["init"]);
    expect(o2).toMatch(/initialized/);
    // but adding a duplicate duty id is rejected fail-closed
    run(["add", "d1", "* * * * *", "/bin/true", "--shell"]);
    run(["add", "d1", "* * * * *", "/bin/true", "--shell"], { code: 1 });
    expect(exit).toBe(1);
  });

  it("add/list round-trip a task", () => {
    run(["init"]);
    run(["add", "nightly", "0 3 * * *", "/usr/bin/true"]);
    const o = run(["list"]);
    expect(out).toMatch(/nightly/);
    expect(out).toMatch(/0 3 \* \* \*/);
  });

  it("rejects an invalid cron at add time", () => {
    run(["init"]);
    run(["add", "bad", "not a cron", "/usr/bin/true"], { code: 1 });
    expect(exit).toBe(1);
  });

  it("tick exits 2 with a completely empty registry", () => {
    run(["init"]);
    run(["tick"], { code: 2 });
    expect(exit).toBe(2);
  });

  it("run-now executes a registered task and reports success", () => {
    run(["init"]);
    run(["add", "echo", "* * * * *", "/bin/sh", "-c", "echo dutybell-ok", "--shell"]);
    const o = run(["run-now", "echo"]);
    // the CLI reports the outcome of the executed duty
    expect(`${out}${err}`).toMatch(/succeeded/);
  });

  it("tick succeeds for a healthy task", () => {
    run(["init"]);
    run(["add", "good", "* * * * *", "/bin/true", "--shell", "--catchup", "60000"]);
    run(["tick"]);
    expect(exit).toBe(0);
  });

  it("tick reports drift (exit 2) for a failing task", () => {
    run(["init"]);
    run(["add", "failing", "* * * * *", "/bin/false", "--shell", "--catchup", "60000"]);
    run(["tick"], { code: 2 });
    expect(exit).toBe(2);
    expect(`${out}${err}`).toMatch(/dutybell/);
  });

  it("log shows the append-only ledger", () => {
    run(["init"]);
    run(["add", "g2", "* * * * *", "/bin/true", "--shell", "--catchup", "60000"]);
    run(["tick"]);
    const o = run(["log"]);
    expect(out).toMatch(/started|succeeded/);
  });

  it("lock-status is honest about the absence of a lock", () => {
    run(["init"]);
    run(["add", "x", "* * * * *", "/bin/true", "--shell"]);
    const o = run(["lock-status", "x"]);
    expect(out).toMatch(/no-lock/);
  });

  it("doctor flags problems with a fail-closed exit", () => {
    run(["init"]);
    run(["add", "x", "* * * * *", "/bin/true", "--shell"]);
    // no tick ever → doctor must flag the cold start (state.json absent) fail-closed
    run(["doctor"], { code: 2 });
    expect(exit).toBe(2);
    expect(`${out}${err}`).toMatch(/never run/);
  });

  it("tick honors DUTYBELL_NOTIFY_URL and awaits the notification", async () => {
    // receiver: respond to any POST with 200 and write the body to a marker file
    const marker = join(tmpdir(), `db-hook-${Date.now()}.marker`);
    const recvFile = join(root, "recv.js");
    writeFileSync(
      recvFile,
      [
        "const http = require('http');",
        "const fs = require('fs');",
        "http.createServer((req, res) => {",
        "  let body = '';",
        "  req.on('data', (c) => (body += c));",
        "  req.on('end', () => { fs.appendFileSync(process.argv[2], body + '\\n'); res.writeHead(200, {'content-type':'application/json'}); res.end('{\"ok\":true}'); });",
        "}).listen(9399);",
      ].join("\n"),
    );
    const server = require("node:child_process").spawn("node", [recvFile, marker], { detached: true, stdio: "ignore" });
    try {
      run(["init"]);
      run(["add", "f1", "* * * * *", "/bin/false", "--shell", "--notify", "failure", "--catchup", "60000"]);
      run(["tick"], { code: 2, env: { DUTYBELL_NOTIFY_URL: "http://127.0.0.1:9399/hook" } });
      await new Promise((r) => setTimeout(r, 600));
      expect(existsSync(marker)).toBe(true);
      const body = require("node:fs").readFileSync(marker, "utf8");
      const event = JSON.parse(body.split("\n").filter(Boolean).pop() as string);
      expect(event.event).toBe("drift");
    } finally {
      process.kill(-server.pid!, "SIGKILL");
      rmSync(marker, { force: true });
    }
  });
});
