import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { alignmentProblems, all, columns, emit, labels, stackRows, text, type Node } from './tree'
import { clone, kids0, rowOf, STACK, start } from './setup'
import type { World } from './world'

describe('branches without a stack', () => {
  test('a plain git branch is shown with a note, without Sync', async ($, on) => {
    const world: World = { kind: 'untracked', current: 'adrian/quick-fix', branches: [{ name: 'adrian/quick-fix', parent: 'main', added: 4, removed: 1 }] }
    const { draw, rec } = await start($, on, world)
    const { ui, tree } = await draw()
    emit('band', 'untracked', tree)

    expect(rec.unknown).toEqual([])
    expect(text(tree)).toContain('not tracked by Graphite')
    expect(labels(kids0(tree))).not.toContain('Sync with main')
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
