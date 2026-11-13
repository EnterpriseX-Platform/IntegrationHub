import type { ConnectionTypeDefinition } from './types';

class ConnectionRegistry {
  private types: Map<string, ConnectionTypeDefinition> = new Map();

  register(type: ConnectionTypeDefinition): void {
    if (this.types.has(type.id)) {
      console.warn(`[ConnectionRegistry] Type "${type.id}" is already registered. Overwriting...`);
    }
    this.types.set(type.id, type);
    console.log(`[ConnectionRegistry] Registered connection type: ${type.id}`);
  }

  unregister(typeId: string): void {
    this.types.delete(typeId);
    console.log(`[ConnectionRegistry] Unregistered connection type: ${typeId}`);
  }

  get(typeId: string): ConnectionTypeDefinition | undefined {
    return this.types.get(typeId);
  }

  getAll(): ConnectionTypeDefinition[] {
    return Array.from(this.types.values());
  }

  getByCategory(category: string): ConnectionTypeDefinition[] {
    return this.getAll().filter(type => type.category === category);
  }

  getByIdPrefix(prefix: string): ConnectionTypeDefinition[] {
    return this.getAll().filter(type => type.id.startsWith(prefix));
  }

  isRegistered(typeId: string): boolean {
    return this.types.has(typeId);
  }

  // Group types by category
  getGroupedByCategory(): Record<string, ConnectionTypeDefinition[]> {
    const groups: Record<string, ConnectionTypeDefinition[]> = {};
    this.getAll().forEach(type => {
      if (!groups[type.category]) {
        groups[type.category] = [];
      }
      groups[type.category].push(type);
    });
    return groups;
  }
}

// Singleton instance
export const connectionRegistry = new ConnectionRegistry();

// Helper functions
export function registerConnectionType(type: ConnectionTypeDefinition): void {
  connectionRegistry.register(type);
}

export function getConnectionType(typeId: string): ConnectionTypeDefinition | undefined {
  return connectionRegistry.get(typeId);
}

export function getConnectionIcon(typeId: string): string {
  const type = connectionRegistry.get(typeId);
  return type?.icon || 'fa-plug';
}

export function getConnectionColors(typeId: string) {
  const type = connectionRegistry.get(typeId);
  return type?.colors || { 
    bg: 'bg-gray-100', 
    text: 'text-gray-600', 
    border: 'border-gray-200' 
  };
}

export function getAllConnectionTypes(): ConnectionTypeDefinition[] {
  return connectionRegistry.getAll();
}

export function getConnectionTypesByCategory(category: string): ConnectionTypeDefinition[] {
  return connectionRegistry.getByCategory(category);
}
