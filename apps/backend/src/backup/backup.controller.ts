import {
  BadGatewayException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Post,
  Put,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import {
  BackupPreviewSchema,
  BackupRunSchema,
  BackupS3TestRequestSchema,
  BackupS3TestResultSchema,
  BackupSettingsInputSchema,
  BackupSettingsSchema,
  type BackupPreview,
  type BackupRun,
  type BackupS3TestRequest,
  type BackupS3TestResult,
  type BackupSettings,
  type BackupSettingsInput,
} from '@capi-navigator/shared';
import type { Response } from 'express';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { Api } from '../openapi/api.decorator.js';
import { Audit, CurrentUser, Requires } from '../auth/decorators.js';
import type { AuthenticatedRequest, Principal } from '../auth/principal.js';
import { BackupService } from './backup.service.js';

/** Backup of the home cluster (FP-38); every endpoint needs backup.manage (FP38-F-06). */
@Controller('api/backup')
@Requires('backup.manage')
export class BackupController {
  constructor(private readonly backup: BackupService) {}

  @Api({
    summary: 'Backup settings: recipient keys and whether audit events are included',
    description: 'Public keys only, with fingerprint, user IDs and expiry (FP38-F-02).',
    response: BackupSettingsSchema,
  })
  @Get('settings')
  settings(): Promise<BackupSettings> {
    return this.backup.settings();
  }

  @Api({
    summary: 'Save the backup settings',
    description:
      'Every key must be an OpenPGP public key that can encrypt. Not with API tokens: whoever sets the keys can read every later backup.',
    response: BackupSettingsSchema,
  })
  // A token must not add its own key and read all credentials (as FP22-F-05 for users).
  @Requires('backup.manage', { peopleOnly: true })
  @Put('settings')
  @Audit({ action: 'backup.settings.update', targetKind: 'NavigatorBackupSettings' })
  update(
    @Body(new ZodValidationPipe(BackupSettingsInputSchema)) body: BackupSettingsInput,
  ): Promise<BackupSettings> {
    return this.backup.updateSettings(body);
  }

  @Api({
    summary: 'What a backup would contain now, by kind',
    response: BackupPreviewSchema,
  })
  @Get('preview')
  preview(): Promise<BackupPreview> {
    return this.backup.preview();
  }

  @Api({
    summary: 'Create a backup and download it, encrypted with OpenPGP',
    description:
      'A tar.gz of all app data in the home cluster, encrypted to every recipient key (FP38-F-04, F-05). Decrypt with gpg -d; see RESTORE.md in the archive. Every backup is audited.',
    response: { contentType: 'application/pgp-encrypted', description: 'Encrypted archive' },
  })
  @Post()
  @HttpCode(200)
  @Header('Content-Type', 'application/pgp-encrypted')
  @Header('Cache-Control', 'no-store')
  @Audit({ action: 'backup.create', targetKind: 'NavigatorBackupSettings' })
  async create(
    @CurrentUser() user: Principal,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const backup = await this.backup.create(user.username);
    req.auditMessage = backup.summary;
    res.setHeader('Content-Disposition', `attachment; filename="${backup.fileName}"`);
    return new StreamableFile(backup.data);
  }

  @Api({
    summary: 'Test the S3 target: write, read, list and delete a test object',
    description: 'Uses the access key in the body, or the stored one (FP38-F-14).',
    response: BackupS3TestResultSchema,
  })
  @Post('s3/test')
  @HttpCode(200)
  @Audit({ action: 'backup.s3.test', skip: true })
  testS3(
    @Body(new ZodValidationPipe(BackupS3TestRequestSchema)) body: BackupS3TestRequest,
  ): Promise<BackupS3TestResult> {
    return this.backup.testS3(body);
  }

  @Api({
    summary: 'Back up to S3 now',
    description:
      'Creates a backup, uploads it to the S3 target and applies the retention (FP38-F-14). The run is recorded in the settings; a failed run answers 502 with the reason.',
    response: BackupRunSchema,
  })
  @Post('s3/run')
  @HttpCode(200)
  @Audit({ action: 'backup.s3.run', targetKind: 'NavigatorBackupSettings' })
  async runS3(
    @CurrentUser() user: Principal,
    @Req() req: AuthenticatedRequest,
  ): Promise<BackupRun> {
    const { run, summary } = await this.backup.runToS3('manual', user.username);
    if (run.outcome === 'failure') {
      throw new BadGatewayException({
        statusCode: 502,
        message: run.message ?? 'The backup to S3 failed',
        ...(run.hint ? { hint: run.hint } : {}),
      });
    }
    if (summary) req.auditMessage = summary;
    return run;
  }
}
