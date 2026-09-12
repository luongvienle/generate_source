import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  blockListChecksum,
  parseLessonMarkdown,
  type BlockList,
  type ParseError,
} from '@knowledge-explorer/content';
import { errorCodes, type UserRole } from '@knowledge-explorer/shared';
import { PrismaService } from '../prisma/prisma.service';

/**
 * §9.3 lesson draft content: the §4.3 draft track, which only admins read and
 * write. Nothing here touches the published columns — P6 owns those.
 */

export interface LessonContentView {
  readonly lessonId: string;
  readonly markdown: string;
  readonly blockList: BlockList;
  readonly draftContentChecksum: string | null;
  readonly draftUpdatedAt: Date | null;
  readonly lastEditedByUserId: string | null;
  readonly contentStatus: string;
  /**
   * Whether THIS caller's write would be accepted, computed server-side from the
   * same facts R-01 and R-02 use.
   *
   * Display only: the editor renders read-only and explains itself rather than
   * letting a save fail mysteriously. The PUT refuses independently, so the UI
   * carries no enforcement.
   */
  readonly canEdit: boolean;
  readonly readOnlyReason: string | null;
}

export type SaveOutcome =
  | { readonly kind: 'saved'; readonly view: LessonContentView }
  /** Byte-identical markdown: nothing written, draft_updated_at not advanced. */
  | { readonly kind: 'unchanged'; readonly view: LessonContentView }
  | { readonly kind: 'invalid'; readonly errors: readonly ParseError[] }
  | { readonly kind: 'conflict'; readonly view: LessonContentView };

export interface Editor {
  readonly userId: string;
  readonly userRole: UserRole;
}

const emptyBlockList: BlockList = { blocks: [], nextBlockSeq: 1 };

/** §8 stores the block list as JSONB; Prisma hands it back as `unknown`. */
export const readBlockList = (value: unknown): BlockList => {
  if (value && typeof value === 'object' && 'blocks' in value && 'nextBlockSeq' in value) {
    return value as BlockList;
  }
  return emptyBlockList;
};

interface LessonRow {
  id: string;
  contentStatus: string;
  assignedAdminId: string | null;
  chapter: { course: { id: string; publicationStatus: string } };
}

@Injectable()
export class LessonContentService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  private async loadLesson(lessonId: string): Promise<LessonRow> {
    const lesson = await this.prisma.client.lesson.findFirst({
      where: { id: lessonId, deletedAt: null },
      select: {
        id: true,
        contentStatus: true,
        assignedAdminId: true,
        chapter: { select: { course: { select: { id: true, publicationStatus: true } } } },
      },
    });
    if (!lesson) throw new NotFoundException({ errorCode: 'LESSON_NOT_FOUND' });
    return lesson;
  }

  /**
   * Mirrors PublishedLockGuard then AssignmentGuard, in that order, so the reason
   * the editor shows is the reason the PUT would actually give.
   */
  private static resolveEditability(
    lesson: LessonRow,
    editor: Editor,
  ): { canEdit: boolean; readOnlyReason: string | null } {
    if (editor.userRole === 'admin_owner') return { canEdit: true, readOnlyReason: null };

    if (lesson.chapter.course.publicationStatus === 'published') {
      return { canEdit: false, readOnlyReason: errorCodes.FORBIDDEN_COURSE_PUBLISHED };
    }
    if (lesson.assignedAdminId !== null && lesson.assignedAdminId !== editor.userId) {
      return { canEdit: false, readOnlyReason: errorCodes.FORBIDDEN_NOT_ASSIGNED };
    }
    return { canEdit: true, readOnlyReason: null };
  }

  private async view(lesson: LessonRow, editor: Editor): Promise<LessonContentView> {
    const content = await this.prisma.client.lessonContent.findUnique({
      where: { lessonId: lesson.id },
      select: {
        draftContentMarkdown: true,
        draftBlockList: true,
        draftContentChecksum: true,
        draftUpdatedAt: true,
        lastEditedByUserId: true,
      },
    });

    return {
      lessonId: lesson.id,
      markdown: content?.draftContentMarkdown ?? '',
      blockList: readBlockList(content?.draftBlockList),
      draftContentChecksum: content?.draftContentChecksum ?? null,
      draftUpdatedAt: content?.draftUpdatedAt ?? null,
      lastEditedByUserId: content?.lastEditedByUserId ?? null,
      contentStatus: lesson.contentStatus,
      ...LessonContentService.resolveEditability(lesson, editor),
    };
  }

  async read(lessonId: string, editor: Editor): Promise<LessonContentView> {
    return this.view(await this.loadLesson(lessonId), editor);
  }

  /**
   * FR-EDIT-02: saving parses the markdown into the block list and stores both.
   *
   * The server reparses rather than accepting a block list from the client. The
   * editor's own parse is display-only; this result is the one that is stored.
   */
  async save(
    lessonId: string,
    markdown: string,
    expectedDraftUpdatedAt: Date | null,
    editor: Editor,
  ): Promise<SaveOutcome> {
    const lesson = await this.loadLesson(lessonId);
    const current = await this.view(lesson, editor);

    // Byte-identical markdown is a no-op. The test is on the MARKDOWN, not the
    // checksum: a whitespace-only edit leaves the checksum alone but must still
    // be persisted, or the admin loses their formatting on reload.
    if (current.markdown === markdown) return { kind: 'unchanged', view: current };

    // Optimistic concurrency. A first save sends null and succeeds only when no
    // row exists yet.
    const storedAt = current.draftUpdatedAt?.getTime() ?? null;
    const expectedAt = expectedDraftUpdatedAt?.getTime() ?? null;
    if (storedAt !== expectedAt) return { kind: 'conflict', view: current };

    const parsed = parseLessonMarkdown(markdown, current.blockList);
    if (!parsed.ok) return { kind: 'invalid', errors: parsed.errors };

    const blockList = parsed.blockList;
    const checksum = blockListChecksum(blockList);
    const now = new Date();

    const becomesDrafting = lesson.contentStatus === 'empty' && markdown.trim().length > 0;
    // §4.3: the learner still sees the last published snapshot, so P6 needs to
    // know a republish is warranted. Only a change the learner would notice —
    // that is, a changed checksum — counts.
    const raisesUnpublishedFlag =
      lesson.chapter.course.publicationStatus === 'published' &&
      checksum !== current.draftContentChecksum;

    await this.prisma.client.$transaction(async (tx) => {
      const data = {
        draftContentMarkdown: markdown,
        draftBlockList: blockList as unknown as object,
        draftContentChecksum: checksum,
        lastEditedByUserId: editor.userId,
        draftUpdatedAt: now,
      };
      await tx.lessonContent.upsert({
        where: { lessonId },
        create: { lessonId, ...data },
        update: data,
      });

      if (becomesDrafting) {
        await tx.lesson.update({ where: { id: lessonId }, data: { contentStatus: 'drafting' } });
      }
      if (raisesUnpublishedFlag) {
        await tx.course.update({
          where: { id: lesson.chapter.course.id },
          data: { hasUnpublishedChanges: true },
        });
      }
    });

    return { kind: 'saved', view: await this.read(lessonId, editor) };
  }
}
