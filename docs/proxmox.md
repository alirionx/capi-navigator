# Proxmox VE

CAPI Navigator creates Kubernetes clusters on Proxmox VE with the Cluster API provider
[CAPMOX](https://github.com/ionos-cloud/cluster-api-provider-proxmox) (FP-31). Proxmox has no load
balancer, no machine flavors and no address management of its own; the app adds them in a way that
stays upstream ([ADR-0027](adr/0027-proxmox-ve-with-capmox.md)). This page covers the one-time setup
in Proxmox VE, what the app creates per cluster, and the limits compared with the clouds.

## Setup in Proxmox VE

1. **API token**: create a user and a role with the privileges CAPMOX, the cloud controller manager
   and the CSI driver need, and a token without privilege separation (it then has the user's
   privileges):

   ```bash
   pveum user add capmox@pve
   pveum role add CAPINavigator -privs "VM.Allocate VM.Clone VM.Config.CDROM VM.Config.CPU \
     VM.Config.Cloudinit VM.Config.Disk VM.Config.HWType VM.Config.Memory VM.Config.Network \
     VM.Config.Options VM.PowerMgmt VM.Audit VM.GuestAgent.Audit Datastore.Allocate \
     Datastore.AllocateSpace Datastore.AllocateTemplate Datastore.Audit Sys.Audit SDN.Use"
   pveum aclmod / -user capmox@pve -role CAPINavigator
   pveum user token add capmox@pve capi --privsep 0
   ```

   On Proxmox VE 8 use `VM.Monitor` instead of `VM.GuestAgent.Audit`. The ACL may be narrower than
   `/` (e.g. a pool plus the storages and the bridge); the credential test in the app names what is
   missing. Templates the token cannot see do not show up in the wizard.

2. **CA certificate**: if the API uses a certificate of a private CA (the Proxmox default), keep
   the root CA as PEM (`/etc/pve/pve-root-ca.pem` on a node). The app verifies TLS against it and
   hands it to CAPMOX, the CCM and the CSI driver; nothing skips verification.

3. **VM templates** from stock cloud images, one per operating system or storage class you want to
   offer (e.g. `ubuntu-24-fast-ssd` and `ubuntu-24-hdd`):

   ```bash
   qm create 9000 --name ubuntu-2404 --memory 2048 --net0 virtio,bridge=vmbr0 \
     --scsihw virtio-scsi-pci --agent enabled=1 --serial0 socket --vga serial0
   qm set 9000 --scsi0 local-zfs:0,import-from=/var/lib/vz/template/iso/noble-server-cloudimg-amd64.img
   qm set 9000 --boot order=scsi0
   qm template 9000
   ```

   - **No Proxmox cloud-init drive** (`ide2`/`scsi1` of type cloudinit): CAPMOX brings its own
     bootstrap data as a NoCloud ISO, and cloud-init would read the Proxmox drive instead (no
     static IP, no bootstrap). Remove it with `qm set <id> --delete ide2`. The wizard warns about
     templates that still have one.
   - **QEMU guest agent enabled** (`--agent enabled=1`). The app installs `qemu-guest-agent` on
     first boot, so the image itself need not contain it.
   - Debian 13 and Ubuntu 24.04/26.04 cloud images are tested.

4. **Addresses**: reserve a range in the bridge's network outside any DHCP range, per cluster:
   one address per node plus one more during rollouts, and one more address for the API (the
   virtual IP). Optionally a second range for Services of type `LoadBalancer`. Clusters must not
   share addresses; the app refuses overlaps.

## In the app

1. **Providers**: install core, the providers of your distribution (RKE2, k0smotron or kubeadm),
   the **in-cluster IPAM provider**, then **Proxmox VE (CAPMOX)**, and CAAPH. CAPMOX needs the IPAM
   provider ready first. Store the credential before CAPMOX (or update CAPMOX afterwards), so it
   gets the CA bundle.
2. **Credentials → Add Proxmox VE**: API URL (e.g. `https://pve.example:8006`), token ID
   (`capmox@pve!capi`), token secret and CA certificate. The token is stored as a Secret in
   `capmox-system` and never shown again. **Test** checks the version, TLS and the token's
   effective privileges. Each credential keeps its **machine sizes** (vCPUs and memory, four
   defaults from 2 vCPU/4 GiB to 8 vCPU/32 GiB), which admins can edit; changed sizes roll out as
   new machine templates.
3. **Create cluster**: choose Proxmox VE and fill in the infrastructure step:

   | Field                  | Meaning                                                                                                   |
   | ---------------------- | --------------------------------------------------------------------------------------------------------- |
   | Node, template         | Proxmox node that holds the template; VMs are full clones of it                                           |
   | Boot disk, storage     | Disk of the template with the root file system (grown to the wizard's size) and the storage of the clones |
   | Bridge                 | Network bridge of the VMs (default `vmbr0`)                                                               |
   | Network, gateway       | The bridge's network in CIDR notation and its gateway                                                     |
   | Node addresses         | The cluster's range, e.g. `10.20.0.71-10.20.0.80`                                                         |
   | API virtual IP         | A free address in the network, outside the node range                                                     |
   | LoadBalancer addresses | Optional: addresses for Services of type `LoadBalancer` (see below)                                       |
   | Memory scheduling      | CAPMOX's memory check (see below), default 0 = off                                                        |
   | Allowed nodes, VM ID   | Optional: further Proxmox nodes for the VMs, and a VM ID range of their own                               |

4. **Later changes**: the cluster's **Configuration** tab shows the infrastructure settings that
   may change after creation (FP-33): memory scheduling and allowed nodes (apply when the next VM
   is placed), DNS servers (new nodes; rebuild to give existing ones the new servers) and node
   addresses (CAPMOX updates the cluster's `InClusterIPPool`). Addresses can only be added: the
   IPAM provider refuses to drop addresses in use, and CAPMOX would retry that forever.
   LoadBalancer addresses can be added, or all removed to switch the feature off (FP-32). Network,
   gateway, virtual IP, node, storage and bridge stay as created.

## What the app creates

Everything is standard CAPMOX and stays manageable without the app:

| Resource                 | Details                                                                                                                                                          |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ProxmoxCluster`         | Node addresses, gateway and DNS (`ipv4Config`, CAPMOX creates an `InClusterIPPool`), the virtual IP as control plane endpoint, allowed nodes, memory scheduling  |
| `ProxmoxMachineTemplate` | Full clone of the template with the size from the credential, boot disk size, bridge and storage                                                                 |
| Credentials Secret       | A copy of the token per cluster: CAPMOX takes ownership and deletes it with the cluster, the stored credential is never referenced directly                      |
| kube-vip                 | Holds the virtual IP on the control plane nodes (see below)                                                                                                      |
| LoadBalancer Services    | Only with LoadBalancer addresses: kube-vip for Services and kube-vip-cloud-provider as Helm add-ons; the range as annotation on the `ProxmoxCluster`             |
| Cloud controller manager | [Proxmox CCM](https://github.com/sergelogvinov/proxmox-cloud-controller-manager) as Helm add-on: node initialization, region (credential) and zone (node) labels |
| CSI plugin               | [Proxmox CSI plugin](https://github.com/sergelogvinov/proxmox-csi-plugin) with the default StorageClass `proxmox` on the cluster's storage                       |

CCM and CSI get the token and the CA as a Secret in `kube-system`, delivered by a
ClusterResourceSet; they never appear in Helm values. The kubelet reports the node's address
(`--node-ip`, the source address towards the gateway), which the CCM sets as `InternalIP`.

## API endpoint with kube-vip

kube-vip runs on every control plane node in ARP mode; the leader answers for the virtual IP.
RKE2 and k0s deploy it from their manifest directories, kubeadm as a static pod. Services of type
`LoadBalancer` have an instance of their own (see below).

- **Failover**: when the leader's API server stops, the VIP moves to another control plane node.
  It takes 13 to 25 seconds (lease expiry plus ARP announcement); clients reconnect.
- **Workaround**: kube-vip has no health check of the API server in ARP mode
  ([kube-vip#800](https://github.com/kube-vip/kube-vip/issues/800),
  [kube-vip#1787](https://github.com/kube-vip/kube-vip/issues/1787)). It therefore renews its lease
  through the node's own API server, with the node's admin kubeconfig: a node whose API server is
  gone loses the lease. The kube-vip pod holds these admin credentials; it runs only on control
  plane nodes, in the host network.
- **No load distribution**: all API traffic goes to the leader. For small clusters this is fine; a
  load balancer with health checks in front of the control plane nodes (e.g. HAProxy with
  keepalived) can be added outside the app.

## Services of type LoadBalancer and volumes

- **LoadBalancer Services** (FP-32, ADR-0028): give the cluster **LoadBalancer addresses** in the
  wizard, or later in the Configuration tab. The app then rolls out two Helm add-ons from the
  [kube-vip charts](https://github.com/kube-vip/helm-charts):
  [kube-vip-cloud-provider](https://github.com/kube-vip/kube-vip-cloud-provider) hands out the
  addresses in order, and a second kube-vip on every node (services only, metrics on port 2113)
  announces each address by ARP from one node. Without LoadBalancer addresses such Services stay
  pending, as Proxmox has no load balancer.
  - **One node per address**: all traffic of a Service goes through the node that holds its
    address (no load distribution, as with MetalLB in L2 mode); kube-proxy forwards it to the pods.
  - **Failover**: when that node fails, another one takes the address after about 15 seconds; the
    Service answered again after about 30 seconds in the tests. kube-vip announces an address only
    while the Service has ready endpoints, so run more than one replica, on different nodes: pods
    of a failed node are rescheduled only after about 5 minutes.
  - **Range used up**: a further Service stays pending with the event "no addresses available";
    add a range in the Configuration tab, it applies without a restart.
  - **Switching off**: removing all ranges uninstalls both add-ons; Services of type `LoadBalancer`
    lose their addresses (their status still shows them, nothing clears it; delete them or change
    their type). Removing only some ranges is refused, Services may use them.
- **Volumes** of the CSI plugin live on the cluster's storage. On local storage (e.g. `local-zfs`)
  a volume stays on its Proxmox node, which is the zone of the node labels; with several Proxmox
  nodes, shared storage (Ceph, NFS) lets pods move between them.

## Air-gapped clusters

RKE2, k0s and kubeadm clusters can run on nodes without internet access (FP-29,
[ADR-0030](adr/0030-air-gapped-nodes-from-an-internal-registry.md),
[ADR-0032](adr/0032-kubeadm-on-capi-images.md)): the nodes pull every image through an internal OCI
registry. RKE2 and k0s download their binaries from it; kubeadm runs on a Cluster API image that
has them already (see [Cluster API images for kubeadm](#cluster-api-images-for-kubeadm)). What
Proxmox VE needs in addition:

- **RKE2 and k0s: a template with the QEMU guest agent installed.** The app normally installs `qemu-guest-agent`
  on first boot, which needs the internet; without the agent CAPMOX waits for cloud-init forever.
  Bake it into the cloud image before you import it, e.g. with `virt-customize` from
  libguestfs-tools:

  ```bash
  virt-customize -a debian-13-genericcloud-amd64.qcow2 --install qemu-guest-agent
  ```

  Then create the template from that image as above (`--agent enabled=1`, no cloud-init drive). On
  RHEL 10 and derivatives, RKE2 also needs `kernel-modules-extra` in the image. Ready-made images of
  this kind (`<os>-qga`: the stock Ubuntu or Debian cloud image plus the guest agent) are in the
  releases of [capi-navigator-images](https://github.com/alirionx/capi-navigator-images), for
  testing only.

- **Internal DNS servers** in the infrastructure step: the nodes must resolve the registry, and
  public resolvers are not reachable. The wizard warns about public ones.
- **A gateway** is still required by CAPMOX; it need not route anywhere. The nodes must reach the
  registry, the Proxmox VE API (CCM and CSI) and each other in the bridge's network.

In the app:

1. **Credentials → Internal registry**: the registry's host, its CA if private, the path per
   upstream registry (e.g. `docker.io` → `proxy-docker-io` for a Harbor proxy cache project) and
   the path of the binary artifacts. The registry must allow anonymous pulls.
2. **Create cluster** with RKE2, k0s or kubeadm and the switch **Air-gapped** on. For RKE2 and k0s
   the preview looks up the binaries of the version in the registry; if they are missing, it shows
   the commands that download them from the upstream release and push them with `oras push`. Run
   them once per version, then preview again. For kubeadm choose a template with a Cluster API
   image of exactly the selected version; a node on another image stops during bootstrap.
3. **Registry contents** in the preview and on the cluster page lists every image the cluster needs with `skopeo copy`
   commands. A proxy cache that reaches the internet fills itself; a registry without one needs
   them all before the nodes start.

Upgrades work like for other clusters: push the binaries of the new version first, the preview
pins them and the machines are replaced. kubeadm upgrades ask for the template of the new version:
the control plane moves to it at once, the worker pools when they follow.

### Cluster API images for kubeadm

A Cluster API image has containerd, runc, kubelet, kubeadm and kubectl of one Kubernetes version
preinstalled, as the Image Builder of Cluster API produces them. On Proxmox VE it also needs the QEMU
guest agent. The app uses such a template **air-gapped and online**: online, the install script
finds kubeadm of the selected version and installs nothing (another version: it changes only the
Kubernetes packages), so one template serves both. The version in the template's name lets the
wizard warn about a mismatch, e.g. `debian-13-kube-v1-36-5`.

The project publishes no supported images. Two ways to get one for Proxmox VE:

- **An osism image with the guest agent added.** [osism](https://github.com/osism/k8s-capi-images)
  publishes maintained Cluster API images for OpenStack (Ubuntu, one per Kubernetes version). They
  boot on Proxmox VE with NoCloud as well, but lack the guest agent; add it with `virt-customize`
  (needs internet while customizing):

  ```bash
  apt-get install -y libguestfs-tools
  virt-customize -a ubuntu-2404-kube-v1.36.5.qcow2 --install qemu-guest-agent
  ```

  Note that osism holds every package of the image, so the image gets no OS updates on its own.

- **Build one from a stock cloud image with `virt-customize`**, directly on a Proxmox VE node:
  start from the Ubuntu or Debian cloud image, install `qemu-guest-agent`, `conntrack` and `socat`,
  containerd and runc (release binaries), kubelet, kubeadm, kubectl, cri-tools and kubernetes-cni of
  the version from `pkgs.k8s.io` (held), and configure containerd with `SystemdCgroup = true`,
  `config_path = '/etc/containerd/certs.d'` (for the registry mirrors) and the pause image kubeadm
  of that version expects. A complete example with a boot test, also as a GitHub Actions workflow,
  is in [capi-navigator-images](https://github.com/alirionx/capi-navigator-images) (for testing
  only, without warranty). Building takes about 90 seconds.

For other infrastructures use the official [Image Builder](https://image-builder.sigs.k8s.io/)
(Packer); on OpenStack the osism images work as they are.

Import the image as template as [above](#setup-in-proxmox-ve), e.g.:

```bash
qm create 9000 --name debian-13-kube-v1-36-5 --ostype l26 --cpu host --cores 2 --memory 4096 \
  --net0 virtio,bridge=vmbr0 --scsihw virtio-scsi-single --serial0 socket --vga serial0 --agent enabled=1
qm disk import 9000 debian-13-kube-v1.36.5.qcow2 local-zfs
qm set 9000 --virtio0 local-zfs:vm-9000-disk-0 --boot order=virtio0
qm template 9000
```

## Troubleshooting

- **A machine stays in Provisioning with "cannot reserve … of memory"**: CAPMOX's memory
  scheduling counts the configured memory of all VMs of a node, stopped ones and templates
  included, and refuses VMs beyond `memoryAdjustment` percent of the node's memory. CAPMOX does
  not retry a refused machine. Lower the value (0 turns the check off, the default for new
  clusters) and delete the machine; CAPI creates a replacement.
- **Machines stay in Provisioning although the nodes are Ready, workers keep the taint
  `node.cluster.x-k8s.io/uninitialized`**: the template has the QEMU guest agent disabled.
  CAPMOX waits for the agent to report that cloud-init has finished
  (`VirtualMachineProvisioned: WaitingForCloudInit`) and only then sets the provider ID. The
  wizard warns and the preview refuses such templates. For running VMs: `qm set <vmid> --agent
enabled=1`, then shut the VM down and start it again (a reboot inside the guest does not add
  the agent's device); fix the template the same way.
- **A VM boots without address or never joins**: the template still has a Proxmox cloud-init
  drive; remove it and replace the machine.
- **A VM runs but never answers, `WaitingForCloudInit` without end**: the template's boot order
  contains no disk (e.g. `order=net0`); clones keep it, so the VM never boots its system. The
  wizard warns and the preview refuses such templates. Fix the template
  (`qm set <id> --boot order=virtio0`, with its boot disk) and delete the machine.
- **A node stays in the list for a short while after it was replaced**: during the VIP move CAPI
  cannot always delete the Node object; the CCM removes it once the VM is gone.

## Deleting

Delete clusters in the app with cleanup: it removes `LoadBalancer` Services and volumes first, so
the CSI plugin deletes its disks before CAPMOX removes the VMs, their bootstrap ISOs and the
cluster's IP addresses. The stored credential and its machine sizes stay.
