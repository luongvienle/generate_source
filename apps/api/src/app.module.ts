import { Module, type DynamicModule } from '@nestjs/common';
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
import { PublishingController } from './content/publishing.controller';
import { PublishingService } from './content/publishing.service';
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
import { LearnerSessionGuard } from './auth/learner-session.guard';
import { WriteTargetResolver } from './auth/target-resolver';
import { OwnerFieldGuard } from './auth/owner-field.guard';
import { ImportQueue, REDIS_URL } from './jobs/import.queue';
import { ImageQueue } from './jobs/image.queue';
import { NarrationQueue } from './jobs/narration.queue';
import { NarrationController } from './content/narration.controller';
import { NarrationService } from './content/narration.service';
import { AudioQueue } from './jobs/audio.queue';
import { PublishQueue } from './jobs/publish.queue';
import { AudioController } from './content/audio.controller';
import { AudioService } from './content/audio.service';
import { JobStatusService } from './jobs/job-status.service';
import { JobWatchGuard } from './jobs/job-watch.guard';
import { OBJECT_STORAGE, S3ObjectStorage, s3ConfigFromEnv } from '@knowledge-explorer/storage';
import { TEXT_TO_SPEECH_PROVIDER, createTextToSpeechProvider } from '@knowledge-explorer/ai';
import { PublicCatalogController } from './public/catalog.controller';
import { CatalogService } from './public/catalog.service';
import { PublicLessonsController } from './public/lessons.controller';
import { PublicMediaController } from './public/media.controller';
import { PublicMeController } from './public/me.controller';
import { ProgressService } from './public/progress.service';
import { ReaderService } from './public/reader.service';
import { PublicTopicRequestsController } from './public/topic-requests.controller';
import { TopicRequestsLearnerController } from './public/topic-requests-learner.controller';
import { TopicRequestsService } from './public/topic-requests.service';
import { TopicRequestsAdminController } from './topic-requests/topic-requests-admin.controller';
import { TopicRequestsAdminService } from './topic-requests/topic-requests-admin.service';
import { ProductsController } from './commerce/products.controller';
import { ProductsService } from './commerce/products.service';
import { GrantsAdminController } from './commerce/grants-admin.controller';
import { GrantsAdminService } from './commerce/grants-admin.service';
import { CheckoutController } from './commerce/checkout.controller';
import { CheckoutService } from './commerce/checkout.service';
import { PaymentWebhookController } from './commerce/webhook.controller';
import { PurchaseService } from './commerce/purchase.service';
import { FakePaymentPageController } from './commerce/fake-payment-page.controller';
import { DiscountCodesController } from './commerce/discount-codes.controller';
import { DiscountCodesService } from './commerce/discount-codes.service';
import { OrdersAdminController } from './commerce/orders-admin.controller';
import { createPaymentProvider } from './commerce/payment-provider.factory';
import { PAYMENT_PROVIDER } from '@knowledge-explorer/commerce';

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
    PublishingController,
    JobsController,
    CourseStreamController,
    /**
     * §9.4's public surface. These two carry NO guard and NO permission, which
     * is deliberate and is asserted by entitlement-gates.e2e-spec.ts — see the
     * note on PublicLessonsController. §7.3's resolver in packages/commerce
     * gates them instead, and E-01 requires it on both.
     */
    PublicCatalogController,
    PublicLessonsController,
    PublicMediaController,
    PublicMeController,
    /**
     * FR-REQ-01's board. Same treatment, same reason: PublicTopicRequestsController
     * carries no guard and no permission because §9.4's read surface is
     * anonymous, and topic-requests.e2e-spec.ts asserts that absence by name.
     * Its learner-authenticated twin is a separate class so a class-level guard
     * cannot reach the board.
     */
    PublicTopicRequestsController,
    TopicRequestsLearnerController,
    TopicRequestsAdminController,
    /** P8a commerce (specs/p8a-commerce/spec.md): the owner's products and manual grants. */
    ProductsController,
    GrantsAdminController,
    DiscountCodesController,
    OrdersAdminController,
    CheckoutController,
    /**
     * FR-COM-03's webhook. NO guard and NO permission: the caller is a payment
     * gateway and its credential is the signature over the raw body. Asserted by
     * name in commerce-webhook.e2e-spec.ts, like the public controllers above.
     */
    PaymentWebhookController,
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
    PublishQueue,
    JobStatusService,
    JobWatchGuard,
    InvitationService,
    WriteTargetResolver,
    SessionGuard,
    LearnerSessionGuard,
    RolesGuard,
    PublishedLockGuard,
    AssignmentGuard,
    OwnerFieldGuard,
    StructureService,
    PublishingService,
    LessonContentService,
    ImagesService,
    ReaderService,
    CatalogService,
    ProgressService,
    TopicRequestsService,
    TopicRequestsAdminService,
    ProductsService,
    GrantsAdminService,
    DiscountCodesService,
    CheckoutService,
    PurchaseService,
    /**
     * §11's PaymentProvider. Selected by environment once, at startup — and,
     * unlike the image, LLM and TTS providers, NOT defaulting to its fake: an unset
     * PAYMENT_PROVIDER closes the store rather than giving access away. See
     * commerce/payment-provider.factory.ts.
     */
    { provide: PAYMENT_PROVIDER, useFactory: () => createPaymentProvider() },
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
export class AppModule {
  /**
   * AppModule plus the fake payment provider's hosted checkout page.
   *
   * CHOSEN AT BOOTSTRAP, NOT AT IMPORT. main.ts imports this file before it loads
   * `.env`, so a `controllers` array that read PAYMENT_PROVIDER here would see an
   * empty environment and the page would never register in development — with
   * nothing to say why. main.ts selects this form after `loadEnv`, when
   * `isFakePaymentEnabled()`; tests that exercise the page import it explicitly.
   *
   * Registration is only the first layer: the controller also answers a bare 404
   * unless the bound provider is the fake.
   */
  static withFakePaymentPage(): DynamicModule {
    return { module: AppModule, controllers: [FakePaymentPageController] };
  }
}
