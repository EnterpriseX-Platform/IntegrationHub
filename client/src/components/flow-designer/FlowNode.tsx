import { useState } from 'react';
import { 
  Database, Server, Folder, Settings, Play, 
  FileInput, FileOutput, RefreshCw, Clock
} from 'lucide-react';

const nodeTypes: Record<string, { icon: any; color: string; label: string }> = {
  'basket': { icon: Folder, color: 'bg-amber-500', label: 'Basket' },
  'sftp': { icon: Server, color: 'bg-green-500', label: 'SFTP' },
  'database': { icon: Database, color: 'bg-purple-500', label: 'Database' },
  'http': { icon: Server, color: 'bg-blue-500', label: 'HTTP API' },
  'trigger': { icon: Clock, color: 'bg-red-500', label: 'Schedule' },
  'webhook': { icon: Play, color: 'bg-orange-500', label: 'Webhook' },
  'transform': { icon: RefreshCw, color: 'bg-cyan-500', label: 'Transform' },
  'input': { icon: FileInput, color: 'bg-indigo-500', label: 'Input' },
  'output': { icon: FileOutput, color: 'bg-pink-500', label: 'Output' },
  'config': { icon: Settings, color: 'bg-gray-500', label: 'Config' }
};

export interface FlowNodeData {
  id: string;
  type: string;
  x: number;
  y: number;
  label: string;
  config?: Record<string, any>;
}

interface FlowNodeProps {
  node: FlowNodeData;
  selected?: boolean;
  isDragging?: boolean;
  onMouseDown: (e: React.MouseEvent) => void;
  onConnectionStart: (nodeId: string, handleId: string, e: React.MouseEvent) => void;
  onConnectionEnd: (nodeId: string, handleId: string) => void;
  readOnly?: boolean;
}

export const FlowNode = ({
  node,
  selected = false,
  isDragging = false,
  onMouseDown,
  onConnectionStart,
  onConnectionEnd,
  readOnly = false
}: FlowNodeProps) => {
  const [isConnecting, setIsConnecting] = useState(false);
  const nodeType = nodeTypes[node.type] || nodeTypes['config'];
  const Icon = nodeType.icon;

  // Handle positions: top, right, bottom, left
  const handles = [
    { id: 'top', position: 'top-0 left-1/2 -translate-x-1/2 -translate-y-1/2' },
    { id: 'right', position: 'right-0 top-1/2 translate-x-1/2 -translate-y-1/2' },
    { id: 'bottom', position: 'bottom-0 left-1/2 -translate-x-1/2 translate-y-1/2' },
    { id: 'left', position: 'left-0 top-1/2 -translate-x-1/2 -translate-y-1/2' }
  ];

  const handleHandleMouseDown = (handleId: string, e: React.MouseEvent) => {
    if (readOnly) return;
    e.stopPropagation();
    e.preventDefault(); // Prevent text selection
    setIsConnecting(true);
    onConnectionStart(node.id, handleId, e);
    
    const handleMouseUp = () => {
      setIsConnecting(false);
      document.removeEventListener('mouseup', handleMouseUp);
    };
    document.addEventListener('mouseup', handleMouseUp);
  };

  const handleHandleMouseUp = (handleId: string, e: React.MouseEvent) => {
    if (readOnly) return;
    e.stopPropagation();
    onConnectionEnd(node.id, handleId);
  };

  return (
    <div
      data-node-id={node.id}
      className={`absolute select-none ${selected ? 'z-10' : 'z-0'} ${isDragging ? 'cursor-grabbing' : 'cursor-grab'}`}
      style={{ 
        left: node.x, 
        top: node.y,
        transform: isDragging ? 'scale(1.02)' : 'scale(1)',
        transition: isDragging ? 'none' : 'transform 0.15s ease-out'
      }}
      onMouseDown={onMouseDown}
    >
      {/* Handles */}
      {handles.map(handle => (
        <div
          key={handle.id}
          data-handle
          data-handle-id={handle.id}
          className={`absolute w-3 h-3 rounded-full border-2 border-white shadow-sm transition-all hover:scale-125 z-20 ${
            isConnecting ? 'bg-blue-400 cursor-crosshair' : 'bg-gray-400 hover:bg-blue-400 cursor-crosshair'
          } ${handle.position}`}
          onMouseDown={(e) => handleHandleMouseDown(handle.id, e)}
          onMouseUp={(e) => handleHandleMouseUp(handle.id, e)}
        />
      ))}

      {/* Node Card */}
      <div
        className={`w-48 bg-white rounded-lg shadow-lg border-2 transition-all duration-150 ${
          selected 
            ? 'border-blue-500 shadow-lg shadow-blue-300 ring-2 ring-blue-200 ring-offset-2' 
            : 'border-gray-200 hover:border-gray-400 hover:shadow-md'
        } ${isDragging ? 'opacity-90' : 'opacity-100'}`}
      >
        {/* Header */}
        <div className={`${nodeType.color} text-white px-3 py-2 rounded-t-lg flex items-center gap-2`}>
          <Icon className="h-4 w-4" />
          <span className="text-sm font-medium truncate">{node.label || nodeType.label}</span>
        </div>

        {/* Config Preview */}
        <div className="p-3 space-y-2">
          {node.config && Object.keys(node.config).length > 0 ? (
            <div className="text-xs text-gray-600 space-y-1">
              {Object.entries(node.config).slice(0, 3).map(([key, value]) => (
                <div key={key} className="flex justify-between">
                  <span className="text-gray-400">{key}:</span>
                  <span className="truncate max-w-[100px]">
                    {typeof value === 'string' ? value : JSON.stringify(value).slice(0, 20)}
                  </span>
                </div>
              ))}
              {Object.keys(node.config).length > 3 && (
                <div className="text-gray-400">+{Object.keys(node.config).length - 3} more...</div>
              )}
            </div>
          ) : (
            <div className="text-xs text-gray-400 italic">No configuration</div>
          )}
        </div>
      </div>
    </div>
  );
};

export default FlowNode;
