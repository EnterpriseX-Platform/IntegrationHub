import { useState, useEffect } from 'react';
import { File, RefreshCw, Send, CheckCircle, Clock, AlertCircle, Loader2 } from 'lucide-react';
import { api } from '../config/api';
import { Button } from './ui/Button';
import { IconButton, Loading, Tag, Table, TableContainer, TableHead, TableRow, TableHeader, TableBody, TableCell } from '@carbon/react';

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
    const types = {
      pending: 'warm-gray',
      transferring: 'blue',
      transferred: 'green',
      failed: 'red',
    } as const;

    return (
      <Tag size="sm" type={types[status as keyof typeof types] || 'gray'}>
        {status.charAt(0).toUpperCase() + status.slice(1)}
      </Tag>
    );
  };

  const pendingFiles = files.filter(f => f.status === 'pending');

  if (loading) {
    return (
      <div className="text-center py-8">
        <Loading withOverlay={false} small className="mx-auto" />
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
          <IconButton kind="ghost" size="md" label="Refresh" onClick={fetchFiles}>
            <RefreshCw className="h-4 w-4" />
          </IconButton>
          {pendingFiles.length > 0 && (
            <Button
              onClick={transferAllFiles}
              isLoading={transferring}
              leftIcon={<Send className="h-4 w-4" />}
            >
              Transfer All to SFTP
            </Button>
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
        <TableContainer>
          <Table size="md">
            <TableHead>
              <TableRow>
                <TableHeader>File</TableHeader>
                <TableHeader>Size</TableHeader>
                <TableHeader>Status</TableHeader>
                <TableHeader>Uploaded</TableHeader>
              </TableRow>
            </TableHead>
            <TableBody>
              {files.map((file) => (
                <TableRow key={file.id}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      {getStatusIcon(file.status)}
                      <span className="text-sm font-medium">{file.filename}</span>
                    </div>
                  </TableCell>
                  <TableCell>{formatSize(file.size)}</TableCell>
                  <TableCell>{getStatusBadge(file.status)}</TableCell>
                  <TableCell>{formatDate(file.createdAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
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
