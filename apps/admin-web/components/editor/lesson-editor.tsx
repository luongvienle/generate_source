'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { parseLessonMarkdown, type BlockList } from '@knowledge-explorer/content';
import { LessonBody } from '@knowledge-explorer/content/render';
import { ApiError, apiFetch } from '../../lib/api';
import {
  lessonContentPath,
  type LessonContentError,
  type LessonContentView,
} from '../../lib/content-types';
import { useAutosave } from '../../lib/useAutosave';
import type { EditorHandle } from './markdown-editor';
import { Toolbar } from './toolbar';
import { SaveStatus, ValidationErrors } from './save-status';
import { StatusBar } from './status-bar';

/**
 * FR-EDIT-01: the markdown editor with live preview.
 *
 * The preview parses IN THE BROWSER with the same packages/content parser the
 * server uses, so it is instant and keeps working while a save is in flight or
 * failing. The server reparses independently on PUT and its block list is the
 * only one stored — this parse is display-only.
 *
 * Read-only mode is likewise display-only. `canEdit` comes from the server,
 * which computes it from the same facts R-01 and R-02 use, and the PUT refuses
 * independently of anything rendered here.
 */

const MarkdownEditor = dynamic(
  () => import('./markdown-editor').then((module) => module.MarkdownEditor),
  { ssr: false, loading: () => <div className="min-h-[32rem] border border-slate-200 p-2">Loading editor…</div> },
);

const emptyBlockList: BlockList = { blocks: [], nextBlockSeq: 1 };

export function LessonEditor({ lessonId, title }: { lessonId: string; title: string }) {
  const [markdown, setMarkdown] = useState('');
  /** The text the server has accepted. Autosave compares against this. */
  const [savedMarkdown, setSavedMarkdown] = useState('');
  const [draftUpdatedAt, setDraftUpdatedAt] = useState<string | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [readOnlyReason, setReadOnlyReason] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const editor = useRef<EditorHandle | null>(null);

  const adopt = useCallback((view: LessonContentView) => {
    setMarkdown(view.markdown);
    setSavedMarkdown(view.markdown);
    setDraftUpdatedAt(view.draftUpdatedAt);
    setCanEdit(view.canEdit);
    setReadOnlyReason(view.readOnlyReason);
  }, []);

  const load = useCallback(async () => {
    try {
      adopt(await apiFetch<LessonContentView>(lessonContentPath(lessonId)));
    } catch (caught) {
      setLoadError(describe(caught));
    } finally {
      setLoaded(true);
    }
  }, [adopt, lessonId]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(
    (value: string) =>
      apiFetch<LessonContentView>(lessonContentPath(lessonId), {
        method: 'PUT',
        body: JSON.stringify({ markdown: value, expectedDraftUpdatedAt: draftUpdatedAt }),
      }),
    [lessonId, draftUpdatedAt],
  );

  const autosave = useAutosave<LessonContentView>({
    value: markdown,
    savedValue: savedMarkdown,
    save,
    onSaved: (view) => {
      setSavedMarkdown(view.markdown);
      setDraftUpdatedAt(view.draftUpdatedAt);
    },
    onConflict: () => {
      // The server's version travels with the 409; the admin chooses when to
      // take it, so nothing is overwritten behind their back.
    },
    enabled: canEdit && loaded,
  });

  /** FR-EDIT-03: leaving with work the server has not accepted asks first. */
  useEffect(() => {
    if (!autosave.hasUnsavedWork) return;

    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [autosave.hasUnsavedWork]);

  /**
   * The live preview. Parsed from `null` rather than the stored block list: ids
   * shown here are display-only, and the authoritative ones come back from the
   * server on save.
   */
  const preview = useMemo(() => parseLessonMarkdown(markdown, null), [markdown]);
  const blockList = preview.ok ? preview.blockList : emptyBlockList;

  const localErrors: readonly LessonContentError[] = preview.ok ? [] : preview.errors;
  const serverErrors = autosave.state.kind === 'invalid' ? autosave.state.errors : [];
  const errors = localErrors.length > 0 ? localErrors : serverErrors;

  if (!loaded) return <p>Loading…</p>;
  if (loadError) return <p role="alert">{loadError}</p>;

  return (
    <section data-testid="lesson-editor" data-wide className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">{title}</h1>
        <SaveStatus state={autosave.state} onReload={() => void load()} />
      </div>

      {!canEdit ? <ReadOnlyBanner reason={readOnlyReason} /> : null}

      <Toolbar editor={editor} disabled={!canEdit} />
      <ValidationErrors errors={errors} />

      <div className="grid grid-cols-2 gap-4 items-start">
        <MarkdownEditor
          value={markdown}
          onChange={setMarkdown}
          onBlur={autosave.flush}
          readOnly={!canEdit}
          handleRef={editor}
        />
        <div
          data-testid="preview"
          className="prose min-h-[32rem] max-w-none overflow-auto border border-slate-200 p-4"
        >
          <LessonBody blocks={blockList.blocks} />
        </div>
      </div>

      <StatusBar blockList={blockList} />
    </section>
  );
}

const readOnlyMessages: Record<string, string> = {
  FORBIDDEN_COURSE_PUBLISHED:
    'This course is published, so only the owner can edit it (R-01). You can read it here.',
  FORBIDDEN_NOT_ASSIGNED:
    'This lesson is assigned to another admin, so you cannot edit it (R-02). You can read it here.',
};

function ReadOnlyBanner({ reason }: { reason: string | null }) {
  return (
    <p
      role="status"
      data-testid="read-only-banner"
      className="rounded border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-700"
    >
      {(reason && readOnlyMessages[reason]) ?? 'You do not have permission to edit this lesson.'}
    </p>
  );
}

const describe = (caught: unknown): string =>
  caught instanceof ApiError
    ? (caught.failure.errorCode ?? `Request failed with ${caught.failure.status}`)
    : 'Something went wrong.';
