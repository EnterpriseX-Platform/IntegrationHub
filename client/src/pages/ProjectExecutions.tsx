import { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  History,
  CheckCircle,
  XCircle,
  Play,
  Clock,
  ArrowLeft,
  RefreshCw,
  Filter,
  Calendar,
  Search,
  BarChart3,
  AlertTriangle,
} from 'lucide-react';

import { API_URL } from '../config/api';

interface Execution {
  id: string;
  flowId: string;
  flowName: string;
  status: 'Completed' | 'Success' | 'Failed' | 'Running' | 'Pending';
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  error?: string;
  errorType?: string;
}

interface Project {
  id: string;
  name: string;
  color: string;
}

type DateRange = 'today' | 'yesterday' | '7days' | '30days';
type StatusFilter = 'all' | 'success' | 'failed' | 'running';

const statusColors = {
  Completed: { bg: 'bg-green-100', text: 'text-green-700', dot: 'bg-green-500', border: 'border-green-200', icon: CheckCircle },
  Success: { bg: 'bg-green-100', text: 'text-green-700', dot: 'bg-green-500', border: 'border-green-200', icon: CheckCircle },
  Failed: { bg: 'bg-red-100', text: 'text-red-700', dot: 'bg-red-500', border: 'border-red-200', icon: XCircle },
  Running: { bg: 'bg-blue-100', text: 'text-blue-700', dot: 'bg-blue-500', border: 'border-blue-200', icon: Play },
  Pending: { bg: 'bg-yellow-100', text: 'text-yellow-700', dot: 'bg-yellow-500', border: 'border-yellow-200', icon: Clock },
};

const ITEMS_PER_PAGE = 20;

export default function ProjectExecutions() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  
  const [loading, setLoading] = useState(true);
  const [executions, setExecutions] = useState<Execution[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [dateRange, setDateRange] = useState<DateRange>('today');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [autoRefresh, setAutoRefresh] = useState(false);

  // Fetch project and executions
  const fetchData = async () => {
    if (!projectId) return;
    
    try {
      setLoading(true);
      
      // Fetch project details
      const projectRes = await fetch(`${API_URL}/projects/${projectId}`);
      const projectData = await projectRes.json();
      if (projectData.success) {
        setProject(projectData.data);
      }
      
      // Fetch executions
      const execRes = await fetch(`${API_URL}/executions?projectId=${projectId}&limit=500`);
      const execData = await execRes.json();
      if (execData.success) {
        const mapped = execData.data.executions.map((e: any) => ({
          id: e.id,
          flowId: e.flowId,
          flowName: e.flow?.name || 'Unknown Flow',
          status: e.status,
          startedAt: e.startedAt,
          endedAt: e.endedAt,
          durationMs: e.durationMs,
          error: e.error,
          errorType: e.errorType,
        }));
        setExecutions(mapped);
      }
      
      setLoading(false);
    } catch (error) {
      console.error('Error fetching data:', error);
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [projectId]);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, [autoRefresh]);

  // Filter executions
  const filteredExecutions = useMemo(() => {
    let filtered = [...executions];
    
    // Date range filter
    const now = new Date();
    const start = new Date(now);
    
    switch (dateRange) {
      case 'today':
        start.setHours(0, 0, 0, 0);
        break;
      case 'yesterday':
        start.setDate(start.getDate() - 1);
        start.setHours(0, 0, 0, 0);
        break;
      case '7days':
        start.setDate(start.getDate() - 7);
        break;
      case '30days':
        start.setDate(start.getDate() - 30);
        break;
    }
    
    filtered = filtered.filter(e => new Date(e.startedAt) >= start);
    
    // Status filter
    if (statusFilter !== 'all') {
      filtered = filtered.filter(e => e.status.toLowerCase() === statusFilter);
    }
    
    // Search filter
    if (searchQuery) {
      filtered = filtered.filter(e => 
        e.flowName.toLowerCase().includes(searchQuery.toLowerCase()) ||
        e.id.toLowerCase().includes(searchQuery.toLowerCase())
      );
    }
    
    // Sort by date desc
    filtered.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
    
    return filtered;
  }, [executions, dateRange, statusFilter, searchQuery]);

  // Pagination
  const totalPages = Math.ceil(filteredExecutions.length / ITEMS_PER_PAGE);
  const paginatedExecutions = filteredExecutions.slice(
    (currentPage - 1) * ITEMS_PER_PAGE,
    currentPage * ITEMS_PER_PAGE
  );

  // Stats
  const stats = useMemo(() => {
    const total = filteredExecutions.length;
    const success = filteredExecutions.filter(e => e.status === 'Completed' || e.status === 'Success').length;
    const failed = filteredExecutions.filter(e => e.status === 'Failed').length;
    const running = filteredExecutions.filter(e => e.status === 'Running').length;
    
    const durations = filteredExecutions
      .filter(e => e.durationMs)
      .map(e => e.durationMs!);
    
    const avgDuration = durations.length > 0
      ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
      : 0;
    
    return { total, success, failed, running, avgDuration };
  }, [filteredExecutions]);

  const formatDuration = (ms?: number) => {
    if (!ms) return '-';
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  };

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  if (loading) {
    return (
      <div className="p-6 flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500" />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <button
            onClick={() => navigate('/executions')}
            className="p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">
              Execution Management
            </h1>
            <p className="text-sm text-gray-500 mt-1">
              {project?.name || 'Unknown Project'} • {stats.total} executions
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setAutoRefresh(!autoRefresh)}
            className={`flex items-center gap-2 px-3 h-9 rounded-lg transition-colors ${
              autoRefresh ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'
            } whitespace-nowrap`}
          >
            <RefreshCw className={`h-4 w-4 ${autoRefresh ? 'animate-spin' : ''}`} />
            {autoRefresh ? 'Auto-refresh' : 'Manual'}
          </button>
          <button
            onClick={fetchData}
            className="flex items-center gap-2 px-3 h-9 rounded-lg transition-colors whitespace-nowrap bg-blue-600 text-white hover:bg-blue-700"
          >
            <RefreshCw className="h-4 w-4" />
            Refresh
          </button>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <div className="flex items-center gap-2 text-gray-500 mb-2">
            <BarChart3 className="h-4 w-4" />
            <span className="text-xs font-medium">Total</span>
          </div>
          <div className="text-2xl font-bold text-gray-900">{stats.total}</div>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <div className="flex items-center gap-2 text-green-600 mb-2">
            <CheckCircle className="h-4 w-4" />
            <span className="text-xs font-medium">Success</span>
          </div>
          <div className="text-2xl font-bold text-gray-900">{stats.success}</div>
        </div>

        <div className={`rounded-xl border p-4 ${stats.failed > 0 ? 'bg-red-50 border-red-200' : 'bg-white border-gray-200'}`}>
          <div className={`flex items-center gap-2 mb-2 ${stats.failed > 0 ? 'text-red-600' : 'text-gray-500'}`}>
            <XCircle className="h-4 w-4" />
            <span className="text-xs font-medium">Failed</span>
          </div>
          <div className={`text-2xl font-bold ${stats.failed > 0 ? 'text-red-700' : 'text-gray-900'}`}>
            {stats.failed}
          </div>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <div className="flex items-center gap-2 text-blue-600 mb-2">
            <Play className="h-4 w-4" />
            <span className="text-xs font-medium">Running</span>
          </div>
          <div className="text-2xl font-bold text-blue-600">{stats.running}</div>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <div className="flex items-center gap-2 text-gray-500 mb-2">
            <Clock className="h-4 w-4" />
            <span className="text-xs font-medium">Avg Duration</span>
          </div>
          <div className="text-2xl font-bold text-gray-900">{formatDuration(stats.avgDuration)}</div>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white rounded-xl border border-gray-200 p-4">
        <div className="flex flex-wrap items-center gap-4">
          {/* Search */}
          <div className="flex-1 min-w-[200px]">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
              <input
                type="text"
                placeholder="Search by flow name or execution ID..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-10 pr-4 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
              />
            </div>
          </div>

          {/* Date Range */}
          <div className="flex items-center gap-2">
            <Calendar className="h-4 w-4 text-gray-500" />
            <select
              value={dateRange}
              onChange={(e) => setDateRange(e.target.value as DateRange)}
              className="px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none"
            >
              <option value="today">Today</option>
              <option value="yesterday">Yesterday</option>
              <option value="7days">Last 7 days</option>
              <option value="30days">Last 30 days</option>
            </select>
          </div>

          {/* Status Filter */}
          <div className="flex items-center gap-2">
            <Filter className="h-4 w-4 text-gray-500" />
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
              className="px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none"
            >
              <option value="all">All Status</option>
              <option value="success">Success</option>
              <option value="failed">Failed</option>
              <option value="running">Running</option>
            </select>
          </div>
        </div>
      </div>

      {/* Executions List */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-gray-900">Executions</h3>
          <span className="text-sm text-gray-500">
            Showing {paginatedExecutions.length} of {filteredExecutions.length}
          </span>
        </div>

        <div className="divide-y divide-gray-100">
          {paginatedExecutions.length > 0 ? (
            paginatedExecutions.map((execution) => {
              const statusStyle = statusColors[execution.status];
              const StatusIcon = statusStyle.icon;

              return (
                <div
                  key={execution.id}
                  className="px-6 py-4 hover:bg-gray-50 transition-colors"
                >
                  <div className="flex items-center gap-4">
                    {/* Status Icon */}
                    <div className={`w-10 h-10 ${statusStyle.bg} rounded-lg flex items-center justify-center flex-shrink-0`}>
                      <StatusIcon className={`h-5 w-5 ${statusStyle.text}`} />
                    </div>

                    {/* Execution Info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-3">
                        <span className="font-medium text-gray-900 truncate">
                          {execution.flowName}
                        </span>
                        <span className={`text-xs px-2 py-0.5 rounded-full ${statusStyle.bg} ${statusStyle.text} ${statusStyle.border} border`}>
                          {execution.status}
                        </span>
                        {execution.errorType && (
                          <span className="text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-700 border border-red-200">
                            {execution.errorType}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-4 mt-1 text-sm text-gray-500">
                        <span className="font-mono text-xs">{execution.id.slice(0, 8)}...</span>
                        <span>•</span>
                        <span>{formatDate(execution.startedAt)}</span>
                      </div>
                    </div>

                    {/* Duration */}
                    <div className="text-right flex-shrink-0">
                      <div className="text-sm font-medium text-gray-900">
                        {formatDuration(execution.durationMs)}
                      </div>
                      <div className="text-xs text-gray-500">
                        {execution.endedAt 
                          ? formatDate(execution.endedAt)
                          : 'In progress...'
                        }
                      </div>
                    </div>

                    {/* Error */}
                    {execution.error && (
                      <div className="flex-shrink-0 max-w-xs">
                        <div className="flex items-center gap-1 text-red-600 text-xs">
                          <AlertTriangle className="h-3 w-3" />
                          <span className="truncate">{execution.error.slice(0, 50)}...</span>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              );
            })
          ) : (
            <div className="py-12 text-center">
              <History className="h-12 w-12 text-gray-300 mx-auto mb-3" />
              <p className="text-gray-500">No executions found</p>
              <p className="text-sm text-gray-400 mt-1">Try adjusting your filters</p>
            </div>
          )}
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="px-6 py-4 border-t border-gray-200 flex items-center justify-between">
            <button
              onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
              disabled={currentPage === 1}
              className="inline-flex items-center justify-center px-3.5 h-9 text-[14px] text-gray-600 hover:bg-gray-100 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
            >
              Previous
            </button>
            <span className="text-sm text-gray-500">
              Page {currentPage} of {totalPages}
            </span>
            <button
              onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
              disabled={currentPage === totalPages}
              className="inline-flex items-center justify-center px-3.5 h-9 text-[14px] text-gray-600 hover:bg-gray-100 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
            >
              Next
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
