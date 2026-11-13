export type PlatformContentMigrationTarget =
  | 'test-central'
  | 'test-west'
  | 'prod-central'
  | 'prod-west'

export type PlatformContentMigrationArguments = {
  source: PlatformContentMigrationTarget
  target: PlatformContentMigrationTarget
  migrationId: string
  apply: boolean
  confirmation?: string
}

export type PlatformContentMigrationPlan = {
  source: PlatformContentMigrationTarget
  target: PlatformContentMigrationTarget
  migrationId: string
  dryRun: boolean
  confirmation: string
  services: readonly ['mattermost', 'gitea']
  databases: readonly ['mattermost', 'gitea']
  transfer: {
    database: 'cloud-sql-native-export-import'
    files: 'compute-snapshot-to-temporary-target-pvc'
    verification: 'metadata-counts-and-digests'
    credentials: 'target-platform-generated-only'
  }
}

const allowedPairs = new Set(['test-central:test-west', 'prod-central:prod-west'])

function requireValue(argument: string, name: string): string {
  const prefix = `--${name}=`
  if (!argument.startsWith(prefix) || argument.length === prefix.length) {
    throw new Error(`requires --${name}=VALUE`)
  }
  return argument.slice(prefix.length)
}

function asTarget(value: string, name: string): PlatformContentMigrationTarget {
  if (!['test-central', 'test-west', 'prod-central', 'prod-west'].includes(value)) {
    throw new Error(`${name} must be a deployment target`)
  }
  return value as PlatformContentMigrationTarget
}

export function contentMigrationConfirmation(
  source: PlatformContentMigrationTarget,
  target: PlatformContentMigrationTarget,
  migrationId: string,
): string {
  return `octogee/platform-content-migration/${source}/${target}/${migrationId}`
}

export function parsePlatformContentMigrationArguments(
  argumentsList: readonly string[],
): PlatformContentMigrationArguments {
  let source: PlatformContentMigrationTarget | undefined
  let target: PlatformContentMigrationTarget | undefined
  let migrationId: string | undefined
  let confirmation: string | undefined
  let apply = false

  for (const argument of argumentsList) {
    if (argument === '--apply') {
      apply = true
      continue
    }
    if (argument.startsWith('--source=')) {
      source = asTarget(requireValue(argument, 'source'), 'source')
      continue
    }
    if (argument.startsWith('--target=')) {
      target = asTarget(requireValue(argument, 'target'), 'target')
      continue
    }
    if (argument.startsWith('--migration-id=')) {
      migrationId = requireValue(argument, 'migration-id')
      continue
    }
    if (argument.startsWith('--confirm=')) {
      confirmation = requireValue(argument, 'confirm')
      continue
    }
    throw new Error(`unknown argument: ${argument}`)
  }

  if (!source || !target || !migrationId) {
    throw new Error('requires --source=TARGET --target=TARGET --migration-id=ID')
  }
  if (!/^[a-z0-9][a-z0-9-]{2,62}$/.test(migrationId)) {
    throw new Error('migration id must contain 3-63 lowercase letters, digits, or hyphens')
  }

  return { source, target, migrationId, apply, confirmation }
}

export function createPlatformContentMigrationPlan(
  argumentsValue: PlatformContentMigrationArguments,
): PlatformContentMigrationPlan {
  const { source, target, migrationId, apply, confirmation } = argumentsValue
  if (!allowedPairs.has(`${source}:${target}`)) {
    throw new Error('only supports test-central -> test-west or prod-central -> prod-west')
  }

  const requiredConfirmation = contentMigrationConfirmation(source, target, migrationId)
  if (apply && confirmation !== requiredConfirmation) {
    throw new Error(`apply requires --confirm=${requiredConfirmation}`)
  }

  return {
    source,
    target,
    migrationId,
    dryRun: !apply,
    confirmation: requiredConfirmation,
    services: ['mattermost', 'gitea'],
    databases: ['mattermost', 'gitea'],
    transfer: {
      database: 'cloud-sql-native-export-import',
      files: 'compute-snapshot-to-temporary-target-pvc',
      verification: 'metadata-counts-and-digests',
      credentials: 'target-platform-generated-only',
    },
  }
}
