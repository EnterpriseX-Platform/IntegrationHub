import { useState, useEffect, useMemo, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ChevronDown, Globe } from 'lucide-react';
import { Button } from '../components/ui/Button';
import { OpenApiSpecEditor, type OpenApiSpec } from '../components/flow/OpenApiSpecEditor';
import { FlowDesigner } from '../components/flow/FlowDesigner';
import { nodeRegistry } from '../lib/flow-sdk/nodeRegistry';
import { registerAllNodes } from '../lib/flow-sdk/nodes';
import { specToOpenApiYaml } from '../utils/YAMLGenerator';
import { API_URL, PUBLIC_API_ROOT, apiFetch } from '../config/api';
import VariablesPanel from '../components/flow-designer/VariablesPanel';

// Initialize node registry
registerAllNodes();

// Types
interface APIOperation {
  id: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  path: string;
  summary: string;
  description?: string;
  apiSpecId?: string;
  parameters?: any[];
  requestBody?: any;
  responses?: any[];
}

interface APISpec {
  openapi: string;
  info: {
    title: string;
    version: string;
    description?: string;
  };
  servers: { url: string; description?: string }[];
  operations: APIOperation[];
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
}

interface OperationFlow {
  operationId: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
}

interface Connection {
  id: string;
  name: string;
  type: string;
  status: string;
}

const DEFAULT_SPEC: APISpec = {
  openapi: '3.0.3',
  info: {
    title: 'New API',
    version: '1.0.0',
    description: '',
  },
  servers: [{ url: `${API_URL}/v1` }],
  operations: [],
};

export const ApiFlowDesigner = () => {
  const { flowId, id: projectId } = useParams();
  const navigate = useNavigate();
  
  const [activeTab, setActiveTab] = useState<'spec' | 'designer' | 'test' | 'deploy'>('spec');
  const [isLoading, setIsLoading] = useState(false);
  const [connections, setConnections] = useState<Connection[]>([]);
  
  const [apiSpec, setApiSpec] = useState<APISpec>(DEFAULT_SPEC);
  const [operationFlows, setOperationFlows] = useState<Record<string, OperationFlow>>({});
  const [selectedOp, setSelectedOp] = useState<string>('');
  const [flowName, setFlowName] = useState('');
  const [requireApiKey, setRequireApiKey] = useState(true);

  // Load flow data
  useEffect(() => {
    if (flowId && projectId) {
      loadFlow();
      loadConnections();
    }
  }, [flowId, projectId]);

  const loadConnections = async () => {
    try {
      const res = await fetch(`${API_URL}/projects/${projectId}`);
      const data = await res.json();
      if (data.success) {
        setConnections(data.data.connections || []);
      }
    } catch (e) {
      console.error('Error loading connections:', e);
    }
  };

  const loadFlow = async () => {
    try {
      const res = await fetch(`${API_URL}/flows/${flowId}`);
      const data = await res.json();
      if (data.success) {
        const flow = data.data;
        setFlowName(flow.name);
        
        let config: any = {};
        if (flow.config) {
          try {
            config = typeof flow.config === 'string' ? JSON.parse(flow.config) : flow.config;
          } catch (e) {
            console.error('Error parsing config:', e);
          }
        }
        
        if (config.apiSpec) {
          setApiSpec(config.apiSpec);
        }
        if (config.deployment) {
          setRequireApiKey(config.deployment.requireApiKey ?? true);
        }
        if (config.operationFlows) {
          // Convert nodes from database format (position: {x, y}) to FlowDesigner format (x, y)
          const convertedFlows: Record<string, OperationFlow> = {};
          Object.entries(config.operationFlows).forEach(([key, flowData]: [string, any]) => {
            convertedFlows[key] = {
              operationId: flowData.operationId,
              nodes: (flowData.nodes || []).map((node: any) => ({
                id: node.id,
                type: node.type,
                x: node.position?.x ?? node.x ?? 0,
                y: node.position?.y ?? node.y ?? 0,
                data: node.data || {},
              })),
              edges: flowData.edges || [],
            };
          });
          setOperationFlows(convertedFlows);
          const firstOp = Object.keys(convertedFlows)[0];
          if (firstOp) setSelectedOp(firstOp);
        }
      }
    } catch (e) {
      console.error('Error loading flow:', e);
    }
  };

  const saveFlow = async () => {
    setIsLoading(true);
    try {
      await apiFetch(`${API_URL}/flows/${flowId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          config: { apiSpec, operationFlows }
        }),
      });
    } catch (e) {
      console.error('Error saving:', e);
    }
    setIsLoading(false);
  };

  const deployAPI = async () => {
    try {
      const res = await fetch(`${API_URL}/flows/${flowId}/deploy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiSpec, operationFlows }),
      });
      const data = await res.json();
      if (data.success) {
        alert(`API Deployed!\n${data.data.operations.map((o: any) => `${o.method} ${o.path}`).join('\n')}`);
      }
    } catch (e) {
      alert('Deploy failed');
    }
  };

  const currentFlow = useMemo(() => {
    return operationFlows[selectedOp] || { operationId: selectedOp, nodes: [], edges: [] };
  }, [operationFlows, selectedOp]);

  const handleFlowChange = (newFlow: { nodes: FlowNode[]; edges: FlowEdge[] }) => {
    setOperationFlows(prev => ({
      ...prev,
      [selectedOp]: { operationId: selectedOp, nodes: newFlow.nodes, edges: newFlow.edges }
    }));
  };

  const getMethodColor = (method: string) => {
    const colors: Record<string, string> = {
      GET: 'bg-blue-500',
      POST: 'bg-green-500',
      PUT: 'bg-yellow-500',
      DELETE: 'bg-red-500',
      PATCH: 'bg-purple-500',
    };
    return colors[method] || 'bg-gray-500';
  };

  // Operation Selector Component
  const OperationSelector = () => {
    const [isOpen, setIsOpen] = useState(false);
    const dropdownRef = useRef<HTMLDivElement>(null);
    const selectedOperation = apiSpec.operations.find(o => o.id === selectedOp);

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
          className="flex items-center gap-3 px-3 py-2 bg-white border border-gray-200 rounded-lg hover:border-blue-400 hover:shadow-sm transition-all min-w-[280px]"
        >
          {selectedOperation ? (
            <>
              <span className={`px-2 py-0.5 text-xs font-bold text-white rounded ${getMethodColor(selectedOperation.method)}`}>
                {selectedOperation.method}
              </span>
              <div className="flex-1 text-left min-w-0">
                <div className="text-sm font-medium text-gray-900 truncate">{selectedOperation.path}</div>
                <div className="text-xs text-gray-500 truncate">{selectedOperation.summary}</div>
              </div>
            </>
          ) : (
            <span className="text-sm text-gray-500">Select operation...</span>
          )}
          <ChevronDown size={16} className={`text-gray-400 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
        </button>

        {isOpen && (
          <div className="absolute top-full left-0 mt-1 w-[400px] bg-white border border-gray-200 rounded-lg shadow-lg z-50 overflow-hidden">
            <div className="max-h-[320px] overflow-y-auto">
              {apiSpec.operations.map((op) => (
                <button
                  key={op.id}
                  onClick={() => {
                    setSelectedOp(op.id);
                    setIsOpen(false);
                  }}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 hover:bg-gray-50 transition-colors text-left ${
                    selectedOp === op.id ? 'bg-blue-50 border-l-4 border-blue-500' : 'border-l-4 border-transparent'
                  }`}
                >
                  <span className={`px-2 py-0.5 text-xs font-bold text-white rounded flex-shrink-0 ${getMethodColor(op.method)}`}>
                    {op.method}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-gray-900 truncate">{op.path}</div>
                    <div className="text-xs text-gray-500 truncate">{op.summary}</div>
                  </div>
                  {selectedOp === op.id && (
                    <i className="fas fa-check text-blue-500 text-xs"></i>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="h-screen flex flex-col bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <button onClick={() => navigate(-1)} className="p-2 hover:bg-gray-100 rounded">
              <i className="fas fa-arrow-left text-gray-600"></i>
            </button>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-blue-100 rounded-lg flex items-center justify-center">
                <Globe className="h-5 w-5 text-blue-600" />
              </div>
              <div>
                <h1 className="font-semibold text-gray-900">{flowName || 'Untitled API'}</h1>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-blue-600 bg-blue-50 px-2 py-0.5 rounded-full">REST API</span>
                  <span className="text-xs text-gray-500">{apiSpec.operations.length} operations</span>
                </div>
              </div>
            </div>
          </div>

          {/* Tabs */}
          <div className="flex items-center gap-1 bg-gray-100 rounded-lg p-1">
            {[
              { id: 'spec', label: 'OpenAPI Specification', icon: 'fa-file-code' },
              { id: 'designer', label: 'Flow Designer', icon: 'fa-project-diagram' },
              { id: 'test', label: 'Test & Debug', icon: 'fa-bug' },
              { id: 'deploy', label: 'Deploy', icon: 'fa-rocket' },
            ].map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as any)}
                className={`inline-flex items-center justify-center px-3.5 h-9 rounded-lg text-[14px] font-medium transition-colors ${
                  activeTab === tab.id 
                    ? 'bg-white text-gray-900 shadow-sm' 
                    : 'text-gray-600 hover:text-gray-900'
                } whitespace-nowrap`}
              >
                <i className={`fas ${tab.icon} mr-2`}></i>
                {tab.label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={saveFlow} disabled={isLoading}>
              <i className="fas fa-save mr-2"></i>
              {isLoading ? 'Saving...' : 'Save'}
            </Button>
            <Button size="sm" onClick={deployAPI}>
              <i className="fas fa-rocket mr-2"></i>
              Deploy
            </Button>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {activeTab === 'spec' && (
          <OpenApiSpecEditor
            spec={apiSpec as unknown as OpenApiSpec}
            onChange={(spec) => setApiSpec(spec as unknown as APISpec)}
            requireApiKey={requireApiKey}
          />
        )}

        {activeTab === 'designer' && (
          <div className="h-full flex flex-col">
            {/* Operation Selector Bar */}
            <div className="bg-white border-b px-4 py-2 flex items-center gap-4">
              <label className="text-sm font-medium text-gray-700">Operation:</label>
              <OperationSelector />
            </div>
            
            {/* Flow Designer */}
            {selectedOp ? (
              <FlowDesigner
                flow={currentFlow}
                onChange={handleFlowChange}
                nodeTypes={nodeRegistry.getByFlowType('rest-api')}
                connections={connections}
                flowType="rest-api"
              />
            ) : (
              <div className="flex-1 flex items-center justify-center">
                <div className="flex items-center gap-2 text-sm text-gray-500">
                  <i className="fas fa-hand-pointer"></i>
                  <span>Select an operation to design its flow</span>
                </div>
              </div>
            )}
          </div>
        )}

        {activeTab === 'test' && (
          <TestPanel 
            operations={apiSpec.operations}
            flowId={flowId!}
            getMethodColor={getMethodColor}
            selectedOp={selectedOp}
            onSelectOp={setSelectedOp}
          />
        )}

        {activeTab === 'deploy' && (
          <DeployPanel
            flowId={flowId!}
            projectId={projectId!}
            apiSpec={apiSpec}
            flowName={flowName}
          />
        )}
      </div>
    </div>
  );
};

// Test Panel Component
interface TestPanelProps {
  operations: APIOperation[];
  flowId: string;
  getMethodColor: (method: string) => string;
  selectedOp: string;
  onSelectOp: (opId: string) => void;
}

interface TestRequestState {
  pathParams: Record<string, string>;
  queryParams: Record<string, string>;
  headers: Record<string, string>;
  body: string;
}

const TestPanel = ({ operations, flowId, getMethodColor, selectedOp, onSelectOp }: TestPanelProps) => {
  const [request, setRequest] = useState<TestRequestState>({
    pathParams: {},
    queryParams: {},
    headers: {},
    body: ''
  });
  const [response, setResponse] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [activeRequestTab, setActiveRequestTab] = useState<'params' | 'body' | 'headers'>('params');

  const currentOp = operations.find(op => op.id === selectedOp);

  // Reset request state when operation changes
  useEffect(() => {
    if (currentOp) {
      const pathParams: Record<string, string> = {};
      const queryParams: Record<string, string> = {};
      
      currentOp.parameters?.forEach((param: any) => {
        if (param.in === 'path') {
          pathParams[param.name] = '';
        } else if (param.in === 'query') {
          queryParams[param.name] = param.default || '';
        }
      });

      // Set default body for POST/PUT
      let body = '';
      if (currentOp.requestBody && (currentOp.method === 'POST' || currentOp.method === 'PUT')) {
        const properties = currentOp.requestBody.content?.schema?.properties || {};
        const exampleBody: Record<string, any> = {};
        Object.keys(properties).forEach(key => {
          exampleBody[key] = '';
        });
        body = JSON.stringify(exampleBody, null, 2);
      }

      setRequest({
        pathParams,
        queryParams,
        headers: { 'Content-Type': 'application/json' },
        body
      });
      setResponse(null);
      setActiveRequestTab(currentOp.requestBody ? 'body' : 'params');
    }
  }, [selectedOp, currentOp]);

  const buildUrl = () => {
    if (!currentOp) return '';

    let url = currentOp.path;

    // Replace only filled path params
    Object.entries(request.pathParams).forEach(([key, value]) => {
      if (value) {
        url = url.replace(`{${key}}`, value);
      }
    });

    // Add query params
    const queryString = Object.entries(request.queryParams)
      .filter(([_, value]) => value)
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
      .join('&');

    if (queryString) {
      url += `?${queryString}`;
    }

    return url;
  };

  // Render URL with highlighted template variables for unfilled params
  const buildUrlDisplay = () => {
    if (!currentOp) return null;

    const path = currentOp.path;
    const parts: { text: string; isParam: boolean; filled: boolean }[] = [];
    let lastIndex = 0;

    // Split path into segments: static text and {param} placeholders
    const paramRegex = /\{([^}]+)\}/g;
    let match;
    while ((match = paramRegex.exec(path)) !== null) {
      // Static text before this param
      if (match.index > lastIndex) {
        parts.push({ text: path.slice(lastIndex, match.index), isParam: false, filled: false });
      }
      const paramName = match[1];
      const value = request.pathParams[paramName];
      if (value) {
        parts.push({ text: value, isParam: true, filled: true });
      } else {
        parts.push({ text: `{${paramName}}`, isParam: true, filled: false });
      }
      lastIndex = match.index + match[0].length;
    }
    // Remaining static text
    if (lastIndex < path.length) {
      parts.push({ text: path.slice(lastIndex), isParam: false, filled: false });
    }

    // Query string
    const queryString = Object.entries(request.queryParams)
      .filter(([_, value]) => value)
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
      .join('&');
    if (queryString) {
      parts.push({ text: `?${queryString}`, isParam: false, filled: false });
    }

    return (
      <>
        {parts.map((part, i) =>
          part.isParam && !part.filled ? (
            <span key={i} className="px-1.5 py-0.5 bg-blue-100 text-blue-600 rounded text-xs font-semibold">
              {part.text}
            </span>
          ) : (
            <span key={i}>{part.text}</span>
          )
        )}
      </>
    );
  };

  const handleSendRequest = async () => {
    if (!currentOp) return;
    
    setLoading(true);
    setResponse(null);
    
    try {
      const startTime = Date.now();
      
      const res = await fetch(`${API_URL}/flows/${flowId}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operationId: currentOp.id,
          method: currentOp.method,
          path: buildUrl(),
          headers: request.headers,
          body: request.body ? JSON.parse(request.body) : undefined
        }),
      });

      const duration = Date.now() - startTime;
      const contentType = res.headers.get('Content-Type') || '';

      // Handle file download response (non-JSON)
      if (!contentType.includes('application/json') && res.ok) {
        const blob = await res.blob();
        const disposition = res.headers.get('Content-Disposition') || '';
        let fileName = 'download';
        const match = disposition.match(/filename[*]?=["']?([^"';\n]+)/);
        if (match) fileName = decodeURIComponent(match[1]);

        // Trigger browser download
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);

        setResponse({
          success: true,
          status: res.status,
          duration,
          data: { message: `File downloaded: ${fileName}`, size: blob.size, contentType },
          timestamp: new Date().toISOString()
        });
      } else {
        const data = await res.json();

        setResponse({
          success: data.success,
          status: res.status,
          duration,
          data: data.data,
          error: data.error,
          timestamp: new Date().toISOString()
        });
      }
    } catch (error) {
      setResponse({
        success: false,
        error: 'Network error or server unavailable',
        timestamp: new Date().toISOString()
      });
    } finally {
      setLoading(false);
    }
  };

  const formatJson = (obj: any) => JSON.stringify(obj, null, 2);

  // Operation Selector Component
  const OperationSelector = () => {
    const [isOpen, setIsOpen] = useState(false);
    const dropdownRef = useRef<HTMLDivElement>(null);
    const buttonRef = useRef<HTMLButtonElement>(null);

    useEffect(() => {
      const handleClickOutside = (e: MouseEvent) => {
        if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
          setIsOpen(false);
        }
      };
      if (isOpen) {
        document.addEventListener('mousedown', handleClickOutside);
      }
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [isOpen]);

    return (
      <div className="relative inline-block" ref={dropdownRef}>
        <button
          ref={buttonRef}
          onClick={() => setIsOpen(!isOpen)}
          className="flex items-center gap-3 px-4 py-2.5 bg-white border border-gray-200 rounded-lg hover:border-blue-400 hover:shadow-sm transition-all w-[320px]"
        >
          {currentOp ? (
            <>
              <span className={`px-2 py-0.5 text-xs font-bold text-white rounded ${getMethodColor(currentOp.method)}`}>
                {currentOp.method}
              </span>
              <div className="flex-1 text-left min-w-0 overflow-hidden">
                <div className="text-sm font-medium text-gray-900 truncate">{currentOp.path}</div>
                <div className="text-xs text-gray-500 truncate">{currentOp.summary}</div>
              </div>
            </>
          ) : (
            <span className="text-sm text-gray-500">Select operation to test...</span>
          )}
          <ChevronDown size={16} className={`text-gray-400 transition-transform flex-shrink-0 ${isOpen ? 'rotate-180' : ''}`} />
        </button>

        {isOpen && (
          <div className="fixed mt-1 w-[320px] bg-white border border-gray-200 rounded-lg shadow-xl z-[9999] overflow-hidden" style={{top: (buttonRef.current?.getBoundingClientRect().bottom ?? 0), right: window.innerWidth - (buttonRef.current?.getBoundingClientRect().right ?? 0)}}>
            <div className="max-h-[280px] overflow-y-auto">
              {operations.map((op) => (
                <button
                  key={op.id}
                  onClick={() => {
                    onSelectOp(op.id);
                    setIsOpen(false);
                  }}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 hover:bg-gray-50 transition-colors text-left border-l-4 ${
                    selectedOp === op.id ? 'bg-blue-50 border-blue-500' : 'border-transparent'
                  }`}
                >
                  <span className={`px-2 py-0.5 text-xs font-bold text-white rounded flex-shrink-0 ${getMethodColor(op.method)}`}>
                    {op.method}
                  </span>
                  <div className="flex-1 min-w-0 overflow-hidden">
                    <div className="text-sm font-medium text-gray-900 truncate">{op.path}</div>
                    <div className="text-xs text-gray-500 truncate">{op.summary}</div>
                  </div>
                  {selectedOp === op.id && (
                    <i className="fas fa-check text-blue-500 text-xs flex-shrink-0"></i>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  };

  if (!currentOp) {
    return (
      <div className="h-full flex flex-col bg-gray-50">
        <div className="bg-white border-b px-6 py-4">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Test & Debug</h2>
          <OperationSelector />
        </div>
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center text-gray-400">
            <i className="fas fa-vial text-5xl mb-4 text-gray-300"></i>
            <p className="text-lg font-medium text-gray-600 mb-2">Test Your API</p>
            <p className="text-sm">Select an operation to start testing</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Test & Debug</h2>
            <p className="text-sm text-gray-500 mt-0.5">Configure request and send to test API endpoint</p>
          </div>
          <OperationSelector />
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Request Panel */}
        <div className="flex-1 flex flex-col border-r bg-white">
          {/* URL Bar */}
          <div className="px-6 py-4 border-b bg-gray-50">
            <div className="flex items-center gap-3">
              <span className={`px-3 py-1.5 text-sm font-bold text-white rounded ${getMethodColor(currentOp.method)}`}>
                {currentOp.method}
              </span>
              <code className="flex-1 px-4 py-2 bg-white border rounded-lg text-sm font-mono text-gray-700 truncate flex items-center gap-0">
                {buildUrlDisplay()}
              </code>
              <button
                onClick={handleSendRequest}
                disabled={loading}
                className="px-3 h-9 text-[14px] font-medium rounded-lg flex items-center gap-2 transition-colors whitespace-nowrap bg-blue-600 text-white hover:bg-blue-700"
              >
                {loading ? (
                  <><i className="fas fa-spinner fa-spin"></i> Sending...</>
                ) : (
                  <><i className="fas fa-paper-plane"></i> Send</>
                )}
              </button>
            </div>
          </div>

          {/* Request Tabs */}
          <div className="flex border-b">
            {[
              { id: 'params', label: 'Parameters', icon: 'fa-sliders-h' },
              ...(currentOp.requestBody ? [{ id: 'body', label: 'Body', icon: 'fa-code' }] : []),
              { id: 'headers', label: 'Headers', icon: 'fa-list' }
            ].map((tab: any) => (
              <button
                key={tab.id}
                onClick={() => setActiveRequestTab(tab.id)}
                className={`px-5 py-3 text-sm font-medium flex items-center gap-2 transition-colors ${
                  activeRequestTab === tab.id
                    ? 'text-blue-600 border-b-2 border-blue-600 bg-blue-50'
                    : 'text-gray-600 hover:text-gray-900 hover:bg-gray-50'
                }`}
              >
                <i className={`fas ${tab.icon}`}></i>
                {tab.label}
              </button>
            ))}
          </div>

          {/* Request Content */}
          <div className="flex-1 overflow-y-auto p-6">
            {activeRequestTab === 'params' && (
              <div className="space-y-6">
                {/* Path Parameters */}
                {Object.keys(request.pathParams).length > 0 && (
                  <div>
                    <h4 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2">
                      <i className="fas fa-route text-blue-500"></i>
                      Path Parameters
                    </h4>
                    <div className="space-y-3">
                      {Object.entries(request.pathParams).map(([key, value]) => (
                        <div key={key} className="flex items-center gap-3">
                          <code className="w-32 px-3 py-2 bg-gray-100 rounded text-sm font-medium text-gray-700">
                            {key}
                          </code>
                          <input
                            type="text"
                            value={value}
                            onChange={(e) => setRequest(prev => ({
                              ...prev,
                              pathParams: { ...prev.pathParams, [key]: e.target.value }
                            }))}
                            placeholder={`Enter ${key}`}
                            className="flex-1 px-4 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Query Parameters */}
                {Object.keys(request.queryParams).length > 0 && (
                  <div>
                    <h4 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2">
                      <i className="fas fa-question-circle text-green-500"></i>
                      Query Parameters
                    </h4>
                    <div className="space-y-3">
                      {Object.entries(request.queryParams).map(([key, value]) => (
                        <div key={key} className="flex items-center gap-3">
                          <code className="w-32 px-3 py-2 bg-gray-100 rounded text-sm font-medium text-gray-700">
                            {key}
                          </code>
                          <input
                            type="text"
                            value={value}
                            onChange={(e) => setRequest(prev => ({
                              ...prev,
                              queryParams: { ...prev.queryParams, [key]: e.target.value }
                            }))}
                            placeholder="Value"
                            className="flex-1 px-4 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {Object.keys(request.pathParams).length === 0 && Object.keys(request.queryParams).length === 0 && (
                  <div className="text-center py-8 text-gray-400">
                    <i className="fas fa-info-circle text-3xl mb-3"></i>
                    <p>No parameters defined for this operation</p>
                  </div>
                )}
              </div>
            )}

            {activeRequestTab === 'body' && currentOp.requestBody && (
              <div>
                <div className="flex items-center justify-between mb-3">
                  <h4 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
                    <i className="fas fa-code text-purple-500"></i>
                    Request Body (JSON)
                  </h4>
                  <button
                    onClick={() => setRequest(prev => ({ ...prev, body: formatJson(JSON.parse(prev.body || '{}')) }))}
                    className="inline-flex items-center justify-center text-[13px] text-blue-600 hover:text-blue-700 px-3 h-8 bg-blue-50 rounded-lg whitespace-nowrap"
                  >
                    <i className="fas fa-magic mr-1"></i> Format JSON
                  </button>
                </div>
                <textarea
                  value={request.body}
                  onChange={(e) => setRequest(prev => ({ ...prev, body: e.target.value }))}
                  className="w-full h-80 p-4 border rounded-lg font-mono text-sm resize-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  placeholder="{}"
                  spellCheck={false}
                />
              </div>
            )}

            {activeRequestTab === 'headers' && (
              <div>
                <h4 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2">
                  <i className="fas fa-list text-orange-500"></i>
                  Request Headers
                </h4>
                <div className="space-y-3">
                  {Object.entries(request.headers).map(([key, value]) => (
                    <div key={key} className="flex items-center gap-3">
                      <input
                        type="text"
                        value={key}
                        readOnly
                        className="w-48 px-4 h-9 bg-gray-100 border rounded-lg text-sm font-medium text-gray-700"
                      />
                      <input
                        type="text"
                        value={value}
                        onChange={(e) => setRequest(prev => ({
                          ...prev,
                          headers: { ...prev.headers, [key]: e.target.value }
                        }))}
                        className="flex-1 px-4 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Response Panel */}
        <div className="w-[45%] bg-gray-50 flex flex-col">
          <div className="px-6 py-4 border-b bg-white">
            <h3 className="font-semibold text-gray-900 flex items-center gap-2">
              <i className="fas fa-reply text-blue-500"></i>
              Response
            </h3>
          </div>

          <div className="flex-1 overflow-y-auto p-6">
            {response ? (
              <div className="space-y-4">
                {/* Status Bar */}
                <div className="flex items-center gap-4">
                  <div className={`px-4 py-2 rounded-lg font-medium text-sm ${
                    response.success
                      ? 'bg-green-100 text-green-700'
                      : 'bg-red-100 text-red-700'
                  }`}>
                    {response.success ? (
                      <><i className="fas fa-check-circle mr-2"></i>Success</>
                    ) : (
                      <><i className="fas fa-times-circle mr-2"></i>Failed</>
                    )}
                  </div>
                  {response.duration && (
                    <div className="text-sm text-gray-500">
                      <i className="fas fa-clock mr-1"></i>
                      {response.duration}ms
                    </div>
                  )}
                  {response.timestamp && (
                    <div className="text-sm text-gray-500">
                      <i className="fas fa-calendar mr-1"></i>
                      {new Date(response.timestamp).toLocaleTimeString()}
                    </div>
                  )}
                </div>

                {/* Error Message */}
                {response.error && (
                  <div className="bg-red-50 border border-red-200 rounded-xl overflow-hidden">
                    <div className="px-4 py-2 bg-red-100 border-b border-red-200 flex items-center gap-2">
                      <i className="fas fa-exclamation-triangle text-red-600"></i>
                      <span className="text-xs font-semibold text-red-700 uppercase">Error</span>
                    </div>
                    <div className="p-4">
                      <p className="text-sm text-red-800 font-medium">{response.error}</p>
                      {response.hint && (
                        <p className="text-xs text-red-600 mt-2">
                          <i className="fas fa-lightbulb mr-1"></i>
                          {response.hint}
                        </p>
                      )}
                    </div>
                  </div>
                )}

                {/* Response Body */}
                <div className="bg-white rounded-xl border overflow-hidden">
                  <div className="px-4 py-2 bg-gray-100 border-b flex items-center justify-between">
                    <span className="text-xs font-semibold text-gray-600 uppercase">Response Body</span>
                    <button
                      onClick={() => navigator.clipboard.writeText(formatJson(response.data || response))}
                      className="text-xs text-blue-600 hover:text-blue-700"
                    >
                      <i className="fas fa-copy mr-1"></i> Copy
                    </button>
                  </div>
                  <pre className="p-4 text-sm font-mono overflow-x-auto max-h-[400px]">
                    {formatJson(response.data || response)}
                  </pre>
                </div>
              </div>
            ) : (
              <div className="h-full flex items-center justify-center text-gray-400">
                <div className="text-center">
                  <i className="fas fa-paper-plane text-4xl mb-4 text-gray-300"></i>
                  <p className="text-lg font-medium text-gray-600 mb-2">No Response Yet</p>
                  <p className="text-sm">Configure your request and click Send</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

// Deploy Panel Component
interface DeployPanelProps {
  flowId: string;
  projectId: string;
  apiSpec: APISpec;
  flowName: string;
}

interface DeploymentConfig {
  publicUrl: string;
  requireApiKey: boolean;
  enabled: boolean;
  deployedAt?: string;
}

interface Project {
  code?: string;
  name?: string;
}



const DeployPanel = ({ flowId, projectId, apiSpec, flowName }: DeployPanelProps) => {
  const [config, setConfig] = useState<DeploymentConfig>({
    publicUrl: '',
    requireApiKey: true,
    enabled: false,
  });
  const [project, setProject] = useState<Project>({});
  const [loading, setLoading] = useState(true);
  const [deploying, setDeploying] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);


  // Get basePath from API Spec servers (field ที่กรอกบนหน้าจอ OpenAPI Spec)
  const basePath = apiSpec.servers?.[0]?.url || '/v1';
  const cleanBasePath = basePath.startsWith('/') ? basePath : `/${basePath}`;
  
  // Generate public URL: /{PUBLIC_API_ROOT}/{projectCode}/{basePath}
  const generatedPublicUrl = project.code
    ? `${PUBLIC_API_ROOT}/${project.code}${cleanBasePath}`
    : `${PUBLIC_API_ROOT}/${projectId.substring(0, 8)}${cleanBasePath}`;

  const fullBaseUrl = `${window.location.origin}${generatedPublicUrl}`;

  useEffect(() => {
    loadDeploymentConfig();
    loadProject();
  }, [flowId, projectId]);



  const loadDeploymentConfig = async () => {
    try {
      const res = await fetch(`${API_URL}/flows/${flowId}`);
      const data = await res.json();
      if (data.success && data.data.config) {
        const config = typeof data.data.config === 'string' 
          ? JSON.parse(data.data.config) 
          : data.data.config;
        
        if (config.deployment) {
          setConfig({
            publicUrl: config.deployment.publicUrl || generatedPublicUrl,
            requireApiKey: config.deployment.requireApiKey ?? true,
            enabled: config.deployment.enabled ?? false,
            deployedAt: config.deployment.deployedAt,
          });
        }
      }
    } catch (e) {
      console.error('Error loading deployment config:', e);
    } finally {
      setLoading(false);
    }
  };

  const loadProject = async () => {
    try {
      const res = await fetch(`${API_URL}/projects/${projectId}`);
      const data = await res.json();
      if (data.success) {
        setProject(data.data);
      }
    } catch (e) {
      console.error('Error loading project:', e);
    }
  };

  const deployAPI = async () => {
    setDeploying(true);
    setMessage(null);
    
    try {
      const res = await fetch(`${API_URL}/flows/${flowId}/deploy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          apiSpec, 
          deployment: {
            publicUrl: generatedPublicUrl,
            requireApiKey: config.requireApiKey,
            enabled: true,
            deployedAt: new Date().toISOString(),
          }
        }),
      });
      
      const data = await res.json();
      if (data.success) {
        setMessage({ type: 'success', text: 'API deployed successfully! Public URL is now active.' });
        setConfig(prev => ({ 
          ...prev, 
          enabled: true, 
          deployedAt: new Date().toISOString(),
        }));
      } else {
        setMessage({ type: 'error', text: data.error || 'Deploy failed' });
      }
    } catch (e) {
      setMessage({ type: 'error', text: 'Network error' });
    } finally {
      setDeploying(false);
    }
  };

  const undeployAPI = async () => {
    setDeploying(true);
    setMessage(null);
    
    try {
      const res = await apiFetch(`${API_URL}/flows/${flowId}/deploy`, {
        method: 'DELETE',
      });
      
      const data = await res.json();
      if (data.success) {
        setMessage({ type: 'success', text: 'API undeployed successfully! Public URL is now inactive.' });
        setConfig(prev => ({ 
          ...prev, 
          enabled: false, 
        }));
      } else {
        setMessage({ type: 'error', text: data.error || 'Undeploy failed' });
      }
    } catch (e) {
      setMessage({ type: 'error', text: 'Network error' });
    } finally {
      setDeploying(false);
    }
  };

  const downloadApiSpec = () => {
    // Use shared utility to generate consistent YAML
    const yamlContent = specToOpenApiYaml({
      openapi: apiSpec.openapi,
      info: apiSpec.info,
      servers: [{ url: fullBaseUrl, description: 'Public API Server' }],
      operations: apiSpec.operations,
      requireApiKey: config.requireApiKey,
    });

    const blob = new Blob([yamlContent], { type: 'application/yaml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(apiSpec.info?.title || flowName).toLowerCase().replace(/\s+/g, '-')}-openapi.yaml`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setMessage({ type: 'success', text: 'Copied to clipboard!' });
    setTimeout(() => setMessage(null), 2000);
  };



  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-gray-50 p-6">
      <div className="max-w-5xl mx-auto space-y-6">
        {/* Header with Deploy Button */}
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Deploy API</h2>
            <p className="text-sm text-gray-500">Deploy your API to make it publicly accessible</p>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={downloadApiSpec}
              className="px-3 h-9 bg-white border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 flex items-center gap-2 whitespace-nowrap"
            >
              <i className="fas fa-download"></i>
              Download OpenAPI YAML
            </button>
            {config.enabled ? (
              <button
                onClick={undeployAPI}
                disabled={deploying}
                className="px-3 h-9 rounded-lg flex items-center gap-2 disabled:opacity-70 whitespace-nowrap bg-red-600 text-white hover:bg-red-700"
              >
                <i className="fas fa-stop"></i>
                {deploying ? 'Processing...' : 'Undeploy'}
              </button>
            ) : (
              <button
                onClick={deployAPI}
                disabled={deploying}
                className="px-3 h-9 rounded-lg flex items-center gap-2 disabled:opacity-70 whitespace-nowrap bg-blue-600 text-white hover:bg-blue-700"
              >
                <i className="fas fa-rocket"></i>
                {deploying ? 'Deploying...' : 'Deploy Public URL'}
              </button>
            )}
          </div>
        </div>

        {/* Message */}
        {message && (
          <div className={`p-4 rounded-lg flex items-center gap-2 ${
            message.type === 'success' ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-700 border border-red-200'
          }`}>
            <i className={`fas ${message.type === 'success' ? 'fa-check-circle' : 'fa-exclamation-circle'}`}></i>
            {message.text}
          </div>
        )}

        {/* Deployment Status */}
        <div className="bg-white rounded-xl border p-6">
          <h3 className="font-medium text-gray-900 mb-4">Deployment Status</h3>
          
          <div className={`flex items-center gap-4 p-4 rounded-lg ${
            config.enabled ? 'bg-green-50 border border-green-200' : 'bg-gray-50 border border-gray-200'
          }`}>
            <div className={`w-3 h-3 rounded-full ${config.enabled ? 'bg-green-500 animate-pulse' : 'bg-gray-400'}`}></div>
            <div className="flex-1">
              <div className="font-medium text-gray-900">
                {config.enabled ? 'Active' : 'Inactive'}
              </div>
              <div className="text-sm text-gray-500">
                {config.enabled 
                  ? `Deployed at ${new Date(config.deployedAt!).toLocaleString()}`
                  : 'API is not currently deployed'
                }
              </div>
            </div>
            <div className={`px-3 py-1 rounded-full text-xs font-medium ${
              config.enabled 
                ? 'bg-green-100 text-green-700' 
                : 'bg-gray-100 text-gray-600'
            }`}>
              {config.enabled ? 'Running' : 'Stopped'}
            </div>
          </div>
        </div>

        {/* Public URL Display */}
        <div className="bg-white rounded-xl border p-6">
          <h3 className="font-medium text-gray-900 mb-4">Public Base URL</h3>
          
          <div className="p-4 bg-blue-50 rounded-lg border border-blue-200">
            <div className="flex items-center gap-3">
              <code className="text-lg font-mono text-blue-900 font-semibold flex-1 break-all">
                {fullBaseUrl}
              </code>
              <button
                onClick={() => copyToClipboard(fullBaseUrl)}
                className="p-2 text-blue-600 hover:bg-blue-100 rounded-lg transition-colors flex-shrink-0"
                title="Copy URL"
              >
                <i className="fas fa-copy"></i>
              </button>
            </div>

          </div>

          {config.deployedAt && (
            <p className="text-sm text-gray-500 mt-4">
              <i className="fas fa-clock mr-1"></i>
              Deployed at: {new Date(config.deployedAt).toLocaleString()}
            </p>
          )}
        </div>

        {/* Available Endpoints */}
        <div className="bg-white rounded-xl border p-6">
          <h3 className="font-medium text-gray-900 mb-4">Available Endpoints</h3>
          <div className="space-y-2">
            {apiSpec.operations?.map((op: any) => (
              <div key={op.id} className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg">
                <span className={`px-2 py-1 text-xs font-bold text-white rounded ${
                  op.method === 'GET' ? 'bg-blue-500' :
                  op.method === 'POST' ? 'bg-green-500' :
                  op.method === 'PUT' ? 'bg-yellow-500' :
                  op.method === 'DELETE' ? 'bg-red-500' : 'bg-gray-500'
                }`}>
                  {op.method}
                </span>
                <code className="text-gray-700 font-mono text-sm flex-1">
                  {op.path}
                </code>
                <span className="text-sm text-gray-500">{op.summary}</span>
              </div>
            ))}
          </div>
        </div>

        {/* API Key Authentication Section */}
        <div className="bg-white rounded-xl border p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-medium text-gray-900">API Key Authentication</h3>
            <a 
              href={`/projects/${projectId}/api-keys`}
              className="px-3 h-9 bg-blue-50 text-blue-600 rounded-lg hover:bg-blue-100 flex items-center gap-2 text-sm whitespace-nowrap"
            >
              <i className="fas fa-key"></i>
              Manage API Keys
            </a>
          </div>

          {/* Toggle API Key */}
          <div className="flex items-center justify-between p-4 bg-gray-50 rounded-lg mb-4">
            <p className="font-medium text-gray-900">Require API Key</p>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={config.requireApiKey}
                onChange={(e) => {
                  const newValue = e.target.checked;
                  setConfig(prev => ({ ...prev, requireApiKey: newValue }));
                  apiFetch(`${API_URL}/flows/${flowId}/deployment`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      publicUrl: config.publicUrl || generatedPublicUrl,
                      requireApiKey: newValue,
                      enabled: config.enabled,
                    }),
                  });
                }}
                className="sr-only peer"
              />
              <div className="w-14 h-7 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-6 after:w-6 after:transition-all peer-checked:bg-blue-600"></div>
            </label>
          </div>

          {config.requireApiKey ? (
            <div className="p-4 bg-amber-50 rounded-lg border border-amber-200">
              <div className="flex items-center gap-3">
                <i className="fas fa-shield-alt text-amber-600"></i>
                <div>
                  <p className="font-medium text-amber-900">API Key Required</p>
                  <p className="text-sm text-amber-700">
                    Header: <code className="bg-amber-100 px-1">X-API-Key</code>
                  </p>
                </div>
              </div>
            </div>
          ) : (
            <div className="p-4 bg-green-50 rounded-lg border border-green-200">
              <div className="flex items-center gap-3">
                <i className="fas fa-globe text-green-600"></i>
                <div>
                  <p className="font-medium text-green-900">Public Access</p>
                  <p className="text-sm text-green-700">No authentication required</p>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Variables — define runtime parameters (used by Scheduler + Run Task) */}
        <VariablesPanel flowId={flowId} />
      </div>
    </div>
  );
};

export default ApiFlowDesigner;
