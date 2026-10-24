Projects - sites with their own backend (optional)

Keep each project in its own folder here, for example:

  projects\
    cubeword\
      index.html        <- the site (or in dist\, build\, public\ ...)
      server\           <- its backend: pb_hooks\, pb_migrations\ (and pb_data\ once it has run)

Then, in the Media Vault window: Settings > Sites with a backend > "Add a site or backend..." -
the folder picker starts here. Pick the project's folder and Media Vault publishes the site and
runs the backend from this folder (its data stays in its own pb_data).

A project outside this folder can be added too; the add window can move it here for you.

Every site you publish (from the app's Sites page or the Media Vault window) is also copied here,
as projects\<site address>\ - replaced each time it's published again. Editing the copy doesn't
change the live site. A folder here that isn't Media Vault's copy (no .mediavault-site.json in it)
is never touched; the copy then goes next to it as <site address>-site.
Using this folder is optional - it's just to keep things together.

Backups: a backend's data is in its pb_data folder - back it up with Media Vault's pb_data.

Step-by-step, with pictures: docs\SETUP-GUIDE.md, part 6.
