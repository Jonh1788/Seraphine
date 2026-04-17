# 050 — Reactive Animations per Active App

## Scope

Poll `active_app_local` (via 042) every 5s; map to per-app idle
expression/gesture:

| App contains        | expression | extra animation |
|---------------------|-----------|-----------------|
| VS Code / Cursor    | focused   | keyboard-typing loop |
| Arc / Chrome / Safari | curious  | head tilt reading |
| Slack / Discord     | warm      | wave once every 60s |
| Spotify / Music     | playful   | subtle bob |
| Terminal / iTerm    | thinking  | hand on chin |
| Finder              | curious   | look around |
| Mail                | soft      | reading pose |
| default             | soft      | — |

Implementation: `ActiveAppReactor` class in AvatarCompanion consumes a
stream of `active_app` polls, debounces, calls `setExpression` and
optional `playGesture` on the VrmAvatarController.
