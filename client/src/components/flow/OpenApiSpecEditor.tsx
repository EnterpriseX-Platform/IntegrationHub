import { useState, useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { ChevronDown } from 'lucide-react';
import { specToOpenApiYaml } from '../../utils/YAMLGenerator';

interface OpenApiParameter {
  name: string;
  in: 'query' | 'path' | 'header';
  required: boolean;
  schema: { type: string };
  description?: string;
}

interface OpenApiOperation {
  id: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  path: string;
  summary: string;
  description?: string;
  parameters: OpenApiParameter[];
  requestBody?: {
    description?: string;
    content: Record<string, { schema: any }>;
  };
  responses: {
    code: string;
    description: string;
    content?: Record<string, { schema: any }>;
  }[];
}

export interface OpenApiSpec {
  openapi: string;
  info: {
    title: string;
    version: string;
    description?: string;
  };
  servers: { url: string }[];
  operations: OpenApiOperation[];
}

interface OpenApiSpecEditorProps {
  spec: OpenApiSpec;
  onChange: (spec: OpenApiSpec) => void;
  requireApiKey?: boolean;
}

const METHOD_COLORS: Record<string, string> = {
  GET: 'bg-blue-500',
  POST: 'bg-green-500',
  PUT: 'bg-yellow-500',
  DELETE: 'bg-red-500',
  PATCH: 'bg-purple-500',
};

const TYPE_LABELS: Record<string, string> = {
  string: 'String',
  integer: 'Integer',
  number: 'Number',
  boolean: 'Boolean',
  array: 'Array',
  object: 'Object',
};

// Custom Dropdown Component
// @ts-ignore
const CustomDropdown = ({
  value,
  options,
  onChange,
  width = 'w-32',
  renderOption,
  renderSelected,
}: {
  value: string;
  options: string[];
  onChange: (value: string) => void;
  width?: string;
  renderOption?: (opt: string) => React.ReactNode;
  renderSelected?: (val: string) => React.ReactNode;
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  return (
    <div className={`relative ${width}`} ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full h-10 px-3 bg-white border border-gray-200 rounded-lg hover:border-blue-400 hover:shadow-sm transition-all flex items-center justify-between"
      >
        <span className="text-sm">
          {renderSelected ? renderSelected(value) : TYPE_LABELS[value] || value}
        </span>
        <ChevronDown size={16} className={`text-gray-400 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <div className="absolute top-full left-0 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg z-50 overflow-hidden">
          {options.map((opt) => (
            <button
              key={opt}
              onClick={() => {
                onChange(opt);
                setIsOpen(false);
              }}
              className={`w-full px-3 py-2.5 text-left text-sm hover:bg-gray-50 transition-colors flex items-center gap-2 ${
                value === opt ? 'bg-blue-50 text-blue-700' : 'text-gray-700'
              }`}
            >
              {renderOption ? renderOption(opt) : (TYPE_LABELS[opt] || opt)}
              {value === opt && <i className="fas fa-check text-blue-500 text-xs ml-auto"></i>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

// Method Dropdown Component
const MethodDropdown = ({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const methods = Object.keys(METHOD_COLORS);

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={`h-9 px-3 rounded-lg font-bold text-white text-[14px] flex items-center gap-2 ${METHOD_COLORS[value]}`}
      >
        {value}
        <ChevronDown size={14} className={`transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <div className="absolute top-full left-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-50 overflow-hidden min-w-[100px]">
          {methods.map((method) => (
            <button
              key={method}
              onClick={() => {
                onChange(method);
                setIsOpen(false);
              }}
              className={`w-full px-4 py-2.5 text-left text-sm font-bold text-white flex items-center gap-2 hover:opacity-90 ${METHOD_COLORS[method]} ${
                value === method ? 'ring-2 ring-offset-1 ring-blue-400' : ''
              }`}
            >
              {method}
              {value === method && <i className="fas fa-check text-xs ml-auto"></i>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

// Simple Field Model
interface Field {
  name: string;
  type: string;
  required: boolean;
  description: string;
  items?: Field;
  properties?: Record<string, Field>;
}

// Convert Fields to OpenAPI Schema
const fieldsToSchema = (fields: Field[]): any => {
  if (!fields.length) return { type: 'object' };
  
  const properties: Record<string, any> = {};
  const required: string[] = [];
  
  fields.forEach(f => {
    const prop: any = { type: f.type };
    if (f.description) prop.description = f.description;
    
    if (f.type === 'array' && f.items) {
      prop.items = fieldToSchemaItem(f.items);
    } else if (f.type === 'object' && f.properties) {
      const nested = fieldsToSchema(Object.values(f.properties));
      prop.properties = nested.properties;
      if (nested.required?.length) prop.required = nested.required;
    }
    
    properties[f.name] = prop;
    if (f.required) required.push(f.name);
  });
  
  return { type: 'object', properties, required };
};

const fieldToSchemaItem = (f: Field): any => {
  const prop: any = { type: f.type };
  if (f.description) prop.description = f.description;
  if (f.type === 'array' && f.items) {
    prop.items = fieldToSchemaItem(f.items);
  } else if (f.type === 'object' && f.properties) {
    const nested = fieldsToSchema(Object.values(f.properties));
    prop.properties = nested.properties;
    if (nested.required?.length) prop.required = nested.required;
  }
  return prop;
};

const schemaToFields = (schema: any): Field[] => {
  if (!schema?.properties) return [];
  return Object.entries(schema.properties).map(([name, prop]: [string, any]) => ({
    name,
    type: prop.type || 'string',
    required: schema.required?.includes(name) || false,
    description: prop.description || '',
    items: prop.items ? {
      name: 'item',
      type: prop.items.type || 'object',
      required: false,
      description: prop.items.description || '',
      properties: prop.items.properties ? Object.fromEntries(
        Object.entries(prop.items.properties).map(([k, v]: [string, any]) => [
          k,
          { name: k, type: v.type || 'string', required: false, description: v.description || '' }
        ])
      ) : undefined,
    } : undefined,
    properties: prop.properties ? Object.fromEntries(
      Object.entries(prop.properties).map(([k, v]: [string, any]) => [
        k,
        { name: k, type: v.type || 'string', required: false, description: v.description || '' }
      ])
    ) : undefined,
  }));
};

// Field Editor Component
const FieldRow = ({
  field,
  onChange,
  onDelete,
  depth = 0,
}: {
  field: Field;
  onChange: (f: Field) => void;
  onDelete: () => void;
  depth?: number;
}) => {
  const [expanded, setExpanded] = useState(depth < 1);
  const isComplex = field.type === 'object' || field.type === 'array';
  const indent = depth * 24;

  return (
    <div className="group">
      <div 
        className="flex items-center gap-2 py-2 hover:bg-gray-50 rounded-lg px-2 -mx-2"
        style={{ marginLeft: indent }}
      >
        {/* Expand/Collapse */}
        {isComplex ? (
          <button
            onClick={() => setExpanded(!expanded)}
            className="w-6 h-6 flex items-center justify-center text-gray-400 hover:text-gray-600"
          >
            <i className={`fas fa-caret-${expanded ? 'down' : 'right'}`}></i>
          </button>
        ) : (
          <span className="w-6"></span>
        )}

        {/* Name */}
        <input
          type="text"
          value={field.name}
          onChange={(e) => onChange({ ...field, name: e.target.value })}
          className="flex-1 min-w-0 px-3 py-1.5 text-sm border rounded focus:ring-2 focus:ring-blue-500"
          placeholder="field name"
        />

        {/* Type */}
        <select
          value={field.type}
          onChange={(e) => {
            const type = e.target.value;
            const updates: any = { type };
            if (type === 'array' && !field.items) {
              updates.items = { name: 'item', type: 'string', required: false, description: '' };
            } else if (type === 'object' && !field.properties) {
              updates.properties = {};
            }
            onChange({ ...field, ...updates });
          }}
          className="w-28 px-2 py-1.5 text-sm border rounded bg-white"
        >
          {Object.entries(TYPE_LABELS).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>

        {/* Required Toggle */}
        <label className="flex items-center gap-1.5 px-2 py-1 cursor-pointer">
          <input
            type="checkbox"
            checked={field.required}
            onChange={(e) => onChange({ ...field, required: e.target.checked })}
            className="rounded"
          />
          <span className="text-xs text-gray-600">Req</span>
        </label>

        {/* Delete */}
        <button
          onClick={onDelete}
          className="p-1.5 text-gray-400 hover:text-red-500 opacity-0 group-hover:opacity-100"
        >
          <i className="fas fa-times"></i>
        </button>
      </div>

      {/* Description Row */}
      <div style={{ marginLeft: indent + 32, marginTop: -4 }} className="mb-2">
        <input
          type="text"
          value={field.description}
          onChange={(e) => onChange({ ...field, description: e.target.value })}
          className="w-full max-w-md px-3 py-1 text-xs text-gray-500 border rounded"
          placeholder="Description"
        />
      </div>

      {/* Nested Fields */}
      {expanded && isComplex && (
        <div className="mt-1 pb-2">
          {field.type === 'object' && (
            <div className="border-l-2 border-gray-200 ml-4 pl-4">
              {field.properties && Object.entries(field.properties).map(([key, prop]) => (
                <FieldRow
                  key={key}
                  field={prop}
                  onChange={(updated) => {
                    const props = { ...field.properties, [updated.name]: updated };
                    if (updated.name !== key) delete props[key];
                    onChange({ ...field, properties: props });
                  }}
                  onDelete={() => {
                    const props = { ...field.properties };
                    delete props[key];
                    onChange({ ...field, properties: props });
                  }}
                  depth={depth + 1}
                />
              ))}
              <button
                onClick={() => {
                  const props = { ...(field.properties || {}) };
                  const newKey = `field${Object.keys(props).length + 1}`;
                  props[newKey] = { name: newKey, type: 'string', required: false, description: '' };
                  onChange({ ...field, properties: props });
                }}
                className="text-xs text-blue-600 hover:text-blue-700 flex items-center gap-1 py-1"
              >
                <i className="fas fa-plus"></i> Add property
              </button>
            </div>
          )}

          {field.type === 'array' && field.items && (
            <div className="border-l-2 border-blue-200 ml-4 pl-4 bg-blue-50/50 rounded-r p-2">
              <span className="text-xs text-blue-600 font-medium mb-1 block">Array item type:</span>
              <FieldRow
                field={field.items}
                onChange={(items) => onChange({ ...field, items })}
                onDelete={() => {}}
                depth={depth + 1}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// Fields Section Editor
const FieldsSection = ({
  fields,
  onChange,
  title,
}: {
  fields: Field[];
  onChange: (fields: Field[]) => void;
  title?: string;
}) => {
  const addField = () => {
    onChange([...fields, { name: 'newField', type: 'string', required: false, description: '' }]);
  };

  const updateField = (idx: number, field: Field) => {
    const newFields = [...fields];
    newFields[idx] = field;
    onChange(newFields);
  };

  const removeField = (idx: number) => {
    onChange(fields.filter((_, i) => i !== idx));
  };

  return (
    <div className="space-y-1">
      {title && <p className="text-xs font-medium text-gray-500 mb-2">{title}</p>}
      {fields.length === 0 ? (
        <div className="p-4 text-center border-2 border-dashed border-gray-200 rounded-lg">
          <p className="text-gray-400 text-sm">No fields defined</p>
        </div>
      ) : (
        <>
          {fields.map((field, idx) => (
            <FieldRow
              key={idx}
              field={field}
              onChange={(f) => updateField(idx, f)}
              onDelete={() => removeField(idx)}
            />
          ))}
        </>
      )}
      <button
        onClick={addField}
        className="w-full py-2 border border-dashed border-gray-300 rounded-lg text-sm text-gray-500 hover:border-blue-400 hover:text-blue-600 transition-colors mt-2"
      >
        <i className="fas fa-plus mr-1"></i> Add Field
      </button>
    </div>
  );
};

// Code Editor Component (YAML Support) - View only with syntax highlighting
const CodeEditor = ({
  spec,
  viewMode,
  setViewMode,
  requireApiKey
}: {
  spec: OpenApiSpec;
  viewMode: 'form' | 'code';
  setViewMode: (mode: 'form' | 'code') => void;
  requireApiKey?: boolean;
}) => {
  // Convert internal spec format to standard OpenAPI YAML with 'paths'
  const generateYaml = (s: any): string => {
    return specToOpenApiYaml({
      openapi: s.openapi,
      info: s.info,
      servers: s.servers,
      operations: s.operations,
      requireApiKey,
    });
  };

  const [yamlText, setYamlText] = useState(generateYaml(spec));

  useEffect(() => {
    setYamlText(generateYaml(spec));
  }, [spec]);

  const handleChange = (value: string) => {
    setYamlText(value);
  };

  const formatYaml = () => {
    const formatted = generateYaml(spec);
    setYamlText(formatted);
  };

  const copyToClipboard = () => {
    navigator.clipboard.writeText(yamlText);
  };

  const lineCount = yamlText.split('\n').length;

  return (
    <div className="h-full flex flex-col bg-white">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b bg-gray-50 flex-shrink-0">
        <span className="font-medium text-gray-700">OpenAPI YAML Editor</span>
        <div className="flex items-center gap-2">
          {/* Form/Code Toggle */}
          <div className="flex bg-gray-100 rounded-lg p-1 h-9">
            <button
              onClick={() => setViewMode('form')}
              className={`px-3 h-8 text-[13px] rounded-lg flex items-center gap-1.5 transition-colors ${
                viewMode === 'form' 
                  ? 'bg-white text-gray-900 shadow-sm' 
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              <i className="fas fa-list-alt"></i> Form
            </button>
            <button
              onClick={() => setViewMode('code')}
              className={`px-3 h-8 text-[13px] rounded-lg flex items-center gap-1.5 transition-colors ${
                viewMode === 'code' 
                  ? 'bg-white text-gray-900 shadow-sm' 
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              <i className="fas fa-code"></i> Code
            </button>
          </div>
          <button
            onClick={copyToClipboard}
            className="h-9 px-3 text-[14px] bg-white border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 flex items-center gap-1.5"
            title="Copy to clipboard"
          >
            <i className="fas fa-copy"></i>
            <span className="hidden sm:inline">Copy</span>
          </button>
          <button
            onClick={formatYaml}
            className="h-9 px-3 text-[14px] bg-white border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 flex items-center gap-1.5"
          >
            <i className="fas fa-align-left"></i>
            <span className="hidden sm:inline">Format</span>
          </button>
        </div>
      </div>
      
      {/* Editor with Line Numbers - Scroll handled by parent */}
      <div className="flex">
        {/* Line Numbers */}
        <div className="w-12 bg-gray-50 border-r border-gray-200 text-right pr-2 select-none flex-shrink-0">
          {Array.from({ length: lineCount }, (_, i) => (
            <div key={i} className="text-xs text-gray-400 leading-6 h-6">
              {i + 1}
            </div>
          ))}
        </div>
        
        {/* Editor Textarea - No scroll, parent handles it */}
        <textarea
          value={yamlText}
          onChange={(e) => handleChange(e.target.value)}
          className="flex-1 p-2 font-mono text-sm text-gray-800 bg-white resize-none focus:outline-none block w-full overflow-hidden"
          spellCheck={false}
          rows={lineCount}
          style={{ 
            tabSize: 2, 
            fontFamily: 'Monaco, Menlo, Consolas, monospace',
            lineHeight: '1.5',
            minHeight: '100%'
          }}
        />
      </div>
    </div>
  );
};

// Main Component
export const OpenApiSpecEditor = ({ spec, onChange, requireApiKey }: OpenApiSpecEditorProps) => {
  const { projectId, flowId } = useParams();
  const [selectedOp, setSelectedOp] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'form' | 'code'>('form');


  // Operations
  const addOperation = () => {
    const newOp: OpenApiOperation = {
      id: `op-${Date.now()}`,
      method: 'GET',
      path: '/new-path',
      summary: 'New Endpoint',
      parameters: [],
      responses: [{ code: '200', description: 'OK' }],
    };
    onChange({ ...spec, operations: [...(spec.operations || []), newOp] });
    setSelectedOp(newOp.id);
  };

  const updateOperation = (id: string, updates: Partial<OpenApiOperation>) => {
    onChange({
      ...spec,
      operations: (spec.operations || []).map(op => op.id === id ? { ...op, ...updates } : op),
    });
  };

  const deleteOperation = (id: string) => {
    onChange({ ...spec, operations: (spec.operations || []).filter(op => op.id !== id) });
    if (selectedOp === id) {
      setSelectedOp(null);
    }
  };

  const currentOp = spec.operations?.find(o => o.id === selectedOp);

  // Helper: Get/Set body fields
  const getBodyFields = (): Field[] => {
    const schema = currentOp?.requestBody?.content?.['application/json']?.schema;
    return schemaToFields(schema);
  };

  const setBodyFields = (fields: Field[]) => {
    if (!currentOp) return;
    const schema = fieldsToSchema(fields);
    updateOperation(currentOp.id, {
      requestBody: {
        description: 'Request body',
        content: { 'application/json': { schema } }
      }
    });
  };

  // Helper: Get/Set response fields
  const getResponseFields = (idx: number): Field[] => {
    const schema = currentOp?.responses[idx]?.content?.['application/json']?.schema;
    return schemaToFields(schema);
  };

  const setResponseFields = (idx: number, fields: Field[]) => {
    if (!currentOp) return;
    const schema = fieldsToSchema(fields);
    const responses = [...(currentOp.responses || [])];
    responses[idx] = { ...responses[idx], content: { 'application/json': { schema } } };
    updateOperation(currentOp.id, { responses });
  };

  return (
    <div className="h-full flex">
      {/* Left Sidebar - Compact */}
      <div className="w-64 bg-gray-50 border-r flex flex-col">
        {/* API Info - Compact */}
        <div className="p-3 border-b bg-white">
          <input
            type="text"
            value={spec.info?.title || ''}
            onChange={(e) => onChange({ ...spec, info: { ...spec.info, title: e.target.value } })}
            className="w-full font-semibold bg-transparent border-0 p-0 focus:ring-0 placeholder-gray-400 text-sm"
            placeholder="API Title"
          />
          <div className="flex items-center gap-2 mt-1">
            <input
              type="text"
              value={spec.info?.version || '1.0.0'}
              onChange={(e) => onChange({ ...spec, info: { ...spec.info, version: e.target.value } })}
              className="w-16 text-xs text-gray-500 bg-transparent border-0 p-0 focus:ring-0"
              placeholder="1.0.0"
            />
            <span className="text-gray-300">|</span>
            <input
              type="text"
              value={spec.servers?.[0]?.url || ''}
              onChange={(e) => onChange({ ...spec, servers: [{ url: e.target.value }] })}
              className="flex-1 text-xs text-gray-500 bg-transparent border-0 p-0 focus:ring-0"
              placeholder="Base URL"
            />
          </div>
        </div>

        {/* Endpoints List */}
        <div className="flex-1 overflow-y-auto py-2">
          <div className="px-3 py-1 flex items-center justify-between">
            <span className="text-xs font-medium text-gray-500 uppercase">Endpoints</span>
            <button
              onClick={addOperation}
              className="text-xs text-blue-600 hover:text-blue-700"
            >
              <i className="fas fa-plus"></i>
            </button>
          </div>
          
          <div className="space-y-0.5 px-1">
            {spec.operations?.map(op => (
              <div
                key={op.id}
                onClick={() => {
                  setSelectedOp(op.id);
                  setViewMode('form');
                }}
                className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer text-sm ${
                  selectedOp === op.id 
                    ? 'bg-white text-blue-700 shadow-sm' 
                    : 'hover:bg-white text-gray-700'
                }`}
              >
                <span className={`px-1.5 py-0.5 text-[12px] font-bold text-white rounded ${METHOD_COLORS[op.method]}`}>
                  {op.method}
                </span>
                <span className="flex-1 truncate font-mono text-xs">{op.path}</span>
              </div>
            ))}
          </div>
        </div>


      </div>

      {/* Main Content */}
      <div className="flex-1 overflow-auto bg-white">
        {!currentOp ? (
          <div className="h-full flex items-center justify-center">
            <div className="text-center text-gray-400">
              <i className="fas fa-arrow-left text-3xl mb-4"></i>
              <p>Select an endpoint to edit</p>
            </div>
          </div>
        ) : (viewMode as string) === 'code' ? (
          <CodeEditor spec={spec} viewMode={viewMode} setViewMode={setViewMode} requireApiKey={requireApiKey} />
        ) : (
          <div className="min-h-full">
            <div className="max-w-5xl mx-auto">
              {/* Header with Toggle - Fixed height to match CodeEditor */}
              <div className="flex items-center justify-between px-6 py-3 border-b bg-gray-50">
                <div className="flex items-center gap-3">
                  {/* Method Dropdown - Custom */}
                  <MethodDropdown
                    value={currentOp.method}
                    onChange={(method) => updateOperation(currentOp.id, { method: method as any })}
                  />
                  <input
                    type="text"
                    value={currentOp.path}
                    onChange={(e) => updateOperation(currentOp.id, { path: e.target.value })}
                    className="h-9 px-3 font-mono text-sm border rounded-lg focus:ring-2 focus:ring-blue-500 w-80 bg-white"
                    placeholder="/path"
                  />
                </div>
                
                {/* Form/Code Toggle - Same styling as CodeEditor */}
                <div className="flex items-center gap-2">
                  <div className="flex bg-gray-100 rounded-lg p-1 h-9">
                    <button
                      onClick={() => setViewMode('form')}
                      className={`px-3 h-8 text-[13px] rounded-lg flex items-center gap-1.5 transition-colors ${
                        viewMode === 'form' 
                          ? 'bg-white text-gray-900 shadow-sm' 
                          : 'text-gray-500 hover:text-gray-700'
                      }`}
                    >
                      <i className="fas fa-list-alt"></i> Form
                    </button>
                    <button
                      onClick={() => setViewMode('code')}
                      className={`px-3 h-8 text-[13px] rounded-lg flex items-center gap-1.5 transition-colors ${
                        viewMode === 'code' 
                          ? 'bg-white text-gray-900 shadow-sm' 
                          : 'text-gray-500 hover:text-gray-700'
                      }`}
                    >
                      <i className="fas fa-code"></i> Code
                    </button>
                  </div>
                  <button
                    onClick={() => window.location.href = `/projects/${projectId}/flows/${flowId}/designer`}
                    className="h-9 px-3 bg-blue-500 text-white text-[14px] rounded-lg hover:bg-blue-600 flex items-center gap-1.5"
                  >
                    <i className="fas fa-project-diagram"></i>
                    <span className="hidden sm:inline">Flow</span>
                  </button>
                  <button
                    onClick={() => deleteOperation(currentOp.id)}
                    className="h-9 w-9 flex items-center justify-center text-red-500 hover:bg-red-50 rounded-lg"
                  >
                    <i className="fas fa-trash"></i>
                  </button>
                </div>
              </div>
              
              {/* Content */}
              <div className="p-6">
                
                <input
                  type="text"
                  value={currentOp.summary}
                  onChange={(e) => updateOperation(currentOp.id, { summary: e.target.value })}
                  className="w-full text-lg font-semibold border-0 p-0 focus:ring-0 placeholder-gray-400 mb-1"
                  placeholder="Operation summary"
                />
                <textarea
                  value={currentOp.description || ''}
                  onChange={(e) => updateOperation(currentOp.id, { description: e.target.value })}
                  className="w-full text-sm text-gray-600 border-0 p-0 resize-none focus:ring-0"
                  rows={1}
                  placeholder="Add a description..."
                />
              
            {/* Parameters Section -->
            <div className="mb-8">
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-medium text-gray-700 flex items-center gap-2">
                  <i className="fas fa-sliders-h text-blue-500"></i>
                  Parameters
                </h3>
                <button
                  onClick={() => updateOperation(currentOp.id, {
                    parameters: [...(currentOp.parameters || []), { name: 'param', in: 'query', required: false, schema: { type: 'string' } }]
                  })}
                  className="h-9 px-4 text-[14px] text-blue-600 hover:text-blue-700 font-medium hover:bg-blue-50 rounded-lg flex items-center gap-1.5 transition-colors"
                >
                  <i className="fas fa-plus"></i> Add Parameter
                </button>
              </div>
              
              {(currentOp.parameters || []).length === 0 ? (
                <p className="text-gray-400 text-sm py-2">No parameters defined</p>
              ) : (
                <div className="space-y-2">
                  {(currentOp.parameters || []).map((param, idx) => (
                    <div key={idx} className="flex items-center gap-3 py-2 border-b border-gray-100 last:border-0">
                      <input
                        type="text"
                        value={param.name}
                        onChange={(e) => {
                          const params = [...(currentOp.parameters || [])];
                          params[idx] = { ...param, name: e.target.value };
                          updateOperation(currentOp.id, { parameters: params });
                        }}
                        className="flex-1 h-10 px-4 border rounded-lg text-sm focus:ring-2 focus:ring-blue-500"
                        placeholder="name"
                      />
                      <CustomDropdown
                        value={param.in}
                        options={['query', 'path', 'header']}
                        onChange={(val) => {
                          const params = [...(currentOp.parameters || [])];
                          params[idx] = { ...param, in: val as any };
                          updateOperation(currentOp.id, { parameters: params });
                        }}
                        width="w-28"
                        renderSelected={(v) => v.charAt(0).toUpperCase() + v.slice(1)}
                        renderOption={(v) => v.charAt(0).toUpperCase() + v.slice(1)}
                      />
                      <CustomDropdown
                        value={param.schema.type}
                        options={['string', 'integer', 'number', 'boolean']}
                        onChange={(val) => {
                          const params = [...(currentOp.parameters || [])];
                          params[idx] = { ...param, schema: { type: val } };
                          updateOperation(currentOp.id, { parameters: params });
                        }}
                        width="w-28"
                      />
                      <label className="flex items-center gap-2 h-10 px-3 text-sm whitespace-nowrap cursor-pointer hover:bg-gray-50 rounded-lg">
                        <input
                          type="checkbox"
                          checked={param.required}
                          onChange={(e) => {
                            const params = [...(currentOp.parameters || [])];
                            params[idx] = { ...param, required: e.target.checked };
                            updateOperation(currentOp.id, { parameters: params });
                          }}
                          className="w-4 h-4 rounded text-blue-600"
                        />
                        <span className="text-gray-600">Required</span>
                      </label>
                      <button
                        onClick={() => updateOperation(currentOp.id, {
                          parameters: (currentOp.parameters || []).filter((_, i) => i !== idx)
                        })}
                        className="h-10 w-10 flex items-center justify-center text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
                      >
                        <i className="fas fa-times"></i>
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Request Body Section */}
            <div className="mb-8">
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-medium text-gray-700 flex items-center gap-2">
                  <i className="fas fa-envelope text-green-500"></i>
                  Request Body
                </h3>
                {!currentOp.requestBody ? (
                  <button
                    onClick={() => updateOperation(currentOp.id, {
                      requestBody: { content: { 'application/json': { schema: { type: 'object' } } } }
                    })}
                    className="h-9 px-4 text-[14px] text-green-600 hover:text-green-700 font-medium hover:bg-green-50 rounded-lg flex items-center gap-1.5 transition-colors"
                  >
                    <i className="fas fa-plus"></i> Add Body
                  </button>
                ) : (
                  <button
                    onClick={() => updateOperation(currentOp.id, { requestBody: undefined })}
                    className="h-9 px-4 text-[14px] text-red-500 hover:text-red-700 hover:bg-red-50 rounded-lg transition-colors"
                  >
                    Remove Body
                  </button>
                )}
              </div>
              {currentOp.requestBody && (
                <div className="p-6">
                  <FieldsSection
                    fields={getBodyFields()}
                    onChange={setBodyFields}
                  />
                </div>
              )}
            </div>

            {/* Responses Section */}
            <div>
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-medium text-gray-700 flex items-center gap-2">
                  <i className="fas fa-reply text-purple-500"></i>
                  Responses
                </h3>
                <button
                  onClick={() => updateOperation(currentOp.id, {
                    responses: [...(currentOp.responses || []), { 
                      code: '200', 
                      description: 'OK',
                      content: { 'application/json': { schema: { type: 'object' } } }
                    }]
                  })}
                  className="h-9 px-4 text-[14px] text-purple-600 hover:text-purple-700 font-medium hover:bg-purple-50 rounded-lg flex items-center gap-1.5 transition-colors"
                >
                  <i className="fas fa-plus"></i> Add Response
                </button>
              </div>
              
              <div className="space-y-4">
                {(currentOp.responses || []).map((resp, idx) => {
                  const schema = resp.content?.['application/json']?.schema;
                  const responseType = schema?.type || 'object';
                  
                  return (
                    <div key={idx} className="border rounded-lg p-4">
                      <div className="flex items-center gap-3 mb-4">
                        <input
                          type="text"
                          value={resp.code}
                          onChange={(e) => {
                            const responses = [...(currentOp.responses || [])];
                            responses[idx] = { ...resp, code: e.target.value };
                            updateOperation(currentOp.id, { responses });
                          }}
                          className="w-24 h-10 px-4 text-sm font-mono border rounded-lg focus:ring-2 focus:ring-blue-500"
                        />
                        <input
                          type="text"
                          value={resp.description}
                          onChange={(e) => {
                            const responses = [...(currentOp.responses || [])];
                            responses[idx] = { ...resp, description: e.target.value };
                            updateOperation(currentOp.id, { responses });
                          }}
                          className="flex-1 h-10 px-4 text-sm border rounded-lg focus:ring-2 focus:ring-blue-500"
                          placeholder="Description"
                        />
                        <button
                          onClick={() => updateOperation(currentOp.id, {
                            responses: (currentOp.responses || []).filter((_, i) => i !== idx)
                          })}
                          className="h-10 w-10 flex items-center justify-center text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
                        >
                          <i className="fas fa-trash"></i>
                        </button>
                      </div>
                      
                      {/* Response Data Type Selector */}
                      <div className="flex flex-wrap items-center gap-3 mb-4 p-3 bg-gray-50 rounded-lg">
                        <span className="text-sm font-medium text-gray-700">Type:</span>
                        <div className="flex gap-2">
                          <button
                            onClick={() => {
                              const responses = [...(currentOp.responses || [])];
                              responses[idx] = { 
                                ...resp, 
                                content: { 
                                  'application/json': { 
                                    schema: { type: 'object', properties: {} } 
                                  } 
                                } 
                              };
                              updateOperation(currentOp.id, { responses });
                            }}
                            className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
                              responseType === 'object' 
                                ? 'bg-blue-500 text-white' 
                                : 'bg-white border hover:bg-gray-50'
                            }`}
                          >
                            <i className="fas fa-cube mr-1"></i> Object {'{}'}
                          </button>
                          <button
                            onClick={() => {
                              const responses = [...(currentOp.responses || [])];
                              responses[idx] = { 
                                ...resp, 
                                content: { 
                                  'application/json': { 
                                    schema: { 
                                      type: 'array', 
                                      items: { type: 'object', properties: {} }
                                    } 
                                  } 
                                } 
                              };
                              updateOperation(currentOp.id, { responses });
                            }}
                            className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
                              responseType === 'array' 
                                ? 'bg-blue-500 text-white' 
                                : 'bg-white border hover:bg-gray-50'
                            }`}
                          >
                            <i className="fas fa-list mr-1"></i> Array []
                          </button>
                        </div>
                        <span className="text-gray-300">|</span>
                        <span className="text-xs text-gray-500">Presets:</span>
                        <button
                          onClick={() => {
                            const responses = [...(currentOp.responses || [])];
                            responses[idx] = { 
                              ...resp, 
                              content: { 
                                'application/json': { 
                                  schema: {
                                    type: 'object',
                                    properties: {
                                      data: { 
                                        type: 'array', 
                                        items: { type: 'object', properties: {} }
                                      },
                                      total: { type: 'integer' }
                                    }
                                  }
                                } 
                              } 
                            };
                            updateOperation(currentOp.id, { responses });
                          }}
                          className="text-xs px-2 py-1 bg-purple-100 text-purple-700 hover:bg-purple-200 rounded"
                        >
                          <i className="fas fa-layer-group mr-1"></i>{"{ data: [], total }"}
                        </button>
                      </div>
                      
                      {/* Schema Fields Editor */}
                      {responseType === 'array' ? (
                        <div className="border-l-2 border-blue-200 pl-4">
                          <FieldsSection
                            title="Array Item Schema:"
                            fields={schema?.items ? schemaToFields(schema.items) : []}
                            onChange={(fields) => {
                              const responses = [...(currentOp.responses || [])];
                              responses[idx] = { 
                                ...resp, 
                                content: { 
                                  'application/json': { 
                                    schema: { 
                                      type: 'array', 
                                      items: fieldsToSchema(fields)
                                    } 
                                  } 
                                } 
                              };
                              updateOperation(currentOp.id, { responses });
                            }}
                          />
                        </div>
                      ) : (
                        <div className="space-y-4">
                          {/* Object Fields */}
                          <FieldsSection
                            title="Object Fields:"
                            fields={getResponseFields(idx)}
                            onChange={(fields) => setResponseFields(idx, fields)}
                          />
                          
                          {/* Array Item Fields (if has array field) */}
                          {schema?.properties && Object.entries(schema.properties).map(([fieldName, fieldSchema]: [string, any]) => {
                            if (fieldSchema.type === 'array' && fieldSchema.items?.type === 'object') {
                              return (
                                <div key={fieldName} className="border-l-2 border-purple-200 pl-4 mt-4">
                                  <FieldsSection
                                    title={`${fieldName}[] item fields:`}
                                    fields={schemaToFields(fieldSchema.items)}
                                    onChange={(fields) => {
                                      const responses = [...(currentOp.responses || [])];
                                      const newProps = { ...schema.properties };
                                      newProps[fieldName] = {
                                        ...fieldSchema,
                                        items: fieldsToSchema(fields)
                                      };
                                      responses[idx] = { 
                                        ...resp, 
                                        content: { 
                                          'application/json': { 
                                            schema: { 
                                              type: 'object', 
                                              properties: newProps
                                            } 
                                          } 
                                        } 
                                      };
                                      updateOperation(currentOp.id, { responses });
                                    }}
                                  />
                                </div>
                              );
                            }
                            return null;
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
            </div>{/* Close content div */}
          </div>
          </div>
        )}
      </div>


    </div>
  );
};

export default OpenApiSpecEditor;
