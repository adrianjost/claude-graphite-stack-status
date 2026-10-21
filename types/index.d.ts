export type LinkTarget = 'github' | 'graphite'

export type DiffFile = {
  path: string
  added: number
  removed: number
  hunks: string
  isTooLarge: boolean
  isBinary: boolean
  isNew: boolean
  isGenerated: boolean
}

export type DiffView = {
  branch: string
  parent: string
  trunk: string
  compareTo: 'parent' | 'trunk'
  showWhitespace: boolean
  title: string
  url?: string
  root: string
  headSha?: string
  commits: { sha: string; subject: string }[]
  files: DiffFile[]
  collapsed: string[]
  isLoading: boolean
  error?: string
}

export type Issue = {
  message: string
  detail?: string
  fix?: { label: string; prompt: string }
  canFix?: false
}

export type CiState = 'pass' | 'fail' | 'pending' | 'none'

export type PrInfo = {
  number: number
  title: string
  url: string
  state: string
  isDraft: boolean
  reviewDecision: string
  labels: { name: string; color: string; description?: string }[]
  ci: CiState
  ciCounts: { pass: number; fail: number; pending: number }
  failing: { name: string; workflow?: string; url?: string }[]
  openThreads: number
  hasReviewers: boolean
}

export type Lane = {
  col: number
  up: boolean
  down: boolean
  pipes: number[]
  corners: number[]
}

export type StackRow = {
  branch: string
  parent?: string
  lane: Lane
  isCurrent: boolean
  isTrunk: boolean
  needsRestack: boolean
  pr?: PrInfo
  diff?: { added: number; removed: number }
}

export type StackSnapshot = {
  branch: string
  rows: StackRow[]
  columns: number
  updatedAt: number
  isStale?: boolean
  issue?: Issue
  githubIssue?: Issue
  isLoading: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'graphite-stack': { snapshot: StackSnapshot; isHidden: boolean; linkTarget: LinkTarget; diffView: DiffView | null }
  }
}
