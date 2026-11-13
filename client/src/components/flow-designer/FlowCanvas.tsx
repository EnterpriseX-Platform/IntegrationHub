import { useState, useRef, useCallback, useEffect } from 'react';
import { ConnectionLine } from './ConnectionLine';
import { FlowNode } from './FlowNode';

export interface NodeData {
  id: string;
  type: string;
  x: number;
  y: number;
  label: string;
  config?: Record<string, any>;
}

export interface ConnectionData {
  id: string;
  fromNodeId: string;
  fromHandle: string;
  toNodeId: string;
  toHandle: string;
}

interface FlowCanvasProps {
  nodes: NodeData[];
  connections: ConnectionData[];
  onNodesChange: (nodes: NodeData[]) => void;
  onConnectionsChange: (connections: ConnectionData[]) => void;
  onNodeSelect?: (nodeId: string | null) => void;
  selectedNodeId?: string | null;
  readOnly?: boolean;
}

export const FlowCanvas = ({
  nodes,
  connections,
  onNodesChange,
  onConnectionsChange,
  onNodeSelect,
  selectedNodeId,
  readOnly = false
}: FlowCanvasProps) => {
  const canvasRef = useRef<HTMLDivElement>(null);
  const [dragState, setDragState] = useState<{
    nodeId: string | null;
    startX: number;
    startY: number;
    offsetX: number;
    offsetY: number;
    isDragging: boolean;
  }>({ nodeId: null, startX: 0, startY: 0, offsetX: 0, offsetY: 0, isDragging: false });
  const [connecting, setConnecting] = useState<{
    fromNodeId: string;
    fromHandle: string;
    fromX: number;
    fromY: number;
  } | null>(null);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
  const [selectedConnection, setSelectedConnection] = useState<string | null>(null);
  const [scale, setScale] = useState(1);

  // Get handle position (center of handle element)
  const getHandlePosition = useCallback((nodeId: string, handleId: string) => {
    const handleEl = document.querySelector(`[data-node-id="${nodeId}"] [data-handle-id="${handleId}"]`);
    if (!handleEl || !canvasRef.current) return { x: 0, y: 0 };
    
    const handleRect = handleEl.getBoundingClientRect();
    const canvasRect = canvasRef.current.getBoundingClientRect();
    
    return {
      x: (handleRect.left + handleRect.width / 2 - canvasRect.left) / scale,
      y: (handleRect.top + handleRect.height / 2 - canvasRect.top) / scale
    };
  }, [scale]);

  // Handle node mouse down (start potential drag)
  const handleNodeMouseDown = useCallback((e: React.MouseEvent, nodeId: string) => {
    if (readOnly) return;
    if ((e.target as HTMLElement).closest('[data-handle]')) return; // Don't drag if clicking handle
    
    e.stopPropagation();
    const node = nodes.find(n => n.id === nodeId);
    if (!node || !canvasRef.current) return;

    const canvasRect = canvasRef.current.getBoundingClientRect();
    const mouseX = (e.clientX - canvasRect.left) / scale;
    const mouseY = (e.clientY - canvasRect.top) / scale;

    setDragState({
      nodeId,
      startX: mouseX,
      startY: mouseY,
      offsetX: mouseX - node.x,
      offsetY: mouseY - node.y,
      isDragging: false
    });

    // Select node immediately on mouse down
    onNodeSelect?.(nodeId);
  }, [nodes, scale, readOnly, onNodeSelect]);

  // Handle mouse move
  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!canvasRef.current) return;
    const canvasRect = canvasRef.current.getBoundingClientRect();
    const x = (e.clientX - canvasRect.left) / scale;
    const y = (e.clientY - canvasRect.top) / scale;
    setMousePos({ x, y });

    if (dragState.nodeId) {
      // Check if we've moved enough to be considered a drag
      const dx = Math.abs(x - dragState.startX);
      const dy = Math.abs(y - dragState.startY);
      const hasMoved = dx > 3 || dy > 3; // Threshold of 3 pixels

      if (hasMoved && !dragState.isDragging) {
        setDragState(prev => ({ ...prev, isDragging: true }));
      }

      if (dragState.isDragging || hasMoved) {
        const newX = x - dragState.offsetX;
        const newY = y - dragState.offsetY;
        
        onNodesChange(nodes.map(n => 
          n.id === dragState.nodeId ? { ...n, x: newX, y: newY } : n
        ));
      }
    }
  }, [dragState, nodes, onNodesChange, scale]);

  // Handle mouse up
  const handleMouseUp = useCallback(() => {
    setDragState({ nodeId: null, startX: 0, startY: 0, offsetX: 0, offsetY: 0, isDragging: false });
    setConnecting(null);
  }, []);

  // Handle connection start
  const handleConnectionStart = useCallback((nodeId: string, handleId: string, e: React.MouseEvent) => {
    if (readOnly) return;
    e.stopPropagation();
    
    const pos = getHandlePosition(nodeId, handleId);
    setConnecting({
      fromNodeId: nodeId,
      fromHandle: handleId,
      fromX: pos.x,
      fromY: pos.y
    });
  }, [getHandlePosition, readOnly]);

  // Handle connection end
  const handleConnectionEnd = useCallback((nodeId: string, handleId: string) => {
    if (readOnly || !connecting) return;
    
    // Don't connect to self
    if (connecting.fromNodeId === nodeId) {
      setConnecting(null);
      return;
    }
    
    // Check if connection already exists
    const exists = connections.some(c => 
      c.fromNodeId === connecting.fromNodeId && 
      c.fromHandle === connecting.fromHandle &&
      c.toNodeId === nodeId && 
      c.toHandle === handleId
    );
    
    if (!exists) {
      const newConnection: ConnectionData = {
        id: `conn-${Date.now()}`,
        fromNodeId: connecting.fromNodeId,
        fromHandle: connecting.fromHandle,
        toNodeId: nodeId,
        toHandle: handleId
      };
      onConnectionsChange([...connections, newConnection]);
    }
    
    setConnecting(null);
  }, [connecting, connections, onConnectionsChange, readOnly]);

  // Handle key press (delete selected)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Delete') {
        if (selectedNodeId) {
          onNodesChange(nodes.filter(n => n.id !== selectedNodeId));
          onConnectionsChange(connections.filter(c => 
            c.fromNodeId !== selectedNodeId && c.toNodeId !== selectedNodeId
          ));
          onNodeSelect?.(null);
        }
        if (selectedConnection) {
          onConnectionsChange(connections.filter(c => c.id !== selectedConnection));
          setSelectedConnection(null);
        }
      }
    };
    
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedNodeId, selectedConnection, nodes, connections, onNodesChange, onConnectionsChange, onNodeSelect]);

  // Zoom controls
  const zoomIn = () => setScale(s => Math.min(s * 1.1, 2));
  const zoomOut = () => setScale(s => Math.max(s / 1.1, 0.5));
  const zoomReset = () => setScale(1);

  // Click on canvas to deselect
  const handleCanvasClick = (e: React.MouseEvent) => {
    if (e.target === canvasRef.current || (e.target as HTMLElement).classList.contains('canvas-background')) {
      onNodeSelect?.(null);
      setSelectedConnection(null);
    }
  };

  return (
    <div 
      ref={canvasRef}
      className="relative w-full h-full bg-gray-50 overflow-hidden"
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onClick={handleCanvasClick}
    >
      {/* Grid Background */}
      <div 
        className="absolute inset-0 canvas-background"
        style={{
          backgroundImage: 'radial-gradient(circle, #cbd5e1 1px, transparent 1px)',
          backgroundSize: '20px 20px'
        }}
      />

      {/* SVG Layer for connections */}
      <svg className="absolute inset-0 w-full h-full pointer-events-none" style={{ zIndex: 1 }}>
        <defs>
          <marker id="arrowhead" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
            <polygon points="0 0, 10 3.5, 0 7" fill="#3b82f6" />
          </marker>
        </defs>
        
        {/* Existing connections */}
        {connections.map(conn => {
          const fromPos = getHandlePosition(conn.fromNodeId, conn.fromHandle);
          const toPos = getHandlePosition(conn.toNodeId, conn.toHandle);
          return (
            <g key={conn.id} style={{ pointerEvents: 'all' }}>
              <ConnectionLine
                from={fromPos}
                to={toPos}
                selected={selectedConnection === conn.id}
                onClick={() => setSelectedConnection(conn.id)}
              />
            </g>
          );
        })}
        
        {/* Temporary connection while dragging */}
        {connecting && (
          <ConnectionLine
            from={{ x: connecting.fromX, y: connecting.fromY }}
            to={mousePos}
            animated={false}
            selected={false}
          />
        )}
      </svg>

      {/* Nodes Layer */}
      <div 
        className="absolute inset-0" 
        style={{ 
          zIndex: 2, 
          transform: `scale(${scale})`, 
          transformOrigin: '0 0',
          width: `${100 / scale}%`,
          height: `${100 / scale}%`
        }}
      >
        {nodes.map(node => (
          <FlowNode
            key={node.id}
            node={node}
            selected={selectedNodeId === node.id}
            isDragging={dragState.nodeId === node.id && dragState.isDragging}
            onMouseDown={(e) => handleNodeMouseDown(e, node.id)}
            onConnectionStart={handleConnectionStart}
            onConnectionEnd={handleConnectionEnd}
            readOnly={readOnly}
          />
        ))}
      </div>

      {/* Zoom Controls */}
      <div className="absolute bottom-4 right-4 flex items-center gap-1 bg-white border border-gray-200 rounded-lg p-1 shadow-lg" style={{ zIndex: 10 }}>
        <button onClick={zoomOut} className="p-2 hover:bg-gray-100 rounded" title="Zoom out">-</button>
        <span className="px-2 text-sm text-gray-600 min-w-[50px] text-center">{Math.round(scale * 100)}%</span>
        <button onClick={zoomIn} className="p-2 hover:bg-gray-100 rounded" title="Zoom in">+</button>
        <button onClick={zoomReset} className="p-2 hover:bg-gray-100 rounded" title="Reset zoom">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 4l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
          </svg>
        </button>
      </div>

      {/* Help text */}
      <div className="absolute bottom-4 left-4 bg-white/80 backdrop-blur px-3 py-2 rounded-lg text-xs text-gray-500" style={{ zIndex: 10 }}>
        <p>• Click node to select</p>
        <p>• Drag to move</p>
        <p>• Drag from handles to connect</p>
        <p>• Delete key to remove</p>
      </div>
    </div>
  );
};

export default FlowCanvas;
