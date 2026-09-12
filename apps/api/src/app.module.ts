import { Module } from '@nestjs/common';
import { HealthController } from './health/health.controller';
import { JobsController } from './jobs/jobs.controller';
import { CourseStreamController } from './jobs/course-stream.controller';
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
import { ImagesController } from './content/images.controller';
import { ImagesService } from './content/images.service';
import { InvitationService } from './auth/invitation.service';
import { AssignmentGuard } from './auth/assignment.guard';
import { PublishedLockGuard } from './auth/published-lock.guard';
import { RolesGuard } from './auth/roles.guard';
import { SessionGuard } from './auth/session.guard';
import { WriteTargetResolver } from './auth/target-resolver';
import { OwnerFieldGuard } from './auth/owner-field.guard';
import { ImportQueue, REDIS_URL } from './jobs/import.queue';
import { ImageQueue } from './jobs/image.queue';
import { NarrationQueue } from './jobs/narration.queue';
import { NarrationController } from './content/narration.controller';
import { NarrationService } from './content/narration.service';
import { JobStatusService } from './jobs/job-status.service';
import { JobWatchGuard } from './jobs/job-watch.guard';
import { OBJECT_STORAGE, S3ObjectStorage, s3ConfigFromEnv } from '@knowledge-explorer/storage';

@Module({
  controllers: [
    HealthController,
    AdminsController,
    UndeclaredPolicyFixtureController,
    ChaptersController,
    LessonsController,
    LessonContentController,
    ImagesController,
    NarrationController,
    ImportController,
    CategoriesController,
    CoursesController,
    JobsController,
    CourseStreamController,
  ],
  providers: [
    PrismaService,
    { provide: REDIS_URL, useFactory: () => process.env['REDIS_URL'] ?? 'redis://localhost:6380' },
    ImportQueue,
    ImageQueue,
    NarrationQueue,
    NarrationService,
    JobStatusService,
    JobWatchGuard,
    InvitationService,
    WriteTargetResolver,
    SessionGuard,
    RolesGuard,
    PublishedLockGuard,
    AssignmentGuard,
    OwnerFieldGuard,
    StructureService,
    LessonContentService,
    ImagesService,
    { provide: OBJECT_STORAGE, useFactory: () => new S3ObjectStorage(s3ConfigFromEnv()) },
    { provide: EMAIL_PROVIDER, useClass: LogEmailProvider },
  ],
})
export class AppModule {}
