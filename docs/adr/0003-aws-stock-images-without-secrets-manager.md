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
(`instanceMetadataOptions.httpTokens: required`) with `httpPutResponseHopLimit: 1`, so ordinary
pods cannot reach the instance metadata service; host-network components (cloud controller
manager) still can. The wizard explains this trade-off.

## Consequences

- Stock AMIs work without prebuilt images.
- The join token is readable from the instance metadata on the node itself and via
  `ec2:DescribeInstanceAttribute`; restrict that IAM permission in the account.
- Revisit if CAPA offers a secret delivery that does not need the `aws` CLI on the image.
