# Submitting Clyde to the Claude directory and Google Connected Apps

Copy-paste answers for both forms, so Wen or the lead agent can fill them in minutes. The copy comes from [clyde.json](clyde.json), which `memory/e2e/listing_check.py "listing copy"` checks against both stores' limits. The form fields come from each store's own docs, read on 2026-11-15:

- Claude: [submission](https://claude.com/docs/connectors/building/submission) and [review criteria](https://claude.com/docs/connectors/building/review-criteria).
- Google: [Connected Apps](https://developers.google.com/connected-apps), [GPC steps](https://developers.google.com/connected-apps/gpc/perform-the-steps) and [MCP OAuth](https://developers.google.com/connected-apps/mcp/oauth).

Never paste a password or token into a portal field or this file. Test credentials go through the channel each reviewer asks for: Anthropic's reviewer emails for access, and Google's representative gets them directly.

## Before either form

| # | Step | Who | State on 2026-11-15 |
|---|---|---|---|
| 1 | support@heyclyde.me must receive mail. Run the four commands below from `memory/proxy`, click the verify link Cloudflare emails, then send a test mail and comment on [#60](https://github.com/gewenyu99/like-vincent/issues/60) when it arrives. | Wen | Not done. The agent's `email routing enable` was blocked by its permission settings, and the destination has to be verified from the inbox anyway. heyclyde.me has no MX records yet, so enabling adds Cloudflare's without clashing with anything. |
| 2 | `https://heyclyde.me/mcp` answers MCP, and its `/.well-known/oauth-protected-resource` names `https://heyclyde.me/mcp`. | session clyde-store-server, R53 ([#58](https://github.com/gewenyu99/like-vincent/issues/58)) | Live since R53: heyclyde.me/mcp answers an unauthenticated call with 401 and the OAuth challenge. `https://memory.heyclyde.me/mcp` stays as an alias. |
| 3 | Every tool has a `title` and `readOnlyHint` or `destructiveHint`, and no tool text names Wen or tells the model when to call it. | R53 | In progress. Claude's form refuses tools without annotations. |
| 4 | Public sign-up is open, so a reviewer can connect. | R54 ([#59](https://github.com/gewenyu99/like-vincent/issues/59)) | Waits on tenancy, R48 to R50. |
| 5 | The reviewer account `review@heyclyde.me`: password sign-in, no MFA, 40 sample notes, reseeded nightly. | R55, after tenancy | Waits on R48 to R50. |
| 6 | Pages and brand files are live: [docs](https://heyclyde.me/docs), [support](https://heyclyde.me/support), [privacy](https://heyclyde.me/privacy), [terms](https://heyclyde.me/terms), [Grok guide](https://heyclyde.me/docs/grok), [512 PNG](https://heyclyde.me/brand/clyde-512.png), [48 PNG](https://heyclyde.me/brand/clyde-48.png), [SVG](https://heyclyde.me/brand/clyde.svg). | this change | Done. `python3 memory/e2e/listing_check.py` checks them. |

Step 1 commands. Put your own inbox where it says so:

```bash
npx wrangler@4 email routing enable heyclyde.me
npx wrangler@4 email routing addresses create <your inbox>
npx wrangler@4 email routing rules create heyclyde.me --name support --match-type literal --match-field to --match-value support@heyclyde.me --action-type forward --action-value <your inbox>
npx wrangler@4 email routing rules list heyclyde.me
```

Or in the dashboard: heyclyde.me → Email → Email Routing → Enable, add the destination, then a custom address `support` forwarding to it.

## Claude directory

At [claude.ai/directory/manage](https://claude.ai/directory/manage) → **Submit new** → **MCP connector**, on Wen's paid Claude account. Submit after steps 1 to 5 above.

### Connection

- **Server URL:** `https://heyclyde.me/mcp`
- **Users connect to different URLs:** No. One URL for everyone.

### Tools

Synced from the server. Check each of the 18 tools shows a title and an annotation. If any is flagged, R53 isn't deployed yet: stop and finish it. Read-only: recall, recall_more, get_entry, get_blob, check_messages, list_quests. The rest write.

### Listing

| Field | Answer |
|---|---|
| Server name (≤ 100) | Clyde |
| One-liner (≤ 200) | `claude.one_liner` in clyde.json: "One shared memory for all your AI agents: save a decision or note in Claude, and recall it later from Claude, ChatGPT, Codex, Gemini or Grok." |
| Description (≤ 2,000) | `claude.description` in clyde.json, pasted whole (923 characters). |
| Categories (1 to 5) | Productivity, Developer tools. The docs don't list the options: pick the closest two. |
| Documentation URL | https://heyclyde.me/docs |
| Privacy policy URL | https://heyclyde.me/privacy |
| Support contact | support@heyclyde.me (page: https://heyclyde.me/support) |
| Icon | Upload `memory/proxy/public/brand/clyde-512.png` (512 x 512 PNG, 37 KB), also at https://heyclyde.me/brand/clyde-512.png |
| URL slug (permanent) | `clyde` |
| Allowed link URIs | Leave empty. Clyde doesn't use ui/open-link. |
| Screenshots | None. They're for MCP Apps only. |

### Use cases

- **Primary use cases:** the three in `claude.use_cases`: remember decisions across apps; pick up where another agent left off; hand work to another agent through the quest board.
- **What users need before connecting:** a Clyde account, made on first connect by clicking the sign-in link Clyde emails. No plan or payment needed to start.
- **Reads, writes or both:** Both. It reads notes, files and quests, and writes notes, files, messages and quests.

### Company

| Field | Answer |
|---|---|
| Company name | Pennywhistle software |
| Website | https://heyclyde.me |
| Primary contact | Wen, at support@heyclyde.me |

### Authentication

- **Authentication requirement:** Sign-in required.
- **Authentication methods:** OAuth 2.1, authorization code with PKCE (S256), and dynamic client registration. The authorization server is Supabase Auth at `https://wlhlncmgjqyidosunugv.supabase.co/auth/v1`, named by the server's `/.well-known/oauth-protected-resource`. The user signs in with a one-time email link, no password.
- **Anthropic-held client ID and secret:** Leave empty. Clients register themselves.
- **Callback:** `https://claude.ai/api/mcp/auth_callback` must be in Supabase's redirect allowlist (R54 adds every store's callback).

### Data handling

- **Whose API:** Our own. Clyde's server, run by Pennywhistle software on Supabase in Canada.
- **Personal health data:** No.
- **Sponsored content:** No.
- **What's collected:** only what a tool call sends: the note, quest or message text, plus which app and agent sent it. No conversation logs. The privacy page lists every processor.

### Test & launch

1. Connect the custom connector at `https://heyclyde.me/mcp` in claude.ai and run every tool once, or run them all with the MCP Inspector (`npx @modelcontextprotocol/inspector`). Keep the transcript link for [#61](https://github.com/gewenyu99/like-vincent/issues/61).
2. Tick that every tool was tested.
3. Reviewer access: when Anthropic's reviewer emails, reply from support@heyclyde.me with `review@heyclyde.me` and its password. Never put the password in the portal.

### Compliance

Seven acknowledgments: directory guidelines, first-party API usage, financial transactions, AI media generation, prompt injection, conversation data collection and public documentation. **Wen reads and ticks these himself.** The review criteria to know before ticking: tools may not query Claude's own memory or chat history (Clyde stores only what tools are sent, like the listed Mem0), and server text may not tell Claude to call tools the user didn't ask for (R53 removes that).

## Google Connected Apps

### Preview application

Apply at [connected.google.com/console/help/?apply](https://connected.google.com/console/help/?apply), signed in as the Google account that will own the app.

| Field | Answer |
|---|---|
| Company | Pennywhistle software, Ontario, Canada |
| Contact | support@heyclyde.me |
| Website | https://heyclyde.me |
| App name | Clyde |
| What it does | `google.description`: "Clyde gives your AI agents one shared memory, so notes, decisions and quests saved in one app can be recalled from Gemini and every other app." |
| Connection | A remote MCP server, streamable HTTP, at https://heyclyde.me/mcp |
| Users | People who use Gemini alongside Claude, ChatGPT, Codex or Grok and want one memory across them. Free for the first 1,000 people. |

Accept Google's Connected Apps terms as the account admin: **Wen does this himself.**

### Connected Console

Once the preview is granted, at [connected.google.com/console](https://connected.google.com/console).

**Create app**

| Field | Answer |
|---|---|
| App name | Clyde |
| Category (permanent) | Productivity. The docs don't list the options: if Productivity is missing, pick the one closest to notes or tools for work. It can't be changed. |
| Connection type (permanent) | MCP server |

**App details**

| Field | Answer |
|---|---|
| Icon (512 x 512, ≤ 1 MB, PNG or JPG) | `memory/proxy/public/brand/clyde-512.png` (37 KB) |
| Description (1 sentence, < 30 words) | Clyde gives your AI agents one shared memory, so notes, decisions and quests saved in one app can be recalled from Gemini and every other app. |
| Capabilities (≥ 3, no leading numbers, one per entry) | Save a note, decision or preference to your shared memory / Recall the notes that matter for a question, with who wrote each and when / Open a saved note with its source, links and attached files / Post, list and claim tasks on a quest board shared by your agents / Leave messages for your other AI agents |
| Example prompts (≥ 3, ≥ 2 start with @Clyde, ≥ 1 names Clyde naturally, no numbers or quotation marks) | @Clyde what did I decide about the deploy script? / @Clyde remember that the staging database moved to Toronto / @Clyde is anything on the quest board for me? / Check Clyde for my notes on the pricing page before you draft the email |
| Terms of Service URL | https://heyclyde.me/terms |
| Privacy policy URL | https://heyclyde.me/privacy |
| Website URL | https://heyclyde.me |

**MCP endpoint and domain verification**

1. Endpoint: `https://heyclyde.me/mcp`.
2. Download `google-connected-apps.json` from the console. It holds `verification_tokens`, which aren't secret but stay out of chat.
3. Save it as `memory/proxy/public/.well-known/google-connected-apps`, deploy (`cd memory/proxy && npx wrangler@4 deploy`), and check `curl -si https://heyclyde.me/.well-known/google-connected-apps` answers `200` with no redirect. If the static assets skip the dot folder, serve it from `site.js` instead.
4. Click verify in the console. IP allowlisting: none.

**Access credentials**

| Field | Answer |
|---|---|
| Does your server require authorization? | Yes |
| Type | User-delegated (Authorization Code) |
| Registration | Client ID metadata or Dynamic client registration (recommended). Supabase Auth publishes `registration_endpoint`. |
| Sign-in | Authenticate via Pop up (recommended) |
| Redirect URIs to allowlist | `https://oauth-redirect.googleusercontent.com/r/*`, `https://oauth-redirect-sandbox.googleusercontent.com/r/*`, `https://oauth-redirect-test.googleusercontent.com/r/*`, and the same three with `/a/*`, plus any app-specific URI the console shows. Branch `claude/clyde-listings` (R58, [#63](https://github.com/gewenyu99/like-vincent/issues/63)) adds them to Supabase. |
| Consent screen logo (square SVG, ≥ 500 x 500) | https://heyclyde.me/brand/clyde.svg (512 x 512, a circle on a square canvas) |
| Test account | `review@heyclyde.me`, password sign-in, 2FA off, seeded with sample notes. Give the password to Google's representative directly, once step 5 is done. |

**Sync and availability**

- Sync tools. For each tool: no extra context (no locale or location). User confirmation is set automatically where `destructiveHint` is true.
- Countries: Canada and the United States to start. Never the EU, EEA, UK or Switzerland, where Clyde isn't offered. Language: English.

**Testing and submission**

1. Add testers: Wen's @gmail.com account.
2. Run the five `positive_tests` and three `negative_tests` from clyde.json in the Gemini app, and save the transcript for [#63](https://github.com/gewenyu99/like-vincent/issues/63).
3. **Send for review**, then **Publish** once approved.

Google's policy acknowledgments, if the console asks for them, are **Wen's to accept**.
