#!/usr/bin/env node
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { getIdentity } from '../src/identity.js';
import { listProjects } from '../src/projects.js';

const projectId = process.argv[2];
if (!listProjects().some((project) => project.id === projectId)) {
  throw new Error('Pass a configured project ID: npm run regen:<device|keypair> -- <project-id>');
}
const { directory } = getIdentity(projectId);

const FILE = path.join(directory, 'keypair.json');

if (fs.existsSync(FILE)) {
  fs.renameSync(FILE, `${FILE}.bak`);
  console.log('Backed up old keypair.json → keypair.json.bak');
}

const keyPair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const saved = {
  privateKey: keyPair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  publicKey: keyPair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
};
fs.writeFileSync(FILE, JSON.stringify(saved, null, 2), { mode: 0o600 });
console.log('Generated new ECDSA keypair → keypair.json');
console.log('⚠️  Re-authentication (SMS) required after keypair change.');
