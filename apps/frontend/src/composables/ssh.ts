/** Default login user of the stock cloud images (FP5-F-20); undefined if unknown. */
export function sshUserFor(imageName: string | undefined): string | undefined {
  if (!imageName) return undefined;
  if (/ubuntu/i.test(imageName)) return 'ubuntu';
  if (/rocky/i.test(imageName)) return 'rocky';
  if (/debian/i.test(imageName)) return 'admin';
  if (/amzn|amazon/i.test(imageName)) return 'ec2-user';
  return undefined;
}

/** `ssh -J` command through the bastion to a node. */
export function sshJumpCommand(opts: {
  bastionIP: string;
  bastionUser: string;
  nodeIP: string;
  nodeUser: string;
}): string {
  return `ssh -J ${opts.bastionUser}@${opts.bastionIP} ${opts.nodeUser}@${opts.nodeIP}`;
}
