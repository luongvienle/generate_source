import http from 'node:http';
import https from 'node:https';
import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LogEmailProvider } from '../src/email/log-email.provider';

describe('LogEmailProvider', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs a line containing both the address and the sign-in URL', async () => {
    const logged: string[] = [];
    vi.spyOn(Logger.prototype, 'log').mockImplementation((message: unknown) => {
      logged.push(String(message));
    });

    const url = 'http://localhost:3000/api/auth/callback/email?token=abc123&email=owner%40example.test';
    await new LogEmailProvider().sendSignInLink('owner@example.test', url);

    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('owner@example.test');
    expect(logged[0]).toContain(url);
  });

  /**
   * The point of the dev-mode provider is that it reaches no external service.
   * If someone later "helpfully" makes it call a real API, this fails.
   */
  it('opens no network connection', async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network denied'));
    const httpSpy = vi.spyOn(http, 'request');
    const httpsSpy = vi.spyOn(https, 'request');

    await new LogEmailProvider().sendSignInLink('owner@example.test', 'http://localhost/x');

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(httpSpy).not.toHaveBeenCalled();
    expect(httpsSpy).not.toHaveBeenCalled();
  });

  it('satisfies the EmailProvider interface shape callers depend on', async () => {
    const provider = new LogEmailProvider();
    expect(typeof provider.sendSignInLink).toBe('function');
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    await expect(provider.sendSignInLink('a@b.test', 'http://localhost/x')).resolves.toBeUndefined();
  });
});
