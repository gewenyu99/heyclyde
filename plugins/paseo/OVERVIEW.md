# Clyde

Type `/clyde` in a Paseo project chat to open Clyde beside it. The right panel has three tabs.

- **Quests** lists work available to the current chat. Select a quest to read its brief and completion criteria, then choose **Start task from quest** to claim it and launch a background run.
- **New task** starts work in an isolated Git worktree. Choose **Quick task** for a bounded change or **Plan a feature** to review the design first. Leave the worker on **Auto** or select one yourself.
- **Runs** shows progress, checks, and the audited revision. Open a run to inspect attempts, steer the worker, or stop it.

Clyde shows recalled notes and saved decisions inline in the originating chat. Recalled notes open together. Choose **That helped** or **That didn’t** once for the whole recall. When a run needs a decision, approve the plan or send a reply on its chat card.

The sidebar **Clyde** button opens the board across projects. In **Agents**, review the suggested role and responsibility tags before enabling automatic pickup. Urgent and high priority quests start on eligible idle agents. Normal and low priority work produces an offer.

The [Clyde design system](../../design/README.md) supplies the logo, typography and light/dark paper and ink colors. Run `node plugins/paseo/sync-brand.mjs` after changing the shared assets.

## Routing

Opus or Astra plans. Sol and Sonnet handle routine work based on available provider quota. Opus handles complex implementation. Fable reviews specs and verifies findings in read-only sessions. Carbon audits code changes. Clyde prefers Orchestrator (Carbon) when the host advertises it and can fall back to Carbon High. Enter `/route worker astra` in a run’s steering field to change the worker for its next attempt.

## Connections

The plugin requires Paseo 0.16.2 or newer. Local runs use the companion Clyde daemon. Registration, shared memory and quests use the Clyde service configured in `~/.config/memory`. The quest board requires a Clyde plan with quests. Automatic pickup also requires the hosted dispatch migration. Native before-reply checks appear when the plugin observes a hook receipt. Other providers use best-effort turn instructions.
