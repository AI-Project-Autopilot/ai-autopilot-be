import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { ServiceUnavailableException } from '@nestjs/common';

export const randomToken = () => randomBytes(32).toString('base64url');
export const hashToken = (value: string) => createHash('sha256').update(value).digest('hex');
export const challenge = (value: string) => createHash('sha256').update(value).digest('base64url');

export function encryptionKey(): Buffer {
  const value = process.env.GITHUB_TOKEN_ENCRYPTION_KEY ?? '';
  if (!/^[a-fA-F0-9]{64}$/.test(value)) {
    throw new ServiceUnavailableException('GitHub token encryption is not configured.');
  }
  return Buffer.from(value, 'hex');
}

export function encrypt(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((v) => v.toString('base64url')).join('.');
}

export function decrypt(value: string): string {
  const [iv, tag, encrypted] = value.split('.').map((v) => Buffer.from(v, 'base64url'));
  const cipher = createDecipheriv('aes-256-gcm', encryptionKey(), iv);
  cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(encrypted), cipher.final()]).toString('utf8');
}
