import { useState, useRef, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { ChevronDown, ChevronRight, X, Maximize2, Save, Folder, Package, AlignLeft, Sparkles } from 'lucide-react';
import { createId } from '@paralleldrive/cuid2';
import CodeMirror from '@uiw/react-codemirror';
import { sql } from '@codemirror/lang-sql';
import { ViewPlugin, ViewUpdate, Decoration, DecorationSet } from '@codemirror/view';
import { EditorView } from '@codemirror/view';
import { Extension } from '@codemirror/state';

// Custom extension to highlight template variables like {{vars.name}}, {{path.id}}, etc.
const templateVariableDecoration = Decoration.mark({
  class: 'cm-template-variable',
  attributes: { style: 'background-color: #fef3c7; color: #d97706; border-radius: 3px; padding: 0 2px; font-weight: 600;' }
});

const templateVariablePlugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  
  constructor(view: EditorView) {
    this.decorations = this.findTemplateVariables(view);
  }
  
  update(update: ViewUpdate) {
    if (update.docChanged || update.viewportChanged) {
      this.decorations = this.findTemplateVariables(update.view);
    }
  }
  
  findTemplateVariables(view: EditorView): DecorationSet {
    const decorations: any[] = [];
    const regex = /\{\{[^}]+\}\}/g;
    
    for (let { from, to } of view.visibleRanges) {
      const text = view.state.doc.sliceString(from, to);
      let match;
      
      while ((match = regex.exec(text)) !== null) {
        const start = from + match.index;
        const end = start + match[0].length;
        decorations.push(templateVariableDecoration.range(start, end));
      }
    }
    
    return Decoration.set(decorations);
  }
}, {
  decorations: v => v.decorations
});

const templateVariableHighlight = (): Extension => [templateVariablePlugin];

import { API_URL } from '../../config/api';

// Node card size (Robot Factory style). Edge anchors are computed from these.
const NODE_WIDTH = 176;
const NODE_HEIGHT = 64;

// Generate a readable varName for a node based on its type
const varNamePrefixMap: Record<string, string> = {
  'database': 'db',
  'http-request': 'http',
  'condition': 'cond',
  'transform': 'transform',
  'basket-trigger': 'trigger',
  'api-input': 'input',
  'api-output': 'output',
  'file-read': 'fileread',
  'file-write': 'filewrite',
  'sftp-action': 'sftp',
  'basket-action': 'basketAction',
  'delay': 'delay',
  'ocr': 'ocr',
  'data-admin': 'catalog',
};

function generateVarName(type: string, existingNodes: FlowNode[]): string {
  const prefix = varNamePrefixMap[type] || 'node';
  const existingVarNames = existingNodes.map(n => n.data?.varName || '');
  let counter = 1;
  while (existingVarNames.includes(`${prefix}${counter}`)) {
    counter++;
  }
  return `${prefix}${counter}`;
}

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
  sourcePort?: 'top' | 'right' | 'bottom' | 'left';
  targetPort?: 'top' | 'right' | 'bottom' | 'left';
  label?: string;
}

interface FlowData {
  operationId?: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
}

interface NodeDefinition {
  type: string;
  label: string;
  icon: string;
  color: string;
  category: string;
  description: string;
}

interface Connection {
  id: string;
  name: string;
  type: string;
  status: string;
  config?: any;
}

interface FlowDesignerProps {
  flow: FlowData;
  onChange: (flow: FlowData) => void;
  nodeTypes: NodeDefinition[];
  connections: Connection[];
  flowType?: 'rest-api' | 'event';
}

const GRID_SIZE = 20;

// SQL Editor Modal Component with CodeMirror
interface SqlEditorModalProps {
  value: string;
  onChange: (value: string) => void;
  onClose: () => void;
  onSave: () => void;
  title?: string;
}

const SqlEditorModal = ({ value, onChange, onClose, onSave, title = 'SQL Editor' }: SqlEditorModalProps) => {
  // SQL formatter with proper newlines
  const formatSql = () => {
    // Step 1: Add newlines after major keywords (preserve original newlines temporarily)
    let formatted = value
      .replace(/\s*\b(SELECT)\b\s+/gi, 'SELECT ')
      .replace(/\s*,\s*/g, ', ')  // Normalize spaces after commas
      .replace(/\s*\b(FROM|WHERE|GROUP BY|ORDER BY|HAVING|LIMIT|OFFSET)\b\s*/gi, '\n$1 ')
      .replace(/\s*\b(LEFT JOIN|RIGHT JOIN|INNER JOIN|OUTER JOIN|JOIN)\b\s*/gi, '\n$1 ')
      .replace(/\s*\b(INSERT INTO|VALUES|UPDATE|SET|DELETE|CREATE TABLE|ALTER TABLE|DROP TABLE|UNION|UNION ALL|INTERSECT|EXCEPT)\b\s*/gi, '\n$1 ');

    // Step 2: Handle commas in SELECT - put each column on new line if there are many columns
    const lines = formatted.split('\n');
    const newLines: string[] = [];
    
    for (let line of lines) {
      line = line.trim();
      if (!line) continue;
      
      // If line starts with SELECT and has many commas, split columns
      if (line.toUpperCase().startsWith('SELECT ')) {
        const selectMatch = line.match(/^SELECT\s+(.+)$/i);
        if (selectMatch) {
          const columnsPart = selectMatch[1];
          // Count columns (by commas that are not inside parentheses)
          let commaCount = 0;
          let parenDepth = 0;
          for (const char of columnsPart) {
            if (char === '(') parenDepth++;
            else if (char === ')') parenDepth--;
            else if (char === ',' && parenDepth === 0) commaCount++;
          }
          
          // If more than 3 columns, split each to new line
          if (commaCount > 3) {
            newLines.push('SELECT');
            let currentColumn = '';
            parenDepth = 0;
            for (let i = 0; i < columnsPart.length; i++) {
              const char = columnsPart[i];
              if (char === '(') parenDepth++;
              else if (char === ')') parenDepth--;
              
              if (char === ',' && parenDepth === 0) {
                newLines.push('  ' + currentColumn.trim() + ',');
                currentColumn = '';
              } else {
                currentColumn += char;
              }
            }
            if (currentColumn.trim()) {
              newLines.push('  ' + currentColumn.trim());
            }
          } else {
            newLines.push(line);
          }
        } else {
          newLines.push(line);
        }
      } else {
        // Add indentation for clauses
        const indentKeywords = ['FROM', 'WHERE', 'JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'OUTER JOIN', 'ON', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET'];
        const upperLine = line.toUpperCase();
        const needsIndent = indentKeywords.some(kw => upperLine.startsWith(kw));
        
        if (needsIndent && !upperLine.startsWith('SELECT')) {
          newLines.push('  ' + line);
        } else {
          newLines.push(line);
        }
      }
    }

    // Step 3: Handle AND/OR - indent them
    const finalLines: string[] = [];
    for (const line of newLines) {
      const upperLine = line.toUpperCase().trim();
      if (upperLine.startsWith('AND ') || upperLine.startsWith('OR ')) {
        finalLines.push('    ' + line.trim());
      } else {
        finalLines.push(line);
      }
    }

    formatted = finalLines.join('\n');
    onChange(formatted);
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-2xl w-[1200px] max-w-[95vw] h-[85vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-200 bg-gray-50">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-blue-100 rounded-lg flex items-center justify-center">
              <i className="fas fa-database text-blue-600"></i>
            </div>
            <div>
              <h3 className="font-semibold text-gray-900">{title}</h3>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {/* Format Button */}
            <button
              onClick={formatSql}
              className="px-3 h-9 text-[14px] bg-white text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 flex items-center gap-2 transition-colors whitespace-nowrap"
              title="Format SQL"
            >
              <AlignLeft size={14} />
              Format
            </button>
            <button onClick={onClose} className="p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors">
              <X size={20} />
            </button>
          </div>
        </div>

        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-2 px-4 py-2 border-b border-gray-200 bg-gray-50/50">
          <span className="text-xs text-gray-500 font-medium">Insert Variable:</span>
          <code className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded cursor-pointer hover:bg-blue-200" onClick={() => onChange(value + '{{path.xxx}}')}>path.xxx</code>
          <code className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded cursor-pointer hover:bg-green-200" onClick={() => onChange(value + '{{query.xxx}}')}>query.xxx</code>
          <code className="text-xs bg-purple-100 text-purple-700 px-2 py-0.5 rounded cursor-pointer hover:bg-purple-200" onClick={() => onChange(value + '{{body.xxx}}')}>body.xxx</code>
          <code className="text-xs bg-orange-100 text-orange-700 px-2 py-0.5 rounded cursor-pointer hover:bg-orange-200" onClick={() => onChange(value + '{{vars.xxx}}')}>vars.xxx</code>
        </div>

        {/* CodeMirror Editor - Light Theme */}
        <div className="flex-1 overflow-auto">
          <CodeMirror
            value={value}
            height="100%"
            maxHeight="100%"
            extensions={[sql(), templateVariableHighlight()]}
            onChange={(newValue) => onChange(newValue)}
            basicSetup={{
              lineNumbers: true,
              highlightActiveLineGutter: true,
              highlightActiveLine: true,
              foldGutter: true,
              dropCursor: true,
              allowMultipleSelections: true,
              indentOnInput: true,
              bracketMatching: true,
              closeBrackets: true,
              autocompletion: true,
            }}
            placeholder={`-- SQL Query Example
SELECT 
  agency_code,
  agency_name,
  budget_amount
FROM agency_budget
WHERE year = {{vars.year}}
  AND status = 'ACTIVE'
ORDER BY agency_code;`}
            className="h-full"
            style={{
              fontSize: '14px',
            }}
          />
        </div>

        {/* Footer */}
        <div className="flex justify-between items-center p-4 border-t border-gray-200 bg-gray-50">
          <div className="flex items-center gap-4 text-xs text-gray-500">
            <span>{value.length.toLocaleString()} characters</span>
            <span>{value.split('\n').length} lines</span>
            <span className="flex items-center gap-1">
              <Sparkles size={12} className="text-yellow-500" />
              {title}
            </span>
          </div>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="inline-flex items-center justify-center px-3 h-9 text-[14px] text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors whitespace-nowrap"
            >
              Cancel
            </button>
            <button
              onClick={onSave}
              className="px-3 h-9 text-[14px] rounded-lg flex items-center gap-2 transition-colors whitespace-nowrap bg-blue-600 text-white hover:bg-blue-700"
            >
              <Save size={14} />
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

// Reusable Dropdown Component (mini version of Operation selector)
interface DropdownOption {
  value: string;
  label: string;
  icon?: string;
  iconComponent?: React.ReactNode;
  color?: string;
}

const MiniDropdown = ({ 
  options, 
  value, 
  onChange, 
  placeholder = 'Select...' 
}: { 
  options: DropdownOption[]; 
  value: string; 
  onChange: (value: string) => void;
  placeholder?: string;
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const selected = options.find(o => o.value === value);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between gap-2 px-2.5 py-1.5 bg-white border border-gray-200 rounded hover:border-blue-400 hover:shadow-sm transition-all text-left"
      >
        <div className="flex items-center gap-2 min-w-0">
          {selected?.iconComponent ? (
            <span className={selected.color || 'text-gray-500'}>{selected.iconComponent}</span>
          ) : selected?.icon ? (
            <i className={`fas ${selected.icon} ${selected.color || 'text-gray-500'} text-xs`}></i>
          ) : null}
          <span className="text-xs text-gray-700 truncate">{selected?.label || placeholder}</span>
        </div>
        <ChevronDown size={14} className={`text-gray-400 flex-shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <div className="absolute top-full left-0 mt-1 w-full min-w-[140px] bg-white border border-gray-200 rounded shadow-lg z-50 overflow-hidden">
          {options.map((opt) => (
            <button
              key={opt.value}
              onClick={() => {
                onChange(opt.value);
                setIsOpen(false);
              }}
              className={`w-full flex items-center gap-2 px-2.5 py-1.5 hover:bg-gray-50 transition-colors text-left ${
                value === opt.value ? 'bg-blue-50' : ''
              }`}
            >
              {opt.iconComponent ? (
                <span className={`${opt.color || 'text-gray-500'} w-4`}>{opt.iconComponent}</span>
              ) : opt.icon ? (
                <i className={`fas ${opt.icon} ${opt.color || 'text-gray-500'} text-xs w-4`}></i>
              ) : null}
              <span className="text-xs text-gray-700">{opt.label}</span>
              {value === opt.value && (
                <i className="fas fa-check text-blue-500 text-xs ml-auto"></i>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};


export const FlowDesigner = ({ flow, onChange, nodeTypes, connections, flowType = 'rest-api' }: FlowDesignerProps) => {
  const { id: _projectId } = useParams();
  
  console.log('[FlowDesigner] Render:', { flowType, nodeCount: flow.nodes.length, edgeCount: flow.edges.length, nodeTypesCount: nodeTypes?.length || 0 });
  
  // Safeguard for empty nodeTypes
  const safeNodeTypes = nodeTypes || [];
  if (safeNodeTypes.length === 0) {
    return (
      <div className="h-full flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <i className="fas fa-exclamation-triangle text-amber-500 text-3xl mb-3"></i>
          <p className="text-gray-600">No node types available</p>
          <p className="text-xs text-gray-400 mt-1">Please check node registry</p>
        </div>
      </div>
    );
  }
  
  // Generate unique marker IDs for this flow instance
  // Marker IDs not used - drawing custom arrows instead
  // const markerId = useMemo(() => `arrow-${Math.random().toString(36).substr(2, 9)}`, []);
  // const markerSelectedId = useMemo(() => `arrow-selected-${Math.random().toString(36).substr(2, 9)}`, []);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragState, setDragState] = useState<{
    type: 'node' | 'pan' | 'connect' | null;
    nodeId?: string;
    startX: number;
    startY: number;
    initialNodeX?: number;
    initialNodeY?: number;
    connectFrom?: string;
    sourcePort?: 'top' | 'right' | 'bottom' | 'left';
  }>({ type: null, startX: 0, startY: 0 });
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  // Below lg the node palette is a drawer over the canvas
  const [showPalette, setShowPalette] = useState(false);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [highlightedEdge, setHighlightedEdge] = useState<string | null>(null); // Edge to insert into
  const connectMode = false; // Connection mode toggle removed from toolbar
  const [tempEdge, setTempEdge] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);

  // Baskets state
  const [baskets, setBaskets] = useState<Array<{ id: string; name: string; type: string; isShared?: boolean }>>([]);

  // Fetch baskets from API
  useEffect(() => {
    if (_projectId) {
      fetch(`${API_URL}/baskets?projectId=${_projectId}`)
        .then(res => res.json())
        .then(data => {
          if (data.success) {
            setBaskets(data.data || []);
          }
        })
        .catch(err => console.error('Error fetching baskets:', err));
    }
  }, [_projectId]);

  // Encryption keys state
  const [encryptionKeys, setEncryptionKeys] = useState<Array<{ id: string; name: string; algorithm: string }>>([]);

  // Fetch encryption keys from API
  useEffect(() => {
    if (_projectId) {
      fetch(`${API_URL}/projects/${_projectId}/secrets?category=encryption-key`)
        .then(res => res.json())
        .then(data => {
          if (data.success) {
            setEncryptionKeys((data.data || []).map((k: any) => ({ id: k.id, name: k.name, algorithm: k.algorithm })));
          }
        })
        .catch(err => console.error('Error fetching encryption keys:', err));
    }
  }, [_projectId]);

  // Edge handle dragging state
  const [draggingEdgeHandle, setDraggingEdgeHandle] = useState<{
    edgeId: string;
    handle: 'source' | 'target';
  } | null>(null);

  // Code Editor Modal state
  const [sqlModalOpen, setSqlModalOpen] = useState(false);
  const [sqlModalValue, setSqlModalValue] = useState('');
  const [sqlModalNodeId, setSqlModalNodeId] = useState<string | null>(null);
  const [sqlModalTitle, setSqlModalTitle] = useState('SQL Editor');

  // Collapsible groups state - all collapsed by default for compact view
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({
    trigger: false,
    integration: false,
    action: false,
    processing: false,
    aggregate: false,
    api: false,
  });

  const toggleGroup = (group: string) => {
    setExpandedGroups(prev => ({ ...prev, [group]: !prev[group] }));
  };

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Only Delete key removes nodes/edges (not Backspace)
      if (e.key === 'Delete') {
        if (selectedNode) {
          deleteNode(selectedNode);
        } else if (selectedEdge) {
          deleteEdge(selectedEdge);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedNode, selectedEdge]);

  // Snap to grid
  const snap = (val: number) => Math.round(val / GRID_SIZE) * GRID_SIZE;

  const screenToCanvas = (sx: number, sy: number) => {
    if (!canvasRef.current) return { x: 0, y: 0 };
    const rect = canvasRef.current.getBoundingClientRect();
    return {
      x: (sx - rect.left - pan.x) / scale,
      y: (sy - rect.top - pan.y) / scale,
    };
  };

  const handleMouseDown = (e: React.MouseEvent, type: 'canvas' | 'node' | 'connect', nodeId?: string, port?: 'top' | 'right' | 'bottom' | 'left') => {
    e.stopPropagation();
    const pos = screenToCanvas(e.clientX, e.clientY);
    
    if (type === 'connect' && nodeId) {
      const node = flow.nodes.find(n => n.id === nodeId);
      if (node) {
        const DOT_OFFSET = 5; // adjusted
        const centerY = node.y + 30.5; // adjusted to match HTML dot
        const centerX = node.x + NODE_WIDTH / 2;
        
        let startX, startY;
        switch (port) {
          case 'top':
            startX = centerX;
            startY = node.y - DOT_OFFSET + 1.5; // marginTop adjustment
            break;
          case 'right':
            startX = node.x + NODE_WIDTH + DOT_OFFSET;
            startY = centerY + 1.5; // marginTop adjustment
            break;
          case 'bottom':
            startX = centerX;
            startY = node.y + NODE_HEIGHT + DOT_OFFSET - 1.5; // marginBottom adjustment
            break;
          case 'left':
            startX = node.x - DOT_OFFSET;
            startY = centerY + 1.5; // marginTop adjustment
            break;
          default:
            startX = node.x + NODE_WIDTH + DOT_OFFSET;
            startY = centerY;
        }
        
        setDragState({ type: 'connect', startX: pos.x, startY: pos.y, connectFrom: nodeId, sourcePort: port as 'top' | 'right' | 'bottom' | 'left' });
        setTempEdge({ x1: startX, y1: startY, x2: pos.x, y2: pos.y });
      }
    } else if (type === 'node' && nodeId) {
      const node = flow.nodes.find(n => n.id === nodeId);
      setSelectedNode(nodeId);
      setSelectedEdge(null);
      
      // Start dragging node
      {
        setDragState({
          type: 'node',
          nodeId,
          startX: pos.x,
          startY: pos.y,
          initialNodeX: node?.x,
          initialNodeY: node?.y,
        });
      }
    } else {
      setDragState({ type: 'pan', startX: e.clientX, startY: e.clientY });
      setSelectedNode(null);
      setSelectedEdge(null);
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    const pos = screenToCanvas(e.clientX, e.clientY);
    setMousePos(pos);

    if (dragState.type === 'node' && dragState.nodeId && dragState.initialNodeX !== undefined && dragState.initialNodeY !== undefined) {
      const dx = pos.x - dragState.startX;
      const dy = pos.y - dragState.startY;
      const newX = snap(dragState.initialNodeX + dx);
      const newY = snap(dragState.initialNodeY + dy);
      
      onChange({
        ...flow,
        nodes: flow.nodes.map(n => n.id === dragState.nodeId ? { ...n, x: newX, y: newY } : n),
      });
    } else if (dragState.type === 'pan') {
      const dx = e.clientX - dragState.startX;
      const dy = e.clientY - dragState.startY;
      setPan(prev => ({ x: prev.x + dx, y: prev.y + dy }));
      setDragState(prev => ({ ...prev, startX: e.clientX, startY: e.clientY }));
    } else if (dragState.type === 'connect' && tempEdge && dragState.connectFrom) {
      const fromNode = flow.nodes.find(n => n.id === dragState.connectFrom);
      if (fromNode) {
        // Keep starting from right connection dot
        const DOT_OFFSET = 6;
        const startX = fromNode.x + NODE_WIDTH + DOT_OFFSET;
        const startY = fromNode.y + NODE_HEIGHT / 2;
        setTempEdge({ 
          x1: startX, 
          y1: startY, 
          x2: pos.x, 
          y2: pos.y 
        });
      }
    } else if (draggingEdgeHandle) {
      // Update temp edge position while dragging handle
      const edge = flow.edges.find(e => e.id === draggingEdgeHandle.edgeId);
      if (edge) {
        const source = flow.nodes.find(n => n.id === edge.source);
        const target = flow.nodes.find(n => n.id === edge.target);
        if (source && target) {
          const DOT_OFFSET = 6;
          
          // Calculate base dot positions based on relative positions
          const centerX1 = source.x + NODE_WIDTH / 2;
          const centerY1 = source.y + NODE_HEIGHT / 2;
          const centerX2 = target.x + NODE_WIDTH / 2;
          const centerY2 = target.y + NODE_HEIGHT / 2;
          
          const dx = centerX2 - centerX1;
          const dy = centerY2 - centerY1;
          const isHorizontal = Math.abs(dx) > Math.abs(dy);
          
          let sx, sy, tx, ty;
          
          if (isHorizontal) {
            if (dx > 0) {
              sx = source.x + NODE_WIDTH + DOT_OFFSET;
              sy = centerY1;
              tx = target.x - DOT_OFFSET;
              ty = centerY2;
            } else {
              sx = source.x - DOT_OFFSET;
              sy = centerY1;
              tx = target.x + NODE_WIDTH + DOT_OFFSET;
              ty = centerY2;
            }
          } else {
            if (dy > 0) {
              sx = centerX1;
              sy = source.y + NODE_HEIGHT + DOT_OFFSET;
              tx = centerX2;
              ty = target.y - DOT_OFFSET;
            } else {
              sx = centerX1;
              sy = source.y - DOT_OFFSET;
              tx = centerX2;
              ty = target.y + NODE_HEIGHT + DOT_OFFSET;
            }
          }
          
          // Override with mouse position for the handle being dragged
          if (draggingEdgeHandle.handle === 'source') {
            sx = pos.x;
            sy = pos.y;
          } else {
            tx = pos.x;
            ty = pos.y;
          }
          
          setTempEdge({ x1: sx, y1: sy, x2: tx, y2: ty });
        }
      }
    }
  };

  // Helper to detect which port is closest to a point
  const detectPort = (node: FlowNode, x: number, y: number): 'top' | 'right' | 'bottom' | 'left' => {
    const DOT_OFFSET = 5;
    const centerY = node.y + 30.5;
    const centerX = node.x + NODE_WIDTH / 2;
    
    const dots = {
      top: { x: centerX, y: node.y - DOT_OFFSET + 1.5 },
      right: { x: node.x + NODE_WIDTH + DOT_OFFSET, y: centerY + 1.5 },
      bottom: { x: centerX, y: node.y + NODE_HEIGHT + DOT_OFFSET - 1.5 },
      left: { x: node.x - DOT_OFFSET, y: centerY + 1.5 },
    };
    
    let closest: 'top' | 'right' | 'bottom' | 'left' = 'right';
    let minDist = Infinity;
    
    (Object.keys(dots) as Array<keyof typeof dots>).forEach(port => {
      const dot = dots[port];
      const dist = Math.sqrt((x - dot.x) ** 2 + (y - dot.y) ** 2);
      if (dist < minDist) {
        minDist = dist;
        closest = port;
      }
    });
    
    return closest;
  };

  const handleMouseUp = (_e: React.MouseEvent) => {
    if (dragState.type === 'connect' && dragState.connectFrom) {
      // Find target node under mouse
      const targetNode = flow.nodes.find(n => {
        if (n.id === dragState.connectFrom) return false;
        const withinX = mousePos.x >= n.x && mousePos.x <= n.x + 120;
        const withinY = mousePos.y >= n.y && mousePos.y <= n.y + 50;
        return withinX && withinY;
      });

      if (targetNode) {
        const sourceNode = flow.nodes.find(n => n.id === dragState.connectFrom);
        if (sourceNode) {
          // Detect which ports to use
          const targetPort = detectPort(targetNode, mousePos.x, mousePos.y);
          // For source, use the port from dragState or detect based on direction
          const sourcePort = (dragState as any).sourcePort || detectPort(sourceNode, 
            sourceNode.x + 120 + 5, sourceNode.y + 30.5);
          
          // Check if edge already exists
          const exists = flow.edges.some(e => 
            e.source === dragState.connectFrom && e.target === targetNode.id
          );
          if (!exists) {
            // Derive label from sourcePort for special nodes (condition, for-each)
            const sourceType = sourceNode.type;
            let edgeLabel: string | undefined;
            if (sourceType === 'condition') {
              edgeLabel = sourcePort === 'bottom' ? 'false' : 'true';
            } else if (sourceType === 'for-each') {
              edgeLabel = sourcePort === 'bottom' ? 'done' : 'body';
            }
            onChange({
              ...flow,
              edges: [...flow.edges, {
                id: createId(),
                source: dragState.connectFrom,
                target: targetNode.id,
                sourcePort,
                targetPort,
                ...(edgeLabel ? { label: edgeLabel } : {}),
              }],
            });
          }
        }
      }
    } else if (draggingEdgeHandle && tempEdge) {
      // Find node under mouse for the dragged handle
      const targetNode = flow.nodes.find(n => {
        const withinX = mousePos.x >= n.x && mousePos.x <= n.x + 120;
        const withinY = mousePos.y >= n.y && mousePos.y <= n.y + 50;
        return withinX && withinY;
      });

      if (targetNode) {
        const edge = flow.edges.find(e => e.id === draggingEdgeHandle.edgeId);
        if (edge) {
          if (draggingEdgeHandle.handle === 'source') {
            // Update source node
            if (targetNode.id !== edge.target) {
              onChange({
                ...flow,
                edges: flow.edges.map(e => 
                  e.id === edge.id ? { ...e, source: targetNode.id } : e
                ),
              });
            }
          } else {
            // Update target node
            if (targetNode.id !== edge.source) {
              onChange({
                ...flow,
                edges: flow.edges.map(e => 
                  e.id === edge.id ? { ...e, target: targetNode.id } : e
                ),
              });
            }
          }
        }
      }
    }
    setDragState({ type: null, startX: 0, startY: 0 });
    setDraggingEdgeHandle(null);
    setTempEdge(null);
  };

  const addNode = (type: string, x?: number, y?: number) => {
    const centerX = x !== undefined ? x : (-pan.x + (canvasRef.current?.clientWidth || 800) / 2) / scale - NODE_WIDTH / 2;
    const centerY = y !== undefined ? y : (-pan.y + (canvasRef.current?.clientHeight || 600) / 2) / scale - NODE_HEIGHT / 2;
    
    const newNode: FlowNode = {
      id: createId(),
      type,
      x: snap(centerX),
      y: snap(centerY),
      data: {
        label: safeNodeTypes.find(n => n.type === type)?.label || type,
        varName: generateVarName(type, flow.nodes),
        ...(type === 'database' ? { connectionId: '', sql: '' } : {}),
      },
    };

    const newNodes = [...flow.nodes, newNode];
    onChange({ ...flow, nodes: newNodes });
    
    // Auto-layout: shift overlapping nodes
    setTimeout(() => autoLayoutNodes(newNodes), 10);
    
    return newNode;
  };

  // Auto-layout: prevent overlapping nodes by shifting them
  const autoLayoutNodes = (nodes: FlowNode[]) => {
    const MIN_DISTANCE_X = 160; // minimum horizontal distance between nodes
    const MIN_DISTANCE_Y = 80;  // minimum vertical distance between nodes
    
    const updatedNodes = [...nodes];
    let hasOverlap = true;
    let iterations = 0;
    const MAX_ITERATIONS = 100;
    
    while (hasOverlap && iterations < MAX_ITERATIONS) {
      hasOverlap = false;
      iterations++;
      
      for (let i = 0; i < updatedNodes.length; i++) {
        for (let j = i + 1; j < updatedNodes.length; j++) {
          const nodeA = updatedNodes[i];
          const nodeB = updatedNodes[j];
          
          const dx = Math.abs(nodeA.x - nodeB.x);
          const dy = Math.abs(nodeA.y - nodeB.y);
          
          if (dx < MIN_DISTANCE_X && dy < MIN_DISTANCE_Y) {
            hasOverlap = true;
            // Shift nodeB to the right
            updatedNodes[j] = {
              ...nodeB,
              x: nodeB.x + MIN_DISTANCE_X - dx + GRID_SIZE,
            };
          }
        }
      }
    }
    
    // Only update if positions changed
    const hasChanges = updatedNodes.some((n, i) => n.x !== nodes[i].x || n.y !== nodes[i].y);
    if (hasChanges) {
      onChange({ ...flow, nodes: updatedNodes });
    }
  };



  // Drag and drop handlers
  const [draggedNodeType, setDraggedNodeType] = useState<string | null>(null);

  const handleDragStart = (e: React.DragEvent, nodeType: string) => {
    setDraggedNodeType(nodeType);
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData('application/node-type', nodeType);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    
    // Highlight edge that will be inserted into
    if (canvasRef.current && draggedNodeType) {
      const rect = canvasRef.current.getBoundingClientRect();
      const dropX = (e.clientX - rect.left - pan.x) / scale;
      const dropY = (e.clientY - rect.top - pan.y) / scale;
      const edgeToInsert = findEdgeToInsert(dropX, dropY);
      setHighlightedEdge(edgeToInsert?.id || null);
    }
  };

  // Calculate distance from point to line segment
  const distanceToEdge = (px: number, py: number, x1: number, y1: number, x2: number, y2: number): number => {
    const A = px - x1;
    const B = py - y1;
    const C = x2 - x1;
    const D = y2 - y1;
    const dot = A * C + B * D;
    const lenSq = C * C + D * D;
    let param = -1;
    if (lenSq !== 0) param = dot / lenSq;
    let xx, yy;
    if (param < 0) { xx = x1; yy = y1; }
    else if (param > 1) { xx = x2; yy = y2; }
    else { xx = x1 + param * C; yy = y1 + param * D; }
    const dx = px - xx;
    const dy = py - yy;
    return Math.sqrt(dx * dx + dy * dy);
  };

  // Find edge near drop position for insertion
  const findEdgeToInsert = (dropX: number, dropY: number): FlowEdge | null => {
    const INSERT_THRESHOLD = 60; // pixels
    let closestEdge: FlowEdge | null = null;
    let minDistance = INSERT_THRESHOLD;
    
    for (const edge of flow.edges) {
      const source = flow.nodes.find(n => n.id === edge.source);
      const target = flow.nodes.find(n => n.id === edge.target);
      if (!source || !target) continue;
      
      // Node center points - must match rendering (120x46)
      const sx = source.x + NODE_WIDTH / 2;
      const sy = source.y + NODE_HEIGHT / 2;
      const tx = target.x + NODE_WIDTH / 2;
      const ty = target.y + NODE_HEIGHT / 2;
      
      const dist = distanceToEdge(dropX, dropY, sx, sy, tx, ty);
      if (dist < minDistance) {
        minDistance = dist;
        closestEdge = edge;
      }
    }
    return closestEdge;
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    
    const nodeType = e.dataTransfer.getData('application/node-type') || draggedNodeType;
    if (!nodeType || !canvasRef.current) return;
    
    const rect = canvasRef.current.getBoundingClientRect();
    const dropX = (e.clientX - rect.left - pan.x) / scale;
    const dropY = (e.clientY - rect.top - pan.y) / scale;
    
    // Check if dropping near an edge to insert into
    const edgeToInsert = findEdgeToInsert(dropX, dropY);
    
    if (edgeToInsert && edgeToInsert.source && edgeToInsert.target) {
      // Insert node into edge: split the edge
      const source = flow.nodes.find(n => n.id === edgeToInsert.source);
      const target = flow.nodes.find(n => n.id === edgeToInsert.target);
      
      if (source && target && source.id !== target.id) {
        // Position node in middle of the edge
        const midX = (source.x + target.x) / 2;
        const midY = (source.y + target.y) / 2;
        
        const newNode: FlowNode = {
          id: createId(),
          type: nodeType,
          x: snap(midX),
          y: snap(midY),
          data: {
            label: safeNodeTypes.find(n => n.type === nodeType)?.label || nodeType,
            varName: generateVarName(nodeType, flow.nodes),
            ...(nodeType === 'database' ? { connectionId: '', sql: '' } : {}),
          },
        };

        // Remove old edge, add two new edges
        const newEdge1: FlowEdge = { id: createId(), source: edgeToInsert.source, target: newNode.id };
        const newEdge2: FlowEdge = { id: createId(), source: newNode.id, target: edgeToInsert.target };
        
        const newNodes = [...flow.nodes, newNode];
        const newEdges = [
          ...flow.edges.filter(e => e.id !== edgeToInsert.id),
          newEdge1,
          newEdge2
        ];
        
        onChange({ nodes: newNodes, edges: newEdges });
        
        // Note: No auto-layout for insert-into-edge, node stays in middle of edge
        setDraggedNodeType(null);
        setHighlightedEdge(null);
        return;
      }
    }
    
    // Normal drop (not inserting into edge)
    addNode(nodeType, dropX, dropY);
    setDraggedNodeType(null);
    setHighlightedEdge(null);
  };

  const deleteNode = (nodeId: string) => {
    onChange({
      ...flow,
      nodes: flow.nodes.filter(n => n.id !== nodeId),
      edges: flow.edges.filter(e => e.source !== nodeId && e.target !== nodeId),
    });
    if (selectedNode === nodeId) setSelectedNode(null);
  };

  const deleteEdge = (edgeId: string) => {
    onChange({ ...flow, edges: flow.edges.filter(e => e.id !== edgeId) });
  };

  const updateNodeData = (nodeId: string, data: any) => {
    onChange({
      ...flow,
      nodes: flow.nodes.map(n => n.id === nodeId ? { ...n, data: { ...n.data, ...data } } : n),
    });
  };

  // SQL Modal handlers
  const openSqlModal = (nodeId: string, currentSql: string, modalTitle?: string) => {
    setSqlModalNodeId(nodeId);
    setSqlModalValue(currentSql || '');
    setSqlModalTitle(modalTitle || 'SQL Editor');
    setSqlModalOpen(true);
  };

  const closeSqlModal = () => {
    setSqlModalOpen(false);
    setSqlModalNodeId(null);
    setSqlModalValue('');
  };

  const saveSqlModal = () => {
    if (sqlModalNodeId) {
      const node = flow.nodes.find(n => n.id === sqlModalNodeId);
      const field = (node?.type === 'transform' || node?.data?.operation === 'code') ? 'code' : 'sql';
      updateNodeData(sqlModalNodeId, { [field]: sqlModalValue });
    }
    closeSqlModal();
  };

  const selectedNodeData = flow.nodes.find(n => n.id === selectedNode);
  const selectedNodeDef = selectedNodeData ? safeNodeTypes.find(n => n.type === selectedNodeData.type) : null;

  return (
    <div className="h-full flex relative">
      {/* Left Sidebar - Tools (drawer over the canvas below lg) */}
      {showPalette && <div className="lg:hidden absolute inset-0 z-20 bg-gray-900/20" onClick={() => setShowPalette(false)} />}
      <div className={`${showPalette ? 'flex absolute inset-y-0 left-0 z-30 shadow-xl' : 'hidden'} lg:static lg:z-auto lg:shadow-none lg:flex w-56 bg-white border-r flex-col h-full min-h-0`}>
        {/* Quick Add */}
        <div className="p-3 border-b bg-gray-50">
          <span className="text-[12px] text-gray-500 block mb-2">Quick Add</span>
          <div className="flex gap-1">
            {safeNodeTypes.slice(0, 4).map(node => (
              <button
                key={node.type}
                onClick={() => addNode(node.type)}
                className={`w-8 h-8 ${node.color} rounded flex items-center justify-center hover:opacity-80`}
                title={node.label}
              >
                <i className={`fas ${node.icon} text-white text-xs`}></i>
              </button>
            ))}
            <button
              onClick={() => addNode(safeNodeTypes[4]?.type || 'transform')}
              className="w-8 h-8 bg-gray-200 rounded flex items-center justify-center hover:bg-gray-300"
              title="More nodes"
            >
              <i className="fas fa-plus text-gray-600 text-xs"></i>
            </button>
          </div>
        </div>

        {/* Expand/Collapse All */}
        <div className="px-3 py-2 border-b bg-white flex gap-2">
          <button
            onClick={() => setExpandedGroups({ trigger: true, integration: true, action: true, processing: true, aggregate: true, api: true })}
            className="flex-1 whitespace-nowrap text-[12px] px-2 py-1 bg-gray-100 hover:bg-gray-200 rounded text-gray-600 transition-colors"
          >
            <i className="fas fa-expand-alt mr-1"></i>Expand All
          </button>
          <button
            onClick={() => setExpandedGroups({ trigger: false, integration: false, action: false, processing: false, aggregate: false, api: false })}
            className="flex-1 whitespace-nowrap text-[12px] px-2 py-1 bg-gray-100 hover:bg-gray-200 rounded text-gray-600 transition-colors"
          >
            <i className="fas fa-compress-alt mr-1"></i>Collapse All
          </button>
        </div>

        {/* Event Flow: Grouped by Category (Collapsible) */}
        {flowType === 'event' ? (
          <>
            {/* Trigger Nodes */}
            <button 
              onClick={() => toggleGroup('trigger')}
              className="w-full p-2 bg-orange-50 border-b border-orange-100 flex items-center justify-between hover:bg-orange-100 transition-colors"
            >
              <h3 className="font-medium text-xs text-orange-600 flex items-center gap-1">
                <i className="fas fa-bolt text-[12px]"></i> Triggers
                <span className="text-[12px] opacity-60">({safeNodeTypes.filter(n => n.category === 'trigger').length})</span>
              </h3>
              {expandedGroups.trigger ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
            {expandedGroups.trigger && (
              <div className="p-2 space-y-1 border-b">
                {safeNodeTypes.filter(n => n.category === 'trigger').map(node => (
                  <button
                    key={node.type}
                    onClick={() => addNode(node.type)}
                    draggable
                    onDragStart={(e) => handleDragStart(e, node.type)}
                    className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded hover:bg-orange-50 text-left transition-colors group/node"
                  >
                    <div className={`w-6 h-6 ${node.color} rounded flex items-center justify-center flex-shrink-0 group-hover/node:scale-110 transition-transform`}>
                      <i className={`fas ${node.icon} text-white text-[12px]`}></i>
                    </div>
                    <div className="min-w-0">
                      <span className="text-xs font-medium block truncate">{node.label}</span>
                    </div>
                  </button>
                ))}
              </div>
            )}

            {/* Integration Nodes */}
            <button 
              onClick={() => toggleGroup('integration')}
              className="w-full p-2 bg-indigo-50 border-b border-indigo-100 flex items-center justify-between hover:bg-indigo-100 transition-colors"
            >
              <h3 className="font-medium text-xs text-indigo-600 flex items-center gap-1">
                <i className="fas fa-plug text-[12px]"></i> Integration
                <span className="text-[12px] opacity-60">({safeNodeTypes.filter(n => n.category === 'integration').length})</span>
              </h3>
              {expandedGroups.integration ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
            {expandedGroups.integration && (
              <div className="p-2 space-y-1 border-b">
                {safeNodeTypes.filter(n => n.category === 'integration').map(node => (
                  <button
                    key={node.type}
                    onClick={() => addNode(node.type)}
                    draggable
                    onDragStart={(e) => handleDragStart(e, node.type)}
                    className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded hover:bg-indigo-50 text-left transition-colors group/node"
                  >
                    <div className={`w-6 h-6 ${node.color} rounded flex items-center justify-center flex-shrink-0 group-hover/node:scale-110 transition-transform`}>
                      <i className={`fas ${node.icon} text-white text-[12px]`}></i>
                    </div>
                    <div className="min-w-0">
                      <span className="text-xs font-medium block truncate">{node.label}</span>
                    </div>
                  </button>
                ))}
              </div>
            )}

            {/* Action Nodes */}
            <button 
              onClick={() => toggleGroup('action')}
              className="w-full p-2 bg-blue-50 border-b border-blue-100 flex items-center justify-between hover:bg-blue-100 transition-colors"
            >
              <h3 className="font-medium text-xs text-blue-600 flex items-center gap-1">
                <i className="fas fa-cogs text-[12px]"></i> Actions
                <span className="text-[12px] opacity-60">({safeNodeTypes.filter(n => n.category === 'action').length})</span>
              </h3>
              {expandedGroups.action ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
            {expandedGroups.action && (
              <div className="p-2 space-y-1 border-b">
                {safeNodeTypes.filter(n => n.category === 'action').map(node => (
                  <button
                    key={node.type}
                    onClick={() => addNode(node.type)}
                    draggable
                    onDragStart={(e) => handleDragStart(e, node.type)}
                    className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded hover:bg-blue-50 text-left transition-colors group/node"
                  >
                    <div className={`w-6 h-6 ${node.color} rounded flex items-center justify-center flex-shrink-0 group-hover/node:scale-110 transition-transform`}>
                      <i className={`fas ${node.icon} text-white text-[12px]`}></i>
                    </div>
                    <div className="min-w-0">
                      <span className="text-xs font-medium block truncate">{node.label}</span>
                    </div>
                  </button>
                ))}
              </div>
            )}

            {/* Aggregate Nodes (Fan-out/Fan-in) */}
            <button 
              onClick={() => toggleGroup('aggregate')}
              className="w-full p-2 bg-purple-50 border-b border-purple-100 flex items-center justify-between hover:bg-purple-100 transition-colors"
            >
              <h3 className="font-medium text-xs text-purple-600 flex items-center gap-1">
                <i className="fas fa-project-diagram text-[12px]"></i> Aggregate
                <span className="text-[12px] opacity-60">({safeNodeTypes.filter(n => n.category === 'aggregate').length})</span>
              </h3>
              {expandedGroups.aggregate ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
            {expandedGroups.aggregate && (
              <div className="p-2 space-y-1 border-b">
                {safeNodeTypes.filter(n => n.category === 'aggregate').map(node => (
                  <button
                    key={node.type}
                    onClick={() => addNode(node.type)}
                    draggable
                    onDragStart={(e) => handleDragStart(e, node.type)}
                    className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded hover:bg-purple-50 text-left transition-colors group/node"
                  >
                    <div className={`w-6 h-6 ${node.color} rounded flex items-center justify-center flex-shrink-0 group-hover/node:scale-110 transition-transform`}>
                      <i className={`fas ${node.icon} text-white text-[12px]`}></i>
                    </div>
                    <div className="min-w-0">
                      <span className="text-xs font-medium block truncate">{node.label}</span>
                    </div>
                  </button>
                ))}
              </div>
            )}

            {/* Processing Nodes */}
            <button 
              onClick={() => toggleGroup('processing')}
              className="w-full p-2 bg-gray-100 border-b flex items-center justify-between hover:bg-gray-200 transition-colors"
            >
              <h3 className="font-medium text-xs text-gray-600 flex items-center gap-1">
                <i className="fas fa-code-branch text-[12px]"></i> Processing
                <span className="text-[12px] opacity-60">({safeNodeTypes.filter(n => n.category === 'processing' || !n.category).length})</span>
              </h3>
              {expandedGroups.processing ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
            {expandedGroups.processing && (
              <div className="p-2 flex-1 overflow-y-auto space-y-1">
                {safeNodeTypes.filter(n => n.category === 'processing' || !n.category).map(node => (
                  <button
                    key={node.type}
                    onClick={() => addNode(node.type)}
                    draggable
                    onDragStart={(e) => handleDragStart(e, node.type)}
                    className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded hover:bg-gray-100 text-left transition-colors group/node"
                  >
                    <div className={`w-6 h-6 ${node.color} rounded flex items-center justify-center flex-shrink-0 group-hover/node:scale-110 transition-transform`}>
                      <i className={`fas ${node.icon} text-white text-[12px]`}></i>
                    </div>
                    <div className="min-w-0">
                      <span className="text-xs font-medium block truncate">{node.label}</span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </>
        ) : (
          /* API Flow: Grouped by Category (Collapsible) */
          <>
            {/* API Nodes (Input/Output) */}
            <button 
              onClick={() => toggleGroup('api')}
              className="w-full p-2 bg-blue-50 border-b border-blue-100 flex items-center justify-between hover:bg-blue-100 transition-colors"
            >
              <h3 className="font-medium text-xs text-blue-600 flex items-center gap-1">
                <i className="fas fa-exchange-alt text-[12px]"></i> API
                <span className="text-[12px] opacity-60">({safeNodeTypes.filter(n => n.category === 'api').length})</span>
              </h3>
              {expandedGroups.api ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
            {expandedGroups.api && (
              <div className="p-2 space-y-1 border-b">
                {safeNodeTypes.filter(n => n.category === 'api').map(node => (
                  <button
                    key={node.type}
                    onClick={() => addNode(node.type)}
                    draggable
                    onDragStart={(e) => handleDragStart(e, node.type)}
                    className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded hover:bg-blue-50 text-left transition-colors group/node"
                  >
                    <div className={`w-6 h-6 ${node.color} rounded flex items-center justify-center flex-shrink-0 group-hover/node:scale-110 transition-transform`}>
                      <i className={`fas ${node.icon} text-white text-[12px]`}></i>
                    </div>
                    <div className="min-w-0">
                      <span className="text-xs font-medium block truncate">{node.label}</span>
                    </div>
                  </button>
                ))}
              </div>
            )}

            {/* Integration Nodes */}
            <button 
              onClick={() => toggleGroup('integration')}
              className="w-full p-2 bg-indigo-50 border-b border-indigo-100 flex items-center justify-between hover:bg-indigo-100 transition-colors"
            >
              <h3 className="font-medium text-xs text-indigo-600 flex items-center gap-1">
                <i className="fas fa-plug text-[12px]"></i> Integration
                <span className="text-[12px] opacity-60">({safeNodeTypes.filter(n => n.category === 'integration').length})</span>
              </h3>
              {expandedGroups.integration ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
            {expandedGroups.integration && (
              <div className="p-2 space-y-1 border-b">
                {safeNodeTypes.filter(n => n.category === 'integration').map(node => (
                  <button
                    key={node.type}
                    onClick={() => addNode(node.type)}
                    draggable
                    onDragStart={(e) => handleDragStart(e, node.type)}
                    className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded hover:bg-indigo-50 text-left transition-colors group/node"
                  >
                    <div className={`w-6 h-6 ${node.color} rounded flex items-center justify-center flex-shrink-0 group-hover/node:scale-110 transition-transform`}>
                      <i className={`fas ${node.icon} text-white text-[12px]`}></i>
                    </div>
                    <div className="min-w-0">
                      <span className="text-xs font-medium block truncate">{node.label}</span>
                    </div>
                  </button>
                ))}
              </div>
            )}

            {/* Processing Nodes */}
            <button 
              onClick={() => toggleGroup('processing')}
              className="w-full p-2 bg-cyan-50 border-b border-cyan-100 flex items-center justify-between hover:bg-cyan-100 transition-colors"
            >
              <h3 className="font-medium text-xs text-cyan-600 flex items-center gap-1">
                <i className="fas fa-code-branch text-[12px]"></i> Processing
                <span className="text-[12px] opacity-60">({safeNodeTypes.filter(n => n.category === 'processing' || !n.category).length})</span>
              </h3>
              {expandedGroups.processing ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
            {expandedGroups.processing && (
              <div className="p-2 flex-1 overflow-y-auto space-y-1">
                {safeNodeTypes.filter(n => n.category === 'processing' || !n.category).map(node => (
                  <button
                    key={node.type}
                    onClick={() => addNode(node.type)}
                    draggable
                    onDragStart={(e) => handleDragStart(e, node.type)}
                    className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded hover:bg-cyan-50 text-left transition-colors group/node"
                  >
                    <div className={`w-6 h-6 ${node.color} rounded flex items-center justify-center flex-shrink-0 group-hover/node:scale-110 transition-transform`}>
                      <i className={`fas ${node.icon} text-white text-[12px]`}></i>
                    </div>
                    <div className="min-w-0">
                      <span className="text-xs font-medium block truncate">{node.label}</span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
        
        {/* Status */}
        <div className="p-3 border-t text-xs text-gray-500 space-y-1 bg-gray-50">
          <div className="flex justify-between">
            <span>Nodes:</span>
            <span className="font-medium">{flow.nodes.length}</span>
          </div>
          <div className="flex justify-between">
            <span>Edges:</span>
            <span className="font-medium">{flow.edges.length}</span>
          </div>
          {selectedNode && (
            <div className="text-blue-600 mt-2 pt-2 border-t">
              <i className="fas fa-mouse-pointer mr-1"></i>
              Node: {flow.nodes.find(n => n.id === selectedNode)?.data?.label || 'Selected'}
            </div>
          )}
          {selectedEdge && (
            <div className="text-blue-600 mt-2 pt-2 border-t">
              <i className="fas fa-project-diagram mr-1"></i>
              Edge selected - Press Delete key
            </div>
          )}
          {connectMode && (
            <div className="text-green-600 mt-2 pt-2 border-t animate-pulse">
              <i className="fas fa-link mr-1"></i>
              Click & drag between nodes to connect
            </div>
          )}
        </div>
      </div>

      {/* Canvas */}
      <div className="flex-1 min-w-0 relative overflow-hidden bg-gray-50">
        <button
          type="button"
          onClick={() => setShowPalette(true)}
          className="lg:hidden absolute top-3 left-3 z-10 h-9 px-3 inline-flex items-center gap-2 rounded-lg bg-white border shadow-sm text-[14px] text-gray-700"
        >
          <i className="fas fa-plus text-xs"></i> Nodes
        </button>
        <div
          ref={canvasRef}
          className="absolute inset-0 cursor-grab active:cursor-grabbing"
          onMouseDown={(e) => handleMouseDown(e, 'canvas')}
          onMouseMove={handleMouseMove}
          onMouseUp={(e) => handleMouseUp(e)}
          onMouseLeave={handleMouseUp}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          onWheel={(e) => {
            if (e.ctrlKey || e.metaKey) {
              e.preventDefault();
              const delta = e.deltaY > 0 ? 0.9 : 1.1;
              setScale(s => Math.max(0.3, Math.min(3, s * delta)));
            }
          }}
        >
          {/* Infinite Grid Background - extends with pan */}
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              backgroundImage: `
                linear-gradient(to right, var(--canvas-grid) 1px, transparent 1px),
                linear-gradient(to bottom, var(--canvas-grid) 1px, transparent 1px)
              `,
              backgroundSize: `${GRID_SIZE * scale}px ${GRID_SIZE * scale}px`,
              backgroundPosition: `${pan.x}px ${pan.y}px`,
              width: '100%',
              height: '100%',
            }}
          />

          {/* Content - expands with nodes */}
          <div
            className="absolute top-0 left-0"
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
              transformOrigin: '0 0',
              width: Math.max(4000, ...flow.nodes.map(n => n.x + 300), 0),
              height: Math.max(4000, ...flow.nodes.map(n => n.y + 200), 0),
              minWidth: '100%',
              minHeight: '100%',
            }}
          >
            {/* Edges SVG */}
            <svg 
              className="absolute top-0 left-0 w-full h-full overflow-visible"
              style={{ 
                zIndex: 10,
              }}
            >
              <defs>
                {/* No markers - drawing custom arrows instead */}
              </defs>
              
              {flow.edges.map(edge => {
                const source = flow.nodes.find(n => n.id === edge.source);
                const target = flow.nodes.find(n => n.id === edge.target);
                if (!source || !target) return null;
                
                // Check if this edge is being dragged
                const isDraggingThisEdge = draggingEdgeHandle?.edgeId === edge.id;
                
                // Node dimensions - MUST match HTML node rendering
                const DOT_OFFSET = 5;     // Adjusted: was 6, now 5 to align with HTML dot
                
                // Node centers - adjusted to match HTML dot positions
                const centerX1 = source.x + NODE_WIDTH / 2;
                const centerY1 = source.y + 30.5; // Adjusted: HTML dot moved down 1px
                const centerX2 = target.x + NODE_WIDTH / 2;
                const centerY2 = target.y + 30.5; // Adjusted: HTML dot moved down 1px
                
                // Calculate direction to determine which connection dots to use
                const dx = centerX2 - centerX1;
                const dy = centerY2 - centerY1;
                const isHorizontal = Math.abs(dx) > Math.abs(dy);
                
                // Connection dot positions
                let sx, sy, tx, ty;
                
                // Helper to get dot position
                const getDotPos = (node: FlowNode, port: 'top' | 'right' | 'bottom' | 'left' | undefined, centerX: number, centerY: number) => {
                  switch (port) {
                    case 'top': return { x: centerX, y: node.y - DOT_OFFSET + 1.5 };
                    case 'right': return { x: node.x + NODE_WIDTH + DOT_OFFSET, y: centerY + 1.5 };
                    case 'bottom': return { x: centerX, y: node.y + NODE_HEIGHT + DOT_OFFSET - 1.5 };
                    case 'left': return { x: node.x - DOT_OFFSET, y: centerY + 1.5 };
                    default: return null;
                  }
                };
                
                // Use stored ports if available, otherwise auto-detect
                const sourcePos = getDotPos(source, edge.sourcePort, centerX1, centerY1);
                const targetPos = getDotPos(target, edge.targetPort, centerX2, centerY2);
                
                if (sourcePos && targetPos) {
                  // Use specified ports
                  sx = sourcePos.x; sy = sourcePos.y;
                  tx = targetPos.x; ty = targetPos.y;
                } else {
                  // Auto-detect based on relative positions
                  if (isHorizontal) {
                    if (dx > 0) {
                      sx = source.x + NODE_WIDTH + DOT_OFFSET;
                      sy = centerY1;
                      tx = target.x - DOT_OFFSET;
                      ty = centerY2;
                    } else {
                      sx = source.x - DOT_OFFSET;
                      sy = centerY1;
                      tx = target.x + NODE_WIDTH + DOT_OFFSET;
                      ty = centerY2;
                    }
                  } else {
                    if (dy > 0) {
                      sx = centerX1;
                      sy = source.y + NODE_HEIGHT + DOT_OFFSET;
                      tx = centerX2;
                      ty = target.y - DOT_OFFSET;
                    } else {
                      sx = centerX1;
                      sy = source.y - DOT_OFFSET;
                      tx = centerX2;
                      ty = target.y + NODE_HEIGHT + DOT_OFFSET;
                    }
                  }
                }
                
                // Use tempEdge positions if dragging this edge
                if (isDraggingThisEdge && tempEdge) {
                  sx = tempEdge.x1;
                  sy = tempEdge.y1;
                  tx = tempEdge.x2;
                  ty = tempEdge.y2;
                }
                
                // Path goes directly to HTML connection dot centers
                // Arrow marker (refX=6) will point exactly at the dot center
                let path;
                if (isHorizontal) {
                  const mx = sx + (tx - sx) * 0.5;
                  path = `M ${sx} ${sy} C ${mx} ${sy}, ${mx} ${ty}, ${tx} ${ty}`;
                } else {
                  const my = sy + (ty - sy) * 0.5;
                  path = `M ${sx} ${sy} C ${sx} ${my}, ${tx} ${my}, ${tx} ${ty}`;
                }

                const isSelected = selectedEdge === edge.id;
                const isHighlighted = highlightedEdge === edge.id;
                const sourceNode = flow.nodes.find(n => n.id === edge.source);
                const targetNode = flow.nodes.find(n => n.id === edge.target);
                const sourceLabel = sourceNode?.data?.label || sourceNode?.type || '?';
                const targetLabel = targetNode?.data?.label || targetNode?.type || '?';

                return (
                  <g key={edge.id} style={{ pointerEvents: 'all' }}>
                    
                    {/* Invisible path for clicking - thinner */}
                    <path
                      d={path}
                      stroke="transparent"
                      strokeWidth={8}
                      fill="none"
                      style={{ cursor: 'pointer' }}
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedEdge(edge.id);
                        setSelectedNode(null);
                      }}
                      onDoubleClick={() => deleteEdge(edge.id)}
                    />
                    
                    {/* Visible path with glow when selected or highlighted */}
                    {(isSelected || isHighlighted) && (
                      <path
                        d={path}
                        stroke={isHighlighted ? '#86efac' : '#93c5fd'}
                        strokeWidth={isHighlighted ? 10 : 8}
                        fill="none"
                        opacity={isHighlighted ? 0.5 : 0.3}
                        style={{ pointerEvents: 'none' }}
                      />
                    )}
                    <path
                      d={path}
                      stroke={isSelected ? '#3b82f6' : isHighlighted ? '#22c55e' : '#64748b'}
                      strokeWidth={isSelected ? 3 : isHighlighted ? 4 : 2}
                      fill="none"
                      style={{ pointerEvents: 'none' }}
                    />
                    
                    {/* Arrow head at line end - simple triangle pointing along line */}
                    {(() => {
                      // Get angle from bezier control point to end
                      // For M sx,sy C cp1x,cp1y cp2x,cp2y tx,ty
                      // The line approaches from cp2 toward tx,ty
                      let cp2x, cp2y;
                      if (isHorizontal) {
                        cp2x = sx + (tx - sx) * 0.5;
                        cp2y = ty;
                      } else {
                        cp2x = tx;
                        cp2y = sy + (ty - sy) * 0.5;
                      }
                      // Angle from control point to end (where line comes from)
                      const angle = Math.atan2(ty - cp2y, tx - cp2x);
                      
                      // Simple triangle arrow
                      const L = 10; // length
                      const W = 6;  // half width
                      
                      // Tip at connection dot
                      const tipX = tx;
                      const tipY = ty;
                      // Base center (back from tip along the line)
                      const baseX = tx - L * Math.cos(angle);
                      const baseY = ty - L * Math.sin(angle);
                      // Left and right corners of base
                      const leftX = baseX - W * Math.sin(angle);
                      const leftY = baseY + W * Math.cos(angle);
                      const rightX = baseX + W * Math.sin(angle);
                      const rightY = baseY - W * Math.cos(angle);
                      
                      return (
                        <polygon
                          points={`${tipX},${tipY} ${leftX},${leftY} ${rightX},${rightY}`}
                          fill={isSelected ? '#3b82f6' : isHighlighted ? '#22c55e' : '#64748b'}
                          style={{ pointerEvents: 'none' }}
                        />
                      );
                    })()}
                    
                    {/* Label showing connection */}
                    <text
                      x={(sx + tx) / 2}
                      y={(sy + ty) / 2 - 8}
                      textAnchor="middle"
                      fill={isSelected ? '#3b82f6' : '#9ca3af'}
                      style={{ fontSize: '9px', pointerEvents: 'none', fontWeight: isSelected ? 'bold' : 'normal' }}
                    >
                      {edge.label ? `[${edge.label}] ` : ''}{sourceLabel} → {targetLabel}
                    </text>
                    
                    {/* Delete button on edge */}
                    {isSelected && (
                      <g 
                        style={{ cursor: 'pointer' }}
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteEdge(edge.id);
                        }}
                      >
                        <circle
                          cx={(sx + tx) / 2}
                          cy={(sy + ty) / 2}
                          r="10"
                          fill="#ef4444"
                          stroke="white"
                          strokeWidth="2"
                        />
                        {/* X icon */}
                        <line x1={(sx + tx) / 2 - 4} y1={(sy + ty) / 2 - 4} x2={(sx + tx) / 2 + 4} y2={(sy + ty) / 2 + 4} stroke="white" strokeWidth="2" />
                        <line x1={(sx + tx) / 2 + 4} y1={(sy + ty) / 2 - 4} x2={(sx + tx) / 2 - 4} y2={(sy + ty) / 2 + 4} stroke="white" strokeWidth="2" />
                      </g>
                    )}
                  </g>
                );
              })}
              
              {/* Temporary edge while connecting */}
              {tempEdge && (
                <>
                  {/* Temp line */}
                  <line
                    x1={tempEdge.x1}
                    y1={tempEdge.y1}
                    x2={tempEdge.x2}
                    y2={tempEdge.y2}
                    stroke="#3b82f6"
                    strokeWidth={2}
                    strokeDasharray="5,5"
                  />
                  {/* Temp arrow head */}
                  {(() => {
                    const dx = tempEdge.x2 - tempEdge.x1;
                    const dy = tempEdge.y2 - tempEdge.y1;
                    const angle = Math.atan2(dy, dx);
                    const L = 10, W = 6;
                    const tx = tempEdge.x2, ty = tempEdge.y2;
                    const baseX = tx - L * Math.cos(angle);
                    const baseY = ty - L * Math.sin(angle);
                    const leftX = baseX - W * Math.sin(angle);
                    const leftY = baseY + W * Math.cos(angle);
                    const rightX = baseX + W * Math.sin(angle);
                    const rightY = baseY - W * Math.cos(angle);
                    
                    return (
                      <polygon
                        points={`${tx},${ty} ${leftX},${leftY} ${rightX},${rightY}`}
                        fill="#3b82f6"
                      />
                    );
                  })()}
                  {/* Glow effect */}
                  <line
                    x1={tempEdge.x1}
                    y1={tempEdge.y1}
                    x2={tempEdge.x2}
                    y2={tempEdge.y2}
                    stroke="#93c5fd"
                    strokeWidth={6}
                    opacity={0.3}
                  />
                  {/* Target indicator circle */}
                  <circle 
                    cx={tempEdge.x2} 
                    cy={tempEdge.y2} 
                    r="5" 
                    fill="#3b82f6" 
                    opacity={0.5}
                  />
                </>
              )}
            </svg>

            {/* Nodes */}
            {flow.nodes.map(node => {
              const def = safeNodeTypes.find(n => n.type === node.type);
              const isSelected = selectedNode === node.id;
              
              return (
                <div
                  key={node.id}
                  className={`absolute ${isSelected ? 'z-20' : 'z-10'}`}
                  style={{
                    left: node.x,
                    top: node.y,
                    width: NODE_WIDTH,
                    height: NODE_HEIGHT,
                  }}
                >
                  {/* Ports: small hollow dots on every side (Robot Factory style) */}
                  {(connectMode || true) && (
                    <>
                      <div
                        className={`absolute -top-1.5 left-1/2 -translate-x-1/2 w-3 h-3 rounded-full cursor-crosshair z-30 transition-shadow bg-[var(--canvas-node)] ${
                          connectMode ? 'shadow-[inset_0_0_0_2px_#24a148] animate-pulse' : 'shadow-[inset_0_0_0_2px_var(--canvas-port)] hover:shadow-[inset_0_0_0_2px_#4589ff]'
                        }`}
                        onMouseDown={(e) => handleMouseDown(e, 'connect', node.id, 'top')}
                        title="Drag to connect"
                      />
                      <div
                        className={`absolute top-1/2 -right-1.5 -translate-y-1/2 w-3 h-3 rounded-full cursor-crosshair z-30 transition-shadow bg-[var(--canvas-node)] ${
                          connectMode ? 'shadow-[inset_0_0_0_2px_#24a148] animate-pulse' : 'shadow-[inset_0_0_0_2px_var(--canvas-port)] hover:shadow-[inset_0_0_0_2px_#4589ff]'
                        }`}
                        onMouseDown={(e) => handleMouseDown(e, 'connect', node.id, 'right')}
                        title="Drag to connect"
                      />
                      <div
                        className={`absolute -bottom-1.5 left-1/2 -translate-x-1/2 w-3 h-3 rounded-full cursor-crosshair z-30 transition-shadow bg-[var(--canvas-node)] ${
                          connectMode ? 'shadow-[inset_0_0_0_2px_#24a148] animate-pulse' : 'shadow-[inset_0_0_0_2px_var(--canvas-port)] hover:shadow-[inset_0_0_0_2px_#4589ff]'
                        }`}
                        onMouseDown={(e) => handleMouseDown(e, 'connect', node.id, 'bottom')}
                        title="Drag to connect"
                      />
                      <div
                        className={`absolute top-1/2 -left-1.5 -translate-y-1/2 w-3 h-3 rounded-full cursor-crosshair z-30 transition-shadow bg-[var(--canvas-node)] ${
                          connectMode ? 'shadow-[inset_0_0_0_2px_#24a148] animate-pulse' : 'shadow-[inset_0_0_0_2px_var(--canvas-port)] hover:shadow-[inset_0_0_0_2px_#4589ff]'
                        }`}
                        onMouseDown={(e) => handleMouseDown(e, 'connect', node.id, 'left')}
                        title="Drag to connect"
                      />
                    </>
                  )}

                  {/* Node card: icon tile · type · name · summary */}
                  <div
                    className={`relative select-none grid grid-cols-[36px_minmax(0,1fr)] items-center gap-2.5 h-full pl-2.5 pr-3 rounded-[10px] bg-[var(--canvas-node)] text-[var(--canvas-node-text)] cursor-move transition-shadow ${
                      isSelected
                        ? 'shadow-[inset_0_0_0_2px_var(--canvas-node-text),0_10px_22px_rgb(0_0_0/0.18)]'
                        : connectMode
                        ? 'shadow-[inset_0_0_0_1px_#24a148,0_1px_2px_rgb(0_0_0/0.06)]'
                        : 'shadow-[inset_0_0_0_1px_var(--canvas-node-line),0_1px_2px_rgb(0_0_0/0.06),0_4px_12px_rgb(0_0_0/0.04)] hover:shadow-[inset_0_0_0_1px_var(--canvas-port),0_2px_4px_rgb(0_0_0/0.08),0_8px_18px_rgb(0_0_0/0.06)]'
                    }`}
                    onMouseDown={(e) => handleMouseDown(e, 'node', node.id)}
                  >
                    <span className={`grid place-items-center w-9 h-9 rounded-[9px] ${def?.color || 'bg-gray-500'}`}>
                      <i className={`fas ${def?.icon || 'fa-cube'} text-white text-[15px]`}></i>
                    </span>
                    <span className="grid gap-px min-w-0 leading-tight">
                      <small className="text-[11px] font-semibold uppercase tracking-[0.02em] text-[var(--canvas-node-muted)] truncate">
                        {def?.label || node.type}
                      </small>
                      <b className="text-[14px] font-semibold truncate">
                        {node.data?.label || def?.label || node.type}
                      </b>
                      <span className="text-[12px] text-[var(--canvas-node-muted)] truncate">
                        {node.type === 'database' && node.data?.connectionId
                          ? `${connections.find(c => c.id === node.data?.connectionId)?.name || '...'} · ${node.data?.operation || 'select'}`
                          : node.type === 'file-read' && node.data?.basketId
                          ? `Basket: ${baskets.find(b => b.id === node.data?.basketId)?.name || '...'}`
                          : node.type === 'for-each'
                          ? `Loop: ${node.data?.source || 'triggerFiles'}${(node.data?.workers || 1) > 1 ? ` (${node.data?.workers}w)` : ''}`
                          : node.data?.varName || node.type}
                      </span>
                    </span>
                    {isSelected && (
                      <button
                        onClick={(e) => { e.stopPropagation(); deleteNode(node.id); }}
                        onMouseDown={(e) => e.stopPropagation()}
                        className="absolute -top-2.5 -right-2.5 grid place-items-center w-5 h-5 rounded-full bg-red-600 text-white shadow"
                        title="Delete node"
                      >
                        <i className="fas fa-times text-[10px]"></i>
                      </button>
                    )}
                    {(node.type === 'condition' || node.type === 'for-each') && (
                      <>
                        <span className="absolute -right-2 top-1/2 translate-x-full -translate-y-1/2 pl-1 text-[11px] font-semibold text-[var(--canvas-node-muted)] pointer-events-none">
                          {node.type === 'condition' ? 'true' : 'body'}
                        </span>
                        <span className="absolute bottom-0 left-1/2 translate-y-full -translate-x-1/2 pt-2 text-[11px] font-semibold text-[var(--canvas-node-muted)] pointer-events-none">
                          {node.type === 'condition' ? 'false' : 'done'}
                        </span>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Controls */}
        <div className="absolute bottom-4 right-4 flex flex-col gap-2">
          <div className="bg-white rounded-lg shadow-lg border p-1">
            <button onClick={() => setScale(s => Math.min(3, s * 1.2))} className="w-8 h-8 flex items-center justify-center hover:bg-gray-100 rounded">
              <i className="fas fa-plus text-gray-600 text-xs"></i>
            </button>
            <div className="w-8 h-8 flex items-center justify-center text-xs font-medium">{Math.round(scale * 100)}%</div>
            <button onClick={() => setScale(s => Math.max(0.3, s * 0.8))} className="w-8 h-8 flex items-center justify-center hover:bg-gray-100 rounded">
              <i className="fas fa-minus text-gray-600 text-xs"></i>
            </button>
          </div>
          <button onClick={() => { setPan({ x: 0, y: 0 }); setScale(1); }} className="w-10 h-10 bg-white rounded-lg shadow-lg border flex items-center justify-center hover:bg-gray-100">
            <i className="fas fa-compress text-gray-600 text-xs"></i>
          </button>
        </div>
      </div>

      {/* Right Panel - Properties (below lg: slides over the canvas only while a node is selected) */}
      <div className={`${selectedNodeData ? 'flex absolute inset-y-0 right-0 z-30 shadow-xl max-w-full' : 'hidden'} lg:static lg:z-auto lg:shadow-none lg:flex w-80 lg:w-72 bg-white border-l flex-col h-full min-h-0`}>
        <div className="p-3 border-b flex items-center">
          <h3 className="font-medium text-sm">Properties</h3>
          <button type="button" onClick={() => setSelectedNode(null)} className="lg:hidden ml-auto h-7 w-7 inline-flex items-center justify-center rounded text-gray-500 hover:bg-gray-100" title="Close">
            <i className="fas fa-times"></i>
          </button>
        </div>
        
        {selectedNodeData ? (
          <div className="p-4 space-y-4 overflow-y-auto flex-1 min-h-0 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
            {/* Node Info */}
            <div className="p-3 bg-blue-50 rounded-lg border border-blue-200">
              <div className="flex items-center gap-2">
                <div className={`w-8 h-8 ${selectedNodeDef?.color || 'bg-gray-500'} rounded flex items-center justify-center`}>
                  <i className={`fas ${selectedNodeDef?.icon || 'fa-cube'} text-white text-xs`}></i>
                </div>
                <div>
                  <p className="text-sm font-medium">{selectedNodeDef?.label || selectedNodeData.type}</p>
                  <p className="text-xs text-gray-500">{selectedNodeData.type}</p>
                </div>
              </div>
            </div>

            {/* ID (varName) */}
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">ID</label>
              <input
                type="text"
                value={selectedNodeData.data?.varName || ''}
                onChange={(e) => {
                  const val = e.target.value.replace(/[^a-zA-Z0-9]/g, '');
                  updateNodeData(selectedNodeData.id, { varName: val });
                }}
                className={`w-full px-2 py-1.5 text-sm border rounded focus:ring-2 focus:ring-blue-500 outline-none font-mono ${
                  selectedNodeData.data?.varName && flow.nodes.some(n => n.id !== selectedNodeData.id && n.data?.varName === selectedNodeData.data?.varName)
                    ? 'border-red-400 bg-red-50' : ''
                }`}
                placeholder="e.g. db1, http1"
              />
              {selectedNodeData.data?.varName && flow.nodes.some(n => n.id !== selectedNodeData.id && n.data?.varName === selectedNodeData.data?.varName) && (
                <p className="text-[12px] text-red-500 mt-0.5">ID ซ้ำกับ node อื่น</p>
              )}
              <p className="text-[12px] text-gray-400 mt-0.5">ใช้อ้างอิง: <code className="bg-gray-100 px-1">{`{{${selectedNodeData.data?.varName || 'id'}.rows}}`}</code></p>
            </div>

            {/* Label */}
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Label</label>
              <input
                type="text"
                value={selectedNodeData.data?.label || ''}
                onChange={(e) => updateNodeData(selectedNodeData.id, { label: e.target.value })}
                className="w-full px-2 py-1.5 text-sm border rounded focus:ring-2 focus:ring-blue-500 outline-none"
              />
            </div>

            {/* Database-specific config */}
            {selectedNodeData.type === 'database' && (
              <>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Connection</label>
                  <MiniDropdown
                    value={selectedNodeData.data?.connectionId || ''}
                    onChange={(value) => updateNodeData(selectedNodeData.id, { connectionId: value })}
                    options={[
                      { value: '', label: 'Select connection...', icon: 'fa-database', color: 'text-gray-400' },
                      ...connections.map(conn => ({
                        value: conn.id,
                        label: `${conn.name} (${conn.type})`,
                        icon: 'fa-database',
                        color: 'text-blue-500'
                      }))
                    ]}
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Operation</label>
                  <MiniDropdown
                    value={selectedNodeData.data?.operation || 'select'}
                    onChange={(value) => updateNodeData(selectedNodeData.id, { operation: value })}
                    options={[
                      { value: 'select', label: 'SELECT (Query)', icon: 'fa-search', color: 'text-blue-500' },
                      { value: 'query', label: 'PL/SQL', icon: 'fa-code', color: 'text-indigo-500' },
                      { value: 'code', label: 'Code', icon: 'fa-terminal', color: 'text-purple-500' },
                      { value: 'insert', label: 'INSERT (Create)', icon: 'fa-plus', color: 'text-green-500' },
                      { value: 'execute', label: 'EXECUTE (SQL/PL/SQL)', icon: 'fa-play', color: 'text-teal-500' },
                      { value: 'bulk-insert', label: 'BULK INSERT (Batch)', icon: 'fa-upload', color: 'text-orange-500' },
                      { value: 'update', label: 'UPDATE (Modify)', icon: 'fa-edit', color: 'text-amber-500' },
                      { value: 'delete', label: 'DELETE (Remove)', icon: 'fa-trash', color: 'text-red-500' },
                    ]}
                  />
                </div>

                {selectedNodeData.data?.operation === 'code' ? (
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-xs font-medium text-gray-700">Code Editor</label>
                      <button
                        onClick={() => openSqlModal(selectedNodeData.id, selectedNodeData.data?.code || '', 'Code Editor')}
                        className="text-[12px] px-2 py-1 bg-blue-500 text-white rounded hover:bg-blue-600 flex items-center gap-1"
                      >
                        <Maximize2 size={10} />
                        Expand Editor
                      </button>
                    </div>
                    <textarea
                      value={selectedNodeData.data?.code || ''}
                      onChange={(e) => updateNodeData(selectedNodeData.id, { code: e.target.value })}
                      className="w-full px-2 py-1.5 text-sm border rounded font-mono text-[12px] leading-relaxed"
                      rows={12}
                      placeholder={'// input = previous node output\n// vars = trigger parameters\n// return SQL string or { sql: "...", summary: {...} }\nconst sql = `BEGIN\\n  ...\\nEND;`;\nreturn sql;'}
                    />
                    <p className="text-[12px] text-gray-500 mt-1">
                      Access: <code className="bg-gray-100 px-1">input</code> (prev node), <code className="bg-gray-100 px-1">vars</code> (parameters), <code className="bg-gray-100 px-1">context</code>. Return SQL string or {'{ sql, summary }'}
                    </p>
                  </div>
                ) : selectedNodeData.data?.operation === 'execute' ? (
                  <>
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <label className="text-xs font-medium text-gray-700">SQL / PL/SQL</label>
                        <button
                          onClick={() => openSqlModal(selectedNodeData.id, selectedNodeData.data?.sql || '', 'SQL/PL/SQL Editor')}
                          className="text-[12px] px-2 py-1 bg-blue-500 text-white rounded hover:bg-blue-600 flex items-center gap-1"
                        >
                          <Maximize2 size={10} />
                          Expand Editor
                        </button>
                      </div>
                      <textarea
                        value={selectedNodeData.data?.sql || ''}
                        onChange={(e) => updateNodeData(selectedNodeData.id, { sql: e.target.value })}
                        className="w-full px-2 py-1.5 text-sm border rounded font-mono text-[12px] leading-relaxed"
                        rows={6}
                        placeholder={'DECLARE\n  v_id VARCHAR2(200) := :myParam;\nBEGIN\n  INSERT INTO my_table (id) VALUES (v_id);\n  COMMIT;\nEND;'}
                      />
                      <p className="text-[12px] text-gray-500 mt-1">
                        Bind variables: <code className="bg-gray-100 px-1">:paramName</code> — values defined in Params below
                      </p>
                    </div>

                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <label className="text-xs font-medium text-gray-700">Bind Params</label>
                        <button
                          onClick={() => {
                            const params = selectedNodeData.data?.params || {};
                            const newKey = `param${Object.keys(params).length + 1}`;
                            updateNodeData(selectedNodeData.id, { params: { ...params, [newKey]: '' } });
                          }}
                          className="text-[12px] px-2 py-1 bg-green-500 text-white rounded hover:bg-green-600 flex items-center gap-1"
                        >
                          <i className="fas fa-plus text-[8px]"></i> Add
                        </button>
                      </div>
                      {Object.entries(selectedNodeData.data?.params || {}).map(([key, value]) => (
                        <div key={key} className="flex gap-1 mb-1 items-center">
                          <input
                            type="text"
                            value={key}
                            onChange={(e) => {
                              const params = { ...selectedNodeData.data?.params };
                              const val = params[key];
                              delete params[key];
                              params[e.target.value] = val;
                              updateNodeData(selectedNodeData.id, { params });
                            }}
                            className="w-1/3 px-2 py-1 text-[12px] border rounded font-mono bg-teal-50"
                            placeholder="name"
                          />
                          <input
                            type="text"
                            value={String(value || '')}
                            onChange={(e) => {
                              const params = { ...selectedNodeData.data?.params };
                              params[key] = e.target.value;
                              updateNodeData(selectedNodeData.id, { params });
                            }}
                            className="flex-1 px-2 py-1 text-[12px] border rounded font-mono"
                            placeholder="{{vars.nodeName.field}}"
                          />
                          <button
                            onClick={() => {
                              const params = { ...selectedNodeData.data?.params };
                              delete params[key];
                              updateNodeData(selectedNodeData.id, { params });
                            }}
                            className="text-red-400 hover:text-red-600 px-1"
                          >
                            <i className="fas fa-times text-[12px]"></i>
                          </button>
                        </div>
                      ))}
                      {Object.keys(selectedNodeData.data?.params || {}).length === 0 && (
                        <p className="text-[12px] text-gray-400 italic">No bind parameters</p>
                      )}
                    </div>
                  </>
                ) : ['select', 'query'].includes(selectedNodeData.data?.operation || 'select') ? (
                  <>
                    {(() => {
                      const sqlVal = selectedNodeData.data?.sql || '';
                      const refMatch = sqlVal.match(/^\{\{(\w[\w-]*)\.(\w+)\}\}$/);
                      if (refMatch) {
                        const sourceNodeId = refMatch[1];
                        const sourceField = refMatch[2];
                        const sourceNode = flow.nodes.find(n => n.id === sourceNodeId);
                        return (
                          <div className="border rounded-lg overflow-hidden">
                            <div className="bg-indigo-50 px-3 py-2 border-b flex items-center justify-between">
                              <div className="flex items-center gap-2">
                                <i className="fas fa-link text-indigo-500 text-xs"></i>
                                <span className="text-xs font-medium text-indigo-700">
                                  SQL from: <code className="bg-indigo-100 px-1.5 py-0.5 rounded">{sourceNode?.data?.label || sourceNodeId}</code>
                                  <span className="text-indigo-400 mx-1">→</span>
                                  <code className="bg-indigo-100 px-1.5 py-0.5 rounded">.{sourceField}</code>
                                </span>
                              </div>
                              {sourceNode?.type === 'transform' && (
                                <button
                                  onClick={() => openSqlModal(sourceNodeId, sourceNode.data?.code || '', 'Code Editor (Read-only)')}
                                  className="text-[12px] px-2 py-1 bg-indigo-500 text-white rounded hover:bg-indigo-600 flex items-center gap-1"
                                >
                                  <Maximize2 size={10} />
                                  View Code
                                </button>
                              )}
                            </div>
                            <div className="px-3 py-2 bg-white">
                              <p className="text-[12px] text-gray-500 mb-1.5">Transform node returns object:</p>
                              <div className="font-mono text-[12px] text-gray-600 bg-gray-50 rounded p-2 border">
                                <div>{'{'}</div>
                                <div className="pl-3"><span className={sourceField === 'sql' ? 'text-indigo-600 font-bold' : ''}>sql</span>: <span className="text-green-600">"BEGIN...END;"</span>,</div>
                                <div className="pl-3">summary: {'{ stgCount, goalCount, mapCount }'},</div>
                                <div className="pl-3">records: {'{ stg[], goal[], map[] }'}</div>
                                <div>{'}'}</div>
                              </div>
                              <input
                                type="text"
                                value={sqlVal}
                                onChange={(e) => updateNodeData(selectedNodeData.id, { sql: e.target.value })}
                                className="w-full mt-2 px-2 py-1 text-[12px] border rounded font-mono text-gray-500"
                              />
                            </div>
                          </div>
                        );
                      }
                      return (
                        <div>
                          <div className="flex items-center justify-between mb-1">
                            <label className="text-xs font-medium text-gray-700">SQL Query</label>
                            <button
                              onClick={() => openSqlModal(selectedNodeData.id, selectedNodeData.data?.sql || '', selectedNodeData.data?.operation === 'query' ? 'PL/SQL Editor' : 'SQL Editor')}
                              className="text-[12px] px-2 py-1 bg-blue-500 text-white rounded hover:bg-blue-600 flex items-center gap-1"
                            >
                              <Maximize2 size={10} />
                              Expand Editor
                            </button>
                          </div>
                          <textarea
                            value={selectedNodeData.data?.sql || ''}
                            onChange={(e) => updateNodeData(selectedNodeData.id, { sql: e.target.value })}
                            className="w-full px-2 py-1.5 text-sm border rounded font-mono text-xs"
                            rows={4}
                            placeholder={selectedNodeData.data?.operation === 'query'
                              ? '-- PL/SQL Block\nBEGIN\n  ...\nEND;'
                              : '-- SQL Query\nSELECT * FROM table_name'}
                          />
                          <p className="text-[12px] text-gray-500 mt-1">
                            Variables: <code className="bg-gray-100 px-1">${'{path.xxx}'}</code> <code className="bg-gray-100 px-1">${'{query.xxx}'}</code> <code className="bg-gray-100 px-1">${'{body.xxx}'}</code> <code className="bg-gray-100 px-1">{'{{nodeId.field}}'}</code>
                          </p>
                        </div>
                      );
                    })()}
                  </>
                ) : selectedNodeData.data?.operation === 'bulk-insert' ? (
                  <>
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">Table Name</label>
                      <input
                        type="text"
                        value={selectedNodeData.data?.table || ''}
                        onChange={(e) => updateNodeData(selectedNodeData.id, { table: e.target.value })}
                        className="w-full px-2 py-1.5 text-sm border rounded font-mono text-xs"
                        placeholder="TARGET_TABLE"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">Data Source Path</label>
                      <input
                        type="text"
                        value={selectedNodeData.data?.dataPath || ''}
                        onChange={(e) => updateNodeData(selectedNodeData.id, { dataPath: e.target.value })}
                        className="w-full px-2 py-1.5 text-sm border rounded font-mono text-xs"
                        placeholder="vars.fileread.data"
                      />
                      <p className="text-[12px] text-gray-500 mt-1">
                        Path to data array. Use <code className="bg-gray-100 px-1">filesPath</code> below for multi-file.
                      </p>
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">Files Path (multi-file)</label>
                      <input
                        type="text"
                        value={selectedNodeData.data?.filesPath || ''}
                        onChange={(e) => updateNodeData(selectedNodeData.id, { filesPath: e.target.value })}
                        className="w-full px-2 py-1.5 text-sm border rounded font-mono text-xs"
                        placeholder="vars.fileread.files"
                      />
                    </div>

                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        id="bulkIdColumn"
                        checked={!!selectedNodeData.data?.idColumn}
                        onChange={(e) => updateNodeData(selectedNodeData.id, {
                          idColumn: e.target.checked ? 'ID' : ''
                        })}
                        className="rounded text-blue-600"
                      />
                      <label htmlFor="bulkIdColumn" className="text-xs text-gray-700">Auto UUID Column</label>
                      {selectedNodeData.data?.idColumn && (
                        <input
                          type="text"
                          value={selectedNodeData.data?.idColumn || 'ID'}
                          onChange={(e) => updateNodeData(selectedNodeData.id, { idColumn: e.target.value })}
                          className="flex-1 px-2 py-1 text-[12px] border rounded font-mono"
                          placeholder="ID column name"
                        />
                      )}
                    </div>

                    {/* Column Mapping: fileColumn → dbColumn */}
                    <div className="border rounded-lg p-2 bg-gray-50">
                      <div className="flex items-center justify-between mb-2">
                        <label className="text-xs font-medium text-gray-700">Column Mapping</label>
                        <button
                          onClick={() => {
                            const current = selectedNodeData.data?.columns || [];
                            const fileCols = selectedNodeData.data?.fileColumns || [];
                            updateNodeData(selectedNodeData.id, {
                              columns: [...current, ''],
                              fileColumns: [...fileCols, ''],
                            });
                          }}
                          className="text-[12px] px-2 py-1 bg-blue-500 text-white rounded hover:bg-blue-600"
                        >
                          <i className="fas fa-plus mr-1"></i>Add
                        </button>
                      </div>

                      <div className="flex gap-1 mb-1 text-[12px] text-gray-500 font-medium">
                        <span className="flex-1">File Column</span>
                        <span className="w-4"></span>
                        <span className="flex-1">DB Column</span>
                        <span className="w-6"></span>
                      </div>

                      {(selectedNodeData.data?.columns || []).map((_: any, index: number) => (
                        <div key={index} className="flex gap-1 mb-1 items-center">
                          <input
                            type="text"
                            value={(selectedNodeData.data?.fileColumns || [])[index] || ''}
                            onChange={(e) => {
                              const fileCols = [...(selectedNodeData.data?.fileColumns || [])];
                              fileCols[index] = e.target.value;
                              updateNodeData(selectedNodeData.id, { fileColumns: fileCols });
                            }}
                            className="flex-1 px-2 py-1 text-[12px] border rounded font-mono"
                            placeholder="file_col"
                          />
                          <i className="fas fa-arrow-right text-[8px] text-gray-400"></i>
                          <input
                            type="text"
                            value={(selectedNodeData.data?.columns || [])[index] || ''}
                            onChange={(e) => {
                              const cols = [...(selectedNodeData.data?.columns || [])];
                              cols[index] = e.target.value;
                              updateNodeData(selectedNodeData.id, { columns: cols });
                            }}
                            className="flex-1 px-2 py-1 text-[12px] border rounded font-mono"
                            placeholder="DB_COL"
                          />
                          <button
                            onClick={() => {
                              const cols = (selectedNodeData.data?.columns || []).filter((_: any, i: number) => i !== index);
                              const fileCols = (selectedNodeData.data?.fileColumns || []).filter((_: any, i: number) => i !== index);
                              updateNodeData(selectedNodeData.id, { columns: cols, fileColumns: fileCols });
                            }}
                            className="px-2 py-1 text-red-500 hover:bg-red-50 rounded text-[12px]"
                          >
                            <i className="fas fa-times"></i>
                          </button>
                        </div>
                      ))}

                      {(selectedNodeData.data?.columns || []).length === 0 && (
                        <p className="text-[12px] text-gray-400 text-center py-1">
                          Map file columns to database columns
                        </p>
                      )}
                    </div>

                    {/* Extra Columns (static values) */}
                    <div className="border rounded-lg p-2 bg-gray-50">
                      <div className="flex items-center justify-between mb-2">
                        <label className="text-xs font-medium text-gray-700">Extra Columns</label>
                        <button
                          onClick={() => {
                            const current = selectedNodeData.data?.extraColumns || [];
                            updateNodeData(selectedNodeData.id, {
                              extraColumns: [...current, { column: '', value: '' }]
                            });
                          }}
                          className="text-[12px] px-2 py-1 bg-green-500 text-white rounded hover:bg-green-600"
                        >
                          <i className="fas fa-plus mr-1"></i>Add
                        </button>
                      </div>

                      {(selectedNodeData.data?.extraColumns || []).map((extra: any, index: number) => (
                        <div key={index} className="flex gap-1 mb-1">
                          <input
                            type="text"
                            value={extra.column}
                            onChange={(e) => {
                              const extras = [...(selectedNodeData.data?.extraColumns || [])];
                              extras[index] = { ...extra, column: e.target.value };
                              updateNodeData(selectedNodeData.id, { extraColumns: extras });
                            }}
                            className="flex-1 px-2 py-1 text-[12px] border rounded font-mono"
                            placeholder="COLUMN"
                          />
                          <span className="text-[12px] text-gray-400 self-center">=</span>
                          <input
                            type="text"
                            value={extra.value}
                            onChange={(e) => {
                              const extras = [...(selectedNodeData.data?.extraColumns || [])];
                              extras[index] = { ...extra, value: e.target.value };
                              updateNodeData(selectedNodeData.id, { extraColumns: extras });
                            }}
                            className="flex-1 px-2 py-1 text-[12px] border rounded font-mono"
                            placeholder="{{value}} or static"
                          />
                          <button
                            onClick={() => {
                              const extras = (selectedNodeData.data?.extraColumns || []).filter((_: any, i: number) => i !== index);
                              updateNodeData(selectedNodeData.id, { extraColumns: extras });
                            }}
                            className="px-2 py-1 text-red-500 hover:bg-red-50 rounded text-[12px]"
                          >
                            <i className="fas fa-times"></i>
                          </button>
                        </div>
                      ))}

                      {(selectedNodeData.data?.extraColumns || []).length === 0 && (
                        <p className="text-[12px] text-gray-400 text-center py-1">
                          Static values added to every row
                        </p>
                      )}
                    </div>

                    {/* Options */}
                    <div className="border-t pt-3 mt-1 space-y-2">
                      <div className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          id="truncateFirst"
                          checked={selectedNodeData.data?.truncateFirst || false}
                          onChange={(e) => updateNodeData(selectedNodeData.id, { truncateFirst: e.target.checked })}
                          className="rounded text-red-600"
                        />
                        <label htmlFor="truncateFirst" className="text-xs text-gray-700">Truncate before insert</label>
                      </div>

                      <div className="flex gap-2">
                        <div className="flex-1">
                          <label className="block text-[12px] text-gray-600 mb-0.5">Batch Size</label>
                          <input
                            type="number"
                            value={selectedNodeData.data?.batchSize || 1000}
                            onChange={(e) => updateNodeData(selectedNodeData.id, { batchSize: parseInt(e.target.value) || 1000 })}
                            className="w-full px-2 py-1 text-[12px] border rounded"
                          />
                        </div>
                        <div className="flex-1">
                          <label className="block text-[12px] text-gray-600 mb-0.5">Skip Rows</label>
                          <input
                            type="number"
                            value={selectedNodeData.data?.skipRows || 0}
                            onChange={(e) => updateNodeData(selectedNodeData.id, { skipRows: parseInt(e.target.value) || 0 })}
                            className="w-full px-2 py-1 text-[12px] border rounded"
                          />
                        </div>
                      </div>
                    </div>
                  </>
                ) : (
                  <>
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">Table Name</label>
                      <input
                        type="text"
                        value={selectedNodeData.data?.table || ''}
                        onChange={(e) => updateNodeData(selectedNodeData.id, { table: e.target.value })}
                        className="w-full px-2 py-1.5 text-sm border rounded font-mono text-xs"
                        placeholder="users, orders, imported_data"
                      />
                    </div>
                    
                    <div className="border rounded-lg p-2 bg-gray-50">
                      <div className="flex items-center justify-between mb-2">
                        <label className="text-xs font-medium text-gray-700">Column Mapping</label>
                        <button
                          onClick={() => {
                            const current = selectedNodeData.data?.columnMapping || [];
                            updateNodeData(selectedNodeData.id, {
                              columnMapping: [...current, { column: '', value: '' }]
                            });
                          }}
                          className="text-[12px] px-2 py-1 bg-blue-500 text-white rounded hover:bg-blue-600"
                        >
                          <i className="fas fa-plus mr-1"></i>Add
                        </button>
                      </div>
                      
                      {(selectedNodeData.data?.columnMapping || []).map((mapping: any, index: number) => (
                        <div key={index} className="flex gap-1 mb-1">
                          <input
                            type="text"
                            value={mapping.column}
                            onChange={(e) => {
                              const newMapping = [...(selectedNodeData.data?.columnMapping || [])];
                              newMapping[index] = { ...mapping, column: e.target.value };
                              updateNodeData(selectedNodeData.id, { columnMapping: newMapping });
                            }}
                            className="flex-1 px-2 py-1 text-[12px] border rounded"
                            placeholder="Column"
                          />
                          <input
                            type="text"
                            value={mapping.value}
                            onChange={(e) => {
                              const newMapping = [...(selectedNodeData.data?.columnMapping || [])];
                              newMapping[index] = { ...mapping, value: e.target.value };
                              updateNodeData(selectedNodeData.id, { columnMapping: newMapping });
                            }}
                            className="flex-1 px-2 py-1 text-[12px] border rounded font-mono"
                            placeholder="{{input.field}}"
                          />
                          <button
                            onClick={() => {
                              const newMapping = (selectedNodeData.data?.columnMapping || []).filter((_: any, i: number) => i !== index);
                              updateNodeData(selectedNodeData.id, { columnMapping: newMapping });
                            }}
                            className="px-2 py-1 text-red-500 hover:bg-red-50 rounded text-[12px]"
                          >
                            <i className="fas fa-times"></i>
                          </button>
                        </div>
                      ))}
                      
                      {(selectedNodeData.data?.columnMapping || []).length === 0 && (
                        <p className="text-[12px] text-gray-400 text-center py-1">
                          Click "Add" to map columns
                        </p>
                      )}
                    </div>

                    {(selectedNodeData.data?.operation === 'update' || selectedNodeData.data?.operation === 'delete') && (
                      <div>
                        <label className="block text-xs font-medium text-gray-700 mb-1">WHERE Clause</label>
                        <input
                          type="text"
                          value={selectedNodeData.data?.whereClause || ''}
                          onChange={(e) => updateNodeData(selectedNodeData.id, { whereClause: e.target.value })}
                          className="w-full px-2 py-1.5 text-sm border rounded font-mono text-xs"
                          placeholder="id = {{input.id}}"
                        />
                        {selectedNodeData.data?.operation === 'delete' && (
                          <p className="text-[12px] text-red-500 mt-1">
                            <i className="fas fa-exclamation-triangle mr-1"></i>
                            Without WHERE, all rows deleted!
                          </p>
                        )}
                      </div>
                    )}
                  </>
                )}
              </>
            )}

            {/* API Input config */}
            {selectedNodeData.type === 'api-input' && (
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Extract Parameters</label>
                <textarea
                  value={selectedNodeData.data?.extract || ''}
                  onChange={(e) => updateNodeData(selectedNodeData.id, { extract: e.target.value })}
                  className="w-full px-2 py-1.5 text-sm border rounded font-mono text-xs"
                  rows={3}
                  placeholder="body.name, query.page, params.id"
                />
              </div>
            )}

            {/* API Output config */}
            {selectedNodeData.type === 'api-output' && (
              <div className="space-y-3">
                {/* Response Type */}
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Response Type</label>
                  <select
                    value={selectedNodeData.data?.responseType || 'object'}
                    onChange={(e) => updateNodeData(selectedNodeData.id, { 
                      responseType: e.target.value as any,
                      autoTransform: e.target.value === 'array' ? true : selectedNodeData.data?.autoTransform
                    })}
                    className="w-full px-2 py-1.5 text-sm border rounded"
                  >
                    <option value="object">Object {'{}'}</option>
                    <option value="array">Array []</option>
                    <option value="string">String</option>
                    <option value="number">Number</option>
                    <option value="boolean">Boolean</option>
                  </select>
                </div>

                {/* API Spec Schema Transform Toggle */}
                <div className="flex items-center gap-2 p-2 bg-green-50 rounded border border-green-100">
                  <input
                    type="checkbox"
                    id="useApiSpecSchema"
                    checked={selectedNodeData.data?.useApiSpecSchema !== false}
                    onChange={(e) => updateNodeData(selectedNodeData.id, { 
                      useApiSpecSchema: e.target.checked,
                      autoTransform: !e.target.checked // Disable auto transform when using schema
                    })}
                    className="w-4 h-4 text-green-600 rounded focus:ring-green-500"
                  />
                  <label htmlFor="useApiSpecSchema" className="text-xs font-medium text-green-900 cursor-pointer flex-1">
                    Use API Spec Schema
                  </label>
                </div>

                {/* Auto Transform Toggle (only when not using API Spec) */}
                {selectedNodeData.data?.useApiSpecSchema === false && (
                  <div className="flex items-center gap-2 p-2 bg-blue-50 rounded border border-blue-100">
                    <input
                      type="checkbox"
                      id="autoTransform"
                      checked={selectedNodeData.data?.autoTransform || false}
                      onChange={(e) => updateNodeData(selectedNodeData.id, { autoTransform: e.target.checked })}
                      className="w-4 h-4 text-blue-600 rounded focus:ring-blue-500"
                    />
                    <label htmlFor="autoTransform" className="text-xs font-medium text-blue-900 cursor-pointer flex-1">
                      Auto Transform from Database
                    </label>
                  </div>
                )}

                {/* Field Mappings (when auto transform enabled) */}
                {selectedNodeData.data?.autoTransform && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <label className="block text-xs font-medium text-gray-700">Field Mappings</label>
                      <button
                        onClick={() => {
                          const mappings = selectedNodeData.data?.fieldMappings || [];
                          updateNodeData(selectedNodeData.id, {
                            fieldMappings: [...mappings, { source: '', target: '', transform: '' }]
                          });
                        }}
                        className="text-xs text-blue-600 hover:text-blue-700 flex items-center gap-1"
                      >
                        <i className="fas fa-plus"></i> Add
                      </button>
                    </div>
                    
                    {(selectedNodeData.data?.fieldMappings || []).map((mapping: any, index: number) => (
                      <div key={index} className="flex gap-2 items-start p-2 bg-gray-50 rounded">
                        <div className="flex-1 space-y-1">
                          <input
                            type="text"
                            placeholder="Source (e.g., rows, rows[0].name)"
                            value={mapping.source}
                            onChange={(e) => {
                              const mappings = [...(selectedNodeData.data?.fieldMappings || [])];
                              mappings[index] = { ...mapping, source: e.target.value };
                              updateNodeData(selectedNodeData.id, { fieldMappings: mappings });
                            }}
                            className="w-full px-2 py-1 text-xs border rounded font-mono"
                          />
                          <div className="flex gap-1">
                            <input
                              type="text"
                              placeholder="Target field"
                              value={mapping.target}
                              onChange={(e) => {
                                const mappings = [...(selectedNodeData.data?.fieldMappings || [])];
                                mappings[index] = { ...mapping, target: e.target.value };
                                updateNodeData(selectedNodeData.id, { fieldMappings: mappings });
                              }}
                              className="flex-1 px-2 py-1 text-xs border rounded"
                            />
                            <select
                              value={mapping.transform || ''}
                              onChange={(e) => {
                                const mappings = [...(selectedNodeData.data?.fieldMappings || [])];
                                mappings[index] = { ...mapping, transform: e.target.value };
                                updateNodeData(selectedNodeData.id, { fieldMappings: mappings });
                              }}
                              className="px-2 py-1 text-xs border rounded w-24"
                            >
                              <option value="">-</option>
                              <option value="string">string</option>
                              <option value="number">number</option>
                              <option value="boolean">boolean</option>
                              <option value="date">date</option>
                              <option value="array">array</option>
                            </select>
                          </div>
                        </div>
                        <button
                          onClick={() => {
                            const mappings = (selectedNodeData.data?.fieldMappings || []).filter((_: any, i: number) => i !== index);
                            updateNodeData(selectedNodeData.id, { fieldMappings: mappings });
                          }}
                          className="text-red-500 hover:text-red-700 p-1"
                        >
                          <i className="fas fa-trash text-xs"></i>
                        </button>
                      </div>
                    ))}

                    {/* Quick Presets */}
                    {(selectedNodeData.data?.fieldMappings || []).length === 0 && (
                      <div className="flex flex-wrap gap-1">
                        <button
                          onClick={() => updateNodeData(selectedNodeData.id, { 
                            fieldMappings: [{ source: 'rows', target: 'data', transform: '' }],
                            wrapInDataKey: true,
                            responseType: 'array'
                          })}
                          className="inline-flex items-center justify-center text-[13px] px-2 h-8 bg-gray-100 hover:bg-gray-200 rounded whitespace-nowrap"
                        >
                          Preset: Database Rows
                        </button>
                        <button
                          onClick={() => updateNodeData(selectedNodeData.id, { 
                            fieldMappings: [{ source: 'rows[0]', target: 'data', transform: '' }],
                            wrapInDataKey: true,
                            responseType: 'object'
                          })}
                          className="inline-flex items-center justify-center text-[13px] px-2 h-8 bg-gray-100 hover:bg-gray-200 rounded whitespace-nowrap"
                        >
                          Preset: Single Row
                        </button>
                        <button
                          onClick={() => updateNodeData(selectedNodeData.id, { 
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



                {/* Output Options */}
                <div className="flex flex-wrap gap-3 pt-2 border-t">
                  <label className="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={selectedNodeData.data?.wrapInDataKey || false}
                      onChange={(e) => updateNodeData(selectedNodeData.id, { wrapInDataKey: e.target.checked })}
                      className="rounded text-blue-600"
                    />
                    Wrap in {'{'}data:{'}'}
                  </label>
                  <label className="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={selectedNodeData.data?.includeMetadata || false}
                      onChange={(e) => updateNodeData(selectedNodeData.id, { includeMetadata: e.target.checked })}
                      className="rounded text-blue-600"
                    />
                    Include _meta
                  </label>
                </div>

                {/* Status Code */}
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Status Code</label>
                  <select
                    value={selectedNodeData.data?.statusCode || 200}
                    onChange={(e) => updateNodeData(selectedNodeData.id, { statusCode: parseInt(e.target.value) })}
                    className="w-full px-2 py-1.5 text-sm border rounded"
                  >
                    <option value={200}>200 OK</option>
                    <option value={201}>201 Created</option>
                    <option value={204}>204 No Content</option>
                    <option value={400}>400 Bad Request</option>
                    <option value={401}>401 Unauthorized</option>
                    <option value={403}>403 Forbidden</option>
                    <option value={404}>404 Not Found</option>
                    <option value={500}>500 Server Error</option>
                  </select>
                </div>

                {/* Legacy Mode Toggle */}
                <details className="text-xs">
                  <summary className="cursor-pointer text-gray-500 hover:text-gray-700">
                    Legacy: JavaScript Mapping
                  </summary>
                  <div className="mt-2">
                    <textarea
                      value={selectedNodeData.data?.mapping || ''}
                      onChange={(e) => updateNodeData(selectedNodeData.id, { mapping: e.target.value })}
                      className="w-full px-2 py-1.5 text-sm border rounded font-mono text-xs"
                      rows={3}
                      placeholder="{ data: input.rows }"
                    />
                  </div>
                </details>
              </div>
            )}

            {/* Transform config */}
            {selectedNodeData.type === 'transform' && (
              <>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Mode</label>
                  <MiniDropdown
                    value={selectedNodeData.data?.mode || 'javascript'}
                    onChange={(value) => updateNodeData(selectedNodeData.id, { mode: value })}
                    options={[
                      { value: 'javascript', label: 'JavaScript', icon: 'fa-code', color: 'text-amber-500' },
                      { value: 'mapping', label: 'Field Mapping', icon: 'fa-exchange-alt', color: 'text-blue-500' },
                    ]}
                  />
                </div>
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-xs font-medium text-gray-700">
                      Code Editor
                    </label>
                    <button
                      onClick={() => openSqlModal(selectedNodeData.id, selectedNodeData.data?.code || '', 'Code Editor')}
                      className="text-[12px] px-2 py-1 bg-blue-500 text-white rounded hover:bg-blue-600 flex items-center gap-1"
                    >
                      <Maximize2 size={10} />
                      Expand Editor
                    </button>
                  </div>
                  <textarea
                    value={selectedNodeData.data?.code || ''}
                    onChange={(e) => updateNodeData(selectedNodeData.id, { code: e.target.value })}
                    className="w-full px-2 py-1.5 text-sm border rounded font-mono text-[12px] leading-relaxed"
                    rows={12}
                    placeholder={selectedNodeData.data?.mode === 'mapping'
                      ? '{"targetField": "input.sourceField"}'
                      : '// input = previous node output\n// vars = trigger parameters\n// return transformed data\nconst result = input;\nreturn result;'}
                  />
                  <p className="text-[12px] text-gray-500 mt-1">
                    Access: <code className="bg-gray-100 px-1">input</code> (prev node), <code className="bg-gray-100 px-1">vars</code> (parameters), <code className="bg-gray-100 px-1">context</code>
                  </p>
                </div>
              </>
            )}

            {/* Condition config */}
            {selectedNodeData.type === 'condition' && (
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Condition</label>
                <textarea
                  value={selectedNodeData.data?.condition || ''}
                  onChange={(e) => updateNodeData(selectedNodeData.id, { condition: e.target.value })}
                  className="w-full px-2 py-1.5 text-sm border rounded font-mono text-xs resize-y"
                  rows={3}
                  placeholder="e.g., input.status === 'active'"
                />
                <p className="text-[12px] text-gray-500 mt-1">
                  Use double curly braces for variables. Support &&, ||, ! operators.
                </p>
              </div>
            )}


            {/* Basket Trigger config */}
            {selectedNodeData.type === 'basket-trigger' && (
              <>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">
                    <i className="fas fa-folder-open text-amber-500 mr-1"></i>
                    Basket
                  </label>
                  <select
                    value={selectedNodeData.data?.basketId || ''}
                    onChange={(e) => {
                      const selectedBasket = baskets.find(b => b.id === e.target.value);
                      updateNodeData(selectedNodeData.id, { 
                        basketId: e.target.value,
                        basketName: selectedBasket?.name || '',
                        basketType: selectedBasket?.type || ''
                      });
                    }}
                    className="w-full px-2 py-1.5 text-sm border rounded focus:ring-2 focus:ring-blue-500 outline-none"
                  >
                    <option value="">Select basket...</option>
                    {baskets.map(b => (
                      <option key={b.id} value={b.id}>{b.name} ({b.type}){b.isShared ? ' - Shared' : ''}</option>
                    ))}
                  </select>
                  {baskets.length === 0 && (
                    <p className="text-[12px] text-amber-600 mt-1">
                      <i className="fas fa-exclamation-triangle mr-1"></i>
                      No baskets found. Create a basket first.
                    </p>
                  )}
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">
                    Trigger On Session Status
                    <span className="text-[12px] text-amber-600 ml-1">(Session, not File)</span>
                  </label>
                  <MiniDropdown
                    value={selectedNodeData.data?.triggerOn || 'published'}
                    onChange={(value) => updateNodeData(selectedNodeData.id, { triggerOn: value })}
                    options={[
                      { value: 'open', label: 'Open (Collecting files)', icon: 'fa-folder-open', color: 'text-gray-400' },
                      { value: 'published', label: 'Published (Ready)', icon: 'fa-check-circle', color: 'text-green-500' },
                      { value: 'processing', label: 'Processing', icon: 'fa-spinner', color: 'text-blue-500' },
                      { value: 'completed', label: 'Completed', icon: 'fa-check-double', color: 'text-purple-500' },
                      { value: 'archived', label: 'Archived', icon: 'fa-archive', color: 'text-gray-600' },
                    ]}
                  />
                  <p className="text-[12px] text-gray-500 mt-1">
                    Trigger when session status matches. Recommended: <b>Published</b>
                  </p>
                  <p className="text-[12px] text-amber-600 mt-1">
                    <i className="fas fa-info-circle mr-1"></i>
                    Auto-updates to "Processing" after trigger to prevent duplicates
                  </p>
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">
                    Manual Run: pick files from sessions that are
                  </label>
                  {(() => {
                    // Unset = the old rule (published first, else open / processing),
                    // shown as those three ticked; the first click makes the list explicit.
                    const picked: string[] = selectedNodeData.data?.runOnStatuses ?? ['open', 'published', 'processing'];
                    const toggle = (status: string, on: boolean) => {
                      const next = on ? [...picked.filter(s => s !== status), status] : picked.filter(s => s !== status);
                      updateNodeData(selectedNodeData.id, { runOnStatuses: next });
                    };
                    return (
                      <>
                        <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                          {[
                            { value: 'open', label: 'Open (not published)' },
                            { value: 'published', label: 'Published' },
                            { value: 'processing', label: 'Processing' },
                            { value: 'completed', label: 'Completed' },
                            { value: 'error', label: 'Error (retry)' },
                          ].map(o => (
                            <label key={o.value} className="flex items-center gap-1.5 text-xs text-gray-700">
                              <input
                                type="checkbox"
                                checked={picked.includes(o.value)}
                                onChange={e => toggle(o.value, e.target.checked)}
                                className="rounded text-blue-600"
                              />
                              {o.label}
                            </label>
                          ))}
                        </div>
                        <p className="text-[12px] text-gray-500 mt-1">
                          Used when you press Run without publishing. A Publish still runs on that session only.
                        </p>
                        {picked.includes('completed') && (
                          <p className="text-[12px] text-amber-600 mt-1">
                            <i className="fas fa-exclamation-triangle mr-1"></i>
                            Completed sessions were processed before — their files will be imported again.
                          </p>
                        )}
                      </>
                    );
                  })()}
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">File Pattern</label>
                  <input
                    type="text"
                    value={selectedNodeData.data?.filePattern || '*'}
                    onChange={(e) => updateNodeData(selectedNodeData.id, { filePattern: e.target.value })}
                    className="w-full px-2 py-1.5 text-sm border rounded text-xs"
                    placeholder="*"
                  />
                  <p className="text-[12px] text-gray-500 mt-1">e.g., *.csv, data_*.txt</p>
                </div>

                <div className="border-t pt-3 mt-3">
                  <label className="block text-xs font-medium text-gray-700 mb-1">Options</label>
                  
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        id="autoProcess"
                        checked={selectedNodeData.data?.options?.autoProcess !== false}
                        onChange={(e) => updateNodeData(selectedNodeData.id, { 
                          options: { ...selectedNodeData.data?.options, autoProcess: e.target.checked }
                        })}
                        className="rounded text-blue-600"
                      />
                      <label htmlFor="autoProcess" className="text-xs text-gray-700">Auto-process on trigger</label>
                    </div>
                    
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        id="archiveAfterTransfer"
                        checked={selectedNodeData.data?.options?.archiveAfterTransfer === true}
                        onChange={(e) => updateNodeData(selectedNodeData.id, { 
                          options: { ...selectedNodeData.data?.options, archiveAfterTransfer: e.target.checked }
                        })}
                        className="rounded text-amber-600"
                      />
                      <label htmlFor="archiveAfterTransfer" className="text-xs text-gray-700">Archive after processing</label>
                    </div>
                  </div>
                </div>
              </>
            )}

            {/* Basket Action config */}
            {selectedNodeData.type === 'basket-action' && (
              <>
                {/* Operation */}
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">
                    <i className="fas fa-cog text-amber-600 mr-1"></i>
                    Operation
                  </label>
                  <MiniDropdown
                    value={selectedNodeData.data?.operation || 'copy'}
                    onChange={(value) => updateNodeData(selectedNodeData.id, { operation: value })}
                    options={[
                      { value: 'copy', label: 'Copy Files', icon: 'fa-copy', color: 'text-blue-500' },
                      { value: 'zip', label: 'ZIP Files', icon: 'fa-file-archive', color: 'text-purple-500' },
                      { value: 'copy-and-zip', label: 'Copy + ZIP', icon: 'fa-archive', color: 'text-amber-600' },
                      { value: 'extract', label: 'Extract / Unzip → Basket', icon: 'fa-file-zipper', color: 'text-emerald-600' },
                    ]}
                  />
                </div>

                {selectedNodeData.data?.operation === 'extract' ? (
                  <>
                    {/* Source File (from a previous node, e.g. an HTTP download) */}
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">
                        <i className="fas fa-file-zipper text-emerald-600 mr-1"></i>
                        Source File (.zip)
                      </label>
                      <input
                        type="text"
                        value={selectedNodeData.data?.sourceFilePath || ''}
                        onChange={(e) => updateNodeData(selectedNodeData.id, { sourceFilePath: e.target.value })}
                        className="w-full px-2 py-1.5 text-sm border rounded text-xs"
                        placeholder="{{dl.localPath}}"
                      />
                      <p className="text-[12px] text-gray-500 mt-1">
                        ไฟล์จาก node ก่อนหน้า เช่น <code className="bg-gray-100 px-1 rounded">{'{{dl.localPath}}'}</code> (HTTP Request download)
                      </p>
                    </div>

                    {/* Auto-create session (batch baskets) */}
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        id="ba-autoCreateSession"
                        checked={selectedNodeData.data?.autoCreateSession !== false}
                        onChange={(e) => updateNodeData(selectedNodeData.id, { autoCreateSession: e.target.checked })}
                      />
                      <label htmlFor="ba-autoCreateSession" className="text-xs text-gray-700">
                        สร้าง session อัตโนมัติ (batch basket จะได้โชว์ไฟล์)
                      </label>
                    </div>

                    {/* Session mode (when auto-session on) */}
                    {selectedNodeData.data?.autoCreateSession !== false && (
                      <div>
                        <label className="block text-xs font-medium text-gray-700 mb-1">
                          <i className="fas fa-layer-group text-emerald-600 mr-1"></i>
                          Session mode
                        </label>
                        <select
                          value={selectedNodeData.data?.sessionMode || 'existing_or_new'}
                          onChange={(e) => updateNodeData(selectedNodeData.id, { sessionMode: e.target.value })}
                          className="w-full px-2 py-1.5 text-sm border rounded focus:ring-2 focus:ring-blue-500 outline-none"
                        >
                          <option value="always_new">สร้าง session ใหม่ทุกครั้ง (always new)</option>
                          <option value="existing_or_new">ใช้ session ที่เปิดอยู่ หรือสร้างใหม่</option>
                          <option value="reuse_existing">ใช้ session ที่เปิดอยู่เท่านั้น</option>
                        </select>
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    {/* Source Basket */}
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">
                        <i className="fas fa-folder-open text-amber-500 mr-1"></i>
                        Source Basket
                      </label>
                      <select
                        value={selectedNodeData.data?.sourceBasketId || ''}
                        onChange={(e) => {
                          const selectedBasket = baskets.find(b => b.id === e.target.value);
                          updateNodeData(selectedNodeData.id, {
                            sourceBasketId: e.target.value,
                            sourceBasketName: selectedBasket?.name || ''
                          });
                        }}
                        className="w-full px-2 py-1.5 text-sm border rounded focus:ring-2 focus:ring-blue-500 outline-none"
                      >
                        <option value="">Select source basket...</option>
                        {baskets.map(b => (
                          <option key={b.id} value={b.id}>{b.name} ({b.type})</option>
                        ))}
                      </select>
                    </div>

                    {/* File Pattern */}
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">
                        <i className="fas fa-filter text-gray-400 mr-1"></i>
                        File Pattern
                      </label>
                      <input
                        type="text"
                        value={selectedNodeData.data?.filePattern || '*'}
                        onChange={(e) => updateNodeData(selectedNodeData.id, { filePattern: e.target.value })}
                        className="w-full px-2 py-1.5 text-sm border rounded text-xs"
                        placeholder="*"
                      />
                      <p className="text-[12px] text-gray-500 mt-1">e.g., *.csv, *.pdf, data_*.txt</p>
                    </div>
                  </>
                )}

                {/* Destination Basket */}
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">
                    <i className="fas fa-folder text-green-500 mr-1"></i>
                    Destination Basket
                  </label>
                  <select
                    value={selectedNodeData.data?.destinationBasketId || ''}
                    onChange={(e) => {
                      const selectedBasket = baskets.find(b => b.id === e.target.value);
                      updateNodeData(selectedNodeData.id, {
                        destinationBasketId: e.target.value,
                        destinationBasketName: selectedBasket?.name || ''
                      });
                    }}
                    className="w-full px-2 py-1.5 text-sm border rounded focus:ring-2 focus:ring-blue-500 outline-none"
                  >
                    <option value="">Select destination basket...</option>
                    {baskets.map(b => (
                      <option key={b.id} value={b.id}>{b.name} ({b.type})</option>
                    ))}
                  </select>
                </div>

                {/* Target Folder (not used for extract) */}
                {selectedNodeData.data?.operation !== 'extract' && (
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">
                    <i className="fas fa-folder-plus text-amber-500 mr-1"></i>
                    Target Folder
                  </label>
                  <input
                    type="text"
                    value={selectedNodeData.data?.targetFolder || ''}
                    onChange={(e) => updateNodeData(selectedNodeData.id, { targetFolder: e.target.value })}
                    className="w-full px-2 py-1.5 text-sm border rounded text-xs"
                    placeholder="e.g., {BYYYY}/{MM}"
                  />
                  <p className="text-[12px] text-gray-500 mt-1">
                    Placeholders: <code className="bg-gray-100 px-1 rounded">{'{BYYYY}'}</code> พ.ศ.,
                    <code className="bg-gray-100 px-1 rounded ml-1">{'{YYYY}'}</code> ค.ศ.,
                    <code className="bg-gray-100 px-1 rounded ml-1">{'{MM}'}</code> เดือน,
                    <code className="bg-gray-100 px-1 rounded ml-1">{'{DD}'}</code> วัน
                  </p>
                </div>
                )}

                {/* ZIP Options - only show when operation includes zip */}
                {(selectedNodeData.data?.operation === 'zip' || selectedNodeData.data?.operation === 'copy-and-zip') && (
                  <div className="border-t pt-3 mt-3">
                    <label className="block text-xs font-medium text-gray-700 mb-2">
                      <i className="fas fa-file-archive text-purple-500 mr-1"></i>
                      ZIP Options
                    </label>
                    <div className="space-y-2">
                      <div>
                        <label className="block text-[12px] text-gray-500 mb-1">ZIP File Name</label>
                        <input
                          type="text"
                          value={selectedNodeData.data?.zipFileName || ''}
                          onChange={(e) => updateNodeData(selectedNodeData.id, { zipFileName: e.target.value })}
                          className="w-full px-2 py-1.5 text-sm border rounded text-xs"
                          placeholder="archive_{{date}}.zip"
                        />
                        <p className="text-[12px] text-gray-500 mt-1">
                          <code className="bg-gray-100 px-1 rounded">{'{'}{'{'}</code>date, timestamp, year, buddhistYear<code className="bg-gray-100 px-1 rounded">{'}'}{'}' }</code>
                        </p>
                      </div>
                      <div>
                        <label className="block text-[12px] text-gray-500 mb-1">Compression Level (0-9)</label>
                        <input
                          type="number"
                          min={0}
                          max={9}
                          value={selectedNodeData.data?.compressionLevel ?? 6}
                          onChange={(e) => updateNodeData(selectedNodeData.id, { compressionLevel: parseInt(e.target.value) || 6 })}
                          className="w-20 px-2 py-1.5 text-sm border rounded text-xs"
                        />
                      </div>
                    </div>
                  </div>
                )}

                {/* Options */}
                <div className="border-t pt-3 mt-3">
                  <label className="block text-xs font-medium text-gray-700 mb-2">Options</label>
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        id="ba-overwrite"
                        checked={selectedNodeData.data?.overwrite !== false}
                        onChange={(e) => updateNodeData(selectedNodeData.id, { overwrite: e.target.checked })}
                        className="rounded text-amber-600"
                      />
                      <label htmlFor="ba-overwrite" className="text-xs text-gray-700">
                        <i className="fas fa-sync-alt text-blue-400 mr-1"></i>
                        Overwrite existing files
                      </label>
                    </div>
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        id="ba-deleteSource"
                        checked={selectedNodeData.data?.deleteSource || false}
                        onChange={(e) => updateNodeData(selectedNodeData.id, { deleteSource: e.target.checked })}
                        className="rounded text-red-500"
                      />
                      <label htmlFor="ba-deleteSource" className="text-xs text-gray-700">
                        <i className="fas fa-trash-alt text-red-400 mr-1"></i>
                        Delete source files after operation
                      </label>
                    </div>
                  </div>
                </div>

                {/* File Status Filter */}
                <div className="border-t pt-3 mt-3">
                  <label className="block text-xs font-medium text-gray-700 mb-1">
                    <i className="fas fa-filter text-gray-400 mr-1"></i>
                    Source File Status Filter
                  </label>
                  <MiniDropdown
                    value={selectedNodeData.data?.fileStatus || 'all'}
                    onChange={(value) => updateNodeData(selectedNodeData.id, { fileStatus: value })}
                    options={[
                      { value: 'all', label: 'All Files', icon: 'fa-asterisk', color: 'text-gray-400' },
                      { value: 'uploaded', label: 'Uploaded', icon: 'fa-upload', color: 'text-blue-500' },
                      { value: 'transferred', label: 'Transferred', icon: 'fa-exchange-alt', color: 'text-green-500' },
                      { value: 'pending', label: 'Pending', icon: 'fa-clock', color: 'text-yellow-500' },
                    ]}
                  />
                </div>
              </>
            )}

            {/* SFTP Action config */}
            {selectedNodeData.type === 'sftp-action' && (() => {
              const d = selectedNodeData.data || {};
              const set = (patch: Record<string, unknown>) => updateNodeData(selectedNodeData.id, patch);
              const op = d.operation === 'download-new-folders' ? 'download' : (d.operation || 'upload');
              const isUpload = op === 'upload';
              const isNewFolders = d.operation === 'download-new-folders' || (op === 'download' && d.newFoldersOnly === true);
              const inputCls = 'w-full px-2 py-1.5 text-xs border rounded focus:ring-2 focus:ring-blue-500 outline-none';
              const labelCls = 'block text-xs font-medium text-gray-700 mb-1';
              const hintCls = 'text-[12px] text-gray-500 mt-1 leading-snug';
              const section = (title: string, icon: string) => (
                <div className="border-t pt-3 mt-1 flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wide text-gray-500">
                  <i className={`fas ${icon} text-gray-400`}></i>{title}
                </div>
              );
              return (
                <>
                  {/* ── Connection ── */}
                  <div>
                    <label className={labelCls}>SFTP Connection</label>
                    <MiniDropdown
                      value={d.connectionId || ''}
                      onChange={(value) => set({ connectionId: value })}
                      options={[
                        { value: '', label: 'Select connection...', icon: 'fa-server', color: 'text-gray-400' },
                        ...connections.filter(c => c.type === 'sftp').map(conn => ({
                          value: conn.id, label: conn.name, icon: 'fa-server', color: 'text-teal-500',
                        })),
                      ]}
                    />
                  </div>
                  <div>
                    <label className={labelCls}>Operation</label>
                    <MiniDropdown
                      value={op}
                      onChange={(value) => set({ operation: value })}
                      options={[
                        { value: 'upload', label: 'Upload to SFTP', icon: 'fa-upload', color: 'text-green-500' },
                        { value: 'download', label: 'Download from SFTP', icon: 'fa-download', color: 'text-blue-500' },
                      ]}
                    />
                  </div>

                  {/* ── Remote side ── */}
                  {section('Remote (SFTP)', 'fa-server')}
                  <div>
                    <label className={labelCls}>{isNewFolders ? 'Remote parent folder' : 'Remote Path'}</label>
                    <input type="text" value={d.remotePath ?? ''} onChange={(e) => set({ remotePath: e.target.value })} className={`${inputCls} font-mono`}
                      placeholder={isNewFolders ? '/inbox/DATA' : '(connection base path)'} />
                    {isNewFolders && <p className={hintCls}>The folder that holds one subfolder per delivery.</p>}
                  </div>
                  <div>
                    <label className={labelCls}>File Pattern</label>
                    <input type="text" value={d.filePattern || '*.*'} onChange={(e) => set({ filePattern: e.target.value })} className={`${inputCls} font-mono`} placeholder="*.*" />
                    <p className={hintCls}>e.g. *.csv, EXPORT_*.txt</p>
                  </div>
                  {isUpload && (
                    <div>
                      <label className={labelCls}>Remote File Name</label>
                      <input type="text" value={d.remoteFileName ?? ''} onChange={(e) => set({ remoteFileName: e.target.value })} className={`${inputCls} font-mono`} placeholder="{{original}}" />
                      <p className={hintCls}>{'{' + '{original}'} = original name, {'{' + '{date}'} = YYYY-MM-DD, {'{' + '{timestamp}'} = unix time</p>
                    </div>
                  )}

                  {/* ── Basket ── */}
                  {section('Basket', 'fa-folder-open')}
                  <div>
                    <label className={labelCls}>{isUpload ? 'Source Basket' : 'Destination Basket'}</label>
                    <select value={d.basketId || ''} onChange={(e) => set({ basketId: e.target.value })} className={inputCls}>
                      <option value="">Select basket...</option>
                      {baskets.map(b => <option key={b.id} value={b.id}>{b.name} ({b.type})</option>)}
                    </select>
                  </div>
                  {isUpload && (
                    <div>
                      <label className={labelCls}>File Status <span className="text-[12px] text-blue-600 ml-1">(file, not session)</span></label>
                      <MiniDropdown
                        value={d.fileStatus || 'published'}
                        onChange={(value) => set({ fileStatus: value })}
                        options={[
                          { value: 'ready', label: 'Not yet sent (pending + uploaded + published)', icon: 'fa-paper-plane', color: 'text-green-600' },
                          { value: 'all', label: 'All files', icon: 'fa-files', color: 'text-blue-500' },
                          { value: 'pending', label: 'Pending', icon: 'fa-clock', color: 'text-gray-400' },
                          { value: 'uploaded', label: 'Uploaded', icon: 'fa-upload', color: 'text-amber-500' },
                          { value: 'published', label: 'Published (Ready)', icon: 'fa-check-circle', color: 'text-green-500' },
                          { value: 'processing', label: 'Processing', icon: 'fa-spinner', color: 'text-blue-500' },
                          { value: 'transferred', label: 'Transferred', icon: 'fa-exchange-alt', color: 'text-purple-500' },
                          { value: 'archived', label: 'Archived', icon: 'fa-archive', color: 'text-gray-600' },
                          { value: 'failed', label: 'Failed', icon: 'fa-exclamation-triangle', color: 'text-red-500' },
                        ]}
                      />
                      <p className={hintCls}>Only send files with this status. Files uploaded on the web page are <b>Pending</b>, files a flow writes are <b>Uploaded</b>; <b>Not yet sent</b> covers both.</p>
                    </div>
                  )}
                  {!isUpload && !isNewFolders && (
                    <div>
                      <label className={labelCls}>Session Mode</label>
                      <MiniDropdown
                        value={d.autoCreateSession === false ? 'none' : (d.sessionMode || 'existing_or_new')}
                        onChange={(value) => value === 'none'
                          ? set({ autoCreateSession: false, sessionMode: undefined })
                          : set({ autoCreateSession: true, sessionMode: value })}
                        options={[
                          { value: 'existing_or_new', label: 'Use Existing or New', icon: 'fa-folder-open', color: 'text-green-500' },
                          { value: 'always_new', label: 'Always Create New', icon: 'fa-plus', color: 'text-blue-500' },
                          { value: 'reuse_existing', label: 'Reuse Existing Only', icon: 'fa-link', color: 'text-purple-500' },
                          { value: 'none', label: 'No session (folder mode)', icon: 'fa-folder', color: 'text-gray-500' },
                        ]}
                      />
                    </div>
                  )}
                  {isNewFolders && <p className={hintCls}>One session per remote folder, named after it.</p>}

                  {/* ── New folders (download) ── */}
                  {!isUpload && (
                    <>
                      {section('New folders only', 'fa-folder-plus')}
                      <label className="flex items-start gap-2 text-xs text-gray-700">
                        <input type="checkbox" className="mt-0.5" checked={isNewFolders}
                          onChange={(e) => set({ operation: 'download', newFoldersOnly: e.target.checked })} />
                        <span>Fetch only subfolders not fetched yet, then copy them to the File Explorer</span>
                      </label>
                      {isNewFolders && (
                        <>
                          <div className="grid grid-cols-2 gap-2">
                            <div>
                              <label className={labelCls}>Start from folder</label>
                              <input type="text" value={d.startFromFolder || ''} onChange={(e) => set({ startFromFolder: e.target.value })} className={`${inputCls} font-mono`} placeholder="2569-10-06" />
                            </div>
                            <div>
                              <label className={labelCls}>Max folders / run</label>
                              <input type="number" min={0} value={d.maxFolders ?? 0} onChange={(e) => set({ maxFolders: parseInt(e.target.value) || 0 })} className={inputCls} />
                              <p className={hintCls}>0 = all</p>
                            </div>
                          </div>
                          <div>
                            <label className={labelCls}>File Explorer basket</label>
                            <select value={d.explorerBasketId || ''} onChange={(e) => set({ explorerBasketId: e.target.value })} className={inputCls}>
                              <option value="">{d.basketId ? "Project's own basket" : 'Shared File Explorer'}</option>
                              {baskets.filter(b => b.type === 'shares').map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                            </select>
                            <p className={hintCls}>Where the decrypted copies show up in the File Explorer.</p>
                          </div>
                          <label className="flex items-start gap-2 text-xs text-gray-700">
                            <input type="checkbox" className="mt-0.5" checked={d.groupByFiscalYear === true} onChange={(e) => set({ groupByFiscalYear: e.target.checked })} />
                            <span>Group by fiscal year (ปีงบประมาณ): <span className="font-mono">DATA/2570/2569-10-06</span></span>
                          </label>
                          <div>
                            <label className={labelCls}>Link base URL</label>
                            <input type="text" value={d.linkBaseUrl || ''} onChange={(e) => set({ linkBaseUrl: e.target.value })} className={`${inputCls} font-mono`} placeholder="https://example.com/integration" />
                            <p className={hintCls}>For the share links in <code>summary</code>. Output: <code>hasNew</code>, <code>newFolderNames</code>, <code>newFolders</code>, <code>summary</code>.</p>
                          </div>
                        </>
                      )}
                    </>
                  )}

                  {/* ── Security ── */}
                  {section('Encryption', 'fa-key')}
                  <div>
                    <label className={labelCls}>Secrets Vault key</label>
                    <MiniDropdown
                      value={d.encryptionKeyId || ''}
                      onChange={(value) => set({ encryptionKeyId: value || undefined })}
                      options={[
                        { value: '', label: 'None (no encryption)', icon: 'fa-unlock', color: 'text-gray-400' },
                        ...encryptionKeys.map(k => ({
                          value: k.id,
                          label: `${k.name} (${k.algorithm.toUpperCase()})`,
                          icon: k.algorithm === 'pgp' ? 'fa-key' : k.algorithm === 'rsa' ? 'fa-shield-alt' : 'fa-lock',
                          color: 'text-emerald-500',
                        })),
                      ]}
                    />
                  </div>

                  {/* ── After transfer ── */}
                  {(isUpload || !isNewFolders) && section('After transfer', 'fa-check-double')}
                  {isUpload && (
                    <div className="space-y-2">
                      <label className="flex items-center gap-2 text-xs text-gray-700">
                        <input type="checkbox" className="rounded" checked={d.publishAfterTransfer === true} onChange={(e) => set({ publishAfterTransfer: e.target.checked })} />
                        Publish/Complete basket session
                      </label>
                      <label className="flex items-center gap-2 text-xs text-gray-700">
                        <input type="checkbox" className="rounded" checked={d.archiveAfterUpload === true} onChange={(e) => set({ archiveAfterUpload: e.target.checked })} />
                        Archive source file after transfer
                      </label>
                      <label className="flex items-center gap-2 text-xs text-gray-700">
                        <input type="checkbox" className="rounded" checked={d.deleteAfterUpload === true} onChange={(e) => set({ deleteAfterUpload: e.target.checked })} />
                        Delete source file after transfer
                      </label>
                    </div>
                  )}
                  {!isUpload && !isNewFolders && (
                    <div className="space-y-2">
                      <label className="flex items-center gap-2 text-xs text-gray-700">
                        <input type="checkbox" className="rounded" checked={d.extractZipFiles === true} onChange={(e) => set({ extractZipFiles: e.target.checked })} />
                        Extract ZIP files after download
                      </label>
                      <label className="flex items-center gap-2 text-xs text-gray-700">
                        <input type="checkbox" className="rounded" checked={d.publishAfterTransfer === true} onChange={(e) => set({ publishAfterTransfer: e.target.checked })} />
                        Publish basket session
                      </label>
                    </div>
                  )}
                </>
              );
            })()}

            {/* Email Action config */}
            {selectedNodeData.type === 'email-action' && (() => {
              const d = selectedNodeData.data || {};
              const set = (patch: Record<string, unknown>) => updateNodeData(selectedNodeData.id, patch);
              const smtpConnections = connections.filter(c => c.type === 'smtp');
              const inputCls = 'w-full px-2 py-1.5 border rounded text-xs';
              return (
                <>
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">SMTP connection</label>
                    <select
                      value={d.connectionId || ''}
                      onChange={(e) => set({ connectionId: e.target.value })}
                      className={`${inputCls} bg-white`}
                    >
                      <option value="">Select a mail server…</option>
                      {smtpConnections.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                    {smtpConnections.length === 0 && (
                      <p className="text-[12px] text-amber-600 mt-1">No SMTP connection in this project yet — add one under Connections (type "SMTP (Email)").</p>
                    )}
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">To</label>
                    <input type="text" value={d.to || ''} onChange={(e) => set({ to: e.target.value })} className={inputCls} placeholder="a@example.com, b@example.com" />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">CC</label>
                      <input type="text" value={d.cc || ''} onChange={(e) => set({ cc: e.target.value })} className={inputCls} />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">BCC</label>
                      <input type="text" value={d.bcc || ''} onChange={(e) => set({ bcc: e.target.value })} className={inputCls} />
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">Subject</label>
                    <input type="text" value={d.subject || ''} onChange={(e) => set({ subject: e.target.value })} className={inputCls} placeholder="New data {{download.folder}} is ready" />
                  </div>
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="block text-xs font-medium text-gray-700">Body</label>
                      <select value={d.bodyFormat || 'text'} onChange={(e) => set({ bodyFormat: e.target.value })} className="text-[12px] border rounded px-1 py-0.5 bg-white">
                        <option value="text">Plain text</option>
                        <option value="html">HTML</option>
                      </select>
                    </div>
                    <textarea
                      value={d.body || ''}
                      onChange={(e) => set({ body: e.target.value })}
                      className={`${inputCls} font-mono`}
                      rows={6}
                      placeholder={'New files are ready:\n{{download.files}}'}
                    />
                    <p className="text-[12px] text-gray-500 mt-1">{'{{nodeName.field}}'} inserts output from earlier nodes.</p>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">Attachments</label>
                    <textarea
                      value={d.attachments || ''}
                      onChange={(e) => set({ attachments: e.target.value })}
                      className={`${inputCls} font-mono`}
                      rows={2}
                      placeholder={'One per line: a file path or {{node.files}}'}
                    />
                  </div>
                  <label className="flex items-center gap-2 text-xs text-gray-700">
                    <input type="checkbox" checked={!!d.zipAttachments} onChange={(e) => set({ zipAttachments: e.target.checked })} />
                    Zip attachments into one file
                  </label>
                  {d.zipAttachments && (
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="block text-xs font-medium text-gray-700 mb-1">Zip name</label>
                        <input type="text" value={d.zipName || ''} onChange={(e) => set({ zipName: e.target.value })} className={inputCls} placeholder="attachments.zip" />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-700 mb-1">Zip password</label>
                        <input type="password" value={d.zipPassword || ''} onChange={(e) => set({ zipPassword: e.target.value })} className={inputCls} placeholder="none" autoComplete="new-password" />
                      </div>
                    </div>
                  )}
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">Max attachment size (MB)</label>
                    <input type="number" min={1} value={d.maxAttachmentMB ?? 20} onChange={(e) => set({ maxAttachmentMB: parseInt(e.target.value) || 20 })} className={inputCls} />
                  </div>
                </>
              );
            })()}

            {/* Delay config */}
            {selectedNodeData.type === 'delay' && (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">Delay</label>
                    <input
                      type="number"
                      min={1}
                      value={selectedNodeData.data?.duration ?? selectedNodeData.data?.seconds ?? 5}
                      onChange={(e) => updateNodeData(selectedNodeData.id, {
                        duration: parseInt(e.target.value) || 1,
                        unit: selectedNodeData.data?.unit || 'seconds',
                        seconds: undefined, // drop legacy field once migrated
                      })}
                      className="w-full px-2 py-1.5 text-sm border rounded text-xs"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">Unit</label>
                    <select
                      value={selectedNodeData.data?.unit || 'seconds'}
                      onChange={(e) => updateNodeData(selectedNodeData.id, {
                        duration: selectedNodeData.data?.duration ?? selectedNodeData.data?.seconds ?? 5,
                        unit: e.target.value,
                        seconds: undefined, // drop legacy field once migrated
                      })}
                      className="w-full px-2 py-1.5 text-sm border rounded text-xs bg-white"
                    >
                      <option value="ms">Milliseconds</option>
                      <option value="seconds">Seconds</option>
                      <option value="minutes">Minutes</option>
                      <option value="hours">Hours</option>
                    </select>
                  </div>
                </div>
                <div className="text-[12px] text-gray-500">
                  Delays are capped at 5 minutes for safety.
                </div>
              </>
            )}

            {/* For-Each config */}
            {selectedNodeData.type === 'for-each' && (
              <>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Source Array</label>
                  <input
                    type="text"
                    value={selectedNodeData.data?.source || 'triggerFiles'}
                    onChange={(e) => updateNodeData(selectedNodeData.id, { source: e.target.value })}
                    className="w-full px-2 py-1.5 text-sm border rounded font-mono text-xs"
                    placeholder="triggerFiles"
                  />
                  <p className="text-[12px] text-gray-500 mt-1">
                    Path to array: <code className="bg-gray-100 px-1">triggerFiles</code>, <code className="bg-gray-100 px-1">vars.nodeId.files</code>
                  </p>
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Item Variable Name</label>
                  <input
                    type="text"
                    value={selectedNodeData.data?.itemVar || 'currentFile'}
                    onChange={(e) => updateNodeData(selectedNodeData.id, { itemVar: e.target.value })}
                    className="w-full px-2 py-1.5 text-sm border rounded font-mono text-xs"
                    placeholder="currentFile"
                  />
                  <p className="text-[12px] text-gray-500 mt-1">
                    Each iteration sets this variable
                  </p>
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Index Variable Name</label>
                  <input
                    type="text"
                    value={selectedNodeData.data?.indexVar || 'loopIndex'}
                    onChange={(e) => updateNodeData(selectedNodeData.id, { indexVar: e.target.value })}
                    className="w-full px-2 py-1.5 text-sm border rounded font-mono text-xs"
                    placeholder="loopIndex"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Filter Pattern <span className="text-gray-400">(optional)</span></label>
                  <input
                    type="text"
                    value={selectedNodeData.data?.filterPattern || ''}
                    onChange={(e) => updateNodeData(selectedNodeData.id, { filterPattern: e.target.value })}
                    className="w-full px-2 py-1.5 text-sm border rounded font-mono text-xs"
                    placeholder="*AnnualPay*.csv"
                  />
                  <p className="text-[12px] text-gray-500 mt-1">
                    Filter items by file name pattern (glob: <code className="bg-gray-100 px-1">*.csv</code>, <code className="bg-gray-100 px-1">*Pay*.csv</code>)
                  </p>
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">
                    Workers <span className="text-gray-400">(parallel)</span>
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={1}
                      max={20}
                      value={selectedNodeData.data?.workers || 1}
                      onChange={(e) => updateNodeData(selectedNodeData.id, { workers: Math.max(1, Math.min(parseInt(e.target.value) || 1, 20)) })}
                      className="w-20 px-2 py-1.5 text-sm border rounded font-mono text-xs"
                    />
                    <span className="text-[12px] text-gray-500">
                      {(selectedNodeData.data?.workers || 1) <= 1 ? 'Sequential' : `${selectedNodeData.data?.workers} items parallel`}
                    </span>
                  </div>
                  <p className="text-[12px] text-gray-500 mt-1">
                    1 = sequential (safe), 2-20 = parallel workers
                  </p>
                </div>

              </>
            )}

            {/* HTTP Request config */}
            {selectedNodeData.type === 'http-request' && (
              <>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">URL</label>
                  <input
                    type="text"
                    value={selectedNodeData.data?.url || ''}
                    onChange={(e) => updateNodeData(selectedNodeData.id, { url: e.target.value })}
                    className="w-full px-2 py-1.5 text-sm border rounded text-xs"
                    placeholder="https://api.example.com/data"
                  />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">Method</label>
                    <MiniDropdown
                      value={selectedNodeData.data?.method || 'GET'}
                      onChange={(value) => updateNodeData(selectedNodeData.id, { method: value })}
                      options={[
                        { value: 'GET', label: 'GET', icon: 'fa-arrow-up', color: 'text-blue-500' },
                        { value: 'POST', label: 'POST', icon: 'fa-plus', color: 'text-green-500' },
                        { value: 'PUT', label: 'PUT', icon: 'fa-edit', color: 'text-amber-500' },
                        { value: 'PATCH', label: 'PATCH', icon: 'fa-band-aid', color: 'text-purple-500' },
                        { value: 'DELETE', label: 'DELETE', icon: 'fa-trash', color: 'text-red-500' },
                      ]}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">Mode</label>
                    <MiniDropdown
                      value={selectedNodeData.data?.uploadFile ? 'upload' : selectedNodeData.data?.downloadFile ? 'download' : 'api'}
                      onChange={(value) => updateNodeData(selectedNodeData.id, { downloadFile: value === 'download', uploadFile: value === 'upload' })}
                      options={[
                        { value: 'api', label: 'API Call', icon: 'fa-cloud', color: 'text-blue-500' },
                        { value: 'download', label: 'Download', icon: 'fa-download', color: 'text-green-500' },
                        { value: 'upload', label: 'Upload File', icon: 'fa-upload', color: 'text-orange-500' },
                      ]}
                    />
                  </div>
                </div>

                {/* Skip TLS/SSL verification (for gov APIs with incomplete cert chains) */}
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="hr-insecure"
                    checked={selectedNodeData.data?.insecure === true}
                    onChange={(e) => updateNodeData(selectedNodeData.id, { insecure: e.target.checked })}
                  />
                  <label htmlFor="hr-insecure" className="text-xs text-gray-700">
                    ข้าม SSL verify (insecure) — สำหรับ API ที่ cert chain ไม่ครบ
                  </label>
                </div>

                {selectedNodeData.data?.uploadFile ? (
                  <>
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">File Path</label>
                      <input
                        type="text"
                        value={selectedNodeData.data?.uploadFilePath || ''}
                        onChange={(e) => updateNodeData(selectedNodeData.id, { uploadFilePath: e.target.value })}
                        className="w-full px-2 py-1.5 text-sm border rounded font-mono text-xs"
                        placeholder="{{vars.currentFile.path}}"
                      />
                      <p className="text-[12px] text-gray-500 mt-1">Path to file to upload (supports templates)</p>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">Field Name</label>
                      <input
                        type="text"
                        value={selectedNodeData.data?.uploadFieldName || 'file'}
                        onChange={(e) => updateNodeData(selectedNodeData.id, { uploadFieldName: e.target.value })}
                        className="w-full px-2 py-1.5 text-sm border rounded text-xs"
                        placeholder="file"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">Headers (JSON)</label>
                      <textarea
                        value={typeof selectedNodeData.data?.headers === 'object' ? JSON.stringify(selectedNodeData.data.headers, null, 2) : (selectedNodeData.data?.headers || '')}
                        onChange={(e) => updateNodeData(selectedNodeData.id, { headers: e.target.value })}
                        className="w-full px-2 py-1.5 text-sm border rounded font-mono text-xs"
                        rows={2}
                        placeholder={`{"Authorization": "Bearer {{vars.login.token}}"}`}
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">Extra Form Fields (JSON)</label>
                      <textarea
                        value={selectedNodeData.data?.formFields ? JSON.stringify(selectedNodeData.data.formFields) : ''}
                        onChange={(e) => {
                          try { updateNodeData(selectedNodeData.id, { formFields: JSON.parse(e.target.value) }); } catch {}
                        }}
                        className="w-full px-2 py-1.5 text-sm border rounded font-mono text-xs"
                        rows={2}
                        placeholder={`{"description": "uploaded file"}`}
                      />
                    </div>
                  </>
                ) : selectedNodeData.data?.downloadFile ? (
                  <>
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">Save to Basket</label>
                      <input
                        type="text"
                        value={selectedNodeData.data?.savePath || '/data/incoming'}
                        onChange={(e) => updateNodeData(selectedNodeData.id, { savePath: e.target.value })}
                        className="w-full px-2 py-1.5 text-sm border rounded text-xs"
                        placeholder="/data/incoming"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">File Name</label>
                      <input
                        type="text"
                        value={selectedNodeData.data?.fileName || '{{original}}'}
                        onChange={(e) => updateNodeData(selectedNodeData.id, { fileName: e.target.value })}
                        className="w-full px-2 py-1.5 text-sm border rounded font-mono text-xs"
                        placeholder="{{original}} or data-{{date}}.csv"
                      />
                      <p className="text-[12px] text-gray-500 mt-1">{`{{original}}, {{date}}, {{timestamp}}`}</p>
                    </div>
                  </>
                ) : (
                  <>
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">Headers (JSON)</label>
                      <textarea
                        value={typeof selectedNodeData.data?.headers === 'object' ? JSON.stringify(selectedNodeData.data.headers, null, 2) : (selectedNodeData.data?.headers || '')}
                        onChange={(e) => updateNodeData(selectedNodeData.id, { headers: e.target.value })}
                        className="w-full px-2 py-1.5 text-sm border rounded font-mono text-xs"
                        rows={2}
                        placeholder={`{"Authorization": "Bearer {{token}}"}`}
                      />
                    </div>
                    {['POST', 'PUT', 'PATCH'].includes(selectedNodeData.data?.method) && (
                      <div>
                        <label className="block text-xs font-medium text-gray-700 mb-1">Body (JSON)</label>
                        <textarea
                          value={typeof selectedNodeData.data?.body === 'object' ? JSON.stringify(selectedNodeData.data.body, null, 2) : (selectedNodeData.data?.body || '')}
                          onChange={(e) => updateNodeData(selectedNodeData.id, { body: e.target.value })}
                          className="w-full px-2 py-1.5 text-sm border rounded font-mono text-xs"
                          rows={3}
                          placeholder={`{"key": "{{value}}"}`}
                        />
                      </div>
                    )}

                    {/* Pagination: loop limit/offset until all pages fetched */}
                    <div className="border-t pt-2 mt-1">
                      <div className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          id="hr-paginate"
                          checked={selectedNodeData.data?.paginate === true}
                          onChange={(e) => updateNodeData(selectedNodeData.id, { paginate: e.target.checked })}
                        />
                        <label htmlFor="hr-paginate" className="text-xs text-gray-700">
                          เปิด paging — ดึงครบทุกหน้า (วน limit/offset จนครบ total)
                        </label>
                      </div>
                      {selectedNodeData.data?.paginate && (
                        <div className="mt-2 space-y-2 pl-1">
                          <div className="grid grid-cols-2 gap-2">
                            <div>
                              <label className="block text-[12px] font-medium text-gray-600 mb-1">Page size</label>
                              <input
                                type="number"
                                value={selectedNodeData.data?.pageSize ?? 1000}
                                onChange={(e) => updateNodeData(selectedNodeData.id, { pageSize: Number(e.target.value) })}
                                className="w-full px-2 py-1.5 text-sm border rounded text-xs"
                                placeholder="1000"
                              />
                            </div>
                            <div>
                              <label className="block text-[12px] font-medium text-gray-600 mb-1">Params in</label>
                              <MiniDropdown
                                value={selectedNodeData.data?.paginationIn || (['POST', 'PUT', 'PATCH'].includes(selectedNodeData.data?.method) ? 'body' : 'query')}
                                onChange={(value) => updateNodeData(selectedNodeData.id, { paginationIn: value })}
                                options={[
                                  { value: 'body', label: 'Body', icon: 'fa-code', color: 'text-green-500' },
                                  { value: 'query', label: 'Query', icon: 'fa-link', color: 'text-blue-500' },
                                ]}
                              />
                            </div>
                          </div>
                          <div className="grid grid-cols-2 gap-2">
                            <div>
                              <label className="block text-[12px] font-medium text-gray-600 mb-1">Limit param</label>
                              <input
                                type="text"
                                value={selectedNodeData.data?.limitParam ?? 'limit'}
                                onChange={(e) => updateNodeData(selectedNodeData.id, { limitParam: e.target.value })}
                                className="w-full px-2 py-1.5 text-sm border rounded font-mono text-xs"
                                placeholder="limit"
                              />
                            </div>
                            <div>
                              <label className="block text-[12px] font-medium text-gray-600 mb-1">Offset param</label>
                              <input
                                type="text"
                                value={selectedNodeData.data?.offsetParam ?? 'offset'}
                                onChange={(e) => updateNodeData(selectedNodeData.id, { offsetParam: e.target.value })}
                                className="w-full px-2 py-1.5 text-sm border rounded font-mono text-xs"
                                placeholder="offset"
                              />
                            </div>
                          </div>
                          <div>
                            <label className="block text-[12px] font-medium text-gray-600 mb-1">Items path</label>
                            <input
                              type="text"
                              value={selectedNodeData.data?.itemsPath ?? ''}
                              onChange={(e) => updateNodeData(selectedNodeData.id, { itemsPath: e.target.value })}
                              className="w-full px-2 py-1.5 text-sm border rounded font-mono text-xs"
                              placeholder="value.items (ว่าง = response เป็น array ตรง ๆ)"
                            />
                          </div>
                          <div>
                            <label className="block text-[12px] font-medium text-gray-600 mb-1">Total path</label>
                            <input
                              type="text"
                              value={selectedNodeData.data?.totalPath ?? ''}
                              onChange={(e) => updateNodeData(selectedNodeData.id, { totalPath: e.target.value })}
                              className="w-full px-2 py-1.5 text-sm border rounded font-mono text-xs"
                              placeholder="value.total"
                            />
                          </div>
                          <p className="text-[12px] text-gray-500">
                            วน offset += page size จนสะสม ≥ total — executor merge items ทุกหน้าเป็นชุดเดียวให้ (ไม่ต้องใส่ limit/offset ใน Body เอง)
                          </p>
                        </div>
                      )}
                    </div>
                  </>
                )}
              </>
            )}

            {/* File Read config */}
            {selectedNodeData.type === 'file-read' && (
              <>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Source</label>
                  <MiniDropdown
                    value={selectedNodeData.data?.source || 'basket'}
                    onChange={(value) => updateNodeData(selectedNodeData.id, { source: value })}
                    options={[
                      { value: 'basket', label: 'Basket', icon: 'fa-folder', color: 'text-amber-500' },
                      { value: 'sftp', label: 'SFTP Server', icon: 'fa-server', color: 'text-teal-500' },
                      { value: 'local', label: 'Local Path', icon: 'fa-desktop', color: 'text-gray-500' },
                      { value: 'input', label: 'From Previous Node', icon: 'fa-arrow-down', color: 'text-blue-500' },
                    ]}
                  />
                </div>

                {/* Source-specific options */}
                {selectedNodeData.data?.source === 'basket' && (
                  <>
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">Basket</label>
                      <MiniDropdown
                        value={selectedNodeData.data?.basketId || ''}
                        onChange={(value) => updateNodeData(selectedNodeData.id, { basketId: value })}
                        options={[
                          { value: '', label: 'Select basket...', icon: 'fa-folder', color: 'text-gray-400' },
                          ...baskets.map(b => ({
                            value: b.id,
                            label: b.isShared ? `${b.name} (Shared)` : b.name,
                            icon: b.isShared ? 'fa-share-alt' : 'fa-folder-open',
                            color: b.isShared ? 'text-blue-500' : 'text-amber-500'
                          }))
                        ]}
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">Session Source</label>
                      <MiniDropdown
                        value={selectedNodeData.data?.sessionSource || 'auto'}
                        onChange={(value) => updateNodeData(selectedNodeData.id, { sessionSource: value })}
                        options={[
                          { value: 'auto', label: 'Auto (Trigger/All)', icon: 'fa-magic', color: 'text-purple-500' },
                          { value: 'trigger', label: 'From Trigger', icon: 'fa-bolt', color: 'text-orange-500' },
                          { value: 'latest', label: 'Latest Session', icon: 'fa-clock', color: 'text-blue-500' },
                          { value: 'specific', label: 'Specific Session', icon: 'fa-crosshairs', color: 'text-gray-500' },
                          { value: 'all', label: 'All Files', icon: 'fa-layer-group', color: 'text-green-500' },
                        ]}
                      />
                    </div>
                    {selectedNodeData.data?.sessionSource === 'specific' && (
                      <div>
                        <label className="block text-xs font-medium text-gray-700 mb-1">Session ID</label>
                        <input
                          type="text"
                          value={selectedNodeData.data?.sessionId || ''}
                          onChange={(e) => updateNodeData(selectedNodeData.id, { sessionId: e.target.value })}
                          className="w-full px-2 py-1.5 text-sm border rounded font-mono text-xs"
                          placeholder="Session ID"
                        />
                      </div>
                    )}
                    {selectedNodeData.data?.sessionSource === 'all' && (
                      <div>
                        <label className="block text-xs font-medium text-gray-700 mb-1">File Status</label>
                        <MiniDropdown
                          value={selectedNodeData.data?.fileStatus || 'open'}
                          onChange={(value) => updateNodeData(selectedNodeData.id, { fileStatus: value })}
                          options={[
                            { value: 'open', label: 'Open/Active', icon: 'fa-folder-open', color: 'text-gray-500' },
                            { value: 'published', label: 'Published', icon: 'fa-check-circle', color: 'text-green-500' },
                            { value: 'all', label: 'All Statuses', icon: 'fa-layer-group', color: 'text-blue-500' },
                          ]}
                        />
                      </div>
                    )}
                  </>
                )}

                {selectedNodeData.data?.source === 'sftp' && (
                  <>
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">SFTP Connection</label>
                      <select
                        value={selectedNodeData.data?.sftpConnectionId || ''}
                        onChange={(e) => updateNodeData(selectedNodeData.id, { sftpConnectionId: e.target.value })}
                        className="w-full px-2 py-1.5 text-sm border rounded"
                      >
                        <option value="">Select...</option>
                        {connections.filter(c => c.type === 'sftp').map(conn => (
                          <option key={conn.id} value={conn.id}>{conn.name}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">Remote Path</label>
                      <input
                        type="text"
                        value={selectedNodeData.data?.sftpRemotePath || '/uploads/'}
                        onChange={(e) => updateNodeData(selectedNodeData.id, { sftpRemotePath: e.target.value })}
                        className="w-full px-2 py-1.5 text-sm border rounded text-xs"
                        placeholder="/uploads/file.csv"
                      />
                    </div>
                  </>
                )}

                {selectedNodeData.data?.source === 'local' && (
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">Local Path</label>
                    <input
                      type="text"
                      value={selectedNodeData.data?.localPath || ''}
                      onChange={(e) => updateNodeData(selectedNodeData.id, { localPath: e.target.value })}
                      className="w-full px-2 py-1.5 text-sm border rounded font-mono text-xs"
                      placeholder="/path/to/file.csv"
                    />
                  </div>
                )}

                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">File Pattern</label>
                  <input
                    type="text"
                    value={selectedNodeData.data?.filePattern || '*.*'}
                    onChange={(e) => updateNodeData(selectedNodeData.id, { filePattern: e.target.value })}
                    className="w-full px-2 py-1.5 text-sm border rounded font-mono text-xs"
                    placeholder="*.csv or {{currentFile}}"
                  />
                  <p className="text-[12px] text-gray-400 mt-0.5">
                    Glob pattern (*.csv) or {'{{variable}}'} from For-Each loop
                  </p>
                </div>

                <div className="border-t pt-3 mt-3">
                  <label className="block text-xs font-medium text-gray-700 mb-1">Parse As</label>
                  <MiniDropdown
                    value={selectedNodeData.data?.parseAs || 'auto'}
                    onChange={(value) => updateNodeData(selectedNodeData.id, { parseAs: value })}
                    options={[
                      { value: 'auto', label: 'Auto Detect', icon: 'fa-magic', color: 'text-purple-500' },
                      { value: 'csv', label: 'CSV', icon: 'fa-file-csv', color: 'text-green-500' },
                      { value: 'tsv', label: 'TSV', icon: 'fa-file-csv', color: 'text-green-600' },
                      { value: 'json', label: 'JSON', icon: 'fa-file-code', color: 'text-blue-500' },
                      { value: 'txt', label: 'Text', icon: 'fa-file-alt', color: 'text-gray-500' },
                      { value: 'raw', label: 'Raw (No Parse)', icon: 'fa-file', color: 'text-gray-400' },
                      { value: 'download', label: 'Download (Binary)', icon: 'fa-download', color: 'text-indigo-500' },
                    ]}
                  />
                </div>

                {(selectedNodeData.data?.parseAs === 'csv' || selectedNodeData.data?.parseAs === 'tsv') && (
                  <>
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">Delimiter</label>
                      <input
                        type="text"
                        value={selectedNodeData.data?.delimiter || ''}
                        onChange={(e) => updateNodeData(selectedNodeData.id, { delimiter: e.target.value })}
                        className="w-full px-2 py-1.5 text-sm border rounded text-xs"
                        placeholder=", or tab"
                      />
                    </div>
                    
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        id="hasHeader"
                        checked={selectedNodeData.data?.hasHeader !== false}
                        onChange={(e) => updateNodeData(selectedNodeData.id, { hasHeader: e.target.checked })}
                        className="rounded text-blue-600"
                      />
                      <label htmlFor="hasHeader" className="text-xs text-gray-700">First row is header</label>
                    </div>
                    
                    {selectedNodeData.data?.hasHeader === false && (
                      <div>
                        <label className="block text-xs font-medium text-gray-700 mb-1">Custom Headers (optional)</label>
                        <input
                          type="text"
                          value={selectedNodeData.data?.customHeaders || ''}
                          onChange={(e) => updateNodeData(selectedNodeData.id, { customHeaders: e.target.value })}
                          className="w-full px-2 py-1.5 text-sm border rounded font-mono text-xs"
                          placeholder="name,email,phone (or leave empty for col0,col1...)"
                        />
                        <p className="text-[12px] text-gray-500 mt-1">
                          Leave empty to use col0, col1, col2...
                        </p>
                      </div>
                    )}
                  </>
                )}

                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Encoding</label>
                  <MiniDropdown
                    value={selectedNodeData.data?.encoding || 'utf-8'}
                    onChange={(value) => updateNodeData(selectedNodeData.id, { encoding: value })}
                    options={[
                      { value: 'utf-8', label: 'UTF-8', icon: 'fa-font', color: 'text-blue-500' },
                      { value: 'tis-620', label: 'TIS-620 (Thai)', icon: 'fa-language', color: 'text-green-500' },
                      { value: 'windows-874', label: 'Windows-874', icon: 'fa-language', color: 'text-green-600' },
                      { value: 'ascii', label: 'ASCII', icon: 'fa-font', color: 'text-gray-500' },
                    ]}
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Max Rows</label>
                  <input
                    type="number"
                    value={selectedNodeData.data?.maxRows || ''}
                    onChange={(e) => updateNodeData(selectedNodeData.id, { maxRows: e.target.value ? parseInt(e.target.value) : undefined })}
                    className="w-full px-2 py-1.5 text-sm border rounded text-xs"
                    placeholder="Unlimited"
                  />
                </div>
              </>
            )}

            {/* File Write config */}
            {selectedNodeData.type === 'file-write' && (
              <>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Data Source</label>
                  <MiniDropdown
                    value={selectedNodeData.data?.dataSource || 'input'}
                    onChange={(value) => updateNodeData(selectedNodeData.id, { dataSource: value })}
                    options={[
                      { value: 'input', label: 'From Previous Node', icon: 'fa-arrow-down', color: 'text-blue-500' },
                      { value: 'template', label: 'Custom Template', icon: 'fa-pen', color: 'text-purple-500' },
                    ]}
                  />
                </div>

                {selectedNodeData.data?.dataSource === 'input' ? (
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">Data Path</label>
                    <input
                      type="text"
                      value={selectedNodeData.data?.dataPath || 'input.data'}
                      onChange={(e) => updateNodeData(selectedNodeData.id, { dataPath: e.target.value })}
                      className="w-full px-2 py-1.5 text-sm border rounded font-mono text-xs"
                      placeholder="input.data, db.rows"
                    />
                  </div>
                ) : (
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">Content Template</label>
                    <textarea
                      value={selectedNodeData.data?.template || ''}
                      onChange={(e) => updateNodeData(selectedNodeData.id, { template: e.target.value })}
                      className="w-full px-2 py-1.5 text-sm border rounded font-mono text-xs"
                      rows={4}
                      placeholder="Name: {{name}}&#10;Email: {{email}}"
                    />
                  </div>
                )}

                <div className="border-t pt-3 mt-3">
                  <label className="block text-xs font-medium text-gray-700 mb-1">Output Format</label>
                  <MiniDropdown
                    value={selectedNodeData.data?.format || 'csv'}
                    onChange={(value) => updateNodeData(selectedNodeData.id, { format: value })}
                    options={[
                      { value: 'csv', label: 'CSV (Comma)', icon: 'fa-file-csv', color: 'text-green-500' },
                      { value: 'tsv', label: 'TSV (Tab)', icon: 'fa-file-csv', color: 'text-green-600' },
                      { value: 'delimited', label: 'Delimited Text', icon: 'fa-file-alt', color: 'text-orange-500' },
                      { value: 'json', label: 'JSON', icon: 'fa-file-code', color: 'text-blue-500' },
                      { value: 'txt', label: 'Plain Text', icon: 'fa-file-alt', color: 'text-gray-500' },
                      { value: 'xlsx', label: 'Excel (XLSX)', icon: 'fa-file-excel', color: 'text-green-600' },
                      { value: 'zip', label: 'ZIP Archive', icon: 'fa-file-archive', color: 'text-purple-500' },
                    ]}
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">File Name</label>
                  <input
                    type="text"
                    value={selectedNodeData.data?.fileName || 'export-{{timestamp}}.csv'}
                    onChange={(e) => updateNodeData(selectedNodeData.id, { fileName: e.target.value })}
                    className="w-full px-2 py-1.5 text-sm border rounded font-mono text-xs"
                    placeholder="export-{{timestamp}}.csv"
                  />
                  <p className="text-[12px] text-gray-500 mt-1">{`{{timestamp}}, {{date}}, {{extension}}`}</p>
                </div>

                {/* Destination — moved up so it's always visible */}
                <div className="border-t pt-3 mt-3">
                  <label className="block text-xs font-medium text-gray-700 mb-1">Destination</label>
                  <MiniDropdown
                    value={selectedNodeData.data?.destination || 'basket'}
                    onChange={(value) => updateNodeData(selectedNodeData.id, { destination: value })}
                    options={[
                      { value: 'basket', label: 'Basket', icon: 'fa-folder', color: 'text-amber-500' },
                      { value: 'sftp', label: 'SFTP Server', icon: 'fa-server', color: 'text-teal-500' },
                      { value: 'local', label: 'Local Path', icon: 'fa-desktop', color: 'text-gray-500' },
                    ]}
                  />
                </div>

                {selectedNodeData.data?.destination === 'basket' && (
                  <>
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">
                        Basket {baskets.length > 0 && <span className="text-gray-400">({baskets.length})</span>}
                      </label>
                      <MiniDropdown
                        value={selectedNodeData.data?.basketId || ''}
                        onChange={(value) => {
                          const selectedBasket = baskets.find(b => b.id === value);
                          updateNodeData(selectedNodeData.id, {
                            basketId: value,
                            basketType: selectedBasket?.type || 'batch'
                          });
                        }}
                        options={[
                          {
                            value: '',
                            label: baskets.length === 0 ? 'Loading baskets...' : 'Select basket...',
                            iconComponent: <Folder size={14} />,
                            color: 'text-gray-400'
                          },
                          ...baskets.map(b => ({
                            value: b.id,
                            label: b.name,
                            iconComponent: b.type === 'shares' ? <Folder size={14} /> : <Package size={14} />,
                            color: b.type === 'shares' ? 'text-cyan-600' : 'text-orange-500'
                          }))
                        ]}
                      />
                      {baskets.length === 0 && (
                        <p className="text-[12px] text-amber-600 mt-1">No baskets found</p>
                      )}
                    </div>

                    {/* Target Folder for Shares basket */}
                    {selectedNodeData.data?.basketId && selectedNodeData.data?.basketType === 'shares' && (
                      <div>
                        <label className="block text-xs font-medium text-gray-700 mb-1">Target Folder</label>
                        <input
                          type="text"
                          value={selectedNodeData.data?.targetFolder || ''}
                          onChange={(e) => updateNodeData(selectedNodeData.id, { targetFolder: e.target.value })}
                          className="w-full px-2 py-1.5 text-sm border rounded text-xs"
                          placeholder="e.g., /incoming, /data/2024"
                        />
                        <p className="text-[12px] text-gray-500 mt-1">Folder path within shares basket</p>
                      </div>
                    )}

                    {/* Session Mode for Batch basket */}
                    {selectedNodeData.data?.basketId && selectedNodeData.data?.basketType !== 'shares' && (
                      <>
                        <div>
                          <label className="block text-xs font-medium text-gray-700 mb-1">Session Mode</label>
                          <MiniDropdown
                            value={selectedNodeData.data?.sessionMode || 'always_new'}
                            onChange={(value) => updateNodeData(selectedNodeData.id, { sessionMode: value })}
                            options={[
                              { value: 'always_new', label: 'Always Create New', icon: 'fa-plus', color: 'text-blue-500' },
                              { value: 'existing_or_new', label: 'Use Existing or New', icon: 'fa-folder-open', color: 'text-green-500' },
                              { value: 'reuse_existing', label: 'Reuse Existing Only', icon: 'fa-link', color: 'text-purple-500' },
                            ]}
                          />
                        </div>

                        <div className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            id="autoPublishWrite"
                            checked={selectedNodeData.data?.autoPublish === true}
                            onChange={(e) => updateNodeData(selectedNodeData.id, { autoPublish: e.target.checked })}
                            className="rounded text-blue-600"
                          />
                          <label htmlFor="autoPublishWrite" className="text-xs text-gray-700">Auto-publish after write</label>
                        </div>
                      </>
                    )}

                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        id="clearFiles"
                        checked={selectedNodeData.data?.clearFiles === true}
                        onChange={(e) => updateNodeData(selectedNodeData.id, { clearFiles: e.target.checked })}
                        className="rounded text-blue-600"
                      />
                      <label htmlFor="clearFiles" className="text-xs text-gray-700">Clear existing files first</label>
                    </div>

                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        id="autoPublishSession"
                        checked={selectedNodeData.data?.autoPublish === true}
                        onChange={(e) => updateNodeData(selectedNodeData.id, { autoPublish: e.target.checked })}
                        className="rounded text-green-600"
                      />
                      <label htmlFor="autoPublishSession" className="text-xs text-gray-700">Auto publish session</label>
                    </div>
                  </>
                )}

                {/* ZIP Options — when format is 'zip' */}
                {selectedNodeData.data?.format === 'zip' && (
                  <div className="border-t pt-3 mt-3 space-y-3">
                    <label className="block text-xs font-medium text-gray-700 mb-1">
                      <i className="fas fa-file-archive text-purple-500 mr-1"></i>
                      ZIP Options
                    </label>
                    <div>
                      <label className="block text-[12px] text-gray-500 mb-1">Source Basket (files to zip)</label>
                      <select
                        value={selectedNodeData.data?.sourceBasketId || ''}
                        onChange={(e) => {
                          const selectedBasket = baskets.find(b => b.id === e.target.value);
                          updateNodeData(selectedNodeData.id, {
                            sourceBasketId: e.target.value,
                            sourceBasketName: selectedBasket?.name || ''
                          });
                        }}
                        className="w-full px-2 py-1.5 text-sm border rounded focus:ring-2 focus:ring-blue-600 outline-none"
                      >
                        <option value="">Same as destination basket</option>
                        {baskets.map(b => (
                          <option key={b.id} value={b.id}>{b.name} ({b.type})</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-[12px] text-gray-500 mb-1">File Pattern (which files to include)</label>
                      <input
                        type="text"
                        value={selectedNodeData.data?.zipFilePattern || '*'}
                        onChange={(e) => updateNodeData(selectedNodeData.id, { zipFilePattern: e.target.value })}
                        className="w-full px-2 py-1.5 text-sm border rounded font-mono text-xs"
                        placeholder="*"
                      />
                      <p className="text-[12px] text-gray-500 mt-1">
                        Glob or comma-separated: <code className="bg-gray-100 px-1 rounded">*.txt,*.xlsx</code> or <code className="bg-gray-100 px-1 rounded">S_ITEM.*</code>
                      </p>
                    </div>
                    <div>
                      <label className="block text-[12px] text-gray-500 mb-1">Compression Level (0-9)</label>
                      <input
                        type="number"
                        min={0}
                        max={9}
                        value={selectedNodeData.data?.compressionLevel ?? 6}
                        onChange={(e) => updateNodeData(selectedNodeData.id, { compressionLevel: parseInt(e.target.value) || 6 })}
                        className="w-20 px-2 py-1.5 text-sm border rounded text-xs"
                      />
                    </div>
                  </div>
                )}

                {/* Delimiter selector for delimited formats */}
                {(selectedNodeData.data?.format === 'delimited' || selectedNodeData.data?.format === 'csv' || selectedNodeData.data?.format === 'tsv') && (
                  <div className="border-t pt-3 mt-3">
                    <label className="block text-xs font-medium text-gray-700 mb-1">Delimiter</label>
                    <MiniDropdown
                      value={selectedNodeData.data?.delimiter || (selectedNodeData.data?.format === 'csv' ? ',' : selectedNodeData.data?.format === 'tsv' ? '\t' : '|')}
                      onChange={(value) => updateNodeData(selectedNodeData.id, { delimiter: value })}
                      options={[
                        { value: '|', label: 'Pipe (|)', icon: 'fa-grip-lines-vertical', color: 'text-gray-600' },
                        { value: ',', label: 'Comma (,)', icon: 'fa-comma', color: 'text-gray-600' },
                        { value: '\t', label: 'Tab', icon: 'fa-arrows-alt-h', color: 'text-gray-600' },
                        { value: ';', label: 'Semicolon (;)', icon: 'fa-grip-lines-vertical', color: 'text-gray-600' },
                      ]}
                    />
                  </div>
                )}

                {/* Include Header - for non-xlsx formats (xlsx has per-sheet config) */}
                {selectedNodeData.data?.format !== 'xlsx' && selectedNodeData.data?.format !== 'zip' && (
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      id="includeHeader"
                      checked={selectedNodeData.data?.includeHeader !== false}
                      onChange={(e) => updateNodeData(selectedNodeData.id, { includeHeader: e.target.checked })}
                      className="rounded text-blue-600"
                    />
                    <label htmlFor="includeHeader" className="text-xs text-gray-700">Include Header Row</label>
                  </div>
                )}

                {/* Column Headers - for non-xlsx formats (xlsx has per-sheet config) */}
                {selectedNodeData.data?.format !== 'xlsx' && selectedNodeData.data?.format !== 'zip' && (
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">Column Headers (optional)</label>
                    <textarea
                      value={selectedNodeData.data?.columns?.join('\n') || ''}
                      onChange={(e) => {
                        const cols = e.target.value.split('\n').map(c => c.trim()).filter(c => c);
                        updateNodeData(selectedNodeData.id, { columns: cols.length > 0 ? cols : undefined });
                      }}
                      className="w-full px-2 py-1.5 text-sm border rounded font-mono text-xs"
                      rows={4}
                      placeholder="COLUMN1&#10;COLUMN2&#10;COLUMN3&#10;(One per line, leave empty to use data keys)"
                    />
                  </div>
                )}

                {/* File Encoding - for non-xlsx formats */}
                {selectedNodeData.data?.format !== 'xlsx' && selectedNodeData.data?.format !== 'zip' && (
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">File Encoding</label>
                    <input
                      type="text"
                      value={selectedNodeData.data?.encoding || 'utf8'}
                      onChange={(e) => updateNodeData(selectedNodeData.id, { encoding: e.target.value })}
                      className="w-full px-2 py-1.5 text-sm border rounded font-mono text-xs"
                      placeholder="utf8, tis620, windows-874, etc."
                      list="encoding-options"
                    />
                    <datalist id="encoding-options">
                      <option value="utf8">UTF-8 (Unicode)</option>
                      <option value="tis620">TIS-620 (Thai)</option>
                      <option value="windows-874">Windows-874 (Thai)</option>
                      <option value="ascii">ASCII</option>
                      <option value="latin1">Latin-1 (ISO-8859-1)</option>
                    </datalist>
                  </div>
                )}

                {/* XLSX Options — Multi-sheet support (placed after destination) */}
                {selectedNodeData.data?.format === 'xlsx' && (() => {
                  const sheets: Array<{ name: string; dataVar: string; columns?: string[]; headerMapping?: Record<string, string>; freezeHeader?: boolean; autoFitColumns?: boolean }> =
                    selectedNodeData.data?.sheets && selectedNodeData.data.sheets.length > 0
                      ? selectedNodeData.data.sheets
                      : [{ name: selectedNodeData.data?.sheetName || 'Sheet1', dataVar: '', columns: selectedNodeData.data?.columns, headerMapping: selectedNodeData.data?.headerMapping, freezeHeader: selectedNodeData.data?.freezeHeader, autoFitColumns: selectedNodeData.data?.autoFitColumns }];

                  const updateSheets = (newSheets: typeof sheets) => {
                    updateNodeData(selectedNodeData.id, { sheets: newSheets, sheetName: undefined });
                  };

                  const updateSheet = (idx: number, patch: Partial<typeof sheets[0]>) => {
                    const updated = sheets.map((s, i) => i === idx ? { ...s, ...patch } : s);
                    updateSheets(updated);
                  };

                  return (
                    <div className="border-t pt-3 mt-3 space-y-3">
                      <div className="flex items-center justify-between">
                        <label className="block text-xs font-medium text-gray-700">Sheets ({sheets.length})</label>
                        <button
                          onClick={() => updateSheets([...sheets, { name: `Sheet${sheets.length + 1}`, dataVar: '', freezeHeader: true, autoFitColumns: true }])}
                          className="text-[12px] text-blue-600 hover:text-blue-800 flex items-center gap-1"
                        >
                          <i className="fas fa-plus text-[8px]" /> Add Sheet
                        </button>
                      </div>

                      {sheets.map((sheet, idx) => (
                        <div key={idx} className="border rounded p-2 space-y-2 bg-gray-50">
                          <div className="flex items-center justify-between">
                            <span className="text-[12px] font-medium text-gray-500">Sheet {idx + 1}</span>
                            {sheets.length > 1 && (
                              <button
                                onClick={() => updateSheets(sheets.filter((_, i) => i !== idx))}
                                className="text-[12px] text-red-400 hover:text-red-600"
                              >
                                <i className="fas fa-trash text-[8px]" /> Remove
                              </button>
                            )}
                          </div>

                          <div>
                            <label className="block text-[12px] text-gray-600 mb-0.5">Sheet Name</label>
                            <input
                              type="text"
                              value={sheet.name || ''}
                              onChange={(e) => updateSheet(idx, { name: e.target.value })}
                              className="w-full px-2 py-1 text-xs border rounded font-mono"
                              placeholder="Sheet1"
                            />
                          </div>

                          <div>
                            <label className="block text-[12px] text-gray-600 mb-0.5">Data Variable</label>
                            <input
                              type="text"
                              value={sheet.dataVar || ''}
                              onChange={(e) => updateSheet(idx, { dataVar: e.target.value })}
                              className="w-full px-2 py-1 text-xs border rounded font-mono"
                              placeholder="nodeId (e.g., agency_query)"
                            />
                            <p className="text-[12px] text-gray-400 mt-0.5">Node ID or varName of upstream data source</p>
                          </div>

                          <div>
                            <label className="block text-[12px] text-gray-600 mb-0.5">Columns (optional)</label>
                            <textarea
                              value={sheet.columns?.join('\n') || ''}
                              onChange={(e) => {
                                const cols = e.target.value.split('\n').map(c => c.trim()).filter(c => c);
                                updateSheet(idx, { columns: cols.length > 0 ? cols : undefined });
                              }}
                              className="w-full px-2 py-1 text-xs border rounded font-mono"
                              rows={3}
                              placeholder={"Column1\nColumn2\n(one per line)"}
                            />
                          </div>

                          <div>
                            <label className="block text-[12px] text-gray-600 mb-0.5">Header Mapping (optional)</label>
                            <textarea
                              value={sheet.headerMapping
                                ? Object.entries(sheet.headerMapping).map(([k, v]) => `${k}=${v}`).join('\n')
                                : ''}
                              onChange={(e) => {
                                const mapping: Record<string, string> = {};
                                e.target.value.split('\n').forEach((line: string) => {
                                  const eqIdx = line.indexOf('=');
                                  if (eqIdx > 0) {
                                    const key = line.substring(0, eqIdx).trim();
                                    const val = line.substring(eqIdx + 1).trim();
                                    if (key && val) mapping[key] = val;
                                  }
                                });
                                updateSheet(idx, { headerMapping: Object.keys(mapping).length > 0 ? mapping : undefined });
                              }}
                              className="w-full px-2 py-1 text-xs border rounded font-mono"
                              rows={2}
                              placeholder={"DB_COL=Display Header"}
                            />
                          </div>

                          <div className="flex items-center gap-3">
                            <label className="flex items-center gap-1 text-[12px] text-gray-600">
                              <input
                                type="checkbox"
                                checked={sheet.freezeHeader !== false}
                                onChange={(e) => updateSheet(idx, { freezeHeader: e.target.checked })}
                                className="rounded text-green-600"
                              />
                              Freeze Header
                            </label>
                            <label className="flex items-center gap-1 text-[12px] text-gray-600">
                              <input
                                type="checkbox"
                                checked={sheet.autoFitColumns !== false}
                                onChange={(e) => updateSheet(idx, { autoFitColumns: e.target.checked })}
                                className="rounded text-green-600"
                              />
                              Auto-fit
                            </label>
                          </div>
                        </div>
                      ))}
                    </div>
                  );
                })()}

                {selectedNodeData.data?.destination === 'sftp' && (
                  <>
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">SFTP Connection</label>
                      <select
                        value={selectedNodeData.data?.sftpConnectionId || ''}
                        onChange={(e) => updateNodeData(selectedNodeData.id, { sftpConnectionId: e.target.value })}
                        className="w-full px-2 py-1.5 text-sm border rounded"
                      >
                        <option value="">Select...</option>
                        {connections.filter(c => c.type === 'sftp').map(conn => (
                          <option key={conn.id} value={conn.id}>{conn.name}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">Remote Path</label>
                      <input
                        type="text"
                        value={selectedNodeData.data?.sftpRemotePath || '/uploads/'}
                        onChange={(e) => updateNodeData(selectedNodeData.id, { sftpRemotePath: e.target.value })}
                        className="w-full px-2 py-1.5 text-sm border rounded text-xs"
                        placeholder="/uploads/"
                      />
                    </div>
                  </>
                )}

                {selectedNodeData.data?.destination === 'local' && (
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">Local Path</label>
                    <input
                      type="text"
                      value={selectedNodeData.data?.localPath || '/tmp'}
                      onChange={(e) => updateNodeData(selectedNodeData.id, { localPath: e.target.value })}
                      className="w-full px-2 py-1.5 text-sm border rounded text-xs"
                      placeholder="/tmp"
                    />
                  </div>
                )}
              </>
            )}

            {/* OCR config */}
            {selectedNodeData.type === 'ocr' && (
              <>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">OCR Service URL</label>
                  <input
                    type="text"
                    value={selectedNodeData.data?.url || ''}
                    onChange={(e) => updateNodeData(selectedNodeData.id, { url: e.target.value })}
                    className="w-full px-2 py-1.5 text-sm border rounded font-mono text-xs"
                    placeholder="https://ocr-server.example.com"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">File Source</label>
                  <input
                    type="text"
                    value={selectedNodeData.data?.fileSource || ''}
                    onChange={(e) => updateNodeData(selectedNodeData.id, { fileSource: e.target.value })}
                    className="w-full px-2 py-1.5 text-sm border rounded font-mono text-xs"
                    placeholder="vars.currentFile.path"
                  />
                  <p className="text-[12px] text-gray-500 mt-1">
                    Variable path to file: <code className="bg-gray-100 px-1">vars.currentFile.path</code>
                  </p>
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Language</label>
                  <select
                    value={selectedNodeData.data?.language || 'Thai,English'}
                    onChange={(e) => updateNodeData(selectedNodeData.id, { language: e.target.value })}
                    className="w-full px-2 py-1.5 text-sm border rounded"
                  >
                    <option value="Thai,English">Thai + English</option>
                    <option value="Thai">Thai</option>
                    <option value="English">English</option>
                    <option value="Japanese">Japanese</option>
                    <option value="Chinese">Chinese</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Output Format</label>
                  <select
                    value={selectedNodeData.data?.outputFormat || 'txt'}
                    onChange={(e) => updateNodeData(selectedNodeData.id, { outputFormat: e.target.value })}
                    className="w-full px-2 py-1.5 text-sm border rounded"
                  >
                    <option value="txt">Plain Text</option>
                    <option value="pdf">PDF</option>
                    <option value="docx">Word (DOCX)</option>
                    <option value="xml">XML</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Auth Type</label>
                  <select
                    value={selectedNodeData.data?.authType || 'none'}
                    onChange={(e) => updateNodeData(selectedNodeData.id, { authType: e.target.value })}
                    className="w-full px-2 py-1.5 text-sm border rounded"
                  >
                    <option value="none">None</option>
                    <option value="basic">Basic Auth</option>
                    <option value="bearer">Bearer Token</option>
                    <option value="api-key">API Key</option>
                  </select>
                </div>

                {selectedNodeData.data?.authType === 'basic' && (
                  <>
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">Username</label>
                      <input type="text" value={selectedNodeData.data?.username || ''} onChange={(e) => updateNodeData(selectedNodeData.id, { username: e.target.value })} className="w-full px-2 py-1.5 text-sm border rounded text-xs" />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">Password</label>
                      <input type="password" value={selectedNodeData.data?.password || ''} onChange={(e) => updateNodeData(selectedNodeData.id, { password: e.target.value })} className="w-full px-2 py-1.5 text-sm border rounded text-xs" />
                    </div>
                  </>
                )}

                {selectedNodeData.data?.authType === 'bearer' && (
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">Token</label>
                    <input type="text" value={selectedNodeData.data?.token || ''} onChange={(e) => updateNodeData(selectedNodeData.id, { token: e.target.value })} className="w-full px-2 py-1.5 text-sm border rounded font-mono text-xs" placeholder="{{vars.login.token}}" />
                  </div>
                )}

                {selectedNodeData.data?.authType === 'api-key' && (
                  <>
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">API Key</label>
                      <input type="text" value={selectedNodeData.data?.apiKey || ''} onChange={(e) => updateNodeData(selectedNodeData.id, { apiKey: e.target.value })} className="w-full px-2 py-1.5 text-sm border rounded text-xs" />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">Header Name</label>
                      <input type="text" value={selectedNodeData.data?.apiKeyHeader || 'X-API-Key'} onChange={(e) => updateNodeData(selectedNodeData.id, { apiKeyHeader: e.target.value })} className="w-full px-2 py-1.5 text-sm border rounded text-xs" />
                    </div>
                  </>
                )}

                <div className="border-t pt-2 mt-1">
                  <p className="text-xs font-medium text-gray-700 mb-2">Custom Endpoints</p>
                  <div>
                    <label className="block text-[12px] text-gray-500 mb-0.5">Upload Endpoint</label>
                    <input type="text" value={selectedNodeData.data?.uploadEndpoint || '/api/v1/process'} onChange={(e) => updateNodeData(selectedNodeData.id, { uploadEndpoint: e.target.value })} className="w-full px-2 py-1 text-xs border rounded font-mono" />
                  </div>
                  <div className="mt-1">
                    <label className="block text-[12px] text-gray-500 mb-0.5">Status Endpoint</label>
                    <input type="text" value={selectedNodeData.data?.statusEndpoint || '/api/v1/status/{taskId}'} onChange={(e) => updateNodeData(selectedNodeData.id, { statusEndpoint: e.target.value })} className="w-full px-2 py-1 text-xs border rounded font-mono" />
                  </div>
                  <div className="mt-1">
                    <label className="block text-[12px] text-gray-500 mb-0.5">Result Endpoint</label>
                    <input type="text" value={selectedNodeData.data?.resultEndpoint || '/api/v1/result/{taskId}'} onChange={(e) => updateNodeData(selectedNodeData.id, { resultEndpoint: e.target.value })} className="w-full px-2 py-1 text-xs border rounded font-mono" />
                  </div>
                </div>

                <div className="border-t pt-2 mt-1">
                  <p className="text-xs font-medium text-gray-700 mb-2">Polling</p>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-[12px] text-gray-500 mb-0.5">Interval (ms)</label>
                      <input type="number" value={selectedNodeData.data?.pollInterval || 5000} onChange={(e) => updateNodeData(selectedNodeData.id, { pollInterval: parseInt(e.target.value) })} className="w-full px-2 py-1 text-xs border rounded" />
                    </div>
                    <div>
                      <label className="block text-[12px] text-gray-500 mb-0.5">Max Wait (ms)</label>
                      <input type="number" value={selectedNodeData.data?.maxWaitTime || 300000} onChange={(e) => updateNodeData(selectedNodeData.id, { maxWaitTime: parseInt(e.target.value) })} className="w-full px-2 py-1 text-xs border rounded" />
                    </div>
                  </div>
                </div>

              </>
            )}

            {/* Data Admin config */}
            {selectedNodeData.type === 'data-admin' && (
              <>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Dataset Path</label>
                  <input
                    type="text"
                    value={selectedNodeData.data?.path || ''}
                    onChange={(e) => updateNodeData(selectedNodeData.id, { path: e.target.value })}
                    className="w-full px-2 py-1.5 text-sm border rounded font-mono text-xs"
                    placeholder="e.g. {{year}}/mis/customers"
                  />
                  <p className="text-[12px] text-gray-400 mt-1">
                    Supports: <code className="bg-gray-100 px-1">{'{{year}}'}</code> <code className="bg-gray-100 px-1">{'{{vars.xxx}}'}</code> or static <code className="bg-gray-100 px-1">ref/provinces</code>
                  </p>
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Additional WHERE Filter</label>
                  <input
                    type="text"
                    value={selectedNodeData.data?.where || ''}
                    onChange={(e) => updateNodeData(selectedNodeData.id, { where: e.target.value })}
                    className="w-full px-2 py-1.5 text-sm border rounded font-mono text-xs"
                    placeholder={`e.g. year = '{{vars.year}}'`}
                  />
                  <p className="text-[12px] text-gray-400 mt-1">Optional SQL WHERE clause (without WHERE keyword)</p>
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Max Rows</label>
                  <input
                    type="number"
                    value={selectedNodeData.data?.limit || 10000}
                    onChange={(e) => updateNodeData(selectedNodeData.id, { limit: parseInt(e.target.value) || 10000 })}
                    className="w-full px-2 py-1.5 text-sm border rounded text-xs"
                    min={1}
                    max={100000}
                  />
                </div>

                <div className="bg-violet-50 border border-violet-200 rounded-lg p-2.5 text-[12px] text-violet-700">
                  <p className="font-semibold mb-1">Output:</p>
                  <code className="block">{'{'} rows: [...], rowCount: N {'}'}</code>
                  <p className="mt-1 text-violet-500">Access: <code className="bg-violet-100 px-1">{'{{vars.' + (selectedNodeData.data?.varName || 'catalog1') + '.rows}}'}</code></p>
                </div>
              </>
            )}

            {/* Position */}
            <div className="pt-4 border-t">
              <p className="text-xs text-gray-500">Position</p>
              <p className="text-xs font-mono">X: {selectedNodeData.x}, Y: {selectedNodeData.y}</p>
            </div>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center text-gray-400 p-4 text-center">
            <div>
              <i className="fas fa-mouse-pointer text-3xl mb-2"></i>
              <p className="text-sm">Select a node to configure</p>
            </div>
          </div>
        )}
      </div>

      {/* SQL Editor Modal */}
      {sqlModalOpen && (
        <SqlEditorModal
          value={sqlModalValue}
          onChange={setSqlModalValue}
          onClose={closeSqlModal}
          onSave={saveSqlModal}
          title={sqlModalTitle}
        />
      )}
    </div>
  );
};

export default FlowDesigner;
