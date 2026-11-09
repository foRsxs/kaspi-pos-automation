import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { DATA_DIR } from './paths.js';
import { ecKeyPair } from './config.js';
import { getIdentity } from './identity.js';

const ecdhFileFor = (projectId) => {
  const directory = projectId ? getIdentity(projectId).directory : DATA_DIR;
  return path.join(directory, 'ecdh-keypair.json');
};

// ─── ECDH ───

const vtokenSuite = 'OCRA-1:HOTP-SHA256-6:QH64-T1M';

// ─── AES-256-GCM encryption for vtokenSecret ───

if (!/^[a-fA-F0-9]{64}$/.test(process.env.TOKEN_SECRET_KEY || '')) {
  console.error('FATAL: TOKEN_SECRET_KEY must be exactly 64 hexadecimal characters.');
  console.error('Generate a value with openssl rand -hex 32 and set TOKEN_SECRET_KEY in .env.');
  process.exit(1);
}
const ENCRYPTION_KEY = Buffer.from(process.env.TOKEN_SECRET_KEY, 'hex');

export const encryptSecret = (secretBuffer) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(secretBuffer), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
};

export const decryptSecret = (tokenB64) => {
  const buf = Buffer.from(tokenB64, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const encrypted = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
};

export const generateECDH = (projectId) => {
  const ecdhKeyPair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  // Persist ECDH private key so refresh (SignInLite) can reuse it
  const saved = {
    privateKey: ecdhKeyPair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
    publicKey: ecdhKeyPair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  };
  fs.writeFileSync(ecdhFileFor(projectId), JSON.stringify(saved, null, 2), { mode: 0o600 });
  const spki = ecdhKeyPair.publicKey.export({ type: 'spki', format: 'der' });
  return spki.toString('base64');
};

export const completeECDH = (serverX509B64, projectId) => {
  const saved = JSON.parse(fs.readFileSync(ecdhFileFor(projectId), 'utf8'));
  const privateKey = crypto.createPrivateKey({
    key: Buffer.from(saved.privateKey, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  const serverPubKey = crypto.createPublicKey({
    key: Buffer.from(serverX509B64, 'base64'),
    format: 'der',
    type: 'spki',
  });
  return crypto.diffieHellman({ privateKey, publicKey: serverPubKey });
};

export const completeECDHWithSaved = completeECDH;

// ─── Helpers ───

const hexToBytes = (hex) => {
  const bytes = [];
  for (let i = 0; i < hex.length; i += 2) {
    bytes.push(parseInt(hex.substring(i, i + 2), 16));
  }
  return Buffer.from(bytes);
};

// ─── OCRA-1 TOTP (matches Kaspi vtoken) ───

export const computeTokenSnMac = (tokenSN, secret) => {
  if (!secret) return '000000';

  const timeStep = BigInt(Date.now()) / BigInt(30000);
  const timeHex = timeStep.toString(16);

  const qHex = Buffer.from(tokenSN || '00000000')
    .toString('hex')
    .substring(0, 64);

  const suiteBytes = Buffer.from(vtokenSuite);
  const separator = Buffer.from([0x00]);

  const qPadded = qHex.padEnd(256, '0');
  const qBytes = hexToBytes(qPadded);

  const tPadded = timeHex.padStart(16, '0');
  const tBytes = hexToBytes(tPadded);

  const dataBuffer = Buffer.concat([suiteBytes, separator, qBytes, tBytes]);

  const hash = crypto.createHmac('sha256', secret).update(dataBuffer).digest();

  // Dynamic truncation (RFC 4226)
  const offset = hash[hash.length - 1] & 0x0f;
  const binCode =
    ((hash[offset] & 0x7f) << 24) |
    ((hash[offset + 1] & 0xff) << 16) |
    ((hash[offset + 2] & 0xff) << 8) |
    (hash[offset + 3] & 0xff);

  return (binCode % 1000000).toString().padStart(6, '0');
};

// ─── ECDSA signing ───

export const ecSign = (data, keyPair = ecKeyPair) => {
  const sign = crypto.createSign('SHA256');
  sign.update(data);
  sign.end();
  return sign.sign(keyPair.privateKey).toString('base64');
};

export const signDataPayload = (dataB64, keyPair) => ecSign(dataB64, keyPair);

export const computeXSU = (url) => crypto.createHash('md5').update(url.toLowerCase()).digest('hex');

export const computeXSign = (url, headers, xshList, body, keyPair) => {
  const keys = xshList.split(',');
  const lines = [];
  for (const name of keys) {
    if (name === 'url') {
      lines.push('url:' + url.toLowerCase());
    } else {
      lines.push(name.toLowerCase() + ':' + (headers[name] || ''));
    }
  }
  let signText = lines.join('\n');
  if (body) {
    signText += '\n' + body;
  }
  const hash = crypto.createHash('sha256').update(signText, 'utf8').digest();
  return ecSign(hash, keyPair);
};
