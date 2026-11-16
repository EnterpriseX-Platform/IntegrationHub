import { useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { ComposedModal, ModalHeader, ModalBody, IconButton, TextInput } from '@carbon/react';
import { Button } from '../ui/Button';
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
    <ComposedModal open onClose={onBack} size="lg" preventCloseOnClickOutside>
        {/* Modal Header with Inline Editing */}
        <ModalHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3 flex-1 min-w-0">
            <IconButton kind="ghost" size="md" label="Back" onClick={onBack} className="flex-shrink-0">
              <ArrowLeft className="h-5 w-5" />
            </IconButton>
            <div className="flex-1 min-w-0">
              {/* Basket Name - Inline Edit */}
              <div className="flex items-center gap-2">
                {isEditingBasketDetail ? (
                  <TextInput
                    id="shares-basket-name"
                    labelText="Basket name"
                    hideLabel
                    value={editBasketDetailName}
                    onChange={(e) => setEditBasketDetailName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') saveBasketDetailChanges();
                      if (e.key === 'Escape') cancelEditingBasketDetail();
                    }}
                    className="w-full max-w-xl"
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
                  <TextInput
                    id="shares-basket-desc"
                    labelText="Description"
                    hideLabel
                    size="sm"
                    value={editBasketDetailDesc}
                    onChange={(e) => setEditBasketDetailDesc(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') saveBasketDetailChanges();
                      if (e.key === 'Escape') cancelEditingBasketDetail();
                    }}
                    className="w-full max-w-xl"
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
                  <Button size="sm" onClick={saveBasketDetailChanges} disabled={!editBasketDetailName.trim()}>
                    Save
                  </Button>
                  <Button size="sm" variant="secondary" onClick={cancelEditingBasketDetail}>
                    Cancel
                  </Button>
                </div>
              )}
            </div>
          </div>
        </div>
        </ModalHeader>

        {/* Same folder view as the File Explorer; who sees it follows the project's access */}
        <ModalBody className="h-[70vh] overflow-hidden !p-0 !mb-0">
          <ShareFolderExplorer basket={{ id: basket.id, name: basket.name }} readOnly={!canWrite} embedded />
        </ModalBody>
    </ComposedModal>
  );
};
