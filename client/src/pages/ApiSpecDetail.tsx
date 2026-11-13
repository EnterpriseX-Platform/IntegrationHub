import React, { useState } from 'react';
import FlowCanvas from '../components/flow/FlowCanvas';

interface ApiSpecDetailProps {
  projectId?: string;
  onBack?: () => void;
}

export const ApiSpecDetail: React.FC<ApiSpecDetailProps> = ({ onBack }) => {
  const [isRunning, setIsRunning] = useState(false);

  const handleTestApi = () => {
    setIsRunning(true);
    setTimeout(() => {
      setIsRunning(false);
    }, 2000);
  };

  const handleShowSwagger = () => {
    // Swagger docs modal would be shown here
    console.log('Show Swagger UI');
  };

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <button
              onClick={onBack}
              className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
            >
              <i className="fas fa-arrow-left text-gray-500"></i>
            </button>
            <div>
              <div className="flex items-center gap-2">
                <span className="method-badge method-get">GET</span>
                <h1 className="text-lg font-semibold text-gray-900">/api/v1/employees/list</h1>
                <span className="px-2 py-0.5 bg-green-100 text-green-700 text-xs rounded-full">Active</span>
              </div>
              <p className="text-sm text-gray-500">Get list of employees from SRC_A system</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleShowSwagger}
              className="inline-flex items-center justify-center px-3 h-9 border border-gray-300 rounded-lg text-[14px] hover:bg-gray-50 transition-colors whitespace-nowrap"
            >
              <i className="fas fa-book mr-2"></i>Swagger UI
            </button>
            <button className="inline-flex items-center justify-center px-3 h-9 border border-gray-300 rounded-lg text-[14px] hover:bg-gray-50 transition-colors whitespace-nowrap">
              <i className="fas fa-save mr-2"></i>Save
            </button>
            <button
              onClick={handleTestApi}
              disabled={isRunning}
              className="inline-flex items-center justify-center px-3 h-9 rounded-lg text-[14px] font-medium transition-colors whitespace-nowrap bg-blue-600 text-white hover:bg-blue-700"
            >
              {isRunning ? (
                <><i className="fas fa-spinner fa-spin mr-2"></i>Running...</>
              ) : (
                <><i className="fas fa-play mr-2"></i>Test API</>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left Sidebar - OpenAPI Spec */}
        <div className="w-96 bg-white border-r border-gray-200 flex flex-col overflow-auto">
          <div className="p-4 border-b border-gray-200">
            <h3 className="font-semibold text-gray-900 flex items-center gap-2">
              <i className="fas fa-code text-indigo-500"></i> OpenAPI Spec
            </h3>
          </div>
          <div className="p-4 space-y-4">
            {/* Base URL */}
            <div>
              <label className="text-xs font-medium text-gray-500 uppercase">Base URL</label>
              <div className="mt-1 px-3 py-2 bg-gray-100 rounded-lg text-sm font-mono">
                https://api.example.com
              </div>
            </div>

            {/* Endpoints */}
            <div>
              <label className="text-xs font-medium text-gray-500 uppercase mb-2 block">Endpoints</label>
              <div className="border border-gray-200 rounded-lg overflow-hidden">
                <div className="flex items-center gap-2 px-3 py-2 bg-gray-50 border-b border-gray-200">
                  <span className="method-badge method-get">GET</span>
                  <span className="text-sm font-mono">/api/v1/employees/list</span>
                </div>
                <div className="p-3">
                  <p className="text-sm text-gray-600 mb-2">Get list of employees</p>
                  
                  {/* Parameters */}
                  <div className="mb-3">
                    <span className="text-xs font-medium text-gray-500">Parameters</span>
                    <div className="mt-1 space-y-1">
                      <div className="flex items-center gap-2 text-sm">
                        <span className="text-blue-600 font-mono">department</span>
                        <span className="text-gray-400">string</span>
                        <span className="text-gray-400">(optional)</span>
                      </div>
                      <div className="flex items-center gap-2 text-sm">
                        <span className="text-blue-600 font-mono">limit</span>
                        <span className="text-gray-400">integer</span>
                        <span className="text-gray-400">(optional)</span>
                      </div>
                    </div>
                  </div>

                  {/* Responses */}
                  <div>
                    <span className="text-xs font-medium text-gray-500">Responses</span>
                    <div className="mt-1">
                      <div className="flex items-center gap-2 text-sm">
                        <span className="text-green-600">200</span>
                        <span className="text-gray-600">Success</span>
                      </div>
                      <pre className="mt-1 bg-gray-900 text-gray-100 p-2 rounded text-xs overflow-x-auto">
                        {`{ "employees": [...], "total": 100 }`}
                      </pre>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Authentication */}
            <div>
              <label className="text-xs font-medium text-gray-500 uppercase mb-2 block">Authentication</label>
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
                <div className="flex items-center gap-2 mb-2">
                  <i className="fas fa-lock text-amber-600"></i>
                  <span className="text-sm font-medium text-amber-800">API Key Required</span>
                </div>
                <p className="text-xs text-amber-700">Include X-API-Key header in all requests</p>
              </div>
            </div>
          </div>
        </div>

        {/* Right Side - Flow Designer */}
        <div className="flex-1 flex flex-col">
          <div className="bg-gray-100 px-4 py-2 border-b border-gray-200 flex items-center gap-2">
            <span className="text-sm font-medium text-gray-700">
              <i className="fas fa-project-diagram mr-2"></i>Flow Designer
            </span>
            <span className="text-xs text-gray-500">- Design the flow that executes when API is called</span>
          </div>
          <FlowCanvas operationId="api-spec" initialNodes={[]} initialEdges={[]} onChange={() => {}} nodeTypes={[]} />
        </div>
      </div>
    </div>
  );
};

export default ApiSpecDetail;
