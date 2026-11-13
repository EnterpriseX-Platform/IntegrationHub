import { useParams } from 'react-router-dom';
import { ChevronRightIcon, PlayIcon } from '../components/icons';

// Simple SVG icons since Heroicons might not be available
function SaveIconCustom(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" {...props}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" />
    </svg>
  );
}

export default function FlowEditor() {
  const { id, flowId } = useParams<{ id: string; flowId: string }>();

  return (
    <div className="h-[calc(100vh-6rem)] flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center space-x-2 text-sm text-gray-500">
          <span>Projects</span>
          <ChevronRightIcon className="w-4 h-4" />
          <span>{id}</span>
          <ChevronRightIcon className="w-4 h-4" />
          <span className="text-gray-900 font-medium">{flowId}</span>
        </div>
        <div className="flex space-x-3">
          <button className="btn-secondary flex items-center">
            <SaveIconCustom className="w-4 h-4 mr-2" />
            Save
          </button>
          <button className="btn-primary flex items-center">
            <PlayIcon className="w-4 h-4 mr-2" />
            Test
          </button>
        </div>
      </div>

      {/* Toolbar */}
      <div className="card p-3 mb-4 flex items-center space-x-4">
        <span className="text-sm font-medium text-gray-700">Add Node:</span>
        {['Trigger', 'Action', 'Condition', 'Transform', 'Delay'].map((node) => (
          <button
            key={node}
            className="inline-flex items-center justify-center px-3 h-9 text-[14px] bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors whitespace-nowrap"
          >
            {node}
          </button>
        ))}
      </div>

      {/* Canvas */}
      <div className="flex-1 card bg-gray-50 relative overflow-hidden">
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="text-center">
            <div className="w-16 h-16 bg-primary-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <PlayIcon className="w-8 h-8 text-primary-500" />
            </div>
            <h3 className="text-lg font-medium text-gray-900">Flow Editor</h3>
            <p className="text-sm text-gray-500 mt-1">Drag and drop nodes to build your integration flow</p>
          </div>
        </div>
        
        {/* Sample nodes for visual reference */}
        <div className="absolute top-8 left-1/2 transform -translate-x-1/2">
          <div className="bg-white border-2 border-primary-500 rounded-lg px-4 py-3 shadow-sm w-48">
            <div className="flex items-center">
              <div className="w-3 h-3 bg-green-500 rounded-full mr-2" />
              <span className="text-sm font-medium">Webhook Trigger</span>
            </div>
          </div>
        </div>
        
        <div className="absolute top-28 left-1/2 transform -translate-x-1/2">
          <div className="bg-white border border-gray-300 rounded-lg px-4 py-3 shadow-sm w-48">
            <div className="flex items-center">
              <div className="w-3 h-3 bg-blue-500 rounded-full mr-2" />
              <span className="text-sm font-medium">Transform Data</span>
            </div>
          </div>
        </div>
        
        <div className="absolute top-48 left-1/2 transform -translate-x-1/2">
          <div className="bg-white border border-gray-300 rounded-lg px-4 py-3 shadow-sm w-48">
            <div className="flex items-center">
              <div className="w-3 h-3 bg-purple-500 rounded-full mr-2" />
              <span className="text-sm font-medium">API Call</span>
            </div>
          </div>
        </div>
      </div>

      {/* Properties Panel */}
      <div className="card p-4 mt-4">
        <h3 className="text-sm font-medium text-gray-900 mb-3">Properties</h3>
        <p className="text-sm text-gray-500">Select a node to edit its properties</p>
      </div>
    </div>
  );
}
