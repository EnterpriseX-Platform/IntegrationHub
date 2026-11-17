import { useState, useEffect, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import {
  History, CheckCircle, XCircle, Clock,
  ChevronDown, ChevronLeft, ChevronRight,
  Activity, Zap, Terminal, AlertCircle,
  ChevronRight as ChevronRightIcon, Trash2, Filter, Loader2
} from 'lucide-react';
import { Search as CdsSearch, Select, SelectItem, Tag, Loading, InlineLoading, IconButton, Tabs, TabList, Tab } from '@carbon/react';
import { Button } from '../../components/ui/Button';
import { Modal } from '../../components/ui/Modal';

import { API_URL, apiFetch } from '../../config/api';

interface Project {
  id: string;
  name: string;
}

interface NodeExecution {
  nodeId: string;
  nodeType: string;
  nodeName: string;
  status: 'success' | 'error' | 'pending' | 'running';
  startedAt: string;
  endedAt?: string;
  error?: string;
  output?: any;
}

interface Execution {
  id: string;
  flowId: string;
  flowName: string;
  flowType: 'API_SPEC' | 'TRIGGER' | string;
  status: 'Completed' | 'Success' | 'Failed' | 'Running' | 'Pending';
  startedAt: string;
  endedAt: string | null;
  duration?: number;
  triggerType?: string;
  callerName?: string;
  logs?: {
    timestamp: string;
    level: 'info' | 'error' | 'warn' | 'debug';
    message: string;
    nodeId?: string;
    nodeName?: string;
  }[];
  nodeExecutions?: NodeExecution[];
  error?: string;
  input?: any;
  output?: any;
  result?: any;
}

type DateRange = 'today' | 'yesterday' | '7days' | '30days' | 'all';

const ITEMS_PER_PAGE = 20;

export const ProjectExecutions = ({ project }: { project: Project }) => {
  // Get projectId from URL params as fallback
  const { id: projectIdFromUrl } = useParams<{ id: string }>();
  const effectiveProjectId = project?.id || projectIdFromUrl;
  
  const [executions, setExecutions] = useState<Execution[]>([]);
  const [flows, setFlows] = useState<{id: string, name: string, type: string}[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'success' | 'failed' | 'running'>('all');
  const [typeFilter, setTypeFilter] = useState<'all' | 'api' | 'trigger'>('all');
  const [flowFilter, setFlowFilter] = useState<string>('all');
  const [dateRange, setDateRange] = useState<DateRange>('today');
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedExecution, setSelectedExecution] = useState<Execution | null>(null);
  const [showDetailModal, setShowDetailModal] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailTab, setDetailTab] = useState<'overview' | 'logs' | 'result'>('overview');
  const [showClearModal, setShowClearModal] = useState(false);
  const [clearAllMode, setClearAllMode] = useState(false);
  const [clearingLogs, setClearingLogs] = useState(false);

  useEffect(() => {
    if (effectiveProjectId) {
      fetchExecutions();
    }
  }, [effectiveProjectId]);

  const fetchExecutions = async () => {
    if (!effectiveProjectId) return;
    try {
      const response = await fetch(`${API_URL}/projects/${effectiveProjectId}`);
      const result = await response.json();
      if (result.success) {
        // Extract flows for filter dropdown
        const flowsList = (result.data.flows || []).map((f: any) => ({
          id: f.id,
          name: f.name,
          type: f.type,
        }));
        setFlows(flowsList);

        const execs = (result.data.executions || []).map((e: any) => {
          // Parse logs if string
          let logs = e.logs;
          if (typeof logs === 'string') {
            try { logs = JSON.parse(logs); } catch { logs = []; }
          }
          
          // Parse result if has node execution info
          let nodeExecutions: NodeExecution[] = [];
          if (e.result) {
            try {
              const result = JSON.parse(e.result);
              nodeExecutions = result.nodeExecutions || [];
            } catch {}
          }

          return {
            id: e.id,
            flowId: e.flowId,
            flowName: e.flow?.name || 'Unknown',
            flowType: e.flow?.type || 'Unknown',
            status: e.status,
            startedAt: e.startedAt,
            endedAt: e.endedAt,
            duration: e.endedAt
              ? Math.round((new Date(e.endedAt).getTime() - new Date(e.startedAt).getTime()) / 1000)
              : undefined,
            triggerType: e.triggerType,
            callerName: e.callerName,
            logs: logs || [],
            nodeExecutions,
            error: e.error,
            input: e.input,
            output: e.output,
          };
        });
        setExecutions(execs);
      }
    } catch (error) {
      console.error('Error fetching executions:', error);
    } finally {
      setLoading(false);
    }
  };

  // Filter by date range
  const getDateRangeFilter = (range: DateRange): { start: Date; end: Date } => {
    const now = new Date();
    const end = new Date(now.setHours(23, 59, 59, 999));
    const start = new Date(now);
    
    switch (range) {
      case 'today':
        start.setHours(0, 0, 0, 0);
        break;
      case 'yesterday':
        start.setDate(start.getDate() - 1);
        start.setHours(0, 0, 0, 0);
        end.setDate(end.getDate() - 1);
        end.setHours(23, 59, 59, 999);
        break;
      case '7days':
        start.setDate(start.getDate() - 7);
        start.setHours(0, 0, 0, 0);
        break;
      case '30days':
        start.setDate(start.getDate() - 30);
        start.setHours(0, 0, 0, 0);
        break;
      case 'all':
        start.setFullYear(2000);
        break;
    }
    return { start, end };
  };

  const filteredExecutions = useMemo(() => {
    let filtered = executions;

    // Date range filter
    const { start, end } = getDateRangeFilter(dateRange);
    filtered = filtered.filter(e => {
      const date = new Date(e.startedAt);
      return date >= start && date <= end;
    });

    // Status filter
    if (statusFilter !== 'all') {
      filtered = filtered.filter(e => {
        if (statusFilter === 'success') return e.status === 'Completed' || e.status === 'Success';
        if (statusFilter === 'failed') return e.status === 'Failed';
        if (statusFilter === 'running') return e.status === 'Running';
        return true;
      });
    }

    // Type filter
    if (typeFilter !== 'all') {
      filtered = filtered.filter(e => {
        if (typeFilter === 'api') return e.flowType === 'API_SPEC';
        if (typeFilter === 'trigger') return e.flowType === 'TRIGGER';
        return true;
      });
    }

    // Flow filter
    if (flowFilter !== 'all') {
      filtered = filtered.filter(e => e.flowId === flowFilter);
    }

    // Search filter (flow name and ID only, NOT status - to avoid conflict with status filter)
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(e => 
        e.flowName.toLowerCase().includes(query) ||
        e.id.toLowerCase().includes(query)
      );
    }

    return filtered;
  }, [executions, dateRange, statusFilter, typeFilter, flowFilter, searchQuery]);

  // Pagination
  const totalPages = Math.ceil(filteredExecutions.length / ITEMS_PER_PAGE);
  const paginatedExecutions = filteredExecutions.slice(
    (currentPage - 1) * ITEMS_PER_PAGE,
    currentPage * ITEMS_PER_PAGE
  );

  const getStatusTagType = (status: string): 'green' | 'red' | 'blue' | 'warm-gray' | 'gray' => {
    const types = { Completed: 'green', Success: 'green', Failed: 'red', Running: 'blue', Pending: 'warm-gray' } as const;
    return types[status as keyof typeof types] || 'gray';
  };

  const getFlowTypeBadge = (type: string) => {
    if (type === 'API_SPEC') {
      return (
        <Tag size="sm" type="blue" renderIcon={() => <Zap className="h-3 w-3" />}>API Flow</Tag>
      );
    }
    return (
      <Tag size="sm" type="purple" renderIcon={() => <Activity className="h-3 w-3" />}>Triggers</Tag>
    );
  };

  const formatDate = (dateStr: string) => {
    if (!dateStr) return '-';
    return new Date(dateStr).toLocaleString('en-GB', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    });
  };

  const formatDuration = (seconds?: number) => {
    if (!seconds) return '-';
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  };

  const getDateRangeLabel = (range: DateRange) => {
    const labels: Record<DateRange, string> = {
      today: 'Today',
      yesterday: 'Yesterday',
      '7days': 'Last 7 days',
      '30days': 'Last 30 days',
      all: 'All time',
    };
    return labels[range];
  };

  const handleExecutionClick = async (execution: Execution) => {
    setSelectedExecution(execution);
    setShowDetailModal(true);
    setDetailTab('overview');
    setDetailLoading(true);
    try {
      const res = await fetch(`${API_URL}/executions/${execution.id}/logs`);
      const data = await res.json();
      if (data.success) {
        const e = data.data.execution;
        const logs = e.logs || [];
        let result = e.result;
        if (typeof result === 'string') {
          try { result = JSON.parse(result); } catch (err) { void err; }
        }
        setSelectedExecution(prev => prev ? { ...prev, logs, result } : prev);
      }
    } catch (err) {
      void err;
    }
    setDetailLoading(false);
  };

  const handleClearLogs = async () => {
    if (!effectiveProjectId) {
      alert('Project ID not available');
      return;
    }
    setClearingLogs(true);
    try {
      const params = new URLSearchParams({
        projectId: effectiveProjectId,
        ...(!clearAllMode && dateRange !== 'all' && { dateRange }),
        ...(!clearAllMode && statusFilter !== 'all' && { status: statusFilter }),
        ...(!clearAllMode && typeFilter !== 'all' && { flowType: typeFilter }),
        ...(!clearAllMode && flowFilter !== 'all' && { flowId: flowFilter }),
      });

      const response = await apiFetch(`${API_URL}/executions/clear?${params}`, {
        method: 'DELETE',
      });
      const result = await response.json();

      if (result.success) {
        // Refresh executions list
        await fetchExecutions();
        setShowClearModal(false);
      } else {
        alert(result.error || 'Failed to clear logs');
      }
    } catch (error) {
      console.error('Error clearing logs:', error);
      alert('Failed to clear logs');
    } finally {
      setClearingLogs(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loading withOverlay={false} small description="Loading executions" />
      </div>
    );
  }

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Executions</h2>
          <p className="text-sm text-gray-500">
            {filteredExecutions.length} executions found
          </p>
        </div>
        <div className="relative group">
          <Button
            variant="danger"
            size="md"
            leftIcon={<Trash2 className="h-4 w-4" />}
            rightIcon={<ChevronDown className="h-3 w-3" />}
          >
            Clear Logs
          </Button>
          <div className="absolute top-full right-0 mt-1 w-48 bg-white border border-gray-200 rounded-lg shadow-lg opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all z-10">
            <button
              onClick={() => { setClearAllMode(false); setShowClearModal(true); }}
              className="w-full text-left px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50 rounded-t-lg flex items-center gap-2"
            >
              <Filter className="h-4 w-4 text-gray-400" />
              Clear Filtered
            </button>
            <button
              onClick={() => { setClearAllMode(true); setShowClearModal(true); }}
              className="w-full text-left px-4 py-2.5 text-sm text-red-600 hover:bg-red-50 rounded-b-lg flex items-center gap-2 border-t border-gray-100"
            >
              <Trash2 className="h-4 w-4" />
              Clear All
            </button>
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        {/* Search */}
        <div className="relative flex-1 min-w-[200px] max-w-md">
          <CdsSearch
            id="executions-search"
            size="md"
            labelText="Search executions"
            placeholder="Search by flow name, ID, or status..."
            value={searchQuery}
            onChange={(e: any) => setSearchQuery(e.target.value)}
            onClear={() => setSearchQuery('')}
          />
        </div>

        {/* Date Range Dropdown */}
        <div className="w-40">
          <Select
            id="executions-date-range"
            labelText="Date range"
            hideLabel
            size="md"
            value={dateRange}
            onChange={(e) => { setDateRange(e.target.value as DateRange); setCurrentPage(1); }}
          >
            {(['today', 'yesterday', '7days', '30days', 'all'] as DateRange[]).map((range) => (
              <SelectItem key={range} value={range} text={getDateRangeLabel(range)} />
            ))}
          </Select>
        </div>

        {/* Status Filter */}
        <div className="w-36">
          <Select
            id="executions-status-filter"
            labelText="Status"
            hideLabel
            size="md"
            value={statusFilter}
            onChange={(e) => { setStatusFilter(e.target.value as typeof statusFilter); setCurrentPage(1); }}
          >
            <SelectItem value="all" text="All Status" />
            <SelectItem value="success" text="Completed" />
            <SelectItem value="failed" text="Failed" />
            <SelectItem value="running" text="Running" />
          </Select>
        </div>

        {/* Type Filter */}
        <div className="w-36">
          <Select
            id="executions-type-filter"
            labelText="Type"
            hideLabel
            size="md"
            value={typeFilter}
            onChange={(e) => { setTypeFilter(e.target.value as typeof typeFilter); setCurrentPage(1); }}
          >
            <SelectItem value="all" text="All Types" />
            <SelectItem value="api" text="API Flow" />
            <SelectItem value="trigger" text="Triggers" />
          </Select>
        </div>

        {/* Flow Filter */}
        <div className="w-56">
          <Select
            id="executions-flow-filter"
            labelText="Flow"
            hideLabel
            size="md"
            value={flowFilter}
            onChange={(e) => { setFlowFilter(e.target.value); setCurrentPage(1); }}
          >
            <SelectItem value="all" text="All Flows" />
            {flows.map((flow) => (
              <SelectItem
                key={flow.id}
                value={flow.id}
                text={`${flow.name} (${flow.type === 'API_SPEC' ? 'API' : 'Triggers'})`}
              />
            ))}
          </Select>
        </div>
      </div>

      {/* Executions List */}
      {paginatedExecutions.length > 0 ? (
        <div className="space-y-2">
          {paginatedExecutions.map((execution) => {
            const borderColor =
              execution.status === 'Completed' || execution.status === 'Success'
                ? 'border-l-green-500'
                : execution.status === 'Failed'
                ? 'border-l-red-500'
                : execution.status === 'Running'
                ? 'border-l-blue-500'
                : execution.status === 'Pending'
                ? 'border-l-yellow-400'
                : 'border-l-gray-300';

            const statusIconEl =
              execution.status === 'Completed' || execution.status === 'Success' ? (
                <CheckCircle className="h-5 w-5 text-green-500 flex-shrink-0" />
              ) : execution.status === 'Failed' ? (
                <XCircle className="h-5 w-5 text-red-500 flex-shrink-0" />
              ) : execution.status === 'Running' ? (
                <Loader2 className="h-5 w-5 text-blue-500 flex-shrink-0 animate-spin" />
              ) : (
                <Clock className="h-5 w-5 text-yellow-400 flex-shrink-0" />
              );

            return (
              <div
                key={execution.id}
                onClick={() => handleExecutionClick(execution)}
                className={`cds--tile app-tile border-l-4 ${borderColor} px-4 py-3 hover:shadow-sm transition-all cursor-pointer`}
              >
                <div className="flex items-center gap-3">
                  {statusIconEl}
                  {/* Middle: flow name + meta */}
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold text-sm text-gray-900 truncate">{execution.flowName}</div>
                    <div className="flex items-center gap-1.5 text-xs text-gray-500 mt-0.5 flex-wrap">
                      <span>{formatDate(execution.startedAt)}</span>
                      {!!execution.duration && (
                        <>
                          <span>•</span>
                          <span>{formatDuration(execution.duration)}</span>
                        </>
                      )}
                      <span>•</span>
                      <span
                        className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[12px] font-medium ${
                          execution.triggerType === 'api'
                            ? 'bg-blue-50 text-blue-600'
                            : execution.triggerType === 'schedule'
                            ? 'bg-purple-50 text-purple-600'
                            : 'bg-gray-100 text-gray-600'
                        }`}
                      >
                        {execution.callerName || (execution.triggerType === 'api' ? 'API' : execution.triggerType === 'schedule' ? 'Scheduler' : 'System')}
                      </span>
                    </div>
                  </div>
                  {/* Right: status pill + chevron */}
                  <div className="flex items-center gap-2 ml-2 flex-shrink-0">
                    <Tag size="sm" type={getStatusTagType(execution.status)}>
                      {execution.status}
                    </Tag>
                    <ChevronRightIcon className="h-4 w-4 text-gray-400" />
                  </div>
                </div>
                {execution.status === 'Failed' && execution.error && (
                  <div className="mt-2 flex items-center gap-2 text-xs text-red-600 bg-red-50 px-2 py-1.5 rounded ml-8">
                    <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />
                    <span className="truncate">{execution.error}</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="text-center py-12 bg-gray-50 rounded-xl border border-dashed border-gray-300">
          <History className="h-12 w-12 text-gray-300 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-gray-900 mb-2">No executions found</h3>
          <p className="text-gray-500">
            {searchQuery || statusFilter !== 'all' || typeFilter !== 'all' || dateRange !== 'all'
              ? 'Try adjusting your filters'
              : 'Run a flow to see execution history here'}
          </p>
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between">
          <div className="text-sm text-gray-500">
            Showing {((currentPage - 1) * ITEMS_PER_PAGE) + 1} - {Math.min(currentPage * ITEMS_PER_PAGE, filteredExecutions.length)} of {filteredExecutions.length}
          </div>
          <div className="flex items-center gap-2">
            <IconButton
              kind="ghost"
              size="sm"
              label="Previous page"
              onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
              disabled={currentPage === 1}
            >
              <ChevronLeft className="h-4 w-4" />
            </IconButton>
            <span className="text-sm text-gray-600">
              Page {currentPage} of {totalPages}
            </span>
            <IconButton
              kind="ghost"
              size="sm"
              label="Next page"
              onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
              disabled={currentPage === totalPages}
            >
              <ChevronRight className="h-4 w-4" />
            </IconButton>
          </div>
        </div>
      )}

      {/* Detail Modal */}
      <Modal
        isOpen={showDetailModal && !!selectedExecution}
        onClose={() => setShowDetailModal(false)}
        title="Execution Details"
        size="4xl"
      >
        {selectedExecution && (
            <div>
              <p className="text-sm text-gray-500 mb-4">ID: {selectedExecution.id}</p>
              {(() => {
                const execution = selectedExecution;

                // JSON viewer helper
                const JsonViewer = ({ data }: { data: any }) => {
                  const [collapsed, setCollapsed] = useState(false);
                  const json = JSON.stringify(data, null, 2);
                  const isLarge = json.length > 2000;
                  return (
                    <div className="relative">
                      <pre className={`text-xs bg-gray-50 border border-gray-200 rounded-lg p-3 overflow-auto font-mono text-gray-800 ${collapsed ? 'max-h-32' : 'max-h-80'}`}>
                        {json}
                      </pre>
                      {isLarge && (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => setCollapsed(c => !c)}
                          className="absolute bottom-2 right-2"
                        >
                          {collapsed ? 'Expand' : 'Collapse'}
                        </Button>
                      )}
                    </div>
                  );
                };

                return (
                  <>
                    {/* Tab bar */}
                    <div className="mb-4">
                      {(() => {
                        const tabs = [
                          { key: 'overview', label: 'Overview', icon: Activity },
                          {
                            key: 'logs',
                            label: `Logs${execution.logs?.length ? ` (${execution.logs.length})` : ''}`,
                            icon: Terminal,
                          },
                          { key: 'result', label: 'Result', icon: Zap },
                        ];
                        return (
                          <Tabs
                            selectedIndex={Math.max(0, tabs.findIndex(t => t.key === detailTab))}
                            onChange={({ selectedIndex }: { selectedIndex: number }) =>
                              setDetailTab(tabs[selectedIndex].key as 'overview' | 'logs' | 'result')
                            }
                          >
                            <TabList aria-label="Execution detail tabs">
                              {tabs.map(tab => (
                                <Tab key={tab.key} renderIcon={() => <tab.icon className="h-4 w-4" />}>
                                  {tab.label}
                                </Tab>
                              ))}
                            </TabList>
                          </Tabs>
                        );
                      })()}
                    </div>

                    {/* Tab: Overview */}
                    {detailTab === 'overview' && (
                      <div className="space-y-4">
                        {/* Status badge */}
                        <div className="flex items-center gap-3">
                          <Tag size="md" type={getStatusTagType(execution.status)}>
                            {execution.status}
                          </Tag>
                          {getFlowTypeBadge(execution.flowType)}
                        </div>

                        {/* 2x2 info grid */}
                        <div className="grid grid-cols-2 gap-3">
                          <div className="p-3 bg-gray-50 rounded-lg">
                            <p className="text-xs text-gray-500 mb-1">Flow</p>
                            <p className="font-medium text-sm text-gray-900">{execution.flowName}</p>
                          </div>
                          <div className="p-3 bg-gray-50 rounded-lg">
                            <p className="text-xs text-gray-500 mb-1">Called by</p>
                            <span
                              className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium ${
                                execution.triggerType === 'api'
                                  ? 'bg-blue-100 text-blue-700'
                                  : execution.triggerType === 'schedule'
                                  ? 'bg-purple-100 text-purple-700'
                                  : 'bg-gray-100 text-gray-700'
                              }`}
                            >
                              {execution.callerName || (execution.triggerType === 'api' ? 'API' : execution.triggerType === 'schedule' ? 'Scheduler' : 'System')}
                            </span>
                          </div>
                          <div className="p-3 bg-gray-50 rounded-lg">
                            <p className="text-xs text-gray-500 mb-1">Started</p>
                            <p className="font-medium text-sm text-gray-900">{formatDate(execution.startedAt)}</p>
                          </div>
                          <div className="p-3 bg-gray-50 rounded-lg">
                            <p className="text-xs text-gray-500 mb-1">Ended / Duration</p>
                            <p className="font-medium text-sm text-gray-900">
                              {execution.endedAt ? formatDate(execution.endedAt) : '-'}
                              {!!execution.duration && (
                                <span className="ml-2 text-xs text-gray-500">({formatDuration(execution.duration)})</span>
                              )}
                            </p>
                          </div>
                        </div>

                        {/* Error box */}
                        {execution.error && (
                          <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-lg p-3">
                            <AlertCircle className="h-4 w-4 text-red-600 flex-shrink-0 mt-0.5" />
                            <p className="text-sm text-red-700">{execution.error}</p>
                          </div>
                        )}

                        {/* Skipped warning */}
                        {execution.result?.skipped && (
                          <div className="flex items-start gap-2 bg-yellow-50 border border-yellow-200 rounded-lg p-3">
                            <AlertCircle className="h-4 w-4 text-yellow-600 flex-shrink-0 mt-0.5" />
                            <p className="text-sm text-yellow-700">{execution.result.reason || 'Execution was skipped'}</p>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Tab: Logs */}
                    {detailTab === 'logs' && (
                      <div>
                        {detailLoading ? (
                          <div className="flex items-center justify-center py-12">
                            <InlineLoading description="Loading..." />
                          </div>
                        ) : execution.logs && execution.logs.length > 0 ? (
                          <div className="max-h-96 overflow-auto space-y-1 pr-1">
                            {execution.logs.map((log, idx) => {
                              const dotColor =
                                log.level === 'error' ? 'bg-red-500' :
                                log.level === 'warn' ? 'bg-yellow-400' :
                                log.level === 'debug' ? 'bg-gray-400' :
                                'bg-green-500';
                              const levelBadge =
                                log.level === 'error' ? 'bg-red-100 text-red-700' :
                                log.level === 'warn' ? 'bg-yellow-100 text-yellow-700' :
                                log.level === 'debug' ? 'bg-gray-100 text-gray-600' :
                                'bg-green-100 text-green-700';
                              return (
                                <div key={idx} className="flex items-start gap-2 py-1.5 px-2 rounded hover:bg-gray-50">
                                  <div className={`w-2 h-2 rounded-full mt-1.5 flex-shrink-0 ${dotColor}`} />
                                  <span className="text-xs text-gray-400 flex-shrink-0 font-mono w-16">
                                    {new Date(log.timestamp).toLocaleTimeString('en-GB', { hour12: false })}
                                  </span>
                                  <span className={`text-[12px] font-medium px-1.5 py-0.5 rounded flex-shrink-0 ${levelBadge}`}>
                                    {log.level.toUpperCase()}
                                  </span>
                                  {log.nodeName && (
                                    <span className="text-[12px] px-1.5 py-0.5 rounded bg-cyan-50 text-cyan-700 flex-shrink-0 font-medium">
                                      {log.nodeName}
                                    </span>
                                  )}
                                  <span className="text-xs text-gray-700 break-words min-w-0">{log.message}</span>
                                </div>
                              );
                            })}
                          </div>
                        ) : (
                          <div className="text-center py-12 text-gray-400 text-sm">No logs</div>
                        )}
                      </div>
                    )}

                    {/* Tab: Result */}
                    {detailTab === 'result' && (
                      <div className="space-y-4">
                        {detailLoading ? (
                          <div className="flex items-center justify-center py-12">
                            <InlineLoading description="Loading..." />
                          </div>
                        ) : execution.triggerType === 'api' ? (
                          <>
                            {execution.input !== undefined && (
                              <div>
                                <p className="text-xs font-semibold text-gray-700 mb-1.5">Request</p>
                                <JsonViewer data={execution.input} />
                              </div>
                            )}
                            {execution.output !== undefined && (
                              <div>
                                <p className="text-xs font-semibold text-blue-700 mb-1.5">Response</p>
                                <div className="relative">
                                  <JsonViewer data={execution.output} />
                                </div>
                              </div>
                            )}
                            {execution.input === undefined && execution.output === undefined && (
                              <div className="text-center py-12 text-gray-400 text-sm">No result data</div>
                            )}
                          </>
                        ) : execution.result?.data ? (
                          execution.result.data.filesDownloaded !== undefined ? (
                            <div className="space-y-3">
                              <div className="grid grid-cols-2 gap-3">
                                <div className="p-3 bg-green-50 border border-green-200 rounded-lg text-center">
                                  <p className="text-2xl font-bold text-green-700">{execution.result.data.filesDownloaded}</p>
                                  <p className="text-xs text-green-600 mt-1">Files Downloaded</p>
                                </div>
                                {execution.result.data.extractedFiles && (
                                  <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg text-center">
                                    <p className="text-2xl font-bold text-blue-700">{execution.result.data.extractedFiles.length}</p>
                                    <p className="text-xs text-blue-600 mt-1">Extracted Files</p>
                                  </div>
                                )}
                              </div>
                              {execution.result.data.extractedFiles && execution.result.data.extractedFiles.length > 0 && (
                                <div>
                                  <p className="text-xs font-semibold text-gray-700 mb-1.5">File List</p>
                                  <div className="max-h-48 overflow-auto space-y-1">
                                    {execution.result.data.extractedFiles.map((f: string, i: number) => (
                                      <div key={i} className="text-xs text-gray-700 bg-gray-50 border border-gray-100 rounded px-2 py-1 font-mono">{f}</div>
                                    ))}
                                  </div>
                                </div>
                              )}
                            </div>
                          ) : (
                            <JsonViewer data={execution.result.data} />
                          )
                        ) : execution.result ? (
                          <JsonViewer data={execution.result} />
                        ) : (
                          <div className="text-center py-12 text-gray-400 text-sm">No result data</div>
                        )}
                      </div>
                    )}
                  </>
                );
              })()}
            </div>
        )}
      </Modal>

      {/* Clear Logs Confirmation Modal */}
      <Modal
        isOpen={showClearModal}
        onClose={() => { if (!clearingLogs) setShowClearModal(false); }}
        title={clearAllMode ? 'Clear All Execution Logs' : 'Clear Filtered Execution Logs'}
        size="lg"
      >
            <div className="space-y-4">
              <p className="text-sm text-red-600 font-medium">This action cannot be undone</p>
              {clearAllMode ? (
                <>
                  <p className="text-sm text-gray-600">
                    You are about to delete <strong>ALL</strong> execution logs for this project.
                  </p>
                  <div className="bg-red-50 border border-red-200 rounded-lg p-3 flex items-start gap-2">
                    <AlertCircle className="h-4 w-4 text-red-600 flex-shrink-0 mt-0.5" />
                    <p className="text-xs text-red-700">
                      This will permanently delete all execution logs regardless of date, status, or flow filters.
                      This action cannot be undone.
                    </p>
                  </div>
                </>
              ) : (
                <>
                  <p className="text-sm text-gray-600">
                    You are about to delete executions matching the following filters:
                  </p>

                  <div className="bg-gray-50 rounded-lg p-4 space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-gray-500">Date Range:</span>
                      <span className="font-medium text-gray-900">{getDateRangeLabel(dateRange)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500">Status:</span>
                      <span className="font-medium text-gray-900">
                        {statusFilter === 'all' ? 'All Status' :
                         statusFilter === 'success' ? 'Completed' :
                         statusFilter === 'failed' ? 'Failed' : 'Running'}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500">Type:</span>
                      <span className="font-medium text-gray-900">
                        {typeFilter === 'all' ? 'All Types' :
                         typeFilter === 'api' ? 'API Flow' : 'Triggers'}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500">Flow:</span>
                      <span className="font-medium text-gray-900">
                        {flowFilter === 'all' ? 'All Flows' : flows.find(f => f.id === flowFilter)?.name || 'Unknown'}
                      </span>
                    </div>
                  </div>

                  <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 flex items-start gap-2">
                    <AlertCircle className="h-4 w-4 text-amber-600 flex-shrink-0 mt-0.5" />
                    <p className="text-xs text-amber-700">
                      This will permanently delete {filteredExecutions.length} execution(s) and their logs.
                      This action cannot be undone.
                    </p>
                  </div>
                </>
              )}
            </div>
            
            {/* Modal Footer */}
            <div className="flex items-center justify-end gap-3 pt-4 mt-4 border-t border-gray-200">
              <Button
                variant="ghost"
                onClick={() => setShowClearModal(false)}
                disabled={clearingLogs}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={handleClearLogs}
                disabled={!clearAllMode && filteredExecutions.length === 0}
                isLoading={clearingLogs}
                leftIcon={<Trash2 className="h-4 w-4" />}
              >
                {clearingLogs
                  ? 'Clearing...'
                  : clearAllMode
                  ? 'Clear All Executions'
                  : `Clear ${filteredExecutions.length} Execution${filteredExecutions.length !== 1 ? 's' : ''}`}
              </Button>
            </div>
      </Modal>
    </div>
  );
};

export default ProjectExecutions;
