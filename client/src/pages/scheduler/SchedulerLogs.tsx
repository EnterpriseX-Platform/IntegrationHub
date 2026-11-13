import { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { 
  ArrowLeft, Clock, Search, Download, Calendar,
  CheckCircle2, AlertCircle, Activity, RefreshCw,
  ChevronLeft, ChevronRight, Terminal,
  Timer, Layers,
  BarChart2,
  ChevronDown,
  Trash2,
  Play
} from 'lucide-react';

import { API_URL, apiFetch } from '../../config/api';

interface Execution {
  id: string;
  status: 'running' | 'completed' | 'failed' | 'pending';
  triggerType?: string;
  startedAt: string;
  endedAt?: string;
  duration?: number;
  error?: string;
  pid?: string;
  logs: LogEntry[];
}

interface LogEntry {
  timestamp: string;
  level: 'info' | 'success' | 'error' | 'warning' | 'debug';
  message: string;
  nodeId?: string;
  nodeName?: string;
  details?: any;
  data?: any;
}

interface Scheduler {
  id: string;
  flowId: string;
  flowName: string;
  projectName: string;
  projectColor: string;
  schedule: string;
}

const ITEMS_PER_PAGE = 20;

const statusConfig = {
  running: { label: 'Running', color: 'text-blue-600 bg-blue-50 border-blue-200', icon: Activity },
  completed: { label: 'Success', color: 'text-green-600 bg-green-50 border-green-200', icon: CheckCircle2 },
  failed: { label: 'Failed', color: 'text-red-600 bg-red-50 border-red-200', icon: AlertCircle },
  pending: { label: 'Pending', color: 'text-gray-600 bg-gray-50 border-gray-200', icon: Clock },
};



// Format duration
const formatDuration = (seconds?: number) => {
  if (!seconds) return '-';
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}m ${secs.toString().padStart(2, '0')}s`;
};



// Compact Stat Card
const StatCard = ({ label, value, icon: Icon, color }: any) => (
  <div className="bg-white rounded-lg border border-gray-200 px-3 py-2 min-w-0">
    <div className="flex items-center gap-1.5 text-xs text-gray-500">
      <Icon className={`h-3.5 w-3.5 shrink-0 ${color.replace('bg-', 'text-')}`} />
      <span className="truncate">{label}</span>
    </div>
    <p className="text-lg font-semibold text-gray-900 leading-tight tabular-nums">{value}</p>
  </div>
);

export default function SchedulerLogs() {
  const navigate = useNavigate();
  const { flowId } = useParams();
  const logContainerRef = useRef<HTMLDivElement>(null);
  
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scheduler, setScheduler] = useState<Scheduler | null>(null);
  const [executions, setExecutions] = useState<Execution[]>([]);
  const [selectedExecution, setSelectedExecution] = useState<Execution | null>(null);
  const [logsLoading, setLogsLoading] = useState(false);

  const [expandedLog, setExpandedLog] = useState<number | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [forceRunning, setForceRunning] = useState(false);

  // Delete all executions for this flow
  const deleteExecutions = async () => {
    if (!scheduler?.flowId) return;
    
    const year = new Date().getFullYear();
    if (!confirm(`ลบ Execution Log ทั้งหมดของปี ${year}?\n\nFlow จะสามารถรันใหม่ได้อีกครั้ง`)) {
      return;
    }
    
    setDeleting(true);
    try {
      const res = await apiFetch(`${API_URL}/executions/flow/${scheduler.flowId}?year=${year}`, {
        method: 'DELETE',
      });
      const data = await res.json();
      
      if (data.success) {
        alert(`ลบ ${data.data?.deletedCount || 0} execution(s) สำเร็จ`);
        fetchData();
      } else {
        alert('ลบไม่สำเร็จ: ' + data.error);
      }
    } catch (e) {
      alert('Error: ' + e);
    } finally {
      setDeleting(false);
    }
  };

  // Force run the flow
  const forceRun = async () => {
    if (!scheduler?.flowId) return;
    
    if (!confirm('Force Run ตอนนี้?\n\n(ไม่ตรวจสอบ execution history)')) {
      return;
    }
    
    setForceRunning(true);
    try {
      const year = new Date().getFullYear();
      const res = await fetch(`${API_URL}/flows/${scheduler.flowId}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          params: { year },
          force: true 
        }),
      });
      const data = await res.json();
      
      if (data.success) {
        alert('Force Run สำเร็จ!\nExecution ID: ' + data.data?.id);
        fetchData();
      } else {
        alert('Force Run ไม่สำเร็จ: ' + data.error);
      }
    } catch (e) {
      alert('Error: ' + e);
    } finally {
      setForceRunning(false);
    }
  };

  // Filters
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [logLevelFilter, setLogLevelFilter] = useState<string>('all');
  const [page, setPage] = useState(1);
  
  // Date Filters
  const [dateFilter, setDateFilter] = useState<string>('all');
  const [customDateRange, setCustomDateRange] = useState<{ start: string; end: string }>({ start: '', end: '' });
  const [showDatePicker, setShowDatePicker] = useState(false);

  // Date filter options
  const dateFilterOptions = [
    { value: 'all', label: 'All Time' },
    { value: 'today', label: 'Today' },
    { value: 'yesterday', label: 'Yesterday' },
    { value: '7days', label: 'Last 7 Days' },
    { value: '30days', label: 'Last 30 Days' },
    { value: 'custom', label: 'Custom Range...' },
  ];

  // Get date range for filter
  const getDateRange = (filter: string) => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    
    switch (filter) {
      case 'today':
        return { start: today, end: new Date(today.getTime() + 86400000) };
      case 'yesterday':
        const yesterday = new Date(today.getTime() - 86400000);
        return { start: yesterday, end: today };
      case '7days':
        return { start: new Date(today.getTime() - 7 * 86400000), end: new Date(today.getTime() + 86400000) };
      case '30days':
        return { start: new Date(today.getTime() - 30 * 86400000), end: new Date(today.getTime() + 86400000) };
      case 'custom':
        if (customDateRange.start && customDateRange.end) {
          return { 
            start: new Date(customDateRange.start), 
            end: new Date(new Date(customDateRange.end).getTime() + 86400000) 
          };
        }
        return { start: null, end: null };
      default:
        return { start: null, end: null };
    }
  };

  // Load logs for a specific execution
  const loadExecutionLogs = async (exec: Execution): Promise<void> => {
    setLogsLoading(true);
    try {
      const res = await fetch(`${API_URL}/executions/${exec.id}/logs`);
      const data = await res.json();
      
      if (data.success && data.data.logs) {
        const logsWithParsedDetails = data.data.logs.map((log: LogEntry) => ({
          ...log,
          // Parse details if it's a string
          details: typeof log.details === 'string' ? JSON.parse(log.details) : log.details,
        }));
        
        const execWithLogs = { ...exec, logs: logsWithParsedDetails };
        setExecutions(prev => prev.map(e => e.id === exec.id ? execWithLogs : e));
        setSelectedExecution(execWithLogs);
      } else {
        setSelectedExecution(exec);
      }
    } catch (err) {
      console.error('Error loading logs:', err);
      setSelectedExecution(exec);
    } finally {
      setLogsLoading(false);
    }
  };

  // Fetch data function
  const fetchData = async () => {
    if (!flowId) {
      setError('No flow ID provided');
      setLoading(false);
      return;
    }
    
    // Reset state when flowId changes
    setExecutions([]);
    setSelectedExecution(null);
    
    try {
      setLoading(true);
      setError(null);
      
      // Fetch flow details + linked schedulers
      const [flowRes, schRes] = await Promise.all([
        fetch(`${API_URL}/flows/${flowId}`),
        fetch(`${API_URL}/schedulers/by-flow/${flowId}`),
      ]);
      const flowData = await flowRes.json();
      const schData = await schRes.json();

      if (!flowData.success) {
        setError('Flow not found');
        setLoading(false);
        return;
      }

      const flow = flowData.data;
      const schedulers = schData.success ? schData.data : [];
      const primaryScheduler = schedulers[0];

      setScheduler({
        id: primaryScheduler?.id || `sched-${flow.id}`,
        flowId: flow.id,
        flowName: flow.name,
        projectName: flow.project?.name || 'Unknown Project',
        projectColor: flow.project?.color || 'blue',
        schedule: primaryScheduler?.schedule || 'No schedule',
      });
      
      // Fetch executions from API
      const execRes = await fetch(`${API_URL}/executions?flowId=${flowId}&limit=100`);
      const execData = await execRes.json();
      
      if (execData.success && execData.data.executions?.length > 0) {
        const execs: Execution[] = execData.data.executions.map((e: any) => ({
          id: e.id,
          status: e.status === 'Running' ? 'running' : 
                  e.status === 'Completed' || e.status === 'Success' ? 'completed' : 
                  e.status === 'Failed' ? 'failed' : 'pending',
          triggerType: e.triggerType,
          startedAt: e.startedAt,
          endedAt: e.endedAt,
          duration: e.endedAt ? Math.round((new Date(e.endedAt).getTime() - new Date(e.startedAt).getTime()) / 1000) : undefined,
          error: e.error,
          pid: e.pid,
          logs: [],
        }));
        
        setExecutions(execs);
        
        // Select first execution and load its logs
        if (execs.length > 0) {
          await loadExecutionLogs(execs[0]);
        }
      } else {
        setExecutions([]);
        setSelectedExecution(null);
      }
    } catch (err) {
      console.error('Error fetching data:', err);
      setError('Failed to fetch scheduler data');
    } finally {
      setLoading(false);
    }
  };

  // Fetch data when flowId changes
  useEffect(() => {
    fetchData();
  }, [flowId]);

  // Load logs when selecting execution
  const handleSelectExecution = async (exec: Execution) => {
    if (exec.logs.length === 0) {
      await loadExecutionLogs(exec);
    } else {
      setSelectedExecution(exec);
    }
  };

  // Filter executions
  const filteredExecutions = useMemo(() => {
    return executions.filter(exec => {
      const matchesSearch = !searchTerm || 
        exec.id.toLowerCase().includes(searchTerm.toLowerCase()) ||
        exec.error?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        exec.pid?.includes(searchTerm);
      
      const matchesStatus = statusFilter === 'all' || exec.status === statusFilter;
      
      // Date filtering
      let matchesDate = true;
      if (dateFilter !== 'all') {
        const { start, end } = getDateRange(dateFilter);
        if (start && end) {
          const execDate = new Date(exec.startedAt);
          matchesDate = execDate >= start && execDate < end;
        }
      }
      
      return matchesSearch && matchesStatus && matchesDate;
    });
  }, [executions, searchTerm, statusFilter, dateFilter, customDateRange]);

  // Filter logs
  const filteredLogs = useMemo(() => {
    if (!selectedExecution) return [];
    
    return selectedExecution.logs.filter(log => {
      const matchesLevel = logLevelFilter === 'all' || log.level === logLevelFilter;
      const matchesSearch = !searchTerm || 
        log.message.toLowerCase().includes(searchTerm.toLowerCase()) ||
        log.nodeName?.toLowerCase().includes(searchTerm.toLowerCase());
      return matchesLevel && matchesSearch;
    });
  }, [selectedExecution, logLevelFilter, searchTerm]);

  // Calculate stats
  const stats = useMemo(() => {
    const total = executions.length;
    const success = executions.filter(e => e.status === 'completed').length;
    const failed = executions.filter(e => e.status === 'failed').length;
    const running = executions.filter(e => e.status === 'running').length;
    const avgDuration = executions.length > 0 
      ? Math.round(executions.reduce((acc, e) => acc + (e.duration || 0), 0) / executions.length)
      : 0;
    
    return { total, success, failed, running, avgDuration, successRate: total > 0 ? Math.round((success / total) * 100) : 0 };
  }, [executions]);

  // Pagination
  const totalPages = Math.ceil(filteredExecutions.length / ITEMS_PER_PAGE);
  const paginatedExecutions = filteredExecutions.slice((page - 1) * ITEMS_PER_PAGE, page * ITEMS_PER_PAGE);

  // Log level counts
  const logLevelCounts = useMemo(() => {
    if (!selectedExecution) return {};
    const counts: Record<string, number> = {};
    selectedExecution.logs.forEach(log => {
      counts[log.level] = (counts[log.level] || 0) + 1;
    });
    return counts;
  }, [selectedExecution]);

  const exportLogs = () => {
    if (!selectedExecution) return;
    
    const content = filteredLogs.map(log => 
      `[${new Date(log.timestamp).toISOString()}] [${log.level.toUpperCase()}] [${log.nodeName || 'system'}] ${log.message}`
    ).join('\n');
    
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${scheduler?.flowName || 'scheduler'}-${selectedExecution.id.slice(0, 8)}.log`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (loading) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-gray-50">
        <RefreshCw className="h-10 w-10 text-blue-500 animate-spin mb-4" />
        <p className="text-gray-500">Loading scheduler data...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-gray-50">
        <AlertCircle className="h-16 w-16 text-red-400 mb-4" />
        <p className="text-lg font-medium text-gray-900">{error}</p>
        <button 
          onClick={() => navigate('/schedulers')}
          className="mt-4 flex items-center gap-2 px-3.5 h-9 bg-blue-600 text-white rounded-lg hover:bg-blue-700 whitespace-nowrap"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Schedulers
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      {/* Header - Compact */}
      <header className="bg-white border-b border-gray-200 sticky top-0 z-20">
        <div className="px-5 py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <button 
                onClick={() => navigate('/schedulers')}
                className="p-2 text-gray-500 hover:text-gray-900 hover:bg-gray-100 rounded-lg transition-colors"
              >
                <ArrowLeft className="h-5 w-5" />
              </button>
              <div>
                <div className="flex items-center gap-2">
                  <h1 className="text-lg font-bold text-gray-900">{scheduler?.flowName}</h1>
                  <span className="px-1.5 py-0.5 bg-blue-50 text-blue-600 text-[10px] rounded font-medium">
                    Scheduler
                  </span>
                </div>
                <div className="flex items-center gap-2 text-xs text-gray-500 mt-0.5">
                  <span className="flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    {scheduler?.schedule}
                  </span>
                  <span className="text-gray-300">|</span>
                  <span className="text-blue-600">{scheduler?.projectName}</span>
                </div>
              </div>
            </div>
            
            <div className="flex items-center gap-2">
              {/* Date Range Filter */}
              <div className="relative">
                <button
                  onClick={() => setShowDatePicker(!showDatePicker)}
                  className="flex items-center gap-1.5 px-2.5 h-9 text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-lg transition-colors border border-gray-200 text-[14px] whitespace-nowrap"
                >
                  <Calendar className="h-4 w-4" />
                  <span>{dateFilterOptions.find(o => o.value === dateFilter)?.label}</span>
                  <ChevronDown className={`h-4 w-4 transition-transform ${showDatePicker ? 'rotate-180' : ''}`} />
                </button>
                
                {showDatePicker && (
                  <div className="absolute top-full right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-30 min-w-[180px]">
                    {dateFilterOptions.map((option) => (
                      <button
                        key={option.value}
                        onClick={() => {
                          setDateFilter(option.value);
                          if (option.value !== 'custom') {
                            setShowDatePicker(false);
                          }
                        }}
                        className={`w-full text-left px-4 py-2.5 text-sm hover:bg-gray-50 first:rounded-t-lg last:rounded-b-lg flex items-center gap-2 ${
                          dateFilter === option.value ? 'bg-blue-50 text-blue-700' : 'text-gray-700'
                        }`}
                      >
                        {dateFilter === option.value && <CheckCircle2 className="h-4 w-4" />}
                        <span className={dateFilter === option.value ? 'ml-0' : 'ml-6'}>{option.label}</span>
                      </button>
                    ))}
                  </div>
                )}
                
                {/* Custom Date Range Popup */}
                {showDatePicker && dateFilter === 'custom' && (
                  <div className="absolute top-full right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-40 p-4 w-72">
                    <p className="text-sm font-medium text-gray-900 mb-3">Custom Date Range</p>
                    <div className="space-y-3">
                      <div>
                        <label className="text-xs text-gray-500 block mb-1.5">Start Date</label>
                        <input
                          type="date"
                          value={customDateRange.start}
                          onChange={(e) => setCustomDateRange(prev => ({ ...prev, start: e.target.value }))}
                          className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-700 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                        />
                      </div>
                      <div>
                        <label className="text-xs text-gray-500 block mb-1.5">End Date</label>
                        <input
                          type="date"
                          value={customDateRange.end}
                          onChange={(e) => setCustomDateRange(prev => ({ ...prev, end: e.target.value }))}
                          className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-700 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                        />
                      </div>
                      <div className="flex gap-2 pt-2">
                        <button
                          onClick={() => setShowDatePicker(false)}
                          className="inline-flex items-center justify-center flex-1 px-3.5 h-9 bg-blue-600 text-white text-[14px] font-medium rounded-lg hover:bg-blue-700 transition-colors whitespace-nowrap"
                        >
                          Apply
                        </button>
                        <button
                          onClick={() => {
                            setDateFilter('all');
                            setCustomDateRange({ start: '', end: '' });
                            setShowDatePicker(false);
                          }}
                          className="inline-flex items-center justify-center px-3.5 h-9 text-gray-500 text-[14px] hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors whitespace-nowrap"
                        >
                          Reset
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
              
              <div className="w-px h-5 bg-gray-300" />
              
              <button
                onClick={fetchData}
                className="p-1.5 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
                title="Refresh"
              >
                <RefreshCw className="h-4 w-4" />
              </button>
              
              <div className="w-px h-5 bg-gray-300" />
              
              {/* Force Run Button */}
              <button
                onClick={forceRun}
                disabled={forceRunning}
                className="flex items-center gap-1.5 px-3 h-9 rounded-lg transition-colors text-[14px] font-medium whitespace-nowrap bg-white border border-gray-300 text-gray-700 hover:bg-gray-50"
                title="Force Run Now"
              >
                <Play className="h-4 w-4" />
                {forceRunning ? 'Running...' : 'Force Run'}
              </button>
              
              {/* Delete Executions Button */}
              <button
                onClick={deleteExecutions}
                disabled={deleting}
                className="flex items-center gap-1.5 px-3 h-9 rounded-lg transition-colors text-[14px] font-medium whitespace-nowrap bg-white border border-red-300 text-red-600 hover:bg-red-50"
                title="Delete execution logs for this year"
              >
                <Trash2 className="h-4 w-4" />
                {deleting ? 'Deleting...' : 'Clear Logs'}
              </button>
            </div>
          </div>
        </div>
      </header>

      <div className="p-4 space-y-4">
        {/* Stats Row - Compact */}
        <div className="grid grid-cols-5 gap-3">
          <StatCard 
            label="Total" 
            value={stats.total} 
            icon={BarChart2} 
            color="bg-blue-500" 
          />
          <StatCard 
            label="Success" 
            value={`${stats.successRate}%`} 
            icon={CheckCircle2} 
            color="bg-emerald-500" 
          />
          <StatCard 
            label="Failed" 
            value={stats.failed} 
            icon={AlertCircle} 
            color="bg-red-500" 
          />
          <StatCard 
            label="Running" 
            value={stats.running} 
            icon={Activity} 
            color="bg-purple-500" 
          />
          <StatCard 
            label="Avg Time" 
            value={formatDuration(stats.avgDuration)} 
            icon={Timer} 
            color="bg-orange-500" 
          />
        </div>

        <div className="grid grid-cols-12 gap-4">
          {/* Left Panel - Execution List */}
          <div className="col-span-4 bg-white rounded-lg border border-gray-200 flex flex-col h-[calc(100vh-260px)]">
            {/* Filters - Compact */}
            <div className="p-3 border-b border-gray-200">
              <div className="relative mb-2">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                <input
                  type="text"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  placeholder="Search executions..."
                  className="w-full pl-10 pr-4 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-900 placeholder-gray-400 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                />
              </div>
              
              <div className="grid grid-cols-4 gap-0.5 p-0.5 bg-gray-100 rounded-lg">
                {([['all', 'All'], ['running', 'Running'], ['completed', 'Done'], ['failed', 'Failed']] as const).map(([status, label]) => (
                  <button
                    key={status}
                    onClick={() => setStatusFilter(status)}
                    className={`h-7 rounded-md text-xs font-medium truncate transition-colors ${
                      statusFilter === status
                        ? 'bg-white text-blue-700 shadow-sm'
                        : 'text-gray-600 hover:text-gray-900'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* Execution List - Compact Cards */}
            <div className="flex-1 overflow-auto p-3 space-y-2">
              {paginatedExecutions.length > 0 ? paginatedExecutions.map((exec) => {
                const config = statusConfig[exec.status];
                const Icon = config.icon;
                const isSelected = selectedExecution?.id === exec.id;
                const isForceRun = exec.triggerType === 'manual';
                
                return (
                  <button
                    key={exec.id}
                    onClick={() => handleSelectExecution(exec)}
                    className={`w-full text-left p-2 rounded-md border transition-all ${
                      isSelected 
                        ? 'bg-blue-50 border-blue-300' 
                        : 'bg-white border-gray-200 hover:border-gray-300'
                    }`}
                  >
                    {/* Row 1: ID + Status + Type */}
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5">
                        <Icon className={`h-3 w-3 ${config.color.split(' ')[0]}`} />
                        <span className="text-xs font-mono text-gray-600">{exec.id.slice(0, 8)}</span>
                        {isForceRun && (
                          <span className="text-[9px] px-1 py-0 bg-amber-100 text-amber-600 rounded">Force</span>
                        )}
                      </div>
                      <span className={`text-[9px] px-1.5 py-0.5 rounded border ${config.color}`}>
                        {config.label}
                      </span>
                    </div>
                    
                    {/* Row 2: Time + Duration */}
                    <div className="flex items-center justify-between mt-1 text-[10px] text-gray-500">
                      <span>{new Date(exec.startedAt).toLocaleTimeString()}</span>
                      <span className="font-mono">{formatDuration(exec.duration)}</span>
                    </div>
                  </button>
                );
              }) : (
                <div className="flex flex-col items-center justify-center h-full text-gray-400">
                  <Layers className="h-12 w-12 mb-3 text-gray-300" />
                  <p className="text-sm">No executions found</p>
                  {searchTerm && (
                    <button 
                      onClick={() => setSearchTerm('')}
                      className="mt-2 text-blue-600 hover:text-blue-700 text-sm font-medium"
                    >
                      Clear search
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* Pagination - Compact */}
            {totalPages > 1 && (
              <div className="p-3 border-t border-gray-200 flex items-center justify-between">
                <button
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={page === 1}
                  className="p-1.5 text-gray-500 hover:text-gray-900 hover:bg-gray-100 rounded-lg disabled:opacity-50"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <span className="text-xs text-gray-500">
                  {page} / {totalPages}
                </span>
                <button
                  onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                  disabled={page === totalPages}
                  className="p-1.5 text-gray-500 hover:text-gray-900 hover:bg-gray-100 rounded-lg disabled:opacity-50"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            )}
          </div>

          {/* Right Panel - Logs */}
          <div className="col-span-8 flex flex-col h-[calc(100vh-260px)]">
            {selectedExecution ? (
              <div className="bg-white rounded-lg border border-gray-200 flex flex-col h-full overflow-hidden">
                {/* Log Header - Compact */}
                <div className="px-3 py-2 border-b border-gray-200 bg-gray-50 rounded-t-lg">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <div className="flex items-center gap-2 min-w-0">
                      <Terminal className="h-4 w-4 text-gray-400 shrink-0" />
                      <span className="font-medium text-gray-900 whitespace-nowrap">Execution Logs</span>
                      <span className="text-xs text-gray-400 font-mono truncate">{selectedExecution.id.slice(0, 16)}</span>
                      {selectedExecution.status === 'running' && (
                        <span className="flex items-center gap-1 text-[10px] text-emerald-600">
                          <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse" />
                          Live
                        </span>
                      )}
                    </div>
                    
                    <div className="flex items-center gap-2">
                      {/* Log Level Filter - Always show */}
                      <div className="flex items-center gap-0.5 bg-white border border-gray-200 rounded-lg p-0.5">
                        {(['all', 'debug', 'info', 'success', 'warning', 'error'] as const).map((level) => (
                          <button
                            key={level}
                            onClick={() => setLogLevelFilter(level)}
                            className={`px-2 py-1 rounded text-[10px] font-medium transition-colors ${
                              logLevelFilter === level 
                                ? 'bg-gray-900 text-white' 
                                : 'text-gray-500 hover:text-gray-900 hover:bg-gray-100'
                            }`}
                          >
                            {level === 'all' ? 'ALL' : level.charAt(0).toUpperCase()}
                            {logLevelCounts[level] > 0 && (
                              <span className={`ml-1 ${
                                level === 'error' ? 'text-red-500' :
                                level === 'warning' ? 'text-amber-500' :
                                level === 'success' ? 'text-green-600' :
                                level === 'debug' ? 'text-purple-500' :
                                level === 'info' ? 'text-blue-500' :
                                'text-gray-500'
                              }`}>{logLevelCounts[level]}</span>
                            )}
                          </button>
                        ))}
                      </div>
                      
                      <button
                            onClick={exportLogs}
                            className="flex items-center gap-1.5 px-3 h-8 text-gray-700 bg-white border border-gray-200 hover:bg-gray-50 rounded-lg text-[13px] whitespace-nowrap"
                          >
                            <Download className="h-4 w-4" />
                            Export
                          </button>

                    </div>
                  </div>
                  
                  {/* Execution Info Bar - Compact */}
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1.5 text-xs text-gray-500">
                    <span>Started: {new Date(selectedExecution.startedAt).toLocaleString()}</span>
                    {selectedExecution.endedAt && (
                      <span>Ended: {new Date(selectedExecution.endedAt).toLocaleString()}</span>
                    )}
                    {selectedExecution.duration && (
                      <span>Duration: {formatDuration(selectedExecution.duration)}</span>
                    )}
                    {selectedExecution.pid && (
                      <span className="font-mono text-gray-400">PID: {selectedExecution.pid}</span>
                    )}
                  </div>
                  
                  {selectedExecution.error && (
                    <div className="mt-2 px-2 py-1.5 bg-red-50 border border-red-200 rounded text-xs text-red-700 font-mono">
                      <span className="font-bold">Error:</span> {selectedExecution.error}
                    </div>
                  )}
                </div>

                {/* Content Area */}
                {/* Log Content */}
                <div 
                  ref={logContainerRef}
                  className="flex-1 overflow-auto bg-white rounded-b-lg p-3 font-mono text-xs"
                >
                  {logsLoading ? (
                    <div className="flex flex-col items-center justify-center h-full text-gray-400">
                      <RefreshCw className="h-8 w-8 animate-spin mb-2" />
                      <p>Loading logs...</p>
                    </div>
                  ) : filteredLogs.length > 0 ? (
                    <div className="space-y-1">
                      {filteredLogs.map((log, idx) => {
                        const isExpanded = expandedLog === idx;
                        
                        return (
                          <div 
                            key={idx}
                            className="group"
                          >
                            <div 
                              onClick={() => log.details && setExpandedLog(isExpanded ? null : idx)}
                              className="flex items-start gap-3 hover:bg-gray-50 rounded cursor-pointer px-1 py-0.5"
                            >
                              <span className="text-gray-400 flex-shrink-0 tabular-nums leading-5">
                                {new Date(log.timestamp).toLocaleTimeString()}
                              </span>
                              
                              <span className={`flex-shrink-0 self-start w-16 text-center px-1.5 rounded text-[10px] font-semibold leading-5 ${
                                log.level === 'error' ? 'text-red-700 bg-red-50' :
                                log.level === 'warning' ? 'text-amber-700 bg-amber-50' :
                                log.level === 'debug' ? 'text-purple-700 bg-purple-50' :
                                log.level === 'success' ? 'text-green-700 bg-green-50' :
                                'text-blue-700 bg-blue-50'
                              }`}>
                                {log.level.toUpperCase()}
                              </span>
                              
                              <span className="text-gray-800 flex-1 min-w-0 break-words leading-5">
                                {log.nodeName && <span className="text-blue-600">[{log.nodeName}] </span>}
                                {log.message}
                              </span>
                              
                              {log.details && (
                                <span className="text-gray-400 flex-shrink-0 leading-5">
                                  {isExpanded ? '▼' : '▶'}
                                </span>
                              )}
                            </div>
                            
                            {isExpanded && log.details && (
                              <div className="ml-16 p-3 bg-gray-50 rounded text-xs text-gray-700 font-mono border-l-2 border-blue-400 max-h-96 overflow-auto">
                                <pre className="whitespace-pre-wrap break-all">{JSON.stringify(log.details, null, 2)}</pre>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="flex flex-col items-center justify-center h-full text-gray-500">
                      <Terminal className="h-12 w-12 mb-3 text-gray-300" />
                      <p>No logs match your filters</p>
                      <button 
                        onClick={() => { setLogLevelFilter('all'); setSearchTerm(''); }}
                        className="mt-2 text-blue-600 hover:text-blue-700 text-sm font-medium"
                      >
                        Clear filters
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="bg-white rounded-xl border border-gray-200 flex items-center justify-center h-full shadow-sm">
                <div className="text-center text-gray-400">
                  <Layers className="h-16 w-16 mx-auto mb-4 text-gray-300" />
                  <p className="text-lg font-medium text-gray-600">Select an execution</p>
                  <p className="text-sm mt-1">Click on an execution from the list to view its logs</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
