import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { FlowCanvas, NodeData, ConnectionData } from '../components/flow-designer/FlowCanvas';
import { Play, Save, ArrowLeft, Settings, Plus, Trash2 } from 'lucide-react';
import { API_URL, apiFetch } from '../config/api';
import { createId } from '@paralleldrive/cuid2';
import {
  TextInput, PasswordInput, Select, SelectItem, TextArea, Checkbox, IconButton,
  ComposedModal, ModalHeader, ModalBody, ModalFooter,
} from '@carbon/react';
import { Button } from '../components/ui/Button';

// Node type definitions
const nodeTypes = [
  { type: 'basket', label: 'Basket', color: 'bg-amber-500' },
  { type: 'sftp', label: 'SFTP', color: 'bg-green-500' },
  { type: 'database', label: 'Database', color: 'bg-purple-500' },
  { type: 'http-request', label: 'HTTP Request', color: 'bg-blue-500' },
  { type: 'trigger', label: 'Schedule', color: 'bg-red-500' },
  { type: 'transform', label: 'Transform', color: 'bg-cyan-500' },
  { type: 'file-write', label: 'File Write', color: 'bg-orange-500' },
];

// Node configuration forms
interface NodeConfigProps {
  node: NodeData;
  onChange: (config: Record<string, any>) => void;
  connections: { id: string; name: string; type?: string }[];
  baskets: { id: string; name: string; type?: string }[];
}

const BasketNodeConfig = ({ node, onChange, baskets }: NodeConfigProps) => (
  <div className="space-y-3">
    <div>
      <Select
        id="fds-select-basket-1"
        labelText="Select Basket"
        size="sm"
        value={node.config?.basketId || ''}
        onChange={(e) => onChange({ ...node.config, basketId: e.target.value })}
      >
        <SelectItem value="" text="Select basket..." />
        {baskets.map(b => (
          <SelectItem key={b.id} value={b.id} text={b.name} />
        ))}
      </Select>
    </div>
    <div>
      <TextInput
        id="fd-file-pattern-1"
        labelText="File Pattern"
        size="sm"
        value={node.config?.filePattern || '*'}
        onChange={(e) => onChange({ ...node.config, filePattern: e.target.value })}
        placeholder="*.pdf, *.txt"
      />
    </div>
    <div>
      <Select
        id="fds-action-2"
        labelText="Action"
        size="sm"
        value={node.config?.action || 'read'}
        onChange={(e) => onChange({ ...node.config, action: e.target.value })}
      >
        <SelectItem value="read" text="Read Files" />
        <SelectItem value="move" text="Read & Move to Processed" />
        <SelectItem value="delete" text="Read & Delete" />
      </Select>
    </div>
  </div>
);

const SFTPNodeConfig = ({ node, onChange, connections }: NodeConfigProps) => (
  <div className="space-y-3">
    <div>
      <Select
        id="fds-connection-3"
        labelText="Connection"
        size="sm"
        value={node.config?.connectionId || ''}
        onChange={(e) => onChange({ ...node.config, connectionId: e.target.value })}
      >
        <SelectItem value="" text="Select connection..." />
        {connections.filter(c => c.type === 'sftp').map(c => (
          <SelectItem key={c.id} value={c.id} text={c.name} />
        ))}
        <SelectItem value="custom" text="Custom Config..." />
      </Select>
    </div>
    
    {(!node.config?.connectionId || node.config?.connectionId === 'custom') && (
      <>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <TextInput
              id="fd-host-2"
              labelText="Host"
              size="sm"
              value={node.config?.host || ''}
              onChange={(e) => onChange({ ...node.config, host: e.target.value })}
              placeholder="localhost"
            />
          </div>
          <div>
            <TextInput
              id="fd-port-3"
              labelText="Port"
              size="sm"
              type="number"
              value={node.config?.port || '22'}
              onChange={(e) => onChange({ ...node.config, port: e.target.value })}
            />
          </div>
        </div>
        <div>
          <TextInput
            id="fd-username-4"
            labelText="Username"
            size="sm"
            value={node.config?.username || ''}
            onChange={(e) => onChange({ ...node.config, username: e.target.value })}
          />
        </div>
        <div>
          <PasswordInput
            id="fd-password-5"
            labelText="Password"
            size="sm"
            value={node.config?.password || ''}
            onChange={(e) => onChange({ ...node.config, password: e.target.value })}
          />
        </div>
      </>
    )}
    
    <div>
      <TextInput
        id="fd-remote-path-6"
        labelText="Remote Path"
        size="sm"
        value={node.config?.remotePath || '/upload'}
        onChange={(e) => onChange({ ...node.config, remotePath: e.target.value })}
        placeholder="/upload/incoming"
      />
    </div>
    <div>
      <Select
        id="fds-operation-4"
        labelText="Operation"
        size="sm"
        value={node.config?.operation || 'upload'}
        onChange={(e) => onChange({ ...node.config, operation: e.target.value })}
      >
        <SelectItem value="upload" text="Upload Files" />
        <SelectItem value="download" text="Download Files" />
        <SelectItem value="list" text="List Files Only" />
        <SelectItem value="delete" text="Delete Files" />
      </Select>
    </div>
  </div>
);

const TriggerNodeConfig = ({ node, onChange }: NodeConfigProps) => (
  <div className="space-y-3">
    <div>
      <Select
        id="fds-schedule-type-5"
        labelText="Schedule Type"
        size="sm"
        value={node.config?.scheduleType || 'cron'}
        onChange={(e) => onChange({ ...node.config, scheduleType: e.target.value })}
      >
        <SelectItem value="cron" text="Cron Expression" />
        <SelectItem value="interval" text="Interval (minutes)" />
        <SelectItem value="once" text="Run Once" />
        <SelectItem value="manual" text="Manual Trigger Only" />
      </Select>
    </div>
    
    {node.config?.scheduleType === 'cron' && (
      <div>
        <TextInput
          id="fd-cron-expression-7"
          labelText="Cron Expression"
          size="sm"
          value={node.config?.cron || '0 */5 * * * *'}
          onChange={(e) => onChange({ ...node.config, cron: e.target.value })}
          placeholder="0 */5 * * * * (every 5 min)"
        />
        <p className="text-xs text-gray-400 mt-1">sec min hour day month weekday</p>
      </div>
    )}
    
    {node.config?.scheduleType === 'interval' && (
      <div>
        <TextInput
          id="fd-interval-minutes-8"
          labelText="Interval (minutes)"
          size="sm"
          type="number"
          value={node.config?.interval || '5'}
          onChange={(e) => onChange({ ...node.config, interval: e.target.value })}
          min="1"
        />
      </div>
    )}
  </div>
);

const HttpNodeConfig = ({ node, onChange }: NodeConfigProps) => (
  <div className="space-y-3">
    <div>
      <Select
        id="fds-method-6"
        labelText="Method"
        size="sm"
        value={node.config?.method || 'GET'}
        onChange={(e) => onChange({ ...node.config, method: e.target.value })}
      >
        <SelectItem value="GET" text="GET" />
        <SelectItem value="POST" text="POST" />
        <SelectItem value="PUT" text="PUT" />
        <SelectItem value="DELETE" text="DELETE" />
        <SelectItem value="PATCH" text="PATCH" />
      </Select>
    </div>
    <div>
      <TextInput
        id="fd-url-9"
        labelText="URL"
        size="sm"
        value={node.config?.url || ''}
        onChange={(e) => onChange({ ...node.config, url: e.target.value })}
        placeholder="https://api.example.com/data"
      />
    </div>
    <div>
      <TextArea
        id="fd-headers-json-16"
        labelText="Headers (JSON)"
        value={node.config?.headers || '{}'}
        onChange={(e) => onChange({ ...node.config, headers: e.target.value })}
        rows={3}
        placeholder='{"Content-Type": "application/json"}'
      />
    </div>
    {node.config?.method !== 'GET' && (
      <div>
        <TextArea
          id="fd-body-json-17"
          labelText="Body (JSON)"
          value={node.config?.body || ''}
          onChange={(e) => onChange({ ...node.config, body: e.target.value })}
          rows={4}
          placeholder="{}"
        />
      </div>
    )}
  </div>
);

const TransformNodeConfig = ({ node, onChange }: NodeConfigProps) => {
  // State for modal editor
  const [showEditor, setShowEditor] = useState(false);
  const [tempCode, setTempCode] = useState(node.config?.code || '');

  return (
    <div className="space-y-4">
      {/* Code Editor */}
      <div>
        <div className="flex justify-between items-center mb-1">
          <label className="block text-xs font-medium text-gray-700">Transform Logic</label>
          <Button
            size="sm"
            onClick={() => {
              setTempCode(node.config?.code || '');
              setShowEditor(true);
            }}
            leftIcon={
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
            }
          >
            Open Editor
          </Button>
        </div>
        
        {/* Preview textarea (read-only, clickable to open editor) */}
        <div 
          onClick={() => {
            setTempCode(node.config?.code || '');
            setShowEditor(true);
          }}
          className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm font-mono text-xs bg-gray-50 cursor-pointer hover:bg-gray-100 min-h-[80px] max-h-[120px] overflow-hidden"
        >
          {node.config?.code ? (
            <pre className="m-0 whitespace-pre-wrap break-all">{node.config.code.slice(0, 200)}{node.config.code.length > 200 ? '...' : ''}</pre>
          ) : (
            <span className="text-gray-400 italic">// Click to open editor and write transform logic...</span>
          )}
        </div>
        
        <p className="text-xs text-gray-500 mt-1">
          Available: <code>input</code> (data from previous node), <code>vars</code> (set/get variables), <code>context</code> (execution context)
        </p>
      </div>

      {/* Modal Code Editor */}
      {showEditor && (
        <ComposedModal open onClose={() => setShowEditor(false)} size="lg">
            <ModalHeader
              title="Transform Logic Editor"
              label="Write JavaScript code to transform data. Press Ctrl+S to save."
            />
            <ModalBody className="flex flex-col h-[60vh] !p-0 !mb-0">
            
            {/* Editor Toolbar */}
            <div className="flex items-center gap-2 px-4 py-2 bg-gray-50 border-b border-gray-200">
              <span className="text-xs text-gray-600">Variables:</span>
              <code className="text-xs bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded">input</code>
              <code className="text-xs bg-green-100 text-green-700 px-1.5 py-0.5 rounded">vars.set(name, value)</code>
              <code className="text-xs bg-green-100 text-green-700 px-1.5 py-0.5 rounded">vars.get(name)</code>
              <code className="text-xs bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded">context</code>
            </div>
            
            {/* Code Editor */}
            <div className="flex-1 p-4">
              <TextArea
                id="fd-transform-code"
                labelText="Transform code"
                hideLabel
                rows={20}
                value={tempCode}
                onChange={(e) => setTempCode(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                    e.preventDefault();
                    onChange({ ...node.config, code: tempCode });
                    setShowEditor(false);
                  }
                }}
                className="font-mono"
                placeholder={`// Transform Logic Examples:

// 1. Simple data transformation
return input.map(item => ({
  ...item,
  processed: true
}));

// 2. NESDC JSON to Database Records
const stgRecords = [];
const stgGoalRecords = [];
const stgMapRecords = [];

// Process input data...

// Set variables for downstream nodes
vars.set('stgRecords', stgRecords);
vars.set('stgGoalRecords', stgGoalRecords);
vars.set('stgMapRecords', stgMapRecords);

return { stgCount: stgRecords.length, goalCount: stgGoalRecords.length };`}
                spellCheck={false}
              />
            </div>
            
            <div className="px-4 pb-2 text-xs text-gray-500">
              Tip: Use <kbd className="bg-gray-200 px-1 rounded">Ctrl</kbd>+<kbd className="bg-gray-200 px-1 rounded">S</kbd> to save
            </div>
            </ModalBody>
            <ModalFooter>
              <Button variant="secondary" onClick={() => setShowEditor(false)}>
                Cancel
              </Button>
              <Button
                onClick={() => {
                  onChange({ ...node.config, code: tempCode });
                  setShowEditor(false);
                }}
              >
                Save Changes
              </Button>
            </ModalFooter>
        </ComposedModal>
      )}
    </div>
  );
};

const FileWriteNodeConfig = ({ node, onChange, connections, baskets }: NodeConfigProps) => (
  <div className="space-y-3">
    <div>
      <Select
        id="fds-data-source-7"
        labelText="Data Source"
        size="sm"
        value={node.config?.dataSource || 'input'}
        onChange={(e) => onChange({ ...node.config, dataSource: e.target.value })}
      >
        <SelectItem value="input" text="From Input (previous node)" />
        <SelectItem value="template" text="Custom Template" />
      </Select>
    </div>

    {node.config?.dataSource === 'template' && (
      <div>
        <TextArea
          id="fd-template-content-18"
          labelText="Template Content"
          value={node.config?.template || ''}
          onChange={(e) => onChange({ ...node.config, template: e.target.value })}
          rows={3}
          placeholder="Enter template content..."
        />
      </div>
    )}

    <div>
      <Select
        id="fds-output-format-8"
        labelText="Output Format"
        size="sm"
        value={node.config?.format || 'csv'}
        onChange={(e) => onChange({ ...node.config, format: e.target.value })}
      >
        <SelectItem value="csv" text="CSV (Comma Separated)" />
        <SelectItem value="tsv" text="TSV (Tab Separated)" />
        <SelectItem value="delimited" text="Delimited Text" />
        <SelectItem value="json" text="JSON" />
        <SelectItem value="txt" text="Plain Text" />
      </Select>
    </div>

    {node.config?.format === 'delimited' && (
      <div>
        <Select
          id="fds-delimiter-9"
          labelText="Delimiter"
          size="sm"
          value={node.config?.delimiter || '|'}
          onChange={(e) => onChange({ ...node.config, delimiter: e.target.value })}
        >
          <SelectItem value="|" text="Pipe (|)" />
          <SelectItem value="," text="Comma (,)" />
          <SelectItem value="\t" text="Tab" />
          <SelectItem value=";" text="Semicolon (;)" />
        </Select>
      </div>
    )}

    <Checkbox
      id="includeHeader"
      labelText="Include Header Row"
      checked={node.config?.includeHeader !== false}
      onChange={(_e, { checked }) => onChange({ ...node.config, includeHeader: checked })}
    />

    <div>
      <TextInput
        id="fd-file-name-10"
        labelText="File Name"
        size="sm"
        value={node.config?.fileName || 'output_{{date}}.txt'}
        onChange={(e) => onChange({ ...node.config, fileName: e.target.value })}
        placeholder="output_{{date}}.txt"
      />
      <p className="text-xs text-gray-400 mt-1">
        Variables: timestamp, date, extension
      </p>
    </div>

    <div className="border-t border-gray-200 pt-3">
      <Select
        id="fds-destination-10"
        labelText="Destination"
        size="sm"
        value={node.config?.destination || 'basket'}
        onChange={(e) => onChange({ ...node.config, destination: e.target.value })}
      >
        <SelectItem value="basket" text="Basket (with Auto Session)" />
        <SelectItem value="sftp" text="SFTP Server" />
        <SelectItem value="local" text="Local Storage" />
      </Select>
    </div>

    {node.config?.destination === 'basket' && (
      <>
        <div>
          <Select
            id="fd-file-write-basket"
            size="sm"
            labelText={
              <>
                Select Basket{' '}
                {baskets.length > 0 && (
                  <span className="text-gray-400 font-normal">({baskets.length} available)</span>
                )}
              </>
            }
            value={node.config?.basketId || ''}
            onChange={(e) => {
              const selectedBasket = baskets.find(b => b.id === e.target.value);
              onChange({ 
                ...node.config, 
                basketId: e.target.value,
                basketType: selectedBasket?.type === 'shares' ? 'shares' : 'batch'
              });
            }}
            disabled={baskets.length === 0}
          >
            <SelectItem value="" text={baskets.length === 0 ? 'Loading baskets...' : 'Select a basket...'} />
            {baskets.map(b => (
              <SelectItem
                key={b.id}
                value={b.id}
                text={`${b.name} ${b.type === 'shares' ? '(Shares)' : (b.type === 'batch' ? '(Session)' : '')}`}
              />
            ))}
          </Select>
          {baskets.length === 0 && (
            <p className="text-xs text-amber-600 mt-1">
              No baskets found. Please create a basket first.
            </p>
          )}
        </div>

        {/* Show Folder selection for Shares basket */}
        {node.config?.basketId && node.config?.basketType === 'shares' && (
          <div>
            <TextInput
              id="fd-target-folder-11"
              labelText="Target Folder"
              size="sm"
              value={node.config?.targetFolder || ''}
              onChange={(e) => onChange({ ...node.config, targetFolder: e.target.value })}
              placeholder="e.g., /incoming, /data/2024"
            />
            <p className="text-xs text-gray-400 mt-1">
              Specify the folder path within the shares basket
            </p>
          </div>
        )}

        {/* Show Session Mode for Batch basket */}
        {node.config?.basketId && node.config?.basketType !== 'shares' && (
          <div>
            <Select
              id="fds-session-mode-11"
              labelText="Session Mode"
              size="sm"
              value={node.config?.sessionMode || 'always_new'}
              onChange={(e) => onChange({ ...node.config, sessionMode: e.target.value })}
            >
              <SelectItem value="always_new" text="Always Create New Session" />
              <SelectItem value="existing_or_new" text="Use Existing or Create New" />
              <SelectItem value="reuse_existing" text="Reuse Existing Only" />
            </Select>
            <p className="text-xs text-gray-400 mt-1">
              {node.config?.sessionMode === 'always_new' && 'Create a new session every time'}
              {node.config?.sessionMode === 'existing_or_new' && 'Use open session if available, else create new'}
              {node.config?.sessionMode === 'reuse_existing' && 'Fail if no open session exists'}
              {!node.config?.sessionMode && 'Create a new session every time'}
            </p>
          </div>
        )}
      </>
    )}

    {node.config?.destination === 'sftp' && (
      <>
        <div>
          <Select
            id="fds-sftp-connection-12"
            labelText="SFTP Connection"
            size="sm"
            value={node.config?.sftpConnectionId || ''}
            onChange={(e) => onChange({ ...node.config, sftpConnectionId: e.target.value })}
          >
            <SelectItem value="" text="Select connection..." />
            {connections.filter(c => c.type === 'sftp').map(c => (
              <SelectItem key={c.id} value={c.id} text={c.name} />
            ))}
          </Select>
        </div>
        <div>
          <TextInput
            id="fd-remote-path-12"
            labelText="Remote Path"
            size="sm"
            value={node.config?.sftpRemotePath || '/upload'}
            onChange={(e) => onChange({ ...node.config, sftpRemotePath: e.target.value })}
            placeholder="/upload/outgoing"
          />
        </div>
      </>
    )}

    {node.config?.destination === 'local' && (
      <div>
        <TextInput
          id="fd-local-path-13"
          labelText="Local Path"
          size="sm"
          value={node.config?.localPath || '/tmp'}
          onChange={(e) => onChange({ ...node.config, localPath: e.target.value })}
          placeholder="/data/outgoing"
        />
      </div>
    )}
  </div>
);

export const FlowDesigner = () => {
  const { flowId } = useParams();
  const navigate = useNavigate();
  const [nodes, setNodes] = useState<NodeData[]>([]);
  const [connections, setConnections] = useState<ConnectionData[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [flowName, setFlowName] = useState('Untitled Flow');
  const [projectId, setProjectId] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  
  // Data for dropdowns
  const [connectionsList, setConnectionsList] = useState<any[]>([]);
  const [basketsList, setBasketsList] = useState<Array<{ id: string; name: string; type?: string }>>([]);

  // Fetch flow data
  useEffect(() => {
    if (flowId) {
      fetchFlow();
    }
  }, [flowId]);

  // Fetch connections and baskets when projectId is available
  useEffect(() => {
    if (projectId) {
      fetchConnections();
      fetchBaskets();
    }
  }, [projectId]);

  const fetchFlow = async () => {
    try {
      const response = await fetch(`${API_URL}/flows/${flowId}`);
      const result = await response.json();
      if (result.success && result.data) {
        setFlowName(result.data.name);
        setProjectId(result.data.projectId);
        
        // Safely parse nodes (handle double-stringified data)
        let parsedNodes = [];
        try {
          let nodesData = result.data.nodes || '[]';
          // First parse if it's a string
          if (typeof nodesData === 'string') {
            nodesData = JSON.parse(nodesData);
          }
          // If still string (double-stringified), parse again
          if (typeof nodesData === 'string') {
            nodesData = JSON.parse(nodesData);
          }
          parsedNodes = Array.isArray(nodesData) ? nodesData : [];
        } catch (e) {
          console.error('Error parsing nodes:', e);
          parsedNodes = [];
        }
        
        // Safely parse connections (handle double-stringified data)
        let parsedConnections = [];
        try {
          let connData = result.data.connections || '[]';
          // First parse if it's a string
          if (typeof connData === 'string') {
            connData = JSON.parse(connData);
          }
          // If still string (double-stringified), parse again
          if (typeof connData === 'string') {
            connData = JSON.parse(connData);
          }
          parsedConnections = Array.isArray(connData) ? connData : [];
        } catch (e) {
          console.error('Error parsing connections:', e);
          parsedConnections = [];
        }
        
        setNodes(parsedNodes);
        setConnections(parsedConnections);
      }
    } catch (error) {
      console.error('Error fetching flow:', error);
    }
  };

  const fetchConnections = async () => {
    // Fetch from project connections
    if (projectId) {
      try {
        const response = await fetch(`${API_URL}/projects/${projectId}`);
        const result = await response.json();
        if (result.success) {
          setConnectionsList(result.data.connections || []);
        }
      } catch (error) {
        console.error('Error fetching connections:', error);
      }
    }
  };

  const fetchBaskets = async () => {
    if (projectId) {
      try {
        const response = await fetch(`${API_URL}/baskets?projectId=${projectId}`);
        const result = await response.json();
        if (result.success) {
          setBasketsList(result.data || []);
        }
      } catch (error) {
        console.error('Error fetching baskets:', error);
      }
    }
  };

  // Add new node
  const addNode = (type: string) => {
    const newNode: NodeData = {
      id: createId(),
      type,
      x: 100 + Math.random() * 200,
      y: 100 + Math.random() * 200,
      label: nodeTypes.find(n => n.type === type)?.label || type,
      config: {}
    };
    setNodes([...nodes, newNode]);
  };

  // Update node config
  const updateNodeConfig = (nodeId: string, config: Record<string, any>) => {
    setNodes(nodes.map(n => 
      n.id === nodeId ? { ...n, config } : n
    ));
  };

  // Save flow
  const saveFlow = async () => {
    if (!flowId) return;
    setSaving(true);
    try {
      // Convert fromNodeId/toNodeId to source/target format
      const apiConnections = connections.map(c => ({
        id: c.id,
        source: c.fromNodeId,
        target: c.toNodeId,
      }));
      await apiFetch(`${API_URL}/flows/${flowId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nodes: JSON.stringify(nodes),
          connections: JSON.stringify(apiConnections)
        })
      });
      alert('Flow saved!');
    } catch (error) {
      console.error('Error saving flow:', error);
    } finally {
      setSaving(false);
    }
  };

  // Run flow
  const runFlow = async () => {
    if (!flowId) return;
    setRunning(true);
    try {
      const response = await fetch(`${API_URL}/flows/${flowId}/execute`, {
        method: 'POST'
      });
      const result = await response.json();
      alert(result.message || 'Flow executed!');
    } catch (error) {
      console.error('Error running flow:', error);
    } finally {
      setRunning(false);
    }
  };

  // Delete selected node
  const deleteSelectedNode = () => {
    if (selectedNodeId) {
      setNodes(nodes.filter(n => n.id !== selectedNodeId));
      setConnections(connections.filter(c => 
        c.fromNodeId !== selectedNodeId && c.toNodeId !== selectedNodeId
      ));
      setSelectedNodeId(null);
    }
  };

  const selectedNode = nodes.find(n => n.id === selectedNodeId);

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <IconButton kind="ghost" size="md" label="Back" onClick={() => navigate(-1)}>
            <ArrowLeft className="h-5 w-5 text-gray-600" />
          </IconButton>
          <div>
            <h1 className="text-lg font-semibold text-gray-900">{flowName}</h1>
            <p className="text-xs text-gray-500">Drag nodes, connect handles from any side</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="danger" onClick={deleteSelectedNode} disabled={!selectedNodeId} leftIcon={<Trash2 className="h-4 w-4" />}>
            Delete Node
          </Button>
          <Button variant="secondary" onClick={saveFlow} disabled={saving} leftIcon={<Save className="h-4 w-4" />}>
            {saving ? 'Saving...' : 'Save'}
          </Button>
          <Button onClick={runFlow} disabled={running} leftIcon={<Play className="h-4 w-4" />}>
            {running ? 'Running...' : 'Run'}
          </Button>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Node Palette */}
        <div className="w-56 bg-white border-r border-gray-200 flex flex-col">
          <div className="p-3 border-b border-gray-200">
            <h3 className="font-medium text-gray-900 flex items-center gap-2">
              <Plus className="h-4 w-4" />
              Add Node
            </h3>
          </div>
          <div className="flex-1 overflow-auto p-2 space-y-1">
            {nodeTypes.map(({ type, label, color }) => (
              <button
                key={type}
                onClick={() => addNode(type)}
                className="w-full flex items-center gap-3 p-2 rounded-lg hover:bg-gray-50 border border-transparent hover:border-gray-200 transition-all"
              >
                <div className={`w-8 h-8 ${color} rounded-lg flex items-center justify-center`}>
                  <span className="text-white text-xs font-bold">{label[0]}</span>
                </div>
                <span className="text-sm text-gray-700">{label}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Canvas */}
        <div className="flex-1 relative">
          <FlowCanvas
            nodes={nodes}
            connections={connections}
            onNodesChange={setNodes}
            onConnectionsChange={setConnections}
            onNodeSelect={setSelectedNodeId}
            selectedNodeId={selectedNodeId}
          />
        </div>

        {/* Properties Panel */}
        <div className="w-72 bg-white border-l border-gray-200 flex flex-col">
          <div className="p-3 border-b border-gray-200">
            <h3 className="font-medium text-gray-900 flex items-center gap-2">
              <Settings className="h-4 w-4" />
              Properties
            </h3>
          </div>
          <div className="flex-1 overflow-auto p-4">
            {selectedNode ? (
              <div className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Node Type</label>
                  <div className="text-sm font-medium text-gray-900">
                    {nodeTypes.find(n => n.type === selectedNode.type)?.label || selectedNode.type}
                  </div>
                </div>
                <div>
                  <TextInput
                    id="fd-id-14"
                    labelText="ID"
                    size="sm"
                    value={selectedNode.config?.varName || ''}
                    onChange={(e) => {
                      const val = e.target.value.replace(/[^a-zA-Z0-9]/g, '');
                      updateNodeConfig(selectedNode.id, { ...selectedNode.config, varName: val });
                    }}
                    className="font-mono"
                    invalid={!!(selectedNode.config?.varName && nodes.some(n => n.id !== selectedNode.id && n.config?.varName === selectedNode.config?.varName))}
                    placeholder="e.g. db1, http1"
                  />
                  {selectedNode.config?.varName && nodes.some(n => n.id !== selectedNode.id && n.config?.varName === selectedNode.config?.varName) && (
                    <p className="text-[12px] text-red-500 mt-0.5">ID ซ้ำกับ node อื่น</p>
                  )}
                  <p className="text-[12px] text-gray-400 mt-0.5">ใช้อ้างอิง: <code className="bg-gray-100 px-1">{`{{${selectedNode.config?.varName || 'id'}.rows}}`}</code></p>
                </div>
                <div>
                  <TextInput
                    id="fd-label-15"
                    labelText="Label"
                    size="sm"
                    value={selectedNode.label}
                    onChange={(e) => {
                      setNodes(nodes.map(n =>
                        n.id === selectedNode.id ? { ...n, label: e.target.value } : n
                      ));
                    }}
                  />
                </div>

                {/* Node-specific config */}
                <div className="border-t border-gray-200 pt-4">
                  <h4 className="text-sm font-medium text-gray-900 mb-3">Configuration</h4>
                  {selectedNode.type === 'basket' && (
                    <BasketNodeConfig
                      node={selectedNode}
                      onChange={(config) => updateNodeConfig(selectedNode.id, config)}
                      connections={connectionsList}
                      baskets={basketsList}
                    />
                  )}
                  {selectedNode.type === 'sftp' && (
                    <SFTPNodeConfig
                      node={selectedNode}
                      onChange={(config) => updateNodeConfig(selectedNode.id, config)}
                      connections={connectionsList}
                      baskets={basketsList}
                    />
                  )}
                  {selectedNode.type === 'trigger' && (
                    <TriggerNodeConfig
                      node={selectedNode}
                      onChange={(config) => updateNodeConfig(selectedNode.id, config)}
                      connections={connectionsList}
                      baskets={basketsList}
                    />
                  )}
                  {selectedNode.type === 'http-request' && (
                    <HttpNodeConfig
                      node={selectedNode}
                      onChange={(config) => updateNodeConfig(selectedNode.id, config)}
                      connections={connectionsList}
                      baskets={basketsList}
                    />
                  )}
                  {selectedNode.type === 'transform' && (
                    <TransformNodeConfig
                      node={selectedNode}
                      onChange={(config) => updateNodeConfig(selectedNode.id, config)}
                      connections={connectionsList}
                      baskets={basketsList}
                    />
                  )}
                  {selectedNode.type === 'file-write' && (
                    <FileWriteNodeConfig
                      node={selectedNode}
                      onChange={(config) => updateNodeConfig(selectedNode.id, config)}
                      connections={connectionsList}
                      baskets={basketsList}
                    />
                  )}
                </div>
              </div>
            ) : (
              <div className="text-center text-gray-400 py-8">
                <Settings className="h-12 w-12 mx-auto mb-2" />
                <p className="text-sm">Select a node to configure</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default FlowDesigner;
