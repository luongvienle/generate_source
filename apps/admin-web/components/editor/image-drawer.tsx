'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, apiFetch, apiUpload } from '../../lib/api';
import { JobProgress } from '../job-progress';
import {
  CANDIDATE_COUNTS,
  DEFAULT_CANDIDATE_COUNT,
  generateImagesPath,
  imagePath,
  lessonImagesPath,
  uploadImagePath,
  type FigureView,
  type LessonImagesView,
} from '../../lib/image-types';

/**
 * FR-IMG-01 to FR-IMG-03 for one figure block.
 *
 * Opens over the preview pane from a click on the figure's placeholder. It is
 * scoped to ONE block: `blockId` is the server's, resolved by the editor before
 * this ever renders (see lib/figure-resolve.ts).
 *
 * Generation does not block editing — FR-IMG-01 — so nothing here disables the
 * left pane while a job runs.
 */

const errorMessages: Record<string, string> = {
  IMAGE_TYPE_UNSUPPORTED: 'That file is not a PNG, JPEG, WebP or SVG.',
  IMAGE_TOO_LARGE: 'That file is larger than 5 MB.',
  IMAGE_BLOCK_NOT_FOUND: 'This figure is no longer in the lesson. Save and reopen it.',
  FORBIDDEN_COURSE_PUBLISHED: 'This course is published, so only the owner can change it (R-01).',
  FORBIDDEN_NOT_ASSIGNED: 'This lesson is assigned to another admin (R-02).',
};

const describe = (caught: unknown): string => {
  if (caught instanceof ApiError) {
    return errorMessages[caught.failure.errorCode ?? ''] ?? `Request failed (${caught.failure.status}).`;
  }
  return caught instanceof Error ? caught.message : String(caught);
};

export function ImageDrawer({
  lessonId,
  blockId,
  canEdit,
  onClose,
  onFiguresChanged,
}: {
  lessonId: string;
  blockId: string;
  canEdit: boolean;
  onClose: () => void;
  onFiguresChanged: (view: LessonImagesView) => void;
}) {
  const [figure, setFigure] = useState<FigureView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  const [candidateCount, setCandidateCount] = useState<number>(DEFAULT_CANDIDATE_COUNT);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    try {
      const view = await apiFetch<LessonImagesView>(lessonImagesPath(lessonId));
      onFiguresChanged(view);
      setFigure(view.figures.find((candidate) => candidate.blockId === blockId) ?? null);
      setError(null);
    } catch (caught) {
      setError(describe(caught));
    }
    // onFiguresChanged is an inline closure in the caller; re-running on every
    // render would refetch forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lessonId, blockId]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Escape closes, which is what a drawer over a pane should do. */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await load();
    } catch (caught) {
      setError(describe(caught));
    } finally {
      setBusy(false);
    }
  };

  const select = (imageId: string) =>
    run(() =>
      apiFetch(imagePath(imageId), {
        method: 'PATCH',
        body: JSON.stringify({ isSelected: true }),
      }),
    );

  const saveText = (changes: { captionText?: string; alternativeText?: string }) => {
    if (!figure?.selectedImageId) return;
    void run(() =>
      apiFetch(imagePath(figure.selectedImageId as string), {
        method: 'PATCH',
        body: JSON.stringify(changes),
      }),
    );
  };

  const generate = () =>
    run(async () => {
      const response = await apiFetch<{ jobId: string }>(generateImagesPath(lessonId), {
        method: 'POST',
        body: JSON.stringify({ blockReferenceId: blockId, imagePromptText: prompt, candidateCount }),
      });
      setJobId(response.jobId);
    });

  const upload = (file: File) =>
    run(() => {
      const form = new FormData();
      form.append('blockReferenceId', blockId);
      form.append('file', file);
      return apiUpload(uploadImagePath(lessonId), form);
    });

  const disabled = !canEdit || busy;

  return (
    <aside
      data-testid="image-drawer"
      data-block-id={blockId}
      aria-label={`Figure ${figure?.figureNumber ?? ''} images`}
      className="absolute inset-0 z-10 flex flex-col gap-3 overflow-auto border border-slate-300 bg-white p-4 shadow-lg"
    >
      <header className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">
          Figure {figure?.figureNumber ?? '—'}
          {figure?.isComplete ? (
            <span data-testid="figure-complete" className="ml-2 text-sm text-green-700">
              ✓ complete
            </span>
          ) : (
            <span data-testid="figure-incomplete" className="ml-2 text-sm text-amber-700">
              needs an image, caption and alt text
            </span>
          )}
        </h2>
        <button type="button" onClick={onClose} data-testid="close-drawer" className="px-2 py-1">
          Close
        </button>
      </header>

      {!canEdit ? (
        <p role="status" className="rounded border border-slate-300 bg-slate-50 px-3 py-2 text-sm">
          Read-only. You can see this figure&apos;s images but not change them.
        </p>
      ) : null}

      {error ? (
        <p role="alert" data-testid="drawer-error" className="text-sm text-red-700">
          {error}
        </p>
      ) : null}

      <section data-testid="candidates" className="grid grid-cols-2 gap-3">
        {figure?.candidates.length === 0 ? (
          <p className="col-span-2 text-sm text-slate-600">No images yet.</p>
        ) : null}
        {figure?.candidates.map((candidate) => (
          <figure
            key={candidate.imageId}
            data-testid="candidate"
            data-selected={candidate.isSelected}
            className={`border p-2 ${candidate.isSelected ? 'border-blue-600' : 'border-slate-200'}`}
          >
            {/* Always an <img>: never inline SVG, so an uploaded SVG cannot execute. */}
            <img src={candidate.url} alt="" className="h-32 w-full object-contain" />
            <figcaption className="mt-1 flex items-center justify-between text-xs">
              <span>{candidate.imageSource === 'uploaded' ? 'Uploaded' : candidate.imageModelName}</span>
              <button
                type="button"
                data-testid="select-candidate"
                disabled={disabled || candidate.isSelected}
                onClick={() => void select(candidate.imageId)}
                className="border px-2 py-0.5 disabled:opacity-50"
              >
                {candidate.isSelected ? 'Selected' : 'Select'}
              </button>
            </figcaption>
          </figure>
        ))}
      </section>

      <section className="flex flex-col gap-2">
        <label className="text-sm font-medium" htmlFor="image-prompt">
          Prompt
        </label>
        <textarea
          id="image-prompt"
          data-testid="image-prompt"
          value={prompt}
          disabled={disabled}
          onChange={(event) => setPrompt(event.target.value)}
          rows={3}
          className="border border-slate-300 p-2 text-sm"
        />
        <div className="flex items-center gap-2">
          <label htmlFor="candidate-count" className="text-sm">
            Candidates
          </label>
          <select
            id="candidate-count"
            data-testid="candidate-count"
            value={candidateCount}
            disabled={disabled}
            onChange={(event) => setCandidateCount(Number(event.target.value))}
            className="border border-slate-300 p-1 text-sm"
          >
            {CANDIDATE_COUNTS.map((count) => (
              <option key={count} value={count}>
                {count}
              </option>
            ))}
          </select>
          <button
            type="button"
            data-testid="generate-images"
            disabled={disabled || prompt.trim().length === 0}
            onClick={() => void generate()}
            className="border px-3 py-1 text-sm disabled:opacity-50"
          >
            Generate
          </button>

          <input
            ref={fileInput}
            type="file"
            data-testid="upload-image"
            accept="image/png,image/jpeg,image/webp,image/svg+xml"
            disabled={disabled}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void upload(file);
              // Clear, so re-choosing the same file fires change again.
              event.target.value = '';
            }}
            className="text-sm"
          />
        </div>

        {/* Reloads the candidate list when the job settles. */}
        <JobProgress jobId={jobId} onSettled={() => void load()} />
      </section>

      <section className="flex flex-col gap-2">
        <label className="text-sm font-medium" htmlFor="caption-text">
          Caption
        </label>
        <input
          id="caption-text"
          data-testid="caption-text"
          defaultValue={figure?.captionText ?? ''}
          key={`caption-${figure?.selectedImageId ?? 'none'}-${figure?.captionText ?? ''}`}
          disabled={disabled || !figure?.selectedImageId}
          onBlur={(event) => saveText({ captionText: event.target.value })}
          className="border border-slate-300 p-2 text-sm"
        />

        <label className="text-sm font-medium" htmlFor="alt-text">
          Alt text
        </label>
        <input
          id="alt-text"
          data-testid="alt-text"
          defaultValue={figure?.alternativeText ?? ''}
          key={`alt-${figure?.selectedImageId ?? 'none'}-${figure?.alternativeText ?? ''}`}
          disabled={disabled || !figure?.selectedImageId}
          onBlur={(event) => saveText({ alternativeText: event.target.value })}
          className="border border-slate-300 p-2 text-sm"
        />
        {/* §5.4: both feed the narration generator, so they must describe the
            picture rather than name it. */}
        <p className="text-xs text-slate-600">
          Both are read aloud by the narration generator, so describe what the image shows — not
          just what it is called.
        </p>
      </section>
    </aside>
  );
}
