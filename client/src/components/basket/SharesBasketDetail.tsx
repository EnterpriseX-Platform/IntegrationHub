import { useState } from 'react';
import {
  X, ArrowLeft
} from 'lucide-react';
import { API_URL, apiFetch } from '../../config/api';
import { ShareFolderExplorer } from '../../pages/FileExplorer';

interface Project {
  id: string;
  name: string;
  color: string;
}

interface Basket {
  id: string;
  name: string;
  description: string | null;
  type: 'batch' | 'shares' | 'sftp';
  projectId: string;
  path: string;
  createdAt: string;
}

interface SharesBasketDetailProps {
  basket: Basket;
  project: Project;
  onBack: () => void;
  isSharedReadOnly?: boolean;
}


// Project Dropdown Component
export const SharesBasketDetail = ({ basket, onBack, isSharedReadOnly = false }: SharesBasketDetailProps) => {
  const canWrite = !isSharedReadOnly;
  const [isEditingBasketDetail, setIsEditingBasketDetail] = useState(false);
  const [editBasketDetailName, setEditBasketDetailName] = useState('');
  const [editBasketDetailDesc, setEditBasketDetailDesc] = useState('');

  const startEditingBasketDetail = () => {
    setIsEditingBasketDetail(true);
    setEditBasketDetailName(basket.name);
    setEditBasketDetailDesc(basket.description || '');
  };

  const cancelEditingBasketDetail = () => {
    setIsEditingBasketDetail(false);
    setEditBasketDetailName(basket.name);
    setEditBasketDetailDesc(basket.description || '');
  };

  const saveBasketDetailChanges = async () => {
    if (!editBasketDetailName.trim()) return;
    try {
      const response = await apiFetch(`${API_URL}/baskets/${basket.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: editBasketDetailName.trim(),
          description: editBasketDetailDesc.trim()
        })
      });
      
      const result = await response.json();
      if (result.success) {
        basket.name = editBasketDetailName.trim();
        basket.description = editBasketDetailDesc.trim();
        setIsEditingBasketDetail(false);
      }
    } catch (error) {
      console.error('Error updating basket:', error);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl w-full max-w-5xl h-[85vh] flex flex-col">
        {/* Modal Header with Inline Editing */}
        <div className="px-5 py-3 border-b border-gray-200 flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-3 flex-1 min-w-0">
            <button
              onClick={onBack}
              className="p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg flex-shrink-0"
            >
              <ArrowLeft className="h-5 w-5" />
            </button>
            <div className="flex-1 min-w-0">
              {/* Basket Name - Inline Edit */}
              <div className="flex items-center gap-2">
                {isEditingBasketDetail ? (
                  <input
                    type="text"
                    value={editBasketDetailName}
                    onChange={(e) => setEditBasketDetailName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') saveBasketDetailChanges();
                      if (e.key === 'Escape') cancelEditingBasketDetail();
                    }}
                    className="text-lg font-semibold text-gray-900 outline-none border-b-2 border-blue-500 bg-transparent px-0 py-0 w-full max-w-xl"
                    autoFocus
                  />
                ) : (
                  <h2 
                    className="text-lg font-semibold text-gray-900 cursor-text hover:text-blue-600 transition-colors"
                    onClick={startEditingBasketDetail}
                    title="Click to edit"
                  >
                    {basket.name}
                  </h2>
                )}
              </div>
              
              {/* Basket Description - Inline Edit */}
              <div className="mt-1">
                {isEditingBasketDetail ? (
                  <input
                    type="text"
                    value={editBasketDetailDesc}
                    onChange={(e) => setEditBasketDetailDesc(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') saveBasketDetailChanges();
                      if (e.key === 'Escape') cancelEditingBasketDetail();
                    }}
                    className="text-sm text-gray-600 outline-none border-b-2 border-blue-500 bg-transparent px-0 py-0 w-full max-w-xl"
                    placeholder="Add description..."
                  />
                ) : (
                  <p 
                    className={`text-sm cursor-text hover:text-blue-600 transition-colors ${basket.description ? 'text-gray-600' : 'text-gray-400 italic'}`}
                    onClick={startEditingBasketDetail}
                    title="Click to edit"
                  >
                    {basket.description || 'Add description...'}
                  </p>
                )}
              </div>
              
              {/* Edit Actions */}
              {isEditingBasketDetail && (
                <div className="flex items-center gap-2 mt-2">
                  <button
                    onClick={saveBasketDetailChanges}
                    disabled={!editBasketDetailName.trim()}
                    className="inline-flex items-center justify-center text-[13px] px-2 h-8 rounded disabled:opacity-50 whitespace-nowrap bg-blue-600 text-white hover:bg-blue-700"
                  >
                    Save
                  </button>
                  <button
                    onClick={cancelEditingBasketDetail}
                    className="inline-flex items-center justify-center h-9 px-3 text-[14px] font-medium border border-gray-300 bg-white text-gray-700 rounded-lg hover:bg-gray-50 transition-colors whitespace-nowrap"
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>
          </div>
          <button onClick={onBack} className="p-2 text-gray-400 hover:text-gray-600 ml-4 flex-shrink-0">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Same folder view as the File Explorer; who sees it follows the project's access */}
        <div className="flex-1 overflow-hidden">
          <ShareFolderExplorer basket={{ id: basket.id, name: basket.name }} readOnly={!canWrite} embedded />
        </div>
      </div>

    </div>
  );
};
