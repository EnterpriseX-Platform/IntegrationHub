import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Button } from '../components/ui/Button';
import { IconButton, Tabs, TabList, Tab, TextArea, Tag, InlineNotification, Loading } from '@carbon/react';
import { FlowDesigner } from '../components/flow/FlowDesigner';
import { nodeRegistry } from '../lib/flow-sdk/nodeRegistry';
import { registerAllNodes } from '../lib/flow-sdk/nodes';
import { API_URL, apiFetch } from '../config/api';
import VariablesPanel from '../components/flow-designer/VariablesPanel';

// Initialize node registry
registerAllNodes();

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
  label?: string;
  sourcePort?: 'top' | 'right' | 'bottom' | 'left';
  targetPort?: 'top' | 'right' | 'bottom' | 'left';
}

interface DeploymentConfig {
  enabled: boolean;
  deployedAt?: string;
  triggerType?: 'scheduler' | 'webhook' | 'manual';
  schedule?: string;
  webhookUrl?: string;
}

export const EventFlowDesigner = () => {
  const { flowId, id: projectId } = useParams();
  const navigate = useNavigate();
  
  const [activeTab, setActiveTab] = useState<'designer' | 'test' | 'deploy'>('designer');
  // Toast for Save / Run Now results (both used to give no feedback at all)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [running, setRunning] = useState(false);
  const flash = (kind: 'ok' | 'error', text: string) => {
    setNotice({ kind, text });
    window.setTimeout(() => setNotice((n) => (n && n.text === text ? null : n)), 4000);
  };
  const [flowName, setFlowName] = useState('');
  const [flowStatus, setFlowStatus] = useState<'Draft' | 'Active' | 'Inactive'>('Draft');
  const [nodes, setNodes] = useState<FlowNode[]>([]);
  const [edges, setEdges] = useState<FlowEdge[]>([]);
  const [connections, setConnections] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [linkedSchedulers, setLinkedSchedulers] = useState<Array<{ id: string; name?: string; schedule: string; enabled: boolean }>>([]);

  // Fetch schedulers linked to this flow
  useEffect(() => {
    if (!flowId) return;
    fetch(`${API_URL}/schedulers/by-flow/${flowId}`)
      .then(r => r.json())
      .then(d => { if (d.success) setLinkedSchedulers(d.data); })
      .catch(() => {});
  }, [flowId]);

  useEffect(() => {
    console.log('[EventFlowDesigner] useEffect triggered:', { flowId, projectId });
    if (flowId && projectId) {
      fetchFlow();
      loadConnections();
    } else {
      console.log('[EventFlowDesigner] Missing flowId or projectId, skipping fetch');
    }
  }, [flowId, projectId]);

  const fetchFlow = async () => {
    console.log('[EventFlowDesigner] Fetching flow:', flowId);
    try {
      setLoading(true);
      setError(null);
      const url = `${API_URL}/flows/${flowId}`;
      console.log('[EventFlowDesigner] API URL:', url);
      const res = await fetch(url);
      console.log('[EventFlowDesigner] Response status:', res.status);
      const data = await res.json();
      console.log('[EventFlowDesigner] Response data:', data);
      if (data.success) {
        setFlowName(data.data.name);
        setFlowStatus(data.data.status || 'Draft');
        console.log('[EventFlowDesigner] Flow name:', data.data.name);
        console.log('[EventFlowDesigner] Raw nodes:', data.data.nodes);
        console.log('[EventFlowDesigner] Raw connections:', data.data.connections);
        try {
          // Helper to parse potentially double-stringified JSON
          const safeParse = (data: any): any => {
            if (typeof data !== 'string') return data;
            try {
              const result = JSON.parse(data);
              // Handle double-stringified JSON
              if (typeof result === 'string') {
                try {
                  return JSON.parse(result);
                } catch {
                  return result;
                }
              }
              return result;
            } catch {
              return data;
            }
          };
          
          let parsedNodes = safeParse(data.data.nodes) || [];
          let parsedConnections = safeParse(data.data.connections) || [];
          
          // Ensure arrays
          if (!Array.isArray(parsedNodes)) parsedNodes = [];
          if (!Array.isArray(parsedConnections)) parsedConnections = [];
          
          // Convert nodes from database format (position: {x, y}) to FlowDesigner format (x, y)
          const convertedNodes = parsedNodes.map((node: any) => ({
            id: node.id,
            type: node.type,
            x: node.position?.x ?? node.x ?? 0,
            y: node.position?.y ?? node.y ?? 0,
            data: node.data || {},
          }));
          
          const parsedEdges = parsedConnections.map((conn: any, idx: number) => ({
            id: conn.id || `edge-${idx}`,
            source: conn.source,
            target: conn.target,
            label: conn.label,
            sourcePort: conn.sourcePort,
            targetPort: conn.targetPort,
          }));
          
          console.log('[EventFlowDesigner] Converted nodes:', convertedNodes.length, convertedNodes);
          console.log('[EventFlowDesigner] Parsed edges:', parsedEdges.length, parsedEdges);
          setNodes(convertedNodes);
          setEdges(parsedEdges);
        } catch (e) {
          console.error('Error parsing flow data:', e);
          setError('Failed to parse flow data: ' + (e as Error).message);
        }
      } else {
        console.error('[EventFlowDesigner] API error:', data.error);
        setError(data.error || 'Failed to load flow');
      }
    } catch (e) {
      console.error('Error fetching flow:', e);
      setError('Network error: ' + (e as Error).message);
    } finally {
      console.log('[EventFlowDesigner] Setting loading to false');
      setLoading(false);
    }
  };

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

  const handleFlowChange = (newFlow: { nodes: FlowNode[]; edges: FlowEdge[] }) => {
    setNodes(newFlow.nodes);
    setEdges(newFlow.edges);
  };

  const saveFlow = async (quiet = false): Promise<boolean> => {
    try {
      const connections = edges.map((edge, idx) => ({
        id: edge.id || `edge-${idx}`,
        source: edge.source,
        target: edge.target,
        label: edge.label,
        sourcePort: edge.sourcePort,
        targetPort: edge.targetPort,
      }));
      
      const res = await apiFetch(`${API_URL}/flows/${flowId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: flowName,
          nodes: JSON.stringify(nodes),
          connections: JSON.stringify(connections),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.success === false) throw new Error(data.error || `HTTP ${res.status}`);
      if (!quiet) flash('ok', 'Flow saved');
      return true;
    } catch (e) {
      console.error('Error saving flow:', e);
      flash('error', `Save failed: ${e instanceof Error ? e.message : 'unknown error'}`);
      return false;
    }
  };

  // Run Now: save the current canvas first, then start an async execution (202)
  const runNow = async () => {
    if (running) return;
    setRunning(true);
    try {
      if (!(await saveFlow(true))) return;
      const res = await apiFetch(`${API_URL}/flows/${flowId}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.success === false) throw new Error(data.error || `HTTP ${res.status}`);
      flash('ok', 'Run started — see Executions for the result');
    } catch (e) {
      flash('error', `Run failed: ${e instanceof Error ? e.message : 'unknown error'}`);
    } finally {
      setRunning(false);
    }
  };

  const currentFlow = { nodes, edges };

  return (
    <div className="h-full flex flex-col bg-gray-50 relative">
      {notice && (
        <div
          role="status"
          className={`fixed bottom-4 right-4 z-[60] max-w-sm px-4 py-3 text-sm shadow-lg border-l-4 bg-white text-gray-900 ${
            notice.kind === 'ok' ? 'border-green-600' : 'border-red-600'
          }`}
        >
          {notice.text}
        </div>
      )}
      {loading && (
        <div className="absolute inset-0 bg-white/80 z-50 flex items-center justify-center">
          <div className="text-gray-600">Loading Triggers Designer...</div>
        </div>
      )}
      {error && (
        <div className="m-4">
          <InlineNotification kind="error" lowContrast hideCloseButton title="Error:" subtitle={error} />
        </div>
      )}
      {/* Header */}
      <div className="bg-white border-b px-3 sm:px-4 py-2.5 sm:py-3">
        <div className="flex items-center justify-between gap-2 flex-wrap lg:flex-nowrap">
          <div className="flex items-center gap-2 sm:gap-4 min-w-0 flex-1">
            <IconButton kind="ghost" size="md" label="Back" onClick={() => navigate(-1)}>
              <i className="fas fa-arrow-left text-gray-600"></i>
            </IconButton>
            <div className="flex items-center gap-3 min-w-0">
              <div className="hidden sm:flex w-10 h-10 shrink-0 bg-green-100 rounded-lg items-center justify-center">
                <i className="fas fa-clock text-green-500"></i>
              </div>
              <div className="min-w-0">
                <h1 className="font-semibold text-gray-900 truncate" title={flowName}>{flowName || 'Untitled Triggers'}</h1>
                <div className="flex items-center gap-2 whitespace-nowrap overflow-hidden">
                  <Tag size="sm" type="green">Triggers</Tag>
                  <span className="hidden sm:inline text-xs text-gray-500">{nodes.length} nodes</span>
                  {flowStatus === 'Active' && (
                    <Tag size="sm" type="green">
                      <i className="fas fa-check-circle mr-1"></i> Active
                    </Tag>
                  )}
                  {linkedSchedulers.length > 0 && (
                    <button
                      onClick={() => navigate('/schedulers')}
                      className="text-xs px-2 py-0.5 rounded-full flex items-center gap-1.5 bg-blue-50 text-blue-700 hover:bg-blue-100 transition-colors"
                      title={linkedSchedulers.map(s => `${s.name || s.schedule} ${s.enabled ? '(Active)' : '(Paused)'}`).join('\n')}
                    >
                      <i className="fas fa-clock text-[12px]"></i>
                      {linkedSchedulers.length} scheduler{linkedSchedulers.length !== 1 ? 's' : ''}
                      {linkedSchedulers.some(s => s.enabled) && (
                        <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
                      )}
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Tabs */}
          <div className="order-last lg:order-none w-full lg:w-auto">
            {(() => {
              const tabs = [
                { id: 'designer', label: 'Flow Designer', icon: 'fa-project-diagram' },
                { id: 'test', label: 'Test & Debug', icon: 'fa-bug' },
                { id: 'deploy', label: 'Deploy', icon: 'fa-rocket' },
              ];
              return (
                <Tabs
                  selectedIndex={Math.max(0, tabs.findIndex(t => t.id === activeTab))}
                  onChange={({ selectedIndex }: { selectedIndex: number }) => setActiveTab(tabs[selectedIndex].id as any)}
                >
                  <TabList aria-label="Flow sections" contained>
                    {tabs.map(tab => (
                      <Tab key={tab.id} title={tab.label}>
                        <i className={`fas ${tab.icon} sm:mr-2`}></i>
                        <span className="hidden sm:inline">{tab.label}</span>
                      </Tab>
                    ))}
                  </TabList>
                </Tabs>
              );
            })()}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <Button variant="secondary" size="sm" onClick={() => saveFlow()} title="Save">
              <i className="fas fa-save sm:mr-2"></i><span className="hidden sm:inline">Save</span>
            </Button>
            <Button size="sm" title="Run Now" onClick={runNow} disabled={running}>
              <i className={`fas ${running ? 'fa-spinner fa-spin' : 'fa-play'} sm:mr-2`}></i><span className="hidden sm:inline whitespace-nowrap">Run Now</span>
            </Button>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {activeTab === 'designer' && (
          <>
            {(() => {
              const eventNodes = nodeRegistry.getByFlowType('event');
              console.log('[EventFlowDesigner] Event node types:', eventNodes.length, eventNodes.map(n => n.type));
              return null;
            })()}
            <FlowDesigner
              flow={currentFlow}
              onChange={handleFlowChange}
              nodeTypes={nodeRegistry.getByFlowType('event')}
              connections={connections}
              flowType="event"
            />
          </>
        )}

        {activeTab === 'test' && (
          <TestPanel 
            flowId={flowId!}
            nodes={nodes}
          />
        )}

        {activeTab === 'deploy' && (
          <DeployPanel
            flowId={flowId!}
            projectId={projectId!}
            flowName={flowName}
            nodes={nodes}
            onStatusChange={setFlowStatus}
          />
        )}
      </div>
    </div>
  );
};

// Test Panel Component for Triggers
interface TestPanelProps {
  flowId: string;
  nodes: FlowNode[];
}

const TestPanel = ({ flowId, nodes }: TestPanelProps) => {
  const [testInput, setTestInput] = useState('{}');
  const [response, setResponse] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  const handleTest = async () => {
    setLoading(true);
    setResponse(null);
    
    try {
      const startTime = Date.now();
      const res = await fetch(`${API_URL}/flows/${flowId}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          test: true,
          input: JSON.parse(testInput || '{}')
        }),
      });
      
      const data = await res.json();
      let duration = Date.now() - startTime;

      // Event flows run in the background (202 + status "Running"); wait for the real
      // outcome instead of reporting "Success" for a run that has only started.
      let exec = data?.data?.execution;
      if (data.success && exec?.id) {
        const deadline = Date.now() + 120_000;
        while (exec && /^(Running|Pending|Queued)$/i.test(exec.status || '') && Date.now() < deadline) {
          await new Promise(r => setTimeout(r, 1000));
          const pr = await fetch(`${API_URL}/executions/${exec.id}/logs`).then(r => r.json()).catch(() => null);
          if (pr?.success) exec = { ...pr.data.execution, logs: pr.data.logs };
        }
        duration = Date.now() - startTime;
        const ok = /^(Completed|Success|Succeeded)$/i.test(exec?.status || '');
        setResponse({
          success: ok,
          duration,
          data: exec,
          error: ok ? undefined : (exec?.error || (/^(Running|Pending|Queued)$/i.test(exec?.status || '') ? 'Still running after 2 minutes — see Executions' : `Execution ${exec?.status || 'failed'}`)),
          timestamp: new Date().toISOString()
        });
        return;
      }

      setResponse({
        success: data.success,
        duration,
        data: data.data,
        error: data.error,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      setResponse({
        success: false,
        error: 'Network error or invalid JSON input',
        timestamp: new Date().toISOString()
      });
    } finally {
      setLoading(false);
    }
  };

  const formatJson = (obj: any) => JSON.stringify(obj, null, 2);

  // Find trigger nodes
  const triggerNodes = nodes.filter(n => 
    n.type?.toLowerCase().includes('trigger') || 
    n.type?.toLowerCase().includes('scheduler') ||
    n.type?.toLowerCase().includes('webhook')
  );

  return (
    <div className="h-full flex flex-col bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Test & Debug</h2>
            <p className="text-sm text-gray-500 mt-0.5">Test your event flow with sample input data</p>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Input Panel */}
        <div className="flex-1 flex flex-col border-r bg-white">
          <div className="px-6 py-4 border-b bg-gray-50">
            <div className="flex items-center justify-between">
              <h3 className="font-medium text-gray-900 flex items-center gap-2">
                <i className="fas fa-play-circle text-green-500"></i>
                Test Input (Event Payload)
              </h3>
              <Button onClick={handleTest} isLoading={loading} leftIcon={loading ? undefined : <i className="fas fa-play"></i>}>
                {loading ? 'Running...' : 'Run Test'}
              </Button>
            </div>
          </div>

          <div className="flex-1 p-6">
            {/* Trigger Info */}
            {triggerNodes.length > 0 && (
              <div className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded-lg">
                <h4 className="text-sm font-medium text-blue-900 mb-2">
                  <i className="fas fa-bolt mr-2"></i>Detected Triggers:
                </h4>
                <div className="flex flex-wrap gap-2">
                  {triggerNodes.map(node => (
                    <Tag key={node.id} size="sm" type="blue">
                      {node.type}
                    </Tag>
                  ))}
                </div>
              </div>
            )}

            <TextArea
              id="event-flow-test-input"
              labelText="Test input"
              hideLabel
              value={testInput}
              onChange={(e) => setTestInput(e.target.value)}
              className="font-mono"
              rows={16}
              placeholder="{}"
              spellCheck={false}
              helperText="Enter JSON payload that simulates the event data your flow will receive."
            />
          </div>
        </div>

        {/* Response Panel */}
        <div className="w-[45%] bg-gray-50 flex flex-col">
          <div className="px-6 py-4 border-b bg-white">
            <h3 className="font-semibold text-gray-900 flex items-center gap-2">
              <i className="fas fa-reply text-green-500"></i>
              Execution Result
            </h3>
          </div>

          <div className="flex-1 overflow-y-auto p-6">
            {response ? (
              <div className="space-y-4">
                {/* Status Bar */}
                <div className="flex items-center gap-4">
                  <Tag type={response.success ? 'green' : 'red'}>
                    {response.success ? (
                      <><i className="fas fa-check-circle mr-2"></i>Success</>
                    ) : (
                      <><i className="fas fa-times-circle mr-2"></i>Failed</>
                    )}
                  </Tag>
                  {response.duration && (
                    <div className="text-sm text-gray-500">
                      <i className="fas fa-clock mr-1"></i>
                      {response.duration}ms
                    </div>
                  )}
                </div>

                {/* Error Message */}
                {response.error && (
                  <InlineNotification kind="error" lowContrast hideCloseButton title={String(response.error)} />
                )}

                {/* Response Body */}
                <div className="cds--tile app-tile !p-0 overflow-hidden">
                  <div className="px-4 py-2 bg-gray-100 border-b flex items-center justify-between">
                    <span className="text-xs font-semibold text-gray-600 uppercase">Output</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => navigator.clipboard.writeText(formatJson(response.data || response))}
                      leftIcon={<i className="fas fa-copy"></i>}
                    >
                      Copy
                    </Button>
                  </div>
                  <pre className="p-4 text-sm font-mono overflow-x-auto max-h-[400px]">
                    {formatJson(response.data || response)}
                  </pre>
                </div>
              </div>
            ) : (
              <div className="h-full flex items-center justify-center text-gray-400">
                <div className="text-center">
                  <i className="fas fa-vial text-4xl mb-4 text-gray-300"></i>
                  <p className="text-lg font-medium text-gray-600 mb-2">Test Your Flow</p>
                  <p className="text-sm">Configure input data and click Run Test</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

// Deploy Panel Component for Triggers
interface DeployPanelProps {
  flowId: string;
  projectId: string;
  flowName: string;
  nodes: FlowNode[];
  onStatusChange: (status: 'Draft' | 'Active' | 'Inactive') => void;
}

const DeployPanel = ({ flowId, projectId, flowName: _flowName, nodes, onStatusChange }: DeployPanelProps) => {
  const navigate = useNavigate();
  const [config, setConfig] = useState<DeploymentConfig>({
    enabled: false,
    triggerType: 'manual',
  });
  const [loading, setLoading] = useState(true);
  const [deploying, setDeploying] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [executions, setExecutions] = useState<any[]>([]);

  // Find trigger nodes
  const triggerNodes = nodes.filter(n => 
    n.type?.toLowerCase().includes('trigger') || 
    n.type?.toLowerCase().includes('scheduler') ||
    n.type?.toLowerCase().includes('webhook')
  );

  const hasScheduler = triggerNodes.some(n => 
    n.type?.toLowerCase().includes('scheduler') ||
    n.data?.triggerType === 'schedule'
  );

  const hasWebhook = triggerNodes.some(n => 
    n.type?.toLowerCase().includes('webhook') ||
    n.data?.triggerType === 'webhook'
  );

  useEffect(() => {
    loadDeploymentConfig();
    loadExecutions();
  }, [flowId]);

  const loadDeploymentConfig = async () => {
    try {
      const res = await fetch(`${API_URL}/flows/${flowId}`);
      const data = await res.json();
      if (data.success) {
        const flow = data.data;
        let flowConfig: any = {};
        if (flow.config) {
          try {
            flowConfig = typeof flow.config === 'string' 
              ? JSON.parse(flow.config) 
              : flow.config;
          } catch (e) {
            console.error('Error parsing config:', e);
          }
        }
        
        if (flowConfig.deployment) {
          setConfig({
            // The flow status is what the scheduler and header use
            enabled: flow.status === 'Active',
            deployedAt: flowConfig.deployment.deployedAt,
            triggerType: flowConfig.deployment.triggerType || 'manual',
            schedule: flowConfig.deployment.schedule,
            webhookUrl: flowConfig.deployment.webhookUrl,
          });
        } else {
          // Auto-detect trigger type from nodes
          let detectedType: 'scheduler' | 'webhook' | 'manual' = 'manual';
          if (hasScheduler) detectedType = 'scheduler';
          else if (hasWebhook) detectedType = 'webhook';
          
          setConfig(prev => ({
            ...prev,
            enabled: flow.status === 'Active',
            triggerType: detectedType,
          }));
        }
      }
    } catch (e) {
      console.error('Error loading deployment config:', e);
    } finally {
      setLoading(false);
    }
  };

  const loadExecutions = async () => {
    try {
      const res = await fetch(`${API_URL}/executions?flowId=${flowId}&limit=5`);
      const data = await res.json();
      if (data.success) {
        setExecutions(data.data || []);
      }
    } catch (e) {
      console.error('Error loading executions:', e);
    }
  };

  const deployFlow = async () => {
    setDeploying(true);
    setMessage(null);
    
    try {
      // Use event-deploy endpoint to actually schedule the flow
      const res = await fetch(`${API_URL}/flows/${flowId}/event-deploy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          triggerType: config.triggerType,
          schedule: config.schedule,
        }),
      });
      
      const data = await res.json();
      if (data.success) {
        setMessage({ type: 'success', text: 'Event flow deployed successfully! Flow is now active.' });
        setConfig(prev => ({ 
          ...prev, 
          enabled: true, 
          deployedAt: data.data.deployedAt,
        }));
        onStatusChange('Active');
      } else {
        setMessage({ type: 'error', text: data.error || 'Deploy failed' });
      }
    } catch (e) {
      setMessage({ type: 'error', text: 'Network error' });
    } finally {
      setDeploying(false);
    }
  };

  const undeployFlow = async () => {
    setDeploying(true);
    setMessage(null);
    
    try {
      // Use event-deploy DELETE endpoint to stop scheduler
      const res = await apiFetch(`${API_URL}/flows/${flowId}/event-deploy`, {
        method: 'DELETE',
      });
      
      const data = await res.json();
      if (data.success) {
        setMessage({ type: 'success', text: 'Event flow undeployed. Flow is now inactive.' });
        setConfig(prev => ({ ...prev, enabled: false }));
        onStatusChange('Inactive');
      } else {
        setMessage({ type: 'error', text: data.error || 'Undeploy failed' });
      }
    } catch (e) {
      setMessage({ type: 'error', text: 'Network error' });
    } finally {
      setDeploying(false);
    }
  };

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <Loading withOverlay={false} description="Loading deployment" />
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-gray-50 p-6">
      <div className="max-w-5xl mx-auto space-y-6">
        {/* Header with Deploy Button */}
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Deploy Triggers</h2>
            <p className="text-sm text-gray-500">Activate your event flow to start processing events</p>
          </div>
          <div className="flex items-center gap-3">
            {config.enabled ? (
              <Button variant="danger" onClick={undeployFlow} disabled={deploying} leftIcon={<i className="fas fa-stop"></i>}>
                {deploying ? 'Processing...' : 'Deactivate'}
              </Button>
            ) : (
              <Button onClick={deployFlow} disabled={deploying} leftIcon={<i className="fas fa-rocket"></i>}>
                {deploying ? 'Deploying...' : 'Activate Flow'}
              </Button>
            )}
          </div>
        </div>

        {/* Message */}
        {message && (
          <InlineNotification
            kind={message.type === 'success' ? 'success' : 'error'}
            lowContrast
            hideCloseButton
            title={message.text}
          />
        )}

        {/* Status Card */}
        <div className="cds--tile app-tile p-6">
          <h3 className="font-medium text-gray-900 mb-4">Deployment Status</h3>
          
          <div className="flex items-center gap-4 p-4 bg-gray-50 rounded-lg">
            <div className={`w-3 h-3 rounded-full ${config.enabled ? 'bg-green-500 animate-pulse' : 'bg-gray-400'}`}></div>
            <div className="flex-1">
              <div className="font-medium text-gray-900">
                {config.enabled ? 'Active' : 'Inactive'}
              </div>
              <div className="text-sm text-gray-500">
                {config.enabled 
                  ? (config.deployedAt && !isNaN(new Date(config.deployedAt).getTime())
                    ? `Deployed at ${new Date(config.deployedAt).toLocaleString()}`
                    : 'Running')
                  : 'Flow is not currently active'
                }
              </div>
            </div>
            <Tag size="sm" type={config.enabled ? 'green' : 'gray'}>
              {config.enabled ? 'Running' : 'Stopped'}
            </Tag>
          </div>
        </div>

        {/* Trigger Configuration */}
        <div className="cds--tile app-tile p-6">
          <h3 className="font-medium text-gray-900 mb-4">Trigger Configuration</h3>
          
          <div className="space-y-4">
            {/* Detected Triggers */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Detected Triggers in Flow</label>
              {triggerNodes.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {triggerNodes.map(node => (
                    <span key={node.id} className="inline-flex items-center gap-1 text-xs px-3 py-1.5 bg-blue-50 text-blue-700 rounded-lg border border-blue-200">
                      <i className="fas fa-bolt"></i>
                      {node.type}
                      {node.data?.schedule && (
                        <span className="text-blue-500">({node.data.schedule})</span>
                      )}
                    </span>
                  ))}
                </div>
              ) : (
                <div className="p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
                  <div className="flex items-center gap-2 text-yellow-800">
                    <i className="fas fa-exclamation-triangle"></i>
                    <span className="text-sm font-medium">No trigger nodes detected</span>
                  </div>
                  <p className="text-xs text-yellow-700 mt-1">
                    Add a trigger node (Scheduler, Webhook, etc.) to your flow to define how it will be activated.
                  </p>
                </div>
              )}
            </div>

            {/* Trigger Type Selection */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Activation Method</label>
              <div className="grid grid-cols-3 gap-3">
                {[
                  { id: 'manual', label: 'Manual', icon: 'fa-hand-pointer', desc: 'Run on demand' },
                  { id: 'scheduler', label: 'Scheduled', icon: 'fa-clock', desc: 'Cron schedule' },
                  { id: 'webhook', label: 'Webhook', icon: 'fa-globe', desc: 'HTTP endpoint' },
                ].map((type) => (
                  <button
                    key={type.id}
                    onClick={() => setConfig(prev => ({ ...prev, triggerType: type.id as any }))}
                    className={`p-3 border rounded-lg text-left transition-colors ${
                      config.triggerType === type.id
                        ? 'border-green-500 bg-green-50'
                        : 'border-gray-200 hover:border-gray-300'
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <i className={`fas ${type.icon} ${config.triggerType === type.id ? 'text-green-600' : 'text-gray-500'}`}></i>
                      <span className={`text-sm font-medium ${config.triggerType === type.id ? 'text-green-900' : 'text-gray-700'}`}>
                        {type.label}
                      </span>
                    </div>
                    <p className="text-xs text-gray-500">{type.desc}</p>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Variables — define runtime parameters (used by Scheduler + Run Task) */}
        <VariablesPanel flowId={flowId} />

        {/* Recent Executions */}
        <div className="cds--tile app-tile p-6">
          <h3 className="font-medium text-gray-900 mb-4">Recent Executions</h3>
          
          {executions.length > 0 ? (
            <div className="space-y-2">
              {executions.map((exec) => (
                <div key={exec.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                  <div className="flex items-center gap-3">
                    <div className={`w-2 h-2 rounded-full ${
                      exec.status === 'Success' ? 'bg-green-500' :
                      exec.status === 'Running' ? 'bg-blue-500 animate-pulse' :
                      'bg-red-500'
                    }`}></div>
                    <div>
                      <div className="text-sm font-medium text-gray-900">
                        {new Date(exec.createdAt).toLocaleString()}
                      </div>
                      <div className="text-xs text-gray-500">
                        {exec.status} • {exec.duration || 'N/A'}ms
                      </div>
                    </div>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => navigate(`/projects/${projectId}/executions/${exec.id}`)}>
                    View Logs
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-8 text-gray-400">
              <i className="fas fa-history text-3xl mb-3"></i>
              <p className="text-sm">No executions yet</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default EventFlowDesigner;
