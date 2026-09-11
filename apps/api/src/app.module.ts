import { Module } from '@nestjs/common';
import { HealthController } from './health/health.controller';
import { PrismaService } from './prisma/prisma.service';
import { EMAIL_PROVIDER } from './email/email.provider';
import { LogEmailProvider } from './email/log-email.provider';
import { AdminsController, UndeclaredPolicyFixtureController } from './admins/admins.controller';
import { ChaptersController } from './content/chapters.controller';
import { LessonsController } from './content/lessons.controller';
import { InvitationService } from './auth/invitation.service';
import { AssignmentGuard } from './auth/assignment.guard';
import { PublishedLockGuard } from './auth/published-lock.guard';
import { RolesGuard } from './auth/roles.guard';
import { SessionGuard } from './auth/session.guard';
import { WriteTargetResolver } from './auth/target-resolver';

@Module({
  controllers: [
    HealthController,
    AdminsController,
    UndeclaredPolicyFixtureController,
    ChaptersController,
    LessonsController,
  ],
  providers: [
    PrismaService,
    InvitationService,
    WriteTargetResolver,
    SessionGuard,
    RolesGuard,
    PublishedLockGuard,
    AssignmentGuard,
    { provide: EMAIL_PROVIDER, useClass: LogEmailProvider },
  ],
})
export class AppModule {}
