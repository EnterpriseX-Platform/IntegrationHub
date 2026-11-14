import { useNavigate } from 'react-router-dom';
import { useState, useEffect, useRef, ChangeEvent, useCallback } from 'react';
import type { ProjectSummary } from '../types';
import { Modal } from '../components/ui/Modal';
import { Button } from '../components/ui/Button';
import {
  Plus, FolderOpen, Loader2, AlertCircle, RefreshCw,
  Pencil, Trash2, Layers, Plug, ChevronDown, ChevronRight,
  CheckCircle2, Search, X, Building2, GripVertical
} from 'lucide-react';

import { API_URL, apiFetch } from '../config/api';

// Extended Color Palette - 24 colors organized by hue
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

// Carbon palette: several Tailwind families render as the same Carbon colour
// (rose = red, violet = purple, sky = blue, every grey…), so the picker offers
// one swatch per distinct colour. Projects saved with an older key still render.
const PICKER_COLORS = ['red', 'pink', 'purple', 'blue', 'cyan', 'teal', 'green', 'yellow', 'orange', 'gray'];
const availableColors = Object.entries(colorMap).filter(([key]) => PICKER_COLORS.includes(key)).map(([key, value]) => ({ 
  key, 
  label: key.charAt(0).toUpperCase() + key.slice(1),
  hex: value.hex 
}));

// Extended type with counts from API
interface ProjectWithCounts extends ProjectSummary {
  flowCount?: number;
  connectionCount?: number;
  executionCount?: number;
  lastActivity?: string;
  updatedAt?: string;
  createdAt?: string;
  flowTypes?: Record<string, number>;
  tags?: string[];
}

interface ProjectFormData {
  name: string;
  slug: string;
  description: string;
  color: string;
  image: string | null;
  projectGroup: string;
  agency: string;
  tags: string[];
}

const defaultFormData: ProjectFormData = {
  name: '',
  slug: '',
  description: '',
  color: 'blue',
  image: null,
  projectGroup: '',
  agency: '',
  tags: [],
};

// Format relative time
const formatRelativeTime = (date?: string) => {
  if (!date) return 'Never';
  const diff = Date.now() - new Date(date).getTime();
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 30) return `${days}d ago`;
  return new Date(date).toLocaleString('en-GB', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
};



// Project Card Component - Compact Design with Drag & Drop
interface ProjectCardProps {
  project: ProjectWithCounts;
  onClick: () => void;
  onEdit: (e: React.MouseEvent) => void;
  onDelete: (e: React.MouseEvent) => void;
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onDragEnd?: (e: React.DragEvent) => void;
  isDragging?: boolean;
}

const ProjectCard = ({ 
  project, 
  onClick, 
  onEdit, 
  onDelete,
  draggable = false,
  onDragStart,
  onDragEnd,
  isDragging = false,
}: ProjectCardProps) => {
  const colors = colorMap[project.color] || colorMap.blue;

  return (
    <div
      onClick={onClick}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={`bg-white rounded-lg border cursor-pointer transition-all duration-200 overflow-hidden group shadow-sm flex flex-col h-full
        ${isDragging 
          ? 'opacity-50 scale-95 border-blue-400 shadow-lg' 
          : 'hover:border-blue-300 border-gray-200'
        }
        ${draggable ? 'cursor-move' : ''}
      `}
    >
      {/* Header - Icon + Full Name + Actions */}
      <div className="px-2.5 pt-2 pb-1">
        <div className="flex items-center gap-2">
          {/* Icon */}
          <div className="flex-shrink-0">
            {project.image ? (
              <div className="w-7 h-7 rounded-md overflow-hidden border border-gray-200 flex-shrink-0">
                <img 
                  src={project.image} 
                  alt={project.name}
                  className="w-full h-full object-cover"
                />
              </div>
            ) : (
              <div className={`w-7 h-7 ${colors.bg} rounded-md flex items-center justify-center flex-shrink-0`}>
                <span className="text-white font-bold text-xs">{project.name[0]}</span>
              </div>
            )}
          </div>

          {/* Full Project Name */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 min-w-0">
              <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${project.status === 'Active' ? 'bg-green-500' : 'bg-gray-300'}`} title={project.status} />
              <h3 className="font-medium text-sm text-gray-900 leading-tight truncate group-hover:text-blue-600 transition-colors" title={project.name}>
                {project.name}
              </h3>
            </div>
          </div>

          {/* Action Icons */}
          <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 -mt-1 -mr-1" onClick={(e) => e.stopPropagation()}>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onEdit(e);
              }}
              className="p-1 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors"
              title="Edit"
            >
              <Pencil className="h-3 w-3" />
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDelete(e);
              }}
              className="p-1 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
              title="Delete"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
        </div>
      </div>

      {/* Content - Description */}
      <div className="px-2.5 pb-1.5 flex-1">
        <p className="text-[12px] text-gray-500 line-clamp-1" title={project.description || ''}>
          {project.description || '\u00A0'}
        </p>
      </div>

      {/* Footer - Stats & Tags */}
      <div className="px-2.5 py-1 bg-gray-50 border-t border-gray-100 flex items-center justify-between mt-auto">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span className="text-[12px] font-medium text-gray-600 flex-shrink-0">
            {(project.flowCount ?? 0)} flow{project.flowCount !== 1 ? 's' : ''}
          </span>
          {project.tags && project.tags.length > 0 && (
            <div className="flex items-center gap-1 min-w-0 overflow-hidden">
              {project.tags.slice(0, 3).map((tag) => (
                <span 
                  key={tag} 
                  className="text-[12px] px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded truncate max-w-[60px]"
                  title={tag}
                >
                  {tag}
                </span>
              ))}
              {project.tags.length > 3 && (
                <span className="text-[12px] text-gray-400 flex-shrink-0">
                  +{project.tags.length - 3}
                </span>
              )}
            </div>
          )}
        </div>
        <span className="text-[12px] text-gray-400 flex-shrink-0 ml-2">
          {formatRelativeTime(project.lastActivity || project.updatedAt)}
        </span>
      </div>
    </div>
  );
};

// Image Upload Component
interface ImageUploadProps {
  value: string | null;
  onChange: (image: string | null) => void;
  color: string;
}

const ImageUpload = ({ value, onChange, color }: ImageUploadProps) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const colors = colorMap[color] || colorMap.blue;

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      alert('Please select an image file');
      return;
    }

    if (file.size > 2 * 1024 * 1024) {
      alert('Image size must be less than 2MB');
      return;
    }

    const reader = new FileReader();
    reader.onloadend = () => {
      onChange(reader.result as string);
    };
    reader.readAsDataURL(file);
  };

  const handleRemove = () => {
    onChange(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  return (
    <div className="h-full flex flex-col">
      <label className="block text-xs font-medium text-gray-700 mb-1">Project Image</label>
      
      <div className="flex-1 min-h-0">
        {value ? (
          <div className="relative w-full h-full rounded-lg overflow-hidden border border-gray-200">
            <img src={value} alt="Project" className="w-full h-full object-cover" />
            <div className="absolute inset-0 bg-black bg-opacity-40 opacity-0 hover:opacity-100 transition-opacity flex items-center justify-center gap-1">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center justify-center px-2 h-8 bg-white rounded text-[13px] font-medium text-gray-700 hover:bg-gray-100 whitespace-nowrap"
              >
                Change
              </button>
              <button
                type="button"
                onClick={handleRemove}
                className="inline-flex items-center justify-center px-2 h-8 rounded text-[13px] font-medium whitespace-nowrap bg-red-600 text-white hover:bg-red-700"
              >
                Remove
              </button>
            </div>
          </div>
        ) : (
          <div
            onClick={() => fileInputRef.current?.click()}
            className={`w-full h-full rounded-lg border-2 border-dashed ${colors.border} ${colors.light} flex flex-col items-center justify-center cursor-pointer hover:bg-opacity-80 transition-colors`}
          >
            <div className={`p-1.5 rounded-full ${colors.bg} bg-opacity-10 mb-1`}>
              <Plus className={`${colors.icon} h-4 w-4`} />
            </div>
            <p className="text-[12px] text-gray-600 text-center px-1">Click to upload</p>
            <p className="text-[12px] text-gray-400">PNG, JPG</p>
          </div>
        )}
      </div>
      
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        onChange={handleFileChange}
        className="hidden"
      />
    </div>
  );
};

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
      <label className="block text-xs font-medium text-gray-700 mb-0.5">{label}</label>
      <div className="relative">
        {icon && (
          <div className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400">
            {icon}
          </div>
        )}
        <button
          type="button"
          onClick={() => setIsOpen(!isOpen)}
          className={`w-full ${icon ? 'pl-8' : 'pl-2.5'} pr-8 py-1.5 border border-gray-300 rounded-md text-left text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all bg-white hover:border-gray-400`}
        >
          <span className={value ? 'text-gray-900' : 'text-gray-400'}>
            {value || placeholder || `Select ${label}`}
          </span>
        </button>
        <ChevronDown className={`absolute right-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </div>

      {isOpen && (
        <div className="absolute z-50 w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-48 overflow-auto">
          {/* Search/Add Input */}
          <div className="p-1.5 border-b border-gray-100 sticky top-0 bg-white">
            <input
              type="text"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              placeholder={`Search or add ${label.toLowerCase()}...`}
              className="w-full px-2 py-1.5 text-sm border border-gray-200 rounded focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
              autoFocus
            />
          </div>

          {/* Options List */}
          <div className="py-0.5">
            {filteredOptions.length === 0 && !canAddNew && (
              <div className="px-2 py-1.5 text-xs text-gray-400 text-center">
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
                className={`w-full px-2 py-1.5 text-left text-xs hover:bg-gray-50 flex items-center justify-between ${
                  value === option ? 'bg-blue-50 text-blue-700' : 'text-gray-700'
                }`}
              >
                <span>{option}</span>
                {value === option && <CheckCircle2 className="h-3.5 w-3.5 text-blue-500" />}
              </button>
            ))}

            {/* Add New Option */}
            {canAddNew && (
              <button
                type="button"
                onClick={handleAddNew}
                className="w-full px-2 py-1.5 text-left text-xs text-blue-600 hover:bg-blue-50 flex items-center gap-1 border-t border-gray-100"
              >
                <Plus className="h-3.5 w-3.5" />
                <span>Add "{inputValue}"</span>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

// Create/Edit Modal Component
interface ProjectModalProps {
  isOpen: boolean;
  onClose: () => void;
  project?: ProjectWithCounts | null;
  onSave: (data: ProjectFormData) => void;
  isLoading?: boolean;
  availableProjectGroups: string[];
  availableAgencies: { name: string; level: string | null }[];
  onProjectGroupsChange: (groups: string[]) => void;
  onAgenciesChange: (agencies: { name: string; level: string | null }[]) => void;
}

const ProjectModal = ({ 
  isOpen, 
  onClose, 
  project, 
  onSave, 
  isLoading,
  availableProjectGroups,
  availableAgencies,
  onProjectGroupsChange,
  onAgenciesChange,
}: ProjectModalProps) => {
  const [formData, setFormData] = useState<ProjectFormData>(defaultFormData);
  const isEditing = !!project;

  useEffect(() => {
    if (project) {
      setFormData({
        name: project.name,
        slug: project.slug || '',
        description: project.description || '',
        color: project.color || 'blue',
        image: project.image || null,
        projectGroup: project.projectGroup || '',
        agency: project.agency || '',
        tags: project.tags || [],
      });
    } else {
      setFormData(defaultFormData);
    }
  }, [project, isOpen]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.name?.trim() || !formData.slug?.trim()) return;
    onSave(formData);
  };

  const handleAddProjectGroup = (newGroup: string) => {
    if (!availableProjectGroups.includes(newGroup)) {
      onProjectGroupsChange([...availableProjectGroups, newGroup]);
    }
  };

  const handleAddAgency = (newAgency: string) => {
    if (!availableAgencies.some(a => a.name === newAgency)) {
      onAgenciesChange([...availableAgencies, { name: newAgency, level: '' }]);
    }
  };

  const uniqueAgencyNames = [...new Set(availableAgencies.map(a => a.name))];

  const [customColor, setCustomColor] = useState('#3b82f6');
  const [showCustomColor, setShowCustomColor] = useState(false);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={isEditing ? 'Edit Project' : 'Create New Project'}
      size="2xl"
    >
      <form onSubmit={handleSubmit} className="space-y-3">
        {/* Two Column: Image | Fields */}
        <div className="grid grid-cols-[140px_1fr] gap-3">
          {/* Image Upload - Compact */}
          <div className="h-[140px]">
            <ImageUpload
              value={formData.image}
              onChange={(image) => setFormData({ ...formData, image })}
              color={formData.color}
            />
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
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all"
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
                value={formData.slug}
                onChange={(e) => setFormData({ ...formData, slug: e.target.value })}
                className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all"
                placeholder="enter-project-slug"
                required
              />
            </div>

            {/* Description */}
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-0.5">Description</label>
              <textarea
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all resize-none"
                rows={2}
                placeholder="Enter description"
              />
            </div>
          </div>
        </div>

        {/* Two Column: Project Group & Agency */}
        <div className="grid grid-cols-2 gap-3">
          <ComboboxWithAdd
            label="Project Group"
            value={formData.projectGroup}
            options={availableProjectGroups}
            onChange={(value) => setFormData({ ...formData, projectGroup: value })}
            onAddNew={handleAddProjectGroup}
            placeholder="Select group"
            icon={<FolderOpen className="h-3.5 w-3.5" />}
          />

          <ComboboxWithAdd
            label="Agency"
            value={formData.agency}
            options={uniqueAgencyNames}
            onChange={(value) => setFormData({ ...formData, agency: value })}
            onAddNew={handleAddAgency}
            placeholder="Select agency"
            icon={<Building2 className="h-3.5 w-3.5" />}
          />
        </div>

        {/* Tags Input */}
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Tags</label>
          <div 
            className="flex flex-wrap gap-1.5 p-1.5 border border-gray-300 rounded-lg bg-white focus-within:ring-2 focus-within:ring-blue-500 focus-within:border-blue-500 cursor-text min-h-[38px]"
            onClick={() => {
              const input = document.getElementById('project-tags-input') as HTMLInputElement;
              input?.focus();
            }}
          >
            {formData.tags.map((tag) => (
              <span
                key={tag}
                className="inline-flex items-center gap-0.5 text-[12px] px-2 py-0.5 bg-blue-50 text-blue-700 rounded-full border border-blue-200"
              >
                {tag}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setFormData({ ...formData, tags: formData.tags.filter(t => t !== tag) });
                  }}
                  className="hover:text-red-500 transition-colors p-0.5"
                >
                  <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </span>
            ))}
            <input
              id="project-tags-input"
              type="text"
              className="flex-1 min-w-[80px] outline-none text-sm bg-transparent"
              placeholder={formData.tags.length === 0 ? "Type and press Enter to add tags..." : ""}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ',') {
                  e.preventDefault();
                  const input = e.target as HTMLInputElement;
                  const rawValue = input.value.trim();
                  if (rawValue) {
                    const newTags = rawValue
                      .split(/[,;]+/)
                      .map(t => t.trim())
                      .filter(t => t.length > 0 && !formData.tags.includes(t));
                    if (newTags.length > 0) {
                      setFormData({ ...formData, tags: [...formData.tags, ...newTags] });
                    }
                    input.value = '';
                  }
                } else if (e.key === 'Backspace' && !(e.target as HTMLInputElement).value && formData.tags.length > 0) {
                  setFormData({ ...formData, tags: formData.tags.slice(0, -1) });
                }
              }}
              onBlur={(e) => {
                const rawValue = e.target.value.trim();
                if (rawValue) {
                  const newTags = rawValue
                    .split(/[,;]+/)
                    .map(t => t.trim())
                    .filter(t => t.length > 0 && !formData.tags.includes(t));
                  if (newTags.length > 0) {
                    setFormData({ ...formData, tags: [...formData.tags, ...newTags] });
                  }
                  e.target.value = '';
                }
              }}
              onClick={(e) => e.stopPropagation()}
            />
          </div>
          <p className="text-[12px] text-gray-400 mt-1">Type and press Enter or comma (,) to add tags. Backspace to remove last.</p>
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
                  setFormData({ ...formData, color: e.target.value });
                }}
                className="w-12 h-8 rounded cursor-pointer border border-gray-300"
              />
              <input
                type="text"
                value={customColor}
                onChange={(e) => {
                  setCustomColor(e.target.value);
                  setFormData({ ...formData, color: e.target.value });
                }}
                className="flex-1 px-2.5 py-1.5 text-sm border border-gray-300 rounded-md font-mono"
                placeholder="#3b82f6"
              />
            </div>
          ) : (
            <div className="grid grid-cols-11 gap-1.5">
              {availableColors.map(({ key, label }) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setFormData({ ...formData, color: key })}
                  className={`group relative w-full aspect-square rounded ${colorMap[key].bg} ${
                    formData.color === key 
                      ? 'ring-2 ring-offset-1 ring-gray-800 scale-110' 
                      : 'hover:scale-105'
                  } transition-all`}
                  title={label}
                >
                  {formData.color === key && (
                    <span className="absolute inset-0 flex items-center justify-center text-white text-[12px]">
                      <i className="fas fa-check"></i>
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-2 border-t">
          <Button type="button" variant="secondary" onClick={onClose} size="sm">
            Cancel
          </Button>
          <Button type="submit" isLoading={isLoading} size="sm">
            {isEditing ? 'Save Changes' : 'Create Project'}
          </Button>
        </div>
      </form>
    </Modal>
  );
};

// Delete Confirmation Modal
interface DeleteModalProps {
  isOpen: boolean;
  onClose: () => void;
  project: ProjectWithCounts | null;
  onConfirm: () => void;
  isLoading?: boolean;
}

const DeleteModal = ({ isOpen, onClose, project, onConfirm, isLoading }: DeleteModalProps) => {
  if (!project) return null;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Delete Project"
      size="sm"
    >
      <div className="space-y-4">
        <div className="flex items-center gap-3 text-amber-500">
          <AlertCircle className="h-8 w-8" />
          <p className="text-sm text-gray-600">
            Are you sure you want to delete <strong>{project.name}</strong>?
          </p>
        </div>
        <p className="text-sm text-gray-500">
          This action cannot be undone. All flows, connections, and data associated with this project will be permanently deleted.
        </p>
        
        <div className="flex justify-end gap-3 pt-4 border-t">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button 
            type="button" 
            variant="danger" 
            onClick={onConfirm}
            isLoading={isLoading}
          >
            Delete Project
          </Button>
        </div>
      </div>
    </Modal>
  );
};

// Group Header Component
interface GroupHeaderProps {
  title: string;
  count: number;
  isExpanded: boolean;
  onToggle: () => void;
  level?: number;
  icon?: React.ReactNode;
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDragLeave?: () => void;
  onDrop?: (e: React.DragEvent) => void;
  isDragging?: boolean;
  isDragOver?: boolean;
}

const GroupHeader = ({ 
  title, count, isExpanded, onToggle, level = 0, icon,
  draggable = false,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  isDragging = false,
  isDragOver = false
}: GroupHeaderProps) => {
  const indentClass = level === 0 ? '' : level === 1 ? 'ml-2 sm:ml-3' : 'ml-4 sm:ml-6';
  
  // Subtle theme with colored icons
  const styles = level === 0 
    ? {
        // Project Group - gray background with blue tinted icon
        bg: 'bg-gray-50',
        border: 'border-gray-200',
        text: 'text-gray-700',
        badge: 'bg-white text-gray-600 border border-gray-200',
        iconBg: 'bg-blue-50 text-blue-500',
        chevron: 'text-gray-400',
      }
    : {
        // Agency - white background with emerald tinted icon
        bg: 'bg-white',
        border: 'border-gray-200',
        text: 'text-gray-600',
        badge: 'bg-gray-100 text-gray-500 border border-gray-200',
        iconBg: 'bg-emerald-50 text-emerald-500',
        chevron: 'text-gray-400',
      };
  
  return (
    <div 
      className={`${indentClass} ${styles.bg} border ${styles.border} rounded-lg px-3 py-2 flex items-center gap-2 cursor-pointer hover:border-gray-300 hover:shadow-sm transition-all mb-1.5 shadow-sm
        ${isDragging ? 'opacity-50' : ''}
        ${isDragOver ? 'border-blue-400 ring-2 ring-blue-100' : ''}
      `}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onClick={onToggle}
    >
      {draggable && (
        <GripVertical className="h-4 w-4 text-gray-300 cursor-grab active:cursor-grabbing" />
      )}
      
      {isExpanded ? (
        <ChevronDown className={`h-4 w-4 ${styles.chevron}`} />
      ) : (
        <ChevronRight className={`h-4 w-4 ${styles.chevron}`} />
      )}
      
      {icon && (
        <span className={`${styles.iconBg} p-1 rounded text-xs`}>
          {icon}
        </span>
      )}
      
      <span className={`${styles.text} font-medium text-sm flex-1`}>{title}</span>
      
      <span className={`text-xs ${styles.badge} px-2 py-0.5 rounded-full`}>
        {count}
      </span>
    </div>
  );
};

// Main Projects Page
const Projects = () => {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<ProjectWithCounts[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  // Search filter
  const [searchTerm, setSearchTerm] = useState('');
  
  // Modal states
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [selectedProject, setSelectedProject] = useState<ProjectWithCounts | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  // Dropdown options
  const [availableProjectGroups, setAvailableProjectGroups] = useState<string[]>([]);
  const [availableAgencies, setAvailableAgencies] = useState<{ name: string; level: string | null }[]>([]);

  // Expanded states for grouping
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  
  // Drag and drop states
  const [draggedProject, setDraggedProject] = useState<ProjectWithCounts | null>(null);
  const [dragOverProjectId, setDragOverProjectId] = useState<string | null>(null);
  const [reorderedProjects, setReorderedProjects] = useState<ProjectWithCounts[]>([]);
  
  // Drag and drop states for groups and agencies
  const [draggedGroup, setDraggedGroup] = useState<string | null>(null);
  const [dragOverGroup, setDragOverGroup] = useState<string | null>(null);
  const [draggedAgency, setDraggedAgency] = useState<{group: string, agency: string} | null>(null);
  const [dragOverAgency, setDragOverAgency] = useState<{group: string, agency: string} | null>(null);
  const [groupOrder, setGroupOrder] = useState<string[]>([]);
  const [agencyOrders, setAgencyOrders] = useState<Record<string, string[]>>({});

  useEffect(() => {
    fetchProjects();
    fetchMetadata();
    fetchGroupAgencyOrder();
  }, []); // Empty array - fetchProjects is stable due to useCallback
  
  // Update reordered projects when projects change
  useEffect(() => {
    if (projects.length === 0) return;
    
    if (reorderedProjects.length === 0) {
      // Initial load - set from projects
      setReorderedProjects(projects);
    } else {
      // Update existing reordered projects with new data from projects (e.g., tags)
      const updatedProjects = reorderedProjects.map(rp => {
        const updatedProject = projects.find(p => p.id === rp.id);
        return updatedProject ? { ...rp, ...updatedProject } : rp;
      });
      setReorderedProjects(updatedProjects);
    }
  }, [projects]);

  const fetchProjects = useCallback(async () => {
    try {
      setLoading(true);
      const response = await fetch(`${API_URL}/projects`);
      const result = await response.json();
      
      if (result.success) {
        setProjects(result.data);
        setReorderedProjects(result.data); // Sync reordered projects immediately
      } else {
        setError(result.error || 'Failed to load projects');
      }
    } catch (err) {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  }, []);

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

  const fetchGroupAgencyOrder = async () => {
    try {
      const response = await fetch(`${API_URL}/projects/group-agency-order`);
      const result = await response.json();
      
      if (result.success) {
        if (result.data.groupOrder.length > 0) {
          setGroupOrder(result.data.groupOrder);
        }
        if (Object.keys(result.data.agencyOrders).length > 0) {
          setAgencyOrders(result.data.agencyOrders);
        }
      }
    } catch (err) {
      console.error('Failed to fetch group-agency order:', err);
    }
  };

  const handleCreateProject = async (formData: ProjectFormData) => {
    setIsSaving(true);
    try {
      const response = await fetch(`${API_URL}/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });
      const result = await response.json();
      
      if (result.success) {
        await fetchProjects();
        setIsCreateModalOpen(false);
      } else {
        alert(result.error || 'Failed to create project');
      }
    } catch (err) {
      alert('Network error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleEditProject = async (formData: ProjectFormData) => {
    if (!selectedProject) return;
    
    setIsSaving(true);
    try {
      const response = await apiFetch(`${API_URL}/projects/${selectedProject.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });
      const result = await response.json();
      
      if (result.success) {
        await fetchProjects();
        setIsCreateModalOpen(false);
        setSelectedProject(null);
      } else {
        alert(result.error || 'Failed to update project');
      }
    } catch (err) {
      alert('Network error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDeleteProject = async () => {
    if (!selectedProject) return;
    
    setIsDeleting(true);
    try {
      const response = await apiFetch(`${API_URL}/projects/${selectedProject.id}`, {
        method: 'DELETE',
      });
      const result = await response.json();
      
      if (result.success) {
        await fetchProjects();
        setIsDeleteModalOpen(false);
        setSelectedProject(null);
      } else {
        alert(result.error || 'Failed to delete project');
      }
    } catch (err) {
      alert('Network error');
    } finally {
      setIsDeleting(false);
    }
  };

  const handleProjectClick = (projectId: string) => {
    navigate(`/projects/${projectId}`);
  };

  const handleEditClick = (e: React.MouseEvent, project: ProjectWithCounts) => {
    e.stopPropagation();
    setSelectedProject(project);
    setIsCreateModalOpen(true);
  };

  const handleDeleteClick = (e: React.MouseEvent, project: ProjectWithCounts) => {
    e.stopPropagation();
    setSelectedProject(project);
    setIsDeleteModalOpen(true);
  };

  const toggleGroup = (groupKey: string) => {
    setExpandedGroups(prev => ({
      ...prev,
      [groupKey]: !prev[groupKey]
    }));
  };
  
  // Drag and drop handlers
  const handleDragStart = (e: React.DragEvent, project: ProjectWithCounts) => {
    setDraggedProject(project);
    e.dataTransfer.effectAllowed = 'move';
    // Set drag image if needed
    const dragImage = document.createElement('div');
    dragImage.className = 'bg-white border border-blue-400 rounded-lg p-3 shadow-lg text-sm font-medium';
    dragImage.textContent = project.name;
    dragImage.style.position = 'absolute';
    dragImage.style.top = '-1000px';
    document.body.appendChild(dragImage);
    e.dataTransfer.setDragImage(dragImage, 0, 0);
    setTimeout(() => document.body.removeChild(dragImage), 0);
  };
  
  const handleDragOver = (e: React.DragEvent, targetProject: ProjectWithCounts) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (draggedProject && draggedProject.id !== targetProject.id) {
      setDragOverProjectId(targetProject.id);
    }
  };
  
  const handleDragLeave = () => {
    setDragOverProjectId(null);
  };
  
  const handleDrop = async (e: React.DragEvent, targetProject: ProjectWithCounts) => {
    e.preventDefault();
    setDragOverProjectId(null);
    
    if (!draggedProject || draggedProject.id === targetProject.id) {
      setDraggedProject(null);
      return;
    }
    
    // Reorder projects within the same group
    const currentList = [...reorderedProjects];
    const draggedIndex = currentList.findIndex(p => p.id === draggedProject.id);
    const targetIndex = currentList.findIndex(p => p.id === targetProject.id);
    
    if (draggedIndex === -1 || targetIndex === -1) {
      setDraggedProject(null);
      return;
    }
    
    // Check if same group and agency
    const draggedProj = currentList[draggedIndex];
    const targetProj = currentList[targetIndex];
    
    if (draggedProj.projectGroup !== targetProj.projectGroup || 
        draggedProj.agency !== targetProj.agency) {
      // Cannot reorder across groups
      alert('Can only reorder projects within the same group and agency');
      setDraggedProject(null);
      return;
    }
    
    // Swap positions
    const [removed] = currentList.splice(draggedIndex, 1);
    currentList.splice(targetIndex, 0, removed);
    
    // Update state
    setReorderedProjects(currentList);
    setProjects(currentList);
    setDraggedProject(null);
    
    // Auto-save positions to backend
    try {
      const positions = currentList.map((p, index) => ({
        projectId: p.id,
        position: index,
      }));
      await fetch(`${API_URL}/projects/position`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ positions }),
      });
    } catch (err) {
      console.error('Failed to save positions:', err);
    }
  };
  
  const handleDragEnd = () => {
    setDraggedProject(null);
    setDragOverProjectId(null);
  };

  // Drag and drop handlers for Groups
  const handleGroupDragStart = (groupKey: string) => {
    setDraggedGroup(groupKey);
  };

  const handleGroupDragOver = (e: React.DragEvent, targetGroup: string) => {
    e.preventDefault();
    if (draggedGroup && draggedGroup !== targetGroup) {
      setDragOverGroup(targetGroup);
    }
  };

  const handleGroupDragLeave = () => {
    setDragOverGroup(null);
  };

  const handleGroupDrop = async (e: React.DragEvent, targetGroup: string) => {
    e.preventDefault();
    setDragOverGroup(null);
    
    if (!draggedGroup || draggedGroup === targetGroup) {
      setDraggedGroup(null);
      return;
    }

    // Reorder groups
    const currentOrder = groupOrder.length > 0 ? groupOrder : sortedGroupKeys;
    const draggedIndex = currentOrder.indexOf(draggedGroup);
    const targetIndex = currentOrder.indexOf(targetGroup);

    if (draggedIndex === -1 || targetIndex === -1) {
      setDraggedGroup(null);
      return;
    }

    const newOrder = [...currentOrder];
    const [removed] = newOrder.splice(draggedIndex, 1);
    newOrder.splice(targetIndex, 0, removed);
    
    setGroupOrder(newOrder);
    setDraggedGroup(null);
    
    // Save to database
    try {
      const groupPositions = newOrder.map((group, index) => ({
        projectGroup: group,
        position: index,
      }));
      await fetch(`${API_URL}/projects/group-position`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groupPositions }),
      });
    } catch (err) {
      console.error('Failed to save group positions:', err);
    }
  };

  // Drag and drop handlers for Agencies
  const handleAgencyDragStart = (groupKey: string, agencyKey: string) => {
    setDraggedAgency({group: groupKey, agency: agencyKey});
  };

  const handleAgencyDragOver = (e: React.DragEvent, groupKey: string, targetAgency: string) => {
    e.preventDefault();
    if (draggedAgency && (draggedAgency.group !== groupKey || draggedAgency.agency !== targetAgency)) {
      setDragOverAgency({group: groupKey, agency: targetAgency});
    }
  };

  const handleAgencyDragLeave = () => {
    setDragOverAgency(null);
  };

  const handleAgencyDrop = async (e: React.DragEvent, groupKey: string, targetAgency: string) => {
    e.preventDefault();
    setDragOverAgency(null);
    
    if (!draggedAgency || (draggedAgency.group === groupKey && draggedAgency.agency === targetAgency)) {
      setDraggedAgency(null);
      return;
    }

    // Can only reorder within same group
    if (draggedAgency.group !== groupKey) {
      alert('Can only reorder agencies within the same project group');
      setDraggedAgency(null);
      return;
    }

    // Get current agency order for this group
    const groupAgencies = groups[groupKey] || {};
    const baseAgencyOrder = Object.keys(groupAgencies);
    const currentOrder = agencyOrders[groupKey] || baseAgencyOrder;
    const draggedIndex = currentOrder.indexOf(draggedAgency.agency);
    const targetIndex = currentOrder.indexOf(targetAgency);

    if (draggedIndex === -1 || targetIndex === -1) {
      setDraggedAgency(null);
      return;
    }

    const newOrder = [...currentOrder];
    const [removed] = newOrder.splice(draggedIndex, 1);
    newOrder.splice(targetIndex, 0, removed);
    
    setAgencyOrders(prev => ({...prev, [groupKey]: newOrder}));
    setDraggedAgency(null);
    
    // Save to database
    try {
      const agencyPositions = newOrder.map((agency, index) => ({
        projectGroup: groupKey,
        agency: agency,
        position: index,
      }));
      await fetch(`${API_URL}/projects/agency-position`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agencyPositions }),
      });
    } catch (err) {
      console.error('Failed to save agency positions:', err);
    }
  };

  // Filter projects (use reorderedProjects if available)
  const displayProjects = reorderedProjects.length > 0 ? reorderedProjects : projects;
  const filteredProjects = displayProjects.filter(project => 
    !searchTerm || 
    project.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    project.description?.toLowerCase().includes(searchTerm.toLowerCase()) ||
    project.projectGroup?.toLowerCase().includes(searchTerm.toLowerCase()) ||
    project.agency?.toLowerCase().includes(searchTerm.toLowerCase())
  );

  // Group projects by Project Group -> Agency Level
  const groupProjects = (projects: ProjectWithCounts[]) => {
    const groups: Record<string, Record<string, ProjectWithCounts[]>> = {};
    const ungrouped: ProjectWithCounts[] = [];

    projects.forEach(project => {
      const groupKey = project.projectGroup || 'Ungrouped';
      const agencyKey = project.agency || 'No Agency';
      
      if (!groups[groupKey]) {
        groups[groupKey] = {};
      }
      if (!groups[groupKey][agencyKey]) {
        groups[groupKey][agencyKey] = [];
      }
      groups[groupKey][agencyKey].push(project);
    });

    return { groups, ungrouped };
  };

  const { groups } = groupProjects(filteredProjects);
  const baseSortedGroupKeys = Object.keys(groups).sort((a, b) => {
    if (a === 'Ungrouped') return 1;
    if (b === 'Ungrouped') return -1;
    return a.localeCompare(b);
  });
  
  // Use custom group order if available
  const sortedGroupKeys = groupOrder.length > 0 
    ? groupOrder.filter(g => groups[g]) // Only include groups that exist
    : baseSortedGroupKeys;

  // Calculate stats
  const stats = {
    total: projects.length,
    active: projects.filter(p => p.status === 'Active').length,
    totalFlows: projects.reduce((acc, p) => acc + (p.flowCount ?? p.flows?.length ?? 0), 0),
    totalConnections: projects.reduce((acc, p) => acc + (p.connectionCount ?? p.connections?.length ?? 0), 0),
  };

  if (loading) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-gray-50">
        <Loader2 className="h-10 w-10 text-blue-500 animate-spin mb-4" />
        <p className="text-gray-500">Loading projects...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-gray-50">
        <AlertCircle className="h-12 w-12 text-red-500 mb-4" />
        <h2 className="text-xl font-semibold text-gray-900">{error}</h2>
        <button 
          onClick={fetchProjects}
          className="mt-4 px-3 h-9 rounded-lg flex items-center gap-2 whitespace-nowrap bg-blue-600 text-white hover:bg-blue-700"
        >
          <RefreshCw className="h-4 w-4" />
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header with Stats */}
      <header className="bg-white border-b border-gray-200 sticky top-0 z-20 shadow-sm">
        <div className="px-4 sm:px-6 py-3 sm:py-4">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h1 className="text-xl sm:text-2xl font-bold text-gray-900">Projects</h1>
              <p className="hidden sm:block text-gray-500 text-sm mt-1">Manage your integration projects</p>
            </div>
            <Button
              onClick={() => {
                setSelectedProject(null);
                setIsCreateModalOpen(true);
              }}
              leftIcon={<Plus className="h-4 w-4" />}
              className="shrink-0 whitespace-nowrap"
            >
              <span className="hidden sm:inline">Create Project</span>
              <span className="sm:hidden">New</span>
            </Button>
          </div>
          
          {/* Compact Stats Bar — 2×2 on phones, one row from sm */}
          <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:flex sm:items-center sm:gap-6 mt-3 pt-3 sm:mt-4 sm:pt-4 border-t border-gray-100">
            <div className="flex items-center gap-2">
              <div className="p-1.5 bg-blue-50 rounded-md">
                <FolderOpen className="h-4 w-4 text-blue-600" />
              </div>
              <div>
                <span className="text-lg font-bold text-gray-900">{stats.total}</span>
                <span className="text-xs text-gray-500 ml-1">projects</span>
              </div>
            </div>
            
            <div className="hidden sm:block w-px h-6 bg-gray-200" />
            
            <div className="flex items-center gap-2">
              <div className="p-1.5 bg-emerald-50 rounded-md">
                <CheckCircle2 className="h-4 w-4 text-emerald-600" />
              </div>
              <div>
                <span className="text-lg font-bold text-gray-900">{stats.active}</span>
                <span className="text-xs text-gray-500 ml-1">active</span>
              </div>
            </div>
            
            <div className="hidden sm:block w-px h-6 bg-gray-200" />
            
            <div className="flex items-center gap-2">
              <div className="p-1.5 bg-purple-50 rounded-md">
                <Layers className="h-4 w-4 text-purple-600" />
              </div>
              <div>
                <span className="text-lg font-bold text-gray-900">{stats.totalFlows}</span>
                <span className="text-xs text-gray-500 ml-1">flows</span>
              </div>
            </div>
            
            <div className="hidden sm:block w-px h-6 bg-gray-200" />
            
            <div className="flex items-center gap-2">
              <div className="p-1.5 bg-orange-50 rounded-md">
                <Plug className="h-4 w-4 text-orange-600" />
              </div>
              <div>
                <span className="text-lg font-bold text-gray-900">{stats.totalConnections}</span>
                <span className="text-xs text-gray-500 ml-1">connections</span>
              </div>
            </div>
          </div>
        </div>
      </header>

      <div className="p-4 sm:p-6">
        {/* Search Bar */}
        <div className="mb-4 sm:mb-6 flex items-center gap-4">
          <div className="relative max-w-md flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search projects..."
              className="w-full pl-10 pr-4 py-2 bg-white border border-gray-200 rounded-lg text-sm text-gray-900 placeholder-gray-400 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
            />
            {searchTerm && (
              <button
                onClick={() => setSearchTerm('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
          
          {/* Reset Order Button - only show when custom order exists */}
          {(groupOrder.length > 0 || Object.keys(agencyOrders).length > 0) && (
            <button
              onClick={async () => {
                // Reset all positions to 0 in database
                try {
                  // Reset group positions
                  await fetch(`${API_URL}/projects/group-position`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                      groupPositions: groupOrder.map((group) => ({
                        projectGroup: group,
                        position: 0,
                      }))
                    }),
                  });
                  
                  // Reset agency positions
                  for (const [group, agencies] of Object.entries(agencyOrders)) {
                    await fetch(`${API_URL}/projects/agency-position`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ 
                        agencyPositions: agencies.map((agency) => ({
                          projectGroup: group,
                          agency: agency,
                          position: 0,
                        }))
                      }),
                    });
                  }
                  
                  // Clear local state
                  setGroupOrder([]);
                  setAgencyOrders({});
                } catch (err) {
                  console.error('Failed to reset positions:', err);
                }
              }}
              className="flex items-center gap-2 px-3 py-2 text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-lg transition-colors"
              title="Reset custom group and agency order"
            >
              <RefreshCw className="h-4 w-4" />
              Reset Order
            </button>
          )}
        </div>

        {/* Projects Grouped View */}
        {filteredProjects.length === 0 ? (
          <div className="text-center py-16 bg-white rounded-xl border border-dashed border-gray-200">
            <div className="w-16 h-16 bg-gray-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
              <FolderOpen className="h-8 w-8 text-gray-400" />
            </div>
            <h3 className="text-lg font-medium text-gray-900 mb-2">
              {searchTerm ? 'No projects found' : 'No projects yet'}
            </h3>
            <p className="text-gray-500 mb-4">
              {searchTerm ? 'Try adjusting your search' : 'Create your first project to get started'}
            </p>
            {!searchTerm && (
              <Button
                onClick={() => setIsCreateModalOpen(true)}
                leftIcon={<Plus className="h-4 w-4" />}
              >
                Create Project
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            {sortedGroupKeys.map((groupKey) => {
              const agencies = groups[groupKey];
              
              // Use custom agency order if available
              const baseSortedAgencyKeys = Object.keys(agencies).sort((a, b) => {
                if (a === 'No Agency') return 1;
                if (b === 'No Agency') return -1;
                return a.localeCompare(b);
              });
              
              const sortedAgencyKeys = agencyOrders[groupKey]?.length > 0
                ? agencyOrders[groupKey].filter(a => agencies[a])
                : baseSortedAgencyKeys;
              
              const groupProjectCount = sortedAgencyKeys.reduce((acc, agencyKey) => acc + agencies[agencyKey].length, 0);
              const isGroupExpanded = expandedGroups[groupKey] !== false; // Default expanded

              return (
                <div key={groupKey} className="space-y-2">
                  {/* Project Group Header */}
                  <GroupHeader
                    title={groupKey}
                    count={groupProjectCount}
                    isExpanded={isGroupExpanded}
                    onToggle={() => toggleGroup(groupKey)}
                    level={0}
                    icon={<FolderOpen className="h-4 w-4" />}
                    draggable={true}
                    onDragStart={() => handleGroupDragStart(groupKey)}
                    onDragOver={(e) => handleGroupDragOver(e, groupKey)}
                    onDragLeave={handleGroupDragLeave}
                    onDrop={(e) => handleGroupDrop(e, groupKey)}
                    isDragging={draggedGroup === groupKey}
                    isDragOver={dragOverGroup === groupKey}
                  />

                  {/* Agency Groups */}
                  {isGroupExpanded && (
                    <div className="space-y-2">
                      {sortedAgencyKeys.map((agencyKey) => {
                        const agencyProjects = agencies[agencyKey];
                        const agencyInfo = availableAgencies.find(a => a.name === agencyKey);
                        const displayName = agencyKey === 'No Agency' 
                          ? 'No Agency' 
                          : agencyInfo?.level 
                            ? `${agencyKey} (${agencyInfo.level})`
                            : agencyKey;
                        const agencyGroupKey = `${groupKey}-${agencyKey}`;
                        const isAgencyExpanded = expandedGroups[agencyGroupKey] !== false; // Default expanded

                        return (
                          <div key={agencyKey}>
                            {/* Agency Level Header */}
                            <GroupHeader
                              title={displayName}
                              count={agencyProjects.length}
                              isExpanded={isAgencyExpanded}
                              onToggle={() => toggleGroup(agencyGroupKey)}
                              level={1}
                              icon={<Building2 className="h-4 w-4" />}
                              draggable={true}
                              onDragStart={() => handleAgencyDragStart(groupKey, agencyKey)}
                              onDragOver={(e) => handleAgencyDragOver(e, groupKey, agencyKey)}
                              onDragLeave={handleAgencyDragLeave}
                              onDrop={(e) => handleAgencyDrop(e, groupKey, agencyKey)}
                              isDragging={draggedAgency?.group === groupKey && draggedAgency?.agency === agencyKey}
                              isDragOver={dragOverAgency?.group === groupKey && dragOverAgency?.agency === agencyKey}
                            />

                            {/* Projects Grid */}
                            {isAgencyExpanded && (
                              <div className="ml-0 sm:ml-12 mt-2 sm:mt-0 grid grid-cols-[repeat(auto-fill,minmax(15rem,20rem))] gap-2 sm:gap-3">
                                {agencyProjects.map((project) => (
                                  <div
                                    key={project.id}
                                    onDragOver={(e) => handleDragOver(e, project)}
                                    onDragLeave={handleDragLeave}
                                    onDrop={(e) => handleDrop(e, project)}
                                    className="relative"
                                  >
                                    {/* Drop Placeholder - Dashed border card */}
                                    {dragOverProjectId === project.id && draggedProject?.id !== project.id && (
                                      <div className="absolute inset-0 border-2 border-dashed border-blue-400 rounded-lg bg-blue-50/30 z-10 flex items-center justify-center">
                                        <div className="flex items-center gap-1 text-blue-500 text-xs font-medium">
                                          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                                          </svg>
                                          <span>Drop here</span>
                                        </div>
                                      </div>
                                    )}
                                    <div className={`
                                      transition-all duration-150
                                      ${dragOverProjectId === project.id && draggedProject?.id !== project.id ? 'opacity-30 scale-[0.98]' : ''}
                                      ${draggedProject?.id === project.id ? 'opacity-40' : ''}
                                    `}>
                                      <ProjectCard
                                        project={project}
                                        onClick={() => handleProjectClick(project.id)}
                                        onEdit={(e) => handleEditClick(e, project)}
                                        onDelete={(e) => handleDeleteClick(e, project)}
                                        draggable={true}
                                        onDragStart={(e) => handleDragStart(e, project)}
                                        onDragEnd={handleDragEnd}
                                        isDragging={draggedProject?.id === project.id}
                                      />
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Create/Edit Modal */}
        <ProjectModal
          isOpen={isCreateModalOpen}
          onClose={() => {
            setIsCreateModalOpen(false);
            setSelectedProject(null);
          }}
          project={selectedProject}
          onSave={selectedProject ? handleEditProject : handleCreateProject}
          isLoading={isSaving}
          availableProjectGroups={availableProjectGroups}
          availableAgencies={availableAgencies}
          onProjectGroupsChange={setAvailableProjectGroups}
          onAgenciesChange={setAvailableAgencies}
        />

        {/* Delete Confirmation Modal */}
        <DeleteModal
          isOpen={isDeleteModalOpen}
          onClose={() => {
            setIsDeleteModalOpen(false);
            setSelectedProject(null);
          }}
          project={selectedProject}
          onConfirm={handleDeleteProject}
          isLoading={isDeleting}
        />
      </div>
    </div>
  );
};

export default Projects;
