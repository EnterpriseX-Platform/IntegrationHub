// Flow Designer SDK - Node Registry System
export interface NodeDefinition {
  type: string;
  category: string;
  label: string;
  icon: string;
  color: string;
  description: string;
  supportedFlowTypes: readonly ('rest-api' | 'event' | 'all')[];
  ports: {
    id: string;
    type: 'input' | 'output';
    position: 'top' | 'right' | 'bottom' | 'left';
  }[];
}

class NodeRegistry {
  private nodes = new Map<string, NodeDefinition>();

  register(node: NodeDefinition): void {
    this.nodes.set(node.type, node);
  }

  get(type: string): NodeDefinition | undefined {
    return this.nodes.get(type);
  }

  getAll(): NodeDefinition[] {
    return Array.from(this.nodes.values());
  }

  getByFlowType(flowType: 'rest-api' | 'event'): NodeDefinition[] {
    const all = this.getAll();
    console.log('[NodeRegistry] getByFlowType:', flowType, 'Total nodes:', all.length);
    const filtered = all.filter(n => {
      const match = n.supportedFlowTypes.includes('all') || n.supportedFlowTypes.includes(flowType);
      console.log('  -', n.type, 'supported:', n.supportedFlowTypes, 'match:', match);
      return match;
    });
    console.log('[NodeRegistry] Filtered:', filtered.length, 'nodes');
    return filtered;
  }
}

export const nodeRegistry = new NodeRegistry();
