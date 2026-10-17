import {
  ApiextensionsV1Api,
  AppsV1Api,
  type KubeConfig,
  type V1Deployment,
} from '@kubernetes/client-node';
import {
  CAPI_OPERATOR,
  CERT_MANAGER,
  ORC,
  ORC_FOR_CAPO,
  type ComponentStatus,
  type Prerequisites,
} from '@capi-navigator/shared';
import { isNotFound } from '../kube/errors.js';

/** True if all wanted replicas of a deployment are available. */
export function deploymentReady(d: V1Deployment): boolean {
  const wanted = d.spec?.replicas ?? 1;
  return (d.status?.availableReplicas ?? 0) >= wanted && wanted > 0;
}

/** Version from the app.kubernetes.io/version label or the image tag. */
export function deploymentVersion(d: V1Deployment, imageRepository?: string): string | undefined {
  const label = d.metadata?.labels?.['app.kubernetes.io/version'];
  if (label) return label.startsWith('v') ? label : `v${label}`;
  const images = d.spec?.template?.spec?.containers?.map((c) => c.image ?? '') ?? [];
  const image = imageRepository ? images.find((i) => i.startsWith(imageRepository)) : images[0];
  const tag = image?.split('@')[0]?.split(':').at(-1);
  return tag && /^v?\d/.test(tag) ? (tag.startsWith('v') ? tag : `v${tag}`) : undefined;
}

async function crdExists(api: ApiextensionsV1Api, name: string): Promise<boolean> {
  try {
    await api.readCustomResourceDefinition({ name });
    return true;
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
}

function summarize(
  crd: boolean,
  deployments: V1Deployment[],
  expected: number,
  imageRepository: string | undefined,
  what: string,
): ComponentStatus {
  if (!crd && deployments.length === 0) return { installed: false, ready: false };
  const first = deployments[0];
  const ready = crd && deployments.length >= expected && deployments.every(deploymentReady);
  const status: ComponentStatus = {
    installed: true,
    ready,
    ...(first?.metadata?.namespace ? { namespace: first.metadata.namespace } : {}),
  };
  const version = first ? deploymentVersion(first, imageRepository) : undefined;
  if (version) status.version = version;
  if (!crd) status.message = `The ${what} CRDs are missing`;
  else if (deployments.length < expected) status.message = `The ${what} deployment is missing`;
  else if (!ready) status.message = `The ${what} deployment is not available yet`;
  return status;
}

/** Detects cert-manager, the CAPI Operator and ORC (FP3-F-01, FP3-F-02, FP3-F-04a). */
export async function detectPrerequisites(kc: KubeConfig): Promise<Prerequisites> {
  const ext = kc.makeApiClient(ApiextensionsV1Api);
  const apps = kc.makeApiClient(AppsV1Api);

  const names = [...CERT_MANAGER.deployments, CAPI_OPERATOR.deploymentName].join(',');
  const [cmCrd, opCrd, orcCrd, labelled, orcDeployment] = await Promise.all([
    crdExists(ext, CERT_MANAGER.crd),
    crdExists(ext, CAPI_OPERATOR.crd),
    crdExists(ext, ORC.crd),
    apps.listDeploymentForAllNamespaces({ labelSelector: `app.kubernetes.io/name in (${names})` }),
    apps
      .readNamespacedDeployment({ name: ORC.deploymentName, namespace: ORC.namespace })
      .catch((err: unknown) => {
        if (isNotFound(err)) return undefined;
        throw err;
      }),
  ]);
  const byName = (n: string) =>
    labelled.items.filter((d) => d.metadata?.labels?.['app.kubernetes.io/name'] === n);
  const certManagerDeployments = CERT_MANAGER.deployments.flatMap(byName);
  const operatorDeployments = byName(CAPI_OPERATOR.deploymentName);

  const latestOrc = Object.values(ORC_FOR_CAPO)[0]!;
  return {
    certManager: summarize(
      cmCrd,
      certManagerDeployments,
      CERT_MANAGER.deployments.length,
      undefined,
      'cert-manager',
    ),
    operator: summarize(
      opCrd,
      operatorDeployments,
      1,
      CAPI_OPERATOR.imageRepository,
      'CAPI Operator',
    ),
    orc: summarize(orcCrd, orcDeployment ? [orcDeployment] : [], 1, ORC.imageRepository, 'ORC'),
    instructions: {
      certManager: CERT_MANAGER.installCommand(CERT_MANAGER.recommendedVersion),
      operator: CAPI_OPERATOR.installCommand(CAPI_OPERATOR.recommendedVersion),
      orc: `kubectl apply --server-side -f ${ORC.manifestUrl(latestOrc)}`,
    },
  };
}
