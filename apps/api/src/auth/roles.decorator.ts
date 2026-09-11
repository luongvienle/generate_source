import { SetMetadata } from '@nestjs/common';
import type { PermissionAction } from '@knowledge-explorer/shared';

export const PERMISSION_ACTION_KEY = 'knowledgeExplorer:permissionAction';

/**
 * Declares which §3 action an endpoint performs.
 *
 * Endpoints declare the action, not a role list, so the §3 matrix in
 * @knowledge-explorer/shared stays the only place a role decision is recorded.
 * An endpoint with no declaration is refused outright — see RolesGuard.
 */
export const RequirePermission = (action: PermissionAction): MethodDecorator =>
  SetMetadata(PERMISSION_ACTION_KEY, action);
