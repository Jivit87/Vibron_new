/**
 * Command safety: classification and environment scrubbing.
 *
 * Three outcomes for a command string:
 *  - **blocked**: never runs, whatever the approval policy (disk wipes,
 *    `rm -rf ~`, remote scripts piped into a shell, privilege escalation).
 *  - **auto-approved**: every simple command in the line is on a narrow
 *    allowlist *with its arguments checked*, and the line uses no shell
 *    feature that could smuggle in something else (substitution, expansion,
 *    redirection to files, subshells, env-assignment prefixes).
 *  - **needs approval**: everything else, deferred to the caller's policy.
 *
 * The allowlist is evaluated on a real (if small) shell tokenizer rather
 * than a regex anchored at the start of the string: `npm test && curl x | sh`
 * and `ls; rm -rf .` used to sail through because only the prefix was
 * checked. When the tokenizer is unsure (unterminated quotes, odd syntax) the
 * answer is always "needs approval", never "auto".
 */

export type CommandVerdict =
  | { allowed: true; needsApproval: boolean }
  | { allowed: false; reason: string };

/* ------------------------------ tokenizer -------------------------------- */

interface Redirect {
  op: string;
  target: string;
}

interface Segment {
  words: string[];
  /** The operator that connected this segment to the previous one. */
  joinedBy: "start" | ";" | "&&" | "||" | "|" | "&";
}

interface ParsedLine {
  segments: Segment[];
  redirects: Redirect[];
  /** Shell features that make static analysis unreliable. */
  hazards: string[];
}

const REDIRECT_OPS = ["&>>", "&>", ">>", ">|", ">&", "<<<", "<<", "<>", "<&", ">", "<"];

export function parseShell(input: string): ParsedLine {
  const segments: Segment[] = [];
  const redirects: Redirect[] = [];
  const hazards = new Set<string>();

  let words: string[] = [];
  let joinedBy: Segment["joinedBy"] = "start";
  let word = "";
  let inWord = false;
  let pendingRedirect: string | null = null;

  const endWord = () => {
    if (!inWord) return;
    if (pendingRedirect !== null) {
      redirects.push({ op: pendingRedirect, target: word });
      pendingRedirect = null;
    } else {
      words.push(word);
    }
    word = "";
    inWord = false;
  };
  const endSegment = (next: Segment["joinedBy"]) => {
    endWord();
    if (pendingRedirect !== null) {
      hazards.add("dangling redirect");
      pendingRedirect = null;
    }
    if (words.length) segments.push({ words, joinedBy });
    else if (next !== "start" && joinedBy !== "start") hazards.add("empty command");
    words = [];
    joinedBy = next;
  };

  let i = 0;
  while (i < input.length) {
    const ch = input[i];

    if (ch === "'") {
      const close = input.indexOf("'", i + 1);
      if (close === -1) {
        hazards.add("unterminated quote");
        word += input.slice(i + 1);
        inWord = true;
        break;
      }
      word += input.slice(i + 1, close);
      inWord = true;
      i = close + 1;
      continue;
    }

    if (ch === '"') {
      let j = i + 1;
      let closed = false;
      while (j < input.length) {
        const c = input[j];
        if (c === "\\" && j + 1 < input.length) {
          const n = input[j + 1];
          if (n === '"' || n === "\\" || n === "$" || n === "`") {
            word += n;
            j += 2;
            continue;
          }
          if (n === "\n") {
            j += 2;
            continue;
          }
          word += c;
          j++;
          continue;
        }
        if (c === '"') {
          closed = true;
          break;
        }
        if (c === "$" || c === "`") hazards.add("expansion");
        word += c;
        j++;
      }
      if (!closed) hazards.add("unterminated quote");
      inWord = true;
      i = j + 1;
      continue;
    }

    if (ch === "\\") {
      if (input[i + 1] === "\n") {
        i += 2;
        continue;
      }
      if (i + 1 < input.length) word += input[i + 1];
      inWord = true;
      i += 2;
      continue;
    }

    if (ch === "$" || ch === "`") {
      hazards.add("expansion");
      word += ch;
      inWord = true;
      i++;
      continue;
    }

    if (ch === " " || ch === "\t") {
      endWord();
      i++;
      continue;
    }

    if (ch === "\n" || ch === "\r" || ch === ";") {
      endSegment(";");
      i++;
      continue;
    }

    if (ch === "&" && input[i + 1] === "&") {
      endSegment("&&");
      i += 2;
      continue;
    }
    if (ch === "|" && input[i + 1] === "|") {
      endSegment("||");
      i += 2;
      continue;
    }
    if (ch === "|") {
      endSegment("|");
      i += input[i + 1] === "&" ? 2 : 1;
      continue;
    }

    if ((ch === "<" || ch === ">") && input[i + 1] === "(") {
      hazards.add("process substitution");
      word += ch;
      inWord = true;
      i++;
      continue;
    }

    const op = REDIRECT_OPS.find((candidate) => input.startsWith(candidate, i));
    if (op && (ch !== "&" || op.startsWith("&>"))) {
      // `2>` — the fd digits were accumulated as the current word.
      let fd = "";
      if (inWord && /^\d+$/.test(word) && pendingRedirect === null) {
        fd = word;
        word = "";
        inWord = false;
      } else {
        endWord();
      }
      if (pendingRedirect !== null) hazards.add("dangling redirect");
      pendingRedirect = fd + op;
      i += op.length;
      continue;
    }

    if (ch === "&") {
      endSegment("&");
      i++;
      continue;
    }

    if (ch === "(" || ch === ")") {
      hazards.add("subshell");
      i++;
      continue;
    }

    if (!inWord && (ch === "#" || ch === "{" || ch === "}")) {
      hazards.add(ch === "#" ? "comment" : "grouping");
    }

    word += ch;
    inWord = true;
    i++;
  }
  endSegment(";");
  return { segments, redirects, hazards: [...hazards] };
}

/* ----------------------------- hard blocks ------------------------------- */

/** Raw-string backstops, applied even when tokenizing fails. */
const HARD_BLOCKED: { pattern: RegExp; reason: string }[] = [
  { pattern: /\b(mkfs(\.\w+)?|fdisk|diskutil\s+(erase\w*|zeroDisk|secureErase|partitionDisk))\b/, reason: "formats a disk" },
  { pattern: /\bdd\b[^;&|\n]*\bof=\/dev\//, reason: "writes directly to a device" },
  { pattern: /:\s*\(\s*\)\s*\{.*\|.*&.*\}/, reason: "is a fork bomb" },
  { pattern: /\b(curl|wget|fetch)\b[^\n]*\|\s*(\S*\/)?(env\s+)?(ba|z|da|k|fi|c|tc)?sh\b/, reason: "pipes a remote script into a shell" },
  { pattern: /\b(curl|wget)\b[^\n]*\|\s*(\S*\/)?(python[\d.]*|perl|ruby|node|php)\b/, reason: "pipes a remote script into an interpreter" },
  { pattern: /\b(ba|z|da|k|fi)?sh\b[^\n]*(<\(|\$\(|`)\s*(curl|wget)\b/, reason: "runs a remote script through a shell" },
  { pattern: /\bchmod\s+(-\w+\s+)*[0-7]?777\s+\/(\s|$)/, reason: "opens permissions on the filesystem root" },
  { pattern: /\b(chown|chmod)\s+(-\w+\s+)*-R\b[^\n]*\s(\/|~\/?)(\s|$)/, reason: "changes ownership of the root or home directory" },
  { pattern: /\b(shutdown|reboot|halt|poweroff)\b/, reason: "controls the host machine" },
  { pattern: /\b(sudo|doas|pkexec)\b/, reason: "requires elevated privileges" },
  { pattern: />\s*\/dev\/(sd|nvme|disk|hd|rdisk)/, reason: "writes to a raw device" },
];

const DANGEROUS_RM_TARGET =
  /^(\/+\.?\*?|\/+\.\.?\/*|~[^/\s]*\/*\*?|\$\{?HOME\}?\/*\*?|\/+(usr|etc|bin|sbin|lib|lib64|var|opt|boot|dev|proc|sys|root|System|Library|Users|home|Applications|private|Volumes)\/*\*?|\.\.\/*\*?)$/;

/** `rm -rf ~`, `rm -r -f /`, `rm --recursive $HOME`, `rm -rf /*` … */
function dangerousRm(words: string[]): boolean {
  for (let start = 0; start < words.length; start++) {
    if (baseName(words[start]) !== "rm") continue;
    const args = words.slice(start + 1);
    let recursive = false;
    let afterDashDash = false;
    const targets: string[] = [];
    for (const arg of args) {
      if (!afterDashDash && arg === "--") {
        afterDashDash = true;
      } else if (!afterDashDash && /^--recursive$/i.test(arg)) {
        recursive = true;
      } else if (!afterDashDash && /^-[a-zA-Z]+$/.test(arg)) {
        if (/[rR]/.test(arg)) recursive = true;
      } else if (!afterDashDash && arg.startsWith("--")) {
        // --force, --no-preserve-root, …
      } else {
        targets.push(arg);
      }
    }
    if (args.includes("--no-preserve-root")) return true;
    // Home and root are unrecoverable even without -r for globbed targets.
    if (targets.some((t) => DANGEROUS_RM_TARGET.test(t) && (recursive || /\*$/.test(t)))) {
      return true;
    }
  }
  return false;
}

function baseName(word: string): string {
  const slash = word.lastIndexOf("/");
  return slash === -1 ? word : word.slice(slash + 1);
}

const INTERPRETERS = /^(ba|z|da|k|fi|c|tc)?sh$|^(python[\d.]*|perl|ruby|node|php|deno|bun)$/;

function remoteScriptPipe(segments: Segment[]): boolean {
  let sawDownload = false;
  for (const seg of segments) {
    const cmd = baseName(seg.words[0] ?? "");
    if (seg.joinedBy === "|" && sawDownload && INTERPRETERS.test(effectiveCommand(seg.words))) {
      return true;
    }
    if (seg.joinedBy !== "|") sawDownload = false;
    if (/^(curl|wget)$/.test(cmd) || seg.words.some((w) => /^(curl|wget)$/.test(baseName(w)))) {
      sawDownload = true;
    }
  }
  return false;
}

/** Skip `env`, `command`, `exec`, `nice`, `time`, `xargs` wrappers. */
function effectiveCommand(words: string[]): string {
  const wrappers = /^(env|command|exec|nice|nohup|time|xargs|stdbuf|timeout)$/;
  for (const w of words) {
    const b = baseName(w);
    if (wrappers.test(b) || w.startsWith("-") || /^\w+=/.test(w) || /^\d+$/.test(w)) continue;
    return b;
  }
  return "";
}

/* ------------------------------ allowlist -------------------------------- */

type ArgRule = (args: string[]) => boolean;

const any: ArgRule = () => true;

function firstPositional(args: string[]): string | undefined {
  return args.find((a) => !a.startsWith("-"));
}

function subcommandIn(allowed: string[], deniedFlags: RegExp | null = null): ArgRule {
  return (args) => {
    const sub = args[0];
    if (!sub || !allowed.includes(sub)) return false;
    return !deniedFlags || !args.some((a) => deniedFlags.test(a));
  };
}

const PKG_GLOBAL = /^(-g|--global|--location=global|--prefix(=.*)?)$/;

/** Runtimes that can evaluate inline code. */
const noEval: ArgRule = (args) =>
  !args.some(
    (a) =>
      /^--(eval|print|import|loader|experimental-loader|input-type)(=|$)/.test(a) ||
      /^-[a-zA-Z]*[ep][a-zA-Z]*$/.test(a),
  );

const PYTHON_MODULES = new Set(["pytest", "unittest", "mypy", "ruff", "black", "pip", "flake8", "pylint"]);

const pythonRule: ArgRule = (args) => {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("-") || a === "-") {
      return a !== "-";
    }
    if (/^-[a-zA-Z]*c/.test(a)) return false;
    if (/^-[a-zA-Z]*m$/.test(a)) return PYTHON_MODULES.has(args[i + 1] ?? "");
    if (/^-[a-zA-Z]*m./.test(a)) return false;
  }
  return false; // bare `python` is a REPL
};

const NPX_TOOLS = new Set([
  "tsc", "vitest", "jest", "eslint", "prettier", "next", "vite", "playwright",
  "tsx", "ts-node", "webpack", "rollup", "esbuild", "mocha", "biome", "turbo",
]);

const GIT_READ_ONLY_FLAGS = /^--(output|exec|upload-pack|receive-pack|ext-diff)(=|$)/;

const gitRule: ArgRule = (args) => {
  const sub = args[0];
  if (!sub || sub.startsWith("-")) return false; // `git -c …` can set hooks/pagers
  if (args.some((a) => GIT_READ_ONLY_FLAGS.test(a))) return false;
  const rest = args.slice(1);
  switch (sub) {
    case "status":
    case "log":
    case "diff":
    case "show":
    case "rev-parse":
    case "ls-files":
    case "blame":
    case "shortlog":
    case "describe":
    case "add":
    case "init":
      return true;
    case "commit":
      return !rest.some((a) => /^--(amend|no-verify)$/.test(a) || a === "-n");
    case "branch":
      return !rest.some((a) => /^-[a-zA-Z]*[dDmMcCf]|^--(delete|move|copy|force|set-upstream-to|unset-upstream|edit-description)/.test(a)) &&
        rest.filter((a) => !a.startsWith("-")).length === 0;
    case "remote":
      return rest.every((a) => a === "-v" || a === "--verbose") ||
        (rest[0] === "get-url" || rest[0] === "show");
    default:
      return false;
  }
};

const findRule: ArgRule = (args) =>
  !args.some((a) => /^-(delete|exec|execdir|ok|okdir|fprint0?|fprintf|fls)$/.test(a));

const AUTO: Record<string, ArgRule> = {
  npm: subcommandIn(["install", "i", "ci", "add", "test", "t", "run", "run-script", "why", "ls", "list", "outdated", "audit"], PKG_GLOBAL),
  pnpm: subcommandIn(["install", "i", "add", "test", "t", "run", "why", "ls", "list", "outdated", "audit"], PKG_GLOBAL),
  yarn: (args) => args.length === 0 || subcommandIn(["install", "add", "test", "run", "why", "list", "outdated", "audit"], PKG_GLOBAL)(args),
  bun: (args) => subcommandIn(["install", "i", "add", "test", "run"], PKG_GLOBAL)(args) && noEval(args),
  npx: (args) => NPX_TOOLS.has(args[0] ?? ""),
  node: (args) => noEval(args) && firstPositional(args) !== undefined,
  tsx: (args) => noEval(args) && firstPositional(args) !== undefined,
  "ts-node": (args) => noEval(args) && firstPositional(args) !== undefined,
  deno: subcommandIn(["test", "fmt", "lint", "check"]),
  python: pythonRule,
  python3: pythonRule,
  pip: subcommandIn(["install", "list", "show", "freeze"]),
  pip3: subcommandIn(["install", "list", "show", "freeze"]),
  poetry: subcommandIn(["install", "show", "check", "lock", "run"]),
  uv: subcommandIn(["sync", "lock", "run", "add", "pip"]),
  cargo: subcommandIn(["build", "test", "check", "run", "fmt", "clippy", "doc", "tree", "bench"]),
  go: subcommandIn(["build", "test", "run", "vet", "fmt", "mod", "list", "version"]),
  dotnet: subcommandIn(["build", "test", "run", "restore", "format"]),
  mvn: any,
  gradle: any,
  git: gitRule,
  ls: any,
  cat: any,
  head: any,
  tail: any,
  wc: any,
  grep: any,
  egrep: any,
  rg: (args) => !args.some((a) => /^--pre(-glob)?(=|$)/.test(a)),
  which: any,
  echo: any,
  printf: any,
  pwd: any,
  tree: (args) => !args.some((a) => /^-o$|^--output/.test(a)),
  stat: any,
  du: any,
  df: any,
  find: findRule,
  cd: any,
  true: any,
  mkdir: any,
  touch: any,
  cp: any,
  mv: any,
  vitest: any,
  jest: any,
  playwright: any,
  eslint: any,
  prettier: any,
  tsc: any,
  next: any,
  vite: any,
  webpack: any,
  rollup: any,
  esbuild: any,
  docker: subcommandIn(["ps", "images", "build"]),
};

/** Commands whose first positional argument is a pattern, not a path. */
const PATTERN_FIRST = new Set(["grep", "egrep", "rg"]);
const NO_PATH_CHECK = new Set(["echo", "printf"]);

function escapesWorkspace(value: string): boolean {
  if (value === "/dev/null") return false;
  if (value.startsWith("/") || value.startsWith("~")) return true;
  if (/(^|\/)\.\.(\/|$)/.test(value)) return true;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || /^data:/i.test(value)) return true;
  return false;
}

function argsStayInWorkspace(cmd: string, args: string[]): boolean {
  if (NO_PATH_CHECK.has(cmd)) return true;
  let skippedPattern = !PATTERN_FIRST.has(cmd);
  for (const arg of args) {
    if (!skippedPattern && !arg.startsWith("-")) {
      skippedPattern = true;
      continue;
    }
    const value = arg.startsWith("-") && arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : arg;
    if (escapesWorkspace(value)) return false;
  }
  return true;
}

function redirectIsSafe(r: Redirect): boolean {
  if (/^\d*>&$/.test(r.op)) return /^\d$|^-$/.test(r.target);
  if (/^(\d*>>?|&>>?|\d*>\|)$/.test(r.op)) return r.target === "/dev/null";
  if (/^\d*<$/.test(r.op)) return !escapesWorkspace(r.target) && r.target !== "";
  return false;
}

function segmentAutoApproved(words: string[]): boolean {
  const [cmd, ...args] = words;
  if (!cmd || cmd.includes("/") || cmd.includes("=")) return false;
  const rule = Object.prototype.hasOwnProperty.call(AUTO, cmd) ? AUTO[cmd] : undefined;
  if (!rule || !rule(args)) return false;
  return argsStayInWorkspace(cmd, args);
}

/* ------------------------------ classify --------------------------------- */

export function classifyCommand(command: string): CommandVerdict {
  const normalized = command.trim();
  if (!normalized) return { allowed: false, reason: "is empty" };

  for (const rule of HARD_BLOCKED) {
    if (rule.pattern.test(normalized)) return { allowed: false, reason: rule.reason };
  }

  const parsed = parseShell(normalized);

  if (parsed.segments.some((s) => dangerousRm(s.words))) {
    return { allowed: false, reason: "recursively deletes the root, home, or a system directory" };
  }
  // Backstop for lines the tokenizer could not follow.
  if (/\brm\s+(-\S+\s+)*-\S*[rR]\S*\s+(-\S+\s+)*["']?(~|\/|\$\{?HOME)["'\s/*]*($|[;&|])/.test(normalized)) {
    return { allowed: false, reason: "recursively deletes the root, home, or a system directory" };
  }
  if (remoteScriptPipe(parsed.segments)) {
    return { allowed: false, reason: "pipes a remote script into an interpreter" };
  }

  const autoOk =
    parsed.hazards.length === 0 &&
    parsed.segments.length > 0 &&
    parsed.redirects.every(redirectIsSafe) &&
    parsed.segments.every((s) => segmentAutoApproved(s.words));

  return { allowed: true, needsApproval: !autoOk };
}

/* --------------------------- agent denylist ------------------------------ */

/** `git [-C dir] [-c k=v] [--flag] <sub> …` → `<sub>` and its args. */
function gitSubcommand(words: string[]): { sub: string; args: string[] } | null {
  let i = words.findIndex((w) => baseName(w) === "git");
  if (i === -1) return null;
  i++;
  while (i < words.length && words[i].startsWith("-")) {
    // Options that take a separate value.
    if (/^(-C|-c|--git-dir|--work-tree|--namespace|--exec-path)$/.test(words[i])) i++;
    i++;
  }
  if (i >= words.length) return null;
  return { sub: words[i], args: words.slice(i + 1) };
}

/**
 * Pramana `DENYLIST` parity for commands an *agent* runs. A user may push
 * from their own terminal; an agent never does (delivery owns remotes), and
 * `git clean -f/-d/-x` wipes the scratch area and untracked user work.
 */
export function classifyAgentCommand(command: string): CommandVerdict {
  const verdict = classifyCommand(command);
  if (!verdict.allowed) return verdict;
  const normalized = command.trim();
  const parsed = parseShell(normalized);
  // Backstop for lines the tokenizer cannot follow (`$(git push)`, `(git push)`).
  if (parsed.hazards.length && /\bgit\s+(-\S+\s+)*push\b/.test(normalized)) {
    return { allowed: false, reason: "pushes to a remote; agents never push (delivery handles remotes)" };
  }
  for (const seg of parsed.segments) {
    const git = gitSubcommand(seg.words);
    if (!git) continue;
    if (git.sub === "push") {
      return { allowed: false, reason: "pushes to a remote; agents never push (delivery handles remotes)" };
    }
    if (git.sub === "clean" && git.args.some((a) => /^-[a-zA-Z]*[fdx]/.test(a) || a === "--force")) {
      return { allowed: false, reason: "runs git clean, which deletes untracked work; remove specific files instead" };
    }
  }
  return verdict;
}

/* ---------------------------- env scrubbing ------------------------------ */

const SECRET_NAME =
  /(API[_-]?KEY|SECRET|TOKEN|PASSW(OR)?D|CREDENTIAL|PRIVATE[_-]?KEY|(^|_)AUTH(_|$)|COOKIE|_PAT$|^PAT_)/i;
const SECRET_PREFIX =
  /^(ANTHROPIC|OPENAI|GROQ|GEMINI|GOOGLE_API|GOOGLE_APPLICATION_CREDENTIALS|FIREBASE|AWS_|AZURE_|GCP_|GH_|GITHUB_TOKEN|GITLAB_|NPM_TOKEN|NODE_AUTH|HF_|HUGGING|MISTRAL|COHERE|TOGETHER|REPLICATE|STRIPE|SLACK_|VIBERON_|DATABASE_URL|REDIS_URL|MONGO)/i;
/** Needed by ordinary dev tooling even though the name looks sensitive. */
const KEEP = new Set(["SSH_AUTH_SOCK", "GPG_AGENT_INFO", "XAUTHORITY"]);

/**
 * Copy of `env` without credentials. Child processes run agent-chosen
 * commands; they must not inherit the app's model API keys or cloud creds.
 */
export function scrubEnv(env: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {} as NodeJS.ProcessEnv;
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (!KEEP.has(key) && (SECRET_NAME.test(key) || SECRET_PREFIX.test(key))) continue;
    out[key] = value;
  }
  return out;
}
