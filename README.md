# Slack Archive

A desktop app for macOS and Windows that keeps a **permanent, private, searchable copy of your own
Slack history on your own computer**.

On Slack's Free plan only the most recent 90 days of messages are visible, in the Slack app and
through its API. Everything older is hidden and eventually deleted. Slack Archive syncs your
channels, direct messages and group DMs in the background, and keeps **everything it has ever
seen, forever**, even after Slack hides it.

- **Local-first.** One computer, no server, no cloud, no account, no telemetry. The only network
  traffic is between the app and Slack (plus a check for new versions on GitHub).
- **Only your own view.** It archives the conversations _you_ are in, using your own Slack login.
  Nobody else's DMs or private channels, no workspace admin needed.
- **Read-only against Slack.** It never posts, edits, reacts or deletes anything in Slack.

> **Status:** Stages 1–8 of [PLAN.md](PLAN.md) are built and tested against a mock Slack. What is
> verified, and what still needs a person (a real sign-in, clean-machine installs), is in
> [docs/STATUS.md](docs/STATUS.md).

## How it signs in to Slack (please read once)

Slack Archive opens Slack's normal sign-in page in its own window. You sign in exactly as you
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
| `npm run dev`                                | Electron with hot reload (data in the per-user app data folder, "Slack Archive (dev)") |
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

`--data-dir=<path>` (or `SLACK_ARCHIVE_DATA_DIR`) opens the archive in another folder: demo data,
tests, or a second archive for a different account. Unpackaged builds default to
`Slack Archive (dev)`, so development never touches a real archive.

## Releasing

1. Bump `version` in `package.json` and commit.
2. Tag and push: `git tag v0.2.0 && git push origin v0.2.0`.
3. The **Release** workflow builds the macOS dmg + zip (Apple Silicon and Intel) and the Windows
   installer, and attaches them to a **draft** GitHub Release.
4. Write the release notes for non-technical readers, link [docs/INSTALL.md](docs/INSTALL.md), and
   publish.

The workflow can also be started by hand (Actions → Release → Run workflow). It then leaves the
builds as workflow artifacts without touching Releases.

> **Before the first release:** this repository is private. Colleagues can't open its Releases
> page and the in-app update check can't see its releases. Either make the repository public, or
> publish releases from a public repository: point `UPDATE_REPO` in `src/main/context.ts` and
> `publish` in `electron-builder.yml` at it, add a `RELEASES_TOKEN` secret that can write there, and
> update the links in [docs/INSTALL.md](docs/INSTALL.md).

## Licence

Proprietary. Copyright © 2026 Roman Bitca. All rights reserved. Internal use only.

Third-party packages keep their own licences (see `node_modules/*/LICENSE`). Slack Archive does
not include or link slackdump (AGPLv3); it can import slackdump/Slack export folders and zips as
data.

"Slack" is a trademark of Salesforce, Inc. This project is not affiliated with or endorsed by
Slack.
