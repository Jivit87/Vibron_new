import { describe, expect, it } from "vitest";
import { signatureImpact, signatureIndex } from "@/lib/harness/impact";
import { makeWorkspace } from "./helpers/harness-workspace";

const config = (sig: string) => `export function parseConfig(${sig}) {\n  return { path };\n}\n`;
const server = 'import { parseConfig } from "./config";\n\nexport function startServer() {\n  return parseConfig("a.json");\n}\n';
const cli = 'import { parseConfig } from "./config";\n\nexport function main() {\n  parseConfig("b.json");\n}\n';

async function graphs(after: string) {
  const files = (cfg: string) => [
    { path: "src/config.ts", source: cfg },
    { path: "src/server.ts", source: server },
    { path: "src/cli.ts", source: cli },
  ];
  const before = (await makeWorkspace(files(config("path: string")))).engine.graph;
  const now = (await makeWorkspace(files(after))).engine.graph;
  return { base: signatureIndex(before), now };
}

describe("signatureImpact (zero-token impact check)", () => {
  it("names untouched callers when a signature changes", async () => {
    const { base, now } = await graphs(config("path: string, strict: boolean"));
    const note = signatureImpact(base, now, ["src/config.ts"], new Set(["src/config.ts"]), new Set());
    expect(note).toMatch(/parseConfig/);
    expect(note).toMatch(/src\/server\.ts:\d+ `startServer`/);
    expect(note).toMatch(/src\/cli\.ts:\d+ `main`/);
  });

  it("leaves out callers the agent already edited", async () => {
    const { base, now } = await graphs(config("path: string, strict: boolean"));
    const note = signatureImpact(base, now, ["src/config.ts"], new Set(["src/config.ts", "src/cli.ts"]), new Set());
    expect(note).toMatch(/startServer/);
    expect(note).not.toMatch(/`main`/);
  });

  it("is silent when only a body changes", async () => {
    const { base, now } = await graphs("export function parseConfig(path: string) {\n  return { path, ok: true };\n}\n");
    expect(signatureImpact(base, now, ["src/config.ts"], new Set(["src/config.ts"]), new Set())).toBeNull();
  });

  it("reports each symbol once per attempt", async () => {
    const { base, now } = await graphs(config("path: string, strict: boolean"));
    const reported = new Set<string>();
    expect(signatureImpact(base, now, ["src/config.ts"], new Set(["src/config.ts"]), reported)).not.toBeNull();
    expect(signatureImpact(base, now, ["src/config.ts"], new Set(["src/config.ts"]), reported)).toBeNull();
  });

  it("works on Python", async () => {
    const files = (sig: string) => [
      { path: "pkg/config.py", source: `def parse_config(${sig}):\n    return path\n` },
      { path: "pkg/server.py", source: "from pkg.config import parse_config\n\n\ndef start_server():\n    return parse_config('a')\n" },
    ];
    const base = signatureIndex((await makeWorkspace(files("path"))).engine.graph);
    const now = (await makeWorkspace(files("path, strict=False"))).engine.graph;
    const note = signatureImpact(base, now, ["pkg/config.py"], new Set(["pkg/config.py"]), new Set());
    expect(note).toMatch(/pkg\/server\.py:\d+ `start_server`/);
  });
});
