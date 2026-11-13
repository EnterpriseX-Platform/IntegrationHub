import { useState, useRef, useEffect } from 'react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { Globe, Clock, X, ChevronDown, CheckCircle2, Plus, Layers } from 'lucide-react';

interface CreateFlowModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (type: 'rest-api' | 'trigger', name: string, description: string, process: string, tags: string[]) => void;
  onUpdate?: (type: 'rest-api' | 'trigger', name: string, description: string, process: string, tags: string[]) => void;
  projectId: string;
  flow?: {
    id: string;
    name: string;
    type: string;
    description?: string;
    process?: string;
    tags?: string[];
  } | null;
  availableProcesses?: string[];
}

const FLOW_TYPES = [
  { value: 'rest-api', label: 'REST API', icon: Globe, color: 'blue', desc: 'HTTP endpoints with Swagger' },
  { value: 'trigger', label: 'Triggers', icon: Clock, color: 'green', desc: 'Scheduled & event-driven' },
] as const;

// Combobox/Dropdown with Add New option - Same as Project Group
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
                <span>Add &quot;{inputValue}&quot;</span>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

// Tag Input Component
interface TagInputProps {
  label: string;
  tags: string[];
  onChange: (tags: string[]) => void;
  placeholder?: string;
}

const TagInput = ({ label, tags, onChange, placeholder }: TagInputProps) => {
  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const handleAddTags = () => {
    const newTags = input
      .split(/[,;]+/)
      .map(t => t.trim())
      .filter(t => t.length > 0 && !tags.includes(t));
    
    if (newTags.length > 0) {
      onChange([...tags, ...newTags]);
    }
    setInput('');
    inputRef.current?.focus();
  };

  const handleRemoveTag = (tagToRemove: string) => {
    onChange(tags.filter(tag => tag !== tagToRemove));
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (input.trim()) {
        handleAddTags();
      }
    } else if (e.key === 'Backspace' && !input && tags.length > 0) {
      handleRemoveTag(tags[tags.length - 1]);
    }
  };

  return (
    <div>
      <label className="block text-xs font-medium text-gray-700 mb-1">{label}</label>
      <div 
        className="flex flex-wrap gap-1.5 p-1.5 border border-gray-300 rounded-lg bg-white focus-within:ring-2 focus-within:ring-blue-500 focus-within:border-blue-500 cursor-text min-h-[38px]"
        onClick={() => inputRef.current?.focus()}
      >
        {tags.map((tag) => (
          <span
            key={tag}
            className="inline-flex items-center gap-0.5 text-[10px] px-2 py-0.5 bg-blue-50 text-blue-700 rounded-full border border-blue-200"
          >
            {tag}
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleRemoveTag(tag);
              }}
              className="hover:text-red-500 transition-colors p-0.5"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={() => {
            if (input.trim()) {
              handleAddTags();
            }
          }}
          onClick={(e) => e.stopPropagation()}
          className="flex-1 min-w-[80px] outline-none text-sm bg-transparent"
          placeholder={tags.length === 0 ? placeholder : ""}
        />
      </div>
      <p className="text-[10px] text-gray-400 mt-1">Press Enter or comma to add multiple tags</p>
    </div>
  );
};

export const CreateFlowModal = ({ isOpen, onClose, onCreate, onUpdate, projectId: _projectId, flow, availableProcesses = [] }: CreateFlowModalProps) => {
  const isEditMode = !!flow;
  
  const [selectedType, setSelectedType] = useState<'rest-api' | 'trigger'>('rest-api');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [process, setProcess] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [isTypeDropdownOpen, setIsTypeDropdownOpen] = useState(false);
  const [processOptions, setProcessOptions] = useState<string[]>(availableProcesses);

  // Load flow data when in edit mode and update process options
  useEffect(() => {
    if (flow) {
      setSelectedType(flow.type === 'API_SPEC' ? 'rest-api' : 'trigger');
      setName(flow.name);
      setDescription(flow.description || '');
      setProcess(flow.process || '');
      setTags(flow.tags || []);
    }
  }, [flow]);

  // Update process options when availableProcesses changes
  useEffect(() => {
    setProcessOptions(availableProcesses);
  }, [availableProcesses]);

  const selectedTypeInfo = FLOW_TYPES.find(t => t.value === selectedType)!;
  const TypeIcon = selectedTypeInfo.icon;

  const handleSubmit = () => {
    if (!name.trim()) return;
    if (isEditMode && onUpdate) {
      onUpdate(selectedType, name, description, process, tags);
    } else {
      onCreate(selectedType, name, description, process, tags);
    }
    reset();
  };

  const reset = () => {
    setSelectedType('rest-api');
    setName('');
    setDescription('');
    setProcess('');
    setTags([]);
    setIsTypeDropdownOpen(false);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleAddNewProcess = (newProcess: string) => {
    if (!processOptions.includes(newProcess)) {
      setProcessOptions([...processOptions, newProcess]);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title={isEditMode ? 'Edit Flow' : 'Create Flow'} size="sm">
      <div className="space-y-4">
        {/* Flow Type Dropdown - Disabled in edit mode */}
        <div className="relative">
          <label className="block text-xs font-medium text-gray-700 mb-1">
            Flow Type <span className="text-red-500">*</span>
          </label>
          <button
            onClick={() => !isEditMode && setIsTypeDropdownOpen(!isTypeDropdownOpen)}
            disabled={isEditMode}
            className={`w-full flex items-center gap-3 px-3 py-2 border border-gray-300 rounded-lg bg-white transition-colors text-left ${
              isEditMode ? 'opacity-60 cursor-not-allowed bg-gray-50' : 'hover:border-gray-400'
            }`}
          >
            <div className={`w-8 h-8 rounded-lg flex items-center justify-center bg-${selectedTypeInfo.color}-100`}>
              <TypeIcon className={`h-4 w-4 text-${selectedTypeInfo.color}-600`} />
            </div>
            <div className="flex-1">
              <p className="text-sm font-medium text-gray-900">{selectedTypeInfo.label}</p>
              <p className="text-[10px] text-gray-500">{selectedTypeInfo.desc}</p>
            </div>
            <ChevronDown className={`h-4 w-4 text-gray-400 transition-transform ${isTypeDropdownOpen ? 'rotate-180' : ''}`} />
          </button>

          {isTypeDropdownOpen && (
            <div className="absolute z-50 w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg">
              {FLOW_TYPES.map((type) => {
                const Icon = type.icon;
                return (
                  <button
                    key={type.value}
                    onClick={() => {
                      setSelectedType(type.value);
                      setIsTypeDropdownOpen(false);
                    }}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-gray-50 transition-colors first:rounded-t-lg last:rounded-b-lg ${
                      selectedType === type.value ? 'bg-blue-50' : ''
                    }`}
                  >
                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center bg-${type.color}-100`}>
                      <Icon className={`h-4 w-4 text-${type.color}-600`} />
                    </div>
                    <div className="flex-1">
                      <p className="text-sm font-medium text-gray-900">{type.label}</p>
                      <p className="text-[10px] text-gray-500">{type.desc}</p>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Name */}
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">
            Name <span className="text-red-500">*</span>
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
            placeholder={selectedType === 'rest-api' ? 'e.g., Customer API' : 'e.g., Daily Report'}
            autoFocus
          />
        </div>

        {/* Description */}
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Description</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none resize-none"
            rows={2}
            placeholder="What does this flow do?"
          />
        </div>

        {/* Process - Combobox like Project Group */}
        <ComboboxWithAdd
          label="Process"
          value={process}
          options={processOptions}
          onChange={setProcess}
          onAddNew={handleAddNewProcess}
          placeholder="Select or create process"
          icon={<Layers className="h-3.5 w-3.5" />}
        />

        {/* Tags */}
        <TagInput
          label="Tags"
          tags={tags}
          onChange={setTags}
          placeholder="e.g., production, v1, urgent..."
        />

        {/* Actions */}
        <div className="flex justify-end gap-2 pt-3 border-t">
          <Button variant="secondary" onClick={handleClose} size="sm">Cancel</Button>
          <Button onClick={handleSubmit} disabled={!name.trim()} size="sm">
            {isEditMode ? 'Save Changes' : 'Create'}
          </Button>
        </div>
      </div>
    </Modal>
  );
};
