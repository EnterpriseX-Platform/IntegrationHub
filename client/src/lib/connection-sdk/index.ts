// Connection SDK - Main Entry Point
// This SDK allows registering custom connection types dynamically

export * from './types';
export * from './ConnectionRegistry';
export * from './built-in-types';

import { connectionRegistry, registerConnectionType } from './ConnectionRegistry';
import { registerAllBuiltInTypes } from './built-in-types';

// Initialize built-in types
export function initializeConnectionSDK(): void {
  console.log('[ConnectionSDK] Initializing...');
  registerAllBuiltInTypes(registerConnectionType);
  console.log(`[ConnectionSDK] Initialized with ${connectionRegistry.getAll().length} connection types`);
}

// Auto-initialize when imported
initializeConnectionSDK();

// Export registry instance for advanced usage
export { connectionRegistry };

// Utility functions for UI
export function getConnectionTypeGroups() {
  return connectionRegistry.getGroupedByCategory();
}

export function getConnectionIconClass(typeId: string): string {
  const type = connectionRegistry.get(typeId);
  return type?.icon || 'fa-plug';
}

export function getConnectionColorClasses(typeId: string) {
  const type = connectionRegistry.get(typeId);
  return type?.colors || {
    bg: 'bg-gray-100',
    text: 'text-gray-600',
    border: 'border-gray-200',
  };
}

// For backward compatibility
export const getConnectionTypeIcon = getConnectionIconClass;
export const getConnectionTypeColor = getConnectionColorClasses;
