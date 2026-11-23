#!/usr/bin/env node
// MCP server (stdio) that lets an MCP client, such as Claude Code, ask Codex
// to investigate or review, through the `codex exec` CLI.
//
// The server always starts Codex with its read-only sandbox, with approval
// requests refused and with the command rules of the user and of the project
// ignored, because a rule that allows a command runs that command outside the
// sandbox. The prompt reaches Codex through stdin, so no shell parses it.
//
// It has no dependencies: the stdio transport of MCP is JSON-RPC 2.0 with
// one message per line.

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";

const SERVER_INFO = { name: "codex-wrapper", version: "0.1.0" };
// 2025-03-26 is left out because it requires JSON-RPC batches, which this server does not handle.
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18"];

const DEFAULT_TIMEOUT_SECONDS = 1800;
const MAX_TIMEOUT_SECONDS = 7200;
const STDERR_TAIL_CHARS = 4000;
// After SIGTERM, wait this long before SIGKILL.
const KILL_GRACE_MS = 5000;
// After Codex exits, wait this long for its stderr to close. A leftover
// descendant can hold the pipe open, and the call must not wait for it.
const STDERR_CLOSE_WAIT_MS = 2000;

const ASK_TOOL = {
  name: "ask",
  title: "Ask Codex (read-only)",
  description:
    "Ask Codex, the OpenAI coding agent, to investigate or review something, and return its final answer. " +
    "Codex runs in its read-only sandbox: it can read files and run commands, but it cannot write files. " +
    "Codex does not see this conversation, so the prompt must state everything it needs, including file paths. " +
    "A call can take several minutes.",
  inputSchema: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "The full instructions for Codex." },
      cwd: {
        type: "string",
        description: "Absolute path of the directory that Codex works in, usually the repository root.",
      },
      timeout_seconds: {
        type: "integer",
        minimum: 1,
        maximum: MAX_TIMEOUT_SECONDS,
        description: `Stop Codex after this many seconds. Default ${DEFAULT_TIMEOUT_SECONDS}.`,
      },
    },
    required: ["prompt", "cwd"],
    additionalProperties: false,
  },
};

// Calls of the `ask` tool that have not finished, by JSON-RPC request id.
// A call is registered before its first await, so that a cancellation that
// arrives while the call is still preparing is not lost.
const jobs = new Map();
// Ids of the requests that the client cancelled. MCP asks the server not to respond to them.
const cancelledRequests = new Set();
let shuttingDown = false;

class Job {
  stopReason = null;
  // The running Codex process, or null before it starts and after it finishes.
  child = null;
  killTimer = null;

  stop(reason) {
    if (this.stopReason) return;
    this.stopReason = reason;
    if (this.child) {
      const child = this.child;
      killGroup(child, "SIGTERM");
      this.killTimer = setTimeout(() => killGroup(child, "SIGKILL"), KILL_GRACE_MS);
      this.killTimer.unref();
    }
  }
}

// Codex starts in its own process group, so that a signal also reaches the commands that Codex runs.
function killGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    // The group has already exited.
  }
}

function send(message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
}

function textResult(text, isError = false) {
  return { content: [{ type: "text", text }], isError };
}

function tail(text, limit) {
  return text.length <= limit ? text : "…" + text.slice(-limit);
}

async function validateArguments(args) {
  if (typeof args?.prompt !== "string" || args.prompt.trim() === "") {
    return "`prompt` must be a non-empty string.";
  }
  if (typeof args.cwd !== "string" || !isAbsolute(args.cwd)) {
    return "`cwd` must be an absolute path.";
  }
  try {
    if (!(await stat(args.cwd)).isDirectory()) return `\`cwd\` is not a directory: ${args.cwd}`;
  } catch {
    return `\`cwd\` does not exist: ${args.cwd}`;
  }
  const timeout = args.timeout_seconds;
  if (timeout !== undefined && !(Number.isInteger(timeout) && timeout >= 1 && timeout <= MAX_TIMEOUT_SECONDS)) {
    return `\`timeout_seconds\` must be an integer from 1 to ${MAX_TIMEOUT_SECONDS}.`;
  }
  return null;
}

function stoppedResult(reason) {
  return textResult(`Codex was stopped: ${reason}.`, true);
}

async function runCodex(job, { prompt, cwd, timeout_seconds = DEFAULT_TIMEOUT_SECONDS }) {
  const workDir = await mkdtemp(join(tmpdir(), "codex-wrapper-"));
  try {
    if (job.stopReason) return stoppedResult(job.stopReason);

    const lastMessageFile = join(workDir, "last-message.txt");
    const args = [
      "exec",
      "--sandbox", "read-only",
      "--config", 'approval_policy="never"',
      "--ignore-rules",
      "--ephemeral",
      "--skip-git-repo-check",
      "--cd", cwd,
      "--output-last-message", lastMessageFile,
      "-",
    ];

    const outcome = await new Promise((resolve) => {
      const child = spawn("codex", args, { cwd, detached: true, stdio: ["pipe", "ignore", "pipe"] });
      job.child = child;
      let stderr = "";
      let exit = null;
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        // Kill any command that Codex left running.
        killGroup(child, "SIGKILL");
        // From here on, the system can reuse the id of the group for another process, so no signal is sent to it.
        clearTimeout(job.killTimer);
        job.child = null;
        resolve({ ...exit, stderr });
      };
      const timer = setTimeout(() => job.stop(`the call timed out after ${timeout_seconds} seconds`), timeout_seconds * 1000);

      // Decode as a stream, so that a multibyte character split across chunks stays intact.
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderr = tail(stderr + chunk, STDERR_TAIL_CHARS * 2);
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        resolve({ spawnError: error, stderr });
      });
      child.on("exit", (code, signal) => {
        exit = { code, signal };
        setTimeout(finish, STDERR_CLOSE_WAIT_MS).unref();
      });
      child.stderr.on("close", () => {
        if (exit) finish();
      });
      // Codex reads the prompt until stdin closes. Leaving stdin open makes it wait forever.
      child.stdin.on("error", () => {});
      child.stdin.end(prompt);
    });

    if (outcome.spawnError) {
      return textResult(`Could not start \`codex\`: ${outcome.spawnError.message}`, true);
    }
    const lastMessage = await readFile(lastMessageFile, "utf8").catch(() => "");
    if (job.stopReason || outcome.code !== 0 || lastMessage.trim() === "") {
      const status = job.stopReason
        ? `Codex was stopped: ${job.stopReason}.`
        : `Codex exited with code ${outcome.code}${outcome.signal ? ` (signal ${outcome.signal})` : ""}` +
          (lastMessage.trim() === "" ? " and produced no final message." : ".");
      const parts = [status];
      if (lastMessage.trim() !== "") parts.push(`Final message:\n${lastMessage}`);
      parts.push(`End of stderr:\n${tail(outcome.stderr, STDERR_TAIL_CHARS)}`);
      return textResult(parts.join("\n\n"), true);
    }
    return textResult(lastMessage);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function callAsk(id, args) {
  const job = new Job();
  jobs.set(id, job);
  try {
    if (shuttingDown) return stoppedResult("the server is shutting down");
    const problem = await validateArguments(args);
    if (problem) return textResult(problem, true);
    return await runCodex(job, args);
  } finally {
    jobs.delete(id);
  }
}

async function handleRequest({ id, method, params }) {
  switch (method) {
    case "initialize": {
      const requested = params?.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : SUPPORTED_PROTOCOL_VERSIONS[0];
      return { protocolVersion, capabilities: { tools: {} }, serverInfo: SERVER_INFO };
    }
    case "ping":
      return {};
    case "tools/list":
      return { tools: [ASK_TOOL] };
    case "tools/call":
      if (params?.name !== ASK_TOOL.name) {
        throw { code: -32602, message: `Unknown tool: ${params?.name}` };
      }
      return callAsk(id, params.arguments);
    default:
      throw { code: -32601, message: `Method not found: ${method}` };
  }
}

function handleNotification({ method, params }) {
  if (method === "notifications/cancelled") {
    const job = jobs.get(params?.requestId);
    if (!job) return;
    cancelledRequests.add(params.requestId);
    job.stop("the client cancelled the call");
  }
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function handleMessage(message) {
  if (!isObject(message) || message.jsonrpc !== "2.0") {
    send({ id: null, error: { code: -32600, message: "Invalid Request" } });
    return;
  }
  if (message.method === undefined) {
    // A response. This server sends no requests, so there is nothing to match it with.
    if ("result" in message || "error" in message) return;
    send({ id: message.id ?? null, error: { code: -32600, message: "Invalid Request" } });
    return;
  }
  const hasId = "id" in message;
  if (typeof message.method !== "string" || (hasId && typeof message.id !== "string" && typeof message.id !== "number")) {
    send({ id: hasId ? message.id : null, error: { code: -32600, message: "Invalid Request" } });
    return;
  }
  if (!hasId) {
    handleNotification(message);
    return;
  }
  let response;
  try {
    response = { result: await handleRequest(message) };
  } catch (error) {
    const code = Number.isInteger(error?.code) ? error.code : -32603;
    response = { error: { code, message: error?.message ?? String(error) } };
  }
  if (cancelledRequests.delete(message.id)) return;
  send({ id: message.id, ...response });
}

// Stop every job, wait for the jobs to finish, and exit.
async function shutDown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const job of jobs.values()) job.stop("the server is shutting down");
  const deadline = Date.now() + KILL_GRACE_MS + STDERR_CLOSE_WAIT_MS + 1000;
  while (jobs.size > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  process.exit(0);
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (line.trim() === "") return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    send({ id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  handleMessage(message);
});
lines.on("close", shutDown);
process.on("SIGTERM", shutDown);
process.on("SIGINT", shutDown);
