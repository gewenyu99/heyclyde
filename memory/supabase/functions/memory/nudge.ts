// R75 (#80): task-shift gating for UserPromptSubmit hooks. Pure string logic with zero external imports so Deno and Node
// unit tests run it with --node-modules-dir=none, while service.ts supplies the session's prior cwd, idle gap, and last
// retrieval from Postgres.
export { classifyPromptShift, type PromptShiftInput } from "./core/nudge.ts";
