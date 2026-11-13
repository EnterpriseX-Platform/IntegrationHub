import { useState, useEffect } from 'react';
import { File, RefreshCw, Send, CheckCircle, Clock, AlertCircle, Loader2 } from 'lucide-react';
import { api } from '../config/api';

interface BasketFile {
  id: string;
  filename: string;
  size: number;
  status: 'pending' | 'transferring' | 'transferred' | 'failed';
  createdAt: string;
  transferredAt?: string;
  error?: string;
}

interface BasketFileListProps {
  refreshTrigger?: number;
}

export const BasketFileList = ({ refreshTrigger }: BasketFileListProps) => {
  const [files, setFiles] = useState<BasketFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [transferring, setTransferring] = useState(false);

  const fetchFiles = async () => {
    try {
      const response = await fetch(api('/basket/files'));
      const result = await response.json();
      if (result.success) {
        setFiles(result.data);
      }
    } catch (error) {
      console.error('Error fetching files:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchFiles();
  }, [refreshTrigger]);

  const transferAllFiles = async () => {
    try {
      setTransferring(true);
      const response = await fetch(api('/basket/transfer-all'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sftpHost: 'localhost',
          sftpPort: 2222,
          sftpUser: 'dga',
          sftpPass: 'dga123',
          remotePath: '/upload/incoming',
        }),
      });

      const result = await response.json();
      if (result.success) {
        // Refresh the file list
        await fetchFiles();
      }
    } catch (error) {
      console.error('Transfer error:', error);
    } finally {
      setTransferring(false);
    }
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  };

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleString();
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'transferred':
        return <CheckCircle className="h-5 w-5 text-green-500" />;
      case 'transferring':
        return <Loader2 className="h-5 w-5 text-blue-500 animate-spin" />;
      case 'failed':
        return <AlertCircle className="h-5 w-5 text-red-500" />;
      default:
        return <Clock className="h-5 w-5 text-yellow-500" />;
    }
  };

  const getStatusBadge = (status: string) => {
    const styles = {
      pending: 'bg-yellow-100 text-yellow-700',
      transferring: 'bg-blue-100 text-blue-700',
      transferred: 'bg-green-100 text-green-700',
      failed: 'bg-red-100 text-red-700',
    };

    return (
      <span className={`px-2 py-1 text-xs rounded-full ${styles[status as keyof typeof styles]}`}>
        {status.charAt(0).toUpperCase() + status.slice(1)}
      </span>
    );
  };

  const pendingFiles = files.filter(f => f.status === 'pending');

  if (loading) {
    return (
      <div className="text-center py-8">
        <Loader2 className="h-8 w-8 text-blue-500 animate-spin mx-auto" />
        <p className="mt-2 text-sm text-gray-500">Loading files...</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header with actions */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-gray-900">Basket Files</h3>
          <p className="text-sm text-gray-500">
            {pendingFiles.length} pending, {files.filter(f => f.status === 'transferred').length} transferred
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={fetchFiles}
            className="p-2 border border-gray-300 rounded-lg hover:bg-gray-50"
            title="Refresh"
          >
            <RefreshCw className="h-4 w-4 text-gray-600" />
          </button>
          {pendingFiles.length > 0 && (
            <button
              onClick={transferAllFiles}
              disabled={transferring}
              className="flex items-center gap-2 px-3 h-9 rounded-lg disabled:opacity-50 whitespace-nowrap bg-blue-600 text-white hover:bg-blue-700"
            >
              {transferring ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
              Transfer All to SFTP
            </button>
          )}
        </div>
      </div>

      {/* File list */}
      {files.length === 0 ? (
        <div className="text-center py-8 bg-gray-50 rounded-lg">
          <File className="h-12 w-12 text-gray-300 mx-auto" />
          <p className="mt-2 text-gray-500">No files in basket</p>
          <p className="text-sm text-gray-400">Upload files to see them here</p>
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          <table className="w-full">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">File</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Size</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Uploaded</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {files.map((file) => (
                <tr key={file.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      {getStatusIcon(file.status)}
                      <span className="text-sm font-medium text-gray-900">{file.filename}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-500">{formatSize(file.size)}</td>
                  <td className="px-4 py-3">{getStatusBadge(file.status)}</td>
                  <td className="px-4 py-3 text-sm text-gray-500">{formatDate(file.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* SFTP Info */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <h4 className="text-sm font-medium text-blue-900 mb-2">SFTP Server Configuration</h4>
        <div className="grid grid-cols-2 gap-2 text-sm">
          <div><span className="text-blue-700">Host:</span> <span className="text-blue-900">localhost:2222</span></div>
          <div><span className="text-blue-700">Username:</span> <span className="text-blue-900">dga</span></div>
          <div><span className="text-blue-700">Password:</span> <span className="text-blue-900">dga123</span></div>
          <div><span className="text-blue-700">Remote Path:</span> <span className="text-blue-900">/upload/incoming</span></div>
        </div>
      </div>
    </div>
  );
};

export default BasketFileList;
