export interface AgentReviewResult {
  decision: 'APPROVE' | 'REJECT' | 'NEEDS_HUMAN'
  confidence: number
  rationale: string
  signals: { signal: string; weight: number }[]
}

export interface AgentReviewer {
  reviewRefund(refundId: string): Promise<AgentReviewResult>
}