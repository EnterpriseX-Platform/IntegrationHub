// /share/:id — resolves a share link and opens its folder (and file) in the File Explorer.
// Lives inside Layout, so an unauthenticated visitor goes to login first and comes back here.
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { API_URL } from '../config/api';

export default function ShareLink() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${API_URL}/share-links/${id}`)
      .then((r) => r.json())
      .then((j) => {
        if (!j.success) throw new Error(j.error || 'Link not found');
        const q = new URLSearchParams();
        if (j.data.folderId) q.set('folder', j.data.folderId);
        if (j.data.fileId) q.set('file', j.data.fileId);
        navigate(`/file-explorer${q.toString() ? `?${q}` : ''}`, { replace: true });
      })
      .catch((e) => setError(e.message));
  }, [id, navigate]);

  return (
    <div className="p-10 text-center text-sm text-gray-500">
      {error ? <span className="text-red-600">{error}</span> : 'Opening shared link…'}
    </div>
  );
}
