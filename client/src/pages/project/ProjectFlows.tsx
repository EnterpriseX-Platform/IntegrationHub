import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Globe, Clock, Plus, Calendar, Workflow, Pencil, Trash2, AlertCircle, X, ChevronDown, ChevronRight, Layers, Search } from 'lucide-react';
import { CreateFlowModal } from '../../components/modals/CreateFlowModal';
import { Button } from '../../components/ui/Button';
import ApiFlowDesigner from '../ApiFlowDesigner';
import EventFlowDesigner from '../EventFlowDesigner';

import { API_URL, apiFetch } from '../../config/api';

interface Project {
  id: string;
  name: string;
}

interface Flow {
  id: string;
  name: string;
  type: 'API_SPEC' | 'TRIGGER';
  status: string;
  description?: string;
  process?: string;
  tags?: string[];
  displayOrder?: number;
  createdAt: string;
  nodes?: any;
}

// Group Header Component - Same as Projects page
interface GroupHeaderProps {
  title: string;
  count: number;
  isExpanded: boolean;
  onToggle: () => void;
  icon?: React.ReactNode;
}

const GroupHeader = ({ title, count, isExpanded, onToggle, icon }: GroupHeaderProps) => {
  return (
    <div 
      className="bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 flex items-center gap-2 cursor-pointer hover:border-gray-300 hover:shadow-sm transition-all mb-2 shadow-sm"
      onClick={onToggle}
    >
      {isExpanded ? (
        <ChevronDown className="h-4 w-4 text-gray-400" />
      ) : (
        <ChevronRight className="h-4 w-4 text-gray-400" />
      )}
      
      {icon && (
        <span className="bg-blue-50 text-blue-500 p-1 rounded text-xs">
          {icon}
        </span>
      )}
      
      <span className="text-gray-700 font-medium text-sm flex-1">{title}</span>
      
      <span className="text-xs bg-white text-gray-600 border border-gray-200 px-2 py-0.5 rounded-full">
        {count}
      </span>
    </div>
  );
};

export const ProjectFlows = ({ project }: { project: Project }) => {
  const navigate = useNavigate();
  const { flowId } = useParams();
  const [flows, setFlows] = useState<Flow[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'all' | 'api' | 'trigger'>('all');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [flowToEdit, setFlowToEdit] = useState<Flow | null>(null);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [flowToDelete, setFlowToDelete] = useState<Flow | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  
  // Search filter
  const [searchTerm, setSearchTerm] = useState('');
  
  // Drag and drop states
  const [draggedFlow, setDraggedFlow] = useState<Flow | null>(null);
  const [dragOverFlowId, setDragOverFlowId] = useState<string | null>(null);

  useEffect(() => {
    if (!project?.id) return;
    const projectData = project as any;
    if (Array.isArray(projectData?.flows)) {
      setFlows(projectData.flows);
      setLoading(false);
    } else {
      fetchFlows();
    }
  }, [project?.id]);

  const fetchFlows = async () => {
    if (!project?.id) return;
    try {
      const response = await fetch(`${API_URL}/projects/${project.id}`);
      const result = await response.json();
      if (result.success) {
        setFlows(result.data.flows || []);
      }
    } catch (error) {
      console.error('Error fetching flows:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteFlow = async () => {
    if (!flowToDelete) return;
    
    setIsDeleting(true);
    try {
      const response = await apiFetch(`${API_URL}/flows/${flowToDelete.id}`, {
        method: 'DELETE',
      });
      
      const result = await response.json();
      if (result.success) {
        setFlows(prev => prev.filter(f => f.id !== flowToDelete.id));
        setShowDeleteModal(false);
        setFlowToDelete(null);
      } else {
        alert(result.error || 'Failed to delete flow');
      }
    } catch (error) {
      console.error('Error deleting flow:', error);
      alert('Failed to delete flow');
    } finally {
      setIsDeleting(false);
    }
  };

  const handleDeleteClick = (e: React.MouseEvent, flow: Flow) => {
    e.stopPropagation();
    setFlowToDelete(flow);
    setShowDeleteModal(true);
  };

  const handleEditClick = (e: React.MouseEvent, flow: Flow) => {
    e.stopPropagation();
    setFlowToEdit(flow);
    setShowEditModal(true);
  };

  const handleEditFlow = async (_type: 'rest-api' | 'trigger', name: string, description: string, process: string, tags: string[]) => {
    if (!flowToEdit) return;
    
    try {
      const response = await apiFetch(`${API_URL}/flows/${flowToEdit.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          description,
          process,
          tags,
        }),
      });

      const result = await response.json();
      if (result.success) {
        setFlows(prev => prev.map(f => f.id === flowToEdit.id ? { ...f, name, description, process, tags } : f));
        setShowEditModal(false);
        setFlowToEdit(null);
      }
    } catch (error) {
      console.error('Error updating flow:', error);
    }
  };

  const handleCreateFlow = async (type: 'rest-api' | 'trigger', name: string, description: string, process: string, tags: string[]) => {
    try {
      const response = await fetch(`${API_URL}/projects/${project.id}/flows`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          description,
          type: type === 'rest-api' ? 'API_SPEC' : 'TRIGGER',
          process,
          tags,
        }),
      });

      const result = await response.json();
      if (result.success) {
        // Navigate to appropriate designer
        if (type === 'rest-api') {
          navigate(`/projects/${project.id}/flows/${result.data.id}/designer`);
        } else {
          navigate(`/projects/${project.id}/event-flows/${result.data.id}/designer`);
        }
      }
    } catch (error) {
      console.error('Error creating flow:', error);
    }
  };

  const toggleGroup = (groupKey: string) => {
    setExpandedGroups(prev => ({
      ...prev,
      [groupKey]: !prev[groupKey]
    }));
  };

  // Drag and drop handlers
  const handleDragStart = (e: React.DragEvent, flow: Flow) => {
    setDraggedFlow(flow);
    
    // Set drag image
    const dragImage = document.createElement('div');
    dragImage.className = 'bg-white border border-blue-400 rounded-lg p-3 shadow-lg text-sm font-medium';
    dragImage.textContent = flow.name;
    dragImage.style.position = 'absolute';
    dragImage.style.top = '-1000px';
    document.body.appendChild(dragImage);
    e.dataTransfer.setDragImage(dragImage, 0, 0);
    setTimeout(() => document.body.removeChild(dragImage), 0);
  };

  const handleDragOver = (e: React.DragEvent, targetFlow: Flow) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (draggedFlow && draggedFlow.id !== targetFlow.id) {
      setDragOverFlowId(targetFlow.id);
    }
  };

  const handleDragLeave = () => {
    setDragOverFlowId(null);
  };

  const handleDrop = async (e: React.DragEvent, targetFlow: Flow, processFlows: Flow[]) => {
    e.preventDefault();
    setDragOverFlowId(null);
    
    if (!draggedFlow || draggedFlow.id === targetFlow.id) {
      setDraggedFlow(null);
      return;
    }
    
    // Check if same process
    if (draggedFlow.process !== targetFlow.process) {
      alert('Can only reorder flows within the same process');
      setDraggedFlow(null);
      return;
    }
    
    // Reorder flows within the same process
    const currentList = [...processFlows];
    const draggedIndex = currentList.findIndex(f => f.id === draggedFlow.id);
    const targetIndex = currentList.findIndex(f => f.id === targetFlow.id);
    
    if (draggedIndex === -1 || targetIndex === -1) {
      setDraggedFlow(null);
      return;
    }
    
    // Swap positions
    const [removed] = currentList.splice(draggedIndex, 1);
    currentList.splice(targetIndex, 0, removed);
    
    // Update flows state - replace flows in the same process with reordered list
    const processKey = draggedFlow.process || 'No Process';
    const updatedFlows = flows.map(f => {
      // Only update flows in the same process
      if ((f.process || 'No Process') === processKey) {
        const newIndex = currentList.findIndex(cf => cf.id === f.id);
        if (newIndex !== -1) {
          return { ...f, displayOrder: newIndex };
        }
      }
      return f;
    });
    
    // Sort flows by displayOrder to reflect new order
    updatedFlows.sort((a, b) => (a.displayOrder || 0) - (b.displayOrder || 0));
    setFlows(updatedFlows);
    setDraggedFlow(null);
    
    // Auto-save positions to backend
    try {
      const positions = currentList.map((f, index) => ({
        flowId: f.id,
        position: index,
      }));
      await fetch(`${API_URL}/flows/position`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ positions }),
      });
    } catch (err) {
      console.error('Failed to save flow positions:', err);
    }
  };

  const handleDragEnd = () => {
    setDraggedFlow(null);
    setDragOverFlowId(null);
  };

  // Group flows by process
  const groupFlowsByProcess = (flows: Flow[]) => {
    const groups: Record<string, Flow[]> = {};
    const ungrouped: Flow[] = [];

    flows.forEach(flow => {
      const processKey = flow.process || 'No Process';
      
      if (!groups[processKey]) {
        groups[processKey] = [];
      }
      groups[processKey].push(flow);
    });

    // Sort flows within each group by displayOrder
    Object.keys(groups).forEach(key => {
      groups[key].sort((a, b) => (a.displayOrder || 0) - (b.displayOrder || 0));
    });

    return { groups, ungrouped };
  };

  const filteredFlows = flows.filter(flow => {
    // Tab filter
    if (activeTab === 'api' && flow.type !== 'API_SPEC') return false;
    if (activeTab === 'trigger' && flow.type?.toLowerCase() !== 'trigger') return false;
    
    // Search filter
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      const tags = Array.isArray(flow.tags) 
        ? flow.tags 
        : (typeof flow.tags === 'string' ? JSON.parse(flow.tags || '[]') : []);
      
      const matchesSearch = 
        flow.name.toLowerCase().includes(term) ||
        flow.description?.toLowerCase().includes(term) ||
        flow.process?.toLowerCase().includes(term) ||
        tags.some((tag: string) => tag.toLowerCase().includes(term));
      
      if (!matchesSearch) return false;
    }
    
    return true;
  });

  const { groups } = groupFlowsByProcess(filteredFlows);
  const sortedGroupKeys = Object.keys(groups).sort((a, b) => {
    if (a === 'No Process') return 1;
    if (b === 'No Process') return -1;
    return a.localeCompare(b);
  });

  // Get unique process names from all flows (excluding 'No Process')
  const availableProcesses = sortedGroupKeys.filter(key => key !== 'No Process');

  // Get flow type for designer
  const getFlowType = (flowId: string): 'api' | 'trigger' => {
    const flow = flows.find(f => f.id === flowId);
    if (flow?.type === 'API_SPEC') return 'api';
    if (flow?.type === 'TRIGGER') return 'trigger';
    // Detect by nodes if type is unclear
    try {
      const nodes = typeof flow?.nodes === 'string' ? JSON.parse(flow.nodes) : flow?.nodes;
      const hasEventTrigger = nodes?.some((n: any) => ['basket-trigger'].includes(n.type));
      if (hasEventTrigger) return 'trigger';
    } catch {}
    return 'api';
  };

  // If in designer mode (flowId present)
  if (flowId) {
    const flowType = getFlowType(flowId);
    return flowType === 'api' ? <ApiFlowDesigner /> : <EventFlowDesigner />;
  }

  return (
    <div className="p-4 sm:p-6">
      {/* Header with Tabs and Search */}
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3 mb-4 sm:mb-6">
        <div className="flex gap-1 bg-gray-100 p-1 rounded-lg self-start max-w-full overflow-x-auto">
          {[
            { id: 'all' as const, label: 'All Flows', count: flows.length },
            { id: 'api' as const, label: 'REST API', count: flows.filter(f => f.type === 'API_SPEC').length },
            { id: 'trigger' as const, label: 'Triggers', count: flows.filter(f => f.type?.toLowerCase() === 'trigger').length },
          ].map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`inline-flex items-center justify-center px-3 sm:px-4 h-9 sm:py-2 rounded-lg text-[14px] font-medium whitespace-nowrap transition-colors ${
                activeTab === tab.id
                  ? 'bg-white text-gray-900 shadow-sm'
                  : 'text-gray-600 hover:text-gray-900'
              }`}
            >
              {tab.label}
              <span className="ml-2 text-xs bg-gray-200 text-gray-600 px-2 py-0.5 rounded-full">
                {tab.count}
              </span>
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2 sm:gap-3">
          {/* Search Bar */}
          <div className="relative flex-1 lg:flex-none">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search flows..."
              className="w-full lg:w-64 pl-10 pr-9 py-2 bg-white border border-gray-200 rounded-lg text-sm text-gray-900 placeholder-gray-400 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
            />
            {searchTerm && (
              <button
                onClick={() => setSearchTerm('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          <button
            onClick={() => setShowCreateModal(true)}
            className="flex items-center gap-1.5 h-9 px-3 text-[14px] bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors whitespace-nowrap shrink-0"
            title="Create Flow"
          >
            <Plus className="h-4 w-4" />
            <span className="hidden sm:inline">Create Flow</span>
          </button>
        </div>
      </div>

      {/* Flows Grouped by Process */}
      {loading ? (
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
        </div>
      ) : filteredFlows.length > 0 ? (
        <div className="space-y-4">
          {sortedGroupKeys.map((processKey) => {
            const processFlows = groups[processKey];
            const isGroupExpanded = expandedGroups[processKey] !== false; // Default expanded

            return (
              <div key={processKey} className="space-y-2">
                {/* Process Group Header */}
                <GroupHeader
                  title={processKey}
                  count={processFlows.length}
                  isExpanded={isGroupExpanded}
                  onToggle={() => toggleGroup(processKey)}
                  icon={<Layers className="h-4 w-4" />}
                />

                {/* Flows Grid */}
                {isGroupExpanded && (
                  <div className="sm:ml-6 grid grid-cols-[repeat(auto-fill,minmax(15rem,20rem))] gap-2 sm:gap-3">
                    {processFlows.map(flow => {
                      const isApi = flow.type === 'API_SPEC';
                      const typeBg = isApi ? 'bg-blue-50' : 'bg-green-50';
                      const typeText = isApi ? 'text-blue-600' : 'text-green-600';
                      
                      return (
                        <div
                          key={flow.id}
                          onClick={() => navigate(`/projects/${project.id}/${isApi ? 'flows' : 'event-flows'}/${flow.id}/designer`)}
                          draggable={true}
                          onDragStart={(e) => handleDragStart(e, flow)}
                          onDragOver={(e) => handleDragOver(e, flow)}
                          onDragLeave={handleDragLeave}
                          onDrop={(e) => handleDrop(e, flow, processFlows)}
                          onDragEnd={handleDragEnd}
                          className={`bg-white rounded-lg border cursor-move transition-all duration-200 overflow-hidden group shadow-sm flex flex-col h-full relative
                            ${dragOverFlowId === flow.id && draggedFlow?.id !== flow.id 
                              ? 'opacity-30 scale-[0.98] border-blue-400' 
                              : 'hover:border-blue-300 border-gray-200'}
                            ${draggedFlow?.id === flow.id ? 'opacity-40' : ''}
                          `}
                        >
                          {/* Drop Placeholder - Dashed border card */}
                          {dragOverFlowId === flow.id && draggedFlow?.id !== flow.id && (
                            <div className="absolute inset-0 border-2 border-dashed border-blue-400 rounded-lg bg-blue-50/30 z-10 flex items-center justify-center">
                              <span className="text-xs text-blue-600 font-medium">Drop here</span>
                            </div>
                          )}
                          {/* Header - Icon + Name + Actions (Same as Project Card) */}
                          <div className="px-2.5 py-2">
                            <div className="flex items-center gap-2">
                              {/* Icon */}
                              <div className={`w-7 h-7 ${typeBg} rounded-md flex items-center justify-center flex-shrink-0`}>
                                {isApi ? (
                                  <Globe className={`h-4 w-4 ${typeText}`} />
                                ) : (
                                  <Clock className={`h-4 w-4 ${typeText}`} />
                                )}
                              </div>
                              
                              {/* Flow Name + Status Badge */}
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-1.5 min-w-0">
                                  <span
                                    className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${flow.status === 'Active' ? 'bg-green-500' : 'bg-gray-300'}`}
                                    title={flow.status}
                                  />
                                  <h3 className="font-medium text-sm text-gray-900 leading-tight truncate group-hover:text-blue-600 transition-colors" title={flow.name}>
                                    {flow.name}
                                  </h3>
                                </div>
                              </div>
                              
                              {/* Action Icons - Edit + Delete */}
                              <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 -mt-1 -mr-1" onClick={(e) => e.stopPropagation()}>
                                <button
                                  onClick={(e) => handleEditClick(e, flow)}
                                  className="p-1 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors"
                                  title="Edit"
                                >
                                  <Pencil className="h-3 w-3" />
                                </button>
                                <button
                                  onClick={(e) => handleDeleteClick(e, flow)}
                                  className="p-1 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
                                  title="Delete"
                                >
                                  <Trash2 className="h-3 w-3" />
                                </button>
                              </div>
                            </div>
                            
                            {/* Description */}
                            {flow.description && (
                              <p className="text-[12px] text-gray-500 mt-1 line-clamp-1">{flow.description}</p>
                            )}
                          </div>
                          
                          {/* Footer - Type • Tags • Date */}
                          <div className="px-2.5 py-1 bg-gray-50 border-t border-gray-100 flex items-center justify-between mt-auto">
                            <div className="flex items-center gap-2 min-w-0 flex-1">
                              <span className={`text-[12px] font-medium flex-shrink-0 ${typeText}`}>
                                {isApi ? 'REST API' : 'Triggers'}
                              </span>
                              {(() => {
                                const tags = Array.isArray(flow.tags) 
                                  ? flow.tags 
                                  : (typeof flow.tags === 'string' ? JSON.parse(flow.tags || '[]') : []);
                                return tags.length > 0 && (
                                  <div className="flex items-center gap-1 min-w-0 overflow-hidden">
                                    <span className="text-gray-300 flex-shrink-0">•</span>
                                    {tags.slice(0, 3).map((tag: string) => (
                                      <span
                                        key={tag}
                                        className="text-[12px] px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded truncate max-w-[50px]"
                                        title={tag}
                                      >
                                        {tag}
                                      </span>
                                    ))}
                                    {tags.length > 3 && (
                                      <span className="text-[12px] text-gray-400 flex-shrink-0">
                                        +{tags.length - 3}
                                      </span>
                                    )}
                                  </div>
                                );
                              })()}
                            </div>
                            <span className="text-[12px] text-gray-400 flex items-center gap-0.5 flex-shrink-0 ml-2">
                              <Calendar className="h-2.5 w-2.5" />
                              {new Date(flow.createdAt).toLocaleString('en-GB', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="text-center py-12 bg-gray-50 rounded-xl border border-dashed border-gray-300">
          <div className="w-14 h-14 bg-gray-100 rounded-xl flex items-center justify-center mx-auto mb-3">
            <Workflow className="h-7 w-7 text-gray-400" />
          </div>
          <h3 className="text-base font-medium text-gray-900 mb-1">
            {searchTerm ? 'No flows found' : 'No flows yet'}
          </h3>
          <p className="text-sm text-gray-500 mb-4">
            {searchTerm 
              ? 'Try adjusting your search' 
              : 'Create your first flow to start building integrations'}
          </p>
          {!searchTerm && (
            <button
              onClick={() => setShowCreateModal(true)}
              className="inline-flex items-center h-9 px-3 text-[14px] bg-blue-500 text-white rounded-lg hover:bg-blue-600"
            >
              Create Flow
            </button>
          )}
        </div>
      )}

      {/* Create Flow Modal */}
      <CreateFlowModal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onCreate={handleCreateFlow}
        projectId={project.id}
        availableProcesses={availableProcesses}
      />

      {/* Edit Flow Modal */}
      <CreateFlowModal
        isOpen={showEditModal}
        onClose={() => {
          setShowEditModal(false);
          setFlowToEdit(null);
        }}
        onCreate={handleCreateFlow}
        onUpdate={handleEditFlow}
        projectId={project.id}
        flow={flowToEdit}
        availableProcesses={availableProcesses}
      />

      {/* Delete Confirmation Modal */}
      {showDeleteModal && flowToDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm mx-4">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
              <h2 className="text-lg font-semibold text-gray-900">Delete Flow</h2>
              <button 
                onClick={() => setShowDeleteModal(false)}
                className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
              >
                <X className="h-5 w-5 text-gray-500" />
              </button>
            </div>
            <div className="p-6">
              <div className="flex items-center gap-3 text-amber-500 mb-3">
                <AlertCircle className="h-8 w-8" />
              </div>
              <p className="text-sm text-gray-600">
                Are you sure you want to delete <strong>{flowToDelete.name}</strong>?
              </p>
              <p className="text-sm text-gray-500 mt-2">
                This action cannot be undone. All executions and data associated with this flow will be permanently deleted.
              </p>
            </div>
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200 bg-gray-50 rounded-b-xl">
              <Button variant="ghost" onClick={() => setShowDeleteModal(false)}>
                Cancel
              </Button>
              <Button 
                variant="danger" 
                onClick={handleDeleteFlow}
                isLoading={isDeleting}
              >
                Delete Flow
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ProjectFlows;
