import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getPrismaClient } from '@knowledge-explorer/database';
import { LessonEditor } from '../../../../../../components/editor/lesson-editor';

/**
 * FR-EDIT-01: the lesson authoring screen, reached from the P1 curriculum tree.
 *
 * The lesson title comes from `lessons.title` and is never derived from the
 * body — §6.1's block list deliberately does not carry it.
 */
export default async function LessonEditorPage({
  params,
}: {
  params: Promise<{ courseId: string; lessonId: string }>;
}) {
  const { courseId, lessonId } = await params;

  const lesson = await getPrismaClient().lesson.findFirst({
    where: { id: lessonId, deletedAt: null },
    select: { id: true, title: true, chapter: { select: { title: true } } },
  });
  if (!lesson) notFound();

  return (
    <>
      <p>
        <Link href={`/courses/${courseId}`}>← Curriculum</Link> · {lesson.chapter.title}
      </p>
      <LessonEditor lessonId={lesson.id} title={lesson.title} />
    </>
  );
}
