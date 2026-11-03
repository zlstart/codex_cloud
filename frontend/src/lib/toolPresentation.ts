export interface ToolBlock {
  label: string;
  code: string;
  language: string;
}
export interface ToolPresentation {
  blocks: ToolBlock[];
  metadata: [string, string][];
  extra?: Record<string, unknown>;
  failed?: boolean;
  processRunning?: boolean;
  exitCode?: number;
}

export function printable(value: unknown): string {
  return typeof value === "string"
    ? value
    : (JSON.stringify(value, null, 2) ?? "");
}

function decoded(value: unknown): unknown {
  if (typeof value !== "string" || !/^[\s]*[\[{]/.test(value)) return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function shellTool(name: string) {
  return /(?:^|[./:])(exec_command|write_stdin|shell|bash)$/.test(name);
}

function block(label: string, value: unknown, language?: string): ToolBlock {
  return {
    label,
    code: printable(value),
    language: language ?? (typeof value === "string" ? "plaintext" : "json"),
  };
}

export function toolInput(name: string, raw: unknown): ToolPresentation {
  const value = decoded(raw);
  const result: ToolPresentation = { blocks: [], metadata: [] };
  if (!record(value)) {
    result.blocks.push(
      block("输入", value, /apply_patch$/.test(name) ? "diff" : undefined),
    );
    return result;
  }
  const extra = { ...value };
  const take = (key: string) => {
    const taken = extra[key];
    delete extra[key];
    return taken;
  };
  if (shellTool(name)) {
    const commandKey =
      typeof value.cmd === "string"
        ? "cmd"
        : typeof value.command === "string" || Array.isArray(value.command)
          ? "command"
          : null;
    if (commandKey) {
      const command = take(commandKey);
      result.blocks.push(
        block(
          "命令",
          Array.isArray(command) ? command.map(String).join("\n") : command,
          "bash",
        ),
      );
    }
    if (typeof value.chars === "string")
      result.blocks.push(block("会话输入", take("chars")));
    if (typeof value.workdir === "string")
      result.metadata.push(["工作目录", String(take("workdir"))]);
    if (value.session_id !== undefined)
      result.metadata.push(["会话", String(take("session_id"))]);
  } else if (/apply_patch$/.test(name)) {
    const key = ["patch", "input", "raw"].find(
      (key) => typeof value[key] === "string",
    );
    if (key) result.blocks.push(block("补丁", take(key), "diff"));
  } else if (/python$/.test(name) && typeof value.code === "string") {
    result.blocks.push(block("代码", take("code"), "python"));
  }
  if (Object.keys(extra).length) {
    if (result.blocks.length || result.metadata.length) result.extra = extra;
    else result.blocks.push(block("输入", extra));
  }
  return result;
}

export function toolOutput(name: string, raw: unknown): ToolPresentation {
  const value = decoded(raw);
  const result: ToolPresentation = { blocks: [], metadata: [] };
  if (record(value)) {
    result.failed =
      value.isError === true ||
      value.status === "failed" ||
      value.status === "error" ||
      value.success === false;
    if (shellTool(name)) {
      const extra = { ...value };
      const exitCode =
        typeof value.exit_code === "number"
          ? value.exit_code
          : typeof value.returncode === "number"
            ? value.returncode
            : undefined;
      if (exitCode !== undefined) {
        result.exitCode = exitCode;
        result.failed ||= exitCode !== 0;
        result.metadata.push(["退出码", String(exitCode)]);
        delete extra.exit_code;
        delete extra.returncode;
      }
      if (
        typeof value.session_id === "number" ||
        typeof value.session_id === "string"
      ) {
        result.processRunning =
          exitCode === undefined || value.exit_code === null;
        result.metadata.push(["会话", String(value.session_id)]);
        delete extra.session_id;
      }
      if (typeof value.wall_time_seconds === "number") {
        result.metadata.push(["耗时", `${value.wall_time_seconds} 秒`]);
        delete extra.wall_time_seconds;
      }
      for (const [key, label] of [
        ["output", "输出"],
        ["stdout", "标准输出"],
        ["stderr", "标准错误"],
        ["error", "错误"],
      ]) {
        if (typeof value[key] === "string") {
          if (value[key]) result.blocks.push(block(label, value[key]));
          delete extra[key];
        }
      }
      if (result.blocks.length || result.metadata.length) {
        if (Object.keys(extra).length) result.extra = extra;
        return result;
      }
    }
  }
  if (shellTool(name) && typeof value === "string") {
    // SDK shell metadata precedes Output:. Never infer status from program output.
    const header =
      /^(Chunk ID: [^\n]+\n)([\s\S]*?)\n(?:Final output|Output):\n?/.exec(
        value,
      );
    if (header) {
      const metadata = header[2];
      const exit = /^Process exited with code (-?\d+)$/m.exec(metadata);
      const session = /^Process running with session ID ([^\n]+)$/m.exec(
        metadata,
      );
      const wall = /^Wall time: (.+)$/m.exec(metadata);
      const tokens = /^Original token count: (\d+)$/m.exec(metadata);
      if (exit) {
        result.exitCode = Number(exit[1]);
        result.failed = result.exitCode !== 0;
        result.metadata.push(["退出码", exit[1]]);
      }
      if (session) {
        result.processRunning = true;
        result.metadata.push(["会话", session[1]]);
      }
      if (wall) result.metadata.push(["耗时", wall[1]]);
      if (tokens) result.metadata.push(["原始 token 数", tokens[1]]);
      const output = value.slice(header[0].length);
      if (output) result.blocks.push(block("输出", output));
      return result;
    }
  }
  if (raw !== undefined && value !== "")
    result.blocks.push(block("结果", value));
  return result;
}
