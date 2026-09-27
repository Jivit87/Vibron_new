/**
 * The solver, the blind test writer, the criteria call and the reviewer can
 * all be talking to the model at once. Route each fake request to its own
 * script by role (read from the system prompt), so tests do not depend on
 * which concurrent call happens to ask first.
 */

import type { AiTurnRequest } from "@/lib/ai";
import type { ScriptedTurn } from "./fake-provider";

export type Who = "solver" | "writer" | "reviewer" | "criteria";

export const whoAsked = (req: AiTurnRequest): Who => {
  const system = JSON.stringify(req.system);
  if (system.includes("independent QA engineer")) return "writer";
  if (system.includes("reviewing a code change")) return "reviewer";
  if (system.includes("meticulous senior maintainer")) return "criteria";
  return "solver";
};

export function routed(queues: Partial<Record<Who, ScriptedTurn[]>>): ScriptedTurn[] {
  const total = Object.values(queues).reduce((n, q) => n + q.length, 0);
  return Array.from({ length: total }, () => (req: AiTurnRequest) => queues[whoAsked(req)]?.shift() ?? { text: "Done." });
}
