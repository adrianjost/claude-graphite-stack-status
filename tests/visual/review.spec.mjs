// The review page in a real browser, served by the real review server on fixture repos,
// fed the states the plugin tests sent (tests/.out/review/*.json).
import { expect, test } from '@playwright/test'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { api, plainRepo, stackRepo, startServer, TOKEN } from './fixture.mjs'

const stateOf = name => {
  const file = `tests/.out/review/${name}.json`
  if (!existsSync(file)) throw new Error(`${file} is missing: run \`npm test\`, which runs the plugin tests first`)
  return JSON.parse(readFileSync(file, 'utf8'))
}

const repos = {}
test.beforeAll(() => {
  repos.stack = stackRepo()
  repos.plain = plainRepo()
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
    await expect(page.locator('#stack-kind')).toHaveText('Code changes')
    await expect(page.locator('#sidebar')).toHaveScreenshot('gh-stack-sidebar.png')
  })

  test('a plain git branch', async ({ page }) => {
    await open(page, { state: 'untracked', repo: 'plain', branch: 'adrian/quick-fix' })
    await expect(page.locator('#stack-kind')).toHaveText('Code changes')
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
    await expect(page.locator('#stack-kind')).toHaveText('Code changes')
    await expect(page.locator('#stack .row .title')).toHaveText([
      'adrian/parents-questions',
      '✨ Gate the parents chapter',
      '✨ Ask the shared story intro',
      'main',
    ])
    await expect(page.locator('#stack .row', { hasText: 'parents-questions' }).locator('.restack')).toHaveAttribute('title', 'Needs a restack')
    await expect(page.locator('#stack .row', { hasText: 'shared story intro' }).locator('.restack')).toHaveAttribute('title', 'Local commits not on GitHub yet')
    await expect(page.locator('#stack .row', { hasText: 'Gate the parents' }).locator('.restack')).toHaveAttribute('title', 'Uncommitted changes')

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
