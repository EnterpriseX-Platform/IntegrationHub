import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { createId } from '@paralleldrive/cuid2';

interface FlowNode {
  id: string;
  type: string;
  x: number;
  y: number;
  data?: Record<string, any>;
}

interface FlowEdge {
  id: string;
  source: string;
  target: string;
  sourcePort?: string;
  targetPort?: string;
}

interface NodeDefinition {
  type: string;
  label: string;
  icon: string;
  color: string;
  category: string;
  description: string;
  ports: { id: string; type: 'input' | 'output'; position: string }[];
}

interface FlowCanvasProps {
  operationId: string;
  initialNodes: FlowNode[];
  initialEdges: FlowEdge[];
  onChange: (nodes: FlowNode[], edges: FlowEdge[]) => void;
  nodeTypes: NodeDefinition[];
}

// Mini Node Card Component
const NodeCard = ({ 
  node, 
  definition, 
  isSelected, 
  onMouseDown, 
  onClick,
  onPortMouseDown,
  onPortMouseUp,
  onDelete
}: { 
  node: FlowNode; 
  definition?: NodeDefinition;
  isSelected: boolean;
  onMouseDown: (e: React.MouseEvent) => void;
  onClick: (e: React.MouseEvent) => void;
  onPortMouseDown: (e: React.MouseEvent, portId: string, portType: string) => void;
  onPortMouseUp: (e: React.MouseEvent, portId: string, portType: string) => void;
  onDelete: () => void;
}) => {
  const nodeDef = definition || {
    type: node.type,
    label: node.type,
    icon: 'fa-cube',
    color: 'bg-gray-500',
    ports: []
  };

  // Group ports by position
  const portsByPosition = {
    left: nodeDef.ports?.filter(p => p.position === 'left') || [],
    right: nodeDef.ports?.filter(p => p.position === 'right') || [],
    top: nodeDef.ports?.filter(p => p.position === 'top') || [],
    bottom: nodeDef.ports?.filter(p => p.position === 'bottom') || [],
  };

  return (
    <div
      className={`absolute select-none ${isSelected ? 'z-20' : 'z-10'}`}
      style={{
        left: node.x,
        top: node.y,
        width: 140,
      }}
      onMouseDown={onMouseDown}
      onClick={onClick}
    >
      {/* Left Ports */}
      <div className="absolute -left-2 top-8 flex flex-col gap-2">
        {portsByPosition.left.map((port, idx) => (
          <div
            key={port.id}
            className="w-4 h-4 bg-gray-400 rounded-full border-2 border-white shadow cursor-crosshair hover:bg-blue-500 hover:scale-125 transition-all"
            style={{ marginTop: idx > 0 ? '4px' : '0' }}
            onMouseDown={(e) => { e.stopPropagation(); onPortMouseDown(e, port.id, 'input'); }}
            onMouseUp={(e) => { e.stopPropagation(); onPortMouseUp(e, port.id, 'input'); }}
            title={`${port.type}: ${port.id}`}
          />
        ))}
      </div>

      {/* Top Ports */}
      <div className="absolute left-1/2 -top-2 -translate-x-1/2 flex flex-row gap-2">
        {portsByPosition.top.map((port, idx) => (
          <div
            key={port.id}
            className="w-4 h-4 bg-gray-400 rounded-full border-2 border-white shadow cursor-crosshair hover:bg-blue-500 hover:scale-125 transition-all"
            style={{ marginLeft: idx > 0 ? '4px' : '0' }}
            onMouseDown={(e) => { e.stopPropagation(); onPortMouseDown(e, port.id, 'input'); }}
            onMouseUp={(e) => { e.stopPropagation(); onPortMouseUp(e, port.id, 'input'); }}
            title={`${port.type}: ${port.id}`}
          />
        ))}
      </div>

      {/* Node Card - Compact Design */}
      <div 
        className={`bg-white rounded-lg shadow-md border-2 transition-all cursor-move overflow-hidden ${
          isSelected ? 'border-blue-500 shadow-lg ring-2 ring-blue-200' : 'border-gray-200 hover:border-gray-300'
        }`}
      >
        {/* Header with color */}
        <div className={`${nodeDef.color} px-2 py-1.5 flex items-center gap-2`}>
          <i className={`fas ${nodeDef.icon} text-white text-xs`}></i>
          <span className="text-white text-xs font-medium truncate flex-1">
            {node.data?.label || nodeDef.label}
          </span>
          {isSelected && (
            <button
              onClick={(e) => { e.stopPropagation(); onDelete(); }}
              className="text-white/80 hover:text-white"
            >
              <i className="fas fa-times text-xs"></i>
            </button>
          )}
        </div>
        
        {/* Body - show type */}
        <div className="px-2 py-1.5 text-[12px] text-gray-500 bg-gray-50">
          {node.type}
        </div>
      </div>

      {/* Right Ports */}
      <div className="absolute -right-2 top-8 flex flex-col gap-2">
        {portsByPosition.right.map((port, idx) => (
          <div
            key={port.id}
            className="w-4 h-4 bg-gray-400 rounded-full border-2 border-white shadow cursor-crosshair hover:bg-blue-500 hover:scale-125 transition-all"
            style={{ marginTop: idx > 0 ? '4px' : '0' }}
            onMouseDown={(e) => { e.stopPropagation(); onPortMouseDown(e, port.id, 'output'); }}
            onMouseUp={(e) => { e.stopPropagation(); onPortMouseUp(e, port.id, 'output'); }}
            title={`${port.type}: ${port.id}`}
          />
        ))}
      </div>

      {/* Bottom Ports */}
      <div className="absolute left-1/2 -bottom-2 -translate-x-1/2 flex flex-row gap-2">
        {portsByPosition.bottom.map((port, idx) => (
          <div
            key={port.id}
            className="w-4 h-4 bg-gray-400 rounded-full border-2 border-white shadow cursor-crosshair hover:bg-blue-500 hover:scale-125 transition-all"
            style={{ marginLeft: idx > 0 ? '4px' : '0' }}
            onMouseDown={(e) => { e.stopPropagation(); onPortMouseDown(e, port.id, 'output'); }}
            onMouseUp={(e) => { e.stopPropagation(); onPortMouseUp(e, port.id, 'output'); }}
            title={`${port.type}: ${port.id}`}
          />
        ))}
      </div>
    </div>
  );
};



// Properties Panel Component
const PropertiesPanel = ({
  selectedNode,
  nodeDefinition,
  onUpdateNode,
  onClose
}: {
  selectedNode: FlowNode | null;
  nodeDefinition?: NodeDefinition;
  onUpdateNode: (nodeId: string, data: any) => void;
  onClose: () => void;
}) => {
  if (!selectedNode) {
    return (
      <div className="w-72 bg-white border-l border-gray-200 p-4">
        <h3 className="font-medium text-gray-900 mb-4">Properties</h3>
        <p className="text-sm text-gray-500">Select a node to edit properties</p>
      </div>
    );
  }

  return (
    <div className="w-72 bg-white border-l border-gray-200 flex flex-col">
      <div className="p-4 border-b border-gray-200 flex items-center justify-between">
        <h3 className="font-medium text-gray-900">Properties</h3>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
          <i className="fas fa-times"></i>
        </button>
      </div>
      
      <div className="p-4 space-y-4 overflow-y-auto flex-1">
        {/* Node Info */}
        <div className="p-3 bg-blue-50 rounded-lg border border-blue-200">
          <div className="flex items-center gap-2 mb-2">
            <div className={`w-8 h-8 ${nodeDefinition?.color || 'bg-gray-500'} rounded flex items-center justify-center`}>
              <i className={`fas ${nodeDefinition?.icon || 'fa-cube'} text-white text-xs`}></i>
            </div>
            <div>
              <p className="text-sm font-medium text-gray-900">{nodeDefinition?.label || selectedNode.type}</p>
              <p className="text-xs text-gray-500">{selectedNode.type}</p>
            </div>
          </div>
        </div>

        {/* Label Input */}
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Label</label>
          <input
            type="text"
            value={selectedNode.data?.label || ''}
            onChange={(e) => onUpdateNode(selectedNode.id, { ...selectedNode.data, label: e.target.value })}
            className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500 outline-none"
            placeholder="Node label"
          />
        </div>

        {/* Node Type Specific Properties */}
        {selectedNode.type === 'database' && (
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Query</label>
            <textarea
              value={selectedNode.data?.query || ''}
              onChange={(e) => onUpdateNode(selectedNode.id, { ...selectedNode.data, query: e.target.value })}
              className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500 outline-none font-mono"
              rows={3}
              placeholder="SQL Query or operation"
            />
          </div>
        )}

        {selectedNode.type === 'condition' && (
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Condition</label>
            <input
              type="text"
              value={selectedNode.data?.condition || ''}
              onChange={(e) => onUpdateNode(selectedNode.id, { ...selectedNode.data, condition: e.target.value })}
              className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500 outline-none font-mono"
              placeholder="e.g., data.status === 'active'"
            />
          </div>
        )}

        {selectedNode.type === 'error-handler' && (
          <>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Status Code</label>
              <input
                type="number"
                value={selectedNode.data?.status || 500}
                onChange={(e) => onUpdateNode(selectedNode.id, { ...selectedNode.data, status: parseInt(e.target.value) })}
                className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500 outline-none"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Message</label>
              <input
                type="text"
                value={selectedNode.data?.message || ''}
                onChange={(e) => onUpdateNode(selectedNode.id, { ...selectedNode.data, message: e.target.value })}
                className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500 outline-none"
                placeholder="Error message"
              />
            </div>
          </>
        )}

        {selectedNode.type === 'api-output' && (
          <div className="space-y-3">
            {/* Response Type */}
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Response Type</label>
              <select
                value={selectedNode.data?.responseType || 'object'}
                onChange={(e) => onUpdateNode(selectedNode.id, { 
                  ...selectedNode.data,
                  responseType: e.target.value as any 
                })}
                className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500 outline-none"
              >
                <option value="object">Object {'{}'}</option>
                <option value="array">Array []</option>
                <option value="string">String</option>
                <option value="number">Number</option>
                <option value="boolean">Boolean</option>
              </select>
            </div>

            {/* API Spec Schema Transform */}
            <div className="flex items-center gap-2 p-2 bg-green-50 rounded border border-green-100">
              <input
                type="checkbox"
                id="useApiSpecSchema"
                checked={selectedNode.data?.useApiSpecSchema !== false}
                onChange={(e) => onUpdateNode(selectedNode.id, { 
                  ...selectedNode.data, 
                  useApiSpecSchema: e.target.checked,
                  autoTransform: !e.target.checked
                })}
                className="w-4 h-4 text-green-600 rounded focus:ring-green-500"
              />
              <label htmlFor="useApiSpecSchema" className="text-xs font-medium text-green-900 cursor-pointer flex-1">
                Use API Spec Schema
              </label>
            </div>

            {/* Auto Transform (when not using API Spec) */}
            {selectedNode.data?.useApiSpecSchema === false && (
              <div className="flex items-center gap-2 p-2 bg-blue-50 rounded border border-blue-100">
                <input
                  type="checkbox"
                  id="autoTransform"
                  checked={selectedNode.data?.autoTransform || false}
                  onChange={(e) => onUpdateNode(selectedNode.id, { 
                    ...selectedNode.data, 
                    autoTransform: e.target.checked 
                  })}
                  className="w-4 h-4 text-blue-600 rounded focus:ring-blue-500"
                />
                <label htmlFor="autoTransform" className="text-xs font-medium text-blue-900 cursor-pointer flex-1">
                  Auto Transform from Database
                </label>
              </div>
            )}

            {/* Field Mappings */}
            {selectedNode.data?.autoTransform && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium text-gray-700">Field Mappings</label>
                  <button
                    onClick={() => {
                      const mappings = selectedNode.data?.fieldMappings || [];
                      onUpdateNode(selectedNode.id, {
                        ...selectedNode.data,
                        fieldMappings: [...mappings, { source: '', target: '', transform: '' }]
                      });
                    }}
                    className="text-xs text-blue-600 hover:text-blue-700"
                  >
                    <i className="fas fa-plus mr-1"></i>Add
                  </button>
                </div>
                
                {(selectedNode.data?.fieldMappings || []).map((mapping: any, index: number) => (
                  <div key={index} className="flex gap-2 items-start p-2 bg-gray-50 rounded">
                    <div className="flex-1 space-y-1">
                      <input
                        type="text"
                        placeholder="Source (e.g., rows)"
                        value={mapping.source}
                        onChange={(e) => {
                          const mappings = [...(selectedNode.data?.fieldMappings || [])];
                          mappings[index] = { ...mapping, source: e.target.value };
                          onUpdateNode(selectedNode.id, { ...selectedNode.data, fieldMappings: mappings });
                        }}
                        className="w-full px-2 py-1 text-xs border rounded font-mono"
                      />
                      <div className="flex gap-1">
                        <input
                          type="text"
                          placeholder="Target"
                          value={mapping.target}
                          onChange={(e) => {
                            const mappings = [...(selectedNode.data?.fieldMappings || [])];
                            mappings[index] = { ...mapping, target: e.target.value };
                            onUpdateNode(selectedNode.id, { ...selectedNode.data, fieldMappings: mappings });
                          }}
                          className="flex-1 px-2 py-1 text-xs border rounded"
                        />
                        <select
                          value={mapping.transform || ''}
                          onChange={(e) => {
                            const mappings = [...(selectedNode.data?.fieldMappings || [])];
                            mappings[index] = { ...mapping, transform: e.target.value };
                            onUpdateNode(selectedNode.id, { ...selectedNode.data, fieldMappings: mappings });
                          }}
                          className="px-1 py-1 text-xs border rounded w-20"
                        >
                          <option value="">-</option>
                          <option value="string">str</option>
                          <option value="number">num</option>
                          <option value="boolean">bool</option>
                          <option value="array">arr</option>
                        </select>
                      </div>
                    </div>
                    <button
                      onClick={() => {
                        const mappings = (selectedNode.data?.fieldMappings || []).filter((_: any, i: number) => i !== index);
                        onUpdateNode(selectedNode.id, { ...selectedNode.data, fieldMappings: mappings });
                      }}
                      className="text-red-500 hover:text-red-700 p-1"
                    >
                      <i className="fas fa-trash text-xs"></i>
                    </button>
                  </div>
                ))}

                {/* Presets */}
                {(selectedNode.data?.fieldMappings || []).length === 0 && (
                  <div className="flex flex-wrap gap-1">
                    <button
                      onClick={() => onUpdateNode(selectedNode.id, { 
                        ...selectedNode.data,
                        fieldMappings: [{ source: 'rows', target: 'data', transform: '' }],
                        wrapInDataKey: true,
                        responseType: 'array'
                      })}
                      className="inline-flex items-center justify-center text-[13px] px-2 h-8 bg-gray-100 hover:bg-gray-200 rounded whitespace-nowrap"
                    >
                      Preset: All Rows
                    </button>
                    <button
                      onClick={() => onUpdateNode(selectedNode.id, { 
                        ...selectedNode.data,
                        fieldMappings: [{ source: 'rows[0]', target: 'data', transform: '' }],
                        wrapInDataKey: true,
                        responseType: 'object'
                      })}
                      className="inline-flex items-center justify-center text-[13px] px-2 h-8 bg-gray-100 hover:bg-gray-200 rounded whitespace-nowrap"
                    >
                      Preset: First Row
                    </button>
                    <button
                      onClick={() => onUpdateNode(selectedNode.id, { 
                        ...selectedNode.data,
                        fieldMappings: [
                          { source: 'rows', target: 'agencies', transform: 'array' },
                          { source: 'rowCount', target: 'total', transform: 'number' }
                        ],
                        wrapInDataKey: false,
                        responseType: 'object'
                      })}
                      className="inline-flex items-center justify-center text-[13px] px-2 h-8 bg-blue-50 text-blue-700 hover:bg-blue-100 rounded whitespace-nowrap"
                    >
                      Preset: Agency API
                    </button>
                  </div>
                )}
              </div>
            )}



            {/* Options */}
            <div className="flex flex-wrap gap-3 pt-2 border-t text-xs">
              <label className="flex items-center gap-1 text-gray-600 cursor-pointer">
                <input
                  type="checkbox"
                  checked={selectedNode.data?.wrapInDataKey || false}
                  onChange={(e) => onUpdateNode(selectedNode.id, { 
                    ...selectedNode.data, 
                    wrapInDataKey: e.target.checked 
                  })}
                  className="rounded text-blue-600"
                />
                Wrap in {'{'}data:{'}'}
              </label>
              <label className="flex items-center gap-1 text-gray-600 cursor-pointer">
                <input
                  type="checkbox"
                  checked={selectedNode.data?.includeMetadata || false}
                  onChange={(e) => onUpdateNode(selectedNode.id, { 
                    ...selectedNode.data, 
                    includeMetadata: e.target.checked 
                  })}
                  className="rounded text-blue-600"
                />
                Add _meta
              </label>
            </div>

            {/* Status Code */}
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Status Code</label>
              <select
                value={selectedNode.data?.statusCode || 200}
                onChange={(e) => onUpdateNode(selectedNode.id, { 
                  ...selectedNode.data, 
                  statusCode: parseInt(e.target.value) 
                })}
                className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500 outline-none"
              >
                <option value={200}>200 OK</option>
                <option value={201}>201 Created</option>
                <option value={204}>204 No Content</option>
                <option value={400}>400 Bad Request</option>
                <option value={404}>404 Not Found</option>
                <option value={500}>500 Server Error</option>
              </select>
            </div>

            {/* Legacy */}
            <details className="text-xs">
              <summary className="cursor-pointer text-gray-500">Legacy JS Mapping</summary>
              <textarea
                value={selectedNode.data?.mapping || ''}
                onChange={(e) => onUpdateNode(selectedNode.id, { 
                  ...selectedNode.data, 
                  mapping: e.target.value 
                })}
                className="w-full mt-2 px-2 py-1.5 text-xs border rounded font-mono"
                rows={3}
                placeholder="{ data: input.rows }"
              />
            </details>
          </div>
        )}

        {/* Position Display */}
        <div className="pt-4 border-t border-gray-200">
          <p className="text-xs text-gray-500">Position</p>
          <p className="text-xs font-mono">X: {Math.round(selectedNode.x)}, Y: {Math.round(selectedNode.y)}</p>
        </div>

        {/* Node ID */}
        <div>
          <p className="text-xs text-gray-500">Node ID</p>
          <p className="text-xs font-mono truncate">{selectedNode.id}</p>
        </div>
      </div>
    </div>
  );
};

export const FlowCanvas = ({ 
  operationId, 
  initialNodes, 
  initialEdges, 
  onChange,
  nodeTypes 
}: FlowCanvasProps) => {
  const canvasRef = useRef<HTMLDivElement>(null);
  const [nodes, setNodes] = useState<FlowNode[]>(initialNodes);
  const [edges, setEdges] = useState<FlowEdge[]>(initialEdges);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [draggingNode, setDraggingNode] = useState<string | null>(null);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [connectingFrom, setConnectingFrom] = useState<{ nodeId: string; portId: string } | null>(null);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });

  // Update parent when nodes/edges change
  useEffect(() => {
    onChange(nodes, edges);
  }, [nodes, edges]);

  // Reset when operation changes
  useEffect(() => {
    setNodes(initialNodes);
    setEdges(initialEdges);
    setSelectedNode(null);
  }, [operationId, initialNodes, initialEdges]);

  // Get node definition
  const getNodeDef = (type: string) => nodeTypes.find(n => n.type === type);

  // Get selected node object
  const selectedNodeObj = useMemo(() => {
    return nodes.find(n => n.id === selectedNode) || null;
  }, [nodes, selectedNode]);

  // Convert screen to canvas coordinates
  const screenToCanvas = useCallback((screenX: number, screenY: number) => {
    if (!canvasRef.current) return { x: 0, y: 0 };
    const rect = canvasRef.current.getBoundingClientRect();
    return {
      x: (screenX - rect.left - pan.x) / scale,
      y: (screenY - rect.top - pan.y) / scale,
    };
  }, [pan, scale]);

  // Add node from palette drop
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const nodeType = e.dataTransfer.getData('nodeType');
    if (!nodeType || !canvasRef.current) return;

    const pos = screenToCanvas(e.clientX, e.clientY);
    const newNode: FlowNode = {
      id: createId(),
      type: nodeType,
      x: pos.x - 70, // Center node
      y: pos.y - 22,
      data: { label: getNodeDef(nodeType)?.label || nodeType }
    };

    setNodes(prev => [...prev, newNode]);
  }, [screenToCanvas, nodeTypes]);

  // Drag over
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  // Mouse down on node
  const handleNodeMouseDown = (e: React.MouseEvent, nodeId: string) => {
    e.stopPropagation();
    setSelectedNode(nodeId);
    setDraggingNode(nodeId);
    
    const pos = screenToCanvas(e.clientX, e.clientY);
    const node = nodes.find(n => n.id === nodeId);
    if (node) {
      setDragOffset({
        x: pos.x - node.x,
        y: pos.y - node.y,
      });
    }
  };

  // Canvas mouse down (for panning)
  const handleCanvasMouseDown = (e: React.MouseEvent) => {
    if (e.target === canvasRef.current || (e.target as HTMLElement).dataset?.canvas) {
      setIsPanning(true);
      setSelectedNode(null);
    }
  };

  // Mouse move
  const handleMouseMove = (e: React.MouseEvent) => {
    const pos = screenToCanvas(e.clientX, e.clientY);
    setMousePos(pos);

    if (draggingNode) {
      setNodes(prev => prev.map(n => 
        n.id === draggingNode 
          ? { ...n, x: pos.x - dragOffset.x, y: pos.y - dragOffset.y }
          : n
      ));
    }

    if (isPanning) {
      setPan(prev => ({
        x: prev.x + e.movementX,
        y: prev.y + e.movementY,
      }));
    }
  };

  // Mouse up
  const handleMouseUp = () => {
    setDraggingNode(null);
    setIsPanning(false);
    setConnectingFrom(null);
  };

  // Delete node
  const deleteNode = (nodeId: string) => {
    setNodes(prev => prev.filter(n => n.id !== nodeId));
    setEdges(prev => prev.filter(e => e.source !== nodeId && e.target !== nodeId));
    if (selectedNode === nodeId) setSelectedNode(null);
  };

  // Update node data
  const updateNodeData = (nodeId: string, data: any) => {
    setNodes(prev => prev.map(n => 
      n.id === nodeId ? { ...n, data } : n
    ));
  };

  // Zoom
  const handleWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      setScale(prev => Math.max(0.5, Math.min(2, prev * delta)));
    }
  };

  // Add node from double click
  const handleDoubleClick = (e: React.MouseEvent) => {
    const pos = screenToCanvas(e.clientX, e.clientY);
    const newNode: FlowNode = {
      id: createId(),
      type: 'transform',
      x: pos.x - 70,
      y: pos.y - 22,
      data: { label: 'Transform' }
    };
    setNodes(prev => [...prev, newNode]);
  };

  // Start connection from port
  const handlePortMouseDown = (e: React.MouseEvent, nodeId: string, portId: string, portType: string) => {
    e.stopPropagation();
    if (portType === 'output') {
      setConnectingFrom({ nodeId, portId });
    }
  };

  // Complete connection to port
  const handlePortMouseUp = (e: React.MouseEvent, nodeId: string, portId: string, portType: string) => {
    e.stopPropagation();
    if (connectingFrom && portType === 'input' && connectingFrom.nodeId !== nodeId) {
      // Check if connection already exists
      const exists = edges.some(e => 
        e.source === connectingFrom.nodeId && e.target === nodeId
      );
      if (!exists) {
        const newEdge: FlowEdge = {
          id: createId(),
          source: connectingFrom.nodeId,
          target: nodeId,
          sourcePort: connectingFrom.portId,
          targetPort: portId,
        };
        setEdges(prev => [...prev, newEdge]);
      }
    }
    setConnectingFrom(null);
  };

  // Get connection line start position
  const getConnectionStartPos = () => {
    if (!connectingFrom) return null;
    const node = nodes.find(n => n.id === connectingFrom.nodeId);
    if (!node) return null;
    return {
      x: node.x + 140,
      y: node.y + 22,
    };
  };

  const connStart = getConnectionStartPos();

  // Calculate canvas bounds based on nodes with 15% padding
  const canvasBounds = useMemo(() => {
    if (nodes.length === 0) {
      return { minX: -1000, minY: -1000, maxX: 4000, maxY: 4000 };
    }
    const xs = nodes.map(n => n.x);
    const ys = nodes.map(n => n.y);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const maxX = Math.max(...xs) + 140; // Add node width
    const maxY = Math.max(...ys) + 44;  // Add node height
    const width = maxX - minX;
    const height = maxY - minY;
    const paddingX = width * 0.15; // 15% padding
    const paddingY = height * 0.15;
    
    return {
      minX: Math.min(-1000, minX - paddingX),
      minY: Math.min(-1000, minY - paddingY),
      maxX: Math.max(4000, maxX + paddingX),
      maxY: Math.max(4000, maxY + paddingY),
    };
  }, [nodes]);

  return (
    <div className="h-full flex">
      {/* Canvas Area */}
      <div className="flex-1 relative overflow-hidden">
        <div
          ref={canvasRef}
          className="w-full h-full relative cursor-grab active:cursor-grabbing"
          style={{
            backgroundColor: '#f9fafb',
          }}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onMouseDown={handleCanvasMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onWheel={handleWheel}
          onDoubleClick={handleDoubleClick}
          data-canvas="true"
        >
          {/* Infinite Grid Background - CSS pattern that extends infinitely */}
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              backgroundImage: `
                linear-gradient(to right, var(--canvas-grid) 1px, transparent 1px),
                linear-gradient(to bottom, var(--canvas-grid) 1px, transparent 1px)
              `,
              backgroundSize: `${20 * scale}px ${20 * scale}px`,
              backgroundPosition: `${pan.x}px ${pan.y}px`,
              width: '100%',
              height: '100%',
              zIndex: 0,
            }}
          />
          
          {/* Transform Container */}
          <div
            className="absolute top-0 left-0"
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
              transformOrigin: '0 0',
              width: canvasBounds.maxX,
              height: canvasBounds.maxY,
              zIndex: 1,
            }}
          >
            {/* Edges Layer - Fixed positioning */}
            <svg 
              className="absolute top-0 left-0 overflow-visible pointer-events-none" 
              style={{ 
                zIndex: 1, 
                width: canvasBounds.maxX,
                height: canvasBounds.maxY,
              }}
            >
              <defs>
                <marker 
                  id={`arrow-${operationId}`} 
                  viewBox="0 0 10 10" 
                  markerWidth="8" 
                  markerHeight="8" 
                  refX="8" 
                  refY="5" 
                  orient="auto"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="#64748b" />
                </marker>
              </defs>
              {edges.map(edge => {
                const sourceNode = nodes.find(n => n.id === edge.source);
                const targetNode = nodes.find(n => n.id === edge.target);
                if (!sourceNode || !targetNode) return null;

                // Calculate connection points (right of source to left of target)
                const startX = sourceNode.x + 140;
                const startY = sourceNode.y + 22;
                const endX = targetNode.x;
                const endY = targetNode.y + 22;
                
                // Bezier curve control points
                const deltaX = Math.abs(endX - startX);
                const controlOffset = Math.max(deltaX * 0.5, 50);

                const path = `M ${startX} ${startY} C ${startX + controlOffset} ${startY}, ${endX - controlOffset} ${endY}, ${endX} ${endY}`;

                return (
                  <g key={edge.id}>
                    {/* Connection line */}
                    <path
                      d={path}
                      stroke="#64748b"
                      strokeWidth={2}
                      fill="none"
                      markerEnd={`url(#arrow-${operationId})`}
                    />
                  </g>
                );
              })}
            </svg>

            {/* Temporary Connection Line */}
            {connStart && (
              <svg className="absolute inset-0 overflow-visible pointer-events-none" style={{ zIndex: 2 }}>
                <path
                  d={`M ${connStart.x} ${connStart.y} L ${mousePos.x} ${mousePos.y}`}
                  stroke="#3b82f6"
                  strokeWidth={2}
                  strokeDasharray="5,5"
                  fill="none"
                />
              </svg>
            )}

            {/* Nodes Layer */}
            {nodes.map(node => (
              <NodeCard
                key={node.id}
                node={node}
                definition={getNodeDef(node.type)}
                isSelected={selectedNode === node.id}
                onMouseDown={(e) => handleNodeMouseDown(e, node.id)}
                onClick={() => setSelectedNode(node.id)}
                onPortMouseDown={(e, portId) => handlePortMouseDown(e, node.id, portId, 'output')}
                onPortMouseUp={(e, portId) => handlePortMouseUp(e, node.id, portId, 'input')}
                onDelete={() => deleteNode(node.id)}

              />
            ))}
          </div>

          {/* Canvas Controls */}
          <div className="absolute bottom-4 right-4 flex flex-col gap-2">
            <div className="bg-white rounded-lg shadow-lg border border-gray-200 p-1">
              <button onClick={() => setScale(p => Math.min(2, p * 1.2))} className="w-8 h-8 flex items-center justify-center hover:bg-gray-100 rounded" title="Zoom In">
                <i className="fas fa-plus text-gray-600 text-xs"></i>
              </button>
              <div className="w-8 h-8 flex items-center justify-center text-xs font-medium text-gray-600">
                {Math.round(scale * 100)}%
              </div>
              <button onClick={() => setScale(p => Math.max(0.5, p * 0.8))} className="w-8 h-8 flex items-center justify-center hover:bg-gray-100 rounded" title="Zoom Out">
                <i className="fas fa-minus text-gray-600 text-xs"></i>
              </button>
            </div>
            <button onClick={() => { setPan({ x: 0, y: 0 }); setScale(1); }} className="w-10 h-10 bg-white rounded-lg shadow-lg border border-gray-200 flex items-center justify-center hover:bg-gray-100" title="Reset View">
              <i className="fas fa-compress text-gray-600 text-xs"></i>
            </button>
          </div>

          {/* Help */}
          <div className="absolute top-4 left-4 bg-white/90 backdrop-blur rounded-lg shadow border border-gray-200 px-3 py-2 text-xs text-gray-500">
            <div className="flex items-center gap-3">
              <span><i className="fas fa-mouse mr-1"></i>Drag to pan</span>
              <span><i className="fas fa-search mr-1"></i>Ctrl+Scroll zoom</span>
              <span><i className="fas fa-hand-pointer mr-1"></i>Double-click add</span>
            </div>
          </div>
        </div>
      </div>

      {/* Properties Panel */}
      <PropertiesPanel
        selectedNode={selectedNodeObj}
        nodeDefinition={selectedNodeObj ? getNodeDef(selectedNodeObj.type) : undefined}
        onUpdateNode={updateNodeData}
        onClose={() => setSelectedNode(null)}
      />
    </div>
  );
};

export default FlowCanvas;
