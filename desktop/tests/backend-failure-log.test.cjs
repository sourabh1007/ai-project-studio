"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createBackendFailureLog, MAX_BYTES } = require("../backend-failure-log.cjs");

function tempLog() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aps-failure-log-"));
  return path.join(dir, "logs", "desktop-supervisor.log");
}

test("persists a record as a JSON line and stamps it", () => {
  const logPath = tempLog();
  const log = createBackendFailureLog({ logPath, now: () => "2026-01-01T00:00:00.000Z" });
  const record = log.record({ kind: "exit", code: 1, stderrTail: "Error: boom" });

  assert.equal(record.at, "2026-01-01T00:00:00.000Z");
  const lines = fs.readFileSync(logPath, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), {
    at: "2026-01-01T00:00:00.000Z",
    kind: "exit",
    code: 1,
    stderrTail: "Error: boom",
  });
});

test("returns recent entries newest first and honours the limit", () => {
  const log = createBackendFailureLog({ logPath: tempLog() });
  for (let i = 0; i < 4; i += 1) {
    log.record({ kind: "exit", code: i });
  }
  assert.deepEqual(log.recent(2).map((entry) => entry.code), [3, 2]);
});

test("keeps at most 20 entries in memory", () => {
  const log = createBackendFailureLog({ logPath: tempLog() });
  for (let i = 0; i < 25; i += 1) {
    log.record({ kind: "exit", code: i });
  }
  const recent = log.recent(100);
  assert.equal(recent.length, 20);
  assert.equal(recent[0].code, 24);
  assert.equal(recent[19].code, 5);
});

test("truncates the log once it grows past the size cap", () => {
  const logPath = tempLog();
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, "x".repeat(MAX_BYTES + 1), "utf8");

  const log = createBackendFailureLog({ logPath });
  log.record({ kind: "unavailable", reason: "gave up" });

  const lines = fs.readFileSync(logPath, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).reason, "gave up");
});

test("reports but never throws when the log cannot be written", () => {
  const messages = [];
  // A path whose parent is a file cannot be created as a directory.
  const blocker = path.join(os.tmpdir(), `aps-blocker-${Date.now()}`);
  fs.writeFileSync(blocker, "not a directory", "utf8");
  const log = createBackendFailureLog({
    logPath: path.join(blocker, "logs", "supervisor.log"),
    onError: (message) => messages.push(message),
  });

  const record = log.record({ kind: "exit", code: 9 });
  assert.equal(record.code, 9);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /could not record backend failure/);
  // The in-memory mirror still works, which is what diagnostics reads.
  assert.equal(log.recent()[0].code, 9);
});

test("exposes the directory the log lives in", () => {
  const logPath = tempLog();
  const log = createBackendFailureLog({ logPath });
  assert.equal(log.logDirectory, path.dirname(logPath));
});