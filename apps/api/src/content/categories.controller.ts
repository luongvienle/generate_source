import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  HttpCode,
  Inject,
  Post,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { RequirePermission } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { SessionGuard } from '../auth/session.guard';

const createCategorySchema = z.strictObject({
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  displayName: z.string().min(1),
  description: z.string().min(1).optional(),
  coverImageUrl: z.string().url().optional(),
  displayOrder: z.int().nonnegative().optional(),
});

/**
 * §9.2 POST /categories. Owner-only by §3.
 *
 * Import upserts a category from its payload's slug and displayName; this route
 * exists for the fields §9.1 does not carry — description, cover image and
 * display order.
 */
@Controller('admin/categories')
@UseGuards(SessionGuard, RolesGuard)
export class CategoriesController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  @Post()
  @RequirePermission('createCategoriesAndCourses')
  @HttpCode(201)
  async create(@Body() body: unknown) {
    const parsed = createCategorySchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        errorCode: 'INVALID_BODY',
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }

    try {
      return await this.prisma.client.category.create({
        data: parsed.data,
        select: { id: true, slug: true, displayName: true, displayOrder: true },
      });
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') {
        throw new ConflictException({ errorCode: 'CATEGORY_SLUG_TAKEN', slug: parsed.data.slug });
      }
      throw error;
    }
  }
}
