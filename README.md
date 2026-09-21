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

> **Status:** under construction. See [PLAN.md](PLAN.md) for the complete build plan and the
> staged roadmap.

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

| Script                                      | What it does                                                                           |
| ------------------------------------------- | -------------------------------------------------------------------------------------- |
| `npm run dev`                               | Electron with hot reload (data in the per-user app data folder, "Slack Archive (dev)") |
| `npm run seed:demo` then `npm run dev:demo` | A synthetic 10k-message archive in `./.demo-data`, then the app on it                  |
| `npm test`                                  | Unit, integration (mock Slack server) and component tests                              |
| `npm run typecheck` / `npm run lint`        | TypeScript (strict) and ESLint                                                         |
| `npm run build`                             | Production bundles in `out/`                                                           |
| `npm run dist:mac` / `npm run dist:win`     | Installers in `release/` (unsigned)                                                    |

Layout: `src/main` (Electron main process: database, Slack sync, sign-in window, tray, IPC),
`src/preload` (the IPC bridge), `src/renderer` (React UI), `src/shared` (the IPC contract),
`test/` (mock Slack server, fixtures).

## Licence

Proprietary. Copyright © 2026 Roman Bitca. All rights reserved. Internal use only.

Third-party packages keep their own licences (see `node_modules/*/LICENSE`). Slack Archive does
not include or link slackdump (AGPLv3); it can import slackdump/Slack export folders and zips as
data.

"Slack" is a trademark of Salesforce, Inc. This project is not affiliated with or endorsed by
Slack.
