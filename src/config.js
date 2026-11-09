import 'dotenv/config';
import { getIdentity } from './identity.js';
import { ROOT_DIR } from './paths.js';

export const PORT = process.env.PORT || 3000;

// Legacy identity is only used by old tracked operations and utility callers.
export const { device: DEVICE, keyPair: ecKeyPair } = getIdentity('__admin__');

// ─── Kaspi Base URLs ───

export const KASPI_ENTRANCE_URL = 'https://entrance-pay.kaspi.kz';
export const KASPI_MTOKEN_URL = 'https://mtoken.kaspi.kz';
export const KASPI_QRPAY_URL = 'https://qrpay.kaspi.kz';

// ─── App version & device constants ───
// Defaults match a known-good Kaspi Pay client. Override via .env if needed.
// ⚠️ The Kaspi API validates these parameters. Kaspi raises the minimum app version periodically; when it does,
// login fails at the phone step with view.onOpenAlarm.error.code = "OldVersionToUpdate" ("Обновите приложение,
// чтобы войти") for EVERY cashier. Fix: set APP_VERSION/APP_BUILD to the current Kaspi Pay iOS release (App Store
// version + its iOS build number) and restart. Kaspi moved to date-based versions after 4.116 (26.0907, 26.0914, …).
export const APP = {
  version: process.env.APP_VERSION || '26.1029',
  build: process.env.APP_BUILD || '1128',
  platform: process.env.APP_PLATFORM || 'iOS',
  platformVer: process.env.APP_PLATFORM_VER || '18.4',
  locale: process.env.APP_LOCALE || 'ru-RU',
  model: process.env.APP_MODEL || 'iPhone16,2',
  brand: process.env.APP_BRAND || 'Apple',
  deviceName: process.env.APP_DEVICE_NAME || 'iPhone',
  screenW: process.env.APP_SCREEN_W || '430.0',
  screenH: process.env.APP_SCREEN_H || '932.0',
  cfNetwork: process.env.APP_CFNETWORK || 'CFNetwork/3826.400.120',
  darwin: process.env.APP_DARWIN || 'Darwin/24.4.0',
};

export const UA_NATIVE = `Kaspi%20Pay/${APP.build} ${APP.cfNetwork} ${APP.darwin}`;
export const UA_BROWSER = `Mozilla/5.0 (iPhone; CPU iPhone OS ${APP.platformVer.replace('.', '_')} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148`;

export const ENTRANCE_HEADERS_BASE = {
  Accept: 'application/json, text/plain, */*',
  'Content-Type': 'application/json',
  'Accept-Language': 'ru',
  'Accept-Encoding': 'gzip, deflate, br',
  Origin: KASPI_ENTRANCE_URL,
  'Sec-Fetch-Site': 'same-origin',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Dest': 'empty',
  'User-Agent': UA_BROWSER,
};

export { ROOT_DIR };
