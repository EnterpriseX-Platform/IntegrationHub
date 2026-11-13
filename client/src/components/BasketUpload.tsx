import { useState, useCallback } from 'react';
import { Upload, File, X, CheckCircle, Loader2 } from 'lucide-react';
import { api } from '../config/api';

interface UploadFile {
  id: string;
  filename: string;
  size: number;
  status: 'pending' | 'uploading' | 'uploaded' | 'error';
  progress?: number;
}

interface BasketUploadProps {
  onUploadComplete?: () => void;
}

export const BasketUpload = ({ onUploadComplete }: BasketUploadProps) => {
  const [files, setFiles] = useState<UploadFile[]>([]);
  const [isDragging, setIsDragging] = useState(false);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    
    const droppedFiles = Array.from(e.dataTransfer.files);
    handleFiles(droppedFiles);
  }, []);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      const selectedFiles = Array.from(e.target.files);
      handleFiles(selectedFiles);
    }
  };

  const handleFiles = async (fileList: File[]) => {
    const newFiles: UploadFile[] = fileList.map(file => ({
      id: Math.random().toString(36).substr(2, 9),
      filename: file.name,
      size: file.size,
      status: 'pending',
    }));

    setFiles(prev => [...prev, ...newFiles]);

    // Upload each file
    for (const uploadFile of newFiles) {
      const file = fileList.find(f => f.name === uploadFile.filename);
      if (file) {
        await uploadFileToBasket(uploadFile, file);
      }
    }
  };

  const uploadFileToBasket = async (uploadFile: UploadFile, file: File) => {
    try {
      setFiles(prev => prev.map(f => 
        f.id === uploadFile.id ? { ...f, status: 'uploading' } : f
      ));

      // Convert file to base64
      const base64 = await fileToBase64(file);
      const content = base64.split(',')[1]; // Remove data URL prefix

      const response = await fetch(api('/basket/upload'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: file.name,
          content: content,
          contentType: file.type,
        }),
      });

      const result = await response.json();

      if (result.success) {
        setFiles(prev => prev.map(f => 
          f.id === uploadFile.id ? { ...f, status: 'uploaded' } : f
        ));
        onUploadComplete?.();
      } else {
        setFiles(prev => prev.map(f => 
          f.id === uploadFile.id ? { ...f, status: 'error' } : f
        ));
      }
    } catch (error) {
      console.error('Upload error:', error);
      setFiles(prev => prev.map(f => 
        f.id === uploadFile.id ? { ...f, status: 'error' } : f
      ));
    }
  };

  const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = error => reject(error);
    });
  };

  const removeFile = (id: string) => {
    setFiles(prev => prev.filter(f => f.id !== id));
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  };

  return (
    <div className="space-y-4">
      {/* Drop Zone */}
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`
          border-2 border-dashed rounded-xl p-8 text-center transition-colors
          ${isDragging 
            ? 'border-blue-500 bg-blue-50' 
            : 'border-gray-300 hover:border-gray-400'
          }
        `}
      >
        <Upload className={`mx-auto h-12 w-12 ${isDragging ? 'text-blue-500' : 'text-gray-400'}`} />
        <p className="mt-2 text-sm text-gray-600">
          <span className="font-medium text-blue-600">Click to upload</span> or drag and drop
        </p>
        <p className="text-xs text-gray-500">Any file type up to 10MB</p>
        <input
          type="file"
          multiple
          onChange={handleFileSelect}
          className="hidden"
          id="file-upload"
        />
        <label
          htmlFor="file-upload"
          className="absolute inset-0 cursor-pointer"
        />
      </div>

      {/* File List */}
      {files.length > 0 && (
        <div className="space-y-2">
          {files.map((file) => (
            <div
              key={file.id}
              className="flex items-center gap-3 p-3 bg-white border border-gray-200 rounded-lg"
            >
              <File className="h-5 w-5 text-gray-400" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-900 truncate">
                  {file.filename}
                </p>
                <p className="text-xs text-gray-500">{formatSize(file.size)}</p>
              </div>
              {file.status === 'uploading' && (
                <Loader2 className="h-5 w-5 text-blue-500 animate-spin" />
              )}
              {file.status === 'uploaded' && (
                <CheckCircle className="h-5 w-5 text-green-500" />
              )}
              {file.status === 'error' && (
                <span className="text-xs text-red-500">Failed</span>
              )}
              <button
                onClick={() => removeFile(file.id)}
                className="p-1 hover:bg-gray-100 rounded"
              >
                <X className="h-4 w-4 text-gray-400" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default BasketUpload;
