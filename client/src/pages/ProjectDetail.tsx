import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate, useLocation, NavLink, Routes, Route } from 'react-router-dom';
import { 
  LayoutDashboard, GitBranch, FolderKanban,
  Plug, History, ArrowLeft, Settings, Plus,
  FolderOpen, Building2, ChevronDown, CheckCircle2, ShieldCheck, Users
} from 'lucide-react';
import { AccessModal } from '../components/access/AccessModal';
import { Button } from '../components/ui/Button';
import { Modal } from '../components/ui/Modal';

// Sub-pages
import { ProjectDashboard } from './project/ProjectDashboard';
import { ProjectFlows } from './project/ProjectFlows';
import { ProjectBaskets } from './project/ProjectBaskets';
import { ProjectConnections } from './project/ProjectConnections';
import { ProjectExecutions } from './project/ProjectExecutions';
import { ProjectApiKeys } from './project/ProjectApiKeys';
import { CreateFlowModal } from '../components/modals/CreateFlowModal';
import { API_URL, apiFetch } from '../config/api';

interface Project {
  id: string;
  name: string;
  slug: string;
  description: string;
  status: string;
  color: string;
  image?: string | null;
  projectGroup?: string | null;
  agency?: string | null;
}

// Extended Color Palette - 22 colors organized by hue
const colorMap: Record<string, { bg: string; icon: string; border: string; text: string; light: string; hex: string }> = {
  // Reds & Pinks
  rose: { bg: 'bg-rose-500', icon: 'text-rose-500', border: 'border-rose-200', text: 'text-rose-700', light: 'bg-rose-50', hex: '#f43f5e' },
  red: { bg: 'bg-red-500', icon: 'text-red-500', border: 'border-red-200', text: 'text-red-700', light: 'bg-red-50', hex: '#ef4444' },
  pink: { bg: 'bg-pink-500', icon: 'text-pink-500', border: 'border-pink-200', text: 'text-pink-700', light: 'bg-pink-50', hex: '#ec4899' },
  fuchsia: { bg: 'bg-fuchsia-500', icon: 'text-fuchsia-500', border: 'border-fuchsia-200', text: 'text-fuchsia-700', light: 'bg-fuchsia-50', hex: '#d946ef' },
  // Purples
  purple: { bg: 'bg-purple-500', icon: 'text-purple-500', border: 'border-purple-200', text: 'text-purple-700', light: 'bg-purple-50', hex: '#a855f7' },
  violet: { bg: 'bg-violet-500', icon: 'text-violet-500', border: 'border-violet-200', text: 'text-violet-700', light: 'bg-violet-50', hex: '#8b5cf6' },
  indigo: { bg: 'bg-indigo-500', icon: 'text-indigo-500', border: 'border-indigo-200', text: 'text-indigo-700', light: 'bg-indigo-50', hex: '#6366f1' },
  // Blues
  blue: { bg: 'bg-blue-500', icon: 'text-blue-500', border: 'border-blue-200', text: 'text-blue-700', light: 'bg-blue-50', hex: '#3b82f6' },
  sky: { bg: 'bg-sky-500', icon: 'text-sky-500', border: 'border-sky-200', text: 'text-sky-700', light: 'bg-sky-50', hex: '#0ea5e9' },
  cyan: { bg: 'bg-cyan-500', icon: 'text-cyan-500', border: 'border-cyan-200', text: 'text-cyan-700', light: 'bg-cyan-50', hex: '#06b6d4' },
  // Greens
  teal: { bg: 'bg-teal-500', icon: 'text-teal-500', border: 'border-teal-200', text: 'text-teal-700', light: 'bg-teal-50', hex: '#14b8a6' },
  emerald: { bg: 'bg-emerald-500', icon: 'text-emerald-500', border: 'border-emerald-200', text: 'text-emerald-700', light: 'bg-emerald-50', hex: '#10b981' },
  green: { bg: 'bg-green-500', icon: 'text-green-500', border: 'border-green-200', text: 'text-green-700', light: 'bg-green-50', hex: '#22c55e' },
  lime: { bg: 'bg-lime-500', icon: 'text-lime-500', border: 'border-lime-200', text: 'text-lime-700', light: 'bg-lime-50', hex: '#84cc16' },
  // Yellows & Oranges
  yellow: { bg: 'bg-yellow-500', icon: 'text-yellow-500', border: 'border-yellow-200', text: 'text-yellow-700', light: 'bg-yellow-50', hex: '#eab308' },
  amber: { bg: 'bg-amber-500', icon: 'text-amber-500', border: 'border-amber-200', text: 'text-amber-700', light: 'bg-amber-50', hex: '#f59e0b' },
  orange: { bg: 'bg-orange-500', icon: 'text-orange-500', border: 'border-orange-200', text: 'text-orange-700', light: 'bg-orange-50', hex: '#f97316' },
  // Browns & Greys
  stone: { bg: 'bg-stone-500', icon: 'text-stone-500', border: 'border-stone-200', text: 'text-stone-700', light: 'bg-stone-50', hex: '#78716c' },
  slate: { bg: 'bg-slate-500', icon: 'text-slate-500', border: 'border-slate-200', text: 'text-slate-700', light: 'bg-slate-50', hex: '#64748b' },
  zinc: { bg: 'bg-zinc-500', icon: 'text-zinc-500', border: 'border-zinc-200', text: 'text-zinc-700', light: 'bg-zinc-50', hex: '#71717a' },
  gray: { bg: 'bg-gray-500', icon: 'text-gray-500', border: 'border-gray-200', text: 'text-gray-700', light: 'bg-gray-50', hex: '#6b7280' },
  neutral: { bg: 'bg-neutral-500', icon: 'text-neutral-500', border: 'border-neutral-200', text: 'text-neutral-700', light: 'bg-neutral-50', hex: '#737373' },
};

const availableColors = Object.entries(colorMap).map(([key, value]) => ({ 
  key, 
  label: key.charAt(0).toUpperCase() + key.slice(1),
  hex: value.hex 
}));

// Combobox/Dropdown with Add New option
interface ComboboxWithAddProps {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
  onAddNew: (value: string) => void;
  placeholder?: string;
  icon?: React.ReactNode;
}

const ComboboxWithAdd = ({ label, value, options, onChange, onAddNew, placeholder, icon }: ComboboxWithAddProps) => {
  const [isOpen, setIsOpen] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        setInputValue('');
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const filteredOptions = options.filter(opt => 
    opt.toLowerCase().includes(inputValue.toLowerCase())
  );
  
  const canAddNew = inputValue && !options.includes(inputValue);

  const handleAddNew = () => {
    if (inputValue.trim()) {
      onAddNew(inputValue.trim());
      onChange(inputValue.trim());
      setInputValue('');
      setIsOpen(false);
    }
  };

  return (
    <div className="relative" ref={dropdownRef}>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      <div className="relative">
        {icon && (
          <div className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">
            {icon}
          </div>
        )}
        <button
          type="button"
          onClick={() => setIsOpen(!isOpen)}
          className={`w-full ${icon ? 'pl-10' : 'pl-3'} pr-10 py-2 border border-gray-300 rounded-lg text-left text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all bg-white hover:border-gray-400`}
        >
          <span className={value ? 'text-gray-900' : 'text-gray-400'}>
            {value || placeholder || `Select ${label}`}
          </span>
        </button>
        <ChevronDown className={`absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </div>

      {isOpen && (
        <div className="absolute z-50 w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-60 overflow-auto">
          {/* Search/Add Input */}
          <div className="p-2 border-b border-gray-100 sticky top-0 bg-white">
            <input
              type="text"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              placeholder={`Search or add new ${label.toLowerCase()}...`}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
              autoFocus
            />
          </div>

          {/* Options List */}
          <div className="py-1">
            {filteredOptions.length === 0 && !canAddNew && (
              <div className="px-3 py-2 text-sm text-gray-400 text-center">
                No options found
              </div>
            )}
            
            {filteredOptions.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => {
                  onChange(option);
                  setIsOpen(false);
                  setInputValue('');
                }}
                className={`w-full px-3 py-2 text-left text-sm hover:bg-gray-50 flex items-center justify-between ${
                  value === option ? 'bg-blue-50 text-blue-700' : 'text-gray-700'
                }`}
              >
                <span>{option}</span>
                {value === option && <CheckCircle2 className="h-4 w-4 text-blue-500" />}
              </button>
            ))}

            {/* Add New Option */}
            {canAddNew && (
              <button
                type="button"
                onClick={handleAddNew}
                className="w-full px-3 py-2 text-left text-sm text-blue-600 hover:bg-blue-50 flex items-center gap-2 border-t border-gray-100"
              >
                <Plus className="h-4 w-4" />
                <span>Add "{inputValue}"</span>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

// Compact Edit Form Component
interface CompactEditFormProps {
  editForm: {
    name: string;
    slug: string;
    description: string;
    color: string;
    image: string | null;
    projectGroup: string;
    agency: string;
  };
  setEditForm: React.Dispatch<React.SetStateAction<any>>;
  handleSaveEdit: () => void;
  isSaving: boolean;
  setShowEditModal: (show: boolean) => void;
  availableProjectGroups: string[];
  setAvailableProjectGroups: React.Dispatch<React.SetStateAction<string[]>>;
  availableAgencies: { name: string; level: string | null }[];
  setAvailableAgencies: React.Dispatch<React.SetStateAction<{ name: string; level: string | null }[]>>;
  colorMap: Record<string, { bg: string; icon: string; border: string; text: string; light: string; hex: string }>;
  availableColors: { key: string; label: string; hex: string }[];
}

const CompactEditForm = ({
  editForm,
  setEditForm,
  handleSaveEdit,
  isSaving,
  setShowEditModal,
  availableProjectGroups,
  setAvailableProjectGroups,
  availableAgencies,
  setAvailableAgencies,
  colorMap,
  availableColors,
}: CompactEditFormProps) => {
  const [customColor, setCustomColor] = useState('#3b82f6');
  const [showCustomColor, setShowCustomColor] = useState(false);

  return (
    <form onSubmit={(e) => { e.preventDefault(); handleSaveEdit(); }} className="space-y-3">
      {/* Two Column: Image | Fields */}
      <div className="grid grid-cols-[120px_1fr] gap-3">
        {/* Image Upload - Compact */}
        <div className="h-[120px]">
          <div className="h-full flex flex-col">
            <label className="block text-xs font-medium text-gray-700 mb-1">Image</label>
            <div className="flex-1 min-h-0">
              {editForm.image ? (
                <div className="relative w-full h-full rounded-lg overflow-hidden border border-gray-200">
                  <img src={editForm.image} alt="Project" className="w-full h-full object-cover" />
                  <div className="absolute inset-0 bg-black bg-opacity-40 opacity-0 hover:opacity-100 transition-opacity flex items-center justify-center gap-1">
                    <button
                      type="button"
                      onClick={() => document.getElementById('edit-image-upload')?.click()}
                      className="px-1.5 py-0.5 bg-white rounded text-[10px] font-medium text-gray-700"
                    >
                      Change
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditForm((prev: any) => ({ ...prev, image: null }))}
                      className="px-1.5 py-0.5 bg-red-500 rounded text-[10px] font-medium text-white"
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ) : (
                <div
                  onClick={() => document.getElementById('edit-image-upload')?.click()}
                  className={`w-full h-full rounded-lg border-2 border-dashed border-gray-300 bg-gray-50 flex flex-col items-center justify-center cursor-pointer hover:bg-gray-100`}
                >
                  <Plus className="h-4 w-4 text-gray-400 mb-0.5" />
                  <p className="text-[9px] text-gray-500 text-center">Click upload</p>
                </div>
              )}
              <input
                id="edit-image-upload"
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    const reader = new FileReader();
                    reader.onloadend = () => {
                      setEditForm((prev: any) => ({ ...prev, image: reader.result as string }));
                    };
                    reader.readAsDataURL(file);
                  }
                }}
              />
            </div>
          </div>
        </div>

        {/* Right Column Fields */}
        <div className="space-y-2">
          {/* Project Name */}
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-0.5">
              Project Name <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={editForm.name}
              onChange={(e) => setEditForm((prev: any) => ({ ...prev, name: e.target.value }))}
              className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
              placeholder="Enter project name"
              required
            />
          </div>

          {/* Slug */}
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-0.5">
              Slug <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={editForm.slug}
              onChange={(e) => setEditForm((prev: any) => ({ ...prev, slug: e.target.value }))}
              className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
              placeholder="enter-project-slug"
              required
            />
          </div>

          {/* Description */}
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-0.5">Description</label>
            <textarea
              value={editForm.description}
              onChange={(e) => setEditForm((prev: any) => ({ ...prev, description: e.target.value }))}
              className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none resize-none"
              rows={2}
              placeholder="Enter description"
            />
          </div>
        </div>
      </div>

      {/* Two Column: Project Group & Agency */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <ComboboxWithAdd
          label="Project Group"
          value={editForm.projectGroup}
          options={availableProjectGroups}
          onChange={(value) => setEditForm((prev: any) => ({ ...prev, projectGroup: value }))}
          onAddNew={(newGroup: string) => {
            if (!availableProjectGroups.includes(newGroup)) {
              setAvailableProjectGroups([...availableProjectGroups, newGroup]);
            }
          }}
          placeholder="Select group"
          icon={<FolderOpen className="h-3.5 w-3.5" />}
        />

        <ComboboxWithAdd
          label="Agency"
          value={editForm.agency}
          options={[...new Set(availableAgencies.map(a => a.name))]}
          onChange={(value) => setEditForm((prev: any) => ({ ...prev, agency: value }))}
          onAddNew={(newAgency: string) => {
            if (!availableAgencies.some(a => a.name === newAgency)) {
              setAvailableAgencies([...availableAgencies, { name: newAgency, level: '' }]);
            }
          }}
          placeholder="Select agency"
          icon={<Building2 className="h-3.5 w-3.5" />}
        />
      </div>

      {/* Theme Color - Compact Grid */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="block text-xs font-medium text-gray-700">Theme Color</label>
          <button
            type="button"
            onClick={() => setShowCustomColor(!showCustomColor)}
            className="text-xs text-blue-600 hover:text-blue-700"
          >
            {showCustomColor ? 'Preset Colors' : 'Custom Color'}
          </button>
        </div>
        
        {showCustomColor ? (
          <div className="flex items-center gap-3">
            <input
              type="color"
              value={customColor}
              onChange={(e) => {
                setCustomColor(e.target.value);
                setEditForm((prev: any) => ({ ...prev, color: e.target.value }));
              }}
              className="w-12 h-8 rounded cursor-pointer border border-gray-300"
            />
            <input
              type="text"
              value={customColor}
              onChange={(e) => {
                setCustomColor(e.target.value);
                setEditForm((prev: any) => ({ ...prev, color: e.target.value }));
              }}
              className="flex-1 px-2.5 py-1.5 text-sm border border-gray-300 rounded-md font-mono"
              placeholder="#3b82f6"
            />
          </div>
        ) : (
          <div className="grid grid-cols-6 sm:grid-cols-11 gap-1.5">
            {availableColors.map(({ key, label }) => (
              <button
                key={key}
                type="button"
                onClick={() => setEditForm((prev: any) => ({ ...prev, color: key }))}
                className={`group relative w-full aspect-square rounded ${colorMap[key].bg} ${
                  editForm.color === key 
                    ? 'ring-2 ring-offset-1 ring-gray-800 scale-110' 
                    : 'hover:scale-105'
                } transition-all`}
                title={label}
              >
                {editForm.color === key && (
                  <span className="absolute inset-0 flex items-center justify-center text-white text-[10px]">
                    <i className="fas fa-check"></i>
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex justify-end gap-2 pt-2 border-t">
        <Button type="button" variant="secondary" onClick={() => setShowEditModal(false)} size="sm">
          Cancel
        </Button>
        <Button type="submit" disabled={isSaving || !editForm.name?.trim() || !editForm.slug?.trim()} size="sm">
          {isSaving ? 'Saving...' : 'Save Changes'}
        </Button>
      </div>
    </form>
  );
};

export const ProjectDetailLayout = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const [project, setProject] = useState<Project | null>(null);
  const [showAccess, setShowAccess] = useState(false);
  const [loading, setLoading] = useState(true);
  const [showCreateFlowModal, setShowCreateFlowModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [editForm, setEditForm] = useState({ 
    name: '', 
    slug: '',
    description: '', 
    color: 'blue',
    image: null as string | null,
    projectGroup: '',
    agency: ''
  });
  const [isSaving, setIsSaving] = useState(false);

  // Dropdown options
  const [availableProjectGroups, setAvailableProjectGroups] = useState<string[]>([]);
  const [availableAgencies, setAvailableAgencies] = useState<{ name: string; level: string | null }[]>([]);

  useEffect(() => {
    fetchProject();
    fetchMetadata();
  }, [id]);

  const fetchProject = async () => {
    if (!id) return;
    try {
      const response = await fetch(`${API_URL}/projects/${id}`);
      const result = await response.json();
      if (result.success) {
        setProject(result.data);
      }
    } catch (error) {
      console.error('Error fetching project:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchMetadata = async () => {
    try {
      const response = await fetch(`${API_URL}/projects/metadata/unique-values`);
      const result = await response.json();
      if (result.success) {
        setAvailableProjectGroups(result.data.projectGroups);
        setAvailableAgencies(result.data.agencies);
      }
    } catch (err) {
      console.error('Failed to fetch metadata:', err);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  if (!project) {
    return (
      <div className="p-6">
        <div className="text-center py-12">
          <h2 className="text-xl font-semibold text-gray-900">Project not found</h2>
          <button
            onClick={() => navigate('/projects')}
            className="inline-flex items-center justify-center mt-4 px-3.5 h-9 bg-blue-500 text-white rounded-lg hover:bg-blue-600 whitespace-nowrap"
          >
            Back to Projects
          </button>
        </div>
      </div>
    );
  }

  const headerColorMap: Record<string, { bg: string; icon: string; border: string }> = {
    blue: { bg: 'bg-blue-100', icon: 'text-blue-500', border: 'border-blue-200' },
    purple: { bg: 'bg-purple-100', icon: 'text-purple-500', border: 'border-purple-200' },
    green: { bg: 'bg-green-100', icon: 'text-green-500', border: 'border-green-200' },
    orange: { bg: 'bg-orange-100', icon: 'text-orange-500', border: 'border-orange-200' },
    pink: { bg: 'bg-pink-100', icon: 'text-pink-500', border: 'border-pink-200' },
    cyan: { bg: 'bg-cyan-100', icon: 'text-cyan-500', border: 'border-cyan-200' },
    indigo: { bg: 'bg-indigo-100', icon: 'text-indigo-500', border: 'border-indigo-200' },
    amber: { bg: 'bg-amber-100', icon: 'text-amber-500', border: 'border-amber-200' },
    red: { bg: 'bg-red-100', icon: 'text-red-500', border: 'border-red-200' },
    teal: { bg: 'bg-teal-100', icon: 'text-teal-500', border: 'border-teal-200' },
  };

  const navItems = [
    { path: `/projects/${id}`, label: 'Dashboard', icon: LayoutDashboard, end: true },
    { path: `/projects/${id}/flows`, label: 'Flows', icon: GitBranch },
    { path: `/projects/${id}/baskets`, label: 'Baskets', icon: FolderKanban },
    { path: `/projects/${id}/connections`, label: 'Connections', icon: Plug },
    { path: `/projects/${id}/executions`, label: 'Executions', icon: History },
    { path: `/projects/${id}/secrets-vault`, label: 'Secrets Vault', icon: ShieldCheck },
  ];

  const handleSaveEdit = async () => {
    if (!id) return;
    setIsSaving(true);
    try {
      const response = await apiFetch(`${API_URL}/projects/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editForm),
      });
      const result = await response.json();
      if (result.success) {
        setProject(prev => prev ? { ...prev, ...editForm } : null);
        setShowEditModal(false);
      } else {
        alert(result.error || 'Failed to update project');
      }
    } catch (error) {
      console.error('Error updating project:', error);
      alert('Network error');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="h-full flex flex-col">
      {/* Project Header */}
      <div className="bg-white border-b border-gray-200">
        {/* Top Bar */}
        <div className="px-3 sm:px-6 py-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 sm:gap-3 min-w-0 flex-1">
              <button
                onClick={() => navigate('/projects')}
                className="p-1.5 hover:bg-gray-100 rounded-lg transition-colors shrink-0"
              >
                <ArrowLeft className="h-4 w-4 text-gray-600" />
              </button>
              <div className="flex items-center gap-2.5 min-w-0">
                {/* Project Icon/Image - Initial Letter Style */}
                {project.image ? (
                  <div className="w-8 h-8 sm:w-9 sm:h-9 rounded-lg overflow-hidden border border-gray-200 shrink-0">
                    <img
                      src={project.image}
                      alt={project.name}
                      className="w-full h-full object-cover"
                    />
                  </div>
                ) : (
                  <div className={`w-8 h-8 sm:w-9 sm:h-9 shrink-0 ${headerColorMap[project.color]?.bg.replace('100', '500') || 'bg-blue-500'} rounded-lg flex items-center justify-center border ${headerColorMap[project.color]?.border.replace('200', '400') || 'border-blue-400'}`}>
                    <span className="text-white font-bold text-sm sm:text-base">{project.name[0]}</span>
                  </div>
                )}
                <div className="min-w-0">
                  <h1 className="text-sm sm:text-base font-semibold text-gray-900 leading-tight truncate">{project.name}</h1>
                  <p className="text-xs text-gray-500 truncate">{project.description}</p>
                </div>
              </div>
              <span className="hidden sm:inline-block px-2 py-0.5 bg-green-100 text-green-700 text-[11px] rounded-full font-medium shrink-0">
                {project.status}
              </span>
            </div>
            
            {/* Quick Actions */}
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowAccess(true)}
                className="inline-flex items-center gap-1.5 h-8 px-2.5 text-[13px] text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
                title="Who can see this project"
              >
                <Users className="h-4 w-4 text-gray-600" />
                <span className="hidden sm:inline">Access</span>
              </button>
              <button 
                onClick={() => {
                  setEditForm({ 
                    name: project.name || '', 
                    slug: project.slug || '',
                    description: project.description || '', 
                    color: project.color || 'blue',
                    image: project.image || null,
                    projectGroup: project.projectGroup || '',
                    agency: project.agency || ''
                  });
                  setShowEditModal(true);
                }}
                className="p-1.5 hover:bg-gray-100 rounded-lg transition-colors"
                title="Edit Project"
              >
                <Settings className="h-4 w-4 text-gray-600" />
              </button>
            </div>
          </div>
        </div>

        {/* Navigation Tabs (horizontal scroll on narrow screens) */}
        <nav className="px-3 sm:px-6 overflow-x-auto -mb-px [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <div className="flex gap-1 min-w-max">
            {navItems.map((item) => {
              const isActive = item.end
                ? location.pathname === item.path
                : location.pathname.startsWith(item.path);

              return (
                <NavLink
                  key={item.path}
                  to={item.path}
                  end={item.end}
                  className={`flex items-center gap-1.5 px-2.5 sm:px-3 py-2 text-[13px] font-medium border-b-2 transition-colors whitespace-nowrap shrink-0 ${
                    isActive
                      ? 'border-blue-500 text-blue-600'
                      : 'border-transparent text-gray-600 hover:text-gray-900 hover:border-gray-300'
                  }`}
                >
                  <item.icon className="h-3.5 w-3.5" />
                  {item.label}
                </NavLink>
              );
            })}
          </div>
        </nav>
      </div>

      {/* Content Area */}
      <div className="flex-1 overflow-auto bg-gray-50">
        <Routes>
          <Route index element={<ProjectDashboard project={project} />} />
          <Route path="flows/*" element={<ProjectFlows project={project} />} />
          <Route path="baskets" element={<ProjectBaskets project={project} />} />
          <Route path="connections" element={<ProjectConnections project={project} />} />
          <Route path="executions" element={<ProjectExecutions project={project} />} />
          <Route path="secrets-vault" element={<ProjectApiKeys project={project} />} />
          {/* Backward compatibility */}
          <Route path="api-keys" element={<ProjectApiKeys project={project} />} />
        </Routes>
      </div>

      {/* Create Flow Modal */}
      {showCreateFlowModal && (
        <CreateFlowModal
          isOpen={showCreateFlowModal}
          projectId={project.id}
          onClose={() => setShowCreateFlowModal(false)}
          onCreate={(type, name, description, process, tags) => {
            // Create flow via API
            fetch(`${API_URL}/projects/${project.id}/flows`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                name,
                description,
                type: type === 'rest-api' ? 'API_SPEC' : 'TRIGGER',
                process,
                tags,
              }),
            })
              .then(res => res.json())
              .then(result => {
                if (result.success) {
                  setShowCreateFlowModal(false);
                  if (type === 'rest-api') {
                    navigate(`/projects/${id}/flows/${result.data.id}/designer`);
                  } else {
                    navigate(`/projects/${id}/event-flows/${result.data.id}/designer`);
                  }
                }
              });
          }}
        />
      )}

      {/* Edit Project Modal */}
      <AccessModal
        isOpen={showAccess}
        onClose={() => setShowAccess(false)}
        kind="project"
        id={project.id}
        name={project.name}
        canManage={['admin', 'owner'].includes((project as Project & { myRole?: string }).myRole || '')}
      />

      <Modal
        isOpen={showEditModal}
        onClose={() => setShowEditModal(false)}
        title="Edit Project"
        size="2xl"
      >
        <CompactEditForm 
          editForm={editForm}
          setEditForm={setEditForm}
          handleSaveEdit={handleSaveEdit}
          isSaving={isSaving}
          setShowEditModal={setShowEditModal}
          availableProjectGroups={availableProjectGroups}
          setAvailableProjectGroups={setAvailableProjectGroups}
          availableAgencies={availableAgencies}
          setAvailableAgencies={setAvailableAgencies}
          colorMap={colorMap}
          availableColors={availableColors}
        />
      </Modal>
    </div>
  );
};

export default ProjectDetailLayout;
