import { resetAdminPassword } from '../src/adminStore.js';
const password = await resetAdminPassword();
console.log(`Логин: admin. Новый временный пароль: ${password}`);
console.log('Все браузерные сессии отозваны. Задайте постоянный пароль при входе.');
