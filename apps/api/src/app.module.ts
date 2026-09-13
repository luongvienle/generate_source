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
import { AudioQueue } from './jobs/audio.queue';
import { AudioController } from './content/audio.controller';
import { AudioService } from './content/audio.service';
import { JobStatusService } from './jobs/job-status.service';
import { JobWatchGuard } from './jobs/job-watch.guard';
import { OBJECT_STORAGE, S3ObjectStorage, s3ConfigFromEnv } from '@knowledge-explorer/storage';
import { TEXT_TO_SPEECH_PROVIDER, createTextToSpeechProvider } from '@knowledge-explorer/ai';

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
    AudioController,
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
    AudioQueue,
    AudioService,
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
    /**
     * §11's TextToSpeechProvider. Selected by environment ONCE at startup, so a
     * TTS_PROVIDER=openai with no key fails the boot rather than discovering it
     * on the first paid call. The API needs it only for `maxInputCharacters`,
     * which is what lets a too-long segment be refused before any job exists.
     */
    { provide: TEXT_TO_SPEECH_PROVIDER, useFactory: () => createTextToSpeechProvider() },
  ],
})
export class AppModule {}
