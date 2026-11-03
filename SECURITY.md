# Security

Please report vulnerabilities privately through [GitHub's security advisories](https://github.com/adrianjost/claude-graphite-stack-status/security/advisories/new), not in public issues.

## How the review page is protected

The review page is served by a small Node.js server that each Claude Code session starts for itself.

- It listens on `127.0.0.1` only and answers only requests whose `Host` is exactly that address, which blocks DNS rebinding.
- Every API request needs a 256-bit random token from the page's URL, compared in constant time. Requests from other origins are refused.
- A strict Content Security Policy limits the page to its own server: no inline scripts, no third-party hosts, no frames.
- `Referrer-Policy: no-referrer` keeps the token out of requests to sites the page links to.
- File reads are limited to the repository; paths that leave it, directly or through a symlink, are refused.
- Git runs without external diff drivers or text conversion filters.

## Dependencies

The page's dependencies are pinned to exact versions, locked in `package-lock.json` and bundled into `review/dist`, so nothing loads from the internet at runtime. CI installs without lifecycle scripts, runs `npm audit` and `npm audit signatures`, and checks that the committed bundle matches a fresh build. Dependabot proposes updates weekly after a 7-day cooldown, and the GitHub Actions are pinned to commit SHAs.
