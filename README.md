# codex-wrapper

An MCP server (stdio) that lets an MCP client, such as Claude Code, ask Codex to investigate or review something.

Claude Code cannot run Codex reliably from its sandboxed Bash tool. A local MCP server runs outside that sandbox, and the prompt reaches Codex through stdin, so no shell parses it.

The server uses no npm packages. It needs `node` and the `codex` CLI on `PATH`, with Codex already logged in.

## Tool

`ask` runs `codex exec` with the prompt on stdin, and returns Codex's final message. The options that set how Codex runs are `--sandbox read-only`, `--config approval_policy="never"`, `--ignore-rules`, `--ephemeral`, `--skip-git-repo-check`, and `--cd <cwd>`.

| Argument | Required | Meaning |
|---|---|---|
| `prompt` | yes | The full instructions. Codex does not see the caller's conversation. |
| `cwd` | yes | Absolute path of the directory that Codex works in. |
| `timeout_seconds` | no | Stop Codex after this many seconds. Default 1800, maximum 7200. |

- Codex can read files and run commands, but its sandbox rejects writes. No argument changes this.
- The rule files (`.rules`) of the user and of the project are ignored, because a command that a rule allows runs outside Codex's sandbox. MCP servers configured in Codex also run outside that sandbox, so configuring one weakens the read-only guarantee.
- A timeout, a cancellation by the client, or a shutdown of the server stops Codex.
- When Codex fails, times out, or ends without a final message, the result is an error. The error states the exit status, or the reason that Codex was stopped, and includes the end of Codex's stderr.

## Registration in Claude Code

Run this in the directory of this repository:

```sh
claude mcp add --scope user codex-wrapper -- node "$PWD/server.mjs"
```

The shell expands `$PWD` when the command runs, so Claude Code stores the absolute path of `server.mjs`. If the repository moves, remove the server with `claude mcp remove --scope user codex-wrapper` and register it again.

A running session loads the server only after a restart, or a reconnect from `/mcp`.
