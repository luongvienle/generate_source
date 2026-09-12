/** Mirrors the narration views from apps/api. The two apps share no code, only shapes. */

export type ScriptStatus = 'pending' | 'generating' | 'ready' | 'stale' | 'failed';

export interface NarrationRowView {
  blockId: string;
  blockType: string;
  text: string;
  figureNumber: number | null;
  tableNumber: number | null;
  narrationText: string | null;
  isEdited: boolean;
  freshness: 'fresh' | 'changed' | 'missing';
}

export interface NarrationScriptView {
  lessonId: string;
  /** Computed, never stored: `stale` exists here and nowhere in the database. */
  status: ScriptStatus | null;
  contentChecksum: string | null;
  sourceContentChecksum: string | null;
  scriptChecksum: string | null;
  reviewedByUserId: string | null;
  reviewedAt: string | null;
  generatorModelName: string | null;
  generatorPromptVersion: string | null;
  totalEstimatedSeconds: number | null;
  errorMessage: string | null;
  rows: NarrationRowView[];
  orphanedSegments: { blockId: string; narrationText: string }[];
  canEdit: boolean;
  readOnlyReason: string | null;
}

export interface IncompleteFigure {
  blockId: string;
  figureNumber: number | null;
  missing: string[];
}

export const narrationScriptPath = (lessonId: string): string =>
  `/admin/lessons/${lessonId}/narration-script`;

export const narrationStalenessPath = (lessonId: string): string =>
  `/admin/lessons/${lessonId}/staleness`;

/** Roughly how long the narration runs, for the header. */
export const formatRuntime = (seconds: number | null): string => {
  if (seconds === null || seconds <= 0) return '—';
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes > 0 ? `${String(minutes)}m ${String(rest)}s` : `${String(rest)}s`;
};
