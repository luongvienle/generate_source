import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config as loadEnv } from 'dotenv';
import { getPrismaClient } from '@knowledge-explorer/database';
import { AppModule } from '../src/app.module';

loadEnv({ path: ['../../.env', '.env'] });

/**
 * §9.4's catalog endpoints, and §4.3's guarantee that the draft track is
 * invisible.
 *
 * The assertions that matter most here are the negative ones. A catalog that
 * lists a draft course is not a cosmetic bug — it is the published/unpublished
 * split failing, which is the one thing §4.3 exists to provide.
 */

const run = randomBytes(4).toString('hex');
const prisma = getPrismaClient();
const api = () => request(app.getHttpServer());

let app: INestApplication;
let ownerId = '';
let categoryId = '';
let emptyCategoryId = '';
let levelOrder = 0;

const slugs = {
  published: `cat-${run}-published`,
  draft: `cat-${run}-draft`,
  unpublished: `cat-${run}-unpublished`,
  archived: `cat-${run}-archived`,
  paid: `cat-${run}-paid`,
};

const categorySlug = `cat-${run}`;
const emptyCategorySlug = `cat-empty-${run}`;

async function seedCourse(options: {
  slug: string;
  title: string;
  status: string;
  overview?: string | null;
  pricingType?: string;
  inCategoryId?: string;
}): Promise<string> {
  levelOrder += 1;
  const course = await prisma.course.create({
    data: {
      categoryId: options.inCategoryId ?? categoryId,
      slug: options.slug,
      levelLabel: `N${levelOrder}`,
      levelOrder,
      title: options.title,
      overviewSummary: options.overview ?? null,
      pricingType: options.pricingType ?? 'free',
      publicationStatus: options.status,
      coverImageUrl: 'https://cdn.example.test/cover.png',
      publishedAt: options.status === 'published' ? new Date() : null,
    },
    select: { id: true },
  });

  if (options.status === 'published') {
    const chapter = await prisma.chapter.create({
      data: { courseId: course.id, chapterOrder: 1, title: 'Chương 1' },
      select: { id: true },
    });
    const lesson = await prisma.lesson.create({
      data: { chapterId: chapter.id, lessonOrder: 1, title: 'Bài 1', estimatedMinutes: 10 },
      select: { id: true },
    });
    await prisma.publishedCourseStructure.create({
      data: {
        courseId: course.id,
        publishedVersionNumber: 1,
        totalLessonCount: 1,
        publishedByUserId: ownerId,
        structurePayload: {
          courseId: course.id,
          publishedVersionNumber: 1,
          totalLessonCount: 1,
          chapters: [
            {
              chapterId: chapter.id,
              order: 1,
              title: 'Chương 1',
              description: null,
              lessons: [
                {
                  lessonId: lesson.id,
                  order: 1,
                  title: 'Bài 1',
                  estimatedMinutes: 10,
                  isFreePreview: false,
                  hasAudio: false,
                  audioDurationSeconds: null,
                  figureCount: 0,
                },
              ],
            },
          ],
        } as object,
      },
    });
  }

  return course.id;
}

beforeAll(async () => {
  const owner = await prisma.user.create({
    data: { email: `owner-cat-${run}@example.test`, name: 'Owner', userRole: 'admin_owner' },
    select: { id: true },
  });
  ownerId = owner.id;

  const category = await prisma.category.create({
    data: { slug: categorySlug, displayName: `Tiếng Nhật ${run}`, displayOrder: 1 },
    select: { id: true },
  });
  categoryId = category.id;

  const emptyCategory = await prisma.category.create({
    data: { slug: emptyCategorySlug, displayName: `Trống ${run}`, displayOrder: 2 },
    select: { id: true },
  });
  emptyCategoryId = emptyCategory.id;

  await seedCourse({
    slug: slugs.published,
    title: `Sơ cấp ${run}`,
    status: 'published',
    overview: 'Khoá học dành cho người mới bắt đầu học bảng chữ cái.',
  });
  await seedCourse({ slug: slugs.draft, title: `Bản nháp ${run}`, status: 'draft' });
  await seedCourse({ slug: slugs.unpublished, title: `Đã gỡ ${run}`, status: 'unpublished' });
  await seedCourse({ slug: slugs.archived, title: `Lưu trữ ${run}`, status: 'archived' });
  await seedCourse({
    slug: slugs.paid,
    title: `Trung cấp ${run}`,
    status: 'published',
    pricingType: 'paid',
    overview: 'Ngữ pháp nâng cao.',
  });
  // A course in the second category, so that category has something published
  // and its own "in development" sibling below has something to contrast with.
  await seedCourse({
    slug: `cat-${run}-other`,
    title: `Khác ${run}`,
    status: 'draft',
    inCategoryId: emptyCategoryId,
  });

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api', { exclude: ['health'] });
  await app.init();
});

afterAll(async () => {
  await app?.close();
  await prisma.publishedCourseStructure.deleteMany({ where: { publishedByUserId: ownerId } });
  await prisma.product.deleteMany({ where: { createdByUserId: ownerId } });
  await prisma.course.deleteMany({ where: { categoryId: { in: [categoryId, emptyCategoryId] } } });
  await prisma.category.deleteMany({ where: { id: { in: [categoryId, emptyCategoryId] } } });
  await prisma.user.delete({ where: { id: ownerId } });
});

describe('§4.3: the draft track is invisible', () => {
  it('lists published courses only', async () => {
    // Scoped to this run's category: the suites share one database and every
    // earlier phase leaves published courses behind, so an unfiltered listing
    // asserts nothing about THIS seed. The filter is the subject of its own
    // test below; here it is isolation.
    const response = await api()
      .get('/api/courses')
      .query({ category: categorySlug, pageSize: 50 })
      .expect(200);
    const listed = (response.body as { courses: { slug: string }[] }).courses.map((c) => c.slug);

    expect(listed).toContain(slugs.published);
    expect(listed).toContain(slugs.paid);
    expect(listed).not.toContain(slugs.draft);
    expect(listed).not.toContain(slugs.unpublished);
    expect(listed).not.toContain(slugs.archived);
  });

  it('404s a draft course by slug', async () => {
    const response = await api().get(`/api/courses/${slugs.draft}`).expect(404);
    expect((response.body as { errorCode: string }).errorCode).toBe('COURSE_NOT_PUBLISHED');
  });

  it('404s an unpublished course by slug, preserving its grants underneath', async () => {
    // FR-PUB-04: unpublishing removes the course from the catalog; grants and
    // progress survive, which is why this is a 404 and not a delete.
    await api().get(`/api/courses/${slugs.unpublished}`).expect(404);
  });

  it('404s an archived course by slug', async () => {
    await api().get(`/api/courses/${slugs.archived}`).expect(404);
  });

  it('never returns a draft column on the course page', async () => {
    const response = await api().get(`/api/courses/${slugs.published}`).expect(200);
    const raw = JSON.stringify(response.body);
    expect(raw).not.toContain('draftContentMarkdown');
    expect(raw).not.toContain('draftBlockList');
    expect(raw).not.toContain('publicationStatus');
  });
});

describe('FR-CAT-01: search and pagination', () => {
  it('matches on course title', async () => {
    const response = await api().get('/api/courses').query({ search: `Sơ cấp ${run}` }).expect(200);
    const body = response.body as { courses: { slug: string }[]; total: number };
    expect(body.courses.map((c) => c.slug)).toEqual([slugs.published]);
    expect(body.total).toBe(1);
  });

  it('matches on overview summary', async () => {
    const response = await api().get('/api/courses').query({ search: 'Ngữ pháp nâng cao' }).expect(200);
    expect((response.body as { courses: { slug: string }[] }).courses.map((c) => c.slug)).toEqual([
      slugs.paid,
    ]);
  });

  it('matches on category name, returning every published course in it', async () => {
    const response = await api()
      .get('/api/courses')
      .query({ search: `Tiếng Nhật ${run}`, pageSize: 50 })
      .expect(200);
    const listed = (response.body as { courses: { slug: string }[] }).courses.map((c) => c.slug);
    expect(listed).toContain(slugs.published);
    expect(listed).toContain(slugs.paid);
  });

  it('is case-insensitive', async () => {
    const lower = await api().get('/api/courses').query({ search: 'ngữ pháp' }).expect(200);
    const upper = await api().get('/api/courses').query({ search: 'NGỮ PHÁP' }).expect(200);
    expect((lower.body as { total: number }).total).toBe(1);
    expect((upper.body as { total: number }).total).toBe(1);
  });

  it('reports a total independent of the page size', async () => {
    const response = await api()
      .get('/api/courses')
      .query({ search: `Tiếng Nhật ${run}`, pageSize: 1, page: 1 })
      .expect(200);
    const body = response.body as { courses: unknown[]; total: number; pageSize: number };
    expect(body.courses).toHaveLength(1);
    expect(body.total).toBe(2);
    expect(body.pageSize).toBe(1);
  });

  it('returns the second page', async () => {
    const first = await api()
      .get('/api/courses')
      .query({ search: `Tiếng Nhật ${run}`, pageSize: 1, page: 1 })
      .expect(200);
    const second = await api()
      .get('/api/courses')
      .query({ search: `Tiếng Nhật ${run}`, pageSize: 1, page: 2 })
      .expect(200);

    const slugOf = (body: unknown) => (body as { courses: { slug: string }[] }).courses[0]?.slug;
    expect(slugOf(first.body)).not.toBe(slugOf(second.body));
  });

  it('refuses an unbounded page size', async () => {
    await api().get('/api/courses').query({ pageSize: 5000 }).expect(400);
  });

  it('refuses an unknown query parameter rather than ignoring it', async () => {
    // strictObject: a typo'd filter must fail loudly, not silently list all.
    await api().get('/api/courses').query({ categorySlug: 'oops' }).expect(400);
  });

  it('filters by category', async () => {
    const response = await api()
      .get('/api/courses')
      .query({ category: categorySlug, pageSize: 50 })
      .expect(200);
    expect((response.body as { total: number }).total).toBe(2);
  });
});

describe('FR-CAT-02: the category page', () => {
  it('lists published levels with a link and in-development levels without one', async () => {
    const response = await api().get(`/api/categories/${categorySlug}`).expect(200);
    const levels = (response.body as { levels: { title: string; isPublished: boolean; slug: string | null }[] })
      .levels;

    const published = levels.find((level) => level.slug === slugs.published);
    expect(published?.isPublished).toBe(true);

    const draft = levels.find((level) => level.title === `Bản nháp ${run}`);
    expect(draft).toBeDefined();
    expect(draft?.isPublished).toBe(false);
    // §5.8: "shown as 'in development' with no link". No slug means no route.
    expect(draft?.slug).toBeNull();
  });

  it('omits archived levels entirely', async () => {
    const response = await api().get(`/api/categories/${categorySlug}`).expect(200);
    const titles = (response.body as { levels: { title: string }[] }).levels.map((l) => l.title);
    // §4.2 hides archived courses; an archived level is gone, not forthcoming.
    expect(titles).not.toContain(`Lưu trữ ${run}`);
  });

  it('404s an unknown category', async () => {
    await api().get(`/api/categories/does-not-exist-${run}`).expect(404);
  });
});

describe('FR-CAT-01: the category list', () => {
  it('counts published courses and omits categories with none', async () => {
    const response = await api().get('/api/categories').expect(200);
    const rows = response.body as { slug: string; publishedCourseCount: number }[];

    const mine = rows.find((row) => row.slug === categorySlug);
    expect(mine?.publishedCourseCount).toBe(2);
    // The second category holds one draft course and nothing else.
    expect(rows.find((row) => row.slug === emptyCategorySlug)).toBeUndefined();
  });
});

describe('FR-CAT-03: the course page', () => {
  it('serves metadata from courses and the table of contents from the snapshot', async () => {
    const response = await api().get(`/api/courses/${slugs.published}`).expect(200);
    const body = response.body as {
      title: string;
      categoryName: string;
      structure: { totalLessonCount: number; chapters: { lessons: unknown[] }[] } | null;
    };

    expect(body.title).toBe(`Sơ cấp ${run}`);
    expect(body.categoryName).toBe(`Tiếng Nhật ${run}`);
    expect(body.structure?.totalLessonCount).toBe(1);
    expect(body.structure?.chapters[0]?.lessons).toHaveLength(1);
  });

  it('renders no price block while no product exists', async () => {
    // P8 inserts products. Until then the block is absent rather than a
    // placeholder, so P8 turns it on with no change here.
    const response = await api().get(`/api/courses/${slugs.paid}`).expect(200);
    const body = response.body as { singleCourseOffer: unknown; bundleOffer: unknown };
    expect(body.singleCourseOffer).toBeNull();
    expect(body.bundleOffer).toBeNull();
  });

  it('renders the price block once an active product exists', async () => {
    const product = await prisma.product.create({
      data: {
        productType: 'single_course',
        courseId: (await prisma.course.findUniqueOrThrow({
          where: { slug: slugs.paid },
          select: { id: true },
        })).id,
        displayName: 'Trung cấp',
        priceAmount: '1200000.00',
        currencyCode: 'VND',
        createdByUserId: ownerId,
      },
      select: { id: true },
    });

    const response = await api().get(`/api/courses/${slugs.paid}`).expect(200);
    const offer = (response.body as { singleCourseOffer: { priceAmount: string; currencyCode: string } | null })
      .singleCourseOffer;

    // Decimal(12,2) crosses the wire as a string; a float would not survive it.
    expect(offer?.priceAmount).toBe('1200000');
    expect(offer?.currencyCode).toBe('VND');

    await prisma.product.delete({ where: { id: product.id } });
  });

  it('ignores an inactive product', async () => {
    const courseId = (
      await prisma.course.findUniqueOrThrow({ where: { slug: slugs.paid }, select: { id: true } })
    ).id;
    const product = await prisma.product.create({
      data: {
        productType: 'single_course',
        courseId,
        displayName: 'Trung cấp',
        priceAmount: '1200000.00',
        createdByUserId: ownerId,
        isActive: false,
      },
      select: { id: true },
    });

    const response = await api().get(`/api/courses/${slugs.paid}`).expect(200);
    expect((response.body as { singleCourseOffer: unknown }).singleCourseOffer).toBeNull();

    await prisma.product.delete({ where: { id: product.id } });
  });
});

describe('§9.4: the catalog is anonymous', () => {
  it('serves every catalog endpoint with no session at all', async () => {
    await api().get('/api/categories').expect(200);
    await api().get(`/api/categories/${categorySlug}`).expect(200);
    await api().get('/api/courses').expect(200);
    await api().get(`/api/courses/${slugs.published}`).expect(200);
  });
});
