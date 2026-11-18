// MCP over streamable HTTP, stateless, JSON responses only. initialize mints an Mcp-Session-Id and records the client's
// name, so a later call in any isolate knows claude from codex and keeps the arm its session drew. GET gets 405, which
// the spec allows a server that offers no stream.
import type { Principal } from "./auth.ts";
import type { Verdict } from "./billing/entitlement.ts";
import * as limits from "./billing/limits.ts";
import { config } from "./config.ts";
import { sql } from "./db.ts";
import * as quests from "./quests.ts";
import * as service from "./service.ts";
import { CARD_KEY as CARD, readUiResource, requestWantsUi, UI_EXTENSION, uiResources, uiTools, wantsUi } from "./ui/apps.ts";
import { type Badge, cardData } from "./ui/data.ts";
import { clientStatus, installerNote, SERVER_VERSION } from "./version.ts";
import { Refused, remember } from "./write.ts";
import {
  AGENT_CONTEXTS,
  AGENT_TYPES,
  type AgentScope,
  type EntryFilter,
  normalizeComputer,
  normalizeProjectSlug,
} from "./permissions.ts";

export const MAX_MCP_BODY = 12 * 1024 * 1024;
const RID = /^retrieval ([0-9a-f-]{36})/;
const VERSIONS =["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
// R53 (#58): the stores' reviews read this text. It says what each tool does and never tells the model what to call or
// when. The recall-first and feedback guidance lives in the Claude Code plugin's skill (plugins/memory/skills/clyde).
export const INSTRUCTIONS = "Clyde keeps one set of notes for all of a person's AI agents: what one agent learns, every other agent can " +
  "recall. register_agent names the agent once per token and app (name, context work, home, hobby, personal or both, surface, " +
  "description, plus optional nickname, type, harness, repos, projects, computer, strict_projects), so its notes and messages carry that name. recall searches " +
  "the notes: decisions, preferences, observations and past reactions, with optional category, context, project or transferability " +
  "filters. Each result packet starts with a retrieval id. recall_more takes that id and returns the next page, dormant and " +
  "replaced notes included. feedback takes the same id and a verdict (used, irrelevant or wrong) for each result shown, those under " +
  "On trial included, or nothing_useful, and ranking learns from it. remember writes a note: it needs only pattern, title, body " +
  "and evidence. A note stays under 500 characters, with the details in artifacts: [{name, kind, text or base64 or sha256}]. recall " +
  "lists a note's artifacts by name and kind, get_blob reads one, and upload_blob takes a file too big to send inline. Agents leave " +
  "each other messages: check_messages lists them with ids, ack_messages marks them handled, and post_message sends one. The quest " +
  "board hands work between agents: post_quest puts a task up with a title, a short brief, done_when (how anyone can tell it's " +
  "finished) and the details in artifacts. list_quests shows the open quests for a context and projects. claim_quest takes one " +
  "under a 2-hour lease, so no other agent works on it. update_quest reports progress and renews the lease, and a lease that runs out " +
  "puts the quest back on the board. complete_quest closes a quest with the evidence and the id of the note the work produced. " +
  "abandon_quest gives a claimed quest back, or withdraws a posted one. Done quests stay as history that recall finds.";

const str = (description: string) => ({ type: "string", description });
const int = (description: string) => ({ type: "integer", description });
/** A tool's title and hints. None reaches outside Clyde. A tool that writes says whether it can delete, supersede or
 * overwrite (destructive) or only adds. */
const hints = (title: string, readOnly: boolean, destructive?: boolean) => ({
  title,
  annotations: { title, readOnlyHint: readOnly, ...(readOnly ? {} : { destructiveHint: Boolean(destructive) }), openWorldHint: false },
});
const HELD = "[{name, sha256}] of files Clyde holds";

export const TOOLS = [
  {
    name: "register_agent",
    ...hints("Register agent", false, true),
    description: "Names the agent using this token and app, once. Clyde keeps it for this token and app, so later sessions " +
      "start registered, and the agent's notes and messages carry its name. Until then, each reply carries a reminder.\n\n" +
      "name: a short lowercase handle, like clyde-work or journeymate-ios. An agent that has a name reuses it.\n" +
      "context: work, home, hobby, personal or both: the part of the person's life the agent works on.\n" +
      "surface: where the agent runs, like claude-code, claude.ai, cowork, codex or a script.\n" +
      "description: one or two sentences on what the agent does.\n" +
      "nickname: optional short unique nickname per owner (lowercase letters, digits, dashes and underscores).\n" +
      "repos: optional list of owner/repo names or project slugs the agent can reach.\n" +
      "harness: optional client harness name; inferred from clientInfo.name when omitted.\n" +
      "projects: optional list of project slugs or owner/repo names the agent works on.\n" +
      "computer: optional machine name the agent runs on.\n" +
      "type: optional role (coding, exploration, research, review, ops, assistant or other).\n" +
      "strict_projects: optional boolean; true locks project-scoped reads to the declared projects.",
    inputSchema: {
      type: "object", required: ["name", "context", "surface", "description"],
      properties: {
        name: str("Lowercase handle, letters, digits and dashes"), context: str("work, home, hobby, personal or both"),
        surface: str("Where the agent runs"), description: str("What the agent does"),
        nickname: str("Optional unique nickname per owner (1-40 lowercase letters, digits, dashes and underscores)"),
        repos: { type: "array", items: { type: "string" }, description: "Repositories or project slugs the agent can reach" },
        harness: str("Optional client harness name; inferred from clientInfo.name when omitted"),
        projects: { type: "array", items: { type: "string" }, description: "Project slugs or owner/repo names" },
        computer: str("Computer or machine name (1-64 characters)"),
        type: { type: "string", enum: [...AGENT_TYPES], description: "Agent type: coding, exploration, research, review, ops, assistant or other" },
        strict_projects: { type: "boolean", description: "True to strictly limit project-scoped reads to declared projects" },
      },
    },
  },
  {
    name: "recall",
    ...hints("Recall notes", true),
    description: "Searches the notes the person's agents have saved: decisions, preferences, observations and past reactions.\n\n" +
      "query: what to find, in English or 中文.\n" +
      "task: optional one-line description of the current work, to sharpen the search.\n" +
      "scope: optional run scope like run:abc. That run's notes rank first. Other runs' notes are searched too.\n" +
      "depth: optional, packet (the default) or deep, which adds the page recall_more would give next.\n" +
      "category, context, project, transferability: optional filters to narrow results within permitted scope.\n" +
      "Results start with a retrieval id, which recall_more and feedback take. feedback on a recall tells Clyde which " +
      "results helped, so ranking learns what to keep.",
    inputSchema: {
      type: "object", required: ["query"],
      properties: {
        query: str("What to find"), task: str("The current work"), scope: str("run:<id>"),
        depth: str("packet (default) or deep: the packet and the next page past it, in one request"),
        category: str("Optional category filter, e.g. architecture, billing, style, preferences"),
        context: str("Optional realm filter: general, work, home, hobby, personal or all"),
        project: str("Optional project slug filter, e.g. clyde or owner/repo"),
        transferability: str("Optional transferability filter: general, context, project or computer"),
      },
    },
  },
  {
    name: "recall_more",
    ...hints("Recall more", true),
    description: "The next page of a recall: past what that recall showed, in the order it ranked them, then the notes recall " +
      "leaves out, dormant (low strength) and superseded ones included. Each item is labelled with its kind, strength and " +
      "state: settled, on trial, dormant, or superseded by its replacement. Each page has its own retrieval id, for feedback " +
      "and for the page after. A dormant note rated used comes back. Only the session that made the recall can page through it.",
    inputSchema: {
      type: "object", required: ["retrieval_id"],
      properties: { retrieval_id: str("The retrieval id of the recall, or of the last recall_more page") },
    },
  },
  {
    name: "get_entry",
    ...hints("Get note", true),
    description: "Opens one note by id, with its evidence, source, links and artifacts.",
    inputSchema: { type: "object", required: ["id"], properties: { id: str("Entry id") } },
  },
  {
    name: "get_blob",
    ...hints("Read artifact", true),
    description: "Reads an artifact that get_entry lists, as text, one page at a time. The reply says how to get the next page. " +
      "An image, video, audio file or other non-text artifact comes back as a link that downloads it for 10 minutes.",
    inputSchema: {
      type: "object", required: ["sha256"],
      properties: { sha256: str("The blob's sha256"), offset: int("First character, default 0"), limit: int("Characters, default 20000") },
    },
  },
  {
    name: "upload_blob",
    ...hints("Upload file", false, false),
    description: "Takes a file too big to send inline with remember, up to 500 MB: an image, video, audio, PDF, zip or long " +
      "text. Give its sha256, its size in bytes and its media type. The reply is a URL to PUT the file to within two hours " +
      "(curl -X PUT --data-binary @file '<url>'). remember then cites the sha256 as an artifact: artifacts: [{name, kind, " +
      "sha256}]. Clyde checks the hash and size when the file is cited. Text with a secret in it is refused.",
    inputSchema: {
      type: "object", required: ["sha256", "size"],
      properties: { sha256: str("sha256 of the file, 64 hex digits"), size: int("Size in bytes"), media_type: str("Like image/png. Default application/octet-stream") },
    },
  },
  {
    name: "remember",
    ...hints("Remember a note", false, true),
    description: "Writes one note. Every other agent can recall it at once, labelled by its kind and marked unreviewed until " +
      "the person or a reviewing agent reviews it. supersedes replaces earlier notes.\n\n" +
      "pattern: projects, decisions, observations, preferences, recommendations, references or reactions.\n" +
      "title, body: a one-line title, and the summary recall ranks on. A note stays under 500 characters, with the details " +
      "in artifacts. A body over 500 characters is refused unless long is true. 4000 is the most.\n" +
      "evidence: what backs it.\n" +
      "kind: observation (default: an inference or summary), fact, wen or plan. A fact starts high only when its evidence " +
      "is a line from a tool's output that Clyde holds: evidence_event is the event id the hook printed, and evidence " +
      "quotes that line word for word. If it isn't in that event, the note is stored as an observation. wen is the " +
      "person's own words, from a prompt event. plan is what the agent means to do.\n" +
      "evidence_event: the id of the hook event that holds the evidence line.\n" +
      "scope: optional, default global. run:<id> hands a note off within a run, and that run's recalls rank it first.\n" +
      "evidence_kind: summary or assistant.\n" +
      "project: optional, default the agent's own notes project. The id of a projects entry files the note under it.\n" +
      'links: [{"type": "supports|contradicts|derived_from|relates|corrects", "to": "<id>"}].\n' +
      "supersedes: ids of notes in the same run that this note replaces. Hybrid recall stops serving them, and the " +
      "index arm lists them struck through.\n" +
      'artifacts: [{"name": "plan.md", "kind": "document", "text": "..."}] for the details: a plan, log, transcript, image, code. ' +
      "Each has a name and one of text (UTF-8), base64 (binary, up to 4 MiB; upload_blob takes bigger files) or sha256 (a " +
      "file sent with upload_blob). kind is image, video, audio, document, skill, artifact, data or other, and Clyde derives " +
      "it when it's left out. Recall lists a note's artifacts by name, kind and size, never their content. blobs still works " +
      "as the same field.\n" +
      "long: true lets a body past 500 characters through.\n" +
      "Returns the entry's id and each artifact's sha256.",
    inputSchema: {
      type: "object", required: ["pattern", "title", "body", "evidence"],
      properties: {
        pattern: str("Entry pattern"), title: str("One-line title"), body: str("Summary recall ranks on"),
        evidence: str("What backs it"), kind: str("observation (default), fact, wen or plan"),
        evidence_event: { type: "integer", description: "The hook event id that holds the evidence line" },
        scope: str("global (default) or run:<id>"), project: str("A projects entry id, default the agent's notes project"),
        evidence_kind: str("summary or assistant"), authority: str("Leave out"), sensitivity: str("normal, private (title only for everyone) or confidential (work: title only for outside models)"),
        lang: str("Language code, default en"), valid_from: str("YYYY-MM-DD"),
        links: { type: "array", items: { type: "object" } }, supersedes: { type: "array", items: { type: "string" } },
        artifacts: { type: "array", items: { type: "object" }, description: "[{name, kind, text | base64 | sha256}]" },
        blobs: { type: "array", items: { type: "object" }, description: "Same as artifacts" },
        long: { type: "boolean", description: "Allow a body past 500 characters" },
        category: str("Optional category slug (1-40 lowercase chars, e.g. architecture, billing, style)"),
        context: str("Optional realm: general, work, home, hobby or personal"),
        transferability: str("Optional transferability: general, context, project or computer"),
        project_slug: str("Optional project slug (e.g. clyde or owner/repo)"),
        computer: str("Optional computer name (1-64 characters)"),
      },
    },
  },
  {
    name: "feedback",
    ...hints("Rate a recall", false, false),
    description: "Rates the results of one recall, once: entries: [{entry_id, verdict}] with verdict used, irrelevant or " +
      "wrong, for each result shown, those under On trial included, or nothing_useful: true when none helped. A result left " +
      "out counts as not used. Only the session that made the recall can rate it, and only once. The older form still " +
      "works: verdict (helpful, used, irrelevant, wrong), with entry_id for one result.",
    inputSchema: {
      type: "object", required: ["retrieval_id"],
      properties: {
        retrieval_id: str("From the packet"),
        entries: {
          type: "array", description: "A verdict for each result shown",
          items: {
            type: "object", required: ["entry_id", "verdict"],
            properties: { entry_id: str("A result's id"), verdict: { type: "string", enum: ["used", "irrelevant", "wrong"] } },
          },
        },
        items: { type: "array", description: "Same as entries", items: { type: "object" } },
        nothing_useful: { type: "boolean", description: "True when no result helped. Not sent with entries." },
        verdict: str("Overall, or for entry_id: helpful, used, irrelevant, wrong or nothing_useful"), entry_id: str("One result, with verdict"),
        note: str("Why, up to 4,000 characters"),
      },
    },
  },
  {
    name: "post_message",
    ...hints("Post message", false, false),
    description: "Leaves a message for the person's other agents. to: claude, codex, all, or another agent Clyde has seen in " +
      "the last 30 days. all reaches the registered agents and claude and codex (optionally filtered by context and project). " +
      "They see it at their next check or prompt. A message to all that no other agent could receive isn't posted. Work " +
      "another agent should pick up goes on the quest board, with post_quest.",
    inputSchema: {
      type: "object", required: ["to", "body"],
      properties: {
        to: str("claude, codex, all or another agent's name"), body: str("The message"),
        context: str("Optional realm filter when to='all': work, home, hobby, personal or both"),
        project: str("Optional project slug filter when to='all'"),
      },
    },
  },
  {
    name: "check_messages",
    ...hints("Check messages", true),
    description: "Lists the messages waiting for this agent from the person's other agents, oldest first, up to 20, each with " +
      "an id. Reading doesn't finish them: ack_messages marks them handled. One left unacknowledged comes back after 30 " +
      "minutes, up to 3 times, then it's dropped and its sender is told.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "ack_messages",
    ...hints("Acknowledge messages", false, true),
    description: "Marks messages handled, by the ids check_messages listed (the hook prints the same ids). Only this agent's own can be acknowledged.",
    inputSchema: {
      type: "object", required: ["ids"],
      properties: { ids: { type: "array", items: { type: "integer" }, description: "Message ids from check_messages" } },
    },
  },
  {
    name: "post_quest",
    ...hints("Post quest", false, false),
    description: "Puts a task on the quest board for the person's other agents to claim, like a mission board. It's for work " +
      "another agent should pick up, not for telling one agent something (that's post_message).\n\n" +
      "title: up to 120 characters.\n" +
      "brief: what to do and why, up to 500 characters. The details go in artifacts.\n" +
      "done_when: one line any agent can check to tell the quest is finished, up to 300 characters.\n" +
      "tags: up to 8 lowercase words.\n" +
      "priority: high, normal (default) or low.\n" +
      "context: work, home, hobby, personal or both. Default: the agent's registered context.\n" +
      "for: who may claim it: any (default), claude, codex, or one agent's name.\n" +
      "project, computer, agent_type: optional restrictions on who can see and claim this quest.\n" +
      "target: optional routing object {types, harness, device_id, device, repo, context}.\n" +
      "artifacts: [{name, sha256}] of files Clyde already holds, like a plan saved with remember. get_entry lists them.\n" +
      "Returns the quest's id. Every agent sees it at session start and in list_quests.",
    inputSchema: {
      type: "object", required: ["title", "brief", "done_when"],
      properties: {
        title: str("Up to 120 characters"), brief: str("What to do and why, up to 500 characters"),
        done_when: str("How anyone can tell it's finished, up to 300 characters"),
        tags: { type: "array", items: { type: "string" }, description: "Up to 8 lowercase words" },
        priority: str("high, normal (default) or low"), context: str("work, home, hobby, personal or both. Default: the agent's own"),
        for: str("any (default), claude, codex, or an agent's name"),
        project: str("Optional project slug"), computer: str("Optional computer restriction"),
        agent_type: { type: "string", enum: [...AGENT_TYPES], description: "Optional agent type restriction" },
        target: {
          type: "object",
          description: "Optional routing target: {types, harness, device_id, device, repo, context}",
          properties: {
            types: { type: "array", items: { type: "string", enum: [...AGENT_TYPES] } },
            harness: str("Required harness name"),
            device_id: int("Required device id"),
            device: str("Required device or machine name"),
            repo: str("Required owner/repo or project slug"),
            context: str("Required realm: work, home, hobby, personal or both"),
          },
        },
        artifacts: { type: "array", items: { type: "object" }, description: HELD },
      },
    },
  },
  {
    name: "list_quests",
    ...hints("List quests", true),
    description: "Reads the quest board. By default, the open quests this agent may claim in its context, high priority first.\n\n" +
      "show: open (default), mine (quests this agent posted or claimed), done (finished, with their evidence and entries) or all.\n" +
      "tag: only quests with this tag.\n" +
      "context: work, home, hobby, personal, both or all. Default: the agent's registered context, else all.\n" +
      "project: optional project slug filter.\n" +
      "limit: how many, 1 to 50, default 20.",
    inputSchema: {
      type: "object",
      properties: {
        show: str("open (default), mine, done or all"), tag: str("One tag"), context: str("work, home, hobby, personal, both or all"),
        project: str("Optional project slug filter"),
        limit: int("1 to 50, default 20"),
      },
    },
  },
  {
    name: "claim_quest",
    ...hints("Claim quest", false, false),
    description: "Takes a quest from the board, so no other agent works on it. The claim is a lease, 2 hours unless " +
      "lease_minutes says otherwise: update_quest renews it, and if it runs out the quest goes back on the board. The reply " +
      "has the brief, done_when, the artifacts and the latest notes. Only one agent can hold a quest.",
    inputSchema: {
      type: "object", required: ["id"],
      properties: { id: int("The quest's id from list_quests"), lease_minutes: int("15 to 480, default 120") },
    },
  },
  {
    name: "update_quest",
    ...hints("Update quest", false, false),
    description: "Reports progress on a claimed quest. The note goes on the quest for every agent to read, and the lease " +
      "starts over.",
    inputSchema: {
      type: "object", required: ["id", "note"],
      properties: { id: int("The quest's id"), note: str("What was done and what's left, up to 1000 characters") },
    },
  },
  {
    name: "complete_quest",
    ...hints("Complete quest", false, false),
    description: "Finishes a claimed quest whose done_when holds. entry_id names the note, saved with remember, that records " +
      "what the work produced, and Clyde writes a history note linked to it, so recall can say what agents did.\n\n" +
      "evidence: how done_when is known to hold, up to 2000 characters.\n" +
      "entry_id: the note the work produced.\n" +
      "artifacts: optional [{name, sha256}] of files Clyde holds that back the evidence.",
    inputSchema: {
      type: "object", required: ["id", "evidence", "entry_id"],
      properties: {
        id: int("The quest's id"), evidence: str("How done_when is known to hold"), entry_id: str("The entry the work produced"),
        artifacts: { type: "array", items: { type: "object" }, description: HELD },
      },
    },
  },
  {
    name: "abandon_quest",
    ...hints("Abandon quest", false, true),
    description: "Lets go of a quest. A claimed quest goes back on the board for another agent, with the reason in its " +
      "notes. A posted quest is withdrawn for good.",
    inputSchema: {
      type: "object", required: ["id", "reason"],
      properties: { id: int("The quest's id"), reason: str("Why, up to 500 characters") },
    },
  },
  {
    name: "dismiss_messages",
    ...hints("Dismiss messages", false, true),
    description: "Clears messages without handling them: ids from check_messages, or \"all\" for everything waiting.",
    inputSchema: {
      type: "object",
      properties: {
        ids: {
          anyOf: [{ type: "array", items: { type: "integer" } }, { type: "string", enum: ["all"] }],
          description: "Message ids, or \"all\"",
        },
      },
    },
  },
];

/** The note for a computer whose hook is too old to update itself, or "" for everyone else. A claude.ai connector (oauth:)
 * has no hook, and neither does a computer that only uses MCP: it has never called a hook and reported no version. */
function installNote(who: Principal) {
  if (who.role !== "device" || who.device?.startsWith("oauth:")) return "";
  if (!who.hookSeen && !who.clientVersion) return "";
  return installerNote(clientStatus(who.clientVersion, config.clientCutoffDays), Boolean(who.updateFailed));
}

/** The profile a session is registered as, or null. */
type Profile = {
  name: string;
  context: string;
  surface: string;
  computer: string | null;
  projects: string[];
  repos: string[];
  agent_type: string;
  type: string;
  harness: string | null;
  device_id: number | null;
  strict_projects: boolean;
};
type Call = {
  session: string; client: string | null; agent: Profile | null; sessionRepo: string | null;
  principal: string; args: Record<string, any>; note: string; entitlement?: Verdict;
};
const s = (v: unknown, fallback = "") => typeof v === "string" ? v : fallback;
const scopeOf = (c: Pick<Call, "agent" | "sessionRepo" | "principal">): AgentScope =>
  c.agent ? {
    name: c.agent.name,
    context: c.agent.context,
    computer: c.agent.computer,
    projects: c.agent.projects,
    agentType: c.agent.agent_type,
    strictProjects: c.agent.strict_projects,
    sessionRepo: c.sessionRepo,
    principal: c.principal,
  } : null;

/** The one line every reply of an unregistered session ends with, as a content block of its own so the tool's text is never
 * changed. Registration is gentle: nothing is refused for lack of it. */
export const NUDGE = "memory: you haven't registered yet. Call register_agent {name, context, surface, description} once: " +
  "context is work, home, hobby, personal or both (plus optional projects, computer, type, strict_projects). memory remembers it for this token and app, and your notes and messages then carry your name.";

const AGENT_NAME = /^[a-z0-9][a-z0-9-]{1,39}$/;
const NICKNAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const CONTEXTS: string[] = [...AGENT_CONTEXTS];
const RESERVED = ["claude", "codex", "all", "wen", "memory"];
// Control characters, NUL included, would reach a note's source line, and Postgres refuses NUL.
// deno-lint-ignore no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]+/g;
const plain = (v: unknown, max: number) => s(v).replace(CONTROL, " ").trim().slice(0, max).trim();

/** Make or update the agent's profile, and bind this session, and this credential's app, to it. A name belongs to the credential
 * that registered it first: another credential's attempt is refused and changes nothing. */
async function register({ session, client, principal, args }: Call) {
  const name = s(args.name).trim().toLowerCase(), context = s(args.context).trim().toLowerCase();
  const surface = plain(args.surface, 40), description = plain(args.description, 500);
  const errs = [
    AGENT_NAME.test(name) ? "" : "name must be 2 to 40 lowercase letters, digits and dashes, starting with a letter or digit.",
    CONTEXTS.includes(context) ? "" : "context must be work, home, hobby, personal or both.",
    surface ? "" : "surface is required: where you run, like claude-code or claude.ai.",
    description ? "" : "description is required: what you do for Wen.",
    RESERVED.includes(name) ? `${name} is reserved. Pick a name of your own.` : "",
  ].filter(Boolean);

  const nicknameProvided = args.nickname !== undefined;
  let nickname: string | null = null;
  if (nicknameProvided && args.nickname !== null && String(args.nickname).trim() !== "") {
    const n = typeof args.nickname === "string" ? args.nickname.trim().toLowerCase() : "";
    if (!NICKNAME_RE.test(n) || RESERVED.includes(n)) {
      errs.push("nickname must be 1 to 40 lowercase letters, digits, dashes and underscores, starting with a letter or digit.");
    } else {
      nickname = n;
    }
  }

  const projectsProvided = args.projects !== undefined || args.repos !== undefined;
  let projects: string[] = [];
  const rawList: unknown[] = [];
  let badList = false;
  for (const [k, v] of [["projects", args.projects], ["repos", args.repos]] as const) {
    if (v !== undefined && v !== null) {
      if (!Array.isArray(v)) {
        errs.push(`${k} must be a list of up to 50 project slugs.`);
        badList = true;
      } else {
        rawList.push(...v);
      }
    }
  }
  if (!badList && rawList.length) {
    const seen = new Set<string>();
    for (const raw of rawList) {
      const slug = normalizeProjectSlug(raw);
      if (!slug) {
        errs.push("each project must be a valid slug or owner/repo name.");
        break;
      }
      if (!seen.has(slug)) {
        seen.add(slug);
        projects.push(slug);
      }
    }
    if (projects.length > 50) errs.push("projects must be a list of up to 50 project slugs.");
  }

  const computerProvided = args.computer !== undefined;
  let computer: string | null = null;
  if (computerProvided && args.computer !== null && args.computer !== "") {
    computer = normalizeComputer(args.computer);
    if (!computer) errs.push("computer must be 1 to 64 characters.");
  }

  const rawType = args.type !== undefined ? args.type : args.agent_type;
  const typeProvided = rawType !== undefined;
  let agentType = "other";
  if (typeProvided && rawType !== null && rawType !== "") {
    const t = typeof rawType === "string" ? rawType.trim().toLowerCase() : "";
    if (!(AGENT_TYPES as readonly string[]).includes(t)) {
      errs.push(`type must be one of ${AGENT_TYPES.join(", ")}.`);
    } else {
      agentType = t;
    }
  }

  const harnessProvided = args.harness !== undefined;
  let harness: string | null = null;
  if (harnessProvided && args.harness !== null && String(args.harness).trim() !== "") {
    harness = plain(args.harness, 64);
    if (!harness) errs.push("harness must be 1 to 64 characters.");
  } else if (!harnessProvided && client) {
    harness = plain(client, 64);
  }

  const strictProvided = args.strict_projects !== undefined;
  let strictProjects = false;
  if (strictProvided && args.strict_projects !== null) {
    if (typeof args.strict_projects !== "boolean") errs.push("strict_projects must be true or false.");
    else strictProjects = args.strict_projects;
  }

  if (errs.length) throw new Refused(errs.join("\n"));

  if (nickname !== null) {
    const [taken] = await sql`select name, registered_by from memory.agent
      where owner_id = memory.owner_default() and lower(nickname) = ${nickname}`;
    if (taken && (taken.name !== name || taken.registered_by !== principal)) {
      throw new Refused(`Nickname ${nickname} is already taken. Pick another nickname.`);
    }
  }

  let deviceId: number | null = null;
  if (principal && principal !== "runtime" && !principal.startsWith("oauth:")) {
    const [dev] = await sql`select id from memory.device
      where owner_id = memory.owner_default() and name = ${principal} and revoked_at is null`;
    deviceId = dev ? Number(dev.id) : null;
  }

  // One statement, so two credentials racing for a new name leave one owner. The where keeps a name with the credential that took it.
  let agent;
  try {
    [agent] = await sql`insert into memory.agent (name, nickname, context, surface, description, registered_by, computer, projects, repos, type, agent_type, harness, device_id, strict_projects)
      values (${name}, ${nickname}, ${context}, ${surface}, ${description}, ${principal}, ${computer}, ${projects}::text[], ${projects}::text[], ${agentType}, ${agentType}, ${harness}, ${deviceId}, ${strictProjects})
      on conflict (owner_id, name) do update set
        nickname = case when ${nicknameProvided}::boolean then excluded.nickname else memory.agent.nickname end,
        context = excluded.context,
        surface = excluded.surface,
        description = excluded.description,
        computer = case when ${computerProvided}::boolean then excluded.computer else memory.agent.computer end,
        projects = case when ${projectsProvided}::boolean then excluded.projects else memory.agent.projects end,
        repos = case when ${projectsProvided}::boolean then excluded.repos else memory.agent.repos end,
        type = case when ${typeProvided}::boolean then excluded.type else memory.agent.type end,
        agent_type = case when ${typeProvided}::boolean then excluded.agent_type else memory.agent.agent_type end,
        harness = case when ${harnessProvided}::boolean then excluded.harness else coalesce(excluded.harness, memory.agent.harness) end,
        device_id = coalesce(excluded.device_id, memory.agent.device_id),
        strict_projects = case when ${strictProvided}::boolean then excluded.strict_projects else memory.agent.strict_projects end,
        last_seen = now()
        where memory.agent.registered_by is not distinct from excluded.registered_by
      returning name, nickname, context, computer, projects, repos, type, agent_type, harness, device_id, strict_projects, (xmax = 0) as created`;
  } catch (e) {
    if ((e as { code?: string }).code === "23505" && nickname) {
      throw new Refused(`Nickname ${nickname} is already taken. Pick another nickname.`);
    }
    throw e;
  }
  if (!agent) throw new Refused(`${name} is already registered by another credential. Pick a name of your own.`);
  await sql`update memory.mcp_client set
      agent = ${name},
      session_context = ${agent.context},
      session_projects = ${agent.projects ?? []}::text[],
      session_computer = ${agent.computer},
      session_strict_projects = ${agent.strict_projects}
    where session_id = ${session} and principal = ${principal}`;
  if (client) {
    await sql`insert into memory.agent_binding (principal, client, agent) values (${principal}, ${client}, ${name})
      on conflict (owner_id, principal, client) do update set agent = excluded.agent, updated_at = now()`;
  }
  return `${agent.created ? "Registered" : "Welcome back,"} ${name}: a ${context} agent on ${surface}. ` +
    "memory remembers this for this token and app, so your next session starts registered. Your notes and messages carry your name.";
}

/** The name a registered agent writes and posts under, else the one its client name gives. */
const nameOf = (c: Pick<Call, "agent" | "client">) => c.agent?.name ?? service.agentName(c.client);

/** The mailboxes an agent reads: its own name, and claude or codex when its client is one of those. */
function mailboxes(c: Pick<Call, "agent" | "client">): string[] {
  const own = service.agentName(c.client);
  return c.agent ? [c.agent.name, ...(own === "claude" || own === "codex" ? [own] : [])] : [own];
}

/** The agent a quest tool acts as (R47). */
const questor = (c: Call): quests.Who => ({
  name: nameOf(c), family: service.agentName(c.client), principal: c.principal, session: c.session,
  context: c.agent?.context ?? null, profile: c.agent ? `${c.agent.name}, a ${c.agent.context} agent on ${c.agent.surface}` : null,
  computer: c.agent?.computer ?? null, projects: c.agent?.projects ?? [], repos: c.agent?.repos ?? c.agent?.projects ?? [],
  agentType: c.agent?.type ?? c.agent?.agent_type ?? (c.agent ? "other" : null),
  harness: c.agent?.harness ?? c.client ?? null, deviceId: c.agent?.device_id ?? null,
  strictProjects: c.agent?.strict_projects ?? false, sessionRepo: c.sessionRepo,
});

function recallFilter(args: Record<string, unknown>): EntryFilter {
  const out: EntryFilter = {};
  for (const key of ["category", "context", "project", "transferability"] as const) {
    if (args[key] !== undefined && args[key] !== null) {
      if (typeof args[key] !== "string") throw new Refused(`${key} must be text.`);
      out[key] = args[key] as string;
    }
  }
  return out;
}

const RUN: Record<string, (c: Call) => Promise<string>> = {
  register_agent: register,
  recall: (c) => service.recall(c.session, s(c.args.query), s(c.args.task), c.client, s(c.args.scope) || null, c.principal, nameOf(c),
    c.args.depth ?? "packet", scopeOf(c), recallFilter(c.args)),
  recall_more: (c) => service.recallMore(c.session, s(c.args.retrieval_id), { device: c.principal, agent: nameOf(c) }, scopeOf(c)),
  get_entry: async (c) => (await service.getEntry(c.session, s(c.args.id), { device: c.principal, agent: nameOf(c) }, scopeOf(c))) ?? `No entry ${s(c.args.id)}.`,
  get_blob: ({ args, agent, sessionRepo, principal }) =>
    service.getBlob(s(args.sha256), Number(args.offset ?? 0), Number(args.limit ?? 20000), scopeOf({ agent, sessionRepo, principal })),
  upload_blob: ({ principal, args }) => service.uploadBlob(principal, args),
  remember: async (c) => {
    const { args } = c;
    const payload = {
      pattern: args.pattern, title: args.title, body: args.body, scope: args.scope || null, evidence: args.evidence,
      kind: args.kind || null, evidence_event: args.evidence_event ?? null,
      evidence_kind: args.evidence_kind ?? "summary", authority: args.authority ?? "draft",
      sensitivity: args.sensitivity ?? "normal", lang: args.lang ?? "en", project: args.project || null,
      valid_from: args.valid_from || null, links: args.links ?? [], supersedes: args.supersedes ?? [], blobs: args.blobs ?? [],
      // Only when sent, so a write without them keeps the id and digest it always had.
      ...(args.artifacts !== undefined ? { artifacts: args.artifacts } : {}), ...(args.long !== undefined ? { long: args.long } : {}),
      ...(args.category !== undefined && args.category !== null ? { category: args.category } : {}),
      ...(args.context !== undefined && args.context !== null ? { context: args.context } : {}),
      ...(args.transferability !== undefined && args.transferability !== null ? { transferability: args.transferability } : {}),
      ...(args.project_slug !== undefined && args.project_slug !== null ? { project_slug: args.project_slug } : {}),
      ...(args.computer !== undefined && args.computer !== null ? { computer: args.computer } : {}),
    };
    const me = nameOf(c);
    const r = await remember(payload, "agent", me, c.principal, {
      agent: me, context: c.agent?.context ?? null, session: c.session,
      profile: c.agent ? `${c.agent.name}, a ${c.agent.context} agent on ${c.agent.surface}` : null,
      computer: c.agent?.computer ?? null, projects: c.agent?.projects ?? [], repo: c.sessionRepo, agentScope: scopeOf(c),
    });
    await limits.countBlobs(c.entitlement, r.blobs);
    return [`Remembered ${r.id}.`,
      ...r.blobs.map((b: { name: string; sha256: string; kind: string; size: number }) => `Blob ${b.name}: ${b.sha256} (${b.kind}, ${b.size} bytes)`),
      "Keyword search finds it now. Vector search finds it after the next embedding sync."].join("\n");
  },
  feedback: ({ session, args }) => service.agentFeedback(session, args),
  post_message: (c) => service.postMessage(sql, nameOf(c), s(c.args.to), s(c.args.body), { context: c.args.context, project: c.args.project }),
  check_messages: async (c) => ((await service.checkMessages(mailboxes(c))) || "No new messages.") + (c.note ? `\n${c.note}` : ""),
  ack_messages: (c) => service.ackMessages(mailboxes(c), c.args.ids),
  dismiss_messages: (c) => service.dismissMessages(mailboxes(c), c.args.ids),
  post_quest: (c) => quests.postQuest(questor(c), c.args),
  list_quests: (c) => quests.listQuests(questor(c), c.args),
  claim_quest: (c) => quests.claimQuest(questor(c), c.args),
  update_quest: (c) => quests.updateQuest(questor(c), c.args),
  complete_quest: (c) => quests.completeQuest(questor(c), c.args),
  abandon_quest: (c) => quests.abandonQuest(questor(c), c.args),
};

type RpcMessage = { jsonrpc?: string; id?: string | number | null; method?: string; params?: any };
const result = (id: RpcMessage["id"], value: unknown) => ({ jsonrpc: "2.0", id, result: value });
const error = (id: RpcMessage["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

/** The client name a session gave at initialize, and the agent it is. A session opened under another credential is no one:
 * its id is not a bearer token. */
async function sessionOf(
  session: string | null,
  principal: string,
): Promise<{ client: string | null; agent: Profile | null; sessionRepo: string | null; ui: boolean }> {
  if (!session) return { client: null, agent: null, sessionRepo: null, ui: false };
  const [row] = await sql`select c.client, c.principal, c.ui,
      c.session_context, c.session_projects, c.session_computer, c.session_strict_projects,
      to_jsonb(a) as aj,
      s.repo as session_repo
    from memory.mcp_client c
    left join memory.agent a on a.owner_id = c.owner_id and a.name = c.agent
    left join memory.mcp_session s on s.owner_id = c.owner_id and s.id = c.session_id
    where c.session_id = ${session}`;
  const aj = (row?.aj ?? null) as Record<string, any> | null;
  const mine = row?.principal === principal && aj?.name;
  return {
    client: row?.client ?? null,
    agent: mine ? {
      name: aj!.name,
      context: row.session_context ?? aj!.context,
      surface: aj!.surface,
      computer: row.session_computer ?? aj!.computer ?? null,
      projects: Array.isArray(row.session_projects) ? row.session_projects : (Array.isArray(aj!.projects) ? aj!.projects : []),
      repos: Array.isArray(aj!.repos) ? aj!.repos : (Array.isArray(aj!.projects) ? aj!.projects : []),
      agent_type: aj!.agent_type ?? aj!.type ?? "other",
      type: aj!.type ?? aj!.agent_type ?? "other",
      harness: aj!.harness ?? row.client ?? null,
      device_id: aj!.device_id !== null && aj!.device_id !== undefined ? Number(aj!.device_id) : null,
      strict_projects: row.session_strict_projects ?? aj!.strict_projects ?? false,
    } : null,
    sessionRepo: (row?.principal === principal ? row?.session_repo : null) ?? null,
    ui: row?.principal === principal && row?.ui === true,
  };
}

/** Whether this request's client renders cards (R67): it said so at initialize, or says so on this request. */
async function rendersCards(msg: RpcMessage, session: string | null, principal: string) {
  if (requestWantsUi(msg.params)) return true;
  if (!session) return false;
  const [row] = await sql`select ui from memory.mcp_client where session_id = ${session} and principal = ${principal}`;
  return row?.ui === true;
}

/** The origin a Storage download link comes from, so a card may show an image artifact. */
const storageOrigin = () => {
  try {
    return new URL(Deno.env.get("SUPABASE_URL") ?? "").origin;
  } catch {
    return null;
  }
};

/** The agent a card's badge names. */
const badgeOf = (k: { client: string | null; agent: Profile | null }): Badge =>
  k.agent ? { name: k.agent.name, context: k.agent.context, surface: k.agent.surface, registered: true }
    : { name: service.agentName(k.client), context: null, surface: null, registered: false };

/** A result's card data as its _meta, or null. A card that can't be built leaves the text result as it is. */
async function card(c: Parameters<typeof cardData>[0]): Promise<{ _meta: Record<string, unknown> } | null> {
  try {
    const data = await cardData(c);
    return data ? { _meta: { [CARD]: data } } : null;
  } catch (e) {
    console.error(e);
    return null;
  }
}

const QUEST_TOOLS = new Set(["post_quest", "list_quests", "claim_quest", "update_quest", "complete_quest", "abandon_quest"]);

async function answer(msg: RpcMessage, session: string | null, minted: { id?: string }, who: Principal) {
  const id = msg.id;
  switch (msg.method) {
    case "initialize": {
      const asked = msg.params?.protocolVersion;
      const sid = crypto.randomUUID();
      minted.id = sid;
      const client = typeof msg.params?.clientInfo?.name === "string" ? msg.params.clientInfo.name : null;
      const principal = who.device ?? who.role;
      // R67: a chat app that renders cards gets them for the whole session. A coding app's initialize is what it always was.
      const ui = wantsUi(msg.params);
      // A credential and app that registered before start as that agent. A client that can't use memory yet (R38)
      // connects, but leaves no session behind.
      if (!who.denied) await sql`insert into memory.mcp_client (session_id, client, principal, agent, ui,
          session_context, session_projects, session_computer, session_strict_projects)
        select ${sid}, ${client}, ${principal}, a.name, ${ui},
          a.context, a.projects, a.computer, a.strict_projects
        from (select 1) one
        left join memory.agent_binding b on b.owner_id = memory.owner_default() and b.principal = ${principal} and b.client = ${client}
        left join memory.agent a on a.owner_id = b.owner_id and a.name = b.agent
        on conflict do nothing`;
      return result(id, {
        protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],
        capabilities: ui ? { tools: { listChanged: false }, resources: {}, extensions: { [UI_EXTENSION]: {} } } : { tools: { listChanged: false } },
        serverInfo: { name: "clyde", title: "Clyde", version: SERVER_VERSION },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return result(id, {});
    case "tools/list":
      return result(id, { tools: (await rendersCards(msg, session, who.device ?? who.role)) ? uiTools(TOOLS) : TOOLS });
    // R67: the cards. Only a client that renders them is told they exist, but reading one is harmless for anyone.
    case "resources/list":
      return result(id, { resources: uiResources() });
    case "resources/templates/list":
      return result(id, { resourceTemplates: [] });
    case "resources/read": {
      const read = readUiResource(msg.params?.uri, storageOrigin());
      return read ? result(id, read) : error(id, -32002, `Resource not found: ${String(msg.params?.uri ?? "")}`);
    }
    case "tools/call": {
      // R38: the 402 or 451 the entitlement check decided, as the HTTP answer, before anything is counted or read.
      if (who.denied) throw new limits.Limited(who.denied);
      const name = msg.params?.name, run = RUN[name];
      if (!run) return error(id, -32602, `Unknown tool ${name}`);
      // The burst limit, then the plan's caps on what this tool spends. Each refusal is the HTTP answer.
      await limits.burst(who.entitlement);
      if (name === "recall") await limits.charge(who.entitlement, "recalls_month");
      if (name === "remember") {
        const full = await limits.entriesFull(who.entitlement);
        if (full) return result(id, { content: [{ type: "text", text: full }], isError: true });
        await limits.assertRemember(who.entitlement, msg.params?.arguments ?? {});
        await limits.charge(who.entitlement, "remembers_month");
      }
      if (name === "get_blob" || name === "upload_blob") await limits.assertArtifacts(who.entitlement);
      if (QUEST_TOOLS.has(name)) await limits.assertQuests(who.entitlement);
      const sid = session ?? `anon-${crypto.randomUUID()}`;
      // Every reply, errors included, ends with a reminder while a recall in this MCP session has no feedback. A call with no
      // session header has no recalls of its own to be reminded of.
      const remind = async (text: string) => {
        if (!session) return text;
        try {
          const own = name === "recall" || name === "recall_more" ? RID.exec(text)?.[1] ?? null : null;
          const line = await service.reminder(session, own);
          return line ? `${text}\n${line}` : text;
        } catch (e) {
          console.error(e);
          return text;
        }
      };
      const principal = who.device ?? who.role;
      let nudge: { type: string; text: string }[] = [];
      let cards = false, badge: Badge | null = null, currentScope: AgentScope = null;
      try {
        const known = await sessionOf(session, principal);
        // Registration is gentle: an unregistered session works, and hears this after every reply until it registers.
        if (!known.agent && name !== "register_agent") nudge = [{ type: "text", text: NUDGE }];
        if (known.agent) {
          await sql`update memory.agent set last_seen = now()
            where owner_id = memory.owner_default() and name = ${known.agent.name} and last_seen < now() - interval '1 minute'`;
        }
        cards = known.ui || requestWantsUi(msg.params);
        badge = badgeOf(known);
        currentScope = scopeOf({ agent: known.agent, sessionRepo: known.sessionRepo, principal });
        const args = msg.params?.arguments ?? {};
        const text = await run({
          session: sid, client: known.client, agent: known.agent, sessionRepo: known.sessionRepo,
          principal, args, note: installNote(who), entitlement: who.entitlement,
        });
        // R67: the text is what it always was. A card-rendering client also gets the card's data, in _meta, which the
        // model never reads. A registration's card shows the agent it just became.
        if (cards && name === "register_agent") {
          const updated = await sessionOf(session, principal);
          badge = badgeOf(updated);
          currentScope = scopeOf({ agent: updated.agent, sessionRepo: updated.sessionRepo, principal });
        }
        const meta = cards ? await card({ tool: name, args, text, error: false, session: sid, viewer: { device: principal, agent: badge.name }, badge, agentScope: currentScope }) : null;
        return result(id, { content: [{ type: "text", text: await remind(text) }, ...nudge], ...meta });
      } catch (e) {
        if (!(e instanceof Refused)) console.error(e);
        const text = e instanceof Refused ? e.message : `Error: ${(e as Error).message}`;
        const meta = cards && badge
          ? await card({ tool: name, args: msg.params?.arguments ?? {}, text, error: true, session: sid, viewer: { device: principal, agent: badge.name }, badge, agentScope: currentScope })
          : null;
        return result(id, { content: [{ type: "text", text: await remind(text) }, ...nudge], isError: true, ...meta });
      }
    }
    default:
      return msg.method?.startsWith("notifications/") ? null : error(id, -32601, `Method not found: ${msg.method}`);
  }
}

export async function handle(req: Request, who: Principal): Promise<Response> {
  if (req.method === "GET") return new Response(null, { status: 405, headers: { allow: "POST, DELETE" } });
  if (req.method === "DELETE") return new Response(null, { status: 200 });
  if (req.method !== "POST") return new Response(null, { status: 405 });
  let body: RpcMessage | RpcMessage[];
  try {
    // An inline base64 artifact is the biggest thing a call carries, so this is the same cap /entries has.
    const raw = new Uint8Array(await req.arrayBuffer());
    if (raw.byteLength > MAX_MCP_BODY) return Response.json({ error: `The body is over ${MAX_MCP_BODY} bytes. Send big files with upload_blob.` }, { status: 413 });
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return Response.json(error(null, -32700, "Parse error"), { status: 400 });
  }
  const session = req.headers.get("mcp-session-id");
  const minted: { id?: string } = {};
  const batch = Array.isArray(body);
  const replies = [];
  for (const msg of batch ? body as RpcMessage[] : [body as RpcMessage]) {
    let reply;
    try {
      reply = await answer(msg, session, minted, who);
    } catch (e) {
      if (e instanceof limits.Limited) return e.response;
      throw e;
    }
    if (reply && msg.id !== undefined) replies.push(reply);
  }
  const headers: Record<string, string> = minted.id ? { "mcp-session-id": minted.id } : {};
  if (!replies.length) return new Response(null, { status: 202, headers });
  return Response.json(batch ? replies : replies[0], { headers });
}
