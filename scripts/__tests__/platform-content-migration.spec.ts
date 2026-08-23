import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  contentMigrationConfirmation,
  createPlatformContentMigrationPlan,
  parsePlatformContentMigrationArguments,
} from '../lib/platform-content-migration.js'
import {
  resolvePlatformContentMigrationOperatorImage,
} from '../lib/platform-content-migration-image.js'
import {
  assertFreshTargetDatabase,
  copyPod,
  databaseProbeManifest,
  discoverDisk,
  discoverWorkload,
  readCanonicalOpenclawVersion,
  targetInventoryProbeManifest,
} from '../ops/migrate-platform-content.js'

describe('platform content migration plan', () => {
  it('resolves the canonical exact-commit Builder image to its Artifact Registry digest', () => {
    const commands: Array<{ command: string; args: readonly string[] }> = []
    const image = resolvePlatformContentMigrationOperatorImage({
      artifactRegistryLocation: 'us-west1',
      artifactRegistryProjectId: 'octogee',
      artifactRegistryRepository: 'octogee',
      releaseCommit: 'a'.repeat(40),
      canonicalOpenclawVersion: '2026.7.1',
      run: (command, args) => {
        commands.push({ command, args })
        if (args[0] === 'artifacts') {
          return JSON.stringify({ image_summary: { digest: `sha256:${'b'.repeat(64)}` } })
        }
        return JSON.stringify([{
          status: 'SUCCESS',
          substitutions: {
            COMMIT_SHA: 'a'.repeat(40),
            _IMAGE_TAG: 'aaaaaaa',
            _OPENCLAW_VERSION: '2026.7.1',
          },
          results: {
            images: [{
              name: 'us-west1-docker.pkg.dev/octogee/octogee/octogee-gateway-builder:aaaaaaa',
              digest: `sha256:${'b'.repeat(64)}`,
            }],
          },
        }])
      },
    })

    expect(image).toEqual({
      releaseCommit: 'a'.repeat(40),
      canonicalOpenclawVersion: '2026.7.1',
      tag: 'aaaaaaa-oc2026.7.1',
      digest: `sha256:${'b'.repeat(64)}`,
      reference: `us-west1-docker.pkg.dev/octogee/octogee/octogee-gateway-builder:aaaaaaa-oc2026.7.1@sha256:${'b'.repeat(64)}`,
    })
    expect(commands).toEqual([
      {
        command: 'gcloud',
        args: [
          'artifacts', 'docker', 'images', 'describe',
          'us-west1-docker.pkg.dev/octogee/octogee/octogee-gateway-builder:aaaaaaa-oc2026.7.1',
          '--project=octogee', '--format=json',
        ],
      },
      {
        command: 'gcloud',
        args: [
          'builds', 'list',
          '--project=octogee',
          '--region=us-west1',
          `--filter=status=SUCCESS AND results.images.digest="sha256:${'b'.repeat(64)}"`,
          '--limit=100',
          '--format=json(status,substitutions,results.images)',
        ],
      },
    ])
  })

  it('reads the canonical OpenClaw version from the real repository layout', () => {
    expect(readCanonicalOpenclawVersion(path.resolve(process.cwd(), '..'))).toBe('2026.8.1-main.75c44b2b')
  })

  it('rejects duplicate canonical OpenClaw version declarations', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'octogee-openclaw-version-'))
    fs.writeFileSync(path.join(repo, 'cloudbuild.yaml'), [
      'substitutions:',
      '  _OPENCLAW_VERSION: "2026.7.1"',
      '  _OPENCLAW_VERSION: "2026.7.2"',
    ].join('\n'))

    expect(() => readCanonicalOpenclawVersion(repo)).toThrow(
      'could not resolve the canonical OpenClaw version',
    )
  })

  it.each([
    ['missing Artifact Registry digest', '{}'],
    ['mutable digest', JSON.stringify({ image_summary: { digest: 'latest' } })],
  ])('rejects %s', (_label, output) => {
    expect(() => resolvePlatformContentMigrationOperatorImage({
      artifactRegistryLocation: 'us-west1',
      artifactRegistryProjectId: 'octogee',
      artifactRegistryRepository: 'octogee',
      releaseCommit: 'a'.repeat(40),
      canonicalOpenclawVersion: '2026.7.1',
      run: () => output,
    })).toThrow('did not resolve to an immutable digest')
  })

  it.each([
    ['no Cloud Build record', []],
    ['a different full commit', [{
      status: 'SUCCESS',
      substitutions: {
        COMMIT_SHA: 'c'.repeat(40),
        _IMAGE_TAG: 'aaaaaaa',
        _OPENCLAW_VERSION: '2026.7.1',
      },
      results: { images: [{ name: 'us-west1-docker.pkg.dev/octogee/octogee/octogee-gateway-builder:aaaaaaa', digest: `sha256:${'b'.repeat(64)}` }] },
    }]],
    ['a different OpenClaw version', [{
      status: 'SUCCESS',
      substitutions: {
        COMMIT_SHA: 'a'.repeat(40),
        _IMAGE_TAG: 'aaaaaaa',
        _OPENCLAW_VERSION: '2026.7.0',
      },
      results: { images: [{ name: 'us-west1-docker.pkg.dev/octogee/octogee/octogee-gateway-builder:aaaaaaa', digest: `sha256:${'b'.repeat(64)}` }] },
    }]],
    ['a different image digest', [{
      status: 'SUCCESS',
      substitutions: {
        COMMIT_SHA: 'a'.repeat(40),
        _IMAGE_TAG: 'aaaaaaa',
        _OPENCLAW_VERSION: '2026.7.1',
      },
      results: { images: [{ name: 'us-west1-docker.pkg.dev/octogee/octogee/octogee-gateway-builder:aaaaaaa', digest: `sha256:${'c'.repeat(64)}` }] },
    }]],
  ])('rejects a Builder digest backed by %s', (_label, builds) => {
    expect(() => resolvePlatformContentMigrationOperatorImage({
      artifactRegistryLocation: 'us-west1',
      artifactRegistryProjectId: 'octogee',
      artifactRegistryRepository: 'octogee',
      releaseCommit: 'a'.repeat(40),
      canonicalOpenclawVersion: '2026.7.1',
      run: (_command, args) => args[0] === 'artifacts'
        ? JSON.stringify({ image_summary: { digest: `sha256:${'b'.repeat(64)}` } })
        : JSON.stringify(builds),
    })).toThrow('does not have trusted exact-source Cloud Build provenance')
  })

  it('rejects a non-release commit or canonical version before querying Artifact Registry', () => {
    expect(() => resolvePlatformContentMigrationOperatorImage({
      artifactRegistryLocation: 'us-west1',
      artifactRegistryProjectId: 'octogee',
      artifactRegistryRepository: 'octogee',
      releaseCommit: 'short',
      canonicalOpenclawVersion: '2026.7.1',
      run: () => { throw new Error('must not query') },
    })).toThrow('exact 40-character Git commit')

    expect(() => resolvePlatformContentMigrationOperatorImage({
      artifactRegistryLocation: 'us-west1',
      artifactRegistryProjectId: 'octogee',
      artifactRegistryRepository: 'octogee',
      releaseCommit: 'a'.repeat(40),
      canonicalOpenclawVersion: 'latest',
      run: () => { throw new Error('must not query') },
    })).toThrow('canonical OpenClaw version')
  })

  it('allows only the central-to-west pair for the same environment', () => {
    expect(
      createPlatformContentMigrationPlan({
        source: 'test-central',
        target: 'test-west',
        migrationId: 'migration-20260722',
      }),
    ).toMatchObject({
      source: 'test-central',
      target: 'test-west',
      dryRun: true,
      services: ['mattermost', 'gitea'],
    })

    expect(() =>
      createPlatformContentMigrationPlan({
        source: 'test-central',
        target: 'prod-west',
        migrationId: 'migration-20260722',
      }),
    ).toThrow('only supports test-central -> test-west or prod-central -> prod-west')
  })

  it('makes apply require an exact migration-scoped confirmation', () => {
    const migrationId = 'migration-20260722'
    const confirmation = contentMigrationConfirmation('prod-central', 'prod-west', migrationId)

    expect(
      createPlatformContentMigrationPlan({
        source: 'prod-central',
        target: 'prod-west',
        migrationId,
        apply: true,
        confirmation,
      }),
    ).toMatchObject({ dryRun: false, confirmation })

    expect(() =>
      createPlatformContentMigrationPlan({
        source: 'prod-central',
        target: 'prod-west',
        migrationId,
        apply: true,
        confirmation: 'yes',
      }),
    ).toThrow('requires --confirm=' + confirmation)
  })

  it('parses dry-run as the default and rejects unknown switches', () => {
    expect(
      parsePlatformContentMigrationArguments([
        '--source=test-central',
        '--target=test-west',
        '--migration-id=migration-20260722',
      ]),
    ).toMatchObject({ apply: false })

    expect(() =>
      parsePlatformContentMigrationArguments([
        '--source=test-central',
        '--target=test-west',
        '--migration-id=migration-20260722',
        '--force',
      ]),
    ).toThrow('unknown argument: --force')
  })

  it('discovers the mounted PD CSI disk instead of constructing a disk name', () => {
    const workload = discoverWorkload({
      items: [{
        kind: 'Deployment',
        metadata: { name: 'octogee-gitea' },
        spec: { template: { spec: { serviceAccountName: 'gitea', containers: [{ name: 'gitea' }], volumes: [{ persistentVolumeClaim: { claimName: 'live-data' } }] } } },
      }],
    }, 'gitea')
    const disk = discoverDisk(
      { spec: { resources: { requests: { storage: '20Gi' } } } },
      { spec: { csi: { driver: 'pd.csi.storage.gke.io', volumeHandle: 'projects/octogee/zones/us-west1-a/disks/discovered-disk' } } },
    )

    expect(workload).toMatchObject({ claim: 'live-data', serviceAccount: 'gitea' })
    expect(disk).toEqual({ disk: 'discovered-disk', zone: 'us-west1-a', capacity: '20Gi' })
  })

  it('fails closed when a service workload has more than one data claim', () => {
    expect(() => discoverWorkload({
      items: [{
        kind: 'Deployment',
        metadata: { name: 'mattermost' },
        spec: { template: { spec: { volumes: [
          { persistentVolumeClaim: { claimName: 'first' } },
          { persistentVolumeClaim: { claimName: 'second' } },
        ] } } },
      }],
    }, 'mattermost')).toThrow('exactly one PVC')
  })

  it('builds an identity-safe, content-verifying disk copy pod', () => {
    const manifest = copyPod({
      settings: { clusterProjectId: 'octogee', namespace: 'octogee-test-west' } as never,
      target: { kind: 'deployment', name: 'octogee-gitea', claim: 'gitea-data', serviceAccount: 'gitea', env: [], envFrom: [] },
      sourceDisk: { disk: 'source', zone: 'us-central1-b', capacity: '10Gi' },
      targetDisk: { disk: 'target', zone: 'us-west1-a', capacity: '20Gi' },
      service: 'gitea',
      migrationId: 'migration-20260722',
      scratchDisk: 'scratch-disk',
      image: 'us-west1-docker.pkg.dev/octogee/octogee/octogee-gateway-builder:v0.3.1@sha256:' + 'a'.repeat(64),
    }) as { items: Array<Record<string, any>> }
    const pv = manifest.items.find((item) => item.kind === 'PersistentVolume')!
    const pod = manifest.items.find((item) => item.kind === 'Pod')!
    const command = pod.spec.containers[0].command.at(-1)

    expect(pv.metadata.name).toEqual(expect.any(String))
    expect(pv.spec.capacity.storage).toBe('10Gi')
    expect(pod.spec.automountServiceAccountToken).toBe(false)
    expect(command).toContain('cd "$1"')
    expect(command).toContain('--exclude=./lost+found')
    expect(command).toContain('--exclude=./gitea/conf')
    expect(command).toContain('--exclude=./gitea/sessions')
    expect(command).toContain('find /target -xdev -depth')
    expect(command).toContain('-delete')
    expect(command).toContain('sha256sum')
  })

  it('probes exact database row counts through the existing private proxy service', () => {
    const manifest = databaseProbeManifest(
      { name: 'test', namespace: 'octogee-test-west', region: 'us-west1' } as never,
      {
        kind: 'deployment',
        name: 'mattermost',
        claim: 'mattermost-data',
        serviceAccount: 'mattermost',
        env: [{ name: 'MM_DB_PASSWORD', valueFrom: { secretKeyRef: { name: 'mattermost-cloud-sql', key: 'password' } } }],
        envFrom: [],
      },
      'mattermost',
      'migration-20260722',
    ) as Record<string, any>
    const container = manifest.spec.containers[0]
    const command = container.command.at(-1)

    expect(manifest.metadata.name).toEqual(expect.any(String))
    expect(manifest.spec.automountServiceAccountToken).toBe(false)
    expect(container.env).toEqual([
      expect.objectContaining({ name: 'MM_DB_PASSWORD' }),
      expect.objectContaining({ name: 'MM_ADMIN_USER', valueFrom: { secretKeyRef: { name: 'mattermost-gateway', key: 'admin_user' } } }),
    ])
    expect(command).toContain('-h cloud-sql-proxy -U mattermost -d mattermost_test')
    expect(command).toContain('count(*)::text')
    expect(command).toContain('information_schema.columns')
    expect(command).toContain('bootstrapViolations')
    expect(command).toContain('town-square')
    expect(command).toContain('MM_ADMIN_USER')
    expect(command).toContain("<<'OCTOGEE_BOOTSTRAP_SQL'")

    const giteaManifest = databaseProbeManifest(
      { name: 'test', namespace: 'octogee-test-west', region: 'us-west1' } as never,
      { kind: 'deployment', name: 'gitea', claim: 'gitea-data', serviceAccount: 'gitea', env: [{ name: 'GITEA__DATABASE__PASSWD', valueFrom: { secretKeyRef: { name: 'gitea-cloud-sql', key: 'password' } } }], envFrom: [] },
      'gitea',
      'migration-20260722',
    ) as Record<string, any>
    expect(giteaManifest.spec.containers[0].command.at(-1)).toContain('octogee-admin')
    expect(giteaManifest.spec.containers[0].command.at(-1)).toContain('repository')
  })

  it('proves the target has only an empty database and allowlisted bootstrap PVC paths before reset', () => {
    expect(() => assertFreshTargetDatabase({ tables: 87, rows: 240, digest: 'a'.repeat(64), bootstrapViolations: 0 }, 'gitea')).not.toThrow()
    expect(() => assertFreshTargetDatabase({ tables: 87, rows: 241, digest: 'a'.repeat(64), bootstrapViolations: 1 }, 'gitea')).toThrow('fresh bootstrap database')
    expect(() => assertFreshTargetDatabase({ tables: 0, rows: 0, digest: 'a'.repeat(64), bootstrapViolations: 0 }, 'mattermost')).not.toThrow()

    const manifest = targetInventoryProbeManifest(
      { namespace: 'octogee-test-west' } as never,
      { kind: 'deployment', name: 'gitea', claim: 'gitea-data', serviceAccount: 'gitea', env: [], envFrom: [] },
      'gitea',
      'migration-20260722',
      'us-west1-docker.pkg.dev/octogee/octogee/octogee-gateway-builder:v0.3.1@sha256:' + 'a'.repeat(64),
    ) as Record<string, any>
    const command = manifest.spec.containers[0].command.at(-1)
    expect(manifest.spec.containers[0].volumeMounts).toEqual([
      expect.objectContaining({ mountPath: '/target', readOnly: true }),
    ])
    expect(command).toContain('/target/gitea/conf')
    expect(command).toContain('/target/git/.ssh')
    expect(command).toContain('-print -quit')
    expect(command).not.toContain('-delete')
  })

  it('uses the regional no-soft-delete recovery bucket and target service database owner', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'ops/migrate-platform-content.ts'), 'utf8')
    expect(source).toContain('gs://octogee-west-recovery')
    expect(source).toContain('assertMigrationReceiptBucket')
    expect(source).toContain('writeImmutableMigrationReceipt')
    expect(source).toContain('`--user=${service}`')
    expect(source).toContain('"sql", "databases", "delete"')
    expect(source.indexOf('assertFreshTargetDatabase')).toBeLessThan(source.indexOf('resetTargetDatabase(target'))
    expect(source).not.toContain('${CONTROL_BUCKET}/platform-content-migration')
  })

  it('derives and receipts the exact-release operator image instead of accepting an environment override', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'ops/migrate-platform-content.ts'), 'utf8')
    expect(source).toContain('resolvePlatformContentMigrationOperatorImage')
    expect(source).toContain('readCanonicalOpenclawVersion')
    expect(source).toContain('operatorImage: image')
    expect(source).not.toContain('PLATFORM_CONTENT_MIGRATION_COPY_IMAGE')
  })

})
