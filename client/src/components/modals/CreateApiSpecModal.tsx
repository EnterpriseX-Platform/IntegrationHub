import React, { useState } from 'react';

interface Endpoint {
  id: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  description: string;
}

interface CreateApiSpecModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (data: {
    name: string;
    basePath: string;
    description: string;
    endpoints: Endpoint[];
  }) => void;
}

export const CreateApiSpecModal: React.FC<CreateApiSpecModalProps> = ({
  isOpen,
  onClose,
  onCreate,
}) => {
  const [name, setName] = useState('');
  const [basePath, setBasePath] = useState('');
  const [description, setDescription] = useState('');
  const [endpoints, setEndpoints] = useState<Endpoint[]>([
    { id: '1', method: 'GET', path: '/list', description: 'Get list of items' },
  ]);

  if (!isOpen) return null;

  const addEndpoint = () => {
    const newEndpoint: Endpoint = {
      id: Date.now().toString(),
      method: 'POST',
      path: '',
      description: '',
    };
    setEndpoints([...endpoints, newEndpoint]);
  };

  const removeEndpoint = (id: string) => {
    setEndpoints(endpoints.filter((e) => e.id !== id));
  };

  const updateEndpoint = (id: string, field: keyof Endpoint, value: string) => {
    setEndpoints(
      endpoints.map((e) => (e.id === id ? { ...e, [field]: value } : e))
    );
  };

  const handleCreate = () => {
    onCreate({ name, basePath, description, endpoints });
    // Reset form
    setName('');
    setBasePath('');
    setDescription('');
    setEndpoints([{ id: '1', method: 'GET', path: '/list', description: 'Get list of items' }]);
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl w-full max-w-3xl mx-4 max-h-[90vh] overflow-auto">
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between sticky top-0 bg-white">
          <div>
            <h2 className="text-xl font-semibold text-gray-900">Create API Spec Flow</h2>
            <p className="text-sm text-gray-500">Define your API endpoint and OpenAPI specification</p>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
          >
            <i className="fas fa-times text-gray-500"></i>
          </button>
        </div>

        {/* Content */}
        <div className="p-6">
          {/* API Information */}
          <div className="mb-6">
            <h3 className="text-sm font-semibold text-gray-700 uppercase mb-3">API Information</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">API Name</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g., Get Employee Data"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Base Path</label>
                <input
                  type="text"
                  value={basePath}
                  onChange={(e) => setBasePath(e.target.value)}
                  placeholder="e.g., /api/v1/employees"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
            </div>
            <div className="mt-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Describe what this API does..."
                rows={2}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>
          </div>

          {/* Endpoints */}
          <div className="mb-6">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-gray-700 uppercase">Endpoints</h3>
              <button
                onClick={addEndpoint}
                className="text-sm text-blue-600 hover:text-blue-700 transition-colors"
              >
                <i className="fas fa-plus mr-1"></i>Add Endpoint
              </button>
            </div>
            <div className="space-y-3">
              {endpoints.map((endpoint) => (
                <div key={endpoint.id} className="endpoint-row border border-gray-200 rounded-lg p-4">
                  <div className="grid grid-cols-12 gap-4 items-start">
                    <div className="col-span-2">
                      <select
                        value={endpoint.method}
                        onChange={(e) =>
                          updateEndpoint(endpoint.id, 'method', e.target.value)
                        }
                        className="w-full px-2 py-2 border border-gray-300 rounded-lg text-sm font-medium focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                      >
                        <option value="GET">GET</option>
                        <option value="POST">POST</option>
                        <option value="PUT">PUT</option>
                        <option value="DELETE">DELETE</option>
                      </select>
                    </div>
                    <div className="col-span-4">
                      <input
                        type="text"
                        value={endpoint.path}
                        onChange={(e) =>
                          updateEndpoint(endpoint.id, 'path', e.target.value)
                        }
                        placeholder="/endpoint"
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                      />
                    </div>
                    <div className="col-span-5">
                      <input
                        type="text"
                        value={endpoint.description}
                        onChange={(e) =>
                          updateEndpoint(endpoint.id, 'description', e.target.value)
                        }
                        placeholder="Description"
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                      />
                    </div>
                    <div className="col-span-1 text-right">
                      <button
                        onClick={() => removeEndpoint(endpoint.id)}
                        className="p-2 text-red-500 hover:text-red-700 transition-colors"
                      >
                        <i className="fas fa-trash"></i>
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Flow Implementation */}
          <div className="mb-6">
            <h3 className="text-sm font-semibold text-gray-700 uppercase mb-3">Flow Implementation</h3>
            <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
              <p className="text-sm text-gray-500 mb-3">
                After creating the API spec, you will design the flow that executes when this API is called.
              </p>
              <div className="flex items-center gap-4 flex-wrap">
                <div className="flex items-center gap-2 px-4 py-2 bg-indigo-100 rounded-lg">
                  <i className="fas fa-arrow-right text-indigo-500"></i>
                  <span className="text-sm font-medium text-indigo-700">API Request</span>
                </div>
                <i className="fas fa-arrow-right text-gray-400"></i>
                <div className="flex items-center gap-2 px-4 py-2 bg-blue-100 rounded-lg">
                  <i className="fas fa-project-diagram text-blue-500"></i>
                  <span className="text-sm font-medium text-blue-700">Flow Logic</span>
                </div>
                <i className="fas fa-arrow-right text-gray-400"></i>
                <div className="flex items-center gap-2 px-4 py-2 bg-green-100 rounded-lg">
                  <i className="fas fa-arrow-left text-green-500"></i>
                  <span className="text-sm font-medium text-green-700">API Response</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-200 flex items-center justify-end gap-3 sticky bottom-0 bg-white">
          <button
            onClick={onClose}
            className="inline-flex items-center justify-center px-3 h-9 border border-gray-300 rounded-lg text-[14px] hover:bg-gray-50 transition-colors whitespace-nowrap"
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            className="inline-flex items-center justify-center px-3 h-9 rounded-lg text-[14px] font-medium transition-colors whitespace-nowrap bg-blue-600 text-white hover:bg-blue-700"
          >
            Create API Spec & Design Flow
          </button>
        </div>
      </div>
    </div>
  );
};

export default CreateApiSpecModal;
