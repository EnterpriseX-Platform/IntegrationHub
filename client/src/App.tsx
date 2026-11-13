import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/layout/Layout';
import Dashboard from './pages/Dashboard';
import Projects from './pages/Projects';
import ProjectDetailLayout from './pages/ProjectDetail';
import ApiFlowDesigner from './pages/ApiFlowDesigner';
import EventFlowDesigner from './pages/EventFlowDesigner';
import ApiSpecDetail from './pages/ApiSpecDetail';
import Executions from './pages/Executions';
import ProjectExecutions from './pages/ProjectExecutions';
import Connections from './pages/Connections';
import ShareLink from './pages/ShareLink';
import ApiSpecs from './pages/ApiSpecs';
import Settings from './pages/Settings';
import Profile from './pages/Profile';
import Schedulers from './pages/Schedulers';
import Tasks from './pages/Tasks';
import BasketManagement from './pages/BasketManagement';
import FileExplorer from './pages/FileExplorer';
import SchedulerLogs from './pages/scheduler/SchedulerLogs';
import AnalyticsWorkbench from './pages/AnalyticsWorkbench';
import DataRepository from './pages/DataRepository';
import NotFound from './pages/NotFound';
import Login from './pages/Login';
import XlsxViewer from './pages/XlsxViewer';
import TxtViewer from './pages/TxtViewer';
import { BASE_PATH } from './config/api';

function App() {
  return (
    <Router basename={BASE_PATH}>
      <Routes>
        {/* Public Routes - No Layout */}
        <Route path="/login" element={<Login />} />
        <Route path="/viewer/xlsx" element={<XlsxViewer />} />
        <Route path="/viewer/txt" element={<TxtViewer />} />
        
        <Route path="/" element={<Layout />}>
          {/* Dashboard */}
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="dashboard" element={<Dashboard />} />
          
          {/* Projects - with nested routes */}
          <Route path="projects" element={<Projects />} />
          
          {/* API Flow Designer - MUST be before the wildcard route */}
          <Route path="projects/:id/flows/:flowId/designer" element={<ApiFlowDesigner />} />
          <Route path="flows/:flowId/designer" element={<ApiFlowDesigner />} />
          
          {/* Event Flow Designer - MUST be before the wildcard route */}
          <Route path="projects/:id/event-flows/:flowId/designer" element={<EventFlowDesigner />} />
          <Route path="event-flows/:flowId/designer" element={<EventFlowDesigner />} />
          
          {/* Project Detail with wildcard - MUST be after specific routes */}
          <Route path="projects/:id/*" element={<ProjectDetailLayout />} />
          
          {/* Global pages */}
          <Route path="apispecs" element={<ApiSpecs />} />
          <Route path="apispecs/:id" element={<ApiSpecDetail />} />
          <Route path="connections" element={<Connections />} />
          <Route path="executions" element={<Executions />} />
          <Route path="executions/projects/:projectId" element={<ProjectExecutions />} />
          <Route path="settings" element={<Settings />} />
          <Route path="profile" element={<Profile />} />
          <Route path="schedulers" element={<Schedulers />} />
          <Route path="tasks" element={<Tasks />} />
          <Route path="baskets" element={<BasketManagement />} />
          <Route path="file-explorer" element={<FileExplorer />} />
          <Route path="share/:id" element={<ShareLink />} />
          <Route path="schedulers/:flowId/logs" element={<SchedulerLogs />} />
          <Route path="analytics-workbench" element={<AnalyticsWorkbench />} />
          <Route path="data-repository" element={<DataRepository />} />

          {/* 404 */}
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </Router>
  );
}

export default App;
