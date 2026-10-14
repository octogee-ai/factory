import { GoogleAuth } from 'google-auth-library';
import { randomUUID } from 'node:crypto';
import { runWithOperationAuditIntent } from '@octogee/core/operation-audit';
import { createCentralReleaseAuthority } from '@octogee/core/artifact-registry';
import { deploymentEnvironmentSettings } from '@octogee/core/deployment-environment';
import type { Firestore } from 'firebase-admin/firestore';
import { validateDesktopImage, assertDesktopImageIdentity } from '../../.github/actions/release-digest-manifest/desktop-image.mjs';
import { resolveDesktopRelease } from './desktop-image-release.mjs';

export interface DesktopCloudImage {
  id: string; name: string; status: string; sourceImageId?: string; labels?: Record<string, string>;
}
export interface DesktopPublicationDeps {
  getImage(project: string, name: string): Promise<DesktopCloudImage | null>;
  copyImage(sourceProject: string, name: string, targetProject: string, sourceSha: string): Promise<void>;
  setFamily(project: string, name: string): Promise<void>;
  resolveFamily(project: string): Promise<string | null>;
  staleWarmPool(environment: 'test' | 'prod', project: string, name: string): Promise<string[]>;
  retirePool(environment: 'test' | 'prod', project: string, name: string): Promise<string[]>;
}

function desktopImageProject(environment: 'test' | 'prod'): string {
  return environment === 'test' ? 'octogee-test' : 'octogee';
}

export interface DesktopPublicationPlan {
  project: string; image: string; familyImage: string | null; staleWarmPool: string[]; unchanged: boolean;
}

function assertDestinationCopy(copy: DesktopCloudImage | null, artifact: ReturnType<typeof validateDesktopImage>): void {
  if (copy?.status !== 'READY' || copy.sourceImageId !== artifact.id || copy.labels?.source !== artifact.sourceSha) throw new Error('destination is not a copy of the tested desktop image');
}

export async function planDesktopPublication(value: unknown, environment: 'test' | 'prod', deps: DesktopPublicationDeps, controllerPool = false): Promise<DesktopPublicationPlan> {
  const artifact = validateDesktopImage(value);
  assertDesktopImageIdentity(artifact, await deps.getImage(artifact.project, artifact.name));
  const project = desktopImageProject(environment);
  const familyImage = await deps.resolveFamily(project);
  if (familyImage === artifact.name && project !== artifact.project) assertDestinationCopy(await deps.getImage(project, artifact.name), artifact);
  const staleWarmPool = controllerPool ? [] : await deps.staleWarmPool(environment, project, artifact.name);
  return { project, image: artifact.name, familyImage, staleWarmPool, unchanged: familyImage === artifact.name && staleWarmPool.length === 0 };
}

export async function publishDesktopArtifact(value: unknown, environment: 'test' | 'prod', deps: DesktopPublicationDeps, controllerPool = false) {
  const artifact = validateDesktopImage(value);
  assertDesktopImageIdentity(artifact, await deps.getImage(artifact.project, artifact.name));
  const targetProject = desktopImageProject(environment);
  if (targetProject !== artifact.project) {
    let copy = await deps.getImage(targetProject, artifact.name);
    if (!copy) {
      await deps.copyImage(artifact.project, artifact.name, targetProject, artifact.sourceSha);
      copy = await deps.getImage(targetProject, artifact.name);
    }
    assertDestinationCopy(copy, artifact);
  }
  if (await deps.resolveFamily(targetProject) !== artifact.name) await deps.setFamily(targetProject, artifact.name);
  const retiring = controllerPool ? [] : await deps.retirePool(environment, targetProject, artifact.name);
  return { project: targetProject, image: artifact.name, retiring };
}

export async function selectDesktopFamily(name: string, deps: {
  listMembers(): Promise<string[]>;
  setFamily(name: string, family: string): Promise<void>;
  resolveFamily(): Promise<{ name: string }>;
}): Promise<void> {
  await deps.setFamily(name, 'octogee-computer');
  for (const member of await deps.listMembers()) {
    if (member !== name) await deps.setFamily(member, 'octogee-computer-archive');
  }
  if ((await deps.resolveFamily()).name !== name) throw new Error('desktop family does not resolve to the selected image');
}

export interface DesktopPoolVm {
  labels: Record<string, string>;
  labelFingerprint: string;
  metadata?: { items?: Array<{ key: string; value: string }> };
  disks: Array<{ boot?: boolean; source: string }>;
}
export interface DesktopPoolMember { name: string; zone: string }
interface DesktopPoolDeps {
  readVm(member: DesktopPoolMember): Promise<DesktopPoolVm>;
  readDisk(url: string): Promise<{ sourceImage?: string }>;
  markRetiring(member: DesktopPoolMember, vm: DesktopPoolVm): Promise<void>;
}
interface AggregatedInstancesPage {
  items?: Record<string, { instances?: Array<{ name: string; zone: string }> }>;
  nextPageToken?: string;
}
export async function listDesktopPoolMembers(
  environment: string,
  fetchPage: (filter: string, pageToken: string) => Promise<AggregatedInstancesPage>,
): Promise<DesktopPoolMember[]> {
  const filter = `labels.octogee-environment = ${environment} AND labels.octogee-pool = warm`;
  const members: DesktopPoolMember[] = [];
  let pageToken = '';
  do {
    const page = await fetchPage(filter, pageToken);
    for (const instance of Object.values(page.items ?? {}).flatMap(scope => scope.instances ?? [])) {
      members.push({ name: instance.name, zone: instance.zone.slice(instance.zone.lastIndexOf('/') + 1) });
    }
    pageToken = page.nextPageToken ?? '';
  } while (pageToken);
  return members;
}
function unassigned(vm: DesktopPoolVm, environment: string): boolean {
  const metadata = Object.fromEntries((vm.metadata?.items ?? []).map(entry => [entry.key, entry.value]));
  return vm.labels['octogee-environment'] === environment && vm.labels['octogee-pool'] === 'warm'
    && !vm.labels['octogee-owner-uid'] && !vm.labels['octogee-gateway-id']
    && !metadata['gateway-id'] && !metadata['octogee-owner-uid'];
}
export async function staleDesktopPool(environment: string, project: string, imageName: string, members: DesktopPoolMember[], deps: Omit<DesktopPoolDeps, 'markRetiring'>): Promise<Array<{ member: DesktopPoolMember; vm: DesktopPoolVm }>> {
  const stale: Array<{ member: DesktopPoolMember; vm: DesktopPoolVm }> = [];
  for (const member of members) {
    const vm = await deps.readVm(member);
    if (!unassigned(vm, environment)) continue;
    if (!vm.labelFingerprint) throw new Error('warm-pool label fingerprint missing');
    const disk = vm.disks.find(entry => entry.boot);
    if (!disk) throw new Error('warm-pool boot disk missing');
    const image = (await deps.readDisk(disk.source)).sourceImage;
    if (!image?.endsWith(`/projects/${project}/global/images/${imageName}`)) stale.push({ member, vm });
  }
  return stale;
}
export async function retireDesktopPool(environment: string, project: string, imageName: string, members: DesktopPoolMember[], deps: DesktopPoolDeps): Promise<string[]> {
  const retiring: string[] = [];
  for (const { member, vm } of await staleDesktopPool(environment, project, imageName, members, deps)) {
    try { await deps.markRetiring(member, vm); retiring.push(member.name); }
    catch (error) {
      if ((error as { response?: { status?: number } }).response?.status !== 412) throw error;
      console.warn(`desktop image: preserved concurrently changed VM ${member.name}`);
    }
  }
  return retiring;
}

function createDesktopPublicationCloud(auth: GoogleAuth): DesktopPublicationDeps {
  const base = 'https://compute.googleapis.com/compute/v1/projects';
  const compute = `${base}/octogee`;
  async function request<T>(url: string, data?: object, method = 'POST'): Promise<T> {
    const client = await auth.getClient();
    return (await client.request<T>({ url, method: data ? method as 'POST' | 'PATCH' : 'GET', ...(data ? { data } : {}), timeout: 30_000 })).data;
  }
  async function requestOrNull<T>(url: string): Promise<T | null> {
    try { return await request<T>(url); }
    catch (error) {
      if ((error as { response?: { status?: number } }).response?.status === 404) return null;
      throw error;
    }
  }
  async function waitOperation(project: string, operation: { name: string }, scope = 'global') {
    const deadline = Date.now() + 10 * 60_000;
    while (Date.now() < deadline) {
      const result = await request<{ status: string; error?: unknown }>(`${base}/${project}/${scope}/operations/${operation.name}`);
      if (result.error) throw new Error(JSON.stringify(result.error));
      if (result.status === 'DONE') return;
      await new Promise(resolve => setTimeout(resolve, 2_000));
    }
    throw new Error('desktop image operation timed out');
  }
  function poolMembers(environment: string) {
    return listDesktopPoolMembers(environment, (filter, pageToken) => {
      const page = pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '';
      return request(`${compute}/aggregated/instances?filter=${encodeURIComponent(filter)}${page}`);
    });
  }
  const poolReads = {
    readVm: (member: DesktopPoolMember) => request<DesktopPoolVm>(`${compute}/zones/${member.zone}/instances/${member.name}`),
    readDisk: (url: string) => request<{ sourceImage?: string }>(url),
  };
  return {
    getImage: (project, name) => requestOrNull<DesktopCloudImage>(`${base}/${project}/global/images/${name}`),
    async copyImage(sourceProject, name, project, sourceSha) {
      const operation = await request<{ name: string }>(`${base}/${project}/global/images`, { name, sourceImage: `${base}/${sourceProject}/global/images/${name}`, labels: { source: sourceSha, purpose: 'octogee-computer' } });
      await waitOperation(project, operation);
    },
    async resolveFamily(project) {
      return (await requestOrNull<{ name: string }>(`${base}/${project}/global/images/family/octogee-computer`))?.name ?? null;
    },
    async setFamily(project, name) {
      const images = `${base}/${project}/global/images`;
      await selectDesktopFamily(name, {
        async listMembers() {
          const names: string[] = [];
          let pageToken = '';
          do {
            const page = await request<{ items?: Array<{ name: string }>; nextPageToken?: string }>(`${images}?filter=family%20%3D%20octogee-computer&pageToken=${encodeURIComponent(pageToken)}`);
            names.push(...(page.items ?? []).map(image => image.name));
            pageToken = page.nextPageToken ?? '';
          } while (pageToken);
          return names;
        },
        async setFamily(image, family) {
          await waitOperation(project, await request(`${images}/${image}`, { family }, 'PATCH'));
        },
        resolveFamily: () => request(`${images}/family/octogee-computer`),
      });
    },
    async staleWarmPool(environment, project, name) {
      return (await staleDesktopPool(environment, project, name, await poolMembers(environment), poolReads)).map(({ member }) => member.name);
    },
    async retirePool(environment, project, name) {
      return retireDesktopPool(environment, project, name, await poolMembers(environment), {
        ...poolReads,
        async markRetiring(member, vm) {
          const operation = await request<{ name: string }>(`${compute}/zones/${member.zone}/instances/${member.name}/setLabels`, { labelFingerprint: vm.labelFingerprint, labels: { ...vm.labels, 'octogee-pool': 'retiring' } });
          await waitOperation('octogee', operation, `zones/${member.zone}`);
        },
      });
    },
  };
}

export async function runDesktopImagePublication(input: {
  environment: 'test' | 'prod'; sourceSha: string; apply: boolean; actor: string; why: string; db: Firestore; auth?: GoogleAuth; skipMissing?: boolean; controllerPool?: boolean;
}) {
  if (!/^[a-f0-9]{40}$/.test(input.sourceSha)) throw new Error('desktop-image publish requires --sha=<full-main-sha>');
  const auth = input.auth ?? new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const target = deploymentEnvironmentSettings(input.environment);
  const manifest = await createCentralReleaseAuthority(
    { project: target.artifactRegistryProjectId, location: target.artifactRegistryLocation, repository: target.artifactRegistryName },
    {
      async getAccessToken() {
        const token = await auth.getAccessToken();
        if (!token) throw new Error('desktop image: Google auth returned no access token');
        return token;
      },
    },
  ).resolveManifest(input.sourceSha);
  const desktop = await resolveDesktopRelease({ manifest, digest: manifest.manifestDigest }, async (url, options) => {
    const token = await auth.getAccessToken();
    if (!token) throw new Error('desktop image: Google auth returned no access token');
    return fetch(url, { ...options, headers: { ...options?.headers, Authorization: `Bearer ${token}` } });
  });
  if (!desktop && input.skipMissing) {
    console.log(`desktop image: build ${manifest.sourceSha} has no desktop image; skipping publication`);
    return;
  }
  const cloud = createDesktopPublicationCloud(auth);
  if (!desktop) throw new Error(`Build ${manifest.sourceSha} has no accepted desktop image`);
  const publication = await planDesktopPublication(desktop.desktopImage, input.environment, cloud, input.controllerPool);
  const plan = { environment: input.environment, sourceSha: manifest.sourceSha, manifestDigest: manifest.manifestDigest, desktopManifestDigest: desktop.digest, desktopImage: desktop.desktopImage, publication, warmPoolAuthority: input.controllerPool ? 'controller' : 'operator' };
  console.log(JSON.stringify(plan, null, 2));
  if (!input.apply) return;
  if (publication.unchanged) {
    console.log(`desktop image: ${publication.project} family already serves ${publication.image}; ${input.controllerPool ? 'Cowboy owns warm-pool convergence' : 'no warm spare is stale'}`);
    return;
  }
  await runWithOperationAuditIntent(input.db, {
    actor: input.actor, forced: false, what: 'Publish desktop image', why: input.why,
    target: { environment: input.environment }, preActionStatus: plan,
    mutation: { action: 'publish-desktop-image', retireUnassignedWarmPool: !input.controllerPool },
    idempotencyKey: `desktop-image:${input.environment}:${manifest.manifestDigest}:${randomUUID()}`,
  }, { claimId: randomUUID() }, async () => {
    console.log(JSON.stringify(await publishDesktopArtifact(desktop.desktopImage, input.environment, cloud, input.controllerPool)));
  });
}
