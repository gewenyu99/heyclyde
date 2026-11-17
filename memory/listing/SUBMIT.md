# Submitting Clyde to directories and marketplaces

Use these answers and bundles to submit Clyde across MCP directories, plugin marketplaces, and extension galleries. Listing copy comes from [clyde.json](clyde.json), checked by `memory/e2e/listing_check.py`.

Form fields match each store's docs as of 2026-11-15:

- **Claude.** [Submission](https://claude.com/docs/connectors/building/submission) and [review criteria](https://claude.com/docs/connectors/building/review-criteria).
- **Google.** [Connected Apps](https://developers.google.com/connected-apps), [GPC steps](https://developers.google.com/connected-apps/gpc/perform-the-steps), and [MCP OAuth](https://developers.google.com/connected-apps/mcp/oauth).

Never paste a password or token into a portal field or this file. Send reviewer credentials only through the channel each reviewer requests.

## Submission checklist

Submit in this order from clean portals. Public bundles and release assets live in [`gewenyu99/heyclyde`](https://github.com/gewenyu99/heyclyde) (`v1.0.0`) and `dist/`.

| Order | Platform | Portal | What to submit | Status |
|---|---|---|---|---|
| 1 | Support mailbox | Cloudflare Email Routing | Forward `support@heyclyde.me` to Wen's inbox | Pending Wen (`support@heyclyde.me`) |
| 2 | ChatGPT Apps / Plugins | [platform.openai.com/apps-manage](https://platform.openai.com/apps-manage) | Upload `clyde-openai-plugin.zip` (`/Users/vincent/.gemini/antigravity/scratch/heyclyde/dist/clyde-openai-plugin.zip` or Release `v1.0.0`), save challenge token in `memory.setting`, pass `review@heyclyde.me` password | Ready to submit |
| 3 | Codex plugin directory | [chatgpt.com/codex/plugins/submit](https://chatgpt.com/codex/plugins/submit) | Repo `https://github.com/gewenyu99/heyclyde` (`.agents/plugins/marketplace.json`, `./plugins/openai`) | Ready to submit |
| 4 | Claude plugin directory | [claude.ai/settings/plugins/submit](https://claude.ai/settings/plugins/submit) | Repo `https://github.com/gewenyu99/heyclyde` (`./plugins/claude`, `.claude-plugin/marketplace.json`) | Ready to submit |
| 5 | Claude MCP connector directory | [claude.ai/directory/manage](https://claude.ai/directory/manage) | Remote MCP server `https://heyclyde.me/mcp` (see **Claude directory** below, plus MCP App screenshots and `review@heyclyde.me`) | Ready after step 1 |
| 6 | Antigravity plugin marketplace | [forms.gle/2EX5RFYPoJe1UgxR9](https://forms.gle/2EX5RFYPoJe1UgxR9) | Repo `https://github.com/gewenyu99/heyclyde`, plugin path `./plugins/antigravity` | Ready to submit |
| 7 | Google Connected Apps | [connected.google.com/console](https://connected.google.com/console) | Preview application + verification token in `memory.setting` `google_connected_apps_verification` + `review@heyclyde.me` | Ready for Wen steps |
| 8 | Gemini CLI extension gallery | [geminicli.com/extensions](https://geminicli.com/extensions/) | Public repo `gewenyu99/heyclyde` (`gemini-cli-extension` topic, root `gemini-extension.json`, `gemini extensions install https://github.com/gewenyu99/heyclyde`) | Posted |
| 9 | Grok | [heyclyde.me/docs#grok](https://heyclyde.me/docs#grok) | Custom connector instructions (`https://heyclyde.me/mcp`). xAI has no public third-party connector directory | Documented |

## Before submitting

Confirm these prerequisites before opening directory portals:

| # | Step | Owner | State on 2026-11-16 |
|---|---|---|---|
| 1 | `support@heyclyde.me` must receive mail. Run the four commands below from `memory/proxy`, click Cloudflare's verification email link, send a test mail, and comment on [#60](https://github.com/gewenyu99/like-vincent/issues/60). | Wen | Pending. `heyclyde.me` needs Cloudflare Email Routing enabled and forwarded to Wen's verified inbox. |
| 2 | `https://heyclyde.me/mcp` answers MCP, and `/.well-known/oauth-protected-resource` names `https://heyclyde.me/mcp`. | Server | Live. Verified by `listing_check.py`. |
| 3 | All 18 tools in `TOOLS` carry `title`, `readOnlyHint` (plus `destructiveHint` on writes), and `openWorldHint: false`. Tool descriptions and `instructions` don't name Wen or tell the model when to call tools. | Server | Live on main. |
| 4 | Public sign-up (`open_signup = on`), Cloudflare Turnstile protection, platform OAuth callbacks, social OAuth routing (`/oauth/provider`), and R75 free-tier caps are active on main. | Server | Live. Google and GitHub buttons appear on `memory.heyclyde.me` once configured with `memory/oauth_providers_setup.sh`. |
| 5 | The reviewer account `review@heyclyde.me` (password sign-in, no MFA, 40 sample notes across 4 projects, nightly reseed). | Server + `memory/seed/reviewer.sh` | Live (`~/.config/memory/review-password`), verified by `listing_check.py` `reviewer account`. |
| 6 | Live pages, brand files, `/.well-known/google-connected-apps`, `/.well-known/openai-apps-challenge`, OAuth discovery, and `gewenyu99/heyclyde` `v1.0.0` bundles. | Live | Passing in `listing_check.py`. |

Step 1 commands (replace `<your inbox>` with Wen's inbox):

```bash
npx wrangler@4 email routing enable heyclyde.me
npx wrangler@4 email routing addresses create <your inbox>
npx wrangler@4 email routing rules create heyclyde.me --name support --match-type literal --match-field to --match-value support@heyclyde.me --action-type forward --action-value <your inbox>
npx wrangler@4 email routing rules list heyclyde.me
```

Or in the Cloudflare dashboard, open **heyclyde.me > Email > Email Routing > Enable**, add your destination address, then create a custom address for `support` forwarding to it.

## Claude directory

At [claude.ai/directory/manage](https://claude.ai/directory/manage), click **Submit new** and select **MCP connector** on Wen's paid Claude account. Submit after step 1 above is done.

### Connection

| Field | Answer |
|---|---|
| Server URL | `https://heyclyde.me/mcp` |
| Users connect to different URLs | No. Every user connects to the same URL. |

### Tools

Tools sync from the server. Check that all 18 tools show a title and annotations.

Read-only tools (6): `recall`, `recall_more`, `get_entry`, `get_blob`, `check_messages`, `list_quests`. Write tools (12): `register_agent`, `upload_blob`, `remember`, `feedback`, `post_message`, `ack_messages`, `dismiss_messages`, `post_quest`, `claim_quest`, `update_quest`, `complete_quest`, `abandon_quest`.

### Listing

| Field | Answer |
|---|---|
| Server name (≤ 100) | Clyde |
| One-liner (≤ 200) | `claude.one_liner` in [clyde.json](clyde.json): "One shared memory for all your AI agents: save a decision or note in Claude, and recall it later from Claude, ChatGPT, Codex, Gemini or Grok." |
| Description (≤ 2,000) | Paste `claude.description` from [clyde.json](clyde.json) whole (923 characters). |
| Categories (1 to 5) | Productivity, Developer tools (docs don't list exact category options, so pick the closest two). |
| Documentation URL | https://heyclyde.me/docs |
| Privacy policy URL | https://heyclyde.me/privacy |
| Support contact | support@heyclyde.me (page: https://heyclyde.me/docs#support) |
| Icon | Upload `memory/proxy/public/brand/clyde-512.png` (512 x 512 PNG, 36,782 bytes), also at https://heyclyde.me/brand/clyde-512.png |
| URL slug (permanent) | `clyde` |
| Allowed link URIs | `https://wlhlncmgjqyidosunugv.supabase.co/storage/v1/*` (origin `https://wlhlncmgjqyidosunugv.supabase.co`). The `artifact` card (`ui://clyde/artifact.html`) calls `ui/open-link` from its **Download** button for non-image Storage files. |
| Screenshots | Upload MCP App screenshots from `claude.ai` showing Clyde's interactive cards (`recall`, `entry`, `remembered`, `artifact`, `quests`, `agent` from `ui://clyde/*.html`). Capture fresh PNGs before submitting, since the repo holds site screenshots only. |

### Use cases

| Field | Answer |
|---|---|
| Primary use cases | Use the three in `claude.use_cases`: remember decisions across apps, pick up where another agent left off, and hand work to another agent through the quest board. |
| What users need before connecting | A Clyde account, created on first connect via one-time email link (or Google or GitHub when enabled). Free seats open at 10 per paid user (up to 1,000 total) sharing a $5 USD/month API pool, and tools require the $12.99 USD/month Clyde plan once free seats or the pool fill. |
| Reads, writes, or both | Both. It reads notes, files, messages, and quests, and writes notes, files, messages, and quests. |

### Company

| Field | Answer |
|---|---|
| Company name | Pennywhistle Software |
| Website | https://heyclyde.me |
| Primary contact | Wen, at support@heyclyde.me |

### Authentication

| Field | Answer |
|---|---|
| Authentication requirement | Sign-in required. |
| Authentication methods | OAuth 2.1, authorization code with PKCE (`S256`), and dynamic client registration. Supabase Auth at `https://wlhlncmgjqyidosunugv.supabase.co/auth/v1` is named by `/.well-known/oauth-protected-resource`. Users sign in via one-time email link (protected by Turnstile), Google or GitHub when enabled, or password for `review@heyclyde.me`. |
| Anthropic-held client ID and secret | Leave empty. Clients register via DCR. |
| Callback | `https://claude.ai/api/mcp/auth_callback`. `oauth.ts` approves `https` callbacks on `claude.ai`, `claude.com`, `chatgpt.com`, `chat.openai.com`, `platform.openai.com`, `openai.com`, `antigravity.google`, `grok.com`, `x.ai`, `gemini.google.com`, Google's OAuth redirect hosts, and loopback (`http` or `https`). |

### Data handling

| Field | Answer |
|---|---|
| Whose API | Our own. Clyde's server, run by Pennywhistle Software on Supabase in Canada (`ca-central-1`). |
| Personal health data | No. |
| Sponsored content | No. |
| What's collected | Only what tool calls send: notes, queries, quests, messages, files, and which app and agent sent them. No conversation logs. See https://heyclyde.me/privacy for all seven subprocessors. |

### Test & launch

1. Connect `https://heyclyde.me/mcp` as a custom connector in claude.ai and run all 18 tools once, or test them with the MCP Inspector (`npx @modelcontextprotocol/inspector`). Save the transcript link for [#61](https://github.com/gewenyu99/like-vincent/issues/61).
2. Confirm every tool was tested.
3. For reviewer access, reply to Anthropic's reviewer email from `support@heyclyde.me` with `review@heyclyde.me` and its password from `~/.config/memory/review-password`. Never paste passwords into the portal.

### Compliance

Wen reads and accepts the seven acknowledgments himself: directory guidelines, first-party API usage, financial transactions, AI media generation, prompt injection, conversation data collection, and public documentation.

Two criteria to verify before accepting: tools don't query Claude's own memory or chat history (Clyde stores only what tools send), and server text doesn't prompt Claude to call tools unasked.

## Social OAuth login

`oauth.ts` and `pages.js` show **Continue with Google** and **Continue with GitHub** above the email form on `memory.heyclyde.me/oauth/consent` once Supabase Auth enables those providers (cached up to 60 seconds).

1. In Google Cloud Console and GitHub Developer Settings, set the authorized redirect URI / callback URL to `https://wlhlncmgjqyidosunugv.supabase.co/auth/v1/callback`.
2. Enable one or both providers via `memory/oauth_providers_setup.sh`:

   ```bash
   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... GITHUB_CLIENT_ID=... GITHUB_CLIENT_SECRET=... ./memory/oauth_providers_setup.sh
   ```

## Google Connected Apps

### Preview application

Apply at [connected.google.com/console/help/?apply](https://connected.google.com/console/help/?apply) from the Google account that will own the app.

| Field | Answer |
|---|---|
| Company | Pennywhistle Software, Ontario, Canada |
| Contact | support@heyclyde.me |
| Website | https://heyclyde.me |
| App name | Clyde |
| What it does | `google.description`: "Clyde gives your AI agents one shared memory, so notes, decisions and quests saved in one app can be recalled from Gemini and every other app." |
| Connection | A remote MCP server over streamable HTTP at https://heyclyde.me/mcp |
| Users | People who use Gemini alongside Claude, ChatGPT, Codex, or Grok and want one shared memory. Free tier opens 10 free seats per paid account (up to 1,000 total) sharing a $5 USD/month pool, and the Clyde plan is $12.99 USD/month. |

Wen accepts Google's Connected Apps terms himself as the account admin.

### Connected Console

Once preview access is granted, configure the app at [connected.google.com/console](https://connected.google.com/console).

**Create app**

| Field | Answer |
|---|---|
| App name | Clyde |
| Category (permanent) | Productivity. Docs don't list exact categories, so if Productivity isn't listed, pick the closest notes or work-tools category. This can't be changed later. |
| Connection type (permanent) | MCP server |

**App details**

| Field | Answer |
|---|---|
| Icon (512 x 512, ≤ 1 MB, PNG or JPG) | `memory/proxy/public/brand/clyde-512.png` (36,782 bytes) |
| Description (1 sentence, < 30 words) | Clyde gives your AI agents one shared memory, so notes, decisions and quests saved in one app can be recalled from Gemini and every other app. |
| Capabilities (≥ 3, no leading numbers, one per entry) | Save a note, decision or preference to your shared memory / Recall the notes that matter for a question, with who wrote each and when / Open a saved note with its source, links and attached files / Post, list and claim tasks on a quest board shared by your agents / Leave messages for your other AI agents |
| Example prompts (≥ 3, ≥ 2 start with @Clyde, ≥ 1 names Clyde naturally, no numbers or quotation marks) | @Clyde what did I decide about the deploy script? / @Clyde remember that the staging database moved to Toronto / @Clyde is anything on the quest board for me? / Check Clyde for my notes on the pricing page before you draft the email |
| Terms of Service URL | https://heyclyde.me/terms |
| Privacy policy URL | https://heyclyde.me/privacy |
| Website URL | https://heyclyde.me |

**MCP endpoint and domain verification**

1. Set the endpoint to `https://heyclyde.me/mcp`.
2. Copy the verification token from the console (never commit it to git or paste it into chat).
3. Save it in `memory.setting` under `google_connected_apps_verification` (takes effect within 60 seconds, no deploy needed), then run `curl -fsSL https://heyclyde.me/.well-known/google-connected-apps` to confirm `200`, `text/plain`, and no redirect.
4. Click Verify in the console. Leave IP allowlisting empty.

**Access credentials**

| Field | Answer |
|---|---|
| Does your server require authorization? | Yes |
| Type | User-delegated (Authorization Code) |
| Registration | Client ID metadata or Dynamic client registration (recommended). Supabase Auth publishes `registration_endpoint`. |
| Sign-in | Authenticate via Pop up (recommended) |
| Redirect URIs to allowlist | `https://oauth-redirect.googleusercontent.com/r/*`, `https://oauth-redirect-sandbox.googleusercontent.com/r/*`, `https://oauth-redirect-test.googleusercontent.com/r/*`, and the same three with `/a/*`, plus any app-specific URI the console shows. `oauth.ts` already approves `/r/*` and `/a/*` on these three hosts plus `gemini.google.com`. |
| Consent screen logo (square SVG, ≥ 500 x 500) | https://heyclyde.me/brand/clyde.svg (512 x 512, circle on a square canvas) |
| Test account | `review@heyclyde.me`, password stored in `~/.config/memory/review-password` (no MFA, 40 sample notes reseeded nightly). Expand **Have a password?** on the consent page, enter `review@heyclyde.me` and the password, and give the password directly to Google's reviewer through their requested private channel. |

**Sync and availability**

- Sync tools without extra locale or location context. User confirmation turns on automatically where `destructiveHint` is `true`.
- Enable Canada (excluding Quebec) and the United States first. Keep the EU, EEA, UK, and Switzerland off, where Clyde isn't offered. Language: English.

**Testing and submission**

1. Add Wen's `@gmail.com` account as a tester.
2. Run the five `positive_tests` and three `negative_tests` from [clyde.json](clyde.json) in the Gemini app, and save the transcript for [#63](https://github.com/gewenyu99/like-vincent/issues/63).
3. Click **Send for review**, then **Publish** after approval.

Wen accepts any policy acknowledgments the console displays.

## Claude plugin directory

Submit the plugin bundle from [`gewenyu99/heyclyde`](https://github.com/gewenyu99/heyclyde) at [claude.ai/settings/plugins/submit](https://claude.ai/settings/plugins/submit):

- **GitHub repository.** `https://github.com/gewenyu99/heyclyde` (bundle path `./plugins/claude`, marketplace `.claude-plugin/marketplace.json`).
- **Direct archive.** `/Users/vincent/.gemini/antigravity/scratch/heyclyde/dist/clyde-claude-plugin.zip` (also attached to GitHub Release `v1.0.0`).
- **Validator checks.** `plugins/claude` ships zero local command hooks, PNG-only icons, and no `userConfig`. `/Users/vincent/.paseo/bin/claude plugin validate --profile directory --strict ./plugins/claude` passes, and Anthropic's online directory validator (`claude.ai/directory/manage/new/plugin`) reports zero blocking errors and zero policy holds.

## OpenAI ChatGPT and Codex

**ChatGPT Apps and Plugins portal** ([platform.openai.com/apps-manage](https://platform.openai.com/apps-manage)):

1. Upload `/Users/vincent/.gemini/antigravity/scratch/heyclyde/dist/clyde-openai-plugin.zip` (or release asset `https://github.com/gewenyu99/heyclyde/releases/download/v1.0.0/clyde-openai-plugin.zip`). The zip puts `plugin.json`, `mcp.json`, `README.md`, and `LICENSE` at root, `skills/clyde/SKILL.md` in `skills/`, and icons in `assets/`, with no `hooks/`. `plugin.json` sets `capabilities` to `["Interactive", "Read", "Write"]`.
2. Copy the domain challenge token for `heyclyde.me` and save it into `memory.setting` (takes effect within 60 seconds with no redeploy):

   ```sql
   insert into memory.setting (name, value)
   values ('openai_apps_challenge', '<TOKEN>')
   on conflict (name) do update set value = excluded.value
   ```

3. Confirm `curl -fsSL https://heyclyde.me/.well-known/openai-apps-challenge` returns the exact token, pass `review@heyclyde.me` and its password from `~/.config/memory/review-password` if OpenAI's reviewer form requests test credentials, then click Verify and submit.

**Codex plugin directory** ([chatgpt.com/codex/plugins/submit](https://chatgpt.com/codex/plugins/submit), docs [developers.openai.com/codex/submit-plugins](https://developers.openai.com/codex/submit-plugins)):

- **Repository.** `https://github.com/gewenyu99/heyclyde`.
- **Marketplace.** `.agents/plugins/marketplace.json` pointing to `./plugins/openai` (OAuth DCR on `https://heyclyde.me/mcp`, zero hooks).

## Antigravity plugin marketplace

Submit at [forms.gle/2EX5RFYPoJe1UgxR9](https://forms.gle/2EX5RFYPoJe1UgxR9):

- **Repository.** `https://github.com/gewenyu99/heyclyde`.
- **Bundle path.** `./plugins/antigravity` (archive `clyde-antigravity-plugin.zip` at `/Users/vincent/.gemini/antigravity/scratch/heyclyde/dist/clyde-antigravity-plugin.zip` and Release `v1.0.0`).
- **Validator.** `agy plugin validate --strict ./plugins/antigravity` passed with zero warnings (`skills 1`, `rules 1`, `mcpServers 1`).

## Gemini CLI extension gallery

Live and ready for indexing on [geminicli.com/extensions](https://geminicli.com/extensions/):

- **Repository.** Public repo `https://github.com/gewenyu99/heyclyde` carries topic `gemini-cli-extension`, root `gemini-extension.json` (`https://heyclyde.me/mcp`), `GEMINI.md`, and Release `v1.0.0` tarball `clyde.tar.gz`.
- **Install check.** `gemini extensions install https://github.com/gewenyu99/heyclyde`.

## Grok

Custom remote MCP connector `https://heyclyde.me/mcp` with setup instructions at [heyclyde.me/docs#grok](https://heyclyde.me/docs#grok). xAI doesn't offer a public third-party connector directory.
