# Userscripts

Personal Tampermonkey userscripts, each auto-updating via `@updateURL`.

## Scripts

| Script | Site | What it does |
|--------|------|--------------|
| [tatoeba-flashcards](tatoeba-flashcards/) | tatoeba.org | Anki-style flashcards over Tatoeba's filtered search (ES ↔ EN), with profiles + Gist config sync. |
| [udemy-media-keys](udemy-media-keys/) | udemy.com | Media keys control the course video (±5s, play/pause). |
| [youtube-media-keys](youtube-media-keys/) | youtube.com | Media keys control the YouTube video (±5s, play/pause). |
| [instagram-reels](instagram-reels/) | instagram.com | Click a reel to unmute and play it. |
| [devtalles-media-keys](devtalles-media-keys/) | cursos.devtalles.com | Media keys control the Wistia player (±5s, play/pause). |

## Install / auto-update

Open a script's raw URL with Tampermonkey installed and accept the install. Each script
declares `@updateURL`/`@downloadURL`, so Tampermonkey checks this repo periodically and
auto-updates every device once installed.

Raw URL pattern:

```
https://raw.githubusercontent.com/willcas36/userscripts/main/<folder>/<folder>.user.js
```

## Publishing changes

Edit a script, **bump its `@version`**, then:

```
./publish.sh <script-folder>     # e.g. ./publish.sh youtube-media-keys
```

It runs `node --check`, commits the change scoped to that script, and pushes. Tampermonkey
picks it up on its next update check. If `@version` is not bumped, nothing propagates.

## Local development

`tatoeba-flashcards` has a `dev-loader.user.js` (gitignored — it holds an absolute local
path). Install it once and enable "Allow access to file URLs" for Tampermonkey to load the
script straight from disk and see edits on reload, without publishing. Disable the published
copy while the loader is active.
