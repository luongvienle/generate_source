/** Mirrors the audio views from apps/api. The two apps share no code, only shapes. */

export type AudioStatus = 'pending' | 'generating' | 'ready' | 'stale' | 'failed';

export interface AudioRowView {
  blockId: string;
  segmentOrder: number;
  narrationText: string;
  figureNumber: number | null;
  tableNumber: number | null;
  startMillisecond: number | null;
  endMillisecond: number | null;
  freshness: 'fresh' | 'stale' | 'missing';
}

export interface AudioView {
  lessonId: string;
  /** Computed, never stored: `stale` exists here and nowhere in the database. */
  status: AudioStatus | null;
  /** Short-lived and presigned. The server never returns the stored key. */
  mergedAudioUrl: string | null;
  totalDurationSeconds: number | null;
  totalCharacterCount: number | null;
  voiceIdentifier: string | null;
  voiceProviderName: string | null;
  configuredVoiceIdentifier: string;
  errorMessage: string | null;
  rows: AudioRowView[];
  orphanedSegmentBlockIds: string[];
  /** Why Generate is refused right now, as an errorCode, or null if it is not. */
  blockedReason: string | null;
  canEdit: boolean;
  readOnlyReason: string | null;
}

export const audioPath = (lessonId: string): string => `/admin/lessons/${lessonId}/audio`;

/** mm:ss for a duration the admin reads beside the player. */
export const formatDuration = (seconds: number | null): string => {
  if (seconds === null || seconds <= 0) return '—';
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${String(minutes)}:${String(rest).padStart(2, '0')}`;
};

/**
 * How many segments a run would pay for, and how many it would reuse.
 *
 * Shown in the regeneration confirmation, because it is the admin's only view of
 * what a run costs — FR-AUDIO-01's saving is invisible otherwise.
 */
export const runCost = (rows: readonly AudioRowView[]): { synthesize: number; reuse: number } => {
  const synthesize = rows.filter((row) => row.freshness !== 'fresh').length;
  return { synthesize, reuse: rows.length - synthesize };
};
