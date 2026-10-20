import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import {
  CreateGroupMappingRequestSchema,
  GroupMappingListSchema,
  GroupMappingSchema,
  UpdateGroupMappingRequestSchema,
  type CreateGroupMappingRequest,
  type GroupMapping,
  type UpdateGroupMappingRequest,
} from '@capi-navigator/shared';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { Api } from '../openapi/api.decorator.js';
import { Audit, Requires } from './decorators.js';
import { GroupsService } from './groups.service.js';

/** Mappings of OpenID Connect groups to role assignments (FP14-F-04); audited (FP14-F-09). */
@Controller('api/oidc-groups')
@Requires('users.manage')
export class GroupsController {
  constructor(private readonly groups: GroupsService) {}

  @Api({ summary: 'List the mappings of OpenID Connect groups', response: GroupMappingListSchema })
  @Get()
  list(): GroupMapping[] {
    return this.groups.list();
  }

  @Api({
    summary: 'Map an OpenID Connect group to role assignments',
    description: 'Applies to members of the group from their next sign-in.',
    response: GroupMappingSchema,
  })
  @Post()
  @Audit({ action: 'oidc-group.create', targetKind: 'NavigatorGroup', targetParam: 'group' })
  create(
    @Body(new ZodValidationPipe(CreateGroupMappingRequestSchema)) body: CreateGroupMappingRequest,
  ): Promise<GroupMapping> {
    return this.groups.create(body);
  }

  @Api({
    summary: 'Change the role assignments of a group; applies on the next request',
    response: GroupMappingSchema,
  })
  @Patch(':name')
  @Audit({ action: 'oidc-group.update', targetKind: 'NavigatorGroup', targetParam: 'name' })
  update(
    @Param('name') name: string,
    @Body(new ZodValidationPipe(UpdateGroupMappingRequestSchema)) body: UpdateGroupMappingRequest,
  ): Promise<GroupMapping> {
    return this.groups.update(name, body);
  }

  @Api({
    summary: 'Remove the mapping of a group; its members lose that access on the next request',
    response: 'empty',
  })
  @Delete(':name')
  @HttpCode(204)
  @Audit({ action: 'oidc-group.delete', targetKind: 'NavigatorGroup', targetParam: 'name' })
  delete(@Param('name') name: string): Promise<void> {
    return this.groups.delete(name);
  }
}
