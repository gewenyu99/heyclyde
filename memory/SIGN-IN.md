# Signing in to Clyde

Two different things are called OAuth here, and they never mix.

1. **An app connects to Clyde.** Claude, ChatGPT, Codex, Gemini, Antigravity, Grok and other MCP clients authorize *Clyde's MCP server*. Supabase Auth's OAuth 2.1 server runs it, with dynamic client registration and S256 PKCE. The app gets a Clyde access token. Clyde never gets a token for the app, its model, or the person's account there.
2. **A person proves who they are.** Email link or code, a password (the store reviewers' account), or Google or GitHub. Supabase Auth runs all of them. Google and GitHub only say whose account it is. Clyde asks them for nothing else.

Google and GitHub sign in a person at three places:

| Entry point | Where | How |
|---|---|---|
| Connecting an app | `memory.heyclyde.me/oauth/consent` | The consent page's **Continue with Google** and **Continue with GitHub** buttons (`oauth.ts` `startProvider`, back to `/oauth/approve?direct=1`) |
| The workspace | `heyclyde.me/memories` and every app page | The sign-in form's buttons (`memory/proxy/social.js`, back to `heyclyde.me/auth/callback`) |
| The installer | `curl -fsSL https://heyclyde.me/install \| sh` | Email link only, for now. See [What's left](#whats-left) |

Each button shows only once Supabase Auth has that provider on: the consent page asks `/auth/v1/settings` through `oauth.ts` `enabledProviders`, and the workspace asks it through the Worker.

## Apps that connect to Clyde

Every app below registers itself and sends S256 PKCE. `oauth.ts` `clientAllowed` approves the callback, or refuses it and logs `oauth_deny` to `admin_audit`. A refused app gets `error=access_denied` and no code.

| App | Callback Clyde approves | Source |
|---|---|---|
| claude.ai, Claude desktop and mobile, Cowork | `https://claude.ai/api/mcp/auth_callback` (and `claude.com`) | [Anthropic: connector authentication](https://claude.com/docs/connectors/building/authentication) |
| Claude Code | `http://localhost:<port>/callback`, any port | [Claude Code: MCP](https://code.claude.com/docs/en/mcp), [RFC 8252 §7.3](https://www.rfc-editor.org/rfc/rfc8252#section-7.3) |
| ChatGPT | `https://chatgpt.com/connector_platform_oauth_redirect`, and `https://chatgpt.com/connector/oauth/<id>` | [OpenAI Apps SDK: authentication](https://developers.openai.com/apps-sdk/build/auth) |
| Codex CLI | loopback `http://127.0.0.1:<port>/callback/<id>` from `codex mcp login` | [Codex: MCP](https://developers.openai.com/codex/mcp) |
| Gemini CLI | loopback, by default `http://localhost:7777/oauth/callback` | [Gemini CLI: MCP servers](https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md) |
| Gemini app (Connected Apps) | `/r/*` and `/a/*` on `oauth-redirect.googleusercontent.com` and its `-sandbox` and `-test` hosts | Google's Connected Apps console ([listing/SUBMIT.md](listing/SUBMIT.md)) |
| Antigravity | `https://antigravity.google/oauth-callback` | [Antigravity: MCP](https://antigravity.google/docs/mcp) |
| Grok | `https` on `grok.com` or `x.ai` | Not documented by xAI. Approved by host and logged, so its real callback shows on the first try |
| Other MCP clients | loopback `http` or `https`, any port and path | RFC 8252 §7.3 |

None of these apps signs a person in to Clyde, and Clyde doesn't use any of them as an identity provider. "Sign in with ChatGPT" or "Sign in with Claude" for a Clyde account has no documented contract, so Clyde offers neither.

## The provider flows

### Connecting an app (consent page)

1. The app sends the person to Supabase Auth's `/authorize`. Supabase sends them to `/oauth/consent?authorization_id=<id>`.
2. **Continue with GitHub** opens `/oauth/provider?authorization_id=<id>&provider=github`. The function stores a PKCE verifier for `<id>`, sets `__Host-clyde_oauth=<id>.<bind>` (`HttpOnly`, `Secure`, `SameSite=Lax`, 15 minutes) and sends the browser to Supabase Auth's `/authorize?provider=github` with the challenge and `redirect_to=/oauth/approve?authorization_id=<id>&direct=1&bind=<bind>`.
3. GitHub, then Supabase Auth, send the browser back to `/oauth/approve`. The function refuses, without spending the code:
   - a cancelled sign-in (`error=access_denied`): the **Sign-in cancelled** page, with **Back to sign-in** for the same request
   - a provider error: the error, with **Back to sign-in**
   - a request older than 15 minutes: **Link expired**
   - a browser without the matching cookie, or a `bind` that doesn't match: 403, with **Back to sign-in**
4. Otherwise it trades the code and the verifier for a session, and requires a verified email. Then the usual rules apply: the allowlist while sign-up is closed, the region check, the callback check above, and the free tier and plan. The window goes on to the app through `/oauth/wait`.

### The workspace

1. **Continue with Google** on `heyclyde.me` makes a verifier, its S256 challenge and a state, keeps them in the tab's `sessionStorage` for 10 minutes, and opens `/auth/v1/authorize?provider=google&redirect_to=https://heyclyde.me/auth/callback?state=<state>`. The Worker passes it to Supabase Auth.
2. `/auth/callback` takes the code out of the address bar first. It refuses a callback with no pending sign-in in this tab, a stale one, or a state that doesn't match, before any exchange. A cancelled sign-in says so.
3. It trades the code and the verifier at `/auth/v1/token?grant_type=pkce`, keeps the session as the email sign-in does, and goes back to the workspace page that started it. Only a workspace path on `heyclyde.me` can be that page. Anything else lands on `/memories`.

### Existing accounts

Supabase Auth links a Google or GitHub identity to the account that already has the same verified email ([identity linking](https://supabase.com/docs/guides/auth/auth-identity-linking)). The account keeps its id, so its notes, devices, plan, free seat and connected apps stay. Email links, codes and passwords keep working. A provider account with no verified email gets no access.

Nothing here changes who may use Clyde. With `open_signup` off, a new Google or GitHub person who isn't on the allowlist is refused at the consent page and by every `/me` and `/mcp` call, as an email sign-in is. With it on, they get the same free-seat and plan checks.

## Owner setup

No credentials are in this repo. Each step below needs the owner's own accounts.

1. **Google.** In Google Cloud Console, create an OAuth client of type *Web application*. Add the authorized redirect URI `https://wlhlncmgjqyidosunugv.supabase.co/auth/v1/callback`. Set the consent screen's app name to Clyde, its home page to `https://heyclyde.me`, and its privacy and terms links to `https://heyclyde.me/privacy` and `/terms`. Ask only for the default `openid`, `email` and `profile` scopes. ([Supabase: Login with Google](https://supabase.com/docs/guides/auth/social-login/auth-google))
2. **GitHub.** Create an OAuth App (not a GitHub App) with the homepage `https://heyclyde.me` and the authorization callback URL `https://wlhlncmgjqyidosunugv.supabase.co/auth/v1/callback`. ([Supabase: Login with GitHub](https://supabase.com/docs/guides/auth/social-login/auth-github))
3. **Turn them on.** Put the client IDs and secrets in your shell, not in a file, and run [`oauth_providers_setup.sh`](oauth_providers_setup.sh). It turns each provider on in Supabase Auth through the Management API.
4. **Redirect URLs.** Supabase Auth's redirect allow list must hold `https://heyclyde.me/**` and `https://memory.heyclyde.me/oauth/approve**`, as [`supabase/config.toml`](supabase/config.toml) says. Supabase sends an unlisted `redirect_to` to the site URL instead ([redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls)).
5. **Identity linking.** Leave automatic linking on, so existing accounts get the new sign-in rather than a second account.
6. **Sign-ups.** New Google or GitHub people need Supabase Auth's sign-ups allowed. Clyde's own `open_signup` setting still decides who gets in.
7. **Deploy** the function and the Worker as usual ([DEPLOY.md](DEPLOY.md)). No migration is needed.

## What needs a live login

The tests run everything against a fake Supabase Auth: `harness/test/memory/signup.test.ts` (the consent flow), `social_test.ts` (the workspace client) and `proxy_test.ts` (the Worker). These need a real browser, a real provider account and the deployed site, once the owner setup is done:

| Case | Expect |
|---|---|
| Consent page, Continue with Google, then claude.ai | Claude shows Clyde connected, and **Apps** lists Claude |
| Consent page, Continue with GitHub, then ChatGPT developer mode | ChatGPT shows Clyde connected |
| Consent page, Cancel at Google | **Sign-in cancelled**, and **Back to sign-in** shows the same request's sign-in page |
| Workspace `/quests`, Continue with GitHub | Back on `/quests`, signed in |
| An existing email account signs in with Google on the same address | The same notes and plan, and one account in Supabase Auth with two identities |
| A GitHub account with no verified email | Refused with the verified-email message |
| Each provider on Safari and Firefox | The `__Host-clyde_oauth` cookie comes back on the provider's redirect |

## What's left

- **The installer** signs in with an email link. It could open Google or GitHub with the same PKCE hand-off (`/install/approve` stores any Supabase Auth code, and only the installer holds the verifier). `install.sh` is client surface, so it needs a `CLIENT_VERSION` bump and an offline-signed release.
- **Grok** has no documented callback. Its first live connect shows the real one in `admin_audit`.
- **Consent.** A signed-in person's approved app connects without a separate *Allow* screen. The callback check above keeps codes on approved apps' own hosts, but an attacker's own ChatGPT connector or Gemini Connected App would pass it. An *Allow Clyde for <app>* step before approval would close that.
