import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { 
  GitBranch, FolderKanban, Clock, CheckCircle, 
  XCircle, Play, Activity, TrendingUp, AlertCircle,
  Zap, ChevronRight
} from 'lucide-react';

import { API_URL } from '../../config/api';

interface Project {
  id: string;
  name: string;
  description: string;
  status: string;
  color: string;
}

interface ProjectStats {
  totalFlows: number;
  apiFlows: number;
  triggerFlows: number;
  baskets: number;
  connections: number;
  totalExecutions: number;
  successExecutions: number;
  failedExecutions: number;
  runningExecutions: number;
  lastExecution: {
    flowName: string;
    status: string;
    startedAt: string;
  } | null;
}

interface RecentExecution {
  id: string;
  flowName: string;
  flowType: string;
  status: string;
  startedAt: string;
  duration: string;
}

export const ProjectDashboard = ({ project }: { project: Project }) => {
  const navigate = useNavigate();
  const [stats, setStats] = useState<ProjectStats>({
    totalFlows: 0,
    apiFlows: 0,
    triggerFlows: 0,
    baskets: 0,
    connections: 0,
    totalExecutions: 0,
    successExecutions: 0,
    failedExecutions: 0,
    runningExecutions: 0,
    lastExecution: null
  });
  const [recentExecutions, setRecentExecutions] = useState<RecentExecution[]>([]);
  const [loading, setLoading] = useState(true);

  // Helper functions - Same as ProjectExecutions
  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'Completed':
      case 'Success':
        return <CheckCircle className="h-4 w-4 text-green-500" />;
      case 'Failed':
        return <XCircle className="h-4 w-4 text-red-500" />;
      case 'Running':
        return <Play className="h-4 w-4 text-blue-500" />;
      default:
        return <Clock className="h-4 w-4 text-gray-500" />;
    }
  };

  const getStatusBadge = (status: string) => {
    const styles: Record<string, string> = {
      Completed: 'bg-green-100 text-green-700 border-green-200',
      Success: 'bg-green-100 text-green-700 border-green-200',
      Failed: 'bg-red-100 text-red-700 border-red-200',
      Running: 'bg-blue-100 text-blue-700 border-blue-200',
      Pending: 'bg-yellow-100 text-yellow-700 border-yellow-200',
    };
    return styles[status] || 'bg-gray-100 text-gray-700 border-gray-200';
  };

  const getFlowTypeBadge = (type: string) => {
    if (type === 'API_SPEC') {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-blue-50 text-blue-700 border border-blue-100">
          <Zap className="h-3 w-3" />
          API Flow
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-purple-50 text-purple-700 border border-purple-100">
        <Activity className="h-3 w-3" />
        Triggers
      </span>
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

  // Note: formatDuration is available in ProjectExecutions if needed

  useEffect(() => {
    fetchProjectStats();
  }, [project.id]);

  // Refresh data when page becomes visible (e.g., after clearing logs)
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        fetchProjectStats();
      }
    };
    
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [project.id]);

  // Auto-refresh every 10 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      fetchProjectStats();
    }, 10000);
    
    return () => clearInterval(interval);
  }, [project.id]);

  const fetchProjectStats = async () => {
    try {
      // Fetch project details with all relations
      const response = await fetch(`${API_URL}/projects/${project.id}`);
      const result = await response.json();
      
      if (result.success) {
        const data = result.data;
        
        // Calculate stats
        const flows = data.flows || [];
        const executions = data.executions || [];
        
        setStats({
          totalFlows: flows.length,
          apiFlows: flows.filter((f: any) => f.type?.toUpperCase() === 'API_SPEC').length,
          triggerFlows: flows.filter((f: any) => f.type?.toUpperCase() === 'TRIGGER').length,
          baskets: (data.baskets || []).length,
          connections: (data.connections || []).length,
          totalExecutions: executions.length,
          successExecutions: executions.filter((e: any) => e.status === 'Success' || e.status === 'Completed').length,
          failedExecutions: executions.filter((e: any) => e.status === 'Failed').length,
          runningExecutions: executions.filter((e: any) => e.status === 'Running').length,
          lastExecution: executions.length > 0 ? {
            flowName: executions[0].flow?.name || 'Unknown',
            status: executions[0].status,
            startedAt: executions[0].startedAt
          } : null
        });

        // Recent executions
        setRecentExecutions(executions.slice(0, 5).map((e: any) => ({
          id: e.id,
          flowName: e.flow?.name || 'Unknown',
          flowType: e.flow?.type || 'Unknown',
          status: e.status,
          startedAt: e.startedAt,
          duration: e.endedAt 
            ? `${Math.round((new Date(e.endedAt).getTime() - new Date(e.startedAt).getTime()) / 1000)}s`
            : '-'
        })));
      }
    } catch (error) {
      console.error('Error fetching project stats:', error);
    } finally {
      setLoading(false);
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'Completed':
      case 'Success':
        return 'bg-green-100 text-green-700';
      case 'Failed':
        return 'bg-red-100 text-red-700';
      case 'Running':
        return 'bg-blue-100 text-blue-700';
      default:
        return 'bg-gray-100 text-gray-700';
    }
  };

  const formatTime = (dateStr: string) => {
    const date = new Date(dateStr);
    const now = new Date();
    const diff = Math.floor((now.getTime() - date.getTime()) / 1000);
    
    if (diff < 60) return 'Just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 space-y-4 sm:space-y-6">
      {/* Quick Stats Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {[
          {
            label: 'Flows', value: stats.totalFlows, icon: GitBranch, tint: 'text-blue-500', to: 'flows',
            meta: <><span className="text-indigo-600">{stats.apiFlows} API</span><span className="text-orange-600">{stats.triggerFlows} Triggers</span></>,
          },
          {
            label: 'Executions', value: stats.totalExecutions, icon: Activity, tint: 'text-green-500', to: 'executions',
            meta: <>
              <span className="flex items-center gap-0.5 text-green-600"><CheckCircle className="h-3 w-3" />{stats.successExecutions}</span>
              <span className="flex items-center gap-0.5 text-red-600"><XCircle className="h-3 w-3" />{stats.failedExecutions}</span>
              {stats.runningExecutions > 0 && <span className="flex items-center gap-0.5 text-blue-600"><Play className="h-3 w-3" />{stats.runningExecutions}</span>}
            </>,
          },
          { label: 'Baskets', value: stats.baskets, icon: FolderKanban, tint: 'text-amber-500', to: 'baskets', meta: null },
          { label: 'Connections', value: stats.connections, icon: TrendingUp, tint: 'text-purple-500', to: 'connections', meta: null },
        ].map(card => (
          <button
            key={card.label}
            type="button"
            onClick={() => navigate(`/projects/${project.id}/${card.to}`)}
            className="bg-white rounded-lg border border-gray-200 px-3 py-2 text-left hover:border-blue-300 transition-colors min-w-0"
          >
            <div className="flex items-center gap-1.5 text-xs text-gray-500">
              <card.icon className={`h-3.5 w-3.5 shrink-0 ${card.tint}`} />
              <span className="truncate">{card.label}</span>
            </div>
            <div className="flex items-baseline gap-2 min-w-0">
              <span className="text-lg font-semibold text-gray-900 leading-tight tabular-nums">{card.value}</span>
              {card.meta && <span className="flex items-center gap-1.5 text-[11px] whitespace-nowrap overflow-hidden">{card.meta}</span>}
            </div>
          </button>
        ))}
      </div>

      {/* Main Content Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Recent Executions */}
        <div className="lg:col-span-2 bg-white rounded-xl border border-gray-200">
          <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
            <h3 className="font-semibold text-gray-900 flex items-center gap-2">
              <Clock className="h-5 w-5 text-gray-400" />
              Recent Executions
            </h3>
            <button 
              onClick={() => navigate(`/projects/${project.id}/executions`)}
              className="text-sm text-blue-600 hover:text-blue-700"
            >
              View all
            </button>
          </div>
          <div className="p-3 space-y-2">
            {recentExecutions.length > 0 ? (
              recentExecutions.map((execution) => (
                <div
                  key={execution.id}
                  onClick={() => navigate(`/projects/${project.id}/executions?id=${execution.id}`)}
                  className="bg-white border border-gray-200 rounded-lg p-3 hover:border-blue-300 hover:shadow-sm transition-all cursor-pointer"
                >
                  <div className="flex items-center justify-between">
                    {/* Left: Flow Info */}
                    <div className="flex items-center gap-3 flex-1 min-w-0">
                      {getStatusIcon(execution.status)}
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-sm text-gray-900 truncate">
                            {execution.flowName}
                          </span>
                          {getFlowTypeBadge(execution.flowType)}
                        </div>
                        <div className="flex items-center gap-2 text-xs text-gray-500">
                          <span>ID: {execution.id.slice(-8)}</span>
                          <span>•</span>
                          <span>{formatDate(execution.startedAt)}</span>
                          {execution.duration !== '-' && (
                            <>
                              <span>•</span>
                              <span>{execution.duration}</span>
                            </>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Right: Status & Chevron */}
                    <div className="flex items-center gap-3 ml-4">
                      <span className={`px-2 py-1 text-xs rounded-full border ${getStatusBadge(execution.status)}`}>
                        {execution.status}
                      </span>
                      <ChevronRight className="h-4 w-4 text-gray-400" />
                    </div>
                  </div>

                  {/* Error Preview (if failed) */}
                  {execution.status === 'Failed' && (
                    <div className="mt-2 flex items-center gap-2 text-xs text-red-600 bg-red-50 px-2 py-1.5 rounded">
                      <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />
                      <span className="truncate">Execution failed</span>
                    </div>
                  )}
                </div>
              ))
            ) : (
              <div className="px-5 py-8 text-center text-gray-500">
                <Clock className="h-12 w-12 mx-auto mb-2 text-gray-300" />
                <p>No executions yet</p>
                <p className="text-sm">Run a flow to see executions here</p>
              </div>
            )}
          </div>
        </div>

        {/* Status Panel */}
        <div className="space-y-4">
          {/* Last Execution */}
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <h3 className="font-semibold text-gray-900 mb-4 flex items-center gap-2">
              <Activity className="h-5 w-5 text-gray-400" />
              Last Execution
            </h3>
            {stats.lastExecution ? (
              <div className="space-y-3">
                <div className="flex items-center gap-3">
                  {stats.lastExecution.status === 'Completed' || stats.lastExecution.status === 'Success' ? (
                    <div className="w-10 h-10 bg-green-100 rounded-lg flex items-center justify-center">
                      <CheckCircle className="h-5 w-5 text-green-500" />
                    </div>
                  ) : stats.lastExecution.status === 'Failed' ? (
                    <div className="w-10 h-10 bg-red-100 rounded-lg flex items-center justify-center">
                      <XCircle className="h-5 w-5 text-red-500" />
                    </div>
                  ) : (
                    <div className="w-10 h-10 bg-blue-100 rounded-lg flex items-center justify-center">
                      <Play className="h-5 w-5 text-blue-500" />
                    </div>
                  )}
                  <div>
                    <p className="font-medium text-gray-900">{stats.lastExecution.flowName}</p>
                    <p className="text-sm text-gray-500">{formatTime(stats.lastExecution.startedAt)}</p>
                  </div>
                </div>
                <div className={`inline-flex px-3 py-1 rounded-full text-sm font-medium ${getStatusColor(stats.lastExecution.status)}`}>
                  {stats.lastExecution.status}
                </div>
              </div>
            ) : (
              <div className="text-center py-4 text-gray-500">
                <AlertCircle className="h-10 w-10 mx-auto mb-2 text-gray-300" />
                <p className="text-sm">No executions yet</p>
              </div>
            )}
          </div>

          {/* Quick Actions */}
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <h3 className="font-semibold text-gray-900 mb-4">Quick Actions</h3>
            <div className="space-y-2">
              <button
                onClick={() => navigate(`/projects/${project.id}/flows`)}
                className="w-full flex items-center gap-3 p-3 rounded-lg hover:bg-gray-50 transition-colors text-left"
              >
                <div className="w-8 h-8 bg-blue-100 rounded-lg flex items-center justify-center">
                  <GitBranch className="h-4 w-4 text-blue-500" />
                </div>
                <div>
                  <p className="font-medium text-gray-900">Create Flow</p>
                  <p className="text-xs text-gray-500">API or Trigger flow</p>
                </div>
              </button>
              <button
                onClick={() => navigate(`/projects/${project.id}/baskets`)}
                className="w-full flex items-center gap-3 p-3 rounded-lg hover:bg-gray-50 transition-colors text-left"
              >
                <div className="w-8 h-8 bg-amber-100 rounded-lg flex items-center justify-center">
                  <FolderKanban className="h-4 w-4 text-amber-500" />
                </div>
                <div>
                  <p className="font-medium text-gray-900">Create Basket</p>
                  <p className="text-xs text-gray-500">For file storage</p>
                </div>
              </button>
              <button
                onClick={() => navigate(`/projects/${project.id}/connections`)}
                className="w-full flex items-center gap-3 p-3 rounded-lg hover:bg-gray-50 transition-colors text-left"
              >
                <div className="w-8 h-8 bg-purple-100 rounded-lg flex items-center justify-center">
                  <TrendingUp className="h-4 w-4 text-purple-500" />
                </div>
                <div>
                  <p className="font-medium text-gray-900">Add Connection</p>
                  <p className="text-xs text-gray-500">SFTP, DB, API</p>
                </div>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ProjectDashboard;
