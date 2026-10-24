# Setting up Media Vault

## A new install
Unzip or copy the folder somewhere outside OneDrive (e.g. `C:\Media Vault`) and run `start.bat`: the first time,
it opens **setup** (see `README.md` in the main folder). To make a clean copy for another PC from an install that's in use, run
`scripts\make-package.ps1` there (`powershell -ExecutionPolicy Bypass -File scripts\make-package.ps1`): it makes
`Media-Vault-setup-{date}.zip` next to the folder - the program without the library, logs, settings, hosted sites
or the Android signing key, plus the code of any site backends under `backends\`.

**Setup** (`setup.bat`, or "Setup..." in the status window; safe to run again) asks for:
- the ports for Media Vault (8091) and the sites server (8092), saved in `mediavault.json`. On a fresh copy whose
  default ports are taken (e.g. by another copy on the same PC) it starts on free ones.
- the admin dashboard account (`/_/`); your own Media Vault account is created in the app (the first one is the owner)
- Tailscale: Media Vault's https address (8443, tailnet only) and the sites' (443: public through Funnel, tailnet, off).
  An address already serving something else on this PC starts off and is only taken over after a yes.
- site backends: extra PocketBase servers some sites need (e.g. a game's accounts and saves), each in its own folder
  on `127.0.0.1:{port}`, optionally published on its own https port (Funnel can use 443, 8443 and 10000). The status
  window then starts, watches and stops them with the other two. Point the site at the backend's address.
- the firewall rule, starting with Windows, a desktop shortcut

It starts from what's set up now and only changes what differs; its last page lists the addresses to use (and what to
type into the Android app). Setup's log is in `logs\setup.log`.

## Moving an install (with its data) to another PC
1. Stop Media Vault (close its window, choose Yes) so the database isn't copied mid-write.
2. Copy the whole folder to the new PC (outside OneDrive). `pb_data` holds the library and accounts, `pb_sites` the
   hosted sites. If setup put the library somewhere else (`dataDir` in `mediavault.json`), copy that folder too.
   Site backends in other folders need copying too.
3. On the new PC run `setup.bat` (if the library is in a new place, point **Servers > Where your library is stored**
   at it): it keeps the data and redoes the PC-specific parts (firewall, Tailscale addresses,
   startup). Phones then need the new address (Android app: **Change address**).

## HTTPS addresses (Tailscale)
- Media Vault: `https://{pc}.{tailnet}.ts.net:8443/` - tailnet only, never public.
- Hosted sites: `https://{pc}.{tailnet}.ts.net/{site}/` - public through Funnel, or tailnet only.

Setup or the status window's **Settings** tab set these. By hand (`tailscale serve` keeps them across restarts):

    tailscale serve --bg --https=8443 http://127.0.0.1:8091
    tailscale funnel --bg --https=443 http://127.0.0.1:8092

(Use `tailscale serve --bg --https=443 http://127.0.0.1:8092` instead of the funnel line to keep the sites
tailnet-only.) Check with `tailscale serve status`. `http://{Tailscale IP}:8091` works too.

The sites server only serves `pb_sites\www`: no dashboard, no API, no login. Each site has its own access setting
(public / password / private) in Media Vault > Sites, and a folder without an `index.html` shows its file list.
`https://{pc}.{tailnet}.ts.net/` itself (no site) sends the Android app and signed-in tailnet browsers on to Media
Vault on 8443; Funnel visitors just see a plain page.

## Notes
- Never funnel 8443 / 8091 - the vault is meant to stay private. Only 443 (the sites) and site backends may be public.
- Share links (`/s/...`) are built from whatever address you open the app with.
- If you build the Android app, keep `android/media-vault.jks` + `keystore.properties` safe: updates won't install
  over the existing app without them (see `android/README.md`).
- Back up by copying the library folder (`pb_data`, or `dataDir`) and `pb_sites\www` while Media Vault is stopped.
