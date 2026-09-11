/**
 * Transactional email, behind an interface (spec §11).
 *
 * P0 ships only the logging implementation: §7.5's provider decision is open
 * and P8 owns it. Swapping in a real sender must not touch any caller.
 */
export interface EmailProvider {
  sendSignInLink(emailAddress: string, url: string): Promise<void>;
}

/** Injection token. A Symbol cannot collide with another provider's token. */
export const EMAIL_PROVIDER = Symbol('EmailProvider');
