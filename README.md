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
| **↻ restack** | the branch is no longer based on its parent's head |
| **Badges** | the PR's GitHub labels, in their colors |

The title links to the PR. The band refreshes every minute and after Claude runs `git`, `gh` or `gt`. When any PR fails CI, the status line says so.

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

## Usage

The band appears on its own whenever the session's branch belongs to a Graphite stack.

- `/stack` shows or hides it
- click the band, then press `R` to refresh or `H` to hide

## License

MIT
