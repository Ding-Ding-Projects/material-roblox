# GitHub wiki mirror

The five Markdown files beside this README (`Home.md`, `_Sidebar.md`,
`Features-Overview.md`, `Development-and-Building.md`, `FAQ.md`) are the
content of the project's GitHub wiki, kept in-repo so the wiki is reviewable,
diffable, and never lost if nobody opens the web UI for a while.

**They mirror the wiki — the wiki is the published copy.** When the content
changes, change it here first, merge, then paste the same text up to the wiki.

## Why the files sit here instead of being pushed straight up

A repository's wiki has its own Git remote
(`https://github.com/Ding-Ding-Projects/material-roblox.wiki.git`). That
remote **returns 404 until the first wiki page exists**, and the first page
can only be created through the web UI — there is no API or CLI route that
initializes a wiki on an empty repository. Until someone does that once, any
clone or push aimed at the wiki remote fails with a 404.

That limitation is documented here rather than papered over: no script
pretends to sync, and nothing claims the wiki is populated when it is not.

## One-time initialization (manual)

1. Open the repository on GitHub → **Settings** → **Wiki** (or the **Wiki**
   tab) and create the first page — call it **Home**, paste the contents of
   [`Home.md`](Home.md), and save.
   Creating that first page brings the wiki remote into existence.
2. After that, the wiki remote works normally. Either paste the remaining
   pages through the web UI, or clone
   `https://github.com/Ding-Ding-Projects/material-roblox.wiki.git` and copy
   the files up:

   ```bat
   git clone https://github.com/Ding-Ding-Projects/material-roblox.wiki.git
   copy /Y <repo>\docs\wiki\Home.md            material-roblox.wiki\Home.md
   copy /Y <repo>\docs\wiki\_Sidebar.md        material-roblox.wiki\_Sidebar.md
   copy /Y <repo>\docs\wiki\Features-Overview.md       material-roblox.wiki\Features-Overview.md
   copy /Y <repo>\docs\wiki\Development-and-Building.md material-roblox.wiki\Development-and-Building.md
   copy /Y <repo>\docs\wiki\FAQ.md             material-roblox.wiki\FAQ.md
   cd material-roblox.wiki
   git add -A && git commit -m "Mirror in-repo wiki content" && git push
   ```

3. `_Sidebar.md` is picked up automatically by GitHub wikis and renders as the
   navigation column on every page. No configuration is needed beyond the file
   being present at the wiki root.

## Keeping the two copies honest

- The in-repo copies are the source of truth; the wiki is the rendered copy.
- Wiki pages deep-link into the repository tree
  (`https://github.com/Ding-Ding-Projects/material-roblox/blob/main/...`)
  rather than duplicating article content, so a documentation edit in
  `docs/features/**` reaches wiki readers immediately without a wiki edit.
- If you find the wiki out of date, the fix is: update the in-repo file,
  then repeat the copy step above. Do not edit only the wiki — the next
  mirror overwrites it.
