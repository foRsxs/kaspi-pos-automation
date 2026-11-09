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

const FILE = path.join(directory, 'device.json');

if (fs.existsSync(FILE)) {
  fs.renameSync(FILE, `${FILE}.bak`);
  console.log('Backed up old device.json → device.json.bak');
}

const device = {
  deviceId: crypto.randomUUID().toUpperCase(),
  installId: crypto.randomUUID().toUpperCase(),
  pinHash: crypto.createHash('md5').update(crypto.randomBytes(16)).digest('hex'),
};
fs.writeFileSync(FILE, JSON.stringify(device, null, 2), { mode: 0o600 });
console.log('Generated new device identity → device.json');
console.log(`  deviceId:  ${device.deviceId}`);
console.log(`  installId: ${device.installId}`);
console.log('⚠️  Re-authentication (SMS) required after device change.');
