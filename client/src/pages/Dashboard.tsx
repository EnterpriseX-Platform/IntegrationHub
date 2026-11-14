import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  FolderOpen, Layers, Plug, ArrowRight,
  Loader2, Clock, Activity, CheckCircle2, AlertCircle,
  Play, Pause, Inbox, RefreshCw,
  Zap
} from 'lucide-react';

import { API_URL } from '../config/api';

const colorMap: Record<string, { bg: string; text: string; border: string; light: string }> = {
  blue: { bg: 'bg-blue-500', text: 'text-blue-600', border: 'border-blue-400', light: 'bg-blue-50' },
  purple: { bg: 'bg-purple-500', text: 'text-purple-600', border: 'border-purple-400', light: 'bg-purple-50' },
  green: { bg: 'bg-green-500', text: 'text-green-600', border: 'border-green-400', light: 'bg-green-50' },
  orange: { bg: 'bg-orange-500', text: 'text-orange-600', border: 'border-orange-400', light: 'bg-orange-50' },
  pink: { bg: 'bg-pink-500', text: 'text-pink-600', border: 'border-pink-400', light: 'bg-pink-50' },
  cyan: { bg: 'bg-cyan-500', text: 'text-cyan-600', border: 'border-cyan-400', light: 'bg-cyan-50' },
  amber: { bg: 'bg-amber-500', text: 'text-amber-600', border: 'border-amber-400', light: 'bg-amber-50' },
  red: { bg: 'bg-red-500', text: 'text-red-600', border: 'border-red-400', light: 'bg-red-50' },
};

interface Project {
  id: string;
  name: string;
  description?: string;
  color: string;
  status: string;
  flowCount?: number;
  connectionCount?: number;
  updatedAt: string;
  image?: string | null;
}

interface Execution {
  id: string;
  flowName: string;
  projectName: string;
  status: 'running' | 'completed' | 'failed' | 'pending';
  startedAt: string;
  duration?: number;
}

interface Scheduler {
  id: string;
  flowName: string;
  projectName: string;
  schedule: string;
  status: 'active' | 'paused' | 'running';
  lastRun?: string;
}

interface DashboardStats {
  totalProjects: number;
  activeProjects: number;
  totalFlows: number;
  totalConnections: number;
  todayExecutions: number;
  runningExecutions: number;
  failedExecutions: number;
  activeSchedulers: number;
  pausedSchedulers: number;
  pendingBaskets: number;
}

// KPI Stat Card
// Trend badges and sparklines were dropped from these cards: they were
// hardcoded/generated, not measured, so they showed numbers that meant nothing.
const KpiCard = ({ 
  title, 
  value, 
  subtext,
  icon: Icon, 
  color,
  onClick 
}: { 
  title: string; 
  value: string | number; 
  subtext?: string;
  trend?: string;
  isPositive?: boolean;
  icon: any; 
  color: string;
  chartData?: number[];
  onClick?: () => void;
}) => {
  // Icons stay grey; colour is kept for the one card where it means something
  // (failures today), and only when that number isn't zero.
  const alert = color === 'red' && Number(value) > 0;

  // Carbon tile (RunLoop style): small coloured icon + label, big light number
  const tint: Record<string, string> = {
    blue: 'text-blue-600', green: 'text-green-600', purple: 'text-purple-600', cyan: 'text-cyan-600',
    orange: 'text-orange-600', red: 'text-red-600', amber: 'text-yellow-600',
  };

  return (
    <div
      onClick={onClick}
      className="bg-white px-4 py-4 cursor-pointer transition-colors hover:bg-gray-100 min-w-0"
    >
      <div className="flex items-center gap-2 text-sm text-gray-600 min-w-0">
        <Icon className={`h-4 w-4 shrink-0 ${tint[color] || 'text-gray-500'}`} />
        <span className="truncate" title={title}>{title}</span>
      </div>
      <p className={`mt-3 text-[2.5rem] leading-none font-light tabular-nums ${alert ? 'text-red-600' : 'text-gray-900'}`}>{value}</p>
      <p className="mt-3 text-xs text-gray-500 truncate">{subtext || '\u00a0'}</p>
    </div>
  );
};

// Project Card
const ProjectCard = ({ project, onClick }: { project: Project; onClick: () => void }) => {
  const colors = colorMap[project.color] || colorMap.blue;
  
  const formatTime = (date: string) => {
    const d = new Date(date);
    const now = new Date();
    const diff = Math.floor((now.getTime() - d.getTime()) / 60000);
    if (diff < 1) return 'Just now';
    if (diff < 60) return `${diff}m ago`;
    if (diff < 1440) return `${Math.floor(diff / 60)}h ago`;
    return `${Math.floor(diff / 1440)}d ago`;
  };

  return (
    <div
      onClick={onClick}
      className="bg-white rounded-lg border border-gray-200 cursor-pointer transition-colors hover:border-blue-300 overflow-hidden group"
    >
      <div className="p-3">
        <div className="flex items-center gap-2.5">
          <div className={`w-9 h-9 ${colors.bg} rounded-lg flex items-center justify-center flex-shrink-0`}>
            <span className="text-white font-bold text-sm">{project.name[0]}</span>
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="font-medium text-sm text-gray-900 truncate group-hover:text-blue-600 transition-colors">
              {project.name}
            </h3>
            <div className="flex items-center gap-2 mt-0.5">
              <span className={`text-[12px] px-1.5 py-0.5 rounded ${colors.light} ${colors.text}`}>
                {project.status}
              </span>
              <span className="text-[12px] text-gray-400">{project.flowCount || 0} flows</span>
            </div>
          </div>
        </div>
      </div>
      <div className="px-3 py-1.5 bg-gray-50 border-t border-gray-100">
        <span className="text-[12px] text-gray-400">Updated {formatTime(project.updatedAt)}</span>
      </div>
    </div>
  );
};

export default function Dashboard() {
  const navigate = useNavigate();
  const [stats, setStats] = useState<DashboardStats>({
    totalProjects: 0,
    activeProjects: 0,
    totalFlows: 0,
    totalConnections: 0,
    todayExecutions: 0,
    runningExecutions: 0,
    failedExecutions: 0,
    activeSchedulers: 0,
    pausedSchedulers: 0,
    pendingBaskets: 0,
  });
  const [projects, setProjects] = useState<Project[]>([]);
  const [, setExecutions] = useState<Execution[]>([]);
  const [, setSchedulers] = useState<Scheduler[]>([]);
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  // Chart data from real trends
  const [executionTrend, setExecutionTrend] = useState<number[]>([12, 15, 18, 14, 20, 25, 22, 28, 32, 30, 35, 40]);
  const [projectTrend, setProjectTrend] = useState<number[]>([2, 3, 3, 4, 5, 6, 6, 7, 8, 8, 9, 10]);
  const [schedulerTrend, setSchedulerTrend] = useState<number[]>([1, 1, 2, 2, 3, 3, 3, 4, 4, 5, 5, 5]);

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    try {
      setLoading(true);
      
      // Fetch projects
      const projectsRes = await fetch(`${API_URL}/projects`);
      const projectsData = await projectsRes.json();
      const projects: Project[] = projectsData.success ? projectsData.data : [];
      
      const totalFlows = projects.reduce((acc, p) => acc + (p.flowCount || 0), 0);
      const totalConnections = projects.reduce((acc, p) => acc + (p.connectionCount || 0), 0);
      const activeProjects = projects.filter(p => p.status === 'active').length;
      
      setProjects(projects.slice(0, 6));
      setProjectTrend(generateTrend(projects.length, 12));

      // Fetch executions
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      
      const executionsRes = await fetch(`${API_URL}/executions?limit=20`);
      const executionsData = await executionsRes.json();
      
      let executionsList: Execution[] = [];
      let todayExecutions = 0;
      let runningExecutions = 0;
      let failedExecutions = 0;
      
      if (executionsData.success && executionsData.data?.executions) {
        const rawExecutions = executionsData.data.executions;
        
        executionsList = rawExecutions.slice(0, 4).map((e: any) => ({
          id: e.id,
          flowName: e.flow?.name || 'Unknown Flow',
          projectName: e.project?.name || 'Unknown Project',
          status: e.status === 'Running' ? 'running' : 
                  e.status === 'Completed' || e.status === 'Success' ? 'completed' : 
                  e.status === 'Failed' ? 'failed' : 'pending',
          startedAt: e.startedAt,
          duration: e.duration,
        }));
        
        // Calculate stats
        rawExecutions.forEach((e: any) => {
          const execDate = new Date(e.startedAt);
          if (execDate >= today) {
            todayExecutions++;
            if (e.status === 'Failed') failedExecutions++;
          }
          if (e.status === 'Running') runningExecutions++;
        });
        
        setExecutionTrend(generateTrend(todayExecutions, 12));
      }
      
      setExecutions(executionsList);

      // Fetch schedulers from schedulers table (single source of truth)
      let activeSchedulers = 0;
      const schedulersList: Scheduler[] = [];
      try {
        const schRes = await fetch(`${API_URL}/schedulers`);
        const schData = await schRes.json();
        if (schData.success && Array.isArray(schData.data)) {
          for (const s of schData.data) {
            if (s.enabled) activeSchedulers++;
            schedulersList.push({
              id: s.id,
              flowName: s.flowName || s.name || 'Unknown flow',
              projectName: s.projectName || 'Unknown project',
              schedule: s.schedule || 'No schedule',
              status: s.enabled ? 'active' : 'paused',
              lastRun: s.lastRun,
            });
          }
        }
      } catch (err) {
        console.error('Error fetching schedulers:', err);
      }

      setSchedulers(schedulersList.slice(0, 3));
      setSchedulerTrend(generateTrend(activeSchedulers, 12));

      // Fetch baskets
      let pendingBaskets = 0;
      try {
        const basketsRes = await fetch(`${API_URL}/baskets`);
        const basketsData = await basketsRes.json();
        if (basketsData.success && basketsData.data) {
          pendingBaskets = basketsData.data.length;
        }
      } catch (err) {
        console.log('Baskets API not available');
      }

      setStats({
        totalProjects: projects.length,
        activeProjects,
        totalFlows,
        totalConnections,
        todayExecutions,
        runningExecutions,
        failedExecutions,
        activeSchedulers,
        pausedSchedulers: schedulersList.length - activeSchedulers,
        pendingBaskets,
      });
      setUpdatedAt(new Date());
    } catch (error) {
      console.error('Error fetching dashboard data:', error);
    } finally {
      setLoading(false);
    }
  };

  // Generate trend data based on current value
  const generateTrend = (currentValue: number, points: number): number[] => {
    const trend: number[] = [];
    let value = Math.max(1, Math.floor(currentValue * 0.5));
    for (let i = 0; i < points; i++) {
      value = value + Math.floor(Math.random() * 5) - 2;
      value = Math.max(1, value);
      trend.push(value);
    }
    trend[points - 1] = currentValue;
    return trend;
  };

  if (loading) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-gray-50">
        <Loader2 className="h-10 w-10 text-blue-500 animate-spin mb-4" />
        <p className="text-gray-500">Loading dashboard...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header>
        <div className="px-4 sm:px-6 pt-6 pb-2">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
              <p className="text-gray-500 text-sm mt-1">Platform overview and activity</p>
            </div>
            <button
              onClick={fetchData}
              className="p-2 text-gray-500 hover:text-gray-900 hover:bg-gray-100 rounded-lg transition-colors"
            >
              <RefreshCw className="h-5 w-5" />
            </button>
          </div>
        </div>
      </header>

      <div className="p-4 sm:p-6 space-y-4 sm:space-y-6">
        {/* KPI Stats Grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 sm:gap-4">
          <KpiCard
            title="Total Projects"
            value={stats.totalProjects}
            trend="+12%"
            isPositive={true}
            icon={FolderOpen}
            color="blue"
            chartData={projectTrend}
            onClick={() => navigate('/projects')}
          />
          <KpiCard
            title="Active Projects"
            value={stats.activeProjects}
            subtext="with flows running"
            icon={Zap}
            color="green"
            onClick={() => navigate('/projects')}
          />
          <KpiCard
            title="Total Flows"
            value={stats.totalFlows}
            trend="+8%"
            isPositive={true}
            icon={Layers}
            color="purple"
            onClick={() => navigate('/projects')}
          />
          <KpiCard
            title="Connections"
            value={stats.totalConnections}
            icon={Plug}
            color="cyan"
            onClick={() => navigate('/connections')}
          />
          <KpiCard
            title="Today's Runs"
            value={stats.todayExecutions}
            trend="+23%"
            isPositive={true}
            icon={Activity}
            color="orange"
            chartData={executionTrend}
            onClick={() => navigate('/executions')}
          />
          <KpiCard
            title="Running Now"
            value={stats.runningExecutions}
            subtext="active executions"
            icon={Play}
            color="blue"
            onClick={() => navigate('/executions')}
          />
          <KpiCard
            title="Failed Today"
            value={stats.failedExecutions}
            trend="-5%"
            isPositive={true}
            icon={AlertCircle}
            color="red"
            onClick={() => navigate('/executions')}
          />
          <KpiCard
            title="Active Schedulers"
            value={stats.activeSchedulers}
            trend="+2"
            isPositive={true}
            icon={Clock}
            color="amber"
            chartData={schedulerTrend}
            onClick={() => navigate('/schedulers')}
          />
        </div>

        {/* Live Activity Panel */}
        <div className="bg-white p-4">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></div>
              <h2 className="font-semibold text-gray-900">Live Activity</h2>
            </div>
            {updatedAt && (
              <span className="whitespace-nowrap text-xs text-gray-400">
                Updated {updatedAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
              </span>
            )}
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
            {/* Executions Summary */}
            <div 
              onClick={() => navigate('/executions')}
              className="bg-gray-50 rounded-xl p-4 cursor-pointer hover:bg-gray-100 transition-colors"
            >
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-white border border-gray-200 rounded-xl flex items-center justify-center">
                  <Activity className="h-5 w-5 text-gray-600" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900">Executions</p>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1">
                    <div className="flex items-center gap-1">
                      <Play className="h-3 w-3 text-gray-500" />
                      <span className="whitespace-nowrap text-xs font-semibold text-gray-700">{stats.runningExecutions} running</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <CheckCircle2 className="h-3 w-3 text-green-600" />
                      <span className="whitespace-nowrap text-xs text-gray-500">{stats.todayExecutions} today</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Schedulers Summary */}
            <div 
              onClick={() => navigate('/schedulers')}
              className="bg-gray-50 rounded-xl p-4 cursor-pointer hover:bg-gray-100 transition-colors"
            >
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-white border border-gray-200 rounded-xl flex items-center justify-center">
                  <Clock className="h-5 w-5 text-gray-600" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900">Schedulers</p>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1">
                    <div className="flex items-center gap-1">
                      <Zap className="h-3 w-3 text-gray-500" />
                      <span className="whitespace-nowrap text-xs font-semibold text-gray-700">{stats.activeSchedulers} active</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <Pause className="h-3 w-3 text-gray-500" />
                      <span className="whitespace-nowrap text-xs text-gray-500">{stats.pausedSchedulers} paused</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Baskets Summary */}
            <div 
              onClick={() => navigate('/baskets')}
              className="bg-gray-50 rounded-xl p-4 cursor-pointer hover:bg-gray-100 transition-colors"
            >
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-white border border-gray-200 rounded-xl flex items-center justify-center">
                  <Inbox className="h-5 w-5 text-gray-600" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900">Baskets</p>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1">
                    <div className="flex items-center gap-1">
                      <Inbox className="h-3 w-3 text-gray-500" />
                      <span className="whitespace-nowrap text-xs font-semibold text-gray-700">{stats.pendingBaskets} total</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Today's success rate */}
            <div className="bg-gray-50 rounded-xl p-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-white border border-gray-200 rounded-xl flex items-center justify-center">
                  <CheckCircle2 className="h-5 w-5 text-green-600" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900">Today's Success Rate</p>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1">
                    {stats.todayExecutions > 0 ? (
                      <span className="whitespace-nowrap text-xs text-green-600 font-semibold">
                        {Math.round(((stats.todayExecutions - stats.failedExecutions) / stats.todayExecutions) * 100)}% of {stats.todayExecutions} runs
                      </span>
                    ) : (
                      <span className="whitespace-nowrap text-xs text-gray-500">No runs yet today</span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Recent Projects */}
        <div>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-gray-900">Recent Projects</h2>
            <button 
              onClick={() => navigate('/projects')}
              className="text-sm text-blue-600 hover:text-blue-700 font-medium flex items-center gap-1"
            >
              View all projects
              <ArrowRight className="h-4 w-4" />
            </button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-3">
            {projects.map((project) => (
              <ProjectCard 
                key={project.id} 
                project={project} 
                onClick={() => navigate(`/projects/${project.id}`)}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
