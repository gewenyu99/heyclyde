# Phase 1 plan

The arms ignore the graph Wen built. This plan makes recall follow links, know where it was called from, and stay accurate over time.

## Goal

Spreading recall beats hybrid on Wen's behaviors without losing his facts. Measured, not argued:

1. **Facts hold.** On the train questions, spreading scores at least hybrid's 90%, with no new leaks.
2. **Behaviors improve.** On behavior probes, spreading delivers the governing entry more often than hybrid by a clear margin. Probes come from Wen's own pushback.
3. **Context works.** The same probe in two contexts gets the right packet in each.
4. **Test read once.** The 7 held-out questions and the held-out probes get read after every knob is frozen, and the number gets reported as is.

## Where we start (2026-10-10, local copy of production)

| | Value |
|---|---|
| Entries | 187 |
| Links | 238, of which 181 are part_of. Only 57 carry meaning |
| Train questions | index 81%, hybrid 90% gold hit |
| Behavior probes | none yet |
| Context per recall | none. Hooks see the cwd, recall does not |

The graph is too thin to spread over. Grooming comes before tuning.

## Workstreams

### 1. Context capture
Both clients put the working directory and machine name into MCP headers. Every recall logs client, machine, repo and branch. Playground and checks get a context picker. Entry scope grows from one value to a set of conditions: repo, project, client, machine, kind of action.

### 2. Rich index
search_text today is title, body, evidence and project title. Version 2 adds pattern, scope, authority, and each link as words: "corrects pref-x", "exception of pref-y". Keyword vectors and embeddings get rebuilt. Each addition is ablated alone on train, and only what earns its place stays.

### 3. Spreading arm, faithful to Wen's design
- Seeds: hybrid's top 50, boosted when their scope matches the context.
- Spread: personalized PageRank over typed links, weighted per link type from link_type_weight.
- Superseded entries ×0.3. A rule travels with the exceptions that match the context.
- Filter: the decider asks "does the task need this?" per item and prunes before delivery. Private text is redacted before any third-party model sees it.
- Trace: the arm returns its activation paths, so Playground and Graph can show how a query bubbles.

### 4. Training
- Ants on train questions and train probes: up to 3 hops, α=1, β=2, 10% exploration. They set the per-link-type weights. PPR serves on them.
- Online: per Wen's rule, a walked link gains 0.2 (cap 5) and one behind a bad reaction drops ×0.9 (floor 0.2). Nothing fades by calendar days. Agent feedback is logged and never moves weights alone. Filter rejections push weight down on the paths that produced them.

### 5. Grooming and coherence
A nightly audit, plus a console view:
- **Contradictions.** Two current entries that disagree with no supersedes or exception link between them.
- **Duplicates.** Near-identical embeddings with different ids.
- **Orphans.** Entries with only part_of links.
- **Stale drafts.** Drafts never confirmed or rejected.
- **Bad chains.** Supersede loops, and superseded entries still linked as current rules.
- **Link proposals.** Typed links two agents propose independently. Agreement adds them. Disagreement goes to Wen.

### 6. Agents collaborate on the board
Codex and Claude label the same items independently: probes, link proposals, contradictions. They trade work and results on the message board. Agreement is the confidence signal.

## When to ask Wen

| Ask now | Queue for Wen | Never ask |
|---|---|---|
| Direction and design. Money. Publishing. Anything irreversible or touching other people. Experiment calls he owns, like which arms go live | Memory facts the agents disagree on. Single weak evidence. Two approved entries in conflict. An inferred scope or exception. Anything the audit would demote | Execution on his machine. Reversible steps. Anything an agent can verify itself |

The queue is a Clarify inbox in the console, batched, never an interruption mid-task. His answer writes the entry or the link, with his words as evidence.

## Order

1. Context capture and the behavior probe set, dual-labeled by Claude and Codex.
2. Link grooming to densify the graph, dual-labeled. Clarify inbox.
3. Rich index, ablated on train.
4. Spreading arm with trace, then ant training on train.
5. Playground and Graph show activation. Checks view.
6. Freeze, read test once, report.
