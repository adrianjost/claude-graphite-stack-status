// The review page in a real browser, served by the real review server on fixture repos,
// fed the states the plugin tests sent (tests/.out/review/*.json).
import { expect, test } from '@playwright/test'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { api, plainRepo, stackRepo, startServer, TOKEN, versionsRepo } from './fixture.mjs'

const stateOf = name => {
  const file = `tests/.out/review/${name}.json`
  if (!existsSync(file)) throw new Error(`${file} is missing: run \`npm test\`, which runs the plugin tests first`)
  return JSON.parse(readFileSync(file, 'utf8'))
}

const repos = {}
test.beforeAll(() => {
  repos.stack = stackRepo()
  repos.plain = plainRepo()
  repos.versions = versionsRepo()
})
test.afterAll(() => {
  for (const dir of Object.values(repos)) rmSync(dir, { recursive: true, force: true })
})

let server
test.afterEach(() => server?.stop())

// Opens the page on a branch once its diff has drawn. GitHub's times are relative, so the page's clock is fixed.
async function open(page, { state = 'graphite', repo = 'stack', branch = 'adrian/parents-gate' } = {}) {
  server = await startServer(repos[repo])
  await api(server.base, '/state', stateOf(state))
  await page.clock.setFixedTime(new Date('2026-01-01T03:00:00Z'))
  await page.goto(`${server.base}/?t=${TOKEN}#branch=${encodeURIComponent(branch)}`)
  await expect(page.locator('#diff section.file').first()).toBeVisible()
  await expect(page.locator('#stack .row.selected')).toHaveCount(1)
  return server
}

// What the page asked Claude Code to do, as the plugin would read it.
const actions = () => api(server.base, '/actions')

const shot = (page, name) => expect(page).toHaveScreenshot(`${name}.png`, { fullPage: true })

test.describe('looks', () => {
  for (const scheme of ['light', 'dark']) {
    test(`the checked-out branch with uncommitted changes and GitHub threads (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme })
      await open(page)
      await expect(page.getByText('Could this be simpler? (1)')).toBeVisible()
      await shot(page, `current-branch-${scheme}`)
    })
  }

  test('an approved PR with an SVG preview and unpushed commits', async ({ page }) => {
    await open(page, { branch: 'adrian/shared-story-intro' })
    await expect(page.locator('.svg-preview img')).toHaveCount(2)
    await shot(page, 'approved-svg-unpushed')
  })

  test('a branch without a PR that needs a restack', async ({ page }) => {
    await open(page, { branch: 'adrian/parents-questions' })
    await shot(page, 'no-pr-restack')
  })

  test('the unified view', async ({ page }) => {
    await open(page)
    await page.locator('[data-format="unified"]').click()
    await shot(page, 'unified')
  })

  test('a narrow window', async ({ page }) => {
    await page.setViewportSize({ width: 760, height: 900 })
    await open(page)
    await shot(page, 'narrow')
  })

  test('a GitHub stack', async ({ page }) => {
    await open(page, { state: 'gh-stack' })
    await expect(page.locator('#stack-source')).toHaveText('· GitHub stack')
    await expect(page.locator('#sidebar')).toHaveScreenshot('gh-stack-sidebar.png')
  })

  test('the PR description next to a differing commit message', async ({ page }) => {
    const state = stateOf('graphite')
    const row = state.rows.find(r => r.branch === 'adrian/parents-gate')
    row.pr.title = '✨ Gate the whole parents chapter'
    row.pr.body = 'Gates the chapter until both parents agreed.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)'
    row.pr.bodyHtml = '<p>Gates the chapter until both parents agreed.</p>'
    server = await startServer(repos.stack)
    await api(server.base, '/state', state)
    await page.goto(`${server.base}/?t=${TOKEN}#branch=adrian/parents-gate`)
    await expect(page.locator('.description-compare')).toHaveCount(0)
    await page.getByRole('button', { name: 'Compare with commit message' }).click()
    await expect(page.locator('.description-compare')).toContainText('Gates the chapter until both parents agreed.')
    await expect(page.locator('.description-compare .commit-title').last()).toHaveText('✨ Gate the whole parents chapter')
    await expect(page.locator('.description-compare del')).toHaveText('whole')
    await expect(page.locator('#description')).toHaveScreenshot('description-compare.png')
    await page.getByRole('button', { name: 'Hide commit message' }).click()
    await expect(page.locator('.description-compare')).toHaveCount(0)
  })

  test('comparing pushed versions of a layer leaves out what a rebase brought in', async ({ page }) => {
    await open(page, { repo: 'versions', branch: 'adrian/shared-story-intro' })
    await expect(page.locator('#versions .commit')).toHaveCount(3)
    await page.locator('#versions [data-version="3"]').click()
    await expect(page.locator('#commit-view .version-note')).toContainText('rebased')
    await expect(page.locator('#commit-view .changes-body')).toHaveText('No file changes.')
    await page.locator('[data-act="versions"]').click()
    await page.locator('[data-version-pick="from"][value="1"]').check()
    await expect(page.locator('[data-act="versions"]')).toHaveText(/v1 → v3/)
    await expect(page.locator('#commit-view .changes-file')).toHaveText(/src\/intro\.ts/)
    await expect(page.locator('#commit-view del, #commit-view .changes-body')).not.toContainText('feature9')
    await shot(page, 'versions')
    await page.keyboard.press('Escape')
    await expect(page.locator('.version-popover')).toHaveCount(0)
    await page.locator('[data-act="versions"]').click()
    await page.locator('label.to:has([value="2"])').click({ position: { x: 4, y: 4 } })
    await page.locator('[data-version-pick="from"][value="0"]').check()
    await expect(page.locator('[data-act="versions"]')).toHaveText(/v2 vs parent/)
    await expect(page.locator('#commit-view .changes-body')).toContainText('Hi ${name}')
    await expect(page.locator('[data-version-pick="from"][value="-1"]')).toBeDisabled()
    await page.locator('[data-version-pick="to"][value="3"]').check()
    await expect(page.locator('#commit-view')).toBeHidden()
    await expect(page.locator('[data-act="versions"]')).toHaveText(/vs parent/)
    await page.locator('[data-version-pick="from"][value="-1"]').check()
    await expect(page.locator('[data-act="versions"]')).toHaveText(/vs main/)
    await expect(page.locator('#diff')).toBeVisible()
    await page.getByRole('button', { name: 'Reset' }).click()
    await expect(page.locator('[data-act="versions"]')).toHaveText(/vs parent/)
    await expect(page.locator('.version-popover')).toHaveCount(0)
  })

  test('the sidebar marks the file in the middle of the screen', async ({ page }) => {
    await open(page)
    const middle = () => page.evaluate(() => document.elementFromPoint(innerWidth * 0.7, innerHeight / 2)?.closest('#diff .file')?.dataset.file)
    const marked = () => page.locator('#files .file-item.in-view').getAttribute('data-goto', { timeout: 1000 }).catch(() => undefined)
    const at = async top => {
      await page.evaluate(top => window.scrollTo(0, top), top)
      await expect.poll(async () => (await marked()) === (await middle())).toBe(true)
      return marked()
    }
    expect(await at(0)).not.toBe(await at(100_000))
  })

  test('browsing single commits', async ({ page }) => {
    await open(page)
    await page.locator('#commits .commit', { hasText: 'open the gate at 16' }).click()
    await expect(page.locator('#commit-view')).toContainText('Commit 2 of 2')
    await expect(page.locator('#commit-view .changes-file')).toHaveText(/src\/gate\.ts/)
    await expect(page.locator('#diff')).toBeHidden()
    await shot(page, 'commit-view')
    await page.getByRole('button', { name: '‹ Older' }).click()
    await expect(page.locator('#commit-view')).toContainText('Commit 1 of 2')
    await expect(page.locator('#commit-view .commit-title')).toHaveText('✨ Gate the parents chapter')
    await page.getByRole('button', { name: '← All changes' }).click()
    await expect(page.locator('#diff')).toBeVisible()
  })

  test('a plain git branch', async ({ page }) => {
    await open(page, { state: 'untracked', repo: 'plain', branch: 'adrian/quick-fix' })
    await expect(page.locator('#stack-source')).toHaveText('')
    await shot(page, 'plain-branch')
  })

  test('the stack list rows stay padded and aligned', async ({ page }) => {
    await open(page)
    const rows = page.locator('#stack .row')
    await expect(rows).toHaveCount(4)
    const boxes = await rows.evaluateAll(els => els.map(el => {
      const row = el.getBoundingClientRect()
      const lane = el.querySelector('svg').getBoundingClientRect()
      const title = el.querySelector('.num, .title').getBoundingClientRect()
      return { pad: lane.left - row.left, title: title.left, height: row.height }
    }))
    for (const box of boxes) {
      expect(box.pad, 'space between the row highlight and the graph').toBeGreaterThanOrEqual(4)
      expect(box.height).toBe(26)
    }
    expect(new Set(boxes.map(b => b.title)).size, 'PR numbers and titles start at the same x').toBe(1)
  })
})

test.describe('stack list', () => {
  test('shows the stack top to bottom with its kind, and switches branches', async ({ page }) => {
    await open(page)
    await expect(page.locator('#stack-source')).toHaveText('· Graphite')
    await expect(page.locator('#stack .row .title')).toHaveText([
      'adrian/parents-questions',
      '✨ Gate the parents chapter',
      '✨ Ask the shared story intro',
      'main',
    ])
    await expect(page.locator('#stack .row', { hasText: 'parents-questions' }).locator('.restack')).toHaveAttribute('title', "Needs a restack: not based on its parent's latest commit")
    await expect(page.locator('#stack .row', { hasText: 'shared story intro' }).locator('.restack')).toHaveAttribute('title', 'Local commits not on GitHub yet')
    await expect(page.locator('#stack .row', { hasText: 'Gate the parents' }).locator('.restack')).toHaveAttribute('title', 'Uncommitted changes in the working tree')

    const tip = text => page.locator('#stack .row', { hasText: text }).locator('svg > title')
    await expect(tip('parents-questions')).toHaveText("Hollow dot: no PR yet\nDotted line: not based on its parent's latest commit")
    await expect(tip('Gate the parents')).toHaveText('Green dot: open PR\nRing around the dot: the checked-out branch')
    await expect(page.locator('#stack .row', { hasText: 'Gate the parents' }).locator('.stat')).toHaveAttribute('title', 'Lines added and removed against the parent branch')

    await page.locator('#stack .row', { hasText: 'shared story intro' }).click()
    await expect(page.locator('#header h1')).toContainText('Ask the shared story intro')
    await expect(page).toHaveURL(/#branch=adrian%2Fshared-story-intro$/)
    await expect(page.locator('#diff section.file[data-file="src/intro.ts"]')).toBeVisible()
  })
})

test.describe('buttons that ask Claude', () => {
  test('push sends a push-branch action', async ({ page }) => {
    await open(page, { branch: 'adrian/shared-story-intro' })
    await expect(page.locator('#header .badge', { hasText: 'Not pushed' })).toBeVisible()
    await page.locator('[data-act="push-branch"]').click()
    await expect.poll(actions).toEqual([expect.objectContaining({ type: 'push-branch', branch: 'adrian/shared-story-intro' })])
  })

  test('commit sends a commit-branch action', async ({ page }) => {
    await open(page)
    await page.locator('[data-act="commit-branch"]').click()
    await expect.poll(actions).toEqual([expect.objectContaining({ type: 'commit-branch', branch: 'adrian/parents-gate' })])
  })

  test('branches without changes to push or commit have no such buttons', async ({ page }) => {
    await open(page, { branch: 'adrian/parents-questions' })
    await expect(page.locator('[data-act="push-branch"], [data-act="commit-branch"]')).toHaveCount(0)
  })

  test('submit as draft PR sends a submit-branch action', async ({ page }) => {
    await open(page, { branch: 'adrian/parents-questions' })
    await page.locator('[data-act="submit-branch"]').click()
    await expect.poll(actions).toEqual([expect.objectContaining({ type: 'submit-branch', branch: 'adrian/parents-questions' })])
  })

  test('convert to draft sends a pr-ready action', async ({ page }) => {
    await open(page)
    await page.locator('[data-act="pr-ready"]').click()
    await expect.poll(actions).toEqual([expect.objectContaining({ type: 'pr-ready', number: 31188, ready: false })])
  })
})

test.describe('conversations', () => {
  // Three sent comments over two layers: one with an unread reply, one addressed and read, one still waiting.
  async function seed(page) {
    await open(page)
    const file = await page.evaluate(async t => (await fetch(`/file?t=${t}&branch=adrian%2Fparents-gate&path=src%2Ffeature.ts&worktree=1`)).json(), TOKEN)
    const lines = (file.text ?? '').split('\n')
    const at = Date.parse('2026-01-01T02:00:00Z')
    await page.evaluate(
      ({ code, at }) => {
        localStorage.setItem('sent:adrian/parents-gate', JSON.stringify([
          { id: 1, path: 'src/feature.ts', side: 'new', start: 2, line: 3, code, text: 'Why these numbers?', sentAt: at, answeredAt: at + 180_000, answer: { ref: 'c1', status: 'reply', text: 'Product asked for ten times the old values.' } },
          { id: 2, path: 'src/gate.ts', side: 'new', line: 1, code: 'export const isOpen = (age: number) => age >= 18', text: 'Use a named constant for the age', sentAt: at + 60_000, answer: { ref: 'c2', status: 'fixed' }, readSig: 'fixed||' },
        ]))
        localStorage.setItem('sent:adrian/shared-story-intro', JSON.stringify([
          { id: 3, path: 'src/intro.ts', side: 'new', line: 2, code: '  return `Hello ${name}`', text: 'Greet by first name?', sentAt: at + 120_000 },
        ]))
      },
      { code: lines.slice(1, 3).join('\n'), at },
    )
    await page.reload()
    await expect(page.locator('#diff section.file').first()).toBeVisible()
  }

  test('lists every sent comment of the stack, latest activity first, with answers, code and read state', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' })
    await seed(page)
    await expect(page.locator('[data-view="conversations"] .count')).toHaveText('1')
    await page.locator('[data-view="conversations"]').click()
    const cards = page.locator('#conversations .conversation')
    await expect(cards).toHaveCount(3)
    // Claude's answer on the oldest comment moved it to the top
    await expect(cards.locator('code')).toHaveText(['src/feature.ts:2–3', 'src/intro.ts:2', 'src/gate.ts:1'])
    await expect(page.locator('[data-filter="unread"] .count')).toHaveText('1')
    await expect(page.locator('[data-filter="waiting"] .count')).toHaveText('1')
    await expect(cards.nth(0)).toHaveClass(/unread/)
    // unread first, then a divider before the read ones
    await expect(page.locator('#conversations .conversation.unread + .read-divider + .conversation')).toHaveCount(1)
    await expect(cards.nth(0).locator('tr.commented')).toHaveCount(2)
    await expect(cards.nth(0).locator('.conversation-code tr')).toHaveCount(6)
    await expect(cards.nth(2)).toContainText('Changed since you commented')
    await expect(cards.nth(1)).toContainText('Waiting for Claude')
    // seen for a moment, the unread one counts as read but stays marked until the view is drawn again
    await expect(page.locator('[data-filter="unread"] .count')).toHaveText('0')
    await expect(cards.nth(0)).toHaveClass(/unread/)
    await expect(cards.nth(0).locator('[data-act="toggle-read"]')).toHaveText('Mark as unread')
    await expect(cards.nth(1).locator('.conversation-code tr')).toHaveCount(3)
    await expect(page).toHaveScreenshot('conversations.png', { fullPage: true })
    await page.locator('[data-filter="waiting"]').click()
    await expect(cards).toHaveCount(1)

    await cards.locator('[data-jump]').click()
    await expect(page.locator('#conversations')).toBeHidden()
    await expect(page).toHaveURL(/#branch=adrian%2Fshared-story-intro$/)
  })

  test('a reply sent from a card goes to Claude as a follow-up on its layer', async ({ page }) => {
    await seed(page)
    await page.locator('[data-view="conversations"]').click()
    const card = page.locator('#conversations .conversation').first()
    await card.locator('textarea').fill('Then add a comment saying so')
    await card.locator('textarea').press('ControlOrMeta+Enter')
    await expect.poll(actions).toEqual([
      expect.objectContaining({
        type: 'review',
        branch: 'adrian/parents-gate',
        comments: [expect.objectContaining({ replyTo: 1, parentRef: 'c1', text: 'Then add a comment saying so', path: 'src/feature.ts' })],
      }),
    ])
    // the plugin picks it up
    await api(server.base, '/actions', { ids: (await actions()).map(a => a.id) })
    await expect(page.locator('#conversations .conversation').first().locator('.msg')).toHaveCount(2)
    await expect(page.locator('#conversations .conversation').first()).toContainText('Waiting for Claude')
  })

  test('an answer read in the diff view counts as read', async ({ page }) => {
    await seed(page)
    await expect(page.locator('[data-view="conversations"] .count')).toHaveText('1')
    const thread = page.locator('#diff .comment.thread.unread')
    await thread.scrollIntoViewIfNeeded()
    await expect(page.locator('[data-view="conversations"] .count')).toHaveCount(0)
  })

  test('conversations fold by hand, stay folded after a reload and open again on news', async ({ page }) => {
    await seed(page)
    await page.locator('[data-view="conversations"]').click()
    const cards = page.locator('#conversations .conversation')
    await cards.nth(1).locator('.conversation-head code').click()
    await expect(cards.nth(1)).toHaveClass(/folded/)
    await expect(cards.nth(1).locator('.msg')).toBeHidden()
    await page.reload()
    await page.locator('[data-view="conversations"]').click()
    await expect(cards.nth(1)).toHaveClass(/folded/)
    await page.locator('[data-act="fold-all"]').click()
    await expect(page.locator('#conversations .conversation.folded')).toHaveCount(3)
    await expect(page.locator('[data-act="fold-all"]')).toHaveText('Expand all')
    await page.locator('[data-act="fold-all"]').click()
    await expect(page.locator('#conversations .conversation.folded')).toHaveCount(0)

    // Claude answering a folded conversation opens it again
    await cards.nth(1).locator('[data-act="fold-conversation"]').first().click()
    await expect(cards.nth(1)).toHaveClass(/folded/)
    const state = stateOf('graphite')
    await api(server.base, '/state', { ...state, replies: { 3: { ref: 'c3', status: 'reply', text: 'Yes, first name only.' } } })
    await expect(page.locator('#conversations .conversation').first()).toContainText('Yes, first name only.')
    await expect(page.locator('#conversations .conversation').first()).not.toHaveClass(/folded/)
  })

  test('mark as read and unread by hand', async ({ page }) => {
    await seed(page)
    await page.locator('[data-view="conversations"]').click()
    const first = page.locator('#conversations .conversation').first()
    await first.locator('[data-act="toggle-read"]').click()
    await expect(first).not.toHaveClass(/unread/)
    await expect(first.locator('[data-act="toggle-read"]')).toHaveText('Mark as unread')
    await first.locator('[data-act="toggle-read"]').click()
    await expect(page.locator('#conversations .conversation').first()).toHaveClass(/unread/)
  })
})

test.describe('reviewer picker', () => {
  test('people seen before show right away, before GitHub answers', async ({ page }) => {
    server = await startServer(repos.stack)
    const state = stateOf('graphite')
    state.people = [
      { login: 'carla', name: 'Carla Example', avatarUrl: '' },
      { login: 'finn', name: 'Finn Example', avatarUrl: '' },
    ]
    await api(server.base, '/state', state)
    await page.goto(`${server.base}/?t=${TOKEN}#branch=adrian%2Fparents-gate`)
    await page.locator('[data-act="reviewers"]').first().click()
    await page.locator('#picker input').fill('car')
    const carla = page.locator('#picker [data-person="carla"]')
    await expect(carla).toBeVisible()
    await expect(page.locator('#picker [data-person="finn"]')).toHaveCount(0)
    await carla.click()
    await expect(carla).toHaveClass(/selected/)
  })
})

test.describe('reviewing', () => {
  test('a line comment goes into one review sent to Claude', async ({ page }) => {
    await open(page)
    const line = page.locator('#diff section.file[data-file="src/gate.ts"] td.ln[data-side="new"][data-line="1"]')
    await line.hover()
    await line.locator('.add-comment').click()
    await page.locator('.composer textarea').fill('Use a named constant for the age')
    await page.locator('.composer [data-act="save"]').click()
    await expect(page.locator('[data-act="review"] .count')).toHaveText('1')

    await page.locator('[data-act="review"]').first().click()
    await page.locator('#summary').fill('Nearly there.')
    await page.locator('#submit [data-act="send"]').click()
    await expect.poll(actions).toEqual([
      expect.objectContaining({
        type: 'review',
        branch: 'adrian/parents-gate',
        summary: 'Nearly there.',
        comments: [expect.objectContaining({ path: 'src/gate.ts', line: 1, side: 'new', text: 'Use a named constant for the age' })],
      }),
    ])
  })

  test('a long file comment on an added file spans the file and leaves the code its half', async ({ page }) => {
    await open(page)
    const file = page.locator('#diff section.file.half.new-side').first()
    await file.locator('[data-file-comment]').click({ force: true })
    await page.locator('.composer textarea').fill('Why the move to a new file? '.repeat(30))
    await page.locator('.composer [data-act="save"]').click()
    const width = sel => file.locator(sel).first().evaluate(el => el.getBoundingClientRect().width)
    const body = await width('.file-body')
    expect(await width('.file-comments')).toBe(body)
    expect(await width('.file-body > table')).toBeCloseTo(body / 2, 0)
  })

  test('GitHub threads show on their lines', async ({ page }) => {
    await open(page)
    const file = page.locator('#diff section.file[data-file="src/feature.ts"]')
    await expect(file.getByText('Could this be simpler? (1)')).toBeVisible()
    await expect(file.getByText('albert').first()).toBeVisible()
  })

  test('the uncommitted switch shows only the working copy', async ({ page }) => {
    await open(page)
    await page.locator('[data-uncommitted="only"]').click()
    const changed = page.locator('#diff section.file').filter({ hasNotText: 'No longer changed' })
    await expect(changed).toHaveCount(2)
    await expect(changed.nth(0)).toHaveAttribute('data-file', 'src/gate.ts')
    await expect(changed.nth(1)).toHaveAttribute('data-file', 'notes.md')
    // GitHub threads on a file outside this view stay reachable
    await expect(page.locator('#diff section.file[data-file="src/feature.ts"]')).toContainText('No longer changed')
  })

  test('marking a file viewed counts it and survives a reload', async ({ page }) => {
    await open(page)
    const total = await page.locator('#diff section.file').count()
    await page.locator('[data-viewed="src/gate.ts"]').check()
    await expect(page.locator('#files-progress')).toHaveText(`1 / ${total} viewed`)
    await page.reload()
    await expect(page.locator('#files-progress')).toHaveText(`1 / ${total} viewed`)
  })
})
