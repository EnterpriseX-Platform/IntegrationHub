import { useState, useRef, useEffect } from 'react';
import { ChevronDown, Database, Server, Globe, Cloud, Wifi } from 'lucide-react';
import { connectionRegistry } from '../../lib/connection-sdk';
import type { ConnectionTypeDefinition } from '../../lib/connection-sdk';

interface ConnectionTypeSelectorProps {
  value: string;
  onChange: (typeId: string) => void;
  placeholder?: string;
}

// Category icons mapping
const categoryIcons: Record<string, typeof Database> = {
  database: Database,
  storage: Server,
  api: Globe,
  messaging: Wifi,
  custom: Cloud,
};

export function ConnectionTypeSelector({ 
  value, 
  onChange, 
  placeholder = 'Select connection type...' 
}: ConnectionTypeSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const dropdownRef = useRef<HTMLDivElement>(null);
  
  const allTypes = connectionRegistry.getAll();
  const selectedType = connectionRegistry.get(value);
  
  // Filter out generic 'database' type (keep only specific types like postgresql, mysql, etc.)
  const filteredTypes = allTypes.filter(type => type.id !== 'database');
  
  // Group by category
  const groupedTypes = filteredTypes.reduce((acc, type) => {
    if (!acc[type.category]) {
      acc[type.category] = [];
    }
    acc[type.category].push(type);
    return acc;
  }, {} as Record<string, ConnectionTypeDefinition[]>);
  
  // Filter by search
  const filteredGroups = Object.entries(groupedTypes).reduce((acc, [category, types]) => {
    const filtered = types.filter(type => 
      type.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      type.description.toLowerCase().includes(searchTerm.toLowerCase())
    );
    if (filtered.length > 0) {
      acc[category] = filtered;
    }
    return acc;
  }, {} as Record<string, ConnectionTypeDefinition[]>);
  
  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);
  
  const handleSelect = (typeId: string) => {
    onChange(typeId);
    setIsOpen(false);
    setSearchTerm('');
  };
  
  return (
    <div className="relative" ref={dropdownRef}>
      {/* Selected Value / Trigger */}
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className={`
          w-full flex items-center justify-between
          px-4 py-3
          bg-white
          border-2 rounded-xl
          transition-all duration-200
          ${isOpen 
            ? 'border-purple-500 ring-4 ring-purple-100' 
            : 'border-gray-200 hover:border-purple-300 hover:shadow-md'
          }
        `}
      >
        {selectedType ? (
          <div className="flex items-center gap-3">
            <div 
              className={`w-10 h-10 ${selectedType.colors.bg} rounded-lg flex items-center justify-center`}
            >
              <i className={`fas ${selectedType.icon} ${selectedType.colors.text} text-lg`}></i>
            </div>
            <div className="text-left">
              <p className="font-medium text-gray-900">{selectedType.name}</p>
              <p className="text-xs text-gray-500">{selectedType.description}</p>
            </div>
          </div>
        ) : (
          <span className="text-gray-400">{placeholder}</span>
        )}
        <ChevronDown 
          className={`h-5 w-5 text-gray-400 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}
        />
      </button>
      
      {/* Dropdown */}
      {isOpen && (
        <div className="absolute z-[100] w-full mt-2 bg-white border border-gray-200 rounded-xl shadow-xl max-h-96 overflow-hidden">
          {/* Search */}
          <div className="p-3 border-b border-gray-100">
            <input
              type="text"
              placeholder="Search connection types..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-600 focus:border-transparent"
              autoFocus
            />
          </div>
          
          {/* Options */}
          <div className="overflow-y-auto max-h-72">
            {Object.entries(filteredGroups).length === 0 ? (
              <div className="p-4 text-center text-gray-500 text-sm">
                No connection types found
              </div>
            ) : (
              Object.entries(filteredGroups).map(([category, types]) => {
                const CategoryIcon = categoryIcons[category] || Cloud;
                return (
                  <div key={category}>
                    {/* Category Header */}
                    <div className="px-4 py-2 bg-gray-50 flex items-center gap-2">
                      <CategoryIcon className="h-4 w-4 text-gray-500" />
                      <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
                        {category}
                      </span>
                    </div>
                    
                    {/* Type Options */}
                    {types.map((type) => (
                      <button
                        key={type.id}
                        type="button"
                        onClick={() => handleSelect(type.id)}
                        className={`
                          w-full flex items-center gap-3 px-4 py-3
                          hover:bg-purple-50 transition-colors
                          ${value === type.id ? 'bg-purple-50' : ''}
                        `}
                      >
                        <div 
                          className={`w-10 h-10 ${type.colors.bg} rounded-lg flex items-center justify-center flex-shrink-0`}
                        >
                          <i className={`fas ${type.icon} ${type.colors.text} text-lg`}></i>
                        </div>
                        <div className="text-left flex-1 min-w-0">
                          <p className={`font-medium ${value === type.id ? 'text-purple-700' : 'text-gray-900'}`}>
                            {type.name}
                          </p>
                          <p className="text-xs text-gray-500 truncate">{type.description}</p>
                        </div>
                        {value === type.id && (
                          <div className="w-5 h-5 rounded-full bg-purple-500 flex items-center justify-center flex-shrink-0">
                            <i className="fas fa-check text-white text-xs"></i>
                          </div>
                        )}
                      </button>
                    ))}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default ConnectionTypeSelector;
