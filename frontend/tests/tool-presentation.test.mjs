import assert from "node:assert/strict";
import test from "node:test";
import { toolInput, toolOutput } from "../src/lib/toolPresentation.ts";

test("SDK shell headers expose outcome without reading exit-like program output", () => {
  const failed = toolOutput(
    "exec_command",
    "Chunk ID: abc123\nWall time: 0.1234 seconds\nProcess exited with code 7\nOutput:\nmissing input",
  );
  assert.equal(failed.failed, true);
  assert.equal(failed.exitCode, 7);
  assert.equal(failed.blocks[0].code, "missing input");
  const printed = toolOutput(
    "exec_command",
    "Chunk ID: abc123\nWall time: 0.1234 seconds\nProcess exited with code 0\nOutput:\nProcess exited with code 7",
  );
  assert.equal(printed.failed, false);
  assert.equal(printed.blocks[0].code, "Process exited with code 7");
  assert.equal(
    toolOutput("search", "Process exited with code 7").failed,
    undefined,
  );
});

test("background process and malformed output retain a truthful fallback", () => {
  const background = toolOutput(
    "exec_command",
    "Chunk ID: a\nWall time: 1 seconds\nProcess running with session ID 12\nOutput:\nReady",
  );
  assert.equal(background.processRunning, true);
  assert.equal(background.exitCode, undefined);
  const malformed = '{"exit_code": 1, "output": "unfinished';
  assert.equal(toolOutput("exec_command", malformed).blocks[0].code, malformed);
  assert.equal(
    toolOutput("lookup", '{"isError":true,"content":[]}').failed,
    true,
  );
  assert.equal(toolOutput("lookup", '{"rows":[]}').failed, false);
});

test("structured shell results preserve stderr, additional fields and the full tail", () => {
  const output = "line\n".repeat(6000) + "TAIL";
  const result = toolOutput(
    "exec_command",
    JSON.stringify({
      exit_code: 1,
      stdout: output,
      stderr: "bad input",
      retryable: true,
    }),
  );
  assert.equal(result.failed, true);
  assert.equal(result.blocks[0].code, output);
  assert.equal(result.blocks[1].code, "bad input");
  assert.deepEqual(result.extra, { retryable: true });
});

test("shell and raw patch inputs separate useful content without losing arguments", () => {
  const input = toolInput("exec_command", {
    cmd: "python report.py",
    workdir: "/workspace",
    max_output_tokens: 3000,
  });
  assert.equal(input.blocks[0].code, "python report.py");
  assert.equal(input.blocks[0].language, "bash");
  assert.deepEqual(input.extra, { max_output_tokens: 3000 });
  const patch = "*** Begin Patch\n*** Add File: a.py\n+print(1)\n*** End Patch";
  assert.equal(toolInput("apply_patch", { raw: patch }).blocks[0].code, patch);
  assert.equal(
    toolInput("apply_patch", { raw: patch }).blocks[0].language,
    "diff",
  );
  assert.equal(
    toolInput("unknown", { nested: { value: 1 } }).blocks[0].language,
    "json",
  );
});
