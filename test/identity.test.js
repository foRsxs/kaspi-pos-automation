import { it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const makeServerKeyPair = () => crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

const sharedSecretFromServer = (serverKeyPair, clientPublicKeyB64) =>
  crypto.diffieHellman({
    privateKey: serverKeyPair.privateKey,
    publicKey: crypto.createPublicKey({
      key: Buffer.from(clientPublicKeyB64, 'base64'),
      format: 'der',
      type: 'spki',
    }),
  });

it('keeps ECDH keys, device identities, and merchant sessions isolated per project', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kaspi-identities-'));
  const originalDataDir = process.env.DATA_DIR;
  const originalTokenSecretKey = process.env.TOKEN_SECRET_KEY;
  process.env.DATA_DIR = directory;
  process.env.TOKEN_SECRET_KEY = 'b'.repeat(64);
  t.after(() => {
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    if (originalTokenSecretKey === undefined) delete process.env.TOKEN_SECRET_KEY;
    else process.env.TOKEN_SECRET_KEY = originalTokenSecretKey;
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const { generateECDH, completeECDH, encryptSecret, decryptSecret } = await import('../src/crypto.js');
  const { getIdentity } = await import('../src/identity.js');
  const { requireSession, saveMerchantSession } = await import('../src/merchantSession.js');

  const shopIdentity = getIdentity('shop');
  const bookingIdentity = getIdentity('booking');
  const serverShopKeyPair = makeServerKeyPair();
  generateECDH('shop');
  const shopEcdhFile = path.join(shopIdentity.directory, 'ecdh-keypair.json');
  const savedShopKeyPair = fs.readFileSync(shopEcdhFile);

  const serverBookingKeyPair = makeServerKeyPair();
  const bookingPublicKey = generateECDH('booking');
  const bookingEcdhFile = path.join(bookingIdentity.directory, 'ecdh-keypair.json');
  const savedBookingKeyPair = fs.readFileSync(bookingEcdhFile);

  assert.deepEqual(fs.readFileSync(shopEcdhFile), savedShopKeyPair, 'generating booking ECDH must preserve shop key');

  const shopPublicKey = generateECDH('shop');
  assert.deepEqual(
    fs.readFileSync(bookingEcdhFile),
    savedBookingKeyPair,
    'generating shop ECDH must preserve the booking key',
  );

  const shopSharedSecret = completeECDH(
    serverShopKeyPair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    'shop',
  );
  const bookingSharedSecret = completeECDH(
    serverBookingKeyPair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    'booking',
  );
  assert.deepEqual(shopSharedSecret, sharedSecretFromServer(serverShopKeyPair, shopPublicKey));
  assert.deepEqual(bookingSharedSecret, sharedSecretFromServer(serverBookingKeyPair, bookingPublicKey));
  assert.notDeepEqual(shopSharedSecret, bookingSharedSecret);

  const shopSecret = Buffer.alloc(32, 0x11);
  const bookingSecret = Buffer.alloc(32, 0x22);
  const encryptedShopSecret = encryptSecret(shopSecret);
  const encryptedBookingSecret = encryptSecret(bookingSecret);
  saveMerchantSession('shop', { tokenSN: 'shop-token', profileId: 11, vtokenSecret: encryptedShopSecret });
  saveMerchantSession('booking', { tokenSN: 'booking-token', profileId: 22, vtokenSecret: encryptedBookingSecret });
  saveMerchantSession('shop', {
    tokenSN: 'shop-token-updated',
    profileId: 12,
    vtokenSecret: encryptSecret(Buffer.alloc(32, 0x33)),
  });

  let nextCalled = false;
  const request = { kaspiProject: { id: 'booking' } };
  const response = {
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
  requireSession(request, response, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);
  assert.equal(request.session.tokenSN, 'booking-token');
  assert.equal(request.session.profileId, 22);
  assert.equal(request.session.projectId, 'booking');
  assert.deepEqual(request.session.decryptedSecret, bookingSecret);
  assert.deepEqual(decryptSecret(request.session.vtokenSecret), bookingSecret);
  assert.equal(response.statusCode, undefined);

  const savedShopIdentity = {
    device: shopIdentity.device,
    publicKey: shopIdentity.keyPair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  };
  const restarted = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      [
        "import path from 'node:path';",
        "import { pathToFileURL } from 'node:url';",
        "const { getIdentity } = await import(pathToFileURL(path.resolve('src/identity.js')));",
        "const identity = getIdentity('shop');",
        "console.log(JSON.stringify({ device: identity.device, publicKey: identity.keyPair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') }));",
      ].join('\n'),
    ],
    { cwd: process.cwd(), env: process.env, encoding: 'utf8' },
  );
  assert.equal(restarted.status, 0, restarted.stderr);
  assert.deepEqual(JSON.parse(restarted.stdout), savedShopIdentity, 'shop device and key survive process restart');

  fs.copyFileSync(
    path.join(shopIdentity.directory, 'merchant-session.json'),
    path.join(bookingIdentity.directory, 'merchant-session.json'),
  );
  requireSession({ kaspiProject: { id: 'booking' } }, response, () => assert.fail('Swapped session must be rejected'));
  assert.equal(response.statusCode, 401);
});
