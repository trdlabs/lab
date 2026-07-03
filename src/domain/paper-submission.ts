export type PaperSubmissionStatus = 'submitted' | 'rejected' | 'failed';

export interface PaperSubmission {
  id: string;
  experimentId: string;             // UNIQUE — one champion submission per WFO experiment
  strategyProfileId: string;
  submissionStatus: PaperSubmissionStatus;
  candidateId?: string;             // platform OpaqueId (ok:true only)
  admissionStatus?: string;         // admitted | rejected | quarantined | superseded (ok:true only)
  admissionReasonCode?: string;
  error?: Record<string, unknown>;  // {category, code, message} on terminal failed
  idempotencyKey: string;           // UNIQUE
  bundleHash: string;
  params?: Record<string, unknown>; // champion params
  createdAt: string;
  updatedAt: string;
  // Ledger monitor state (paper.monitor slice, all optional)
  strategyName?: string;
  paperRunId?: string;
  runStartedAtMs?: number;
  monitorStatus?: 'watching' | 'window_complete' | 'stalled';
  observedTrades?: number;
  windowPolicy?: Record<string, unknown>;
  lowConfidence?: boolean;
}
