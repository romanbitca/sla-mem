# Slamem — Desktop App: Complete Build Plan

**Document version:** 1.1 · **Date:** 21 September 2026
**Audience:** an AI coding agent (plus the human who commissioned it) building this from an empty repository.

> **Read this whole document before writing any code.** It is self-contained: it carries the full
> product context, the Slack domain knowledge that is expensive to rediscover, the data model, the
> algorithms, the UX requirements, the packaging strategy, and a staged build plan. Sections 2, 5 and
> 12 in particular contain hard-won findings from a previous working implementation — ignoring them
> will cost you days and will produce an archive that silently loses data.
>
> This document is the **single source of truth** for the project. If something here turns out to be
> wrong, fix the document as well as the code.

### Contents

| § | Section | Why you care |
|---|---|---|
| 0 | How to use this document | Conventions, staging |
| 1 | Product definition | What we're building, for whom, constraints, **prior art (1.6)** |
| 2 | Getting data out of Slack without an admin | **The expensive-to-rediscover part** |
| 3 | Architecture | Electron layout, IPC, storage locations, security |
| 4 | Data model | Tables and design rationale |
| 5 | Sync engine | Algorithm + **the data-safety rules** |
| 6 | Search | Query language, FTS5 safety, performance |
| 7 | Message rendering | Slack mrkdwn + Block Kit |
| 8 | UX specification | Written for non-technical users |
| 9 | Packaging, distribution, updates | Unsigned builds, GitHub Releases |
| 10 | Storage | Measured numbers, media vs no media |
| 11 | **Staged build plan** | Stages 1–8 with acceptance criteria |
| 12 | Known pitfalls | 29 findings from the previous build |
| 13 | Testing strategy | |
| A–E | Appendices | API reference, DDL, mrkdwn, existing code, install guide |

---

## 0. How to use this document

- The work is split into **Stages 1–8** (§11). Each stage is independently shippable and has
  **acceptance criteria**. Build them in order. Do not start a stage before the previous one's
  acceptance criteria pass.
- Sections 1–10 are reference material for all stages. Section 12 is a list of **known pitfalls** —
  read it before Stage 3 and again before Stage 8.
- Where this document says **MUST**, it is a hard requirement (usually data-safety or privacy).
  **SHOULD** means strong default; deviate only with a stated reason.
- An earlier implementation of the *same product as a local web app* exists and works
  (see **Appendix D**). If the repository is seeded with it, large parts of Stages 1, 3, 4, 5 are
  already done and should be ported rather than rewritten.
- §1.6 records the **prior-art survey** (other tools that do parts of this). It is already done —
  don't repeat it.
- **As built:** where the implementation had to differ from this document, the document was
  corrected in place and the change is listed in **§0.3**. `docs/STATUS.md` maps every acceptance
  criterion (§11) and pitfall (§12) to the test or check that covers it.

### 0.1 Suggested repository layout

```
sla-mem/                 github.com/romanbitca/sla-mem
  PLAN.md                  ← this document
  README.md                what it is, how to build, test and release
  docs/INSTALL.md          the install guide for colleagues (Appendix E)
  docs/STATUS.md           acceptance criteria and pitfalls → evidence
  package.json
  electron.vite.config.ts  main / preload / renderer builds, and the renderer's CSP
  electron-builder.yml     packaging (§9)
  src/
    main/                  Electron main process
      index.ts             app lifecycle, windows, tray, menu
      context.ts           creates and wires the services
      ipc/                 IPC registration + handlers (archive reads, actions)
      db/                  schema, migrations, repositories, search, normalisation
      slack/               API client, sync engine, file downloader, attachment policy
      auth/                sign-in window, session capture, safeStorage, connection
      import/              Slack / slackdump export importer (folder or .zip)
      runs.ts              one job at a time (sync, downloads, import), progress, problems
      scheduler.ts, preferences.ts, logger.ts, redact.ts, protocol.ts (archive://),
      backup.ts, storage.ts, tray.ts, updates.ts, security.ts, …
    preload/index.ts       contextBridge API surface (window.archive)
    renderer/              React app (components, pages, hooks, mrkdwn renderer)
    shared/                types.ts (DTOs) + ipc.ts (the IPC contract)
  test/                    mock Slack server, synthetic workspace generator, import fixtures
  scripts/                 seed, bench, e2e, screenshots, icon generation
  build/, resources/tray/  app and tray icons
  .github/workflows/       ci.yml (checks on every push), release.yml (tagged builds → Release)
```

### 0.3 Changes made while building (as built)

Each item is also corrected where it belongs in this document.

- **Name:** the product is **Slamem** (the draft called it "Slack Archive", and it was sla-mem
  until 0.3.2): app, installers (`Slamem-<version>-<arch>.dmg`, `Slamem-Setup-<version>.exe`),
  data folder `Slamem`. An archive in a folder under an older name moves to the new one on first
  start. The first rename (Slack Archive → sla-mem) cost the saved Slack sign-in, because macOS
  names the Keychain item holding its key after Electron's name for the app; so since then that
  name stays `sla-mem` (`app.setName`, the item _sla-mem Safe Storage_), as do the app id
  `com.9h.sla-mem` (Update and restart only installs a download with the same id), the repository
  and the `SLA_MEM_*` variables. On a Mac, a copy that Update and restart put where sla-mem.app
  was renames itself Slamem.app at its first start and opens again (`bundle-rename.ts`); menus
  that Electron would label with its name are labelled Slamem. A saved sign-in that can't be
  unlocked (a rename, a copied archive folder, a Keychain entry that's gone) is noticed at
  start-up and shown like a signed-out session: "sign in to Slack again", Reconnect, and Sync now
  held back. (0.2.0 still called itself connected, and Sync now failed without a word.)

- **Toolchain (§3.1):** Electron 44, TypeScript 6.0 (typescript-eslint supports < 6.1), Vite 7
  (electron-vite 5 requires ≤ 7), Vitest 5 with jsdom 29, Playwright for the E2E run.
- **IPC shape (§3.3):** one whitelisted `call(method, arg)` / `on(event, cb)` bridge on
  `window.archive`, typed by `src/shared/ipc.ts`, with a result envelope carrying error codes.
- **Schema (§4, Appendix B):** added `bots`, `conversation_stats`, `files.skip_reason`,
  `files.next_attempt_at`, `runs.problem`, `runs.pid`, and a different index set, measured at 300k
  and 500k messages.
- **Attachments are served over `archive://` (§3.6),** never `file://`, and only for types that
  are safe to show inline.
- **Search (§6):** exclusions are prefix-matched like bare words; Chinese and Japanese text is
  segmented so words inside sentences are found; the search text carries a version and is rebuilt
  in the background after an upgrade that changes it.
- **Packaging (§9):** no native rebuild (better-sqlite3 13 ships Node-API prebuilds); ad-hoc signing
  on macOS (Apple Silicon refuses unsigned code); Electron fuses; Windows icon generated from a PNG.
- **Updates (§9.5):** releases are published in the code repository, made public on 2026-09-22 for
  that (GitHub hides a private repository's releases, so neither colleagues nor the update check
  could see them). Until the first release "Check for updates" says that no version has been
  published (GitHub's 404), rather than a failure to retry. The release workflow refuses a tag that doesn't
  match `package.json`: such a release would be offered as an update forever.
- **Update and restart (added, §9.5):** the banner's button downloads the new version, checks it,
  replaces the app and reopens it, on macOS too: the unsigned app replaces itself after quitting
  instead of going through Squirrel, which refuses unsigned builds. Download remains where the app
  can't replace itself.
- **Start at login (§5.3):** Electron 44 removed `openAsHidden`; a launch at login is detected
  with `wasOpenedAtLogin` and starts in the tray.
- **UI (§7, §8):** the theme choice (system, light, dark) lives in Settings → About; there is no
  separate "Test connection" button (the connection is checked on every sync and shown on the
  home page); a failed sign-in during onboarding also offers Advanced → paste session cookie;
  file actions say "Show in Finder" / "Show in Explorer"; sync history is folded by default and
  the archive numbers appear after the first sync. Block Kit is drawn read-only: buttons and
  inputs are inert, `markdown` blocks show as text, and images on Slack's private file URLs are
  not shown. A thread panel draws 200 replies at a time.
- **Search as a place (added, §8.2):** the sidebar has a **Search** item next to Overview instead
  of a search box; it (and ⌘K / Ctrl+K, and "/") opens the search screen with the last search,
  the cursor in its box. In a window at least 1200 px wide a result opens beside the list (the
  conversation at that message, or the thread for a reply), the list staying where it is with the
  open result marked; the preview is in the URL (`c`, `ts`, `thread`), Esc closes it, and "Open
  conversation" shows the whole conversation. In narrower windows a result opens the
  conversation. Either way the conversation offers **Search results**, which returns to the same
  search, scrolled where the list was, with that result focused.
- **What to archive (added):** conversations can be left out, such as a channel or the DMs with
  someone. Onboarding's third step first lists every conversation (fetched from Slack without
  any history) with all ticked, and only "Start archiving" begins the first sync; automatic syncs
  wait until onboarding is finished. The same list is in Settings. An excluded conversation gets
  no history, threads or attachments (a file also shared somewhere archived still downloads), and
  what was archived before stays unless the reader chooses to delete it.
- **Moving to another computer (added):** "Back up now" writes the whole archive into one zip;
  "Import a backup" (first screen, or Settings → Storage) merges it into the archive on another
  computer, row by row, losing and duplicating nothing, and carries each conversation's sync
  position over so syncing continues where it stopped. A backup of another Slack account is
  refused.
- **Menu bar icon (added):** can be turned off in Settings → App; the app then keeps syncing in
  the background and is reopened like any app. While syncing, its menu shows one progress line.
- **Settings → App (added, §8.4):** "Start Slamem when I log in" and the menu bar icon are about
  the app, not syncing, so they have their own card after Sync. "Last successful sync" (Settings
  and Home) also says how many new messages that sync brought in.
- **Faster incremental syncs (added, §5.2):** quiet threads are re-checked from their parents'
  reply counts instead of one `conversations.replies` call each, so on the real 111-conversation
  workspace a sync with nothing new went from 178 API calls (about 3 minutes) to about 117 (about
  2 minutes). Every conversation is still read on every sync: 0.2.x also skipped unchanged ones
  using the Slack app's own unread summary (`client.counts`, down to about 20 calls), but that
  call is not part of Slack's documented API, so it was removed to keep Slamem on the published
  API only (the owner's decision, 2026-09-22).
- **Overview (0.3.2, §8.2):** the home page and its sidebar item are called **Overview** (a
  dashboard icon), not Archive: everything in the app is the archive. Its **Archive covers** card
  starts where the steady history starts when a handful of messages reach much further back. Slack
  still shows some messages past its 90 days (notes to yourself, thread starters with recent
  replies), so the first sync of the real workspace found five notes from March while everything
  else began on Jun 24, and "Mar 18 – Sep 22, 189 days" described it badly. The card then reads
  "Jun 24, 2026 – Sep 22, 2026 · 91 days · plus 7 older messages, back to Mar 18, 2026", the date
  linking to the oldest message. Main finds the start from the point all but the oldest 1% of
  messages follow, back through messages less than four days apart, and only says it when the few
  older ones stretch the range by over a month and over a quarter (`getStats` → `mainStart`).
- **Conversation header (0.3.2, §8.3):** the line under the name gives the total ("1,057 messages
  · Mar 6 – Sep 21, 2026") and, set apart, how many of them Slack Free no longer shows, with their
  dates ("522 no longer in Slack · Mar 6 – Jun 18, 2026"), or "All still in Slack" (the tooltip says
  when the first one drops out). Older than 90 days is the same rule as the Overview's count. The
  details give way as the header narrows (a thread open), and the tooltips keep them.
- **Sidebar filter (0.3.2):** "Filter conversations" is a bordered box with a filter icon, set apart
  from Overview and Search by a line, and its clear button shows whenever it holds text.
- **Ask AI (added, opt-in):** a sidebar place where the reader asks questions about the archive in
  plain words ("where did Ana mention the tests?", "what happened in #design this week?") and
  Claude answers with numbered citations that open the message beside the chat (or its
  conversation, with a way back), like search results. It uses the reader's own Anthropic API key
  (Settings → Ask AI: checked with Anthropic before saving, kept encrypted with the OS keychain like
  the Slack session, never shown again) and the model chosen there (Claude Sonnet 5 by default,
  Haiku 4.5 for speed and half the price, Opus 5 for hard questions: Settings warns that it costs
  about 2.5 times as much). Answers come in the language of the question, whatever language the
  messages are in. A search can also list words of which one must appear (synonyms and
  translations), and Claude is taught to search the author's wording rather than the reader's: on
  a real miss ("where Geri put my projects on someone", written "distributed your projects
  among"), searching the person, the topic and the reader's name, or the verb's synonyms, found
  the message first or second, where the reader's own words never showed it. Claude works through four local tools (search with
  Slack syntax, open a message with its thread or surroundings, read a conversation over a period,
  list the busiest conversations); only their compact text, the question and the answer travel,
  and only while a question is answered: this is the one exception to "the only network traffic is
  Slack" (§1.2), and it happens only once the reader adds a key. The "In", "From" and "Date" buttons
  under the question box limit a question; the tools can't look outside the limits. Kept cheap and
  quick: medium effort (low made 1–3 cent answers in 10–24 s on Sonnet 5, but searched in the
  wrong language), the prompt cache, compact tool text and a round limit; each answer shows its
  tokens and cost. Chats live in memory only (New chat forgets one; quitting forgets all); logs say
  what an answer cost, never what was asked. `npm run mock:claude` plus `SLA_MEM_ANTHROPIC_API`
  (development builds only) stand in for Anthropic without a key.
- **Export conversation (Stage 8 nicety):** built as Markdown only (day headings, threads as
  quotes, edits, deletions, attachments and reactions noted). Markdown opens in any editor and
  renders in most viewers, so the HTML variant was left out.

### 0.2 First commits (before Stage 1 features)

1. This document as `PLAN.md`, plus a README stating what the project is and its licence.
2. Toolchain: TypeScript strict, electron-vite, ESLint/Prettier, Vitest, a CI job running
   `typecheck + test` on every push.
3. `src/shared/types.ts` with the IPC contract stubbed — it is the seam between the two halves of
   the app and is worth defining before either half exists.

---

## 1. Product definition

### 1.1 The problem

The company ("9H", a digital agency) uses Slack on the **Free plan**. On that plan:

- Only the **most recent 90 days** of messages are visible — in the Slack UI *and* through the API.
- Older content is **hidden, not immediately destroyed**: Slack still holds it, and upgrading to a
  paid plan restores up to the previous 12 months. But on a Free plan you cannot reach it by any
  means, and beyond roughly a year it is **deleted permanently**.
- File attachments older than 90 days become inaccessible stubs.

So institutional memory evaporates: decisions, client conversations, links, screenshots, and
context disappear on a rolling basis. Paying to upgrade is not on the table, and nobody wants to.

**The practical consequence for this project:** anything not captured within its 90-day window is
effectively gone for good. That makes *regular, unattended* syncing the single most important
behaviour of the app — an archive that only runs when someone remembers to open it will have holes.

### 1.2 What we are building

A **desktop application** that keeps a **permanent, private, searchable copy of one person's own
Slack history on their own computer**.

- It syncs regularly. Anything it has ever seen is kept **forever**, even after Slack hides or
  deletes it. This is the core value proposition and the source of most hard requirements.
- It is **local-first**: one machine, no server, no cloud, no account system, no telemetry. The only
  network traffic is directly between the app and Slack, fetching that user's own data. *(As
  built: the update check and download from GitHub, and, only once the reader adds their own
  Anthropic API key, Ask AI's questions to Claude; see §0.3.)*
- Each person runs their own copy and sees **only their own Slack view**: the channels they are in,
  their DMs, their private channels. There is no central archive and no cross-user access.

### 1.3 Who uses it

| User | Profile | Implication |
|---|---|---|
| The owner (1 person) | Technical, will build/distribute, comfortable with terminals | Can handle ops, releases |
| Colleagues (many) | **Totally non-technical**, mixed **macOS and Windows** | Zero terminal, zero config, plain-language errors, one-click everything |

**The non-technical audience is the dominant UX constraint.** If a step requires reading a log,
editing a file, opening a terminal, pasting a token, or understanding a Slack concept, it is wrong.

### 1.4 Hard constraints

1. **No Slack workspace admin involvement.** The admin route is unavailable — the workspace has hit
   the Free plan's 10-app limit, and the users are not admins. Therefore **no Slack app, no OAuth,
   no bot tokens, no admin exports.** See §2 for the route that remains.
2. **macOS and Windows** must both be supported, first-class.
3. **Fully local.** No server component, no hosted service, no user accounts, no shared storage.
4. **Single machine.** No cross-device sync, no mobile, no remote access. Accepted trade-off.
5. **Free distribution infrastructure only** (GitHub Releases). No paid code-signing certificates
   for now — the app ships **unsigned**, and users are given bypass instructions (§9.4, Appendix E).

### 1.5 Non-goals (explicitly out of scope)

- Multi-user / multi-tenant server, login accounts, admin panels.
- Archiving *other people's* DMs or private channels. Impossible and unwanted.
- Company-wide/workspace-wide export.
- Mobile apps, browser access, remote access to the archive.
- Posting to Slack, editing, reacting, or any write operation against Slack. **The app is strictly
  read-only against Slack.**

### 1.6 Prior art — what already exists, and why we are still building this

This landscape was surveyed in September 2026. **Do not re-research it**; use this instead, and
borrow freely from the projects below.

| Project | What it does | Why it isn't what we need |
|---|---|---|
| **[slackdump](https://github.com/rusq/slackdump)** — 2.8k★, actively maintained, **AGPLv3** | The serious prior art. Browser-session login with **no admin or Slack app**; archives channels, DMs, threads, files, emoji; **incremental archives** (resume/append); built-in viewer (`slackdump view`); static-HTML export; macOS/Windows/Linux | **CLI-first** — its terminal login flow was tried with our actual users and rejected as too technical. No background/scheduled sync, no installer, no polished reading/search UI |
| [slackclaw](https://github.com/pooriaarab/slackclaw) | Reads the **Slack Desktop app's local cache** (IndexedDB → Snappy → V8 deserialize) into SQLite + FTS5. No token at all | Genuinely clever, but CLI-only, 0★, no releases, no continuous sync, no Windows. Cache-only coverage |
| [SlackBackup](https://github.com/jcolag/SlackBackup) | An **Electron** app: downloads Slack to Markdown, fuzzy search, some analytics | Closest in form factor. 6★, manual token paste, no automatic sync, effectively dormant |
| [slack-history-archiver](https://github.com/ordigital/slack-history-archiver) | Scripts → SQLite, small Flask/Vue UI, cron'd daily, uses browser token+cookie | Same concept as ours, but 1★/8 commits — scripts, not a product |
| [felixrieseberg/slack-archive](https://github.com/felixrieseberg/slack-archive) | Generates static HTML archives with basic search | One-shot snapshots, not a living archive |
| [slack-export-viewer](https://github.com/hfaran/slack-export-viewer), [slack-vuesualizer](https://github.com/4350pChris/slack-vuesualizer) | Browse/search an existing Slack export | Viewers only — they fetch nothing |
| [slack-archive-bot](https://github.com/docmarionum1/slack-archive-bot) | A bot that archives messages and makes them searchable | Requires a bot **installed by an admin** — blocked for us (§1.4) |
| Commercial (Backupery, Mimecast, Smarsh, compliance vendors) | Backup / retention / eDiscovery | Admin- or Enterprise-only, and/or paid. Nothing targets an individual on a Free plan |

**Conclusion: the gap is real.** Nobody ships an installable, cross-platform desktop app that
quietly keeps a non-technical person's own Slack history archived in the background with a good
reading and search experience. Everything available is a developer CLI, a static snapshot, a viewer
for an export someone else produced, or needs an admin.

**Build vs. wrap — decision.** slackdump has already solved the riskiest parts (session auth,
incremental archiving). Wrapping its binary in our Electron UI was considered and **rejected**:

1. **Licence.** slackdump is **AGPLv3**. Shipping a combined application means the copyleft
   obligations attach — source must be offered to every recipient. Acceptable for an internal tool,
   but it constrains the project permanently and is a real obligation, not a footnote.
2. **Control.** We would inherit its CLI surface, its auth UX, and its release cadence, and we would
   still have to build everything that actually matters here (background sync, installer, reading
   UI, search UI, non-technical error handling).
3. **We already have an engine.** A working implementation of the sync engine, database, search and
   UI exists (Appendix D) with ~900 passing tests.

**So: build our own, and keep slackdump as an interoperability path** — the importer for
Slack/slackdump export folders and `.zip` files (Appendix D) means a user who already has a
slackdump archive, or who ever obtains an official export, can load it straight in.

**Worth borrowing:** slackdump's export layout (we already read it), its documented auth mechanics
(§2.2 was derived partly from its source), and slackclaw's desktop-cache idea as a possible future
fallback if the session approach ever breaks.

---

## 2. Critical domain knowledge: getting data out of Slack without an admin

**This section is the part that is expensive to rediscover. Read it carefully.**

### 2.1 Why the "proper" routes are closed

| Route | Why it's unavailable |
|---|---|
| Slack app + OAuth user token (`xoxp-`) | Creating/installing an app needs an admin to approve it, and the Free workspace is at its 10-app limit. Blocked. |
| Workspace admin export | Admin-only; on Free it covers public channels only. Blocked and insufficient. |
| Slack's own "export my data" | Not available to members on Free. |

### 2.2 The route that works: the Slack **web session**

The Slack web client authenticates with two things that together act as the user's credentials:

1. **`xoxc-…` token** — the web client's API token. It lives in the browser's `localStorage` under
   the key **`localConfig_v2`**, inside a JSON structure:
   ```jsonc
   {
     "teams": {
       "T01ABCDEFG": {
         "id": "T01ABCDEFG",
         "name": "9H",
         "domain": "9h",                    // → 9h.slack.com
         "token": "xoxc-1234-5678-...",     // ← the API token
         "user_id": "U01ABCDEFG"
       }
     }
   }
   ```
   Note `teams` is keyed by team id and contains **one entry per signed-in workspace**.

2. **`d` cookie** — an HttpOnly cookie on domain `.slack.com`, value starts with `xoxd-`. The
   `xoxc` token is **useless without it**.

Every Slack Web API request must therefore send **both**:
```http
POST https://slack.com/api/conversations.history
Authorization: Bearer xoxc-1234-5678-...
Cookie: d=xoxd-...
Content-Type: application/x-www-form-urlencoded
```
Missing or mismatched cookie ⇒ `{"ok": false, "error": "invalid_auth"}`.

**Fallback: deriving the token from the cookie alone.** If you have the `d` cookie but not the
token, you can fetch the workspace's boot page with the cookie set and extract
`"api_token":"xoxc-…"` from the HTML (e.g. `https://<domain>.slack.com/` or
`https://<domain>.slack.com/ssb/redirect`). Implement this as a fallback; it also powers a manual
"paste your cookie" escape hatch.

### 2.3 Capturing the session — **why a desktop app makes this easy**

This is the single biggest reason to build a desktop app rather than a local web app.

Previous attempts and why they were rejected:

| Attempt | Outcome |
|---|---|
| `slackdump` CLI (`slackdump workspace new`) | Works, but is a terminal tool. Non-starter for non-technical users. Its browser login also failed in testing with `target page is closed`. |
| Launching a separate Chrome with `--remote-debugging-port` and reading the session over the Chrome DevTools Protocol | Works, but a **second Chrome window appears**, the user must sign in *again* in an unfamiliar browser. Users found this confusing and alarming. Also fragile: on macOS, closing the last window leaves Chrome running and `Storage.getCookies` starts failing with "Browser context management is not supported". |
| A companion browser extension | Works and stays in the user's own browser, but requires every non-technical colleague to install an unpacked extension via developer mode. Too much friction. |

**In Electron, none of this is necessary.** The app opens Slack in *its own* `BrowserWindow`, so it
can read that window's cookies and localStorage directly:

```ts
// Use a PERSISTENT partition so the login survives app restarts.
const slackSession = session.fromPartition('persist:slack')

const win = new BrowserWindow({
  width: 1000, height: 760,
  webPreferences: { partition: 'persist:slack', nodeIntegration: false, contextIsolation: true },
})
await win.loadURL('https://app.slack.com/signin')   // or https://<domain>.slack.com/

// Poll (every ~1.5 s) until BOTH are available:
const [dCookie] = await slackSession.cookies.get({ domain: '.slack.com', name: 'd' })
const raw = await win.webContents.executeJavaScript(
  'window.localStorage.getItem("localConfig_v2")', true)
const teams = raw ? JSON.parse(raw).teams : null
// A team entry with a `token` starting with "xoxc-" plus dCookie.value starting with "xoxd-"
// means the sign-in completed.
```

Details that matter:

- **Use a persistent partition** (`persist:slack`). With a non-persistent one the session is lost on
  window close and the user must re-authenticate every time.
- **Detect completion by polling for the credentials**, not by watching URLs. Slack's sign-in flow
  redirects through several hosts (SSO providers, `slack.com`, `app.slack.com/client/…`) and URL
  patterns are brittle.
- **Handle multiple workspaces.** If `teams` has more than one entry, show a picker. Bind the
  archive to exactly one team (§5.7).
- **Handle the user closing the window** before finishing: treat as "cancelled", not an error.
- **Time out** after ~10 minutes of no progress.
- **Never log, display, or persist in plaintext** the token or cookie (§3.5).

### 2.4 ⚠️ Google sign-in inside an Electron window — known risk

Many workspaces (including this one, likely) sign in through **Google**. Google actively blocks
OAuth in embedded/automated browsers, returning *"This browser or app may not be secure"*
(`disallowed_useragent`). An Electron `BrowserWindow` can trip this.

**Mitigations, in order of preference:**

1. **Offer Slack's email code sign-in as the primary path.** Slack lets any user sign in with
   *"Sign in with email"* — it emails a **6-digit code**, no Google involved, and it works reliably
   inside an embedded window. For non-technical users, "type the code we emailed you" is the
   *easiest* flow there is. **Make this the recommended option in the UI.**
2. **Spoof a normal Chrome user agent** on the Slack window:
   ```ts
   slackSession.setUserAgent(
     'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
     '(KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36')
   ```
   This often gets Google sign-in through. Not guaranteed.
3. **Fallback: "Paste your session cookie"** under an "Advanced" disclosure, for the rare case both
   fail (instructions: open Slack in your browser → DevTools → Application → Cookies →
   `https://app.slack.com` → copy the value of `d`). Derive the token per §2.2.

**Stage 2 MUST test the real sign-in path against the real workspace early.** Do not defer this;
it is the highest-risk unknown in the project.

### 2.5 Which Slack Web API methods to use

Base URL `https://slack.com/api/`. All calls are form-encoded POST (or GET with query), with the
`Authorization` + `Cookie` headers from §2.2.

| Method | Purpose | Key params |
|---|---|---|
| `auth.test` | Validate session; get `team_id`, `team`, `user_id`, `user`, `url` | — |
| `team.info` | Team name/domain/icon | — (optional; may fail without scope — ignore errors) |
| `users.list` | All workspace users (for names/avatars) | `limit=200`, `cursor` |
| `users.conversations` | **The conversations this user is a member of** — use this, not `conversations.list` | `types=public_channel,private_channel,mpim,im`, `exclude_archived=false`, `limit=200`, `cursor` |
| `conversations.history` | Messages in a conversation, newest first | `channel`, `limit=200`, `cursor`, `oldest`, `latest`, `inclusive` |
| `conversations.replies` | Thread replies (**returns the parent as the first item on every page**) | `channel`, `ts`, `limit=200`, `cursor` |
| `conversations.info` | Conversation metadata when needed | `channel` |
| `emoji.list` | Custom emoji name → URL | — (may fail; ignore) |
| file download | `url_private_download` (or `url_private`) with the same auth headers | — |

**Why `users.conversations` and not `conversations.list`:** the latter returns every public channel
in the workspace including ones the user never joined; the former returns exactly the user's own
view, which is what we archive.

### 2.6 Pagination

Cursor-based:
```jsonc
{ "ok": true, "messages": [...], "has_more": true,
  "response_metadata": { "next_cursor": "dXNlcjpVMDYxTkZUVDI=" } }
```
Loop while `next_cursor` is a **non-empty string**. An empty string or missing field ends the loop.
`conversations.history` returns **newest → oldest**.

### 2.7 Rate limits

- Tiers: `conversations.history` / `conversations.replies` / `users.conversations` ≈ **Tier 3
  (~50 requests/minute)**; `users.list` ≈ Tier 2 (~20/min).
- On limit: **HTTP 429** with a `Retry-After: <seconds>` header. **MUST** honour it, sleep, retry.
- Implement a small per-method token bucket so you rarely hit 429 at all.
- Retry `5xx` and network errors with exponential backoff + jitter, max ~5 attempts.
- Note: the 2025 rate-limit reductions target non-Marketplace *distributed apps*; a web session
  behaves like the Slack web client.

### 2.8 Free-plan behaviour you must handle

- `conversations.history` simply **stops returning messages beyond ~90 days**. This is not an error.
  Backfill ends naturally; record that you reached the boundary.
- Files older than the window come back as stubs: `{"id": "F…", "mode": "hidden_by_limit"}` with no
  URLs. **These MUST NOT overwrite a good, previously archived file record** (§5.6).
- Deleted messages may appear as `subtype: "tombstone"`. **MUST NOT** erase previously archived
  content (§5.6).
- Note the nuance from §1.1: beyond 90 days Slack *hides* rather than instantly deletes, and a paid
  upgrade would restore up to 12 months. From the API's point of view on a Free plan the data is
  simply unreachable, so treat it as gone — but this is why a missed sync window is recoverable *only*
  by upgrading, and why unattended scheduled syncing matters so much.
- This is precisely why the archive exists: **Slack forgets, we must not.**

### 2.9 Legal / terms note (state this in the README)

Using a web-session token is how `slackdump` and similar tools work. It is **not** an officially
sanctioned automation path. In this design each person captures **their own** session, on **their
own** machine, to read **their own** messages, and nothing is centralised — which is the least
objectionable form of this. The app is strictly read-only. Users should be told plainly, once, in
the README and the onboarding screen, that this uses their Slack login to make a personal copy of
their own history.

---

## 3. Architecture

### 3.1 Stack

| Concern | Choice | Notes |
|---|---|---|
| Shell | **Electron** (latest stable; 44 as built) | Bundles Chromium + Node; lets us own the Slack sign-in window (§2.3) |
| Language | **TypeScript**, strict (6.0 as built) | Everywhere: main, preload, renderer. typescript-eslint supports < 6.1 |
| Build/dev | **electron-vite** (recommended) or electron-forge + Vite | As built: electron-vite 5, which requires Vite ≤ 7 |
| UI | **React 19** + **Tailwind CSS v4** | Same stack as the existing implementation |
| Router | `react-router` (memory or hash router — see §3.3) | |
| Data fetching/cache | **TanStack Query v5** | |
| Database | **SQLite via `better-sqlite3`** with **FTS5** | Synchronous API, ideal for the main process |
| Packaging | **electron-builder** | dmg/zip (macOS arm64 + x64), NSIS (Windows x64) |
| Updates | **GitHub Releases** + update check (§9.5) | Free |
| Tests | **Vitest** (+ jsdom for components); Playwright optional for E2E | As built: `scripts/e2e.ts` drives the built app with Playwright against the mock Slack |

### 3.2 Process layout

```
┌─ Main process (Node) ─────────────────────────────────────────┐
│  • SQLite (better-sqlite3) — the archive                      │
│  • Slack Web API client (rate limiting, retries, pagination)   │
│  • Sync engine + scheduler (runs on a timer, in background)    │
│  • File downloader                                            │
│  • Credential storage (Electron safeStorage)                   │
│  • Slack sign-in BrowserWindow (session capture)              │
│  • Tray icon, app lifecycle, auto-launch, update checks        │
└──────────────┬────────────────────────────────────────────────┘
               │ typed IPC (contextBridge + ipcRenderer.invoke/on)
┌──────────────┴────────────────────────────────────────────────┐
│  Renderer (React UI) — sidebar, conversations, threads,        │
│  search, settings, onboarding. No Node access.                 │
└───────────────────────────────────────────────────────────────┘
```

### 3.3 Renderer ↔ main: use **IPC**, not a local HTTP server

**Decision: use typed IPC.** The renderer MUST run with `contextIsolation: true`,
`nodeIntegration: false`, and `sandbox: true`, talking to the main process through a preload bridge:

```ts
// preload.ts
contextBridge.exposeInMainWorld('api', {
  listConversations: () => ipcRenderer.invoke('conversations:list'),
  getMessages: (q: GetMessagesQuery) => ipcRenderer.invoke('messages:get', q),
  search: (p: SearchParams) => ipcRenderer.invoke('search', p),
  startSync: () => ipcRenderer.invoke('sync:start'),
  onSyncProgress: (cb: (p: SyncProgress) => void) => {
    const h = (_: unknown, p: SyncProgress) => cb(p)
    ipcRenderer.on('sync:progress', h)
    return () => ipcRenderer.off('sync:progress', h)
  },
  // …
})
```

> **As built:** the bridge is `window.archive` with two functions instead of one per method:
> `call(method, arg)` and `on(event, callback)`. Method and event names are whitelisted in
> `src/shared/ipc.ts` (`ArchiveApi`, `ArchiveEvents`), where a compile-time check keeps the list
> and the interface in step; the renderer wraps `call` in a typed client. Each method uses the
> channel `archive:<method>` and returns `{ ok: true, value }` or
> `{ ok: false, error: { code, message } }`, so errors cross IPC as a code (`invalid`, `not_found`,
> `conflict`, `blocked`, `signed_out`, `internal`) plus a plain-language message, never a stack.
> Handlers refuse calls from any frame other than the app's own page.

Why not a local HTTP server: it opens a port any process (or any web page, via DNS rebinding and
CSRF tricks) on the machine can reach, and it forces you to reinvent CSRF/origin/Host defences. IPC
has no port, no origin, no CSRF surface. Keep the app closed.

> **If the repo is seeded with the existing local-web implementation** (Appendix D), its API is an
> HTTP layer. Port it by replacing the Hono route handlers with IPC handlers that call the *same*
> service functions, and replacing the renderer's `fetch` calls with `window.api.*`. The database,
> sync, import, search and rendering layers transfer unchanged.

Renderer routing: use a **hash router** or memory router (the app is loaded from `file://` in
production, so a browser history router will break).

### 3.4 Where data lives

Use Electron's `app.getPath('userData')`, which resolves per-OS:

| OS | Path |
|---|---|
| macOS | `~/Library/Application Support/Slamem/` |
| Windows | `C:\Users\<name>\AppData\Roaming\Slamem\` |

```
<userData>/
  archive.db            SQLite database (messages, users, channels, FTS index)
  archive.db-wal        WAL journal
  files/<fileId>/<name> downloaded attachments
  files/<fileId>/thumb.<ext>
  logs/main.log         rotating app log (NEVER contains credentials)
  config.json           non-secret preferences
  credentials.bin       the Slack session, encrypted with safeStorage (§3.5)
  tmp/                  partial downloads before their atomic rename
```

Secrets are **not** stored here in plaintext — see §3.5.

As built, `--data-dir=<path>` or `SLA_MEM_DATA_DIR` points the app at another folder (demo
data, tests, a second account's archive). Unpackaged development builds default to
`Slamem (dev)` so they never touch a real archive.

Show this folder path in Settings with a **"Show in Finder / Show in Explorer"** button
(`shell.showItemInFolder`), so users can back it up.

### 3.5 Credential storage — use Electron `safeStorage`

Electron's `safeStorage` API encrypts with an OS-provided key: **Keychain on macOS**, **DPAPI on
Windows**. It is the correct cross-platform answer and avoids shelling out to `security` or
PowerShell.

```ts
import { safeStorage, app } from 'electron'
import fs from 'node:fs'

function saveCredentials(creds: { token: string; cookie: string; teamId: string }) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('OS secure storage unavailable')
  const buf = safeStorage.encryptString(JSON.stringify(creds))
  fs.writeFileSync(credsPath, buf, { mode: 0o600 })
}
function loadCredentials() {
  if (!fs.existsSync(credsPath)) return null
  return JSON.parse(safeStorage.decryptString(fs.readFileSync(credsPath)))
}
```

Rules (**MUST**):
- Credentials never appear in logs, error messages, IPC payloads to the renderer, crash reports, or
  the database. Add a redaction helper that strips `xox[a-z]-…` patterns from everything logged.
- The renderer never receives the token or cookie — only connection *status* (team name, user name,
  connected/expired).
- On "Disconnect": delete the credential file **and** clear the `persist:slack` session partition
  (`session.fromPartition('persist:slack').clearStorageData()`). The archive itself stays.

### 3.6 Security posture

- No open ports. No server. No remote access.
- The Slack sign-in window loads only `*.slack.com` (and the SSO providers Slack redirects to);
  it is a normal browsing window and must **not** have Node integration.
- The main window loads local files only; set a strict CSP; open external links with
  `shell.openExternal` after validating the URL is `http(s)`/`mailto`.
- Attachments are untrusted content. Never render downloaded HTML/SVG in the app; offer "open with
  system app" / "reveal in folder" instead. Images and PDFs may be displayed inline.
- Message text is untrusted: render it through a parser into React nodes. **Never**
  `dangerouslySetInnerHTML`.

As built:
- Archived attachments reach the renderer through a privileged `archive://file/<id>` /
  `archive://thumb/<id>` protocol, not `file://`. It serves only raster images, video and audio,
  with `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox`, supports Range
  requests, and refuses any path that resolves outside the files folder. Everything else (PDFs
  included) opens in the system app; runnable files are only revealed in the folder.
- The CSP is a `<meta>` tag injected at build time: scripts from the app only; images from the
  app, `archive:`, `data:`/`blob:` and Slack's avatar/emoji CDNs.
- The packaged app sets Electron fuses: cookie encryption on; `RunAsNode`, `NODE_OPTIONS` and
  `--inspect` off; asar integrity checked; the app only loads from its asar.
- The sign-in window accepts any `https` page, because the SSO provider a workspace redirects to
  can't be known in advance (Google, Okta, Microsoft…). It stays an ordinary browsing window:
  sandboxed, no Node, no preload, every permission request refused, no downloads, and other
  schemes (such as `slack://`) ignored.
- The Slack endpoints can be pointed at the mock server (`SLA_MEM_SLACK_API` /
  `SLA_MEM_SLACK_WEB`) only in unpackaged builds, so a stray environment variable can never
  send a user's session anywhere else.

---

## 4. Data model

SQLite with `journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=5000`, `synchronous=NORMAL`.
Versioned migrations via `PRAGMA user_version`. Full DDL in **Appendix B**. Summary:

| Table | Holds |
|---|---|
| `meta` | key/value: `team_id`, `team_name`, `team_domain`, `self_user_id`, schema bookkeeping |
| `users` | id, handle, real/display name, avatar URL, is_bot, deleted, raw JSON |
| `conversations` | id, type (`channel`/`private_channel`/`im`/`mpim`), name, dm_user_id, archived, topic, purpose, members, raw |
| `messages` | **the core table** — see below |
| `messages_fts` | FTS5 external-content index over `messages.plain_text` |
| `message_revisions` | previous versions of edited messages (the archive keeps edit history) |
| `files` | file metadata + local path + download status |
| `message_files` | join table (conversation_id, ts, file_id) |
| `custom_emoji` | workspace emoji name → URL |
| `sync_state` | per conversation: latest_ts, oldest_ts, backfill_complete, last_synced_at, last_error |
| `runs` | sync run history: kind, status, timings, stats JSON, log, problem kind, pid |
| `bots` | *(as built)* apps and integrations that post with only a `bot_id`, so `from:<app>` works |
| `conversation_stats` | *(as built)* per conversation: message count and date range, kept by triggers |

`messages` key columns: `conversation_id`, `ts` (unique together), `time` (unix seconds),
`thread_ts`, `is_reply`, `user_id`, `bot_id`, `username`, `subtype`, `text` (raw mrkdwn),
`plain_text` (normalised, indexed), `reply_count`, `latest_reply`, `reply_users`, `edited_ts`,
`has_files`, `has_links`, `has_images`, `reactions` (JSON), `is_deleted`, `raw` (full JSON),
`source`, `first_seen_at`, `updated_at`.

Design notes worth keeping:
- Store the **full raw JSON** of every message. Disk is cheap (§10) and it makes future features
  possible without re-syncing.
- `plain_text` is a search-normalised rendering: mentions resolved to names (`<@U123>` → `@roman`),
  channels to `#name`, links to `label url`, entities unescaped, emoji shortcodes preserved as
  words, plus attachment text and file names appended. **This is what users actually search.**
- Keep an FTS5 **external-content** table with triggers on insert/update/delete so the index never
  drifts.
- `message_revisions` gives you "(edited)" history — a genuinely nice archive feature.
- *(As built)* `messages.id` is the message's `ts` in microseconds, bumped by one on the rare
  cross-conversation collision. Row order is therefore chronological, which lets date filters
  become FTS rowid ranges and makes `id` a free tie-breaker in every time-ordered index.
- *(As built)* `meta.search_text_version` records which normalisation built `plain_text`. When an
  upgrade changes it, the app rebuilds the search text in the background, in batches, resuming
  after a quit.

---

## 5. Sync engine

### 5.1 The prime directive

> **The archive MUST never lose or degrade data it has already stored.**

Slack will stop returning old messages, will return tombstones for deleted ones, and will return
stub file records. None of these may destroy what is already archived. Every write path must be
written with this in mind, and it must be tested explicitly (§13).

### 5.2 Run shape

A sync run:
1. `auth.test` → store `team_id`, `team_name`, `team_domain`, `self_user_id` in `meta`. On
   `invalid_auth` / `token_revoked` / `account_inactive`: mark the connection **expired**, stop, and
   surface "Slack needs you to sign in again" in the UI. Do not treat as a crash.
2. `users.list` (paginated) → upsert users.
3. `users.conversations` (paginated) → upsert conversations.
4. For each conversation (report progress per conversation):
   - **First sync (no `latest_ts`)**: page `conversations.history` backwards to the end. On Free
     this ends at ~90 days; record `backfill_complete`.
   - **Incremental**: `conversations.history` with `oldest = latest_ts − overlap`, `inclusive=true`.
     **Use a generous overlap — 3 days is too short** (see §12, finding *thread-reply edits*).
     Recommended default: **7 days**, configurable.
   - **Upsert each page as it arrives** so an interrupted run keeps its progress.
   - **Threads**: for every fetched parent with `reply_count > 0` whose stored thread info differs
     (different `latest_reply`, different `reply_count`, or fewer stored replies than `reply_count`),
     call `conversations.replies` and upsert all pages. Remember it returns the **parent first on
     every page** — de-duplicate.
   - **Active-thread recheck**: threads whose `latest_reply` is within the last N days (default 21)
     but whose parent fell outside the history window still receive new replies. Re-poll those with
     `conversations.replies` (`oldest = stored latest_reply`).
   - Per-conversation errors (`not_in_channel`, `channel_not_found`, `missing_scope`) are recorded
     in `sync_state.last_error`; **the run continues**. Only auth errors abort the whole run.
   - *(As built)* **Every conversation is read on every sync.** Reading one costs at least one
     paced `conversations.history` call (about 2 minutes for 111 conversations), and the documented
     Web API has no call that says which conversations changed. 0.2.x skipped unchanged ones with
     the Slack app's own unread summary (`client.counts`); it isn't part of the documented API, so
     it was taken out: Slamem uses only published Web API methods.
   - *(As built)* **Quiet threads.** An active thread (reply within 21 days) whose parent is older
     than the history window used to cost one `conversations.replies` call every sync. When its
     latest reply is older than the overlap, history is instead read back to its parent if that
     costs fewer calls (estimated from the archived messages): the parent's `reply_count` and
     `latest_reply` show whether the thread changed, and only changed threads are fetched.
     Threads with a reply inside the overlap are still polled, so an edit to that reply is seen.
5. `emoji.list` → upsert custom emoji (ignore failures).
6. Download pending files (§5.6), subject to the user's attachment policy.
7. Write run stats: conversations, messagesInserted, messagesUpdated, revisions, threadsFetched,
   filesDownloaded/Failed/Skipped, apiCalls, errors.

Everything honours an `AbortSignal` so "Cancel" is instant and keeps what is already committed.

### 5.3 Scheduling

- Default: sync **every hour** while the app is running, plus once ~10 s after launch if the last
  successful sync is older than the interval.
- Settings offer: Manual only / 15 min / 1 hour / 6 hours / Daily.
- Only one run at a time. A second request returns "already running".
- **Because the Free plan window is 90 days, a user who doesn't open the app for 3 months loses
  that period permanently.** Therefore: launch at login (opt-in during onboarding, default **on**),
  run in the tray, and warn in the UI when the last sync is more than 30 days old.
- *(As built)* A launch at login starts hidden in the tray. Electron 44 removed `openAsHidden`,
  so the app registers a plain login item and checks `wasOpenedAtLogin` on macOS (and a
  `--hidden` argument on Windows).

### 5.4 Incremental correctness

Edits and reactions to messages **older than the overlap window are not detected**. This is inherent
to polling `conversations.history`. Mitigations:
- Generous overlap (7 days default).
- Active-thread recheck (above).
- Accept the rest: an edit to a 2-month-old message may be missed. Document it; don't pretend
  otherwise.
- *(As built)* A quiet thread (latest reply older than the overlap) re-checked through its parent
  (§5.2) notices new replies, but not an edit to an earlier reply; a thread with a recent reply is
  still polled, which catches an edit to that reply.

### 5.5 Merge policy — the rules that protect the archive

Upsert is keyed by `(conversation_id, ts)` and runs inside a transaction per batch.

**MUST** rules:
1. **Never delete message rows** during sync.
2. Normally the incoming version wins for `text`, `edited_ts`, `reactions`, reply fields, `raw`.
3. **Tombstones**: if the incoming message is a deletion tombstone (`subtype: 'tombstone'`, or the
   canonical "This message was deleted." body), **keep the stored text/raw/files** and set
   `is_deleted = 1`. The UI shows a "deleted in Slack" badge. The archive remembers.
4. **Edits**: if incoming `text` differs from stored `text` and neither is empty, write the **old**
   version into `message_revisions` before updating.
5. **Never blank out content**: an incoming copy with empty text MUST NOT overwrite stored non-empty
   text unless it carries a newer `edited.ts`.
6. `reply_count` / `latest_reply` never regress — take the max / later value.
7. `first_seen_at` is preserved forever.
8. Sparse copies must not null out `user_id` / `bot_id` / `username`; `has_files`, `has_images` and
   `is_deleted` are sticky.

### 5.6 Files

- Download `url_private_download || url_private` with the auth headers from §2.2. Write to a temp
  file and **rename atomically** into `files/<fileId>/<sanitised name>`.
- Also fetch the best available thumbnail (`thumb_720|480|360`, `thumb_pdf`, `thumb_video`) for fast
  grid rendering.
- **Stub protection (MUST):** a file object with `mode` of `hidden_by_limit` / `tombstone`, or one
  lacking both `url_private` and `name`, MUST NOT overwrite an existing good record. Insert it only
  if absent, with status `unavailable`. Never reset a `done` download to `pending` unless the local
  file is actually missing.
- `mode: 'external'` / `is_external` (Google Drive links etc.) → `unavailable`, keep the permalink.
- **Retry policy**: files that failed MUST become eligible again later (with backoff), and files
  skipped because they exceeded the size cap MUST be retried if the user raises the cap. (A previous
  implementation permanently stranded them — see §12.)
- **Detect Slack's HTML login page** being returned instead of a file (content-type `text/html`
  when a binary was expected) → mark `failed`, likely an expired session.
- **Redirects**: Slack redirects file downloads. Follow redirects, but **strip `Authorization` and
  `Cookie` when the redirect leaves `*.slack.com` / `*.slack-edge.com`.**
- **Filename sanitisation MUST be Windows-safe**: strip `<>:"/\|?*` and control characters, trim
  trailing dots/spaces, reject reserved names (`CON`, `PRN`, `AUX`, `NUL`, `COM1-9`, `LPT1-9`), cap
  length (~150 chars), and never allow `..` or path separators.

As built:
- Retry backoff after the n-th failure is `min(2^(n−1) hours, 7 days)`. A file that still fails
  definitively more than 90 days after upload is marked `unavailable` (Slack Free has hidden it).
- A download whose size differs from the size Slack reported, or that is empty, is refused
  (pitfall 5). Reserved Windows names are kept readable with a `_` prefix.
- `skip_reason` records why a file was skipped (`policy`, `too_large`, `removed`). Skipped files
  are weighed against the current attachment setting on every run, and raising the setting starts
  a download run straight away. A skipped file still gets its thumbnail unless attachments are off.

### 5.7 One archive = one Slack identity

Bind the archive to a single `team_id` + `self_user_id` (stored in `meta`). If a sign-in produces a
different team or user, refuse with a clear message ("This archive belongs to Roman at 9H. To
archive a different account, use a different archive folder."). Otherwise two people's data merges
into one database and the isolation guarantee is gone.

---

## 6. Search

FTS5 over `messages.plain_text`, external-content, `tokenize='unicode61 remove_diacritics 2'`.

### 6.1 Query language (Slack-like, because users already know it)

```
deploy                          bare words (prefix-matched)
"exact phrase"                  quoted phrase
-staging                        exclusion
from:@priya   from:me           author
in:#engineering   in:@priya     channel or DM
before:2026-06-01  after:2026-01-01  on:2026-03-14  during:2026-03
has:file  has:link  has:image  has:reaction  is:thread
```
Combined filters are ANDed. Dates are interpreted in **local time**; `after` inclusive, `before`
exclusive, `on:D` = `[D, D+1)`.

*As built:* an exclusion is prefix-matched exactly like a bare word (`-stag` excludes "staging"),
and a quoted exclusion (`-"exact phrase"`) excludes that phrase (pitfall 13). Chinese and Japanese
have no spaces between words and the `unicode61` tokenizer can't split them, so runs of Han,
Hiragana and Katakana are indexed and queried one character per token: a search for 会议 finds it
inside a sentence (as a phrase), and snippets are shown without the inserted spaces. Korean is
space-separated and needs nothing special.

### 6.2 Implementation requirements

- **FTS injection safety (MUST):** never interpolate raw user input into `MATCH`. Every word becomes
  a quoted string literal with embedded `"` doubled, then `*` for prefix matching (`"foo"*`).
  Phrases are quoted without `*`. Exclusions use `NOT`. Strip control characters — **a NUL byte in
  the query crashed a previous implementation with `unterminated string`.**
- `from:me` / `in:@me` MUST resolve to the archive's own user (`meta.self_user_id`), **not** to a
  user whose name happens to start with "me".
- `from:<a bot or app>` MUST also match messages that carry only `bot_id`/`username`, not just
  `user_id`.
- Ranking: `bm25()` plus a mild recency tie-break; also offer Newest / Oldest sorts.
- Snippets via FTS5 `snippet()` with sentinel markers (e.g. `\u0002`/`\u0003`) that the UI renders
  as `<mark>` **as React nodes**, never as HTML. Cap snippet length. Don't split surrogate pairs.
- Filter-only queries (no text) are valid: a filtered listing that skips FTS entirely.
- Emoji shortcodes in snippets should render as emoji, not raw `:warning:`.
- Unresolvable modifiers (`from:@nobody`) MUST be reported to the user, not silently ignored.

### 6.3 Performance

Measured on the previous implementation at 300k messages: typical searches 1–25 ms; pathological
2-letter prefixes matching 177k rows ~180 ms. Targets: **< 50 ms typical, < 300 ms worst case** at
500k messages. Add partial indexes for `has:` filters and for the top-level message listing.

*As built,* measured with `npm run bench -- --messages 500000` (488k messages, Apple M-series):
typical searches 0.2–31 ms median (the slowest is `is:thread design`); worst-case one- and
two-letter prefixes 55–234 ms median. Two things made the difference: combined filters are served
by covering indexes, and a text query with filters evaluates the filters once (a materialised CTE
gives both the page and the total) instead of once for the count and again for the page.

---

## 7. Message rendering (Slack mrkdwn)

Slack's format is **not** Markdown. Implement a parser → AST → React renderer.

Must support:
- Entities `&lt; &gt; &amp;` unescaped **exactly once**.
- `*bold*`, `_italic_`, `~strike~` with Slack's word-boundary rules (`snake_case_word` and `2*3*4`
  are **not** formatted), and nesting.
- `` `code` `` and ```` ``` ```` blocks (no formatting inside, newlines preserved).
- Blockquotes: `>` lines, the `&gt;` form, and `>>>` (rest of message).
- Mentions: `<@U123>`, `<@U123|name>`, `<#C123|name>`, `<#C123>`, `<!here>`, `<!channel>`,
  `<!everyone>`, `<!subteam^S123|@team>`, and `<!date^1712345678^{date_short}|fallback>` (render the
  fallback; support `{date_num} {date_short} {date_long} {date_pretty} {time} {time_secs} {ago}`).
- Links `<https://…|label>`, `<https://…>`, `<mailto:…|label>`, plus bare-URL autolinking (careful
  with trailing punctuation and parentheses).
- `:emoji:` shortcodes including skin tones (`:+1::skin-tone-3:`) and **custom workspace emoji**
  (including aliases like `yay → alias:tada`). Use the `emoji-datasource` dataset (iamcal), which is
  what Slack itself uses.
- Emoji-only messages render "jumbo".
- **Links MUST open externally** via `shell.openExternal`, only for `http(s)`/`mailto`. Everything
  else renders as plain text.

**Block Kit:** modern Slack messages carry a `blocks` array; bot/app messages often have *only*
blocks with a short fallback `text`. Render `rich_text` blocks (sections, lists, quotes, preformatted,
styles, links, user/channel/emoji elements) and `section`/`header`/`context`/`fields`, and include
their text in `plain_text` so it is searchable. A previous implementation showed only the fallback —
app notifications were effectively unreadable and unsearchable. Also render legacy `attachments`
(unfurl cards with colour bar, title, text, image, footer).

---

## 8. UX specification (written for non-technical users)

### 8.1 First run / onboarding

A short, friendly, 3-screen flow. No jargon. No settings required.

1. **Welcome** — "Slamem keeps a private copy of your Slack history on this computer, so you
   can still read and search it after Slack hides it. Your data never leaves your machine."
2. **Connect Slack** — one big button. Explain in one line: "You'll sign in to Slack in a window,
   just like in your browser." Recommend the **email code** option (§2.4). Handle: multiple
   workspaces → picker; cancel; failure → plain-language retry with the alternative methods.
3. **Getting your history** — the first sync runs with a real progress bar ("Fetching #general —
   1,240 messages so far"). Explain once: "Slack only lets us see the last 90 days. From now on,
   everything we fetch is kept forever." Offer the "Start Slamem when I log in" checkbox
   (default **on**) and finish.

### 8.2 Main window

Familiar to anyone who has used Slack, but clearly a *reader*:

- **Sidebar**: workspace name; a search box (⌘K / Ctrl+K); Channels, Direct messages, Group DMs, each
  collapsible with a filter box; message counts; archived channels dimmed. *(As built: Overview
  and a Search item that opens the search screen instead of a box in the sidebar, then one filter
  box for all the conversations, with a clear button while it holds text; see §0.3.)*
- **Conversation view**: day dividers (sticky, opaque — must not overlap message content),
  consecutive messages from the same author within 5 minutes grouped, avatars, timestamps with full
  date on hover, "(edited)" with a revisions popover, "deleted in Slack" badge, reactions with
  hover names, attachments (image grid + lightbox; file cards with icon/size/open/reveal; a clear
  "not archived" state for stubs), unfurl cards, and thread summaries ("6 replies · last reply
  today") opening a thread panel. *(As built: the header gives the conversation's total and date
  range and, set apart, how many of its messages Slack no longer shows, and from when to when;
  see §0.3.)*
- **Infinite scroll both directions** with correct scroll anchoring when prepending older messages,
  a "jump to date" control, and deep links to a specific message (highlight it briefly).
- **Search page**: the query box with hints/autocomplete for `from:`/`in:`/`has:`, editable filter
  chips, sort control, results with conversation + author + date + highlighted snippet, grouped or
  flat, "load more", and click-through to the message in context.
- *(As built: an **Ask AI** place under Search, a chat with Claude over the archive; see §0.3.)*
- **Archive home**: how many messages/conversations/files, the date range covered, how much disk is
  used, when the last sync ran, a **Sync now** button, and prominently: **"N messages older than 90
  days — no longer visible in Slack"**, which is the payoff. *(As built: called **Overview**; when a
  few old messages reach much further back than the rest, the range starts where the steady
  history does and names them; see §0.3.)*

### 8.3 Tray / background

- Tray icon with: Open Slamem, Sync now, Last synced <time>, Settings, Quit.
- Closing the window **hides** to the tray (it keeps syncing); Quit actually exits. On macOS follow
  the usual dock behaviour.
- A subtle badge/indicator while syncing.

### 8.4 Settings (deliberately small)

- **Slack connection**: workspace + account, "Reconnect", "Disconnect" (with a confirm that says
  clearly: *your archive stays, only the Slack login is removed*).
- **Sync**: how often (Manual / 15 min / Hourly / 6 hours / Daily); "Start at login".
  *(As built: "Start at login" and the menu bar icon are in a separate **App** card.)*
- **Attachments**: `None` / `Images & documents up to 25 MB` (**default**) / `Everything up to 200 MB`
  — see §10.4 for why.
- **Storage**: disk used, broken down (messages vs attachments), "Show folder", "Delete downloaded
  attachments older than…", and a **Back up now** action that zips the archive to a chosen folder.
- **About**: version, check for updates, link to the guide.
- *(As built: an **Ask AI** card: the Anthropic API key, the model, and what is sent to Anthropic.)*

### 8.5 Error messages — plain language, always with an action

| Condition | What the user sees |
|---|---|
| `invalid_auth` / expired session | "Slack signed you out. **Reconnect** to keep archiving." + button |
| Offline / network failure | "Can't reach Slack right now. We'll try again automatically." |
| 429 rate limited | (silent — handled internally; progress just slows) |
| Disk full | "Your disk is full, so new messages can't be saved. Free up space and we'll continue." |
| Attachment failed | Inline on the file: "Couldn't download — retry" |
| Crash / unexpected | "Something went wrong. Nothing was lost. **Try again** or **Show logs**." |

**Never** show `invalid_auth`, stack traces, HTTP codes, or the words "token", "cookie", "xoxc".

---

## 9. Packaging, distribution and updates

### 9.1 Targets

| OS | Artefacts | Arch |
|---|---|---|
| macOS | `.dmg` (drag to Applications) + `.zip` (for updates) | **arm64 and x64** (or a universal build) |
| Windows | **NSIS installer** `.exe` | x64 |

Build with **electron-builder**. Rebuild native modules for Electron's ABI (`better-sqlite3`):
electron-builder does this automatically via `npmRebuild`; verify the binary loads in a packaged
build, not just in dev — this is a classic late-stage failure.

*As built:* `better-sqlite3` 13 is a Node-API module that ships prebuilt binaries for every
platform, so there is nothing to rebuild (`npmRebuild: false`); the packaging config keeps only
the target platform's binary. Verified by opening the database from the packaged macOS app.

### 9.2 App identity

- App name: **Slamem** · appId `com.9h.sla-mem` (kept from the old name, see §0.3) · a proper icon set
  (`.icns`, `.ico`, tray icons @1x/@2x, and a light/dark-appropriate tray template image on macOS).
- Keep the name/icon clearly distinct from Slack's own branding to avoid implying affiliation.
- *As built:* `build/icon.icns` and `build/icon.png` (electron-builder makes the Windows `.ico`
  from the PNG), plus tray icons in `resources/tray/`. All are drawn by `npm run icons`.

### 9.3 CI (recommended)

GitHub Actions: build on `macos-latest` (arm64 + x64) and `windows-latest` on tag push, attach the
artefacts to a **GitHub Release**. This avoids needing a Windows machine to ship Windows builds.

*As built:* `ci.yml` runs typecheck, lint and tests on Ubuntu and Windows for every push;
`release.yml` builds on a `v*` tag (or by hand) and uploads to a **draft** release, so the owner
can write the notes before publishing.

### 9.4 Unsigned distribution (the accepted trade-off)

The app ships **unsigned**. Consequences, which colleagues must be walked through **once**:

- **macOS**: Gatekeeper refuses the first launch ("cannot be opened because the developer cannot be
  verified"). The user must go to **System Settings → Privacy & Security**, find the blocked app,
  and click **Open Anyway**, then confirm. (Right-click → Open also works on some versions.)
- **Windows**: SmartScreen shows "Windows protected your PC" → **More info → Run anyway**. Some
  antivirus may also flag an unsigned Electron binary.

*As built:* macOS builds are **ad-hoc signed** (`identity: '-'`). That is not a Developer ID, so
Gatekeeper still blocks the first launch, but Apple Silicon refuses to run code with no signature
at all. The first time the app reads its saved sign-in, macOS may ask whether it can use the
keychain; the guide tells users to click **Always Allow**.

Write these as a short illustrated guide — **Appendix E is a ready-to-send draft**. Put it in the
repo README and link it from the release notes. Recommendation: revisit signing (Apple Developer
Program ~$99/yr; Windows OV cert ~$200–400/yr) once the app is proven; it removes all of this.

### 9.5 Updates — ⚠️ read this before choosing an approach

Plan: **GitHub Releases** as the distribution point (free; public repo required for
token-less access — see below).

**The catch:** `electron-updater`'s silent auto-update on **macOS requires the app to be
code-signed** (Squirrel.Mac validates the signature before swapping the bundle). An unsigned macOS
build **cannot** silently auto-update. On **Windows**, NSIS-based auto-update does work unsigned.

Therefore:

- **Baseline (implement this in Stage 7): an in-app update *check* with guided manual update.**
  On launch and daily, call the GitHub Releases API
  (`https://api.github.com/repos/<owner>/<repo>/releases/latest`), compare `tag_name` with
  `app.getVersion()`, and if newer show a non-intrusive banner: *"Version 1.2 is available —
  What's new · Download"*. The Download button opens the correct asset for the user's OS via
  `shell.openExternal`. Then a one-line instruction ("drag it to Applications, replacing the old
  one" / "run the installer"). **This works unsigned on both platforms.**
- **Optional enhancement**: enable `electron-updater` silent updates **on Windows only**, keeping
  the manual path on macOS. Do this only after the baseline works.
- If the code repository must stay private, either make a **separate public repo just for releases**
  or keep updates manual — embedding a GitHub token in a shipped app is not acceptable.

Versioning: semver, `tag_name` = `v<version>`, and always publish release notes written for
non-technical readers ("Fixes search sometimes missing recent messages").

*As built:* the checker runs 30 s after launch, then daily, and on demand from Settings → About.
It reads `romanbitca/sla-mem`, public since 2026-09-22 (§0.3); were it private again, publish
releases from a public repository and point `UPDATE_REPO` (`src/main/context.ts`) and `publish`
(`electron-builder.yml`) at it.

On top of the check, **Update and restart** installs the new version on both platforms without
Squirrel or electron-updater (`src/main/update-install.ts`, `update-service.ts`):

1. It downloads the release's package for this computer: the macOS `.zip` for this chip (never the
   other chip's), or the Windows installer. The file must come from GitHub and match the size and
   SHA-256 GitHub lists for every release file (the API's `digest`); a release file without one is
   never installed.
2. macOS: `ditto` unpacks the app, which must be this app (bundle id) at the expected version with
   an intact signature (`codesign --verify --deep --strict`).
3. A sync, attachment download or import that is under way finishes first (no new one starts);
   then the app quits the normal way.
4. As it exits it hands over. macOS: a small script waits for the process to end, moves the old
   app aside, moves the new one into its place (putting the old one back if that fails)
   and opens whichever is there with `open -n`, with the same `--data-dir`. Windows: the NSIS
   installer runs with `--updated /S --force-run`, as electron-updater does: it waits for the app
   to exit, installs silently and starts it.
5. The next start compares its version with a note written before the restart: the log says
   "Updated to X (from Y)", or the banner says the update couldn't be installed and offers Try
   again and Download.

Downloaded by the app itself, the new macOS app carries no quarantine flag, so Gatekeeper doesn't
stop it again. macOS may ask once for the keychain (ad-hoc signing gives every build a new
identity; a signing certificate, even a self-made one, would end that). Where the app can't replace
itself (a development build, straight from the disk image or App Translocation, a folder it may not
change, a Windows copy not installed by the installer), the banner keeps Download and the
one-line instruction. Verified on 2026-09-22 with a packaged build in /Applications, also flagged
like a browser download allowed with Open Anyway: about 8 s from the click to the new version
running (download and checks 5 s, restart 2 s). The Windows path is covered by unit tests; a real
Windows update still needs a person (docs/STATUS.md).

---

## 10. Storage: how big will this get?

### 10.1 Measured baseline (real numbers, not estimates)

From the previous implementation's demo archive:

| Metric | Value |
|---|---|
| Messages | 9,260 |
| Database size | 12.83 MB |
| **Bytes per message** | **≈ 1,385 B** |
| Avg raw message JSON | 540 B |
| Avg message text | 52 chars |

Breakdown: message rows **71%**, indexes **20%**, FTS index **7%**.

### 10.2 Adjusting to real Slack

The demo's messages are simpler than real ones. Real Slack messages include a `blocks` array
(rich text), `team`, `client_msg_id`, edit metadata, reactions and richer profiles — real raw JSON
averages **≈ 1,000–1,400 B** rather than 540 B, and real text runs longer.

**Budget ≈ 2–2.5 KB per message.** The table below uses **2.2 KB**.

### 10.3 Projections — **messages only, no attachments**

| Messages | Database on disk |
|---|---|
| 10,000 | ~22 MB |
| 25,000 | ~55 MB |
| 50,000 | ~110 MB |
| 100,000 | ~220 MB |
| 250,000 | ~550 MB |
| 500,000 | ~1.1 GB |

How fast do messages accumulate for one person? Counting everything visible in their own view
(channels + DMs):

| Usage | Messages/day | First sync (90 days) | Per year | After 5 years |
|---|---|---|---|---|
| Light | ~50 | ~4,500 (~10 MB) | ~18,000 (~40 MB) | ~90,000 (~200 MB) |
| Typical | ~150 | ~13,500 (~30 MB) | ~55,000 (~120 MB) | ~275,000 (~600 MB) |
| Heavy | ~350 | ~31,500 (~70 MB) | ~128,000 (~280 MB) | ~640,000 (~1.4 GB) |

**Conclusion: text is essentially free.** Even a heavy user after five years is around a gigabyte —
less than a couple of video files. There is no reason to ever discard message text.

### 10.4 Attachments — this is what actually consumes disk

Assume **2–8% of messages carry a file** (higher at a design agency; use **5%**), and:

| File type | Typical size |
|---|---|
| Screenshot (retina PNG) | 300 KB – 3 MB |
| Photo / image | 1 – 6 MB |
| PDF / document | 0.5 – 8 MB |
| Design export | 2 – 25 MB |
| Screen recording / video | 10 – 200 MB |

Weighted average: **≈ 0.8 MB** excluding video; **≈ 2.5 MB** including video. Thumbnails add ~10%.

**For 100,000 archived messages (≈ 5,000 files):**

| Attachment policy | Attachments | **Total archive** |
|---|---|---|
| **None** (text only) | 0 | **≈ 220 MB** |
| **Images & documents ≤ 25 MB** (recommended default) | ≈ 4 GB | **≈ 4.2 GB** |
| **Everything ≤ 200 MB** | ≈ 12.5 GB | **≈ 12.7 GB** |

Scaled to a **typical user after 5 years** (≈ 275,000 messages, ≈ 13,750 files):

| Policy | **Total** |
|---|---|
| None | ≈ 0.6 GB |
| Images & docs ≤ 25 MB | ≈ 11 GB |
| Everything | ≈ 35 GB |

**Attachments are roughly 20–60× the size of the text.** They are also where a lot of the value
lives (screenshots and design files are often *the* context). Hence the recommended middle policy.

### 10.5 Recommendations

- **Default: "Images & documents up to 25 MB."** Keeps the valuable stuff, excludes the runaway
  video files. Make it changeable in one click.
- Show **current disk usage with a messages/attachments split** in Settings, plus "Delete downloaded
  attachments older than N months" (messages are never deleted).
- Warn when the archive folder passes a threshold (e.g. 20 GB) or when the disk is nearly full.
- Note in the UI that skipped attachments can be downloaded later by raising the limit — **as long
  as they are still within Slack's 90-day window** (afterwards they are gone from Slack forever, so
  err on the side of downloading).

### 10.6 Other disk costs

| Item | Size |
|---|---|
| Installed app (Electron) | **≈ 200–250 MB** per machine |
| Download (dmg/exe) | ≈ 90–130 MB |
| Slack sign-in session partition | a few MB |
| Logs | cap at ~10 MB with rotation |

---

## 11. Staged build plan

Each stage ends with working, tested software. **Do not skip the acceptance criteria.**

---

### Stage 1 — Skeleton, storage core, and search

**Goal:** an Electron app that opens a window, with a working local database and search over
synthetic data.

**Build:**
- Repo, TypeScript (strict), electron-vite, ESLint/Prettier, Vitest.
- Electron main + preload + React renderer; `contextIsolation: true`, `nodeIntegration: false`,
  `sandbox: true`; hash/memory router; Tailwind v4; basic app shell (sidebar + content areas).
- SQLite layer: `better-sqlite3`, pragmas, versioned migrations, **full schema from Appendix B**,
  FTS5 external-content table + triggers, prepared-statement caching.
- Repository functions: upsert users/conversations/messages/files, read conversations, paged message
  reads (`before` / `after` / `around` / latest, with **exact** `hasMore` flags), threads, revisions,
  stats.
- `plain_text` normalisation (§4) and Block Kit → text extraction.
- Search: query parser (§6.1), safe FTS expression builder (§6.2), executor with filters, sorts,
  snippets, pagination.
- A dev-only seed script that generates a realistic synthetic archive (~10k messages, threads,
  reactions, edits, files, bot messages) so the UI can be built and perf measured without Slack.

**Acceptance:**
- App launches on macOS and Windows (dev mode).
- `npm test` green, including: migrations idempotent; paging `hasMore` exactness; FTS stays in sync
  after updates; **search-injection attempts** (`foo" OR "bar`, `NEAR(`, `*`, `^`, NUL bytes,
  unbalanced quotes) neither crash nor leak.
- Seeded 300k-message database: conversation list < 10 ms, message page < 50 ms, typical search
  < 50 ms.

---

### Stage 2 — Slack sign-in and credential storage ⚠️ highest risk, do it early

**Goal:** a real user can connect their real Slack account from inside the app.

**Build:**
- The Slack sign-in `BrowserWindow` with a **persistent partition**, Chrome-like user agent, and the
  credential polling loop from §2.3.
- Workspace picker when several teams are present; cancel; timeout; window-closed handling.
- Validation via `auth.test`; store `team_id`/`team_name`/`team_domain`/`self_user_id`.
- Identity binding (§5.7).
- `safeStorage` credential storage (§3.5) + Disconnect (clears credentials **and** the session
  partition; archive untouched).
- Connection status surfaced to the renderer (never the secrets).
- Fallbacks: **email-code sign-in guidance** in the UI, and an "Advanced → paste session cookie"
  path with `deriveTokenFromCookie`.
- Redaction helper applied to all logging.

**Acceptance:**
- **A real sign-in to the real 9H workspace succeeds on macOS and on Windows**, including whichever
  method that workspace actually uses (test Google SSO explicitly — see §2.4).
- Killing and reopening the app keeps the connection working (persistent partition + stored creds).
- Disconnect removes credentials and the Slack session; reconnect works.
- `grep -ri "xoxc\|xoxd" logs/` finds nothing.

---

### Stage 3 — Sync engine

**Goal:** the user's real Slack history lands in the database and stays current.

**Build:**
- Slack API client: auth headers, form encoding, cursor pagination, per-method rate limiting, 429
  `Retry-After`, backoff+jitter on 5xx/network, `AbortSignal`, typed errors, zero secret leakage.
- Sync run per §5.2: users → conversations → per-conversation history → threads → active-thread
  recheck → emoji → files.
- **Merge policy per §5.5** — implement it deliberately and test every rule.
- File downloader per §5.6 (atomic writes, thumbnails, stub protection, retry/backoff, redirect
  header stripping, Windows-safe names, size policy).
- Run bookkeeping + progress events; cancellation; resumability after a crash.
- Scheduler (§5.3).

**Acceptance:**
- First sync of a real account completes; message counts are plausible; threads are complete.
- Second sync immediately after: **0 new, 0 duplicates**, few API calls.
- Simulated scenarios (against a mock Slack server): an edit produces a revision and keeps history;
  a tombstone keeps the original text and flags it deleted; a `hidden_by_limit` file does not
  overwrite a good record; a 429 is waited out; one failing conversation doesn't abort the run;
  `invalid_auth` marks the connection expired cleanly.
- Killing the app mid-sync loses nothing already committed; the next run continues.

---

### Stage 4 — Reading UI

**Goal:** you can actually read your archived Slack.

**Build:**
- Sidebar (channels/DMs/group DMs, filter, counts, archived styling).
- Conversation view: day dividers, author grouping, avatars, timestamps, infinite scroll both ways
  with scroll anchoring, jump-to-date, deep-link + highlight.
- The **mrkdwn renderer** (§7) incl. Block Kit, attachments/unfurls, emoji (standard + custom +
  skin tones), jumbo emoji.
- Files: image grid, lightbox (Esc/arrows), file cards, "not archived" state, open/reveal actions.
- Thread panel; reactions with names; "(edited)" revisions popover; deleted badge; copy link.
- Light/dark theme following the OS, with a manual override.

**Acceptance:**
- Your own real archive is browsable and looks right; no console errors.
- Rendering matches Slack for a checklist of tricky cases (code blocks, nested formatting,
  `snake_case`, mentions, `<!date^…>`, custom emoji, bot/Block Kit messages, unfurls).
- A 30,000-message channel scrolls smoothly; memory stays bounded.

---

### Stage 5 — Search UI

**Goal:** finding anything is fast and obvious.

**Build:** search page per §8.2 — query box with modifier hints, filter chips, sorts, grouped/flat
results, highlighted snippets (with emoji rendered), load-more, click-through to context,
unresolved-modifier warnings, ⌘K/Ctrl+K from anywhere.

**Acceptance:** searching the real archive returns correct results < 300 ms; every modifier in
§6.1 works; `from:me` resolves to *you*; results click through to the right message in context.

---

### Stage 6 — Background operation, settings, storage management

**Goal:** it runs quietly and never needs babysitting.

**Build:** tray icon + menu; close-to-tray; launch at login (opt-in, default on); scheduled syncs
with progress in the tray; the Settings screens from §8.4 (connection, sync frequency, attachment
policy, storage usage + cleanup + **Back up now**, about); plain-language error handling from §8.5;
"last synced" freshness warnings; log rotation.

**Acceptance:** with the window closed, a scheduled sync runs and picks up new messages; changing
the attachment policy takes effect on the next run; backup produces a restorable copy; every error
path shows human language with an action.

---

### Stage 7 — Packaging, distribution, updates

**Goal:** a colleague can install it and use it without you.

**Build:** electron-builder config; icons; dmg + zip (arm64 + x64) and NSIS (x64); GitHub Actions
release workflow on tag; the **update checker** from §9.5; the **install guide** (Appendix E) in the
README and release notes; a first-run check that the app is in Applications / properly installed.

**Acceptance:** a **clean machine** of each OS installs from the GitHub Release following only the
written guide, connects Slack, and syncs — performed by someone who did not build it. Publishing a
newer version makes the update banner appear, and following it upgrades successfully.

---

### Stage 8 — Hardening and polish

**Goal:** it holds up.

**Build:** work through §12's pitfall list; edge cases (renamed channels/users → re-normalise
`plain_text`; very large threads; unicode/CJK/emoji in search; clock changes/DST; disk-full; OS
sleep during sync); performance at 500k messages; onboarding copy polish; accessibility (focus
rings, keyboard navigation, alt text, aria labels); an "Export conversation" (Markdown/HTML) nicety
if time allows.

**Acceptance:** a full pass over §12 with each item either fixed or consciously accepted and
documented; 500k-message archive stays within the performance targets in §6.3.

---

## 12. Known pitfalls (from a previous implementation's review)

A prior version of this product was built and independently reviewed across six dimensions; 54
findings were confirmed. The ones that matter for this build, distilled:

**Data safety**
1. An edit that empties a message's text must not wipe the archived text (write a revision instead).
2. A stale/older source must not regress newer content, reactions, or `reply_count`.
3. `is_locked` / limited messages must not freeze a row forever against later legitimate updates.
4. A single malformed timestamp must not abort an entire import — skip the row, count the error.
5. Truncated or 0-byte downloads must not be recorded as successfully downloaded.

**Sync completeness**
6. **Edits to thread replies are almost never picked up** with a short overlap window — use ≥7 days
   and the active-thread recheck (§5.2).
7. Files that failed or were skipped (too large) must become retryable; do not strand them.
8. One conversation that persistently errors must not abort every future run.
9. After user or channel renames, `plain_text` becomes stale — provide a re-index pass.

**Search**
10. `from:me` matching any user whose name starts with "me" — resolve to `self_user_id`.
11. `from:<bot>` returning nothing because bot messages carry `bot_id`, not `user_id`.
12. A NUL byte or control character in the query crashing FTS5 — sanitise before `MATCH`.
13. Exclusions being exact while inclusions are prefixes — make the semantics consistent and
    documented.
14. Unbounded snippets, and snippets split mid-surrogate-pair producing broken emoji.

**Rendering**
15. **Block Kit messages showing only fallback text** — app/bot notifications unreadable and
    unsearchable. Render blocks and index their text.
16. Attachments carrying `blocks` rendering as empty cards.
17. Custom emoji that alias standard emoji (`yay → alias:tada`) rendering as literal `:yay:`.

**Security / privacy**
18. Following file-download redirects to non-Slack hosts while still sending `Authorization`/`Cookie`.
19. Rendering untrusted HTML/SVG attachments in-app (XSS against your own app).
20. Secrets reaching logs or error messages — apply redaction centrally.

**Cross-platform**
21. Windows-illegal filenames and reserved device names breaking attachment writes.
22. `rename()` over an existing file failing on Windows (unlink first, retry on EBUSY/EPERM).
23. Case-insensitive path containment checks on Windows.
24. `VAR=value command` shell syntax in npm scripts breaking on Windows.

**Electron-specific (new for this build)**
25. `better-sqlite3` not rebuilt for Electron's ABI — works in dev, fails in the packaged app.
26. Google sign-in blocked in an embedded window (§2.4) — have the email-code path ready.
27. Non-persistent session partition losing the Slack login on every restart.
28. macOS unsigned builds cannot silently auto-update (§9.5). *As built:* they replace themselves
    after quitting instead (Update and restart, §9.5).
29. Renderer loaded from `file://` breaking browser-history routing — use a hash/memory router.

---

## 13. Testing strategy

- **Unit (Vitest)**: merge policy (every rule in §5.5 individually), search parser + FTS expression
  builder (including the injection corpus), mrkdwn parser (a large table of tricky inputs),
  normalisation, filename sanitisation, rate limiter, pagination.
- **Mock Slack server**: a local HTTP server imitating `auth.test`, `users.list`,
  `users.conversations`, `conversations.history` (cursor pages, `oldest`/`inclusive`, a 90-day
  window), `conversations.replies` (parent repeated per page), `emoji.list` and authenticated file
  downloads — plus fault injection (429 with `Retry-After`, 500-then-success, `invalid_auth`,
  `not_in_channel`). **All sync tests run against this; never against real Slack.**
- **Scenario tests**: first sync → incremental (no dupes) → edit (revision) → deletion (tombstone
  kept) → late thread reply → file that first fails then succeeds.
- **Component tests (jsdom)**: message rendering, search results, onboarding states, error states.
- **Manual/E2E per stage**: the acceptance criteria in §11, run on **both** macOS and Windows.
- **Never** hit real Slack in automated tests. Real-Slack verification is a manual checklist item in
  Stages 2 and 3.

---

## Appendix A — Slack API quick reference

```
POST https://slack.com/api/<method>
Headers:
  Authorization: Bearer xoxc-...
  Cookie: d=xoxd-...
  Content-Type: application/x-www-form-urlencoded

Envelope:  { "ok": true|false, "error"?: "...",
             "response_metadata": { "next_cursor": "..." } }

auth.test                  → { ok, team, team_id, user, user_id, url }
users.list                 ?limit=200&cursor=
users.conversations        ?types=public_channel,private_channel,mpim,im
                            &exclude_archived=false&limit=200&cursor=
conversations.history      ?channel=C…&limit=200&cursor=&oldest=&latest=&inclusive=true
conversations.replies      ?channel=C…&ts=1712345678.123456&limit=200&cursor=
conversations.info         ?channel=C…
emoji.list                 → { emoji: { name: "https://…" | "alias:other" } }

Common errors: invalid_auth · token_revoked · account_inactive · not_in_channel ·
               channel_not_found · missing_scope · ratelimited (HTTP 429 + Retry-After)
```

Message object fields used: `type, subtype, ts, thread_ts, user, bot_id, username, text, blocks,
attachments, files, reactions, reply_count, reply_users, latest_reply, edited{user,ts}, icons,
bot_profile, user_profile`.

---

## Appendix B — Database DDL

As built: this is migration v1 in `src/main/db/schema.ts`, which is authoritative. Additions to
the original draft are marked `-- added`.

```sql
PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL;

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE users (
  id TEXT PRIMARY KEY, team_id TEXT, name TEXT, real_name TEXT, display_name TEXT,
  avatar_url TEXT, is_bot INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0,
  raw TEXT NOT NULL, updated_at INTEGER NOT NULL);

-- added: apps/integrations that post with only a bot_id (from:<app>, pitfall 11)
CREATE TABLE bots (
  id TEXT PRIMARY KEY, name TEXT, icon_url TEXT, app_id TEXT, user_id TEXT,
  updated_at INTEGER NOT NULL);

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('channel','private_channel','im','mpim')),
  name TEXT, dm_user_id TEXT, is_archived INTEGER NOT NULL DEFAULT 0,
  is_member INTEGER NOT NULL DEFAULT 1, topic TEXT, purpose TEXT, created INTEGER,
  member_ids TEXT NOT NULL DEFAULT '[]', raw TEXT NOT NULL, updated_at INTEGER NOT NULL);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY,            -- ts in microseconds (chronological)
  conversation_id TEXT NOT NULL, ts TEXT NOT NULL, time INTEGER NOT NULL,
  thread_ts TEXT, is_reply INTEGER NOT NULL DEFAULT 0,
  user_id TEXT, bot_id TEXT, username TEXT, subtype TEXT,
  text TEXT NOT NULL DEFAULT '', plain_text TEXT NOT NULL DEFAULT '',
  reply_count INTEGER NOT NULL DEFAULT 0, latest_reply TEXT,
  reply_users TEXT NOT NULL DEFAULT '[]', edited_ts TEXT,
  has_files INTEGER NOT NULL DEFAULT 0, has_links INTEGER NOT NULL DEFAULT 0,
  has_images INTEGER NOT NULL DEFAULT 0,
  reactions TEXT NOT NULL DEFAULT '[]', is_deleted INTEGER NOT NULL DEFAULT 0,
  raw TEXT NOT NULL, source TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE (conversation_id, ts));

CREATE VIRTUAL TABLE messages_fts USING fts5(
  plain_text, content='messages', content_rowid='id',
  tokenize='unicode61 remove_diacritics 2');
-- + AFTER INSERT / AFTER DELETE / AFTER UPDATE OF plain_text triggers mirroring rows into FTS
--   (the update trigger only fires when the text actually changed).

CREATE TABLE message_revisions (
  id INTEGER PRIMARY KEY, conversation_id TEXT NOT NULL, ts TEXT NOT NULL,
  text TEXT NOT NULL, edited_ts TEXT, seen_at INTEGER NOT NULL);

CREATE TABLE files (
  id TEXT PRIMARY KEY, name TEXT, title TEXT, mimetype TEXT, filetype TEXT, size INTEGER,
  url_private TEXT, url_private_download TEXT, permalink TEXT, thumb_url TEXT,
  width INTEGER, height INTEGER, local_path TEXT, thumb_local_path TEXT,
  download_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (download_status IN ('pending','done','failed','skipped','unavailable')),
  download_error TEXT, download_attempts INTEGER NOT NULL DEFAULT 0,
  skip_reason TEXT,                  -- added: 'policy' | 'too_large' | 'removed'
  next_attempt_at INTEGER,           -- added: epoch ms; retry backoff for failed downloads
  created INTEGER, user_id TEXT, raw TEXT NOT NULL, updated_at INTEGER NOT NULL);

CREATE TABLE message_files (
  conversation_id TEXT NOT NULL, ts TEXT NOT NULL, file_id TEXT NOT NULL,
  position INTEGER NOT NULL, PRIMARY KEY (conversation_id, ts, file_id));

CREATE TABLE custom_emoji (
  name TEXT PRIMARY KEY, url TEXT, alias_for TEXT, updated_at INTEGER NOT NULL);

CREATE TABLE sync_state (
  conversation_id TEXT PRIMARY KEY, latest_ts TEXT, oldest_ts TEXT,
  backfill_complete INTEGER NOT NULL DEFAULT 0, last_synced_at INTEGER, last_error TEXT);

CREATE TABLE runs (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL,
  started_at INTEGER NOT NULL, finished_at INTEGER,
  stats TEXT NOT NULL DEFAULT '{}', error TEXT,
  problem TEXT,                      -- added: signed_out | offline | disk_full | … (for §8.5)
  log TEXT NOT NULL DEFAULT '[]',
  pid INTEGER);                      -- added: tells a crashed run from a live one

-- added: sidebar counts and date ranges without scanning messages; kept by triggers
CREATE TABLE conversation_stats (
  conversation_id TEXT PRIMARY KEY, message_count INTEGER NOT NULL DEFAULT 0,
  oldest_ts TEXT, latest_ts TEXT);

-- Indexes (as built; measured at 300k and 500k messages)
CREATE INDEX messages_conv_reply_ts  ON messages (conversation_id, is_reply, ts);
CREATE INDEX messages_conv_thread_ts ON messages (conversation_id, thread_ts, ts);
-- Covering: combined filters (from:me has:link, in:#x is:thread) never touch the table.
CREATE INDEX messages_user_time ON messages
  (user_id, time, has_links, has_files, has_images, reply_count, thread_ts);
CREATE INDEX messages_conv_time ON messages
  (conversation_id, time, has_links, has_files, has_images, reply_count, thread_ts);
CREATE INDEX messages_bot_time  ON messages (bot_id, time) WHERE bot_id IS NOT NULL;
CREATE INDEX messages_time      ON messages (time);
CREATE INDEX messages_conv_top_ts ON messages (conversation_id, ts)
       WHERE is_reply = 0 OR subtype = 'thread_broadcast';
CREATE INDEX messages_has_files     ON messages (time) WHERE has_files = 1;
CREATE INDEX messages_has_links     ON messages (time) WHERE has_links = 1;
CREATE INDEX messages_has_images    ON messages (time) WHERE has_images = 1;
CREATE INDEX messages_has_reactions ON messages (time) WHERE reactions <> '[]';
CREATE INDEX messages_has_thread    ON messages (time) WHERE reply_count > 0;
CREATE INDEX messages_in_thread     ON messages (time) WHERE thread_ts IS NOT NULL;
CREATE INDEX message_files_file        ON message_files (file_id);
CREATE INDEX message_revisions_conv_ts ON message_revisions (conversation_id, ts);
CREATE INDEX files_status_created      ON files (download_status, created);
CREATE INDEX runs_status               ON runs (status);
```

---

## Appendix C — mrkdwn cheat sheet

```
*bold*  _italic_  ~strike~     (word-boundary rules; not inside snake_case or 2*3*4)
`code`  ```pre```              (no formatting inside; newlines preserved)
> quote line      >>> quote rest of message      (also as &gt;)
<@U123>  <@U123|name>          user mention
<#C123|name>  <#C123>          channel mention
<!here> <!channel> <!everyone> broadcast
<!subteam^S123|@team>          user group
<!date^1712345678^{date_short}|fallback>
<https://x.com|label>  <https://x.com>  <mailto:a@b.c|label>
:tada:  :+1::skin-tone-3:      emoji (standard, custom, aliases)
&lt; &gt; &amp;                 must be unescaped exactly once
```

---

## Appendix D — The existing implementation (optional starting point)

A working version of this product already exists as a **local web app** (not Electron), built and
reviewed. If its source is seeded into this repository, most of Stages 1, 3, 4 and 5 are already
done and should be **ported rather than rewritten**.

What it contains (TypeScript, ~900 passing tests):
- `src/server/db/**` — the full schema above, migrations, repositories, normalisation, FTS search
  with the query parser, tuned for 300k+ messages.
- `src/server/slack/**` — Web API client (rate limiting, pagination, retries), the sync engine with
  the merge policy, and the file downloader.
- `src/server/import/**` — importer for Slack/slackdump export folders and `.zip` files (useful if
  anyone ever gets an official export).
- `src/web/**` — the complete React UI: sidebar, conversation view with infinite scroll, thread
  panel, search page, settings, plus a full Slack-mrkdwn parser/renderer and emoji handling.
- A mock Slack server and a synthetic-data generator for testing.

**Porting notes:** replace the Hono HTTP layer with IPC handlers calling the same service functions
(§3.3); replace `fetch` in the renderer with `window.api.*`; replace the Keychain/DPAPI credential
code with Electron `safeStorage` (§3.5); replace the separate-Chrome/CDP sign-in with the in-app
`BrowserWindow` capture (§2.3); move paths to `app.getPath('userData')` (§3.4). The database, sync,
search and rendering layers transfer essentially unchanged.

---

## Appendix E — Install guide for colleagues (ready to send)

> **Installing Slamem**
>
> Slamem keeps a private copy of your Slack history on your own computer, so you can still
> read and search it after Slack hides older messages. Nothing is uploaded anywhere.
>
> **1. Download**
> Go to **<release page link>** and download:
> - **Mac:** `Slamem-<version>-<arch>.dmg` (choose *arm64* for Apple Silicon Macs, M1/M2/M3/M4, or *x64* for Intel)
> - **Windows:** `Slamem-Setup-<version>.exe`
>
> **2. Install**
> - **Mac:** open the `.dmg` and drag **Slamem** into your **Applications** folder.
> - **Windows:** run the `.exe` and follow the installer.
>
> **3. The first time you open it, your computer will warn you.**
> This is normal — it happens because the app isn't registered with Apple/Microsoft, which costs a
> yearly fee we haven't paid. The app is safe and was built in-house.
>
> - **Mac:** double-click Slamem. You'll see *"Slamem cannot be opened because the
>   developer cannot be verified."* Click **Done**. Then open
>   **System Settings → Privacy & Security**, scroll down to where it says *"Slamem was
>   blocked"*, and click **Open Anyway**. Confirm with **Open**. You only do this once.
> - **Windows:** you'll see a blue *"Windows protected your PC"* box. Click **More info**, then
>   **Run anyway**. You only do this once.
>
> **4. Connect your Slack**
> Click **Connect Slack**. A window opens where you sign in to Slack exactly as you normally would.
> *Tip: the easiest option is "Sign in with email" — Slack emails you a 6-digit code.*
>
> **5. That's it**
> The app downloads your last 90 days of history (Slack won't give us more than that), then keeps
> itself up to date in the background. Everything it has seen is kept forever, even after Slack
> hides it.
>
> **Questions or something looks wrong?** Message <your name> on Slack.

---

*End of plan.*
