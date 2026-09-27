import { describe, expect, it } from "vitest";

import { buildGraphSlice, ContextLedger, type EngineInput } from "@/lib/context/engine";
import { parseRepo } from "@/lib/parser";
import { countTokens } from "@/lib/tokens";

const helpers = Array.from(
  { length: 30 },
  (_, i) => `export function helper${i}(value: number): number {\n  const doubled = value * ${i + 2};\n  return doubled + ${i};\n}\n`,
).join("\n");

const FILES = [
  {
    path: "src/cart.ts",
    source: `import { helper1, helper2 } from "./helpers";\n\nexport class Cart {\n  items: number[] = [];\n  total(): number {\n    return this.items.reduce((a, b) => a + helper1(b), 0);\n  }\n}\n\n/** Price of the cart including tax. */\nexport function cartTotalWithTax(cart: Cart, rate: number): number {\n  return helper2(cart.total()) * (1 + rate);\n}\n`,
  },
  { path: "src/helpers.ts", source: helpers },
];

function engine(): EngineInput {
  const { graph } = parseRepo(FILES);
  const files: Record<string, unknown> = {};
  for (const f of FILES) files[f.path] = { path: f.path, hash: "", tokens: countTokens(f.source), exports: [], imports: [] };
  return { graph, memory: { files } as never, fileInfo: [], readFile: async () => null, ledger: new ContextLedger() };
}

describe("graph slice", () => {
  it("shows the matched symbol's body and only signatures for neighbours", () => {
    const slice = buildGraphSlice(engine(), "cartTotalWithTax applies the tax twice", { maxNodes: 30 });
    expect(slice.text).toContain("return helper2(cart.total()) * (1 + rate);");
    // Neighbours are listed by signature, their bodies are not sent.
    expect(slice.text).toMatch(/helper2\(value: number\): number/);
    expect(slice.text).not.toContain("const doubled = value * 4;");
    expect(slice.tokens).toBeLessThanOrEqual(2000);
    expect(slice.nodeIds.length).toBeGreaterThan(1);
  });

  it("respects a token ceiling", () => {
    const slice = buildGraphSlice(engine(), "cart total helper value", { maxNodes: 60, maxTokens: 300 });
    expect(slice.tokens).toBeLessThanOrEqual(420);
    expect(slice.text).toMatch(/omitted for size|with bodies/);
  });

  it("does not resend a body the same agent already saw", () => {
    const eng = engine();
    const first = buildGraphSlice(eng, "cartTotalWithTax is wrong");
    const second = buildGraphSlice(eng, "cartTotalWithTax tax rate is wrong again");
    expect(first.text).toContain("(1 + rate)");
    expect(second.text).not.toContain("(1 + rate);\n");
    expect(second.text).toContain("body shown earlier");
    expect(second.tokens).toBeLessThan(first.tokens);
    // A different agent (fork) has not seen it.
    const other = buildGraphSlice({ ...eng, ledger: eng.ledger.fork("b") }, "cartTotalWithTax tax rate is wrong again");
    expect(other.text).toContain("(1 + rate)");
  });
});
