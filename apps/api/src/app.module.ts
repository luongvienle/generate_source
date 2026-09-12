import { Module } from '@nestjs/common';
import { HealthController } from './health/health.controller';
import { JobsController } from './jobs/jobs.controller';
import { PrismaService } from './prisma/prisma.service';
import { EMAIL_PROVIDER } from './email/email.provider';
import { LogEmailProvider } from './email/log-email.provider';
import { AdminsController, UndeclaredPolicyFixtureController } from './admins/admins.controller';
import { ChaptersController } from './content/chapters.controller';
import { ImportController } from './content/import.controller';
import { CategoriesController } from './content/categories.controller';
import { CoursesController } from './content/courses.controller';
import { StructureService } from './content/structure.service';
import { LessonsController } from './content/lessons.controller';
import { LessonContentController } from './content/lesson-content.controller';
import { LessonContentService } from './content/lesson-content.service';
import { InvitationService } from './auth/invitation.service';
import { AssignmentGuard } from './auth/assignment.guard';
import { PublishedLockGuard } from './auth/published-lock.guard';
import { RolesGuard } from './auth/roles.guard';
import { SessionGuard } from './auth/session.guard';
import { WriteTargetResolver } from './auth/target-resolver';
import { OwnerFieldGuard } from './auth/owner-field.guard';
import { ImportQueue, REDIS_URL } from './jobs/import.queue';
import { JobStatusService } from './jobs/job-status.service';

@Module({
  controllers: [
    HealthController,
    AdminsController,
    UndeclaredPolicyFixtureController,
    ChaptersController,
    LessonsController,
    LessonContentController,
    ImportController,
    CategoriesController,
    CoursesController,
    JobsController,
  ],
  providers: [
    PrismaService,
    { provide: REDIS_URL, useFactory: () => process.env['REDIS_URL'] ?? 'redis://localhost:6380' },
    ImportQueue,
    JobStatusService,
    InvitationService,
    WriteTargetResolver,
    SessionGuard,
    RolesGuard,
    PublishedLockGuard,
    AssignmentGuard,
    OwnerFieldGuard,
    StructureService,
    LessonContentService,
    { provide: EMAIL_PROVIDER, useClass: LogEmailProvider },
  ],
})
export class AppModule {}
