import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { structurePayloadSchema } from '@knowledge-explorer/shared';
import { PrismaService } from '../prisma/prisma.service';

/**
 * FR-LRN-02 and FR-LRN-03: progress, resume and percentages.
 *
 * §7.4: "`lesson_progress` is never deleted on expiry. Expiry blocks reading
 * only. Preserved progress is the strongest reason a learner renews." Nothing
 * in this file deletes a row, and `/me/courses` lists expired courses rather
 * than hiding them.
 */

export interface ProgressInput {
  readonly completed: boolean;
  readonly scrollPercentage: number;
  readonly audioPositionMs: number;
}

export interface ProgressView {
  readonly completed: boolean;
  readonly scrollPercentage: number;
  readonly audioPositionMs: number;
}

export interface MyCourseView {
  readonly courseSlug: string;
  readonly courseTitle: string;
  readonly levelLabel: string;
  readonly categoryName: string;
  readonly categorySlug: string;
  readonly completedLessonCount: number;
  readonly totalLessonCount: number;
  readonly progressPercentage: number;
  readonly expiresAt: string | null;
  readonly daysRemaining: number | null;
  readonly isExpired: boolean;
  readonly resumeLessonId: string | null;
  readonly resumeLessonTitle: string | null;
}

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

@Injectable()
export class ProgressService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async read(userId: string, lessonId: string): Promise<ProgressView> {
    const row = await this.prisma.client.lessonProgress.findUnique({
      where: { userId_lessonId: { userId, lessonId } },
      select: { progressStatus: true, lastScrollPercentage: true, lastAudioPositionMs: true },
    });

    return {
      completed: row?.progressStatus === 'completed',
      scrollPercentage: row?.lastScrollPercentage ?? 0,
      audioPositionMs: row?.lastAudioPositionMs ?? 0,
    };
  }

  /**
   * FR-LRN-02's write, upserted on `(userId, lessonId)` — the pair §8 makes
   * unique, so a learner has exactly one progress row per lesson however many
   * times they revisit it.
   *
   * `completedAt` is set once and never cleared while completion stands, so
   * un-completing and re-completing does not rewrite history the learner never
   * asked to change.
   */
  async write(userId: string, lessonId: string, input: ProgressInput): Promise<ProgressView> {
    const lesson = await this.prisma.client.lesson.findUnique({
      where: { id: lessonId },
      select: { id: true, deletedAt: true },
    });
    if (!lesson || lesson.deletedAt) throw new NotFoundException({ errorCode: 'LESSON_NOT_FOUND' });

    const progressStatus = input.completed
      ? 'completed'
      : input.scrollPercentage > 0 || input.audioPositionMs > 0
        ? 'in_progress'
        : 'not_started';

    const data = {
      progressStatus,
      lastScrollPercentage: input.scrollPercentage,
      lastAudioPositionMs: input.audioPositionMs,
      completedAt: input.completed ? new Date() : null,
      updatedAt: new Date(),
    };

    const row = await this.prisma.client.lessonProgress.upsert({
      where: { userId_lessonId: { userId, lessonId } },
      create: { userId, lessonId, ...data },
      update: data,
      select: { progressStatus: true, lastScrollPercentage: true, lastAudioPositionMs: true },
    });

    return {
      completed: row.progressStatus === 'completed',
      scrollPercentage: row.lastScrollPercentage,
      audioPositionMs: row.lastAudioPositionMs,
    };
  }

  /**
   * §9.4's `/me/courses`: "Owned courses with progress, `expiresAt` and
   * `daysRemaining`".
   *
   * Lists every course the learner holds a grant for, ACTIVE OR NOT. §7.4: "An
   * expired course stays visible in My courses with an expired badge, its
   * progress percentage, and a repurchase action. It is not hidden." Hiding it
   * would hide the progress that is the reason to renew.
   *
   * A revoked grant IS excluded — revocation is the owner withdrawing access
   * rather than a term running out, and §7.4's "stays visible" is about expiry.
   */
  async myCourses(userId: string): Promise<readonly MyCourseView[]> {
    const grants = await this.prisma.client.accessGrant.findMany({
      where: { userId, revokedAt: null },
      select: {
        scopeType: true,
        scopeCourseId: true,
        scopeCategoryId: true,
        expiresAt: true,
        gracePeriodDays: true,
      },
    });
    if (grants.length === 0) return [];

    const courseIds = grants
      .filter((grant) => grant.scopeCourseId !== null)
      .map((grant) => grant.scopeCourseId as string);
    const categoryIds = grants
      .filter((grant) => grant.scopeCategoryId !== null)
      .map((grant) => grant.scopeCategoryId as string);

    const courses = await this.prisma.client.course.findMany({
      where: {
        publicationStatus: 'published',
        OR: [{ id: { in: courseIds } }, { categoryId: { in: categoryIds } }],
      },
      select: {
        id: true,
        slug: true,
        title: true,
        levelLabel: true,
        categoryId: true,
        category: { select: { slug: true, displayName: true } },
        publishedStructure: { select: { structurePayload: true } },
      },
    });

    const now = Date.now();
    const views: MyCourseView[] = [];

    for (const course of courses) {
      /**
       * The widest window any grant gives for this course. A learner holding
       * both a course grant and a category bundle keeps access until the later
       * of the two runs out, and a perpetual grant (owner-granted, §7.2) wins
       * outright.
       */
      const covering = grants.filter(
        (grant) => grant.scopeCourseId === course.id || grant.scopeCategoryId === course.categoryId,
      );
      const perpetual = covering.some((grant) => grant.expiresAt === null);
      const latestEnd = perpetual
        ? null
        : covering.reduce<Date | null>((latest, grant) => {
            if (!grant.expiresAt) return latest;
            const end = new Date(grant.expiresAt.getTime() + grant.gracePeriodDays * MILLISECONDS_PER_DAY);
            return latest === null || end > latest ? end : latest;
          }, null);
      const nearestExpiry = perpetual
        ? null
        : covering.reduce<Date | null>((latest, grant) => {
            if (!grant.expiresAt) return latest;
            return latest === null || grant.expiresAt > latest ? grant.expiresAt : latest;
          }, null);

      const isExpired = latestEnd !== null && latestEnd.getTime() <= now;

      /**
       * FR-LRN-03's denominator comes from the SNAPSHOT, so the percentage
       * agrees with the table of contents the learner is looking at.
       */
      const parsed = course.publishedStructure
        ? structurePayloadSchema.safeParse(course.publishedStructure.structurePayload)
        : null;
      const snapshotLessons = parsed?.success
        ? parsed.data.chapters.flatMap((chapter) => chapter.lessons)
        : [];
      const lessonIds = snapshotLessons.map((lesson) => lesson.lessonId);

      const [completedCount, resume] = await Promise.all([
        lessonIds.length === 0
          ? Promise.resolve(0)
          : this.prisma.client.lessonProgress.count({
              where: { userId, lessonId: { in: lessonIds }, progressStatus: 'completed' },
            }),
        lessonIds.length === 0
          ? Promise.resolve(null)
          : this.prisma.client.lessonProgress.findFirst({
              where: { userId, lessonId: { in: lessonIds } },
              orderBy: { updatedAt: 'desc' },
              select: { lessonId: true },
            }),
      ]);

      const total = snapshotLessons.length;
      views.push({
        courseSlug: course.slug,
        courseTitle: course.title,
        levelLabel: course.levelLabel,
        categoryName: course.category.displayName,
        categorySlug: course.category.slug,
        completedLessonCount: completedCount,
        totalLessonCount: total,
        progressPercentage: total === 0 ? 0 : Math.round((completedCount / total) * 100),
        expiresAt: nearestExpiry?.toISOString() ?? null,
        daysRemaining:
          latestEnd === null
            ? null
            : Math.ceil((latestEnd.getTime() - now) / MILLISECONDS_PER_DAY),
        isExpired,
        resumeLessonId: resume?.lessonId ?? null,
        resumeLessonTitle:
          snapshotLessons.find((lesson) => lesson.lessonId === resume?.lessonId)?.title ?? null,
      });
    }

    return views.sort((a, b) => a.courseTitle.localeCompare(b.courseTitle));
  }
}
