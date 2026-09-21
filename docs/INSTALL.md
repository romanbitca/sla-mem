# Installing Slack Archive

Slack Archive keeps a private copy of your Slack history on your own computer, so you can still
read and search it after Slack hides older messages. Nothing is uploaded anywhere.

It takes about five minutes, and you only do this once.

## 1. Download

Go to the **[latest release](https://github.com/romanbitca/sla-mem/releases/latest)** and download
the file for your computer:

| Your computer                                | Download                            |
| -------------------------------------------- | ----------------------------------- |
| **Mac with Apple silicon** (M1, M2, M3, M4…) | `Slack-Archive-<version>-arm64.dmg` |
| **Mac with an Intel processor**              | `Slack-Archive-<version>-x64.dmg`   |
| **Windows**                                  | `Slack-Archive-Setup-<version>.exe` |

Not sure which Mac you have? Click the Apple menu → **About This Mac**. If it says _Chip: Apple
M…_, you have Apple silicon. If it says _Processor: Intel…_, choose Intel.

## 2. Install

- **Mac:** open the downloaded `.dmg` and drag **Slack Archive** onto the **Applications** folder
  next to it. Then eject the disk image (the ⏏ button next to it in Finder).
- **Windows:** double-click the downloaded `.exe`. It installs by itself (no administrator
  password needed) and opens Slack Archive when it's done.

## 3. The first time you open it, your computer will warn you

This is normal. It happens because the app isn't registered with Apple or Microsoft, which costs a
yearly fee we haven't paid. The app is safe and was built in-house. You only do this once.

### Mac

1. Open **Applications** and double-click **Slack Archive**.
2. You'll see _“Slack Archive” cannot be opened_ (or _Apple could not verify “Slack Archive”…_).
   Click **Done** (or **OK**) — not _Move to Trash_.
3. Open **System Settings** → **Privacy & Security**, and scroll down to the **Security** section.
   You'll see _“Slack Archive” was blocked to protect your Mac._ Click **Open Anyway**.
4. Confirm with **Open Anyway** again (you may be asked for your Mac password or Touch ID).

Slack Archive opens. If your Mac later asks whether _Slack Archive_ may use its **keychain**, click
**Always Allow** — that's where the app keeps your Slack sign-in, encrypted.

### Windows

1. You'll see a blue box: _Windows protected your PC_.
2. Click **More info**, then **Run anyway**.

Some antivirus programs also ask about new apps. If yours does, choose to allow **Slack Archive**.

## 4. Connect your Slack

Click **Connect Slack**. A window opens where you sign in to Slack exactly as you normally would.

> **Tip:** the easiest option is **“Sign in with email”** — Slack emails you a 6-digit code, you type
> it in, and you're done.

When the window closes by itself, you're connected.

## 5. That's it

The app downloads your last 90 days of history (Slack won't give us more than that), then keeps
itself up to date in the background. Everything it has seen is kept forever, even after Slack hides
it.

- Leave **“Start Slack Archive when I log in”** switched on: the archive can only keep what it sees
  within Slack's 90-day window, so it needs to run regularly.
- Closing the window doesn't stop it. It keeps running in the menu bar (Mac) or the system tray
  (Windows, bottom-right). Use that icon to open it again or to quit.

## Updating

When a new version is out, Slack Archive shows a banner: **“Version X is available.”** Click
**Download**, then:

- **Mac:** open the download and drag Slack Archive into Applications, choosing **Replace**.
- **Windows:** run the downloaded installer.

Your archive and settings are kept.

## Questions or something looks wrong?

Message Roman on Slack. In the app, **Settings → About → Show logs** opens the log files, which
help when something goes wrong — they never contain your Slack password or sign-in.
