import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'tests/visual',
  outputDir: 'tests/.out/results',
  snapshotPathTemplate: 'tests/visual/screenshots/{testFileName}/{arg}{ext}',
  fullyParallel: true,
  reporter: [['list']],
  expect: { toHaveScreenshot: { maxDiffPixels: 30, animations: 'disabled', caret: 'hide' } },
  use: { browserName: 'chromium', viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, colorScheme: 'light' },
})
