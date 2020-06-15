import * as crypto from 'crypto';

export function genRandomString(len = 12): string {
  return crypto
    .randomBytes(Math.ceil((len * 3) / 4))
    .toString('base64')
    .slice(0, len)
    .replace(/\+/g, '0')
    .replace(/\//g, '0');
}
