# Clyde

Open **Clyde** in the sidebar for the board across projects. In a workspace, choose **+ → Clyde**, use the Command Center, or type `/clyde` to open a Clyde tab beside your chat. The compact Explorer panel also offers these controls.

- **Quests** opens your shared board across projects. Active includes open and claimed work. Search by number, title, project or tag. Select an open quest to read its brief and completion criteria. Choose **Start with new orchestrator** to create a dedicated chat and start the run in the selected project. You can also choose an eligible existing chat.
- **New task** starts work in an isolated Git worktree. Choose **Quick task** for a bounded change or **Plan a feature** to review the design first. Leave the worker on **Auto** or select one yourself.
- **Runs** shows progress, checks, and the audited revision. Open a run to inspect attempts, steer the worker, or stop it. Use the trash icon to remove a task from the board. Removing active work stops it and retains its history and Git worktree.

Clyde shows recalled notes and saved decisions inline in the originating chat. Recalled notes open in a scrollable list. Notes marked used by the agent appear first with a [USED] stamp. Automatic recalls with no matches stay silent. Choose **That helped** or **That didn’t** once for the whole recall. When a run needs a decision, approve the plan or send a reply on its chat card.

The sidebar **Clyde → Quests** opens the same shared board without selecting a chat. Writable workers launched from a chat run as Paseo children, with their isolated work directory checked before delivery. Antigravity uses its provider-specific full-access mode only when inherited from the same provider or authorized for the run. In **Agents**, review the suggested role and responsibility tags before enabling automatic pickup. Urgent and high priority quests start on eligible idle agents. Normal and low priority work produces an offer.

The [Clyde design system](../../design/README.md) supplies the logo, typography and light/dark paper and ink colors. Run `node plugins/paseo/sync-brand.mjs` after changing the shared assets.

## Returning to work

Selecting a run opens its stages, latest finding, checks, and supervisor conversation. Switching to another workspace tab and back restores the selected task. **Back to board** returns to the queue. Open a stopped or older run from **Task history**.

Ask **Chat with Clyde** about an attempt or saved plan while the worker continues. Replies use Paseo’s Markdown renderer. Pending decisions appear on the task. If a worker requests permission, **Review permission in Paseo** opens that worker. Select a stage to inspect its attempts and transcript.

## Routing

Opus or Astra plans. Sol and Sonnet handle routine work based on available provider quota. Opus handles complex implementation. Fable reviews specs and verifies findings in read-only sessions. Carbon audits code changes. Clyde prefers Orchestrator (Carbon) when the host advertises it and can fall back to Carbon High. Enter `/route worker astra` in a run’s steering field to change the worker for its next attempt.

## Connections

The plugin requires Paseo 0.16.2 or newer. Local runs use the companion Clyde daemon. Registration, shared memory and quests use the Clyde service configured in `~/.config/memory`. The quest board requires a Clyde plan with quests. Automatic pickup also requires the hosted dispatch migration. Native before-reply checks appear when the plugin observes a hook receipt. Other providers use best-effort turn instructions.
