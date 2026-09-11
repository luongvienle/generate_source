import { Injectable, Logger } from '@nestjs/common';
import type { EmailProvider } from './email.provider';

/**
 * Dev-mode delivery: writes the sign-in link to the application log so the
 * magic-link flow is exercisable end to end without choosing an email provider.
 *
 * Sends nothing over the network. That is a deliberate property, asserted by
 * test/log-email.provider.spec.ts.
 */
@Injectable()
export class LogEmailProvider implements EmailProvider {
  private readonly logger = new Logger(LogEmailProvider.name);

  async sendSignInLink(emailAddress: string, url: string): Promise<void> {
    this.logger.log(`sign-in link for ${emailAddress}: ${url}`);
  }
}
