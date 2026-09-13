'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { parseLessonMarkdown, type BlockList } from '@knowledge-explorer/content';
import { LessonBody } from '@knowledge-explorer/content/render';
import type { FigureImages } from '@knowledge-explorer/content';
import { ImageDrawer } from './image-drawer';
import { NarrationTab } from './narration-tab';
import { AudioTab } from './audio-tab';
import { figureNumberFromEvent, resolveFigureBlockId } from '../../lib/figure-resolve';
import { lessonImagesPath, type LessonImagesView } from '../../lib/image-types';
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

const tabLabels = { write: 'Write', narration: 'Narration', audio: 'Audio' } as const;

export function LessonEditor({ lessonId, title }: { lessonId: string; title: string }) {
  const [markdown, setMarkdown] = useState('');
  /** The text the server has accepted. Autosave compares against this. */
  const [savedMarkdown, setSavedMarkdown] = useState('');
  const [draftUpdatedAt, setDraftUpdatedAt] = useState<string | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [readOnlyReason, setReadOnlyReason] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  /**
   * The block list the SERVER returned. Distinct from the preview's parse,
   * whose ids are display-only — see lib/figure-resolve.ts.
   */
  const [savedBlockList, setSavedBlockList] = useState<BlockList | null>(null);
  const [images, setImages] = useState<LessonImagesView | null>(null);
  const [drawerBlockId, setDrawerBlockId] = useState<string | null>(null);
  /** A figure clicked while the buffer was dirty, reopened once the save lands. */
  const [pendingFigureNumber, setPendingFigureNumber] = useState<number | null>(null);
  const [tab, setTab] = useState<'write' | 'narration' | 'audio'>('write');
  /**
   * Flush-then-generate, the same two-phase shape the figure path above uses.
   *
   * `useAutosave().flush()` returns void rather than a promise, so it cannot be
   * awaited: the intent is recorded here, `flush()` is called, and an effect
   * fires once the buffer is clean. Unlike the figure path this one can be
   * CANCELLED — a save that fails must enqueue nothing, or the admin pays for a
   * script of a paragraph the server never accepted.
   */
  const [pendingGeneration, setPendingGeneration] = useState<
    'idle' | 'flushing' | 'go' | 'cancelled'
  >('idle');

  const editor = useRef<EditorHandle | null>(null);

  const adopt = useCallback((view: LessonContentView) => {
    setMarkdown(view.markdown);
    setSavedMarkdown(view.markdown);
    setDraftUpdatedAt(view.draftUpdatedAt);
    setCanEdit(view.canEdit);
    setReadOnlyReason(view.readOnlyReason);
    setSavedBlockList(view.blockList);
  }, []);

  const loadImages = useCallback(async () => {
    try {
      setImages(await apiFetch<LessonImagesView>(lessonImagesPath(lessonId)));
    } catch {
      // A failed image load must not stop the editor from opening; the drawer
      // reports its own errors when it is opened.
    }
  }, [lessonId]);

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
      // The authoritative ids the drawer needs come back with every save.
      setSavedBlockList(view.blockList);
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

  /**
   * Figure identity and numbering as the SERVER currently sees it.
   *
   * The images view carries each figure's number, so it goes stale the moment a
   * save renumbers one — insert a figure above an illustrated one and the view
   * still calls the illustrated one Figure 1 while the server now calls it
   * Figure 2. Reloading on exactly this signature refetches when it matters and
   * not on every keystroke.
   */
  const figureSignature = useMemo(
    () =>
      (savedBlockList?.blocks ?? [])
        .filter((block) => block.blockType === 'figure')
        .map((block) => `${block.blockId}:${String(block.figureNumber)}`)
        .join(','),
    [savedBlockList],
  );

  useEffect(() => {
    void loadImages();
  }, [figureSignature, loadImages]);

  /**
   * What the renderer draws into each figure slot: the SELECTED candidate of
   * each figure.
   *
   * JOINED BY FIGURE NUMBER, NOT BY BLOCK ID, and that is load-bearing. The
   * images API is keyed by the SERVER's blockIds, while this preview renders
   * blocks from a LOCAL parse whose ids are display-only (see the `preview`
   * memo below and lib/figure-resolve.ts). The two id spaces coincide only by
   * accident — insert a figure above an illustrated one and they diverge, which
   * draws the picture on the wrong figure.
   *
   * §6.1 makes the figure number a 1-based count within the lesson, assigned
   * during extraction and nowhere else, so it means the same thing in both
   * parses whenever the two agree on the content.
   *
   * While the buffer is dirty they may briefly disagree, and an image can show
   * against a neighbouring figure for the moment between a keystroke and the
   * save landing. That is the same live-approximation bargain P2's preview
   * already makes, and it corrects itself on the next save.
   */
  const figureImages: FigureImages = useMemo(() => {
    const byNumber = new Map<number, { url: string; captionText: string; alternativeText: string }>();
    for (const figure of images?.figures ?? []) {
      const selected = figure.candidates.find((candidate) => candidate.isSelected);
      if (!selected || figure.figureNumber === null) continue;
      byNumber.set(figure.figureNumber, {
        url: selected.url,
        captionText: figure.captionText,
        alternativeText: figure.alternativeText,
      });
    }

    const byLocalBlockId = new Map<string, { url: string; captionText: string; alternativeText: string }>();
    for (const block of blockList.blocks) {
      if (block.blockType !== 'figure' || block.figureNumber === undefined) continue;
      const image = byNumber.get(block.figureNumber);
      if (image) byLocalBlockId.set(block.blockId, image);
    }
    return byLocalBlockId;
  }, [images, blockList]);

  /**
   * Clicking a figure placeholder opens the drawer for that figure.
   *
   * Delegated from the preview container rather than handled inside LessonBody:
   * the renderer is shared with the learner reader (P7) and an editor
   * interaction has no business in it. The markup already carries
   * `data-figure-number`.
   *
   * If the buffer has moved on, the pending save is flushed FIRST and the
   * drawer opens once the authoritative block list comes back — before that,
   * the preview's figure numbers may not be the server's.
   */
  const onPreviewClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const figureNumber = figureNumberFromEvent(event.target);
      if (figureNumber === null) return;

      const blockId = resolveFigureBlockId({
        savedBlockList,
        figureNumber,
        isDirty: autosave.hasUnsavedWork,
        parseOk: preview.ok,
      });

      if (blockId) {
        setDrawerBlockId(blockId);
        return;
      }

      if (autosave.hasUnsavedWork && preview.ok) {
        setPendingFigureNumber(figureNumber);
        autosave.flush();
      }
    },
    [savedBlockList, autosave, preview.ok],
  );

  // The other half of flush-then-open: the save landed, so resolve and open.
  useEffect(() => {
    if (pendingFigureNumber === null || autosave.hasUnsavedWork) return;

    const blockId = resolveFigureBlockId({
      savedBlockList,
      figureNumber: pendingFigureNumber,
      isDirty: false,
      parseOk: preview.ok,
    });
    setPendingFigureNumber(null);
    if (blockId) setDrawerBlockId(blockId);
  }, [pendingFigureNumber, autosave.hasUnsavedWork, savedBlockList, preview.ok]);

  const requestGeneration = useCallback(() => {
    setPendingGeneration('idle');
    if (!autosave.hasUnsavedWork) {
      setPendingGeneration('go');
      return;
    }
    setPendingGeneration('flushing');
    autosave.flush();
  }, [autosave]);

  /**
   * The other half of flush-then-generate.
   *
   * `conflict` and `invalid` are checked BEFORE `hasUnsavedWork`, and that
   * ordering is load-bearing: neither advances `savedValue`, so the buffer stays
   * dirty forever and waiting for it to go clean would leave Generate disabled
   * with no explanation. `retrying` is deliberately not terminal — the save may
   * still land, and SaveStatus is already telling the admin it is retrying.
   */
  useEffect(() => {
    if (pendingGeneration !== 'flushing') return;

    const kind = autosave.state.kind;
    if (kind === 'conflict' || kind === 'invalid') {
      setPendingGeneration('cancelled');
      return;
    }
    if (!autosave.hasUnsavedWork) setPendingGeneration('go');
  }, [pendingGeneration, autosave.hasUnsavedWork, autosave.state.kind]);

  // The tab consumes 'go' exactly once; reset so a second click can arm again.
  // 'cancelled' is left standing, so the tab can explain why nothing happened.
  useEffect(() => {
    if (pendingGeneration !== 'go') return undefined;
    const timer = setTimeout(() => setPendingGeneration('idle'), 0);
    return () => clearTimeout(timer);
  }, [pendingGeneration]);

  // A figure deleted from the markdown must not leave its drawer open over it.
  useEffect(() => {
    if (!drawerBlockId || !savedBlockList) return;
    const stillThere = savedBlockList.blocks.some((block) => block.blockId === drawerBlockId);
    if (!stillThere) setDrawerBlockId(null);
  }, [drawerBlockId, savedBlockList]);

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

      <nav data-testid="lesson-tabs" className="flex gap-2 border-b border-slate-200">
        {(['write', 'narration', 'audio'] as const).map((name) => (
          <button
            key={name}
            type="button"
            data-testid={`tab-${name}`}
            aria-current={tab === name ? 'page' : undefined}
            onClick={() => setTab(name)}
            className={`px-3 py-1 text-sm ${
              tab === name ? 'border-b-2 border-slate-800 font-semibold' : 'text-slate-600'
            }`}
          >
            {tabLabels[name]}
          </button>
        ))}
      </nav>

      {/*
        Only ONE tab is mounted at a time, which is what lets narration and audio
        share `pendingGeneration` without a second state machine: exactly one
        consumer can ever see 'go'.

        Audio flushes the buffer first for the same reason narration does, even
        though it generates from the SCRIPT rather than from the buffer — a dirty
        buffer means the script is about to go stale, and a run started first buys
        audio the next autosave invalidates.
      */}
      {tab === 'narration' ? (
        <NarrationTab
          lessonId={lessonId}
          canEdit={canEdit}
          onGenerateRequested={requestGeneration}
          pendingGeneration={pendingGeneration}
        />
      ) : null}

      {tab === 'audio' ? (
        <AudioTab
          lessonId={lessonId}
          canEdit={canEdit}
          onGenerateRequested={requestGeneration}
          pendingGeneration={pendingGeneration}
        />
      ) : null}

      <div className={tab === 'write' ? 'space-y-3' : 'hidden'}>
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
        <div className="relative">
          <div
            data-testid="preview"
            data-figures-complete={images?.isComplete ?? false}
            onClick={onPreviewClick}
            className="prose min-h-[32rem] max-w-none overflow-auto border border-slate-200 p-4 [&_figure[data-figure-number]]:cursor-pointer"
          >
            <LessonBody blocks={blockList.blocks} images={figureImages} />
          </div>

          {drawerBlockId ? (
            <ImageDrawer
              lessonId={lessonId}
              blockId={drawerBlockId}
              canEdit={canEdit}
              onClose={() => setDrawerBlockId(null)}
              onFiguresChanged={setImages}
            />
          ) : null}
        </div>
      </div>

      <StatusBar blockList={blockList} />
      </div>
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
