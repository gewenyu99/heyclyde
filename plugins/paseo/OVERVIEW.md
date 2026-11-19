# Clyde

Type `/clyde` in a Paseo project chat to open Clyde beside it. The right panel has three tabs.

- **Quests** opens your shared board across projects. Active includes open and claimed work. Search by number, title, project or tag. A chat’s confirmed responsibilities and scope determine which quests it can claim. Select a quest to read its brief and completion criteria, then choose **Start task from quest** to claim it and launch a background run.
- **New task** starts work in an isolated Git worktree. Choose **Quick task** for a bounded change or **Plan a feature** to review the design first. Leave the worker on **Auto** or select one yourself.
- **Runs** shows progress, checks, and the audited revision. Open a run to inspect attempts, steer the worker, or stop it. Use the trash icon to remove a task from the board. Removing active work stops it and retains its history and Git worktree.

Clyde shows recalled notes and saved decisions inline in the originating chat. Recalled notes open in a scrollable list. Notes marked used by the agent appear first with a [USED] stamp. Automatic recalls with no matches stay silent. Choose **That helped** or **That didn’t** once for the whole recall. When a run needs a decision, approve the plan or send a reply on its chat card.

The sidebar **Clyde → Quests** opens the same shared board without selecting a chat. Writable workers launched from a chat run as Paseo children, with their isolated work directory checked before delivery. Antigravity uses its provider-specific full-access mode only when inherited from the same provider or authorized for the run. In **Agents**, review the suggested role and responsibility tags before enabling automatic pickup. Urgent and high priority quests start on eligible idle agents. Normal and low priority work produces an offer.

The [Clyde design system](../../design/README.md) supplies the logo, typography and light/dark paper and ink colors. Run `node plugins/paseo/sync-brand.mjs` after changing the shared assets.

## Returning to work

The board shows how many tasks finished today and how many await a reply. Open decisions and today’s failures appear first. On the full-screen **Board**, starting or opening a run shows the task and **Chat with Clyde** together. Ask about a failed attempt, saved plan, or check while the worker continues. Reopen the run to resume the same conversation. The task shows what the worker or reviewer is doing, the latest finding, and why a retry was requested. Pending decisions appear inline. Expand **Run details** for checks, attempt history, worker instructions, and stop controls. Open a run to see its completion criteria, audited revision when available, and check results from the latest attempt at each stage. Failed checks show their command and exit code; expand the evidence for the output. Model routing and transcripts are available on demand.

## Routing

Opus or Astra plans. Sol and Sonnet handle routine work based on available provider quota. Opus handles complex implementation. Fable reviews specs and verifies findings in read-only sessions. Carbon audits code changes. Clyde prefers Orchestrator (Carbon) when the host advertises it and can fall back to Carbon High. Enter `/route worker astra` in a run’s steering field to change the worker for its next attempt.

## Connections

The plugin requires Paseo 0.16.2 or newer. Local runs use the companion Clyde daemon. Registration, shared memory and quests use the Clyde service configured in `~/.config/memory`. The quest board requires a Clyde plan with quests. Automatic pickup also requires the hosted dispatch migration. Native before-reply checks appear when the plugin observes a hook receipt. Other providers use best-effort turn instructions.
