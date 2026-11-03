# Claude Graphite Stack Status

A Claude Code plugin that shows the [Graphite](https://graphite.dev) stack of the branch Claude is working on, right above the prompt in the Claude Code desktop app.

<img width="935" alt="The graphite-stack band above the Claude Code prompt, showing a stack of six PRs with their state, review status, failing CI and labels" src="https://github.com/user-attachments/assets/b3b49b33-2cc8-47bf-8504-5210b60d0cdb" />

## What it shows

One row per branch, drawn as the same tree `gt log` draws, from the branch above trunk up to every descendant, side branches included.

| | |
|---|---|
| **Dot** | PR state: ● grey draft, ● green open, ● purple merged, ● red closed, ◯ not submitted |
| **Red ✕** | CI is failing. Hover it for the failing checks, each linked to its run |
| **Review icon** | ✓ approved, 💬 changes requested, 👤+ no reviewers yet, 🕐 waiting for review |
| **Small number** | unresolved review conversations |
| **↻ restack** | the branch is no longer based on its parent's head, and its line to the parent is dotted; click it to have Claude restack it |
| **Badges** | the PR's GitHub labels, in their colors; hover one for its description; when they don't fit, `+N` shows the rest on hover |
| **+12 −3** | lines added and removed against the parent branch, ignoring whitespace; hover and click **Review ↗** to open that branch on the review page |

The title links to the PR. GitHub data refreshes every minute, every 30 seconds while CI is running, and every 5 minutes after 10 quiet minutes. It also refreshes right after Claude runs `git push`, `gt submit`, `gt sync` or `gh pr …`. Other `git`/`gt` commands only re-read the local stack. Sessions on the same repo share results, and polling pauses while no app window shows the session. When any PR fails CI, the status line says so.

## Install

In Claude Code, run:

```
/plugin install graphite-stack --marketplace adrianjost/claude-graphite-stack-status
```

Answer `y` to add the marketplace, then pick a scope.

## Requirements

- The Claude Code desktop app. The band draws nothing in the terminal, VS Code or mobile.
- [`gt`](https://graphite.dev/docs/install-the-cli) tracking your branches (the plugin reads Graphite's local metadata, `.git/.graphite_metadata.db`)
- [`gh`](https://cli.github.com), signed in to the repository's GitHub host
- `sqlite3` and `git` on your `PATH`
- [Node.js](https://nodejs.org) on your `PATH` for the review page (optional)

## Usage

The band appears on its own whenever the session's branch belongs to a Graphite stack.

- `/stack` shows or hides it
- **Refresh** and **Hide** in its header reload it or hide it

## Review page

**Review stack** in the band's header, or **Review ↗** on a branch's line counts, opens a live review page for the stack in your browser. Keep it open: it follows the session as Claude works, and when it's open those buttons switch it to the branch instead of opening another tab.

- The stack graph on the left switches between branches (or press `[` and `]`).
- Diffs are GitHub-style: unified or split, with syntax highlighting, highlighted changed words and expandable context. Compare against the parent branch or trunk and hide whitespace.
- On the checked-out branch, switch between all changes, committed only and uncommitted only. In the combined view, uncommitted lines get an orange dot and their files an **Uncommitted** badge.
- Generated and very large files are left out until you show them. Mark files as viewed; the mark resets when the file changes.
- Click a line number to leave an inline comment, then **Review** → **Send to Claude** hands all comments and an overall note to Claude in the session.
- The page updates live after commits, restacks and Claude's file edits.

Each session serves its own page on `127.0.0.1` with a fixed port, so several review pages can be open at once and an open tab reconnects after a restart. Requests need a random token in the page's URL, and other sites can't call it.

## Keeping the stack current

**Sync with main** in the band's header runs `gt sync` and `gt restack` right away, so the whole stack is based on the latest `origin/main`. A branch's **↻ restack** button does the same for that branch's stack. The header shows progress while they run, and neither pushes anything. If a rebase hits a conflict, the working tree has uncommitted changes or a command fails, the job is handed to Claude to finish.

## Settings

Pick where clicking a PR title opens it with the **Links** picker in the band's header: GitHub (default) or Graphite. The choice is remembered across sessions.

## Troubleshooting

When something keeps the band from working, it shows a ⚠ line with the reason, for example a missing `gh` or `sqlite3`, a `gt` version too old to read, `gh` not signed in, or GitHub's rate limit. Click its button to have Claude fix the problem, or to look into it and suggest a fix when the cause isn't clear.

## License

MIT
