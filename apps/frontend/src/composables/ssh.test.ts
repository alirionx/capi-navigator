import { describe, expect, it } from 'vitest';
import { sshJumpCommand, sshUserFor } from './ssh.js';

describe('ssh helpers (FP5-F-20)', () => {
  it('derives the login user from the image name', () => {
    expect(sshUserFor('Ubuntu 24.04 LTS Noble Numbat')).toBe('ubuntu');
    expect(sshUserFor('ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server')).toBe('ubuntu');
    expect(sshUserFor('Rocky-10-EC2-Base-10.0')).toBe('rocky');
    expect(sshUserFor('debian-13-amd64-20260101')).toBe('admin');
    expect(sshUserFor('custom-image')).toBeUndefined();
  });
  it('builds the jump command', () => {
    expect(
      sshJumpCommand({
        bastionIP: '1.2.3.4',
        bastionUser: 'ubuntu',
        nodeIP: '10.6.0.5',
        nodeUser: 'rocky',
      }),
    ).toBe('ssh -J ubuntu@1.2.3.4 rocky@10.6.0.5');
  });
});
