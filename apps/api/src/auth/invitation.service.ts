import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EMAIL_PROVIDER, type EmailProvider } from '../email/email.provider';

const INVITATION_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Creates the single-use sign-in link FR-AUTH-01 requires.
 *
 * The raw token is emailed; only its hash is stored, so a database reader
 * cannot mint a session. The hash is sha256(token + AUTH_SECRET), which is
 * Auth.js's documented scheme.
 *
 * COUPLING TO VERIFY IN TASK 10: the Auth.js version wired into admin-web must
 * hash verification tokens the same way, or links minted here will not be
 * consumable. If it differs, mint invitations through the library instead of
 * changing the scheme here.
 */
@Injectable()
export class InvitationService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(EMAIL_PROVIDER) private readonly email: EmailProvider,
  ) {}

  async sendInvitation(emailAddress: string): Promise<void> {
    const secret = process.env['AUTH_SECRET'];
    if (!secret) throw new Error('AUTH_SECRET is not set; cannot mint a sign-in link.');

    const token = randomBytes(32).toString('hex');
    const hashedToken = createHash('sha256').update(`${token}${secret}`).digest('hex');

    await this.prisma.client.verificationToken.create({
      data: {
        identifier: emailAddress,
        token: hashedToken,
        expires: new Date(Date.now() + INVITATION_TTL_MS),
      },
    });

    const baseUrl = process.env['AUTH_URL'] ?? 'http://localhost:3000';
    const url =
      `${baseUrl}/api/auth/callback/email` +
      `?token=${encodeURIComponent(token)}&email=${encodeURIComponent(emailAddress)}`;

    await this.email.sendSignInLink(emailAddress, url);
  }
}
