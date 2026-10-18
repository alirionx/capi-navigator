import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import {
  CreateRoleRequestSchema,
  UpdateRoleRequestSchema,
  type CreateRoleRequest,
  type RoleInfo,
  type UpdateRoleRequest,
} from '@capi-navigator/shared';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { Audit, Requires } from './decorators.js';
import { RolesService } from './roles.service.js';

/** Roles page (FP19-F-09); changes are audited (FP19-F-11). */
@Controller('api/roles')
@Requires('users.manage')
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Get()
  list(): RoleInfo[] {
    return this.roles.list();
  }

  @Post()
  @Audit({ action: 'role.create', targetKind: 'NavigatorRole', targetParam: 'name' })
  create(
    @Body(new ZodValidationPipe(CreateRoleRequestSchema)) body: CreateRoleRequest,
  ): Promise<RoleInfo> {
    return this.roles.create(body);
  }

  @Patch(':name')
  @Audit({ action: 'role.update', targetKind: 'NavigatorRole', targetParam: 'name' })
  update(
    @Param('name') name: string,
    @Body(new ZodValidationPipe(UpdateRoleRequestSchema)) body: UpdateRoleRequest,
  ): Promise<RoleInfo> {
    return this.roles.update(name, body);
  }

  @Delete(':name')
  @HttpCode(204)
  @Audit({ action: 'role.delete', targetKind: 'NavigatorRole', targetParam: 'name' })
  delete(@Param('name') name: string): Promise<void> {
    return this.roles.delete(name);
  }
}
