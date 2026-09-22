# Security

Slamem keeps a copy of someone's Slack messages and holds their Slack session, so security
problems matter. Thank you for looking.

## Reporting a problem

Please report it privately, not in a public issue: on GitHub, open the repository's **Security**
tab and choose **Report a vulnerability**
(<https://github.com/romanbitca/sla-mem/security/advisories/new>). Say what an attacker needs
(a crafted Slack message, export, backup, release, local access…) and what they get. You'll get
an answer within a few days, and credit in the release notes if you'd like it.

Only the latest release is supported: fixes ship as a new version, which Slamem offers to install
itself (Update and restart).

## What Slamem protects, and how

The details, with the reasons, are in [PLAN.md](PLAN.md) §3.5–3.6 and §9.5.

- **The Slack session never leaves the computer.** It is encrypted with the operating system's
  keychain (Electron `safeStorage`: macOS Keychain, Windows DPAPI; Linux without a keyring is
  refused), never written in plain text, never logged (every log line is redacted) and never
  handed to the window: the page only learns whether it is connected. The same goes for the
  Anthropic API key of Ask AI.
- **Read-only against Slack, by construction.** The Slack client calls only the documented read
  methods it lists (`READ_ONLY_METHODS` in `src/main/slack/client.ts`) and refuses anything else
  before a request is made. The session goes only to `slack.com`: Web API calls, and file
  downloads from Slack's file addresses (`/files-pri/`, `/files-tmb/`), never to a file address an
  imported export or backup names elsewhere, and never across a redirect off Slack.
- **Everything from Slack is untrusted.** Messages are parsed into React elements (no HTML is
  ever injected), links open in the browser only for `http`, `https` and `mailto` (showing the real
  address when the text differs), and images come only from the archive, Slack's hosts or Slack's
  image proxy. Attachments are shown inline only as raster images, video and audio, from a
  protocol that serves nothing outside the archive's files folder. Programs, scripts, installers
  and shortcuts are never opened, only shown in their folder, and before a file is opened or shown
  it gets the mark a browser gives a download (macOS quarantine, Windows Mark of the Web), so
  Gatekeeper, SmartScreen and Office's Protected View check it.
- **Imports are untrusted too.** Slack exports and Slamem backups can be written by anyone: paths
  are confined to the archive folder (no "zip slip", no symlinks), oversized JSON is refused,
  and a backup's database is opened read-only and checked before the archive touches it (intact,
  and holding only what Slamem's own schema creates; SQLite's `trusted_schema` is off).
- **A locked-down window.** Sandboxed renderer with context isolation and no Node, a strict
  Content-Security-Policy (no requests of its own, scripts only from the app), no navigation away
  from the app, no new windows, no `<webview>`, no web permissions but writing to the clipboard,
  and every IPC call checked against an allowlist, its sender and its arguments. The Slack
  sign-in window, popups included, is an ordinary sandboxed browser window with no access to the
  app.
- **The packaged app.** Electron fuses turn off `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` and
  `--inspect`, encrypt cookies, check the integrity of the app's code archive and load the app only
  from it.
- **Updates.** Update and restart installs only a newer release of this repository's own app,
  after checking its size and SHA-256 against GitHub, its bundle id and version, and (macOS) its
  code signature.
- **The build.** Workflows run with read-only tokens except the step that attaches files to a draft
  release, actions are pinned to commits, dependencies are installed from the lockfile with their
  integrity hashes, and releases are drafts published by a person.

## Known limits

- **Not signed with a Developer ID (yet).** macOS builds are ad-hoc signed and Windows builds
  unsigned (PLAN §9.4), so an update is trusted because it comes from this repository's releases
  over HTTPS with GitHub's checksum: whoever can publish a release here can ship code to every
  user. Signing with a Developer ID (planned) would let the updater also require the same signer.
- **The archive isn't encrypted at rest.** The database and attachments are ordinary files in the
  user's own folder (only the Slack session and the API key are encrypted), readable by anything
  running as that user. Turn on FileVault or BitLocker; keep backups (they hold every message)
  somewhere safe.
- **My style's review sends your latest 150 messages to Anthropic** (only yours), with your own
  key, only when you click Review; the review is kept on this computer, readable by you only.
  Everything else on My style is worked out locally.
- **Ask AI sends what it reads to Anthropic,** with the user's own key and only while it answers.
  Message text can try to steer Claude (prompt injection); the tools it has only read the local
  archive, and answers can't contain links or images, so there is nothing for such text to send
  anywhere.
