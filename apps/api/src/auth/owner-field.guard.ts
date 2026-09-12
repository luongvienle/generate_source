import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { errorCodes } from '@knowledge-explorer/shared';
import type { RequestWithSession } from './session-context';

export const OWNER_ONLY_FIELDS_KEY = 'knowledgeExplorer:ownerOnlyFields';

/**
 * Declares body fields only admin_owner may write, on a route admins may
 * otherwise call.
 *
 * §3 grants "create and edit chapters and lessons" to both roles, but deciding
 * *who works on what* is an owner decision, so assignedAdminId is carved out of
 * an otherwise shared route. Route-level @RequirePermission cannot express that.
 */
export const OwnerOnlyFields = (...fields: string[]): MethodDecorator =>
  SetMetadata(OWNER_ONLY_FIELDS_KEY, fields);

/**
 * Refuses a request that sets an owner-only field without being the owner.
 *
 * A guard rather than a check inside the handler, so that a mixed request —
 * `{ title, assignedAdminId }` from an admin — writes NEITHER field. Rejecting
 * inside the handler would risk the title landing before the refusal.
 */
@Injectable()
export class OwnerFieldGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const fields = this.reflector.getAllAndOverride<string[] | undefined>(OWNER_ONLY_FIELDS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!fields || fields.length === 0) return true;

    const request = context.switchToHttp().getRequest<RequestWithSession>();
    const session = request.sessionContext;
    if (!session) {
      throw new UnauthorizedException({ errorCode: errorCodes.UNAUTHENTICATED });
    }
    if (session.userRole === 'admin_owner') return true;

    const body = (request as { body?: Record<string, unknown> }).body ?? {};
    // Presence is what matters, not value: sending assignedAdminId: null is still
    // an attempt to change an assignment.
    const attempted = fields.filter((field) => Object.hasOwn(body, field));
    if (attempted.length > 0) {
      throw new ForbiddenException({
        errorCode: errorCodes.FORBIDDEN_OWNER_ONLY_FIELD,
        fields: attempted,
      });
    }
    return true;
  }
}
