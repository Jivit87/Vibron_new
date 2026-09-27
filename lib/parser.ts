/**
 * Code graph builder.
 *
 * Two phases, so the graph can be maintained incrementally:
 *  1. `extractFile` parses ONE file into symbols plus unresolved imports and
 *     calls (Babel for JS/TS, `lib/lang/extract` for Python/Go/Rust/Java).
 *     This is the expensive part and is cached per content hash.
 *  2. `linkGraph` resolves imports and calls across all extracts into edges.
 *     Pure, no parsing, cheap enough to run after every write.
 *
 * `parseRepo` = extract everything + link, for callers that have no cache.
 */

import { createHash } from "node:crypto";
import path from "node:path";
import { parse } from "@babel/parser";
import traverseModule from "@babel/traverse";
import type * as t from "@babel/types";
import type { Graph, GraphEdge, GraphNode } from "@/lib/graph";
import { nodeId } from "@/lib/ids";
import { isSourceFilePath, type RepoFile } from "@/lib/github";
import { aliasCandidates, loadPathAliases, type PathAliases } from "@/lib/lang/tsconfig";
import { extractLanguage, languageForPath, type FileExtract } from "@/lib/lang/extract";

export type { FileExtract } from "@/lib/lang/extract";

// CJS/ESM interop: under tsx (headless CLI) the default export can arrive
// wrapped as `{ default: fn }`; under Next/vitest it is the function itself.
const traverse = ((traverseModule as unknown as { default?: typeof traverseModule }).default ??
  traverseModule) as typeof traverseModule;

export interface ParseRepoResult {
  graph: Graph;
  errors: string[];
}

interface FileImport {
  from: string;
  to: string;
  specifiers: Map<string, string>;
  namespaces: Set<string>;
  /** Every name of the target is visible unqualified. */
  wildcard: boolean;
  /** Same-package visibility (Go/Java), not a written import. */
  implicit: boolean;
}

interface PendingCall {
  from: string;
  file: string;
  calleeName: string;
  namespace?: string;
}

interface NodeRange {
  node: GraphNode;
  start: number;
  end: number;
}

const EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];

/** Files parsed since process start. Tests use it to prove writes stay incremental. */
export const parseStats = { filesParsed: 0 };

export function hashSource(source: string): string {
  return createHash("sha1").update(source).digest("hex").slice(0, 16);
}

export interface LinkContext {
  repoRef: string;
  /** Every source file path in the workspace (for import resolution). */
  knownFiles: Set<string>;
  aliases: PathAliases[];
  /** `module` line of go.mod, when present. */
  goModule?: string | null;
}

/** Parse one file into symbols + unresolved imports/calls. Never throws. */
export function extractFile(file: RepoFile): FileExtract {
  parseStats.filesParsed += 1;
  const hash = hashSource(file.source);
  const lang = languageForPath(file.path);
  if (!lang) return { path: file.path, hash, lang: "js", nodes: [], imports: [], calls: [] };
  if (lang !== "js") {
    try {
      return { path: file.path, hash, lang, ...extractLanguage(lang, file.path, file.source) };
    } catch (error) {
      return {
        path: file.path,
        hash,
        lang,
        nodes: [],
        imports: [],
        calls: [],
        error: `${file.path}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  return extractJs(file, hash);
}

function extractJs(file: RepoFile, hash: string): FileExtract {
  const result: FileExtract = { path: file.path, hash, lang: "js", nodes: [], imports: [], calls: [] };
  let ast: t.File;
  try {
    ast = parse(file.source, {
      sourceType: "unambiguous",
      errorRecovery: true,
      plugins: [
        "typescript",
        "jsx",
        "decorators-legacy",
        "classProperties",
        "classPrivateProperties",
        "classPrivateMethods",
        "dynamicImport",
        "importAttributes",
      ],
    });
  } catch (error) {
    result.error = `${file.path}: ${error instanceof Error ? error.message : String(error)}`;
    return result;
  }

  const localRanges: NodeRange[] = [];
  const addNode = (babelNode: t.Node, name: string, kind: GraphNode["kind"]) => {
    if (!babelNode.loc || babelNode.start == null || babelNode.end == null) return;
    const graphNode = makeNode(file, babelNode, name, kind);
    result.nodes.push(graphNode);
    localRanges.push({ node: graphNode, start: babelNode.start, end: babelNode.end });
  };

  // Babel's traverse throws on scope-level errors (a duplicate
  // declaration, for instance) even when `parse` succeeded with error
  // recovery. One unparseable file must not take down indexing for the
  // whole workspace, so degrade to "no symbols from this file".
  try {
    traverse(ast, {
      FunctionDeclaration(nodePath) {
        const name = nodePath.node.id?.name;
        if (name) addNode(nodePath.node, name, "function");
      },
      ClassDeclaration(nodePath) {
        const name = nodePath.node.id?.name;
        if (name) addNode(nodePath.node, name, "class");
      },
      VariableDeclarator(nodePath) {
        const id = nodePath.node.id;
        const init = nodePath.node.init;
        if (!id || id.type !== "Identifier" || !init) return;
        if (init.type === "FunctionExpression" || init.type === "ArrowFunctionExpression") {
          addNode(init, id.name, "function");
        }
      },
      ImportDeclaration(nodePath) {
        const specifiers: [string, string][] = [];
        const namespaces: string[] = [];
        for (const specifier of nodePath.node.specifiers) {
          if (specifier.type === "ImportNamespaceSpecifier") {
            namespaces.push(specifier.local.name);
            continue;
          }
          if (specifier.type === "ImportSpecifier") {
            const imported =
              specifier.imported.type === "Identifier"
                ? specifier.imported.name
                : specifier.imported.value;
            specifiers.push([specifier.local.name, imported]);
            continue;
          }
          specifiers.push([specifier.local.name, specifier.local.name]);
        }
        result.imports.push({ request: nodePath.node.source.value, specifiers, namespaces });
      },
    });
  } catch (error) {
    result.error = `${file.path}: ${error instanceof Error ? error.message : String(error)}`;
    result.nodes = [];
    result.imports = [];
    return result;
  }

  const ranges = localRanges.sort((a, b) => a.start - b.start || a.end - b.end);
  try {
    traverse(ast, {
      CallExpression(nodePath) {
        const callee = calleeName(nodePath.node.callee);
        if (!callee || nodePath.node.start == null) return;
        const enclosing = findEnclosingNode(ranges, nodePath.node.start);
        if (!enclosing) return;
        result.calls.push({
          from: enclosing.id,
          calleeName: callee.name,
          namespace: callee.namespace,
        });
      },
    });
  } catch (error) {
    result.error = `${file.path}: ${error instanceof Error ? error.message : String(error)}`;
  }
  return result;
}

/** Link per-file extracts into one graph: resolve imports, then calls. Pure and cheap. */
export function linkGraph(extracts: Iterable<FileExtract>, ctx: LinkContext): Graph {
  const steps = linkGraphSteps(extracts, ctx);
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}

/**
 * `linkGraph` that yields to the event loop while it works (a large repo's
 * link is hundreds of ms of CPU) and stops when `signal` aborts. Same result.
 */
export async function linkGraphAsync(
  extracts: Iterable<FileExtract>,
  ctx: LinkContext,
  tick: (signal?: AbortSignal) => Promise<void>,
  signal?: AbortSignal,
): Promise<Graph> {
  const steps = linkGraphSteps(extracts, ctx);
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
    await tick(signal);
  }
}

/** The link, as a generator that pauses once per file of each pass. */
function* linkGraphSteps(extracts: Iterable<FileExtract>, ctx: LinkContext): Generator<void, Graph, void> {
  const all = [...extracts];
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const fileToNodeIds = new Map<string, string[]>();
  const nodesByFileAndName = new Map<string, GraphNode>();
  const imports: FileImport[] = [];
  const resolver = makeResolver(ctx);

  for (const extract of all) {
    yield;
    for (const node of extract.nodes) {
      nodes.push(node);
      nodesByFileAndName.set(`${node.file}#${node.name}`, node);
    }
    fileToNodeIds.set(
      extract.path,
      extract.nodes.map((node) => node.id),
    );
  }

  for (const extract of all) {
    yield;
    for (const imp of extract.imports) {
      for (const target of resolver(extract, imp.request, imp.specifiers, Boolean(imp.wildcard))) {
        if (target.to === extract.path) continue;
        imports.push({
          from: extract.path,
          to: target.to,
          specifiers: new Map(target.specifiers ?? imp.specifiers),
          namespaces: new Set(target.namespaces ?? imp.namespaces),
          wildcard: Boolean(imp.wildcard),
          implicit: imp.request === "__samepkg__",
        });
      }
    }
  }

  const edgeKeys = new Set<string>();
  const addEdge = (edge: GraphEdge) => {
    const key = `${edge.source}:${edge.target}:${edge.kind}`;
    if (edge.source === edge.target || edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push(edge);
  };

  let sinceYield = 0;
  for (const fileImport of imports) {
    if ((sinceYield += 1) % 64 === 0) yield;
    // Same-package visibility is not an import; only written imports get edges.
    if (fileImport.implicit) continue;
    const sources = fileToNodeIds.get(fileImport.from) ?? [];
    const targets = fileToNodeIds.get(fileImport.to) ?? [];
    // Bound the cartesian product so one huge module cannot explode the graph.
    if (sources.length * targets.length > 5000) continue;
    for (const source of sources) {
      for (const target of targets) addEdge({ source, target, kind: "import" });
    }
  }

  const importsByFile = new Map<string, FileImport[]>();
  for (const fileImport of imports) {
    const list = importsByFile.get(fileImport.from) ?? [];
    list.push(fileImport);
    importsByFile.set(fileImport.from, list);
  }
  for (const extract of all) {
    yield;
    for (const call of extract.calls) {
      const target = resolveCallTarget(
        { ...call, file: extract.path },
        nodesByFileAndName,
        importsByFile.get(extract.path) ?? [],
      );
      if (target) addEdge({ source: call.from, target: target.id, kind: "call" });
    }
  }

  return {
    nodes,
    edges,
    meta: { repoRef: ctx.repoRef, parsedAt: Date.now(), fileCount: all.length },
  };
}

export function goModuleOf(files: RepoFile[]): string | null {
  const gomod = files.find((file) => file.path === "go.mod");
  return gomod ? (/^module\s+(\S+)/m.exec(gomod.source)?.[1] ?? null) : null;
}

export function parseRepo(files: RepoFile[], repoRef = "unknown/repo@local"): ParseRepoResult {
  const sourceFiles = files.filter((file) => isSourceFilePath(file.path));
  const extracts = sourceFiles.map(extractFile);
  const graph = linkGraph(extracts, {
    repoRef,
    knownFiles: new Set(sourceFiles.map((file) => file.path)),
    aliases: loadPathAliases(files),
    goModule: goModuleOf(files),
  });
  return { graph, errors: extracts.flatMap((extract) => (extract.error ? [extract.error] : [])) };
}

/* ---------------------------- import resolution --------------------------- */

interface ResolvedImport {
  to: string;
  specifiers?: [string, string][];
  namespaces?: string[];
}

function makeResolver(ctx: LinkContext) {
  const filesByDir = new Map<string, string[]>();
  for (const file of ctx.knownFiles) {
    const dir = path.posix.dirname(file);
    const list = filesByDir.get(dir) ?? [];
    list.push(file);
    filesByDir.set(dir, list);
  }
  const has = (candidate: string) => ctx.knownFiles.has(candidate);
  const inDir = (dir: string, ext: string, exclude?: RegExp) =>
    (filesByDir.get(dir) ?? []).filter((f) => f.endsWith(ext) && !(exclude && exclude.test(f)));

  const python = (from: string, request: string, specifiers: [string, string][]): ResolvedImport[] => {
    const dots = /^\.*/.exec(request)![0].length;
    const rest = request.slice(dots).split(".").filter(Boolean);
    let bases: string[];
    if (dots > 0) {
      let dir = path.posix.dirname(from);
      for (let i = 1; i < dots; i += 1) dir = path.posix.dirname(dir);
      bases = [dir === "." ? "" : dir];
    } else {
      const top = from.includes("/") ? from.split("/")[0]! : "";
      bases = ["", "src", ...(top && top !== "src" ? [top] : [])];
    }
    const moduleFile = (segments: string[]): string | null => {
      for (const base of bases) {
        const p = [base, ...segments].filter(Boolean).join("/");
        if (!p) continue;
        if (has(`${p}.py`)) return `${p}.py`;
        if (has(`${p}/__init__.py`)) return `${p}/__init__.py`;
      }
      return null;
    };
    const out: ResolvedImport[] = [];
    const main = rest.length ? moduleFile(rest) : null;
    if (main) out.push({ to: main });
    // `from pkg import submodule` imports a module, not a name.
    for (const [local, imported] of specifiers) {
      const sub = moduleFile([...rest, imported]);
      if (sub && sub !== main) out.push({ to: sub, specifiers: [], namespaces: [local] });
    }
    return out;
  };

  const go = (from: string, request: string): ResolvedImport[] => {
    if (request === "__samepkg__") {
      return inDir(path.posix.dirname(from), ".go").map((to) => ({ to }));
    }
    let dir: string | null = null;
    if (ctx.goModule && (request === ctx.goModule || request.startsWith(`${ctx.goModule}/`))) {
      dir = request.slice(ctx.goModule.length + 1) || ".";
    } else {
      for (const known of filesByDir.keys()) {
        if (known !== "." && request.endsWith(`/${known}`)) {
          dir = known;
          break;
        }
      }
    }
    if (!dir) return [];
    return inDir(dir, ".go", /_test\.go$/).map((to) => ({ to }));
  };

  const rust = (from: string, request: string): ResolvedImport[] => {
    const segments = request.split("::").filter(Boolean);
    const base = path.posix.basename(from);
    const fromDir = path.posix.dirname(from);
    const selfDir = ["mod.rs", "lib.rs", "main.rs"].includes(base)
      ? fromDir
      : path.posix.join(fromDir, base.replace(/\.rs$/, ""));
    let dir: string;
    const head = segments.shift();
    if (head === "crate") {
      const idx = from.lastIndexOf("src/");
      dir = idx === -1 ? "src" : from.slice(0, idx + 3);
    } else if (head === "self") dir = selfDir;
    else if (head === "super") dir = path.posix.dirname(selfDir);
    else return [];
    while (segments[0] === "super") {
      segments.shift();
      dir = path.posix.dirname(dir);
    }
    const moduleFile = (segs: string[]): string | null => {
      const p = path.posix.join(dir, ...segs);
      if (has(`${p}.rs`)) return `${p}.rs`;
      if (has(`${p}/mod.rs`)) return `${p}/mod.rs`;
      return null;
    };
    const full = segments.length ? moduleFile(segments) : null;
    if (full) return [{ to: full }];
    const parent = segments.length > 1 ? moduleFile(segments.slice(0, -1)) : null;
    return parent ? [{ to: parent }] : [];
  };

  const java = (from: string, request: string, wildcard: boolean): ResolvedImport[] => {
    if (request === "__samepkg__") return inDir(path.posix.dirname(from), ".java").map((to) => ({ to }));
    const segments = request.split(".");
    if (wildcard) {
      const suffix = segments.join("/");
      for (const dir of filesByDir.keys()) {
        if (dir === suffix || dir.endsWith(`/${suffix}`)) return inDir(dir, ".java").map((to) => ({ to }));
      }
      return [];
    }
    const tryClass = (segs: string[]) => {
      const suffix = `${segs.join("/")}.java`;
      for (const file of ctx.knownFiles) {
        if (file === suffix || file.endsWith(`/${suffix}`)) return file;
      }
      return null;
    };
    const hit = tryClass(segments) ?? (segments.length > 1 ? tryClass(segments.slice(0, -1)) : null);
    return hit ? [{ to: hit }] : [];
  };

  return (
    extract: FileExtract,
    request: string,
    specifiers: [string, string][],
    wildcard: boolean,
  ): ResolvedImport[] => {
    switch (extract.lang) {
      case "python":
        return python(extract.path, request, specifiers);
      case "go":
        return go(extract.path, request);
      case "rust":
        return rust(extract.path, request);
      case "java":
        return java(extract.path, request, wildcard);
      default: {
        const to = resolveImport(extract.path, request, ctx.knownFiles, ctx.aliases);
        return to ? [{ to }] : [];
      }
    }
  };
}

function makeNode(file: RepoFile, babelNode: t.Node, name: string, kind: GraphNode["kind"]): GraphNode {
  const startLine = babelNode.loc?.start.line ?? 1;
  const endLine = babelNode.loc?.end.line ?? startLine;
  const start = babelNode.start ?? 0;
  const end = babelNode.end ?? start;
  const body = file.source.slice(start, end);
  const jsdoc = extractLeadingJsdoc(file.source, babelNode);
  const snippet = `${jsdoc ? `${jsdoc}\n` : ""}${body}`.slice(0, 2000);

  return {
    id: nodeId(file.path, name, startLine),
    kind,
    name,
    file: file.path,
    folder: file.path.split("/")[0] || ".",
    loc: Math.max(1, endLine - startLine + 1),
    signature: synthesizeSignature(body, name, kind),
    snippet,
    startLine,
    endLine,
  };
}

function synthesizeSignature(snippet: string, name: string, kind: GraphNode["kind"]): string {
  const compact = snippet.split(/\r?\n/)[0]?.trim().replace(/\s+/g, " ");
  if (compact) {
    return compact.length > 160 ? `${compact.slice(0, 157)}...` : compact;
  }

  return kind === "class" ? `class ${name}` : `function ${name}`;
}

/**
 * Resolve an import specifier to a known repo file: relative paths first,
 * then tsconfig/jsconfig `paths`/`baseUrl`. When the file set carries no
 * config at all (e.g. a source-only ingest), fall back to the near-universal
 * `@/` and `~/` conventions rooted at the repo or `src/`.
 */
export function resolveImport(
  fromFile: string,
  request: string,
  knownFiles: Set<string>,
  aliases: PathAliases[] = [],
): string | null {
  let bases: string[];
  if (request.startsWith(".")) {
    bases = [path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), request))];
  } else if (aliases.length > 0) {
    bases = aliasCandidates(fromFile, request, aliases);
  } else if (/^[@~]\//.test(request)) {
    const rest = request.slice(2);
    bases = [rest, `src/${rest}`];
  } else {
    return null;
  }

  for (const base of bases) {
    const probe = base.replace(/^\.\//, "");
    const candidates = [
      probe,
      ...EXTENSIONS.map((extension) => `${probe}${extension}`),
      ...EXTENSIONS.map((extension) => path.posix.join(probe, `index${extension}`)),
      // NodeNext-style `./foo.js` that really points at `foo.ts`.
      ...(/\.m?jsx?$/.test(probe)
        ? [probe.replace(/\.m?js$/, ".ts").replace(/\.jsx$/, ".tsx")]
        : []),
    ];
    const hit = candidates.find((candidate) => knownFiles.has(candidate));
    if (hit) return hit;
  }
  return null;
}

function calleeName(callee: t.Expression | t.V8IntrinsicIdentifier): { name: string; namespace?: string } | null {
  if (callee.type === "Identifier") {
    return { name: callee.name };
  }

  if (callee.type === "MemberExpression" && !callee.computed) {
    const property = callee.property;
    const object = callee.object;
    if (property.type !== "Identifier") {
      return null;
    }

    return {
      name: property.name,
      namespace: object.type === "Identifier" ? object.name : undefined,
    };
  }

  return null;
}

function findEnclosingNode(ranges: NodeRange[], start: number): GraphNode | null {
  let selected: NodeRange | null = null;
  for (const range of ranges) {
    if (range.start <= start && start <= range.end) {
      if (!selected || range.end - range.start < selected.end - selected.start) {
        selected = range;
      }
    }
  }

  return selected?.node ?? null;
}

function resolveCallTarget(
  call: PendingCall,
  nodesByFileAndName: Map<string, GraphNode>,
  fileImports: FileImport[],
): GraphNode | null {
  const sameFileTarget = nodesByFileAndName.get(`${call.file}#${call.calleeName}`);
  if (sameFileTarget) {
    return sameFileTarget;
  }

  for (const fileImport of fileImports) {
    if (call.namespace) {
      if (!fileImport.namespaces.has(call.namespace)) continue;
      const target = nodesByFileAndName.get(`${fileImport.to}#${call.calleeName}`);
      if (target) return target;
      continue;
    }

    const importedName =
      fileImport.specifiers.get(call.calleeName) ?? (fileImport.wildcard ? call.calleeName : undefined);
    if (!importedName) {
      continue;
    }

    const target =
      nodesByFileAndName.get(`${fileImport.to}#${importedName}`) ??
      nodesByFileAndName.get(`${fileImport.to}#${call.calleeName}`);
    if (target) {
      return target;
    }
  }

  return null;
}

function extractLeadingJsdoc(source: string, node: t.Node): string {
  const comments = "leadingComments" in node ? node.leadingComments : undefined;
  const candidate = comments?.at(-1);
  if (
    !candidate ||
    candidate.type !== "CommentBlock" ||
    !candidate.loc ||
    !candidate.value.startsWith("*")
  ) {
    return "";
  }
  const start = candidate.start ?? 0;
  const end = candidate.end ?? start;
  return source.slice(start, end);
}
