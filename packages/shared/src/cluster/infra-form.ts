import type { CredentialSummary, LookupKind, LookupOption } from '../credentials.js';
import type { Infrastructure } from './spec.js';

/**
 * Forms of an infrastructure provider, described by its plugin (FP25-F-05). The frontend renders
 * these descriptions and contains no checks for a specific provider. Labels and hints are i18n
 * keys; hints name the default and the CAPI resource and field a value maps to (POS-04).
 */

/** One input of the infrastructure step of the wizard. */
export interface InfraField {
  /** Dotted path in the spec's `infrastructure`, e.g. "network.nodeCidr". */
  path: string;
  /**
   * text/number: free input; switch: on/off; select/autocomplete: from `lookup` or `options`;
   * list: comma or space separated text that becomes a string array.
   */
  kind: 'text' | 'number' | 'switch' | 'select' | 'autocomplete' | 'list';
  label: string;
  hint: string;
  /** Selection list of the credential (FP4-F-05, FP4-F-10, FP25-F-04). */
  lookup?: LookupKind;
  /** Fixed choices. */
  options?: readonly (string | number)[];
  /** Initial value of a new cluster. */
  default?: string | number | boolean;
  /** Can be emptied; empty optional values are left out of the spec. */
  clearable?: boolean;
  /** Width in the 12-column grid on medium screens; default 6. */
  cols?: number;
  /** Preselects a value once the selection list has loaded, if the field is empty. */
  preselect?: (options: LookupOption[]) => string | undefined;
  /** Initial value from the credential summary, e.g. its region. */
  fromCredential?: (summary: CredentialSummary) => string | undefined;
  /** Fields emptied when this one changes; the selection lists are reloaded (e.g. region). */
  resets?: string[];
  testId?: string;
}

export interface InfraForm {
  /** Name in the wizard's provider switch. */
  displayName: string;
  /** Selection lists the wizard loads for the credential; `optional` ones may fail. */
  lookups: { kind: LookupKind; optional?: boolean }[];
  /** Field whose value is the region of the lookups; else the credential's region. */
  regionField?: string;
  fields: InfraField[];
  /** Info texts below the fields (i18n keys). */
  notes?: string[];
  /** Field holding the cloud key pair, which the bastion needs. */
  keyPairField?: string;
  machine: {
    /** Selection list of the machine size. */
    sizeLookup: LookupKind;
    sizeLabel: string;
    /** Machine template kind and field of the size, for the hint (POS-04). */
    target: string;
    sizeField: string;
    rootVolume: {
      /** Size the provider uses when empty (shown as placeholder). */
      defaultGB?: number;
      defaultType?: string;
      /** Sizes with `details.diskGB === 0` have no local disk and need a root volume. */
      neededWithoutLocalDisk?: boolean;
      /** The disk type only applies with an explicit size. */
      typeNeedsSize?: boolean;
      types: { lookup: LookupKind } | { options: readonly string[] };
      typeHint: string;
    };
  };
  /** Bastion host for SSH (FP5-F-20); unset when the provider has none. */
  bastion?: {
    sizeLabel: string;
    sizeHint: string;
    sizeRequired: boolean;
    /** SSH is restricted to source networks (the form asks for them). */
    allowedCidrs: boolean;
    /** Warning that SSH to the bastion is open to everyone (i18n key). */
    openWarning?: string;
    /** Credential test check that, when failed, breaks the bastion (shown as error). */
    blockingCheck?: string;
    /** SSH user of the bastion; default: the user of the node image. */
    sshUser?: string;
  };
}

export type InfraValues = Record<string, string | number | boolean | null | undefined>;

/** Preselection of the image lists: Ubuntu 24.04. */
export const ubuntuImage = (images: LookupOption[]): string | undefined =>
  images.find((i) => /ubuntu.*24\.04/i.test(i.label))?.value;

/** Values of a new cluster's infrastructure step. */
export function initialInfraValues(form: InfraForm): InfraValues {
  return Object.fromEntries(form.fields.map((f) => [f.path, f.default ?? '']));
}

/** The spec's `infrastructure` from the form values; empty optional values are left out. */
export function infraFromValues(
  provider: Infrastructure['provider'],
  form: InfraForm,
  values: InfraValues,
  credentialRef: string,
  bastion: { enabled: boolean; machineSize: string; allowedCidrs: string[] },
): Record<string, unknown> {
  const out: Record<string, unknown> = { provider, credentialRef };
  for (const f of form.fields) {
    const raw = values[f.path];
    let value: unknown;
    if (f.kind === 'switch') value = !!raw;
    else if (f.kind === 'number') value = raw === '' || raw == null ? undefined : Number(raw);
    else if (f.kind === 'list')
      value = String(raw ?? '')
        .split(/[\s,]+/)
        .filter(Boolean);
    else if (typeof raw === 'string') value = f.clearable ? raw.trim() || undefined : raw.trim();
    else value = raw ?? undefined;
    if (value === undefined) continue;
    setPath(out, f.path, value);
  }
  if (form.bastion && bastion.enabled) {
    out.bastion = {
      enabled: true,
      ...(form.bastion.allowedCidrs
        ? { allowedCidrs: bastion.allowedCidrs.map((c) => c.trim()) }
        : {}),
      ...(bastion.machineSize ? { machineSize: bastion.machineSize } : {}),
    };
  }
  return out;
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  let node = target;
  for (const k of keys.slice(0, -1)) node = (node[k] ??= {}) as Record<string, unknown>;
  node[keys.at(-1)!] = value;
}

/** Bastion part of a day-2 request (FP5-F-20). */
export function bastionRequest(
  form: InfraForm,
  draft: { enabled: boolean; machineSize: string; allowedCidrs: string[] },
): { enabled: boolean; machineSize?: string; allowedCidrs?: string[] } {
  return {
    enabled: draft.enabled,
    ...(draft.machineSize ? { machineSize: draft.machineSize } : {}),
    ...(form.bastion?.allowedCidrs && draft.enabled
      ? { allowedCidrs: draft.allowedCidrs.map((c) => c.trim()) }
      : {}),
  };
}

/** Whether a bastion draft is complete (sizes and networks as the provider needs them). */
export function bastionComplete(
  form: InfraForm,
  draft: { enabled: boolean; machineSize: string; allowedCidrs: string[] },
): boolean {
  if (!draft.enabled) return true;
  if (form.bastion?.sizeRequired && !draft.machineSize) return false;
  if (form.bastion?.allowedCidrs && draft.allowedCidrs.length === 0) return false;
  return true;
}
