import { useState } from 'react';
import { PlusIcon, MagnifyingGlassIcon, DocumentTextIcon } from '../components/icons';
import type { ApiSpec } from '../types';

function ArrowDownTrayIconCustom(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" {...props}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
    </svg>
  );
}

const mockApiSpecs: ApiSpec[] = [
  {
    id: '1',
    projectId: '1',
    name: 'E-commerce API',
    version: '1.0.0',
    format: 'openapi',
    content: '',
    parsed: {
      openapi: '3.0.0',
      info: { title: 'E-commerce API', version: '1.0.0' },
      paths: {},
    },
    createdAt: new Date('2024-01-15'),
    updatedAt: new Date('2024-01-20'),
  },
  {
    id: '2',
    projectId: '1',
    name: 'Payment Gateway',
    version: '2.1.0',
    format: 'swagger',
    content: '',
    parsed: {
      openapi: '2.0',
      info: { title: 'Payment Gateway', version: '2.1.0' },
      paths: {},
    },
    createdAt: new Date('2024-01-12'),
    updatedAt: new Date('2024-01-18'),
  },
  {
    id: '3',
    projectId: '2',
    name: 'Analytics GraphQL',
    version: '1.0.0',
    format: 'graphql',
    content: '',
    parsed: {
      schema: '',
      types: [],
      queries: [],
      mutations: [],
      subscriptions: [],
    },
    createdAt: new Date('2024-01-10'),
    updatedAt: new Date('2024-01-15'),
  },
];

const formatLabels: Record<string, string> = {
  openapi: 'OpenAPI 3.0',
  swagger: 'Swagger 2.0',
  graphql: 'GraphQL',
  asyncapi: 'AsyncAPI',
  custom: 'Custom',
};

export default function ApiSpecs() {
  const [searchQuery, setSearchQuery] = useState('');

  const filteredSpecs = mockApiSpecs.filter((spec) =>
    spec.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">API Specifications</h1>
          <p className="mt-1 text-sm text-gray-500">Manage API specs for your integrations</p>
        </div>
        <button className="btn-primary flex items-center">
          <PlusIcon className="w-5 h-5 mr-2" />
          Import Spec
        </button>
      </div>

      {/* Search */}
      <div className="relative max-w-md">
        <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
          <MagnifyingGlassIcon className="h-5 w-5 text-gray-400" />
        </div>
        <input
          type="text"
          placeholder="Search API specs..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="block w-full pl-10 pr-3 py-2 border border-gray-300 rounded-md leading-5 bg-white placeholder-gray-500 focus:outline-none focus:placeholder-gray-400 focus:ring-1 focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
        />
      </div>

      {/* API Specs Grid */}
      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {filteredSpecs.map((spec) => (
          <div key={spec.id} className="card hover:shadow-md transition-shadow">
            <div className="p-6">
              <div className="flex items-start">
                <div className="flex-shrink-0">
                  <div className="w-10 h-10 bg-purple-100 rounded-lg flex items-center justify-center">
                    <DocumentTextIcon className="w-5 h-5 text-purple-600" />
                  </div>
                </div>
                <div className="ml-4 flex-1">
                  <h3 className="text-lg font-medium text-gray-900">{spec.name}</h3>
                  <p className="text-sm text-gray-500">Version {spec.version}</p>
                </div>
              </div>
              
              <div className="mt-4">
                <span className="inline-flex items-center px-2.5 py-0.5 rounded-md text-xs font-medium bg-gray-100 text-gray-800">
                  {formatLabels[spec.format]}
                </span>
              </div>
              
              <div className="mt-4 pt-4 border-t border-gray-200 flex justify-between items-center">
                <span className="text-xs text-gray-400">
                  Updated {spec.updatedAt.toLocaleString('en-GB', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}
                </span>
                <div className="flex space-x-2">
                  <button className="p-2 text-gray-400 hover:text-gray-600" title="Download">
                    <ArrowDownTrayIconCustom className="w-4 h-4" />
                  </button>
                  <button className="text-sm text-primary-600 hover:text-primary-700 font-medium">
                    View
                  </button>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
