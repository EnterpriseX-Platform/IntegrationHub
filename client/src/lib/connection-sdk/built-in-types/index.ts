import { registerDatabaseTypes } from './database';
import { registerStorageTypes } from './storage';
import { registerApiTypes } from './api';
import { registerMessagingTypes } from './messaging';

export { databaseSubtypes, databaseConnectionType, getDatabaseType } from './database';
export { storageTypes } from './storage';
export { apiTypes } from './api';
export { messagingTypes } from './messaging';

export function registerAllBuiltInTypes(register: (type: any) => void): void {
  registerDatabaseTypes(register);
  registerStorageTypes(register);
  registerApiTypes(register);
  registerMessagingTypes(register);
}
