import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { alignmentProblems, all, columns, emit, labels, stackRows, text, type Node } from './tree'
import { clone, kids0, rowOf, STACK, start } from './setup'
import type { World } from './world'

describe('branches without a stack', () => {
  test('a plain git branch is shown without a note and without Sync', async ($, on) => {
    const world: World = { kind: 'untracked', current: 'adrian/quick-fix', branches: [{ name: 'adrian/quick-fix', parent: 'main', added: 4, removed: 1 }] }
    const { draw, rec } = await start($, on, world)
    const { ui, tree } = await draw()
    emit('band', 'untracked', tree)

    expect(rec.unknown).toEqual([])
    expect(text(tree)).not.toContain('not in a stack')
    expect(labels(kids0(tree))).not.toContain('Sync with main')
    expect(alignmentProblems(tree)).toEqual([])
    await ui.unmount()
  })

  test('several plain branches side by side get no stack note', async ($, on) => {
    const world: World = {
      kind: 'untracked',
      current: 'adrian/quick-fix',
      branches: [
        { name: 'adrian/quick-fix', parent: 'main', added: 4, removed: 1 },
        { name: 'adrian/other-fix', parent: 'main', added: 2, removed: 0 },
      ],
    }
    world.bound = [{ number: 31201, repo: 'acme/app', state: 'open', head: 'adrian/other-fix' }]
    const { draw } = await start($, on, world)
    const { ui, tree } = await draw()
    emit('band', 'untracked-several', tree)
    expect(text(tree)).not.toContain('not in a stack')
    expect(alignmentProblems(tree)).toEqual([])
    await ui.unmount()
  })

  test('on trunk with nothing changed the band stays empty', async ($, on) => {
    const world: World = { kind: 'untracked', current: 'main', branches: [] }
    const { draw } = await start($, on, world)
    const { ui, tree } = await draw()
    expect(text(tree)).toBe('engine')
    await ui.unmount()
  })
})
