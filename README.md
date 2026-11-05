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

The plugin checks for a new release once a day. When there is one, a banner above the stack offers **Update**, which runs `claude plugin update` for you; restart Claude Code afterwards.

## Requirements

- The Claude Code desktop app. The band draws nothing in the terminal, VS Code or mobile.
- [`gt`](https://graphite.dev/docs/install-the-cli) tracking your branches (the plugin reads Graphite's local metadata, `.git/.graphite_metadata.db`)
- [`gh`](https://cli.github.com), signed in to the repository's GitHub host
- `sqlite3` and `git` on your `PATH`
- [Node.js](https://nodejs.org) on your `PATH` for the review page (optional; nothing to install, the page ships prebuilt)

## Usage

The band appears on its own whenever the session's branch belongs to a Graphite stack.

- `/stack` shows or hides it
- **Refresh** and **Hide** in its header reload it or hide it

## Review page

**Review stack** in the band's header, or **Review ↗** on a branch's line counts, opens a live review page for the stack in your browser. Each click opens a new tab on that branch, and every open tab follows the session as Claude works.

- The stack graph on the left switches between branches (or press `[` and `]`).
- For a branch with a PR, the top shows its state, with a button to mark a draft **Ready for review** or **Convert to draft** (through `gh pr ready`), assigned reviewers with their review status (**Edit reviewers** opens a GitHub-style picker with suggestions to request or remove reviewers), and its labels, followed by the PR description (capped, with **Show all**). **Comment on description** adds feedback on the description, quoting any text you selected in it; Claude applies it by editing the PR description.
- Diffs are GitHub-style: split (default) or unified, with syntax highlighting, highlighted changed words and expandable context. Compare against the parent branch or trunk and hide whitespace.
- On the checked-out branch, switch between all changes, committed only and uncommitted only. In the combined view, uncommitted lines get an orange dot and their files an **Uncommitted** badge.
- Generated and very large files are left out until you show them. Mark files as viewed; the mark resets when the file changes.
- For a branch without a PR, the page previews the PR from the branch's first commit: its title as the heading and its body as the description, which you can comment on. **Submit as draft PR** asks Claude to submit the branch with Graphite.
- Click a code line, drag over line numbers, or shift-click a second line to leave an inline comment on one or more lines. A review covers one stack layer: **Review** lists the layer's pending comments, and **Send to Claude** hands them plus an overall note to Claude in the session, naming the layer, its branch and PR, and confirms once Claude Code picked them up.
- The comment button in a file's header (next to **Viewed**) adds a comment on the whole file, shown at the top of its diff and sent as `` `path` (file) `` without quoted code; GitHub's file-level review threads show there too.
- Sent comments stay as a history: **Comments** lists pending and sent comments for the whole stack and jumps to each one. On the diff, sent comments show as faded cards, marked *Outdated* once their lines changed; dismiss them one by one, clear the history, or hide them from the diff.
- Claude answers sent comments with the `review_reply` tool (replies cost only a few tokens): sent comments show an **Addressed** or **Reply** badge, Claude's one-sentence reply when a comment asked a question or wasn't done, and a lazy **Changes** section with the diff of that turn (the worktree is snapshotted with `git stash create` when the comments are sent and when Claude finishes). Answers are kept in the browser, so they survive a restart.
- **Reply** on a sent comment adds a follow-up to the same line, and the comment and its follow-ups show as one conversation card (**Dismiss** clears the whole thread). A follow-up goes to Claude as `[c5] re c2: …`, with no path or quoted code, so it costs only a few tokens; after a restart it includes a short excerpt of the earlier answer instead.
- The page updates live after commits, restacks and Claude's file edits.
- GitHub review threads on the PR show inline at their line, with resolved ones collapsed and threads that no longer match the diff listed at the top of the file. **Add to review** puts a thread into the pending review, **Fix now** sends just that thread to Claude (who fixes it and resolves the thread with `gh`), and **Resolve** / **Unresolve** change it on GitHub. Thread details are fetched only while the page is running and only for PRs whose threads changed, and are cached.
- The browser tab starts with what you're looking at (pending comment count, PR number and title, or branch) and ends with the stack's name. Each stack gets its own coloured favicon with its initial, so several review tabs stay easy to tell apart.

Each session serves its own page on `127.0.0.1` with a fixed port, so several review pages can be open at once and an open tab reconnects after a restart. Requests need a random token in the page's URL, and other sites can't call it; see [SECURITY.md](SECURITY.md).

## Keeping the stack current

**Sync with main** in the band's header runs `gt sync` and `gt restack` right away, so the whole stack is based on the latest `origin/main`. A branch's **↻ restack** button does the same for that branch's stack. The header shows progress while they run, and neither pushes anything. If a rebase hits a conflict, the working tree has uncommitted changes or a command fails, the job is handed to Claude to finish.

## Settings

Pick where clicking a PR title opens it with the **Links** picker in the band's header: GitHub (default) or Graphite. The choice is remembered across sessions.

## Troubleshooting

When something keeps the band from working, it shows a ⚠ line with the reason, for example a missing `gh` or `sqlite3`, a `gt` version too old to read, `gh` not signed in, or GitHub's rate limit. Click its button to have Claude fix the problem, or to look into it and suggest a fix when the cause isn't clear.

## Development

The review page's sources live in `review/src`. Its dependencies (highlight.js, jsdiff, DOMPurify) are pinned in `package.json` and bundled into `review/dist` by esbuild, so the page loads no code from the internet (only screenshots in PR descriptions come from GitHub). `review/dist` is committed because plugins install straight from the repository:

```bash
npm ci
npm run build
```

CI checks that the committed bundle matches a fresh build and runs `npm audit`; Dependabot proposes dependency updates weekly.

## License

MIT
