export interface PlatformMigrationWriters {
  readonly scheduledFunctions: readonly string[];
  readonly cronJobs: readonly string[];
}

const NO_WRITERS: PlatformMigrationWriters = { scheduledFunctions: [], cronJobs: [] };

let installed = NO_WRITERS;

export function installPlatformMigrationWriters(writers: PlatformMigrationWriters): void {
  installed = writers;
}

export function platformMigrationWriters(): PlatformMigrationWriters {
  return installed;
}
