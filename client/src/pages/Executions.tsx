import { useState, useEffect, useCallback, useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  Clock,
  AlertTriangle,
  Zap,
  TrendingUp,
  RefreshCw,
  Layers,
  Globe,
  ChevronRight,
  X,
  ArrowUpRight,
  Download,
  Loader2,
} from 'lucide-react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  AreaChart,
  Area,
} from 'recharts';
import { API_URL } from '../config/api';

type TimeRange = '24h' | '7d' | '30d';
type ViewMode = 'overview' | 'project' | 'flow' | 'api';

interface Execution {
  id: string;
  flowId: string;
  flowName: string;
  flowType: string;
  projectId: string;
  projectName: string;
  projectColor: string;
  status: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  errorType?: string;
  httpStatusCode?: number;
}

interface ProjectStats {
  projectId: string;
  projectName: string;
  projectColor: string;
  total: number;
  success: number;
  failed: number;
  avgDuration: number;
  p95Duration: number;
  errorRate: number;
  throughput: number;
  trend: 'up' | 'down' | 'stable';
  trendValue: number;
}

interface FlowStats {
  flowId: string;
  flowName: string;
  flowType: string;
  projectId: string;
  projectName: string;
  total: number;
  success: number;
  failed: number;
  avgDuration: number;
  errorRate: number;
  lastExecuted: string;
}

interface HourlyData {
  hour: string;
  total: number;
  success: number;
  failed: number;
  avgDuration: number;
}



export default function Executions() {
  
  const [timeRange, setTimeRange] = useState<TimeRange>('24h');
  const [viewMode, setViewMode] = useState<ViewMode>('overview');
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [, setSelectedFlow] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [executions, setExecutions] = useState<Execution[]>([]);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [exporting, setExporting] = useState(false);

  // Fetch executions
  const fetchData = useCallback(async () => {
    try {
      const response = await fetch(`${API_URL}/executions?limit=5000`);
      const result = await response.json();
      if (result.success) {
        const execs = result.data.executions.map((e: any) => {
          // Non-flow source (e.g. data-repository imports) → label accordingly
          const isRepoImport = e.sourceType === 'repo-import';
          const fallbackName = isRepoImport
            ? `Import: ${e.repoTable?.name ?? e.sourceId ?? 'table'}`
            : 'Unknown';
          return {
            id: e.id,
            flowId: e.flowId,
            flowName: e.flow?.name || fallbackName,
            flowType: e.flow?.type || (isRepoImport ? 'REPO_IMPORT' : 'API_SPEC'),
            projectId: e.projectId,
            projectName: e.project?.name || (isRepoImport ? 'Data Repository' : 'Unknown'),
            projectColor: e.project?.color || (isRepoImport ? 'teal' : 'blue'),
            status: e.status,
            startedAt: e.startedAt,
            endedAt: e.endedAt,
            durationMs: e.durationMs,
            errorType: e.errorType,
            httpStatusCode: e.httpStatusCode,
          };
        });
        setExecutions(execs);
      }
      setLoading(false);
    } catch (error) {
      console.error('Error fetching executions:', error);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, [autoRefresh, fetchData]);

  // Filter by time range
  const filteredExecutions = useMemo(() => {
    const now = new Date();
    const start = new Date(now);
    
    switch (timeRange) {
      case '24h':
        start.setHours(start.getHours() - 24);
        break;
      case '7d':
        start.setDate(start.getDate() - 7);
        break;
      case '30d':
        start.setDate(start.getDate() - 30);
        break;
    }

    return executions.filter(e => new Date(e.startedAt) >= start);
  }, [executions, timeRange]);

  // Calculate project stats
  const projectStats = useMemo((): ProjectStats[] => {
    const map = new Map<string, ProjectStats>();
    
    filteredExecutions.forEach(e => {
      const existing = map.get(e.projectId);
      if (existing) {
        existing.total++;
        if (e.status === 'Success' || e.status === 'Completed') existing.success++;
        else if (e.status === 'Failed') existing.failed++;
        if (e.durationMs) {
          existing.avgDuration = (existing.avgDuration * (existing.total - 1) + e.durationMs) / existing.total;
        }
      } else {
        map.set(e.projectId, {
          projectId: e.projectId,
          projectName: e.projectName,
          projectColor: e.projectColor,
          total: 1,
          success: e.status === 'Success' || e.status === 'Completed' ? 1 : 0,
          failed: e.status === 'Failed' ? 1 : 0,
          avgDuration: e.durationMs || 0,
          p95Duration: e.durationMs || 0,
          errorRate: 0,
          throughput: 0,
          trend: 'stable',
          trendValue: 0,
        });
      }
    });

    const stats = Array.from(map.values());
    const hours = timeRange === '24h' ? 24 : timeRange === '7d' ? 168 : 720;
    
    return stats.map(s => {
      
      const durations = filteredExecutions
        .filter(e => e.projectId === s.projectId && e.durationMs)
        .map(e => e.durationMs!)
        .sort((a, b) => a - b);
      
      return {
        ...s,
        errorRate: s.total > 0 ? (s.failed / s.total) * 100 : 0,
        throughput: s.total / hours,
        avgDuration: durations.length > 0 
          ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
          : 0,
        p95Duration: durations.length > 0
          ? durations[Math.floor(durations.length * 0.95)] || durations[durations.length - 1]
          : 0,
      };
    }).sort((a, b) => b.total - a.total);
  }, [filteredExecutions, timeRange]);

  // Calculate flow stats (for selected project)
  const flowStats = useMemo((): FlowStats[] => {
    if (!selectedProject) return [];
    
    const projectExecs = filteredExecutions.filter(e => e.projectId === selectedProject);
    const map = new Map<string, FlowStats>();
    
    projectExecs.forEach(e => {
      const existing = map.get(e.flowId);
      if (existing) {
        existing.total++;
        if (e.status === 'Success' || e.status === 'Completed') existing.success++;
        else if (e.status === 'Failed') existing.failed++;
        if (e.durationMs) {
          existing.avgDuration = (existing.avgDuration * (existing.total - 1) + e.durationMs) / existing.total;
        }
      } else {
        map.set(e.flowId, {
          flowId: e.flowId,
          flowName: e.flowName,
          flowType: e.flowType,
          projectId: e.projectId,
          projectName: e.projectName,
          total: 1,
          success: e.status === 'Success' || e.status === 'Completed' ? 1 : 0,
          failed: e.status === 'Failed' ? 1 : 0,
          avgDuration: e.durationMs || 0,
          errorRate: 0,
          lastExecuted: e.startedAt,
        });
      }
    });

    return Array.from(map.values())
      .map(f => ({
        ...f,
        errorRate: f.total > 0 ? (f.failed / f.total) * 100 : 0,
        avgDuration: Math.round(f.avgDuration),
      }))
      .sort((a, b) => b.total - a.total);
  }, [filteredExecutions, selectedProject]);

  // Hourly heatmap data
  const hourlyData = useMemo((): HourlyData[] => {
    const buckets = new Map<string, { total: number; success: number; failed: number; durations: number[] }>();
    
    const dataToUse = selectedProject 
      ? filteredExecutions.filter(e => e.projectId === selectedProject)
      : filteredExecutions;
    
    dataToUse.forEach(e => {
      const date = new Date(e.startedAt);
      const hour = date.getHours();
      const day = date.toLocaleDateString('en-US', { weekday: 'short' });
      const key = `${day}-${hour}`;
      
      const existing = buckets.get(key);
      if (existing) {
        existing.total++;
        if (e.status === 'Success' || e.status === 'Completed') existing.success++;
        else if (e.status === 'Failed') existing.failed++;
        if (e.durationMs) existing.durations.push(e.durationMs);
      } else {
        buckets.set(key, {
          total: 1,
          success: e.status === 'Success' || e.status === 'Completed' ? 1 : 0,
          failed: e.status === 'Failed' ? 1 : 0,
          durations: e.durationMs ? [e.durationMs] : [],
        });
      }
    });

    const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const result: HourlyData[] = [];
    
    days.forEach(day => {
      for (let hour = 0; hour < 24; hour++) {
        const key = `${day}-${hour}`;
        const data = buckets.get(key);
        result.push({
          hour: `${day} ${hour}:00`,
          total: data?.total || 0,
          success: data?.success || 0,
          failed: data?.failed || 0,
          avgDuration: data?.durations.length 
            ? Math.round(data.durations.reduce((a, b) => a + b, 0) / data.durations.length)
            : 0,
        });
      }
    });
    
    return result;
  }, [filteredExecutions, selectedProject]);

  // Overall stats
  const overallStats = useMemo(() => {
    const total = filteredExecutions.length;
    const success = filteredExecutions.filter(e => e.status === 'Success' || e.status === 'Completed').length;
    const failed = filteredExecutions.filter(e => e.status === 'Failed').length;
    const running = filteredExecutions.filter(e => e.status === 'Running').length;
    
    const durations = filteredExecutions
      .filter(e => e.durationMs)
      .map(e => e.durationMs!)
      .sort((a, b) => a - b);
    
    const hours = timeRange === '24h' ? 24 : timeRange === '7d' ? 168 : 720;
    
    return {
      total,
      success,
      failed,
      running,
      successRate: total > 0 ? (success / total) * 100 : 0,
      errorRate: total > 0 ? (failed / total) * 100 : 0,
      throughput: total / hours,
      avgDuration: durations.length > 0 
        ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
        : 0,
      p95Duration: durations.length > 0
        ? durations[Math.floor(durations.length * 0.95)] || durations[durations.length - 1]
        : 0,
    };
  }, [filteredExecutions, timeRange]);

  // Timeline data for charts
  const timelineData = useMemo(() => {
    const buckets = new Map<string, { total: number; success: number; failed: number; avgDuration: number; count: number }>();
    
    // Create time buckets based on timeRange
    const now = new Date();
    const bucketCount = timeRange === '24h' ? 24 : timeRange === '7d' ? 7 : 10;
    const interval = timeRange === '24h' ? 60 * 60 * 1000 : timeRange === '7d' ? 24 * 60 * 60 * 1000 : 3 * 24 * 60 * 60 * 1000;
    
    for (let i = bucketCount - 1; i >= 0; i--) {
      const time = new Date(now.getTime() - i * interval);
      const key = timeRange === '24h'
        ? time.getHours() + ':00'
        : time.toLocaleString('en-GB', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
      buckets.set(key, { total: 0, success: 0, failed: 0, avgDuration: 0, count: 0 });
    }

    filteredExecutions.forEach(e => {
      const date = new Date(e.startedAt);
      const key = timeRange === '24h'
        ? date.getHours() + ':00'
        : date.toLocaleString('en-GB', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
      
      const existing = buckets.get(key);
      if (existing) {
        existing.total++;
        if (e.status === 'Success' || e.status === 'Completed') existing.success++;
        else if (e.status === 'Failed') existing.failed++;
        if (e.durationMs) {
          existing.avgDuration = (existing.avgDuration * existing.count + e.durationMs) / (existing.count + 1);
          existing.count++;
        }
      }
    });
    
    return Array.from(buckets.entries()).map(([time, data]) => ({
      time,
      total: data.total,
      success: data.success,
      failed: data.failed,
      errorRate: data.total > 0 ? (data.failed / data.total) * 100 : 0,
      avgDuration: Math.round(data.avgDuration),
    }));
  }, [filteredExecutions, timeRange]);

  // Format duration
  const formatDuration = (ms: number) => {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  };

  // Export "รายงานประวัติการเชื่อมโยงข้อมูล" for whatever is on screen right now:
  // same time range, and scoped to the project when one is selected.
  const exportReport = async () => {
    setExporting(true);
    try {
      const params = new URLSearchParams({ range: timeRange, format: 'xlsx' });
      if (selectedProject) params.set('projectId', selectedProject);

      const headers: Record<string, string> = {};
      const token = localStorage.getItem('token');
      if (token) headers.Authorization = `Bearer ${token}`;
      // HTTP headers are ASCII-only and display names are often Thai, so
      // percent-encode; the server decodes it back for the ผู้พิมพ์ line.
      const userStr = localStorage.getItem('user');
      const rawName = userStr ? (JSON.parse(userStr).name || JSON.parse(userStr).email || '') : '';
      if (rawName) headers['X-User-Name'] = encodeURIComponent(rawName);

      const res = await fetch(`${API_URL}/executions/export?${params}`, { headers });
      if (!res.ok) {
        let msg = 'Export failed';
        try { msg = (await res.json()).error || msg; } catch { /* not JSON */ }
        alert(msg);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `data-linkage-report-${new Date().toISOString().slice(0, 10)}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Error exporting report:', error);
      alert('Export failed');
    } finally {
      setExporting(false);
    }
  };

  // Get selected project data
  const selectedProjectData = useMemo(() => {
    return projectStats.find(p => p.projectId === selectedProject);
  }, [projectStats, selectedProject]);

  if (loading) {
    return (
      <div className="p-6 flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500" />
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 space-y-4 sm:space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl sm:text-2xl font-bold text-gray-900">
            {viewMode === 'overview' && 'Execution Monitor'}
            {viewMode === 'project' && selectedProjectData?.projectName}
            {viewMode === 'flow' && 'Flow Details'}
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            {viewMode === 'overview' 
              ? 'Executions across all projects'
              : viewMode === 'project'
              ? `Monitoring ${flowStats.length} flows`
              : 'Detailed flow execution metrics'
            }
          </p>
        </div>
        <div className="flex items-center gap-2 sm:gap-3 flex-wrap">
          {viewMode !== 'overview' && (
            <button
              onClick={() => {
                setViewMode('overview');
                setSelectedProject(null);
                setSelectedFlow(null);
              }}
              className="flex items-center gap-2 px-3 h-9 text-gray-600 hover:bg-gray-100 rounded-lg transition-colors whitespace-nowrap"
            >
              <X className="h-4 w-4" />
              Back
            </button>
          )}
          <button
            onClick={exportReport}
            disabled={exporting}
            title="รายงานประวัติการเชื่อมโยงข้อมูล"
            className="flex items-center gap-2 px-3 h-9 bg-gray-100 text-gray-600 rounded-lg hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
          >
            {exporting
              ? <Loader2 className="h-4 w-4 animate-spin" />
              : <Download className="h-4 w-4" />}
            Export
          </button>
          <button
            onClick={() => setAutoRefresh(!autoRefresh)}
            className={`flex items-center gap-1.5 h-9 px-3 text-[14px] whitespace-nowrap rounded-lg transition-colors ${
              autoRefresh ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'
            }`}
          >
            <RefreshCw className={`h-4 w-4 ${autoRefresh ? 'animate-spin' : ''}`} />
            {autoRefresh ? 'Live' : 'Paused'}
          </button>
          <div className="flex items-center gap-1 bg-gray-100 p-1 rounded-lg">
            {(['24h', '7d', '30d'] as TimeRange[]).map(range => (
              <button
                key={range}
                onClick={() => setTimeRange(range)}
                className={`inline-flex items-center justify-center px-3 h-9 rounded-lg text-[14px] font-medium transition-colors ${
                  timeRange === range
                    ? 'bg-white text-gray-900 shadow-sm'
                    : 'text-gray-500 hover:text-gray-700'
                } whitespace-nowrap`}
              >
                {range === '24h' ? '24H' : range === '7d' ? '7D' : '30D'}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-3 lg:grid-cols-6 gap-2 sm:gap-3">
        <div className="bg-white rounded-lg border border-gray-200 px-2.5 py-2 sm:p-3 min-w-0">
          <div className="flex items-center gap-1.5 text-gray-500 mb-1 min-w-0">
            <Zap className="h-3.5 w-3.5 shrink-0" />
            <span className="text-[12px] sm:text-xs font-medium truncate">Throughput</span>
          </div>
          <div className="text-lg sm:text-xl font-bold leading-tight text-gray-900">
            {overallStats.throughput.toFixed(1)}
          </div>
          <div className="text-[12px] text-gray-500 truncate">req/hour</div>
        </div>

        <div className="bg-white rounded-lg border border-gray-200 px-2.5 py-2 sm:p-3 min-w-0">
          <div className="flex items-center gap-1.5 text-gray-500 mb-1 min-w-0">
            <Clock className="h-3.5 w-3.5 shrink-0" />
            <span className="text-[12px] sm:text-xs font-medium truncate">Avg Response</span>
          </div>
          <div className="text-lg sm:text-xl font-bold leading-tight text-gray-900">
            {formatDuration(overallStats.avgDuration)}
          </div>
          <div className="text-[12px] text-gray-500 truncate">p95: {formatDuration(overallStats.p95Duration)}</div>
        </div>

        <div className="bg-white rounded-lg border border-gray-200 px-2.5 py-2 sm:p-3 min-w-0">
          <div className="flex items-center gap-1.5 text-gray-500 mb-1 min-w-0">
            <TrendingUp className="h-3.5 w-3.5 shrink-0" />
            <span className="text-[12px] sm:text-xs font-medium truncate">Success Rate</span>
          </div>
          <div className="text-lg sm:text-xl font-bold leading-tight text-gray-900">
            {overallStats.successRate.toFixed(1)}%
          </div>
          <div className="text-[12px] text-gray-500 truncate">{overallStats.success} / {overallStats.total}</div>
        </div>

        <div className={`rounded-lg border px-2.5 py-2 sm:p-3 min-w-0 ${overallStats.errorRate > 5 ? 'bg-red-50 border-red-200' : 'bg-white border-gray-200'}`}>
          <div className={`flex items-center gap-2 mb-2 ${overallStats.errorRate > 5 ? 'text-red-600' : 'text-gray-500'}`}>
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            <span className="text-[12px] sm:text-xs font-medium truncate">Error Rate</span>
          </div>
          <div className={`text-lg sm:text-xl font-bold leading-tight ${overallStats.errorRate > 5 ? 'text-red-700' : 'text-gray-900'}`}>
            {overallStats.errorRate.toFixed(1)}%
          </div>
          <div className={`text-xs ${overallStats.errorRate > 5 ? 'text-red-600' : 'text-gray-500'}`}>
            {overallStats.failed} errors
          </div>
        </div>

        <div className="bg-white rounded-lg border border-gray-200 px-2.5 py-2 sm:p-3 min-w-0">
          <div className="flex items-center gap-1.5 text-gray-500 mb-1 min-w-0">
            <Activity className="h-3.5 w-3.5 shrink-0" />
            <span className="text-[12px] sm:text-xs font-medium truncate">Active</span>
          </div>
          <div className="text-lg sm:text-xl font-bold leading-tight text-blue-600">
            {overallStats.running}
          </div>
          <div className="text-[12px] text-gray-500 truncate">running now</div>
        </div>

        <div className="bg-white rounded-lg border border-gray-200 px-2.5 py-2 sm:p-3 min-w-0">
          <div className="flex items-center gap-1.5 text-gray-500 mb-1 min-w-0">
            <Layers className="h-3.5 w-3.5 shrink-0" />
            <span className="text-[12px] sm:text-xs font-medium truncate">Total</span>
          </div>
          <div className="text-lg sm:text-xl font-bold leading-tight text-gray-900">
            {overallStats.total}
          </div>
          <div className="text-[12px] text-gray-500 truncate">executions</div>
        </div>
      </div>

      {/* Main Content */}
      {viewMode === 'overview' ? (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Project Activity - Left Side */}
          <div className="lg:col-span-2 bg-white rounded-xl border border-gray-200 p-4 sm:p-6">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-4 sm:mb-6">
              <div className="min-w-0">
                <h3 className="text-lg font-semibold text-gray-900">Project Activity</h3>
                <p className="text-sm text-gray-500">Project execution performance and metrics</p>
              </div>
              <div className="flex items-center gap-2 text-xs text-gray-500">
                <span className="w-3 h-3 bg-gray-100 rounded" /> 0
                <span className="w-3 h-3 bg-blue-200 rounded" /> Low
                <span className="w-3 h-3 bg-blue-400 rounded" /> Med
                <span className="w-3 h-3 bg-blue-600 rounded" /> High
              </div>
            </div>
            
            <div className="space-y-3">
              {projectStats.map(project => (
                <div
                  key={project.projectId}
                  className="group flex items-center gap-4 p-4 rounded-xl border border-gray-200 hover:border-blue-300 hover:shadow-md transition-all"
                >
                  {/* Project Color Indicator */}
                  <div className={`w-3 h-12 rounded-full bg-${project.projectColor}-500`} 
                       style={{ backgroundColor: `var(--color-${project.projectColor}, #3b82f6)` }} />
                  
                  {/* Project Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h4 className="font-semibold text-gray-900 truncate">
                        {project.projectName}
                      </h4>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-2 sm:gap-x-4 gap-y-0.5 mt-1 text-xs sm:text-sm text-gray-500">
                      <span>{project.total} executions</span>
                      <span>•</span>
                      <span>{formatDuration(project.avgDuration)} avg</span>
                      <span>•</span>
                      <span className={project.errorRate > 5 ? 'text-red-600' : 'text-green-600'}>
                        {project.errorRate.toFixed(1)}% errors
                      </span>
                    </div>
                  </div>

                  {/* Stats (req/h + success bar from sm; the line above already says it on phones) */}
                  <div className="flex items-center gap-6 text-right">
                    <div className="hidden sm:block">
                      <div className="text-lg font-semibold text-gray-900">
                        {project.throughput.toFixed(1)}
                      </div>
                      <div className="text-xs text-gray-500">req/h</div>
                    </div>
                    <div className="hidden sm:block w-24">
                      <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                        <div 
                          className="h-full bg-green-500 rounded-full"
                          style={{ width: `${Math.min(100, 100 - project.errorRate)}%` }}
                        />
                      </div>
                      <div className="text-xs text-gray-500 mt-1">Success Rate</div>
                    </div>
                    {/* Link to Project Executions */}
                    <Link
                      to={`/projects/${project.projectId}/executions`}
                      className="p-2 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                      title="View project executions"
                    >
                      <ArrowUpRight className="h-5 w-5" />
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          </div>

        {/* Charts - Right Side */}
        <div className="space-y-4">
          {/* Execution Timeline with Success/Fail Lines */}
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <h3 className="text-sm font-semibold text-gray-900 mb-2">Execution Timeline</h3>
            <div className="h-28">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={timelineData}>
                  <defs>
                    <linearGradient id="colorSuccess" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#10b981" stopOpacity={0.2}/>
                      <stop offset="95%" stopColor="#10b981" stopOpacity={0}/>
                    </linearGradient>
                    <linearGradient id="colorFail" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#ef4444" stopOpacity={0.2}/>
                      <stop offset="95%" stopColor="#ef4444" stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
                  <XAxis dataKey="time" tick={{ fontSize: 8 }} stroke="#9ca3af" interval="preserveStartEnd" />
                  <YAxis tick={{ fontSize: 8 }} stroke="#9ca3af" width={25} />
                  <Tooltip 
                    contentStyle={{ borderRadius: '6px', border: '1px solid #e5e7eb', fontSize: '11px' }}
                  />
                  <Area type="monotone" dataKey="success" name="Success" stroke="#10b981" fill="url(#colorSuccess)" strokeWidth={1.5} />
                  <Area type="monotone" dataKey="failed" name="Failed" stroke="#ef4444" fill="url(#colorFail)" strokeWidth={1.5} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
            <div className="flex items-center gap-4 mt-2 text-xs">
              <div className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-green-500" />
                <span className="text-gray-600">Success</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-red-500" />
                <span className="text-gray-600">Failed</span>
              </div>
            </div>
          </div>

          {/* Response Time Trend */}
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <h3 className="text-sm font-semibold text-gray-900 mb-2">Response Time</h3>
            <div className="h-28">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={timelineData}>
                  <defs>
                    <linearGradient id="colorDuration" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.2}/>
                      <stop offset="95%" stopColor="#3b82f6" stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
                  <XAxis dataKey="time" tick={{ fontSize: 8 }} stroke="#9ca3af" interval="preserveStartEnd" />
                  <YAxis tick={{ fontSize: 8 }} stroke="#9ca3af" width={44} tickFormatter={(v) => (v >= 1000 ? `${(v / 1000).toFixed(0)}s` : `${v}ms`)} />
                  <Tooltip 
                    contentStyle={{ borderRadius: '6px', border: '1px solid #e5e7eb', fontSize: '11px' }}
                    formatter={(value) => [`${value}ms`, 'Avg']}
                  />
                  <Area type="monotone" dataKey="avgDuration" stroke="#3b82f6" fill="url(#colorDuration)" strokeWidth={1.5} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Error Rate Trend */}
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <h3 className="text-sm font-semibold text-gray-900 mb-2">Error Rate</h3>
            <div className="h-28">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={timelineData}>
                  <defs>
                    <linearGradient id="colorError" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#ef4444" stopOpacity={0.2}/>
                      <stop offset="95%" stopColor="#ef4444" stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
                  <XAxis dataKey="time" tick={{ fontSize: 8 }} stroke="#9ca3af" interval="preserveStartEnd" />
                  <YAxis tick={{ fontSize: 8 }} stroke="#9ca3af" width={25} tickFormatter={(v) => `${v}%`} />
                  <Tooltip 
                    contentStyle={{ borderRadius: '6px', border: '1px solid #e5e7eb', fontSize: '11px' }}
                    formatter={(value) => [`${Number(value).toFixed(1)}%`, 'Error']}
                  />
                  <Area type="monotone" dataKey="errorRate" stroke="#ef4444" fill="url(#colorError)" strokeWidth={1.5} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      </div>
      ) : viewMode === 'project' && selectedProjectData ? (
        <div className="space-y-6">
          {/* Project Summary Cards */}
          <div className="grid grid-cols-2 sm:grid-cols-2 md:grid-cols-4 gap-4">
            <div className="bg-white rounded-xl border border-gray-200 p-4">
              <div className="text-gray-500 text-sm mb-1">Total Executions</div>
              <div className="text-3xl font-bold text-gray-900">{selectedProjectData.total}</div>
              <div className="text-gray-400 text-xs mt-1">
                {selectedProjectData.throughput.toFixed(1)} / hour
              </div>
            </div>
            <div className="bg-white rounded-xl border border-gray-200 p-4">
              <div className="text-gray-500 text-sm mb-1">Success Rate</div>
              <div className="text-3xl font-bold text-gray-900">
                {((selectedProjectData.success / selectedProjectData.total) * 100).toFixed(1)}%
              </div>
              <div className="text-gray-400 text-xs mt-1">
                {selectedProjectData.success} succeeded
              </div>
            </div>
            <div className="bg-white rounded-xl border border-gray-200 p-4">
              <div className="text-gray-500 text-sm mb-1">Avg Response</div>
              <div className="text-3xl font-bold text-gray-900">
                {formatDuration(selectedProjectData.avgDuration)}
              </div>
              <div className="text-gray-400 text-xs mt-1">
                p95: {formatDuration(selectedProjectData.p95Duration)}
              </div>
            </div>
            <div className={`rounded-xl border p-4 ${selectedProjectData.errorRate > 5 ? 'bg-red-50 border-red-200' : 'bg-white border-gray-200'}`}>
              <div className={`text-sm mb-1 ${selectedProjectData.errorRate > 5 ? 'text-red-600' : 'text-gray-500'}`}>
                Error Rate
              </div>
              <div className={`text-3xl font-bold ${selectedProjectData.errorRate > 5 ? 'text-red-700' : 'text-gray-900'}`}>
                {selectedProjectData.errorRate.toFixed(1)}%
              </div>
              <div className={`text-xs mt-1 ${selectedProjectData.errorRate > 5 ? 'text-red-600' : 'text-gray-400'}`}>
                {selectedProjectData.failed} failed
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Flows List */}
            <div className="bg-white rounded-xl border border-gray-200 p-6">
              <h3 className="text-lg font-semibold text-gray-900 mb-4">Flows</h3>
              <div className="space-y-2">
                {flowStats.map(flow => (
                  <div
                    key={flow.flowId}
                    onClick={() => {
                      setSelectedFlow(flow.flowId);
                      setViewMode('flow');
                    }}
                    className="flex items-center gap-4 p-3 rounded-lg border border-gray-100 hover:border-blue-300 hover:bg-blue-50 transition-all cursor-pointer group"
                  >
                    <div className={`w-2 h-10 rounded-full ${flow.flowType === 'API_SPEC' ? 'bg-blue-500' : 'bg-purple-500'}`} />
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-gray-900 group-hover:text-blue-600 truncate">
                        {flow.flowName}
                      </div>
                      <div className="text-xs text-gray-500">
                        {flow.flowType === 'API_SPEC' ? 'API Flow' : 'Triggers'} • {flow.total} runs
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-sm font-medium text-gray-900">
                        {formatDuration(flow.avgDuration)}
                      </div>
                      <div className={`text-xs ${flow.errorRate > 5 ? 'text-red-600' : 'text-green-600'}`}>
                        {flow.errorRate.toFixed(1)}% errors
                      </div>
                    </div>
                    <ChevronRight className="h-4 w-4 text-gray-400 group-hover:text-blue-500" />
                  </div>
                ))}
              </div>
            </div>

            {/* Hourly Heatmap */}
            <div className="bg-white rounded-xl border border-gray-200 p-6">
              <h3 className="text-lg font-semibold text-gray-900 mb-4">Activity Heatmap</h3>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={hourlyData.slice(-24)}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
                    <XAxis 
                      dataKey="hour" 
                      tick={{ fontSize: 10 }}
                      tickFormatter={(v) => v.split(' ')[1]}
                    />
                    <YAxis tick={{ fontSize: 10 }} />
                    <Tooltip />
                    <Bar dataKey="total" fill="#3b82f6" radius={[2, 2, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="text-center py-12">
          <Globe className="h-12 w-12 text-gray-300 mx-auto mb-4" />
          <p className="text-gray-500">Select a project to view details</p>
        </div>
      )}
    </div>
  );
}
