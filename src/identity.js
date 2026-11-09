import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './paths.js';
import { readJson, writeJson } from './storage.js';

const identities = new Map();

export const getIdentity = (projectId) => {
  if (typeof projectId !== 'string' || !/^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,63}$/.test(projectId)) {
    throw new Error('Invalid project identity');
  }
  if (identities.has(projectId)) return identities.get(projectId);
  // Keep the original installation available for legacy tracked operations.
  const directory = projectId === '__admin__' ? DATA_DIR : path.join(DATA_DIR, 'projects', projectId);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const keyFile = path.join(directory, 'keypair.json');
  const saved = readJson(keyFile, null);
  const keyPair = saved
    ? {
        privateKey: crypto.createPrivateKey({
          key: Buffer.from(saved.privateKey, 'base64'),
          format: 'der',
          type: 'pkcs8',
        }),
        publicKey: crypto.createPublicKey({ key: Buffer.from(saved.publicKey, 'base64'), format: 'der', type: 'spki' }),
      }
    : crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  if (!saved)
    writeJson(keyFile, {
      privateKey: keyPair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
      publicKey: keyPair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    });
  const deviceFile = path.join(directory, 'device.json');
  let device = readJson(deviceFile, null);
  if (!device) {
    device = {
      deviceId: crypto.randomUUID().toUpperCase(),
      installId: crypto.randomUUID().toUpperCase(),
      pinHash: crypto.createHash('md5').update(crypto.randomBytes(16)).digest('hex'),
    };
    writeJson(deviceFile, device);
  }
  const publicKey = keyPair.publicKey.export({ type: 'spki', format: 'der' });
  const pk = publicKey.subarray(-65).toString('base64');
  const identity = {
    directory,
    keyPair,
    device: {
      ...device,
      pk,
      pkTag: crypto.createHash('md5').update(pk).digest('hex'),
      x509: publicKey.toString('base64'),
    },
  };
  identities.set(projectId, identity);
  return identity;
};
