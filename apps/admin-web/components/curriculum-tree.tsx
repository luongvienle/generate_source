'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ApiError, apiFetch } from '../lib/api';
import { toStructurePayload, type AdminSummary, type CourseTree, type TreeChapter } from '../lib/tree-types';

/**
 * FR-EDIT-04: add, delete and reorder chapters and lessons.
 *
 * Reordering sends ONE request carrying the complete new order — never one per
 * item — which is why every move funnels through `reorder` below.
 *
 * The assignment control is rendered only for the owner. That is presentation,
 * not enforcement: OwnerFieldGuard refuses assignedAdminId from an admin
 * regardless of what this component renders (R-01's "enforced server-side, not
 * by hiding buttons" applies just as much here).
 */
export function CurriculumTree({
  courseId,
  isOwner,
}: {
  courseId: string;
  isOwner: boolean;
}) {
  const [tree, setTree] = useState<CourseTree | null>(null);
  const [admins, setAdmins] = useState<AdminSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setTree(await apiFetch<CourseTree>(`/admin/courses/${courseId}/structure`));
    } catch (caught) {
      setError(describe(caught));
    }
  }, [courseId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!isOwner) return;
    apiFetch<AdminSummary[]>('/admin/admins')
      .then(setAdmins)
      .catch(() => setAdmins([]));
  }, [isOwner]);

  async function act(work: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await work();
      await load();
    } catch (caught) {
      setError(describe(caught));
    } finally {
      setBusy(false);
    }
  }

  /** Every reorder, whatever moved, is one PATCH carrying the whole tree. */
  const reorder = (chapters: TreeChapter[]) =>
    act(() =>
      apiFetch(`/admin/courses/${courseId}/structure`, {
        method: 'PATCH',
        body: JSON.stringify(toStructurePayload(chapters)),
      }),
    );

  function moveChapter(index: number, delta: number) {
    if (!tree) return;
    const next = [...tree.chapters];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    setTree({ ...tree, chapters: next });
    void reorder(next);
  }

  function moveLesson(chapterIndex: number, lessonIndex: number, delta: number) {
    if (!tree) return;
    const chapters = tree.chapters.map((chapter) => ({
      ...chapter,
      lessons: [...chapter.lessons],
    }));
    const lessons = chapters[chapterIndex]!.lessons;
    const target = lessonIndex + delta;
    if (target < 0 || target >= lessons.length) return;
    [lessons[lessonIndex], lessons[target]] = [lessons[target]!, lessons[lessonIndex]!];
    setTree({ ...tree, chapters });
    void reorder(chapters);
  }

  if (error && !tree) return <p role="alert">{error}</p>;
  if (!tree) return <p>Loading…</p>;

  return (
    <section data-testid="curriculum-tree">
      <h1>{tree.title}</h1>
      <p>
        <code>{tree.slug}</code> — {tree.publicationStatus}
        {tree.hasUnpublishedChanges ? ' (has unpublished changes)' : ''}
      </p>

      {error ? (
        <p role="alert" data-testid="tree-error" style={{ color: '#b00' }}>
          {error}
        </p>
      ) : null}

      <button
        type="button"
        data-testid="add-chapter"
        disabled={busy}
        onClick={() =>
          void act(() =>
            apiFetch('/admin/chapters', {
              method: 'POST',
              body: JSON.stringify({
                courseId,
                chapterOrder: tree.chapters.length + 1,
                title: 'New chapter',
              }),
            }),
          )
        }
      >
        Add chapter
      </button>

      <ol data-testid="chapters">
        {tree.chapters.map((chapter, chapterIndex) => (
          <li key={chapter.id} data-testid="chapter" data-chapter-id={chapter.id}>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <EditableTitle
                value={chapter.title}
                testId="chapter-title"
                disabled={busy}
                onSave={(title) =>
                  act(() =>
                    apiFetch(`/admin/chapters/${chapter.id}`, {
                      method: 'PATCH',
                      body: JSON.stringify({ title }),
                    }),
                  )
                }
              />
              <button
                type="button"
                data-testid="chapter-up"
                disabled={busy || chapterIndex === 0}
                onClick={() => moveChapter(chapterIndex, -1)}
                aria-label={`Move ${chapter.title} up`}
              >
                ↑
              </button>
              <button
                type="button"
                data-testid="chapter-down"
                disabled={busy || chapterIndex === tree.chapters.length - 1}
                onClick={() => moveChapter(chapterIndex, 1)}
                aria-label={`Move ${chapter.title} down`}
              >
                ↓
              </button>
              {isOwner ? (
                <AssignControl
                  admins={admins}
                  value={chapter.assignedAdminId}
                  testId="chapter-assign"
                  disabled={busy}
                  onChange={(assignedAdminId) =>
                    act(() =>
                      apiFetch(`/admin/chapters/${chapter.id}`, {
                        method: 'PATCH',
                        body: JSON.stringify({ assignedAdminId }),
                      }),
                    )
                  }
                />
              ) : null}
              <button
                type="button"
                data-testid="chapter-delete"
                disabled={busy}
                onClick={() =>
                  void act(() =>
                    apiFetch(`/admin/chapters/${chapter.id}`, { method: 'DELETE' }),
                  )
                }
              >
                Delete
              </button>
            </div>

            <ol data-testid="lessons">
              {chapter.lessons.map((lesson, lessonIndex) => (
                <li key={lesson.id} data-testid="lesson" data-lesson-id={lesson.id}>
                  <EditableTitle
                    value={lesson.title}
                    testId="lesson-title"
                    disabled={busy}
                    onSave={(title) =>
                      act(() =>
                        apiFetch(`/admin/lessons/${lesson.id}`, {
                          method: 'PATCH',
                          body: JSON.stringify({ title }),
                        }),
                      )
                    }
                  />
                  <span style={{ color: '#666' }}> ({lesson.contentStatus})</span>
                  <Link
                    href={`/courses/${courseId}/lessons/${lesson.id}`}
                    data-testid="lesson-edit"
                  >
                    Edit content
                  </Link>
                  <button
                    type="button"
                    data-testid="lesson-up"
                    disabled={busy || lessonIndex === 0}
                    onClick={() => moveLesson(chapterIndex, lessonIndex, -1)}
                    aria-label={`Move ${lesson.title} up`}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    data-testid="lesson-down"
                    disabled={busy || lessonIndex === chapter.lessons.length - 1}
                    onClick={() => moveLesson(chapterIndex, lessonIndex, 1)}
                    aria-label={`Move ${lesson.title} down`}
                  >
                    ↓
                  </button>
                  {isOwner ? (
                    <AssignControl
                      admins={admins}
                      value={lesson.assignedAdminId}
                      testId="lesson-assign"
                      disabled={busy}
                      onChange={(assignedAdminId) =>
                        act(() =>
                          apiFetch(`/admin/lessons/${lesson.id}`, {
                            method: 'PATCH',
                            body: JSON.stringify({ assignedAdminId }),
                          }),
                        )
                      }
                    />
                  ) : null}
                  <button
                    type="button"
                    data-testid="lesson-delete"
                    disabled={busy}
                    onClick={() =>
                      void act(() => apiFetch(`/admin/lessons/${lesson.id}`, { method: 'DELETE' }))
                    }
                  >
                    Delete
                  </button>
                </li>
              ))}
            </ol>

            <button
              type="button"
              data-testid="add-lesson"
              disabled={busy}
              onClick={() =>
                void act(() =>
                  apiFetch('/admin/lessons', {
                    method: 'POST',
                    body: JSON.stringify({
                      chapterId: chapter.id,
                      lessonOrder: chapter.lessons.length + 1,
                      title: 'New lesson',
                    }),
                  }),
                )
              }
            >
              Add lesson
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}

function EditableTitle({
  value,
  testId,
  disabled,
  onSave,
}: {
  value: string;
  testId: string;
  disabled: boolean;
  onSave: (title: string) => Promise<unknown>;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  return (
    <input
      data-testid={testId}
      aria-label={`Title: ${value}`}
      value={draft}
      disabled={disabled}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft.trim() !== '' && draft !== value) void onSave(draft);
      }}
    />
  );
}

function AssignControl({
  admins,
  value,
  testId,
  disabled,
  onChange,
}: {
  admins: AdminSummary[];
  value: string | null;
  testId: string;
  disabled: boolean;
  onChange: (assignedAdminId: string | null) => Promise<unknown>;
}) {
  return (
    <select
      data-testid={testId}
      aria-label="Assigned admin"
      value={value ?? ''}
      disabled={disabled}
      onChange={(event) => void onChange(event.target.value === '' ? null : event.target.value)}
    >
      <option value="">Unassigned</option>
      {admins.map((admin) => (
        <option key={admin.id} value={admin.id}>
          {admin.name ?? admin.email}
        </option>
      ))}
    </select>
  );
}

function describe(caught: unknown): string {
  if (caught instanceof ApiError) {
    return caught.failure.reason ?? caught.failure.errorCode ?? `Request failed`;
  }
  return (caught as Error).message;
}
