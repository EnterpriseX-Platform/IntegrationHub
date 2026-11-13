import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { FlowCanvas, NodeData, ConnectionData } from '../components/flow-designer/FlowCanvas';
import { Play, Save, ArrowLeft, Settings, Plus, Trash2 } from 'lucide-react';
import { API_URL, apiFetch } from '../config/api';
import { createId } from '@paralleldrive/cuid2';

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
      <label className="block text-xs font-medium text-gray-500 mb-1">Select Basket</label>
      <select
        value={node.config?.basketId || ''}
        onChange={(e) => onChange({ ...node.config, basketId: e.target.value })}
        className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm"
      >
        <option value="">Select basket...</option>
        {baskets.map(b => (
          <option key={b.id} value={b.id}>{b.name}</option>
        ))}
      </select>
    </div>
    <div>
      <label className="block text-xs font-medium text-gray-500 mb-1">File Pattern</label>
      <input
        type="text"
        value={node.config?.filePattern || '*'}
        onChange={(e) => onChange({ ...node.config, filePattern: e.target.value })}
        className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm"
        placeholder="*.pdf, *.txt"
      />
    </div>
    <div>
      <label className="block text-xs font-medium text-gray-500 mb-1">Action</label>
      <select
        value={node.config?.action || 'read'}
        onChange={(e) => onChange({ ...node.config, action: e.target.value })}
        className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm"
      >
        <option value="read">Read Files</option>
        <option value="move">Read & Move to Processed</option>
        <option value="delete">Read & Delete</option>
      </select>
    </div>
  </div>
);

const SFTPNodeConfig = ({ node, onChange, connections }: NodeConfigProps) => (
  <div className="space-y-3">
    <div>
      <label className="block text-xs font-medium text-gray-500 mb-1">Connection</label>
      <select
        value={node.config?.connectionId || ''}
        onChange={(e) => onChange({ ...node.config, connectionId: e.target.value })}
        className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm"
      >
        <option value="">Select connection...</option>
        {connections.filter(c => c.type === 'sftp').map(c => (
          <option key={c.id} value={c.id}>{c.name}</option>
        ))}
        <option value="custom">Custom Config...</option>
      </select>
    </div>
    
    {(!node.config?.connectionId || node.config?.connectionId === 'custom') && (
      <>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Host</label>
            <input
              type="text"
              value={node.config?.host || ''}
              onChange={(e) => onChange({ ...node.config, host: e.target.value })}
              className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm"
              placeholder="localhost"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Port</label>
            <input
              type="number"
              value={node.config?.port || '22'}
              onChange={(e) => onChange({ ...node.config, port: e.target.value })}
              className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm"
            />
          </div>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Username</label>
          <input
            type="text"
            value={node.config?.username || ''}
            onChange={(e) => onChange({ ...node.config, username: e.target.value })}
            className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Password</label>
          <input
            type="password"
            value={node.config?.password || ''}
            onChange={(e) => onChange({ ...node.config, password: e.target.value })}
            className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm"
          />
        </div>
      </>
    )}
    
    <div>
      <label className="block text-xs font-medium text-gray-500 mb-1">Remote Path</label>
      <input
        type="text"
        value={node.config?.remotePath || '/upload'}
        onChange={(e) => onChange({ ...node.config, remotePath: e.target.value })}
        className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm"
        placeholder="/upload/incoming"
      />
    </div>
    <div>
      <label className="block text-xs font-medium text-gray-500 mb-1">Operation</label>
      <select
        value={node.config?.operation || 'upload'}
        onChange={(e) => onChange({ ...node.config, operation: e.target.value })}
        className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm"
      >
        <option value="upload">Upload Files</option>
        <option value="download">Download Files</option>
        <option value="list">List Files Only</option>
        <option value="delete">Delete Files</option>
      </select>
    </div>
  </div>
);

const TriggerNodeConfig = ({ node, onChange }: NodeConfigProps) => (
  <div className="space-y-3">
    <div>
      <label className="block text-xs font-medium text-gray-500 mb-1">Schedule Type</label>
      <select
        value={node.config?.scheduleType || 'cron'}
        onChange={(e) => onChange({ ...node.config, scheduleType: e.target.value })}
        className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm"
      >
        <option value="cron">Cron Expression</option>
        <option value="interval">Interval (minutes)</option>
        <option value="once">Run Once</option>
        <option value="manual">Manual Trigger Only</option>
      </select>
    </div>
    
    {node.config?.scheduleType === 'cron' && (
      <div>
        <label className="block text-xs font-medium text-gray-500 mb-1">Cron Expression</label>
        <input
          type="text"
          value={node.config?.cron || '0 */5 * * * *'}
          onChange={(e) => onChange({ ...node.config, cron: e.target.value })}
          className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm"
          placeholder="0 */5 * * * * (every 5 min)"
        />
        <p className="text-xs text-gray-400 mt-1">sec min hour day month weekday</p>
      </div>
    )}
    
    {node.config?.scheduleType === 'interval' && (
      <div>
        <label className="block text-xs font-medium text-gray-500 mb-1">Interval (minutes)</label>
        <input
          type="number"
          value={node.config?.interval || '5'}
          onChange={(e) => onChange({ ...node.config, interval: e.target.value })}
          className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm"
          min="1"
        />
      </div>
    )}
  </div>
);

const HttpNodeConfig = ({ node, onChange }: NodeConfigProps) => (
  <div className="space-y-3">
    <div>
      <label className="block text-xs font-medium text-gray-500 mb-1">Method</label>
      <select
        value={node.config?.method || 'GET'}
        onChange={(e) => onChange({ ...node.config, method: e.target.value })}
        className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm"
      >
        <option value="GET">GET</option>
        <option value="POST">POST</option>
        <option value="PUT">PUT</option>
        <option value="DELETE">DELETE</option>
        <option value="PATCH">PATCH</option>
      </select>
    </div>
    <div>
      <label className="block text-xs font-medium text-gray-500 mb-1">URL</label>
      <input
        type="text"
        value={node.config?.url || ''}
        onChange={(e) => onChange({ ...node.config, url: e.target.value })}
        className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm"
        placeholder="https://api.example.com/data"
      />
    </div>
    <div>
      <label className="block text-xs font-medium text-gray-500 mb-1">Headers (JSON)</label>
      <textarea
        value={node.config?.headers || '{}'}
        onChange={(e) => onChange({ ...node.config, headers: e.target.value })}
        className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm font-mono text-xs"
        rows={3}
        placeholder='{"Content-Type": "application/json"}'
      />
    </div>
    {node.config?.method !== 'GET' && (
      <div>
        <label className="block text-xs font-medium text-gray-500 mb-1">Body (JSON)</label>
        <textarea
          value={node.config?.body || ''}
          onChange={(e) => onChange({ ...node.config, body: e.target.value })}
          className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm font-mono text-xs"
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
          <button
            onClick={() => {
              setTempCode(node.config?.code || '');
              setShowEditor(true);
            }}
            className="px-2 h-8 bg-blue-600 text-white text-[13px] rounded hover:bg-blue-700 flex items-center gap-1 whitespace-nowrap"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
            Open Editor
          </button>
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
        <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-4xl h-[80vh] flex flex-col">
            {/* Modal Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
              <div>
                <h3 className="text-lg font-semibold text-gray-900">Transform Logic Editor</h3>
                <p className="text-xs text-gray-500">Write JavaScript code to transform data. Press Ctrl+S to save.</p>
              </div>
              <button
                onClick={() => setShowEditor(false)}
                className="text-gray-400 hover:text-gray-600"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            
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
              <textarea
                value={tempCode}
                onChange={(e) => setTempCode(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                    e.preventDefault();
                    onChange({ ...node.config, code: tempCode });
                    setShowEditor(false);
                  }
                }}
                className="w-full h-full px-4 py-3 border border-gray-300 rounded-lg text-sm font-mono resize-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
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
            
            {/* Modal Footer */}
            <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200 bg-gray-50">
              <div className="text-xs text-gray-500">
                Tip: Use <kbd className="bg-gray-200 px-1 rounded">Ctrl</kbd>+<kbd className="bg-gray-200 px-1 rounded">S</kbd> to save
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowEditor(false)}
                  className="inline-flex items-center justify-center px-3.5 h-9 text-[14px] text-gray-700 hover:bg-gray-100 rounded whitespace-nowrap"
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    onChange({ ...node.config, code: tempCode });
                    setShowEditor(false);
                  }}
                  className="inline-flex items-center justify-center px-3.5 h-9 text-[14px] bg-blue-600 text-white rounded hover:bg-blue-700 whitespace-nowrap"
                >
                  Save Changes
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

const FileWriteNodeConfig = ({ node, onChange, connections, baskets }: NodeConfigProps) => (
  <div className="space-y-3">
    <div>
      <label className="block text-xs font-medium text-gray-500 mb-1">Data Source</label>
      <select
        value={node.config?.dataSource || 'input'}
        onChange={(e) => onChange({ ...node.config, dataSource: e.target.value })}
        className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm"
      >
        <option value="input">From Input (previous node)</option>
        <option value="template">Custom Template</option>
      </select>
    </div>

    {node.config?.dataSource === 'template' && (
      <div>
        <label className="block text-xs font-medium text-gray-500 mb-1">Template Content</label>
        <textarea
          value={node.config?.template || ''}
          onChange={(e) => onChange({ ...node.config, template: e.target.value })}
          className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm"
          rows={3}
          placeholder="Enter template content..."
        />
      </div>
    )}

    <div>
      <label className="block text-xs font-medium text-gray-500 mb-1">Output Format</label>
      <select
        value={node.config?.format || 'csv'}
        onChange={(e) => onChange({ ...node.config, format: e.target.value })}
        className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm"
      >
        <option value="csv">CSV (Comma Separated)</option>
        <option value="tsv">TSV (Tab Separated)</option>
        <option value="delimited">Delimited Text</option>
        <option value="json">JSON</option>
        <option value="txt">Plain Text</option>
      </select>
    </div>

    {node.config?.format === 'delimited' && (
      <div>
        <label className="block text-xs font-medium text-gray-500 mb-1">Delimiter</label>
        <select
          value={node.config?.delimiter || '|'}
          onChange={(e) => onChange({ ...node.config, delimiter: e.target.value })}
          className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm"
        >
          <option value="|">Pipe (|)</option>
          <option value=",">Comma (,)</option>
          <option value="\t">Tab</option>
          <option value=";">Semicolon (;)</option>
        </select>
      </div>
    )}

    <div className="flex items-center gap-2">
      <input
        type="checkbox"
        id="includeHeader"
        checked={node.config?.includeHeader !== false}
        onChange={(e) => onChange({ ...node.config, includeHeader: e.target.checked })}
        className="rounded border-gray-300"
      />
      <label htmlFor="includeHeader" className="text-xs text-gray-600">Include Header Row</label>
    </div>

    <div>
      <label className="block text-xs font-medium text-gray-500 mb-1">File Name</label>
      <input
        type="text"
        value={node.config?.fileName || 'output_{{date}}.txt'}
        onChange={(e) => onChange({ ...node.config, fileName: e.target.value })}
        className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm"
        placeholder="output_{{date}}.txt"
      />
      <p className="text-xs text-gray-400 mt-1">
        Variables: timestamp, date, extension
      </p>
    </div>

    <div className="border-t border-gray-200 pt-3">
      <label className="block text-xs font-medium text-gray-500 mb-1">Destination</label>
      <select
        value={node.config?.destination || 'basket'}
        onChange={(e) => onChange({ ...node.config, destination: e.target.value })}
        className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm"
      >
        <option value="basket">Basket (with Auto Session)</option>
        <option value="sftp">SFTP Server</option>
        <option value="local">Local Storage</option>
      </select>
    </div>

    {node.config?.destination === 'basket' && (
      <>
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">
            Select Basket 
            {baskets.length > 0 && (
              <span className="text-gray-400 font-normal">({baskets.length} available)</span>
            )}
          </label>
          <select
            value={node.config?.basketId || ''}
            onChange={(e) => {
              const selectedBasket = baskets.find(b => b.id === e.target.value);
              onChange({ 
                ...node.config, 
                basketId: e.target.value,
                basketType: selectedBasket?.type === 'shares' ? 'shares' : 'batch'
              });
            }}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 bg-white"
            disabled={baskets.length === 0}
          >
            <option value="">{baskets.length === 0 ? 'Loading baskets...' : 'Select a basket...'}</option>
            {baskets.map(b => (
              <option key={b.id} value={b.id}>
                {b.name} {b.type === 'shares' ? '(Shares)' : (b.type === 'batch' ? '(Session)' : '')}
              </option>
            ))}
          </select>
          {baskets.length === 0 && (
            <p className="text-xs text-amber-600 mt-1">
              No baskets found. Please create a basket first.
            </p>
          )}
        </div>

        {/* Show Folder selection for Shares basket */}
        {node.config?.basketId && node.config?.basketType === 'shares' && (
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Target Folder</label>
            <input
              type="text"
              value={node.config?.targetFolder || ''}
              onChange={(e) => onChange({ ...node.config, targetFolder: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
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
            <label className="block text-xs font-medium text-gray-500 mb-1">Session Mode</label>
            <select
              value={node.config?.sessionMode || 'always_new'}
              onChange={(e) => onChange({ ...node.config, sessionMode: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 bg-white"
            >
              <option value="always_new">Always Create New Session</option>
              <option value="existing_or_new">Use Existing or Create New</option>
              <option value="reuse_existing">Reuse Existing Only</option>
            </select>
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
          <label className="block text-xs font-medium text-gray-500 mb-1">SFTP Connection</label>
          <select
            value={node.config?.sftpConnectionId || ''}
            onChange={(e) => onChange({ ...node.config, sftpConnectionId: e.target.value })}
            className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm"
          >
            <option value="">Select connection...</option>
            {connections.filter(c => c.type === 'sftp').map(c => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Remote Path</label>
          <input
            type="text"
            value={node.config?.sftpRemotePath || '/upload'}
            onChange={(e) => onChange({ ...node.config, sftpRemotePath: e.target.value })}
            className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm"
            placeholder="/upload/outgoing"
          />
        </div>
      </>
    )}

    {node.config?.destination === 'local' && (
      <div>
        <label className="block text-xs font-medium text-gray-500 mb-1">Local Path</label>
        <input
          type="text"
          value={node.config?.localPath || '/tmp'}
          onChange={(e) => onChange({ ...node.config, localPath: e.target.value })}
          className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm"
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
    <div className="h-screen flex flex-col">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <button 
            onClick={() => navigate(-1)}
            className="p-2 hover:bg-gray-100 rounded-lg"
          >
            <ArrowLeft className="h-5 w-5 text-gray-600" />
          </button>
          <div>
            <h1 className="text-lg font-semibold text-gray-900">{flowName}</h1>
            <p className="text-xs text-gray-500">Drag nodes, connect handles from any side</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={deleteSelectedNode}
            disabled={!selectedNodeId}
            className="flex items-center gap-2 px-3 h-9 border border-red-300 text-red-600 rounded-lg hover:bg-red-50 disabled:opacity-50 whitespace-nowrap"
          >
            <Trash2 className="h-4 w-4" />
            Delete Node
          </button>
          <button
            onClick={saveFlow}
            disabled={saving}
            className="flex items-center gap-2 px-3 h-9 border border-gray-300 rounded-lg hover:bg-gray-50 whitespace-nowrap"
          >
            <Save className="h-4 w-4" />
            {saving ? 'Saving...' : 'Save'}
          </button>
          <button
            onClick={runFlow}
            disabled={running}
            className="flex items-center gap-2 px-3 h-9 rounded-lg whitespace-nowrap bg-blue-600 text-white hover:bg-blue-700"
          >
            <Play className="h-4 w-4" />
            {running ? 'Running...' : 'Run'}
          </button>
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
                  <label className="block text-xs font-medium text-gray-500 mb-1">ID</label>
                  <input
                    type="text"
                    value={selectedNode.config?.varName || ''}
                    onChange={(e) => {
                      const val = e.target.value.replace(/[^a-zA-Z0-9]/g, '');
                      updateNodeConfig(selectedNode.id, { ...selectedNode.config, varName: val });
                    }}
                    className={`w-full px-2 py-1.5 border border-gray-300 rounded text-sm font-mono ${
                      selectedNode.config?.varName && nodes.some(n => n.id !== selectedNode.id && n.config?.varName === selectedNode.config?.varName)
                        ? 'border-red-400 bg-red-50' : ''
                    }`}
                    placeholder="e.g. db1, http1"
                  />
                  {selectedNode.config?.varName && nodes.some(n => n.id !== selectedNode.id && n.config?.varName === selectedNode.config?.varName) && (
                    <p className="text-[10px] text-red-500 mt-0.5">ID ซ้ำกับ node อื่น</p>
                  )}
                  <p className="text-[10px] text-gray-400 mt-0.5">ใช้อ้างอิง: <code className="bg-gray-100 px-1">{`{{${selectedNode.config?.varName || 'id'}.rows}}`}</code></p>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Label</label>
                  <input
                    type="text"
                    value={selectedNode.label}
                    onChange={(e) => {
                      setNodes(nodes.map(n =>
                        n.id === selectedNode.id ? { ...n, label: e.target.value } : n
                      ));
                    }}
                    className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm"
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
