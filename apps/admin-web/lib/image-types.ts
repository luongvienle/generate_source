/** Mirrors the image views from apps/api. The two apps share no code, only shapes. */

export interface ImageCandidateView {
  imageId: string;
  /** Short-lived and presigned; re-read the figure when it expires. */
  url: string;
  imageSource: 'ai_generated' | 'uploaded';
  imagePromptText: string | null;
  imageModelName: string | null;
  imageProviderName: string | null;
  isSelected: boolean;
  createdAt: string;
}

export interface FigureView {
  blockId: string;
  figureNumber: number | null;
  candidates: ImageCandidateView[];
  selectedImageId: string | null;
  captionText: string;
  alternativeText: string;
  isComplete: boolean;
}

export interface LessonImagesView {
  lessonId: string;
  figures: FigureView[];
  isComplete: boolean;
  canEdit: boolean;
  readOnlyReason: string | null;
}

export const lessonImagesPath = (lessonId: string): string =>
  `/admin/lessons/${lessonId}/images`;

export const imagePath = (imageId: string): string => `/admin/images/${imageId}`;

export const generateImagesPath = (lessonId: string): string =>
  `/admin/lessons/${lessonId}/images/generate`;

export const uploadImagePath = (lessonId: string): string =>
  `/admin/lessons/${lessonId}/images/upload`;

/** FR-IMG-01: 2 to 4 candidates. */
export const CANDIDATE_COUNTS = [2, 3, 4] as const;
export const DEFAULT_CANDIDATE_COUNT = 4;
