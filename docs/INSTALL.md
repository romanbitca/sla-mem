# Installing Slamem

Slamem keeps a private copy of your Slack history on your own computer, so you can still
read and search it after Slack hides older messages. Nothing is uploaded anywhere.

It takes about five minutes, and you only do this once.

> Slamem was called **sla-mem** until version 0.3.2. If you already have it, see
> [Updating](#updating): your archive and settings come along.

## 1. Download

Go to the **[latest release](https://github.com/romanbitca/sla-mem/releases/latest)** and download
the file for your computer:

| Your computer                                | Download                     |
| -------------------------------------------- | ---------------------------- |
| **Mac with Apple silicon** (M1, M2, M3, M4…) | `Slamem-<version>-arm64.dmg` |
| **Mac with an Intel processor**              | `Slamem-<version>-x64.dmg`   |
| **Windows**                                  | `Slamem-Setup-<version>.exe` |

Not sure which Mac you have? Click the Apple menu → **About This Mac**. If it says _Chip: Apple
M…_, you have Apple silicon. If it says _Processor: Intel…_, choose Intel.

## 2. Install

- **Mac:** open the downloaded `.dmg` and drag **Slamem** onto the **Applications** folder
  next to it. Then eject the disk image (the ⏏ button next to it in Finder).
- **Windows:** double-click the downloaded `.exe`. It installs by itself (no administrator
  password needed) and opens Slamem when it's done.

## 3. The first time you open it, your computer will warn you

This is normal. It happens because the app isn't registered with Apple or Microsoft, which costs a
yearly fee we haven't paid. The app is safe and was built in-house. You only do this once.

### Mac

1. Open **Applications** and double-click **Slamem**.
2. You'll see _“Slamem” cannot be opened_ (or _Apple could not verify “Slamem”…_).
   Click **Done** (or **OK**) — not _Move to Trash_.
3. Open **System Settings** → **Privacy & Security**, and scroll down to the **Security** section.
   You'll see _“Slamem” was blocked to protect your Mac._ Click **Open Anyway**.
4. Confirm with **Open Anyway** again (you may be asked for your Mac password or Touch ID).

Slamem opens. If your Mac later asks whether _Slamem_ may use its **keychain** (the item is called
_sla-mem Safe Storage_, the app's old name), click **Always Allow** — that's where the app keeps
your Slack sign-in, encrypted.

### Windows

1. You'll see a blue box: _Windows protected your PC_.
2. Click **More info**, then **Run anyway**.

Some antivirus programs also ask about new apps. If yours does, choose to allow **Slamem**.

## 4. Connect your Slack

Click **Connect Slack**. A window opens where you sign in to Slack exactly as you normally would.

> **Tip:** the easiest option is **“Sign in with email”** — Slack emails you a 6-digit code, you type
> it in, and you're done.

When the window closes by itself, you're connected.

## 5. Choose what to archive

Slamem lists every channel, direct message and group DM you're in, all ticked. Untick anything
you'd rather not keep, such as a channel or your messages with someone, then click **Start
archiving**. You can change this any time in **Settings → What to archive**.

## 6. That's it

The app downloads your last 90 days of history (Slack won't give us more than that), then keeps
itself up to date in the background. Everything it has seen is kept forever, even after Slack hides
it. **Overview** shows what's archived; each conversation's header says how many of its messages
Slack no longer shows.

- Leave **“Start Slamem when I log in”** switched on: the archive can only keep what it sees
  within Slack's 90-day window, so it needs to run regularly.
- Closing the window doesn't stop it. It keeps running in the menu bar (Mac) or the system tray
  (Windows, bottom-right). Use that icon to open it again or to quit. Don't want the icon? Turn
  it off in **Settings → App**; Slamem keeps syncing, and you open it from Applications (Mac)
  or the Start menu (Windows).

## Moving to a new computer

1. On the old computer: **Settings → Backup → Back up now**, and save the file somewhere you can
   reach from the new computer (a USB stick, a shared drive). It contains your Slack messages:
   keep it private.
2. On the new computer: install Slamem as above. On its first screen click **Moving from another
   computer? Import a backup** and choose that file. (Later, it's **Settings → Backup → Import a
   backup**.) Backups made under the old name, sla-mem, work too.
3. Connect Slack with the same account. Syncing carries on from where the old computer stopped,
   and nothing is duplicated.

## Updating

Slamem looks for a new version when it starts and once a day (or right away with **Settings →
About → Check for updates**). When one is out, it shows a banner: **“Version X is available.”**
Click **Update and restart**. Slamem downloads the new version, closes, and opens again a few
seconds later as the new version (if it is in the middle of a sync, it finishes that first).

- **Mac:** the new version may ask whether it may use your **keychain**. Click **Always Allow**
  (you may need your Mac password): that's where Slamem keeps your Slack sign-in, and each new
  version asks once.
- **Windows:** nothing else to do.

Your archive and settings are kept. Coming from sla-mem 0.3.0 or 0.3.1, the update also renames
the app: on a Mac, _sla-mem_ in Applications becomes _Slamem_ the first time the new version
opens, and the archive folder moves along by itself.

### Updating by hand

The banner shows **Download** instead when Slamem can't replace itself: for example when it runs
straight from the disk image, when an update couldn't be installed, or in versions up to 0.2.2,
which didn't have Update and restart yet. Click **Download**, then:

- **Mac:** quit the app first (**Slamem → Quit Slamem**, or ⌘Q; a Mac won't replace an app
  that is open). Open the download and drag Slamem into Applications, choosing **Replace** if it
  asks. Coming from a version called **sla-mem**, the old app stays next to the new one: move
  _sla-mem_ to the Bin (your archive isn't in it). When you open the new version, your Mac may
  block it once more: follow the same **Open Anyway** steps as in
  [step 3](#3-the-first-time-you-open-it-your-computer-will-warn-you).
- **Windows:** run the downloaded installer (it closes the app if it's open). If Windows warns
  you, choose **More info → Run anyway**, as the first time.

## Questions or something looks wrong?

Message Roman on Slack. In the app, **Settings → About → Show logs** opens the log files, which
help when something goes wrong — they never contain your Slack password or sign-in.
