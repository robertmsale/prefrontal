import { Client } from "npm:@modelcontextprotocol/sdk@1.25.1/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "npm:@modelcontextprotocol/sdk@1.25.1/client/stdio.js";
import { fromFileUrl, join } from "@std/path";

type View =
  | "overview"
  | "memory"
  | "tasks"
  | "locks"
  | "activity"
  | "tools"
  | "help";

type UiState = {
  view: View;
  status: string;
  error: string | null;
  connected: boolean;
  serverCommand: string;
  serverArgs: string[];
  overview: any | null;
  memoryQuery: string;
  memoryResults: any[] | null;
  tasks: any[] | null;
  locks: any[] | null;
  activityCursor: number;
  activityEvents: any[] | null;
  tools: Array<{ name: string; description?: string }> | null;
  inputMode: null | {
    prompt: string;
    value: string;
    onSubmit: (v: string) => Promise<void>;
  };
};

const enc = new TextEncoder();
const dec = new TextDecoder();

function write(s: string) {
  Deno.stdout.writeSync(enc.encode(s));
}

function clearScreen() {
  write("\x1b[2J\x1b[H");
}

function hideCursor() {
  write("\x1b[?25l");
}

function showCursor() {
  write("\x1b[?25h");
}

function bold(s: string) {
  return `\x1b[1m${s}\x1b[22m`;
}

function dim(s: string) {
  return `\x1b[2m${s}\x1b[22m`;
}

function red(s: string) {
  return `\x1b[31m${s}\x1b[39m`;
}

function green(s: string) {
  return `\x1b[32m${s}\x1b[39m`;
}

function cyan(s: string) {
  return `\x1b[36m${s}\x1b[39m`;
}

function truncate(s: string, n: number) {
  if (s.length <= n) return s;
  return s.slice(0, Math.max(0, n - 1)) + "…";
}

function parseArgs(argv: string[]) {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq !== -1) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const key = a.slice(2);
    const val = argv[i + 1];
    if (typeof val === "string" && !val.startsWith("--")) {
      out[key] = val;
      i++;
    } else {
      out[key] = "true";
    }
  }
  return out;
}

function tryParseJsonArray(value: string): string[] | null {
  try {
    const v = JSON.parse(value);
    if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v;
    return null;
  } catch {
    return null;
  }
}

function firstTextContent(result: any): string | null {
  const content = result?.content;
  if (!Array.isArray(content)) return null;
  for (const c of content) {
    if (c?.type === "text" && typeof c?.text === "string") return c.text;
  }
  return null;
}

function parseToolJson<T>(result: any): T {
  const txt = firstTextContent(result);
  if (!txt) throw new Error("Tool did not return text content");
  return JSON.parse(txt) as T;
}

async function findExecutableInPath(command: string): Promise<string | null> {
  const envPath = Deno.env.get("PATH") ?? "";
  const delimiter = Deno.build.os === "windows" ? ";" : ":";
  for (const dir of envPath.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, command);
    try {
      const stat = await Deno.stat(candidate);
      if (stat.isFile) return candidate;
    } catch {
      // ignore
    }
  }
  return null;
}

function selfModulePaths() {
  const rootUrl = new URL("../../", import.meta.url);
  return {
    configPath: fromFileUrl(new URL("deno.json", rootUrl)),
    cliPath: fromFileUrl(new URL("src/cli/main.ts", rootUrl)),
  };
}

export async function runTui(argv: string[] = Deno.args) {
  const flags = parseArgs(argv);

  const serverCommand = flags.command ??
    Deno.env.get("PREFRONTAL_MCP_COMMAND") ??
    ((await findExecutableInPath("prefrontal")) ?? Deno.execPath());
  const serverArgs = (() => {
    const fromFlag = flags.args ? tryParseJsonArray(flags.args) : null;
    if (fromFlag) return fromFlag;
    const fromEnv = Deno.env.get("PREFRONTAL_MCP_ARGS");
    const envArgs = fromEnv ? tryParseJsonArray(fromEnv) : null;
    if (envArgs) return envArgs;
    if (serverCommand === "prefrontal") return ["mcp", "--transport=stdio"];
    const { configPath, cliPath } = selfModulePaths();
    return ["run", "-A", "-c", configPath, cliPath, "mcp", "--transport=stdio"];
  })();

  const client = new Client({ name: "prefrontal-tui", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: serverCommand,
    args: serverArgs,
    cwd: Deno.cwd(),
    env: {
      ...getDefaultEnvironment(),
      ...Deno.env.toObject(),
      PREFRONTAL_TRANSPORT: "stdio",
      PREFRONTAL_TRANSPORT_TYPE: "stdio",
    },
    stderr: "inherit",
  });

  const state: UiState = {
    view: "overview",
    status: "connecting…",
    error: null,
    connected: false,
    serverCommand,
    serverArgs,
    overview: null,
    memoryQuery: "",
    memoryResults: null,
    tasks: null,
    locks: null,
    activityCursor: 0,
    activityEvents: null,
    tools: null,
    inputMode: null,
  };

  let quitting = false;
  let repaintQueued = false;
  const queueRepaint = () => {
    if (repaintQueued) return;
    repaintQueued = true;
    queueMicrotask(() => {
      repaintQueued = false;
      render(state);
    });
  };

  function setError(err: unknown) {
    state.error = err instanceof Error ? err.message : String(err);
    state.status = "error";
    queueRepaint();
  }

  async function refreshOverview() {
    state.status = "loading overview…";
    state.error = null;
    queueRepaint();
    const res = await client.callTool({
      name: "stats_get",
      arguments: { include_paths: true, max_points: null, sample_paths: 20 },
    });
    state.overview = parseToolJson<any>(res);
    state.status = "ready";
    queueRepaint();
  }

  async function refreshTools() {
    state.status = "loading tools…";
    state.error = null;
    queueRepaint();
    const res = await client.listTools();
    state.tools = (res.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
    }));
    state.status = "ready";
    queueRepaint();
  }

  async function refreshTasks() {
    state.status = "loading tasks…";
    state.error = null;
    queueRepaint();
    const res = await client.callTool({
      name: "tasks_list_active",
      arguments: { status_in: null, limit: 100 },
    });
    const data = parseToolJson<{ tasks: any[] }>(res);
    state.tasks = data.tasks ?? [];
    state.status = "ready";
    queueRepaint();
  }

  async function refreshLocks() {
    state.status = "loading locks…";
    state.error = null;
    queueRepaint();
    const res = await client.callTool({
      name: "locks_list",
      arguments: { limit: 200 },
    });
    const data = parseToolJson<{ locks: any[] }>(res);
    state.locks = data.locks ?? [];
    state.status = "ready";
    queueRepaint();
  }

  async function refreshActivity(next: boolean) {
    state.status = "loading activity…";
    state.error = null;
    queueRepaint();
    const res = await client.callTool({
      name: "activity_digest",
      arguments: {
        since_cursor: next ? state.activityCursor : 0,
        limit: 50,
      },
    });
    const data = parseToolJson<{ events: any[]; next_cursor: number }>(res);
    state.activityEvents = data.events ?? [];
    state.activityCursor = data.next_cursor ?? state.activityCursor;
    state.status = "ready";
    queueRepaint();
  }

  async function runMemorySearch(query: string) {
    state.status = "searching memory…";
    state.error = null;
    queueRepaint();
    const res = await client.callTool({
      name: "memory_search",
      arguments: { query, kind: null, path: null, k: 10 },
    });
    const data = parseToolJson<{ results: any[] }>(res);
    state.memoryQuery = query;
    state.memoryResults = data.results ?? [];
    state.status = "ready";
    queueRepaint();
  }

  function promptInput(
    prompt: string,
    initial: string,
    onSubmit: (v: string) => Promise<void>,
  ) {
    state.inputMode = { prompt, value: initial, onSubmit };
    queueRepaint();
  }

  function closePrompt() {
    state.inputMode = null;
    queueRepaint();
  }

  function switchView(v: View) {
    state.view = v;
    state.error = null;
    queueRepaint();
  }

  async function handleKey(ch: string) {
    if (state.inputMode) {
      if (ch === "\x1b") { // ESC
        closePrompt();
        return;
      }
      if (ch === "\r" || ch === "\n") {
        const v = state.inputMode.value;
        const submit = state.inputMode.onSubmit;
        closePrompt();
        try {
          await submit(v);
        } catch (e) {
          setError(e);
        }
        return;
      }
      if (ch === "\x7f" || ch === "\b") { // backspace
        state.inputMode.value = state.inputMode.value.slice(
          0,
          Math.max(0, state.inputMode.value.length - 1),
        );
        queueRepaint();
        return;
      }
      if (ch >= " " && ch !== "\x7f") {
        state.inputMode.value += ch;
        queueRepaint();
      }
      return;
    }

    if (ch === "q" || ch === "\x03") {
      quitting = true;
      return;
    }
    if (ch === "?") switchView("help");
    if (ch === "1") switchView("overview");
    if (ch === "2") switchView("memory");
    if (ch === "3") switchView("tasks");
    if (ch === "4") switchView("locks");
    if (ch === "5") switchView("activity");
    if (ch === "6") switchView("tools");

    if (ch === "r") {
      try {
        await refreshCurrentView();
      } catch (e) {
        setError(e);
      }
      return;
    }

    if (ch === "/" && state.view === "memory") {
      promptInput("Memory search", state.memoryQuery, async (v) => {
        const q = v.trim();
        if (q.length === 0) return;
        await runMemorySearch(q);
      });
      return;
    }

    if (ch === "n" && state.view === "activity") {
      try {
        await refreshActivity(true);
      } catch (e) {
        setError(e);
      }
      return;
    }
  }

  async function refreshCurrentView() {
    if (state.view === "overview") return await refreshOverview();
    if (state.view === "tools") return await refreshTools();
    if (state.view === "tasks") return await refreshTasks();
    if (state.view === "locks") return await refreshLocks();
    if (state.view === "activity") return await refreshActivity(false);
    return;
  }

  function render(s: UiState) {
    clearScreen();
    hideCursor();

    const size = (() => {
      try {
        return Deno.consoleSize();
      } catch {
        return { columns: 100, rows: 30 };
      }
    })();
    const cols = size.columns;
    const headerLeft = `${bold("Prefrontal")} ${dim("TUI")}  ${
      cyan(
        s.view,
      )
    }`;
    const headerRight = s.connected ? green("connected") : dim("disconnected");
    const pad = Math.max(1, cols - headerLeft.length - headerRight.length - 1);
    write(`${headerLeft}${" ".repeat(pad)}${headerRight}\n`);
    write(
      dim(
        `Server: ${s.serverCommand} ${
          s.serverArgs.join(" ")
        }    Keys: 1-6 views, r refresh, / search (memory), n next (activity), q quit, ? help`,
      ) + "\n\n",
    );

    if (s.error) {
      write(red(`Error: ${s.error}`) + "\n\n");
    } else if (s.status && s.status !== "ready") {
      write(dim(s.status) + "\n\n");
    }

    const lines: string[] = [];

    if (s.view === "help") {
      lines.push(bold("Views"));
      lines.push(
        "  1 Overview   2 Memory   3 Tasks   4 Locks   5 Activity   6 Tools",
      );
      lines.push("");
      lines.push(bold("Common keys"));
      lines.push("  r refresh   q quit   ? help");
      lines.push("");
      lines.push(bold("Memory"));
      lines.push("  / enter query, Enter to search");
      lines.push("");
      lines.push(bold("Activity"));
      lines.push("  n fetch next page (uses cursor)");
    }

    if (s.view === "overview") {
      const o = s.overview;
      if (!o) {
        lines.push(dim("Press r to load overview stats."));
      } else {
        const counts = o.counts ?? {};
        lines.push(bold("Counts"));
        lines.push(
          `  repo_chunks: ${counts.repo_chunks ?? "?"}    tasks: ${
            counts.tasks ?? "?"
          }    locks: ${counts.locks ?? "?"}    activity: ${
            counts.activity ?? "?"
          }`,
        );
        const fr = o.file_refs;
        if (fr) {
          lines.push("");
          lines.push(bold("File refs"));
          lines.push(`  unique_paths: ${fr.unique_paths_count ?? "?"}`);
          const sample: string[] = fr.sample_paths ?? [];
          if (sample.length) {
            lines.push("");
            lines.push(bold("Sample paths"));
            for (const p of sample) lines.push(`  - ${p}`);
          }
        }
        const scanned = o.scanned;
        if (scanned) {
          lines.push("");
          lines.push(
            dim(
              `Scanned (max ${scanned.max_points_per_collection} each): repo_chunks=${scanned.repo_chunks} tasks=${scanned.tasks} locks=${scanned.locks} activity=${scanned.activity}${
                scanned.truncated ? " (truncated)" : ""
              }`,
            ),
          );
        }
      }
    }

    if (s.view === "tools") {
      if (!s.tools) {
        lines.push(dim("Press r to load tool list."));
      } else {
        lines.push(bold(`Tools (${s.tools.length})`));
        for (const t of s.tools) {
          const desc = t.description
            ? truncate(t.description, Math.max(10, cols - 20))
            : "";
          lines.push(`  - ${cyan(t.name)}${desc ? ` ${dim(desc)}` : ""}`);
        }
      }
    }

    if (s.view === "memory") {
      lines.push(
        `${bold("Query")}: ${s.memoryQuery ? s.memoryQuery : dim("(none)")}  ${
          dim("(/ to search)")
        }`,
      );
      lines.push("");
      const r = s.memoryResults;
      if (!r) {
        lines.push(dim("No results yet."));
      } else if (!r.length) {
        lines.push(dim("No hits."));
      } else {
        lines.push(bold(`Results (${r.length})`));
        for (const hit of r) {
          const score = typeof hit?.score === "number"
            ? hit.score.toFixed(3)
            : "?";
          const chunk = hit?.chunk ?? {};
          const path = typeof chunk?.path === "string" ? chunk.path : "?";
          const kind = typeof chunk?.kind === "string" ? chunk.kind : "?";
          const text = typeof chunk?.text === "string" ? chunk.text : "";
          lines.push(
            `  ${dim(score)} ${cyan(path)} ${dim(`[${kind}]`)} ${
              truncate(text.replaceAll("\n", " "), Math.max(10, cols - 20))
            }`,
          );
        }
      }
    }

    if (s.view === "tasks") {
      const t = s.tasks;
      if (!t) {
        lines.push(dim("Press r to load active tasks."));
      } else if (!t.length) {
        lines.push(dim("No active tasks."));
      } else {
        lines.push(bold(`Active tasks (${t.length})`));
        for (const task of t) {
          const id = typeof task?.task_id === "string" ? task.task_id : "";
          const title = typeof task?.title === "string" ? task.title : "";
          const status = typeof task?.status === "string" ? task.status : "";
          const who = task?.claimed_by?.agent_id
            ? ` @${task.claimed_by.agent_id}`
            : "";
          lines.push(
            `  - ${cyan(truncate(id, 8))} ${bold(status)}${who} ${
              truncate(title, Math.max(10, cols - 30))
            }`,
          );
        }
      }
    }

    if (s.view === "locks") {
      const l = s.locks;
      if (!l) {
        lines.push(dim("Press r to load locks."));
      } else if (!l.length) {
        lines.push(dim("No active locks."));
      } else {
        lines.push(bold(`Locks (${l.length})`));
        for (const lock of l) {
          const path = typeof lock?.path === "string" ? lock.path : "";
          const mode = typeof lock?.mode === "string" ? lock.mode : "";
          const agent = typeof lock?.agent_id === "string" ? lock.agent_id : "";
          lines.push(`  - ${cyan(path)} ${dim(`[${mode}]`)} ${dim(agent)}`);
        }
      }
    }

    if (s.view === "activity") {
      const ev = s.activityEvents;
      lines.push(
        `${bold("Cursor")}: ${s.activityCursor}  ${dim("(n for next page)")}`,
      );
      lines.push("");
      if (!ev) {
        lines.push(dim("Press r to load activity digest."));
      } else if (!ev.length) {
        lines.push(dim("No events."));
      } else {
        lines.push(bold(`Events (${ev.length})`));
        for (const e of ev) {
          const ts = typeof e?.ts === "number"
            ? new Date(e.ts).toISOString()
            : "";
          const type = typeof e?.type === "string" ? e.type : "";
          const msg = typeof e?.message === "string" ? e.message : "";
          lines.push(
            `  ${dim(ts)} ${cyan(type)} ${
              truncate(msg.replaceAll("\n", " "), Math.max(10, cols - 30))
            }`,
          );
        }
      }
    }

    for (const ln of lines) write(ln + "\n");

    if (s.inputMode) {
      write("\n");
      write(
        `${bold(s.inputMode.prompt)}: ${s.inputMode.value}${
          dim(" (Enter to submit, Esc to cancel)")
        }\n`,
      );
    }
  }

  try {
    Deno.stdin.setRaw(true);
  } catch {
    // ignore
  }

  render(state);

  try {
    state.status = "connecting…";
    render(state);
    await client.connect(transport as any);
    state.connected = true;
    state.status = "ready";
    await refreshOverview();
    await refreshTools().catch(() => {});
  } catch (e) {
    setError(e);
  }

  const reader = Deno.stdin.readable.getReader();
  let inEscape = false;
  let escapeMaybeStandalone = false;
  while (!quitting) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    const txt = dec.decode(value);
    // Best-effort ignore escape sequences (arrows, etc.); handle printable chars.
    for (const ch of txt) {
      if (escapeMaybeStandalone) {
        escapeMaybeStandalone = false;
        // Arrow keys typically start with ESC [ or ESC O.
        if (ch === "[" || ch === "O") {
          inEscape = true;
          continue;
        }
        await handleKey("\x1b");
        if (quitting) break;
        // Fall through to process the current character normally.
      }
      if (inEscape) {
        // Consume until a terminating alpha (CSI sequences end with a letter).
        if ((ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z")) {
          inEscape = false;
        }
        continue;
      }
      if (ch === "\x1b") {
        escapeMaybeStandalone = true;
        continue;
      }
      await handleKey(ch);
      if (quitting) break;
    }
  }

  try {
    await client.close();
  } catch {
    // ignore
  }
  try {
    Deno.stdin.setRaw(false);
  } catch {
    // ignore
  }
  showCursor();
  write("\n");
}

if (import.meta.main) {
  await runTui(Deno.args);
}
