/** Every prompt and question clyde-flow writes. Workers, judges and the user read these, so they follow lanes/voice.md. */
import type { Check, Run, StageSpec } from './types.ts'
import { tail } from './verdict.ts'
import type { Plan, Slice } from './memory.ts'

// pi takes the prompt as one argv word, and Linux caps one word at 128 KiB, so the diff in a judge prompt is cut well below.
const DIFF_IN_PROMPT = 50_000
const CHECK_IN_PROMPT = 4000

const RESULT_BLOCK = '```json\n{"status": "done", "summary": "...", "evidence": [{"criterion": "...", "evidence": "..."}]}\n```'
export const PLAN_RESULT_BLOCK = '```json\n{"status": "done", "summary": "...", "evidence": [{"criterion": "...", "evidence": "..."}], "plan": {"intent": "...", "slices": [{"id": "s1", "title": "...", "acceptance": ["npm test"]}]}}\n```'
// Fail-shaped on purpose: a judge that echoes the template can only fail the stage.
const VERDICT_BLOCK = '```json\n{"verdict": "fail", "criteria": [{"criterion": "...", "pass": false, "evidence": "..."}], "notes": "..."}\n```'

export type WorkerPromptInput = { run: Run; spec: StageSpec; attempt: number; notes?: string; skillFile?: string; root: string; bin: string }

export function memoryMaintenance(run:Run):boolean {
  const input=(run.input??{}) as {prompt?:string;intent?:string}
  const request=(input.prompt??input.intent??'').split('Clyde project notes')[0].slice(0,2000)
  return /\b(?:groom|consolidat\w*|organize|clean(?: up)?)\b.{0,70}\bmemor(?:y|ies)\b|\bmemor(?:y|ies)\b.{0,70}\b(?:housekeeping|house cleaning|cleanup|grooming)\b/is.test(request)
}

export function workerPrompt(o: WorkerPromptInput): string {
  const { run, spec } = o
  if (planning(spec) && spec.extract && spec.resultTemplate) {
    return [
      `You're the worker for stage ${spec.name} of clyde run ${run.id}, attempt ${o.attempt}. Prepare a plan for review in ${run.cwd}, the worktree for ${run.repo}. Implementation starts only after the user approves it.`,
      o.skillFile && `Read the planning guidance in ${o.skillFile}.`,
      spec.prompt.trim(),
      `The reviewer will check these criteria:\n${numbered(spec.criteria)}`,
      o.notes && `Feedback on the previous attempt:\n${o.notes}`,
      `Inspect the relevant source. Return the plan and its evidence directly in one final fenced JSON block. Clyde records this response automatically. No file edits, commits, CLI progress reports, or separate result files are needed.\n\n${spec.resultTemplate}`,
    ].filter(Boolean).join('\n\n')
  }
  const scope = `run:${run.id}`
  const parts = [
    `You're the worker for stage ${spec.name} of clyde run ${run.id}, attempt ${o.attempt}.`,
    "The user approved this run's plan. Don't stop to ask questions. Do the work, then report. When you can't finish, report blocked and say why.",
  ]
  if(memoryMaintenance(run))parts.push(
    "This is shared-memory maintenance. Leave all repository files, git history, original notes and artifacts intact. The deliverable lives in Clyde.",
    "Use the executable at "+o.bin+" (or clyde on PATH). For the actual shared notes, use clyde notes recall QUERY, clyde notes more RETRIEVAL_ID, and clyde notes get ID. Read relevant originals and their evidence. Rate recall batches with clyde notes feedback RETRIEVAL_ID JSON. Join genuinely adjacent notes with clyde notes index --title TITLE --body BODY --source ID --source ID. Include useful search terms and source-grounded details. This writes an additional linked note, preserves the originals and verifies links by reading it back. Run-scoped clyde remember writes are only work logs. Report verified index IDs, source IDs and any missed queries addressed. If no safe changes are justified say exactly why."
  )
  if (o.skillFile) {
    parts.push(`## The skill\n\nRead ${o.skillFile} first and follow it. CLAUDE_PLUGIN_ROOT is ${o.root}, so $LV and \${CLAUDE_PLUGIN_ROOT} in the skill mean that path. Where the skill says to keep a state file or to ask the user, use memory and clyde result as below.`)
  }
  parts.push(`## The task\n\n${spec.prompt.trim()}`)
  parts.push(`## The gate\n\nAn independent judge reads your diff and grades each of these. The stage passes only when all of them hold.\n\n${numbered(spec.criteria)}`)
  if (spec.checks?.length) {
    parts.push(`## The checks\n\nThe runtime runs these in your directory when you finish. Each must exit 0.\n\n${spec.checks.map((c) => `- \`${c}\``).join('\n')}`)
  }
  if (o.notes) parts.push(`## Notes from the last attempt\n\nThe last attempt failed. Fix what this says first.\n\n${o.notes.trim()}`)
  parts.push([
    '## How to work',
    '',
    memoryMaintenance(run) ? 'Work on the bound Clyde memory through clyde notes. No repository edits or commits are needed.' : `- **Work here.** Your directory is ${run.cwd}, on branch ${run.branch}. Commit locally on the current branch. Never push, and never switch branches.`,
    `- **Read the handoff.** Earlier stages left notes in memory scope ${scope}. Start with clyde recall "${spec.name}" --scope ${scope}.`,
    `- **Record as you go.** Write rulings and your gate evidence with clyde remember --pattern observations --title T --body B. Add --blob-file F for long evidence. They land as drafts in ${scope}.`,
    `- **Work from your list.** clyde keeps your work list and puts it at the top of every turn. It starts with one item per gate criterion. Add your own steps with clyde todo add "<step>". Before you change a file, start an item with clyde todo start N --how "<how>". Finish it with clyde todo done N --evidence "<command and result, path:line, or sha>", or clyde todo block N --why "<why>".`,
    `- **Say what you're doing.** Post one line with clyde progress "<line>" as you start each step.`,
    `- **Report once.** Finish with clyde result --status done --summary S --evidence-file F. F holds a JSON list of {"criterion", "evidence"}, one per gate item. clyde refuses done while list items are open. Use --status blocked when you can't finish, after you block the item that stopped you.`,
    '',
    `clyde is on PATH. If it isn't, run node ${o.bin} in its place.`,
    '',
    spec.resultTemplate
      ? `This stage needs an artifact in your last message even if clyde result succeeds. End your last message with this fenced json block. If clyde result fails, this block is also your result:\n\n${spec.resultTemplate}`
      : `If clyde result fails, end your last message with this fenced json block instead:\n\n${RESULT_BLOCK}`,
  ].join('\n'))
  return parts.join('\n\n')
}

export type JudgePromptInput = {
  run: Run; spec: StageSpec; base: string; commits: string; diff: string; checks: Check[]; artifact?: unknown
}

/** Read-only and adversarial. It never gets the worker's transcript or result, only what the worker changed. */
/** A planning stage hands over a plan as its artifact and changes no code. */
export function planning(spec: { role?: string; name: string }): boolean {
  return spec.role === 'planner' || /^plan(-\d+)?$/.test(spec.name)
}

export function judgePrompt(o: JudgePromptInput): string {
  const { run, spec } = o
  const scope = `run:${run.id}`
  const parts = [
    `You're the judge for stage ${spec.name} of clyde run ${run.id}. You're read-only. Don't edit files, commit, or run anything that writes.`,
    planning(spec)
      // A plan is a document. Asking it for diffs, test runs or red and green evidence that only exist once code is built
      // fails every plan forever, so the planner gets sent back without end.
      ? 'This stage produces a plan, not code. Grade the plan in the artifact below against the gate, and be strict about the plan itself: vague slices, missing checks, gaps in the intent, or paths that don\'t exist fail. Don\'t ask for a diff, commits, test runs, or red and green evidence. Those come when each slice is built and judged. Read the repo to confirm the paths and commands the plan names.'
      : 'Grade the change against the gate, and be adversarial. Default to fail. A criterion passes only when you can point at its evidence in the diff, the check output, the files or memory. A claim with no evidence fails.',
    `## The gate\n\n${numbered(spec.criteria)}`,
  ]
  const shown = o.diff.length > DIFF_IN_PROMPT ? `${o.diff.slice(0, DIFF_IN_PROMPT)}\n[The diff is cut here at ${DIFF_IN_PROMPT} of ${o.diff.length} characters. Read the files for the rest.]` : o.diff
  parts.push([
    '## The change',
    '',
    `Your directory is ${run.cwd}, on branch ${run.branch}. The stage started at ${o.base}.`,
    '',
    o.commits ? `Commits since then:\n\n${o.commits}` : 'No commits since then.',
    '',
    o.diff.trim() ? `The diff since ${o.base}, including uncommitted files:\n\n\`\`\`diff\n${shown.trimEnd()}\n\`\`\`` : `Nothing changed since ${o.base}.`,
  ].join('\n'))
  if (o.checks.length) {
    parts.push(`## The checks\n\nThe runtime ran these in the directory.\n\n${o.checks.map(checkBlock).join('\n\n')}`)
  }
  if (o.artifact !== undefined) {
    parts.push(`## The artifact\n\nThe stage produced this. Grade it against the gate too.\n\n\`\`\`json\n${JSON.stringify(o.artifact, null, 2)}\n\`\`\``)
  }
  parts.push(`## The handoff\n\nThe run's notes are in memory scope ${scope}. Recall them with the memory recall tool, or clyde recall "<query>" --scope ${scope}, when you can. They're the workers' own claims, so check each against the diff before you trust it.`)
  parts.push([
    '## Your answer',
    '',
    'Grade every gate item, in order. Give the criterion, pass as true or false, and the evidence you checked. notes says what the next attempt must fix, or what you checked when it all passes. verdict is pass only when every criterion passes.',
    '',
    `When you have a structured output tool, answer through it. Otherwise end your last message with one fenced json block:\n\n${VERDICT_BLOCK}`,
  ].join('\n'))
  return parts.join('\n\n')
}

function checkBlock(c: Check): string {
  return `\`${c.cmd}\` exited ${c.code}:\n\n\`\`\`\n${tail(c.output.trim(), CHECK_IN_PROMPT) || '(no output)'}\n\`\`\``
}

function numbered(items: string[]): string {
  return items.map((c, i) => `${i + 1}. ${c}`).join('\n')
}

export function firstLine(text: string): string {
  return firstLines(text, 1)
}

function firstLines(text: string, n = 3): string {
  return text.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, n).join(' ')
}

/** Ends text with one period, so a quoted reason never reads "it failed.." */
function sentence(text: string): string {
  return `${text.replace(/[.\s]+$/, '')}.`
}

// ---------------------------------------------------------------- questions for the user

export function blockQuestion(run: Run, stage: string, reason: string): string {
  return `Stage ${stage} of run ${run.id} is blocked. The judge accepted the worker's reason: ${sentence(firstLines(reason))} Answer stop, or tell the worker how to proceed.`
}

export function limitQuestion(run: Run, stage: string, error: string): string {
  return `Stage ${stage} of run ${run.id} hit a backend limit: ${sentence(firstLines(error))} Answer stop, or retry after the limit is restored.`
}

export function memoryQuestion(run: Run, error: string): string {
  return `Run ${run.id} can't reach memory: ${sentence(firstLines(error, 1))} Flows hand off through memory, so the run waits. Answer retry once memory is back, or stop.`
}

export function approvalQuestion(run: Run, plan: Plan, entry: string): string {
  const slices = plan.slices.map((s) => `- ${s.id}: ${s.title}${s.acceptance.length ? ` (${s.acceptance.map((c) => `\`${c}\``).join(', ')})` : ''}`)
  return [
    `Approve the plan for run ${run.id}? ${plan.intent}`,
    '',
    ...slices,
    '',
    `The full plan is memory entry ${entry}. Read it with clyde plan show --run ${run.id}. Answer approved, or say what to change and the planner replans.`,
  ].join('\n')
}

export function finalQuestion(run: Run, o: { commits: number; review: string; verdict: string }): string {
  return `Run ${run.id} finished every stage. The work is on branch ${run.branch} in ${run.cwd}, ${o.commits} commit${o.commits === 1 ? '' : 's'} since ${run.base.slice(0, 12)}. Review: ${sentence(firstLines(o.review) || 'no summary')} Judge verdict: ${o.verdict}. Approve to close the run. Pushing and the pull request stay with you.`
}

/** Only a bare yes approves. "Approved, but rename X" replans, so a condition never gets lost. */
export function isApproval(answer: string): boolean {
  return /^\s*(approved?|yes|y|ok|okay|lgtm|ship it|go( ahead)?)\s*[.!]*\s*$/i.test(answer)
}

// ---------------------------------------------------------------- ship's stage prompts

export const PLAN_CRITERIA = [
  "Slices are the right size. Each one fits a cheap rung, Sonnet 5.5 or GPT-6.1 Sol at medium, in one judged stage, and no smaller: two neighbours a cheap rung could do together are one slice. Most plans have 5 to 30. They're in dependency order.",
  'Acceptance is concrete. Each slice names its own check, a command run from the repo root, that would fail before the slice lands and pass after. The plan states the check, and nobody runs it until the slice is built.',
  'The intent is covered. Every part of the intent lands in a slice, or the plan names it as left out and says why.',
  'The plan fits the code. Every path, module and command it names exists in this repo, or the plan says a slice creates it.',
]

export const REVIEW_CRITERIA = [
  'Pinned to commits. The review names the base and head it read, and the head is this branch.',
  'Findings confirmed. Every finding left open has a file, a line, and evidence that it is real.',
  'Fixes hold. Each fix is its own commit, and every acceptance check still passes.',
]

export function planPrompt(intent: string, notes?: string): string {
  const parts = [
    `Plan this change: ${intent.trim()}`,
    "Work it out from the code in your directory. Don't change any files.",
    'Decompose the work until each slice is small enough for a cheap rung, Sonnet 5.5 or GPT-6.1 Sol at medium, to carry out. Put slices in dependency order. Each slice needs its own acceptance check that detects its specific change, fails before that slice lands, and passes after. Run checks from the repo root. Cover every part of the intent, including work in task flows, or name what is left out and why. Say which slice creates each new file or command target.',
    'The plan must be in the plan field of the fenced json block at the end of your last message. The stage instructions below show the exact result shape.',
  ]
  if (notes?.trim()) parts.push(`The user didn't approve the last plan. Their answer:\n\n${notes.trim()}\n\nReplan with it.`)
  return parts.join('\n\n')
}

export function slicePrompt(run: Run, plan: Plan, slice: Slice, skill: string): string {
  const scope = `run:${run.id}`
  return [
    `Build slice ${slice.id} of the approved plan: ${slice.title}.`,
    `The plan's intent: ${plan.intent}`,
    slice.acceptance.length ? `The runtime runs this slice's acceptance after you finish:\n\n${slice.acceptance.map((c) => `- \`${c}\``).join('\n')}` : 'This slice has no acceptance commands, so the judge reads the diff alone.',
    `The plan is in memory scope ${scope}. Read it with clyde plan show --run ${run.id}, or clyde recall "plan" --scope ${scope}.`,
    `Do only the ${skill} stage. The next stage runs as its own worker once this one passes.`,
  ].join('\n\n')
}

export function reviewPrompt(run: Run): string {
  return [
    `Review every change on branch ${run.branch} since ${run.base}, where the run started. Pin the target to ${run.base} and HEAD.`,
    'Fix each confirmed finding with its own commit, and keep every acceptance check passing. List what you leave open with a file and a line.',
    'Put the outcome in your summary: how many findings, how many fixed, and how many open.',
  ].join('\n\n')
}
