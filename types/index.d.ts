export type LinkTarget = 'github' | 'graphite'

export type UpdateInfo = { version: string; url: string; state: 'available' | 'updating' | 'installed' }

export type WaitingPrompt = string | { text: string; branch?: string; refs?: string[] }

export type ReviewReply = { status?: 'fixed' | 'replied'; text?: string; from?: string; to?: string; ref?: string }

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
  threadFp?: string
  hasReviewers: boolean
  reviewers?: { name: string; state: string }[]
  bodyHtml?: string
}

export type Lane = {
  col: number
  up: boolean
  down: boolean
  pipes: number[]
  corners: number[]
  pipeOwners?: string[]
  cornerOwners?: string[]
  upOwner?: string
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
  hold?: string
  issue?: Issue
  githubIssue?: Issue
  isLoading: boolean
}

declare module 'claude-code' {
  interface McpToolInputs {
    'mcp__graphite-stack__review_reply': { fixed?: string[]; replies?: { ref: string; text: string }[] }
  }
  interface PluginState {
    'graphite-stack': { snapshot: StackSnapshot; isHidden: boolean; linkTarget: LinkTarget; working: string | null; reviewUrl: string | null; waitingPrompts: WaitingPrompt[]; reviewReplies: Record<string, ReviewReply>; updateInfo: UpdateInfo | null }
  }
}
