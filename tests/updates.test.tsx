import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { alignmentProblems, all, columns, emit, labels, stackRows, text, type Node } from './tree'
import { clone, kids0, rowOf, STACK, start } from './setup'
import type { World } from './world'

describe('updates', () => {
  test('a newer release shows the update banner above the stack', async ($, on) => {
    const { draw, eng } = await start($, on, clone(STACK), { release: '99.0.0' })
    const { ui, tree } = await draw()
    emit('band', 'update-available', tree)

    expect(text(tree)).toContain('graphite-stack 99.0.0 is available.')
    expect(labels(tree)).toContain('Update')
    expect(eng.toasts.some(t => t.includes('99.0.0'))).toBe(true)
    await ui.press({ key: 'dismiss' })
    expect(text((await ui.drawn()) as unknown as Node)).not.toContain('99.0.0')
    await ui.unmount()
  })

  test('the update button runs the update with the app’s own Claude Code', async ($, on) => {
    const { draw, rec } = await start($, on, clone(STACK), { release: '99.0.0' })
    const { ui } = await draw()
    await ui.press({ key: 'install' })
    const script = rec.calls.find(c => c[0] === 'sh')?.[2] ?? ''
    expect(script).toContain('${CLAUDE_CODE_EXECPATH:-claude}')
    expect(script).toContain('plugin update graphite-stack@adrianjost')
    expect(text((await ui.drawn()) as unknown as Node)).toContain('is installed. Restart Claude Code')
    await ui.unmount()
  })
})
