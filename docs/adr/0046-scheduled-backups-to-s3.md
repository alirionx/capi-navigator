# ADR-0046: Scheduled backups to S3

- Status: accepted
- Date: 2026-11-27
- Pack: FP-38 part 2, refines FP38-F-10 to F-14

## Context

Backups of the home cluster (ADR-0044) should also run on a schedule and land in S3 or
S3-compatible storage. The backend runs with one or more replicas, keeps no state (hard rule 1)
and can restart at any time. A schedule must run each due time once, not once per replica, and a
restart must neither lose nor repeat a run.

## Decision

- Schedule and target live in the `NavigatorBackupSettings` spec: a cron expression with five
  fields in UTC (croner, also used by the UI for the next runs), the number of backups to keep, and
  bucket, prefix, region, optional endpoint, path-style addressing and CA certificate. The access
  key is in the Secret `capi-navigator-backup-s3`, write-only in the API, and part of the backup.
- Every replica checks every 30 seconds. The one holding the Lease `capi-navigator-backup` asks a
  pure function: the last due time of the schedule, compared with `status.lastScheduledAt`. A later
  due time is recorded first and then run, so a replica taking over the Lease does not run it
  again. A due time noticed more than ten minutes late (the app was down) is recorded as done
  without a backup; the next one runs on schedule, as FP38-F-11 asks.
- Each run uploads the same encrypted archive as the download, then lists the prefix and deletes
  the oldest backups beyond the retention. Only names the app writes
  (`capi-navigator-home-<UTC time>.tar.gz.gpg`) directly below the prefix count; other objects are
  never touched. The app creates no buckets.
- The last ten runs (time, trigger, result, object, size, deleted, error with hint) are kept in
  `status.runs`; every run writes an `AuditEvent` (`backup.s3.scheduled` by `scheduler`, or
  `backup.s3.run` by the person).
- S3 calls go through the outbound proxy of the app (FP29-F-01), as the AWS calls do.
  "Test connection" writes, reads, lists and deletes a test object, so it proves the permissions a
  backup needs.

## Consequences

- No CronJob and no image of its own: the schedule works with the chart as it is and stops with
  the app. A backup needs a running backend.
- With a cron of every minute and several replicas, each due time still runs once (verified with
  two backends against one home cluster).
- The PUT of the settings replaces the whole spec; the UI therefore always sends keys, schedule
  and target together.
