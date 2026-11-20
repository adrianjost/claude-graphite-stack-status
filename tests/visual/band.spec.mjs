// Screenshots every band the plugin tests drew (tests/.out/band/*.json), in light and dark.
import { expect, test } from '@playwright/test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { bandHtml } from './band-html.mjs'

const dir = 'tests/.out/band'
const names = existsSync(dir) ? readdirSync(dir).map(f => f.replace(/\.json$/, '')) : []

test('the plugin tests drew bands', () => {
  expect(names.length, 'run `npm test`, which runs the plugin tests first').toBeGreaterThan(5)
})

for (const name of names) {
  for (const scheme of ['light', 'dark']) {
    test(`band ${name} (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme })
      await page.setContent(bandHtml(JSON.parse(readFileSync(`${dir}/${name}.json`, 'utf8'))))
      await expect(page.locator('[data-unknown]'), 'an element the renderer does not know').toHaveCount(0)
      await expect(page.locator('#band')).toHaveScreenshot(`${name}-${scheme}.png`)
    })
  }
}
