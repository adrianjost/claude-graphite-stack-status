import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { alignmentProblems, all, columns, emit, labels, stackRows, text, type Node } from './tree'
import { clone, kids0, rowOf, STACK, start } from './setup'
import type { World } from './world'

describe('refreshing', () => {
  // What a Bash command Claude ran sets off: calls in the first 2 s (local refresh after 1.5 s), and by 16 s (GitHub's 15 s gap).
  const after = async ($: Engine, on: On, command: string) => {
    const { rec, clock } = await start($, on, clone(STACK))
    rec.calls.length = 0
    await $.tool.call({ tool: 'Bash', command })
    await clock.advance(2_000)
    const early = rec.calls.length
    await clock.advance(14_000)
    const late = rec.calls.length
    await clock.settle()
    return { early, late }
  }
  for (const command of ['gh stack rebase', 'gt restack', 'git commit -m x', 'git checkout feat']) {
    test(`\`${command}\` refreshes local data right away`, async ($, on) => {
      expect((await after($, on, command)).early).toBeGreaterThan(0)
    })
  }
  for (const command of ['gh stack submit', 'gh stack push', 'gh stack sync', 'gt submit', 'gt sync', 'git push', 'gh pr create --draft']) {
    test(`\`${command}\` asks GitHub again right away, past the cache`, async ($, on) => {
      const { rec, clock } = await start($, on, clone(STACK))
      const before = rec.graphql
      await $.tool.call({ tool: 'Bash', command })
      await clock.advance(2_000)
      expect(rec.graphql).toBeGreaterThan(before)
    })
  }

  test('a push Claude ran clears the force push button at once', async ($, on) => {
    const world = clone(STACK)
    world.branches[1]!.unpushed = 'rewritten'
    const { draw, clock } = await start($, on, world)
    let { ui, tree } = await draw()
    expect(labels(rowOf(tree, 'adrian/parents-gate')!)).toContain('⇅ force push')
    await ui.unmount()
    world.branches[1]!.remoteHead = 'new-adrian/parents-gate'
    await $.tool.call({ tool: 'Bash', command: 'git branch --unset-upstream && gt submit --update-only --no-edit' })
    await clock.advance(2_000)
    ;({ ui, tree } = await draw())
    expect(labels(rowOf(tree, 'adrian/parents-gate')!).some(l => l.includes('push'))).toBe(false)
    await ui.unmount()
  })

  test('other commands refresh nothing', async ($, on) => {
    const r = await after($, on, 'ls -la')
    expect(r.late).toBe(0)
  })

  test('the refresh button asks GitHub again', async ($, on) => {
    const { draw, rec } = await start($, on, clone(STACK))
    const { ui } = await draw()
    const before = rec.graphql
    await ui.press({ key: 'refresh' })
    expect(rec.graphql).toBeGreaterThan(before)
    await ui.unmount()
  })

  test('/stack hides and shows the band, and ✕ hides it', async ($, on) => {
    const { draw } = await start($, on, clone(STACK))
    await $.command.run({ command: 'stack', args: '' } as never)
    let { ui, tree } = await draw()
    expect(text(tree)).toBe('engine')
    await ui.unmount()
    await $.command.run({ command: 'stack', args: '' } as never)
    ;({ ui, tree } = await draw())
    expect(stackRows(tree)).toHaveLength(4)
    await ui.press({ key: 'hide' })
    expect(text((await ui.drawn()) as unknown as Node)).toBe('engine')
    await ui.unmount()
  })
})
