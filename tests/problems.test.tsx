import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { alignmentProblems, all, columns, emit, labels, stackRows, text, type Node } from './tree'
import { clone, kids0, rowOf, STACK, start } from './setup'
import type { World } from './world'

describe('problems', () => {
  test('GitHub being unreachable shows a warning and keeps the stack', async ($, on) => {
    const world = { ...clone(STACK), githubDown: true }
    const { draw } = await start($, on, world)
    const { ui, tree } = await draw()
    emit('band', 'github-down', tree)

    expect(text(tree)).toContain('⚠')
    expect(stackRows(tree)).toHaveLength(4)
    expect(alignmentProblems(tree)).toEqual([])
    await ui.unmount()
  })

  test('a missing gt or git shows how to fix it', async ($, on) => {
    const world = clone(STACK)
    world.override = argv => (argv[0] === 'sqlite3' ? 'missing' : undefined)
    const { draw } = await start($, on, world)
    const { ui, tree } = await draw()
    emit('band', 'missing-tool', tree)
    expect(text(tree)).toContain("sqlite3 isn't installed")
    expect(labels(tree)).toContain('Fix')
    await ui.unmount()
  })
})
