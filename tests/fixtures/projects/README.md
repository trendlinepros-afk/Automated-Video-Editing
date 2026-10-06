# Sample projects, one per released format

Each folder holds a project exactly as a released version of the app wrote it:

| Folder | Format | Written by |
| --- | --- | --- |
| `format-1/` | 1 | the 0.x test builds (`"version": 1`, linear gain, `anchorWord`/`anchorOffset`, checklist object) |
| `format-2/` | 2 | 1.0.0 |

`tests/project-upgrade.test.ts` copies every folder here to a temporary directory, opens it, upgrades it
and checks that nothing was lost. A release is blocked if any of them fails.

Rules:

- Never edit an existing folder. It is a record of what users have on disk.
- When `PROJECT_FORMAT_VERSION` is bumped, add `format-<new version>/` saved by the release that
  introduced it, with every item type, anchors of both kinds and at least one unknown field.
- Source footage paths point at files that do not exist; projects must open without them.
