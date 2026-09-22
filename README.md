# Slamem

A desktop app for macOS and Windows that keeps a **permanent, private, searchable copy of your own
Slack history on your own computer**.

On Slack's Free plan only the most recent 90 days of messages are visible, in the Slack app and
through its API. Everything older is hidden and eventually deleted. Slamem syncs your
channels, direct messages and group DMs in the background, and keeps **everything it has ever
seen, forever**, even after Slack hides it.

- **Local-first.** One computer, no server, no cloud, no account, no telemetry. The only network
  traffic is between the app and Slack (plus a check for new versions on GitHub, and the download
  of one when you click Update and restart).
- **Only your own view.** It archives the conversations _you_ are in, using your own Slack login.
  Nobody else's DMs or private channels, no workspace admin needed.
- **Read-only against Slack.** It never posts, edits, reacts or deletes anything in Slack.

> **Status:** Stages 1–8 of [PLAN.md](PLAN.md) are built and tested against a mock Slack. What is
> verified, and what still needs a person (a real sign-in, clean-machine installs), is in
> [docs/STATUS.md](docs/STATUS.md).

## How it signs in to Slack (please read once)

Slamem opens Slack's normal sign-in page in its own window. You sign in exactly as you
would in your browser (the easiest option is **"Sign in with email"**, which emails you a 6-digit
code). The app then uses that signed-in web session, the same one the Slack website uses, to
download **your own** messages to **your own** computer.

This is how tools such as [slackdump](https://github.com/rusq/slackdump) work too. It is not an
officially sanctioned automation route: it uses your personal Slack login to make a personal copy
of your own history. Nothing is centralised, nothing is shared, and nothing is written to Slack.
The session is stored encrypted with your operating system's keychain (macOS Keychain / Windows
DPAPI) and never leaves your machine.

## Installing

Download the latest version from the repository's **Releases** page. The app isn't code-signed
(yet), so the first launch needs one extra click. The illustrated guide in
[docs/INSTALL.md](docs/INSTALL.md) walks through it.

## Development

Requirements: Node.js 22.12+ and npm. No native build tools are needed: `better-sqlite3` ships
prebuilt Node-API binaries that load in both Node and Electron.

```bash
npm install
```

```bash
npm run dev
```

| Script                                       | What it does                                                                           |
| -------------------------------------------- | -------------------------------------------------------------------------------------- |
| `npm run dev`                                | Electron with hot reload (data in the per-user app data folder, "Slamem (dev)")        |
| `npm run seed:demo` then `npm run dev:demo`  | A synthetic 10k-message archive in `./.demo-data`, then the app on it                  |
| `npm run mock:slack` then `npm run dev:mock` | A fake Slack workspace on port 4849, then the app signed in to it (`./.mock-data`)     |
| `npm run check`                              | Typecheck, lint and all tests (what CI runs)                                           |
| `npm test`                                   | Unit, integration (mock Slack server) and component tests                              |
| `npm run build` then `npm run e2e`           | The built app driven end to end against the mock Slack (sign-in, sync, restart, crash) |
| `npm run bench -- --messages 500000`         | Seeds a large archive in `.test-data/` and times the hot paths against PLAN §6.3       |
| `npm run icons`                              | Redraws the app and tray icons in `build/` and `resources/tray/`                       |
| `npm run gen:emoji`                          | Rebuilds the emoji table from `emoji-datasource` (after upgrading it)                  |
| `npm run dist:mac` / `npm run dist:win`      | Installers in `release/<version>/` (unsigned)                                          |

Layout: `src/main` (Electron main process: database, Slack sync, sign-in window, tray, IPC),
`src/preload` (the IPC bridge), `src/renderer` (React UI), `src/shared` (the IPC contract),
`test/` (mock Slack server, synthetic workspace, fixtures), `scripts/` (seed, bench, e2e).

Automated tests never talk to real Slack. The mock (`test/mock-slack/`) serves the Web API,
authenticated file downloads and the sign-in pages from a synthetic workspace, with fault
injection (429s, failures, a signed-out session) and a 90-day Free-plan window.

### Pointing a build at another folder

`--data-dir=<path>` (or `SLA_MEM_DATA_DIR`) opens the archive in another folder: demo data,
tests, or a second archive for a different account. Unpackaged builds default to
`Slamem (dev)`, so development never touches a real archive.

### The old name

The app was called sla-mem until 0.3.2. What people see says Slamem; a few identifiers keep the
old name because changing them would break existing installs: the repository and package name,
the bundle id `com.9h.sla-mem` (Update and restart only installs a download with the same id), the
`SLA_MEM_*` variables, and Electron's own name for the app, `app.setName('sla-mem')` in
`src/main/index.ts` (macOS names the keychain item that protects the saved sign-in after it,
_sla-mem Safe Storage_, so a new name would sign everyone out). On first start the archive
folder moves from `sla-mem` to `Slamem`, and a Mac copy updated in place renames itself
`Slamem.app` (`src/main/paths.ts`, `src/main/bundle-rename.ts`).

## Releasing

1. From a clean `main` with the changes pushed (CI green), bump the version and tag it in one go:

   ```bash
   npm version 0.2.0      # or: npm version patch / minor. Commits package.json and tags v0.2.0
   git push --follow-tags
   ```

2. The **Release** workflow (about 10 minutes) checks that the tag matches `package.json`, runs the
   tests, builds the macOS dmg + zip (Apple Silicon and Intel) and the Windows installer, and
   attaches them to a **draft** GitHub Release.
3. Open the draft, write the notes for non-technical readers ("Syncs are much faster"), link
   [docs/INSTALL.md](docs/INSTALL.md), and **Publish**. Drafts are invisible to everyone else.
4. From then on every installed Slamem sees the new version within a day (it checks on start and
   daily, or at once with Settings → About → Check for updates) and shows a banner with your notes
   and **Update and restart**. That one click downloads the new version, checks it against the
   release (GitHub's SHA-256 of the file, and on macOS the app's identity, version and signature),
   replaces the app and reopens it (PLAN §9.5). Nothing installs without the click. A copy that
   can't replace itself (run from the disk image, a folder it may not change) shows a Download
   button and the steps in docs/INSTALL.md → Updating instead. The archive is never touched by an
   update. Update and restart downloads the release's `Slamem-<version>-<arch>-mac.zip` and
   `Slamem-Setup-<version>.exe`, so keep those attached.

The workflow can also be started by hand (Actions → Release → Run workflow). It then leaves the
builds as workflow artifacts without touching Releases: use it to try an installer before tagging.

> The repository is public so that colleagues can download releases without a GitHub account and
> the in-app update check can read them (GitHub hides a private repository's releases). Public
> doesn't mean open source: the licence below still applies. If it ever has to be private again,
> publish releases from a separate public repository instead: point `UPDATE_REPO` in
> `src/main/context.ts` and `publish` in `electron-builder.yml` at it, add a `RELEASES_TOKEN` secret
> that can write there, and update the links in [docs/INSTALL.md](docs/INSTALL.md).

## Licence

Proprietary. Copyright © 2026 Roman Bitca. All rights reserved. Internal use only.

Third-party packages keep their own licences (see `node_modules/*/LICENSE`). Slamem does
not include or link slackdump (AGPLv3); it can import slackdump/Slack export folders and zips as
data.

"Slack" is a trademark of Salesforce, Inc. This project is not affiliated with or endorsed by
Slack.
