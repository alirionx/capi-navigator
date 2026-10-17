# ADR-0003: AWS user data without Secrets Manager on stock images

- Status: accepted
- Date: 2026-10-17
- Pack: FP-5

## Context

CAPA v2.13.1 delivers bootstrap user data through AWS Secrets Manager by default: a cloud-init
boothook downloads it with the `aws` CLI and deletes the secret
(`pkg/cloud/services/secretsmanager/secret_fetch_script.go`). The official Ubuntu, Rocky Linux and
Debian AMIs do not ship the `aws` CLI, so nodes created from stock images (goal 3 of the
requirements) would never bootstrap.

## Decision

AWS machine templates set `cloudInit.insecureSkipSecretsManager: true`. To limit who can read the
user data (which contains the RKE2 join token), instances require IMDSv2
(`instanceMetadataOptions.httpTokens: required`), which blocks SSRF-style IMDSv1 requests. The
hop limit is `httpPutResponseHopLimit: 2`: the EBS CSI controller runs in the pod network, its
chart has no host-network option, and it needs the instance profile credentials from IMDS. A
first live test with hop limit 1 left the controller without credentials. The wizard explains
this trade-off.

## Consequences

- Stock AMIs work without prebuilt images.
- Pods on the nodes can read the user data (including the join token) and the node's instance
  profile credentials. Restrict untrusted workloads with a network policy that blocks
  `169.254.169.254`, or use dedicated nodes for them.
- The EBS CSI preset takes the region from the `AWSCluster` instead of IMDS.
- The AWS CCM preset runs with host networking: it must start before the pod network, since
  it removes the `uninitialized` taint that Calico Typha does not tolerate.
- The join token is readable from the instance metadata on the node itself and via
  `ec2:DescribeInstanceAttribute`; restrict that IAM permission in the account.
- Revisit if CAPA offers a secret delivery that does not need the `aws` CLI on the image, or if
  the EBS CSI driver can use credentials other than the instance profile (e.g. Pod Identity).
