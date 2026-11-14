import { useState, useEffect, useRef } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { 
  Folder, Plus, Search, File, Trash2, X, Upload, Archive, FileText,
  Image, FileSpreadsheet, FileJson, FileCode, FileType,
  Loader2, ExternalLink,
  Package, CheckCircle, Play,
  ChevronDown, ChevronUp, Save, Settings2,
  Download, History, Maximize2, Minimize2, AlertCircle,
  ArrowLeft, Server
} from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { SharesBasketDetail } from '../../components/basket/SharesBasketDetail';
import { SftpBasketDetail } from '../../components/basket/SftpBasketDetail';
import { API_URL, apiFetch, withAuthToken } from '../../config/api';
import { uploadFileB64 } from '../../utils/uploadB64';

interface Project {
  id: string;
  name: string;
  color: string;
}

interface Basket {
  id: string;
  name: string;
  description: string | null;
  path: string;
  projectId: string;
  type: 'batch' | 'shares' | 'sftp';
  maxFiles?: number | null;
  maxFileSize?: number | null;
  allowedTypes: string[];
  namingPattern?: string | null;
  sessionPattern: string;
  autoArchive: boolean;
  autoPublish: string;
  autoPublishConfig: string;
  displayOrder?: number;
  createdAt: string;
  updatedAt: string;
  // SFTP specific
  sftpMode?: 'local' | 'external';
  sftpConnectionId?: string | null;
  _count?: {
    basketFiles: number;
  };
  // Shared basket info
  _isShared?: boolean;
  _sharePermission?: 'read' | 'write';
}

interface ProcessingSession {
  id: string;
  basketId: string;
  batchName: string;
  status: 'active' | 'open' | 'published' | 'processing' | 'completed' | 'error' | 'archived';
  publishMode: string;
  fileCount: number;
  totalSize: number;
  lockedBy?: string;
  lockedAt?: string;
  archivePath?: string;
  archiveSize?: number;
  startedAt: string;
  publishedAt?: string;
  completedAt?: string;
  _count?: {
    basketFiles: number;
  };
}

interface BasketFile {
  id: string;
  basketId: string;
  sessionId: string;
  fileName: string;
  originalName: string;
  size: number;
  mimeType: string;
  status: string;
  createdAt: string;
  updatedAt?: string;
  remoteModifiedAt?: string; // SFTP/remote server modification date
}

interface SessionLog {
  id: string;
  type: string;
  message: string;
  fileCount?: number;
  createdAt: string;
  metadata?: string;
}

interface FilePaging {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

interface UploadingFile {
  id: string;
  name: string;
  progress: number;
  status: 'uploading' | 'completed' | 'error';
}

const FILE_ICONS: Record<string, any> = {
  'image/': Image,
  'application/pdf': FileText,
  'text/': FileText,
  'application/json': FileJson,
  'application/xml': FileCode,
  'text/csv': FileSpreadsheet,
  'application/vnd.ms-excel': FileSpreadsheet,
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': FileSpreadsheet,
  'application/msword': FileType,
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': FileType,
  default: File,
};

const getFileIcon = (mimeType: string) => {
  for (const [key, icon] of Object.entries(FILE_ICONS)) {
    if (key !== 'default' && mimeType?.startsWith(key)) return icon;
  }
  return FILE_ICONS.default;
};

const formatFileSize = (bytes: number): string => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
};

const getStatusColor = (status: string) => {
  const colors: Record<string, string> = {
    open: 'bg-blue-100 text-blue-700 border-blue-200',
    active: 'bg-blue-100 text-blue-700 border-blue-200',
    published: 'bg-purple-100 text-purple-700 border-purple-200',
    processing: 'bg-yellow-100 text-yellow-700 border-yellow-200',
    completed: 'bg-green-100 text-green-700 border-green-200',
    error: 'bg-red-100 text-red-700 border-red-200',
    archived: 'bg-gray-100 text-gray-700 border-gray-200',
    locked: 'bg-orange-100 text-orange-700 border-orange-200',
  };
  return colors[status] || 'bg-gray-100 text-gray-700 border-gray-200';
};

const ITEMS_PER_PAGE = 20;

export const ProjectBaskets = ({ project }: { project: Project }) => {
  const [searchParams, setSearchParams] = useSearchParams();
  const [baskets, setBaskets] = useState<Basket[]>([]);
  const [basketSessions, setBasketSessions] = useState<Record<string, ProcessingSession[]>>({});
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedBasket, setSelectedBasket] = useState<Basket | null>(null);
  
  // Modal states
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showBasketModal, setShowBasketModal] = useState(false);
  const [activeTab, setActiveTab] = useState<'sessions' | 'history' | 'settings'>('sessions');
  
  // Sessions
  const [sessions, setSessions] = useState<ProcessingSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionSearch, setSessionSearch] = useState('');
  const [expandedSession, setExpandedSession] = useState<string | null>(null);
  const [fullscreenSession, setFullscreenSession] = useState<string | null>(null);
  
  // File states per session
  const [sessionFiles, setSessionFiles] = useState<Record<string, BasketFile[]>>({});
  const [filesPaging, setFilesPaging] = useState<Record<string, FilePaging>>({});
  const [filesLoading, setFilesLoading] = useState<Record<string, boolean>>({});
  const [filesSearch, setFilesSearch] = useState<Record<string, string>>({});
  
  // Upload progress per session
  const [uploadingFiles, setUploadingFiles] = useState<Record<string, UploadingFile[]>>({});
  
  // History expanded states
  const [expandedHistorySession, setExpandedHistorySession] = useState<string | null>(null);
  const [fullscreenHistorySession, setFullscreenHistorySession] = useState<string | null>(null);
  const [historyFiles, setHistoryFiles] = useState<Record<string, BasketFile[]>>({});
  const [historyFilesPaging, setHistoryFilesPaging] = useState<Record<string, FilePaging>>({});
  const [historyFilesLoading, setHistoryFilesLoading] = useState<Record<string, boolean>>({});
  const [historyFilesSearch, setHistoryFilesSearch] = useState<Record<string, string>>({});
  
  // History
  const [, setLogs] = useState<SessionLog[]>([]);
  const [, setLogsLoading] = useState(false);
  const [historyDateRange, setHistoryDateRange] = useState({ from: '', to: '' });
  const [historySearch, setHistorySearch] = useState('');
  
  // Create/Edit form
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    type: 'batch' as 'batch' | 'shares' | 'sftp',
    projectId: project.id,
    maxFiles: '',
    maxFileSize: '',
    allowedTypes: '',
    namingPattern: '',
    sessionPattern: 'Batch-{YYYYMMDD}-{NNN}',
    autoArchive: false,
    autoPublish: 'manual',
    autoPublishThreshold: '100',
    // SFTP specific
    sftpMode: 'local' as 'local' | 'external',
    sftpConnectionId: '',
  });
  const [saving, setSaving] = useState(false);
  
  // Session name editing state
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingSessionName, setEditingSessionName] = useState('');
  
  // Delete modal state
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [basketToDelete, setBasketToDelete] = useState<Basket | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  

  
  // Inline editing for basket detail modal
  const [isEditingBasketDetail, setIsEditingBasketDetail] = useState(false);
  const [editBasketDetailName, setEditBasketDetailName] = useState('');
  const [editBasketDetailDesc, setEditBasketDetailDesc] = useState('');
  const [isSavingBasketDetail, setIsSavingBasketDetail] = useState(false);
  
  // Delete session modal state
  const [showDeleteSessionModal, setShowDeleteSessionModal] = useState(false);
  const [sessionToDelete, setSessionToDelete] = useState<ProcessingSession | null>(null);
  const [isDeletingSession, setIsDeletingSession] = useState(false);
  
  // Clear history modal state
  const [showClearHistoryModal, setShowClearHistoryModal] = useState(false);
  const [isClearingHistory, setIsClearingHistory] = useState(false);
  
  // Drag and drop states
  const [draggedBasket, setDraggedBasket] = useState<Basket | null>(null);
  const [dragOverBasketId, setDragOverBasketId] = useState<string | null>(null);
  
  // Shares basket detail
  const [showSharesDetail, setShowSharesDetail] = useState(false);
  const [sharesBasket, setSharesBasket] = useState<Basket | null>(null);

  // SFTP basket detail
  const [showSftpDetail, setShowSftpDetail] = useState(false);
  const [sftpBasket, setSftpBasket] = useState<Basket | null>(null);

  // SFTP connections for dropdown
  const [sftpConnections, setSftpConnections] = useState<Array<{ id: string; name: string; config: any; isActive: boolean; lastTestStatus?: string }>>([]);
  const [sftpConnectionsLoading, setSftpConnectionsLoading] = useState(false);

  useEffect(() => {
    fetchBaskets();
    fetchSftpConnections();
  }, [project.id]);

  // Refresh baskets when modal closes
  useEffect(() => {
    if (!showBasketModal && !showSharesDetail && !showSftpDetail) {
      fetchBaskets();
    }
  }, [showBasketModal, showSharesDetail, showSftpDetail]);

  const fetchBaskets = async () => {
    try {
      setLoading(true);
      const response = await fetch(`${API_URL}/baskets?projectId=${project.id}`);
      const result = await response.json();
      if (result.success) {
        const basketsData = result.data || [];
        // Sort by displayOrder
        basketsData.sort((a: Basket, b: Basket) => (a.displayOrder || 0) - (b.displayOrder || 0));
        setBaskets(basketsData);
        
        // Fetch sessions for each basket
        const sessionsMap: Record<string, ProcessingSession[]> = {};
        await Promise.all(
          basketsData.map(async (basket: Basket) => {
            try {
              const sessionsRes = await fetch(`${API_URL}/baskets/${basket.id}/sessions?limit=100`);
              const sessionsResult = await sessionsRes.json();
              if (sessionsResult.success) {
                sessionsMap[basket.id] = sessionsResult.data || [];
              }
            } catch (e) {
              console.error(`Error fetching sessions for basket ${basket.id}:`, e);
              sessionsMap[basket.id] = [];
            }
          })
        );
        setBasketSessions(sessionsMap);
        
        // Check for basket query param to auto-open modal
        const basketId = searchParams.get('basket');
        if (basketId) {
          const basketToOpen = basketsData.find((b: Basket) => b.id === basketId);
          if (basketToOpen) {
            // Small delay to ensure state is settled
            setTimeout(() => {
              openBasketModal(basketToOpen);
            }, 100);
          }
          // Clean up the URL param
          searchParams.delete('basket');
          setSearchParams(searchParams, { replace: true });
        }
      }
    } catch (error) {
      console.error('Error fetching baskets:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchSftpConnections = async () => {
    try {
      setSftpConnectionsLoading(true);
      const response = await fetch(`${API_URL}/projects/${project.id}`);
      const result = await response.json();
      if (result.success && result.data?.connections) {
        const sftp = result.data.connections
          .filter((c: any) => c.type === 'sftp')
          .map((c: any) => ({
            id: c.id,
            name: c.name,
            config: c.config || {},
            isActive: c.isActive,
            lastTestStatus: c.lastTestStatus,
          }));
        setSftpConnections(sftp);
      }
    } catch (error) {
      console.error('Error fetching SFTP connections:', error);
    } finally {
      setSftpConnectionsLoading(false);
    }
  };

  const openBasketModal = async (basket: Basket) => {
    // For Shares Baskets, use the SharesBasketDetail view
    if (basket.type === 'shares') {
      setSharesBasket(basket);
      setShowSharesDetail(true);
      return;
    }

    // For SFTP Baskets, use the SftpBasketDetail view
    if (basket.type === 'sftp') {
      setSftpBasket(basket);
      setShowSftpDetail(true);
      return;
    }
    
    setSelectedBasket(basket);
    setShowBasketModal(true);
    setActiveTab('sessions');
    setSessionSearch('');
    setExpandedSession(null);
    setFullscreenSession(null);
    setSessionFiles({});
    setFilesPaging({});
    setFilesSearch({});
    setUploadingFiles({});
    
    // Reset history expanded states
    setExpandedHistorySession(null);
    setFullscreenHistorySession(null);
    setHistoryFiles({});
    setHistoryFilesPaging({});
    setHistoryFilesSearch({});
    
    // Reset inline editing state
    setIsEditingBasketDetail(false);
    setEditBasketDetailName(basket.name);
    setEditBasketDetailDesc(basket.description || '');
    
    const config = basket.autoPublishConfig ? JSON.parse(basket.autoPublishConfig) : {};
    setFormData({
      name: basket.name,
      description: basket.description || '',
      type: basket.type || 'batch',
      projectId: project.id,
      maxFiles: basket.maxFiles?.toString() || '',
      maxFileSize: basket.maxFileSize ? (basket.maxFileSize / 1024 / 1024).toString() : '',
      allowedTypes: basket.allowedTypes?.join(', ') || '',
      namingPattern: basket.namingPattern || '',
      sessionPattern: basket.sessionPattern || 'Batch-{YYYYMMDD}-{NNN}',
      autoArchive: basket.autoArchive,
      autoPublish: basket.autoPublish || 'manual',
      autoPublishThreshold: config.thresholdFiles?.toString() || '100',
      sftpMode: basket.sftpMode || 'local',
      sftpConnectionId: basket.sftpConnectionId || '',
    });
    
    await fetchSessions(basket.id);
  };

  const fetchSessions = async (basketId: string) => {
    try {
      setSessionsLoading(true);
      const response = await fetch(`${API_URL}/baskets/${basketId}/sessions?limit=100`);
      const result = await response.json();
      if (result.success) {
        setSessions(result.data);
        
        // Fetch file counts for all sessions to ensure accuracy
        const sessionsData = result.data || [];
        await Promise.all(
          sessionsData.map(async (session: ProcessingSession) => {
            try {
              const filesRes = await fetch(`${API_URL}/baskets/${basketId}/sessions/${session.id}/files?page=1&limit=1`);
              const filesResult = await filesRes.json();
              if (filesResult.success && filesResult.paging) {
                // Update session with correct file count
                setSessions(prev => prev.map(s => 
                  s.id === session.id 
                    ? { ...s, fileCount: filesResult.paging.total }
                    : s
                ));
              }
            } catch (e) {
              // Silent fail - keep original fileCount
            }
          })
        );
      }
    } catch (error) {
      console.error('Error fetching sessions:', error);
    } finally {
      setSessionsLoading(false);
    }
  };

  const fetchSessionFiles = async (basketId: string, sessionId: string, page = 1, search = '') => {
    try {
      setFilesLoading(prev => ({ ...prev, [sessionId]: true }));
      
      const params = new URLSearchParams({
        page: page.toString(),
        limit: ITEMS_PER_PAGE.toString(),
        ...(search && { search })
      });
      
      const response = await fetch(`${API_URL}/baskets/${basketId}/sessions/${sessionId}/files?${params}`);
      const result = await response.json();
      
      if (result.success) {
        setSessionFiles(prev => ({ ...prev, [sessionId]: result.data }));
        setFilesPaging(prev => ({ ...prev, [sessionId]: result.paging }));
        
        // Update session's fileCount and totalSize to match actual files
        if (result.paging?.total !== undefined) {
          setSessions(prev => prev.map(s => 
            s.id === sessionId 
              ? { ...s, fileCount: result.paging.total }
              : s
          ));
        }
      }
    } catch (error) {
      console.error('Error fetching session files:', error);
    } finally {
      setFilesLoading(prev => ({ ...prev, [sessionId]: false }));
    }
  };

  const fetchHistoryFiles = async (basketId: string, sessionId: string, page = 1, search = '') => {
    try {
      setHistoryFilesLoading(prev => ({ ...prev, [sessionId]: true }));
      
      const params = new URLSearchParams({
        page: page.toString(),
        limit: ITEMS_PER_PAGE.toString(),
        ...(search && { search })
      });
      
      const response = await fetch(`${API_URL}/baskets/${basketId}/sessions/${sessionId}/files?${params}`);
      const result = await response.json();
      
      if (result.success) {
        setHistoryFiles(prev => ({ ...prev, [sessionId]: result.data }));
        setHistoryFilesPaging(prev => ({ ...prev, [sessionId]: result.paging }));
      }
    } catch (error) {
      console.error('Error fetching history files:', error);
    } finally {
      setHistoryFilesLoading(prev => ({ ...prev, [sessionId]: false }));
    }
  };

  const fetchHistory = async () => {
    if (!selectedBasket) return;
    try {
      setLogsLoading(true);
      const params = new URLSearchParams();
      if (historyDateRange.from) params.append('from', historyDateRange.from);
      if (historyDateRange.to) params.append('to', historyDateRange.to);
      
      const response = await fetch(`${API_URL}/baskets/${selectedBasket.id}/logs?${params}`);
      const result = await response.json();
      if (result.success) {
        setLogs(result.data);
      }
    } catch (error) {
      console.error('Error fetching logs:', error);
    } finally {
      setLogsLoading(false);
    }
  };

  const handleCreateBasket = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const response = await fetch(`${API_URL}/baskets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: formData.name,
          description: formData.description,
          projectId: project.id,
          type: formData.type,
          maxFiles: formData.maxFiles ? parseInt(formData.maxFiles) : null,
          maxFileSize: formData.maxFileSize ? parseInt(formData.maxFileSize) * 1024 * 1024 : null,
          allowedTypes: formData.allowedTypes.split(',').map(t => t.trim()).filter(Boolean),
          namingPattern: formData.namingPattern || null,
          sessionPattern: formData.sessionPattern,
          autoArchive: formData.autoArchive,
          autoPublish: formData.autoPublish,
          autoPublishConfig: JSON.stringify({
            thresholdFiles: parseInt(formData.autoPublishThreshold) || 100
          }),
          // SFTP specific fields
          sftpMode: formData.type === 'sftp' ? (formData.sftpConnectionId ? 'external' : 'local') : null,
          sftpConnectionId: formData.type === 'sftp' && formData.sftpConnectionId ? formData.sftpConnectionId : null,
        }),
      });
      
      const result = await response.json();
      if (result.success) {
        setShowCreateModal(false);
        resetForm();
        await fetchBaskets();
      }
    } catch (error) {
      alert('Error creating basket');
    } finally {
      setSaving(false);
    }
  };

  const handleUpdateSettings = async () => {
    if (!selectedBasket) return;
    setSaving(true);
    try {
      const response = await apiFetch(`${API_URL}/baskets/${selectedBasket.id}/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          maxFiles: formData.maxFiles ? parseInt(formData.maxFiles) : null,
          maxFileSize: formData.maxFileSize ? parseInt(formData.maxFileSize) : null,
          allowedTypes: formData.allowedTypes.split(',').map(t => t.trim()).filter(Boolean),
          namingPattern: formData.namingPattern || null,
          sessionPattern: formData.sessionPattern,
          autoArchive: formData.autoArchive,
          autoPublish: formData.autoPublish,
          autoPublishConfig: {
            thresholdFiles: parseInt(formData.autoPublishThreshold) || 100
          },
        }),
      });
      
      if (response.ok) {
        await fetchBaskets();
      }
    } catch (error) {
      alert('Error updating settings');
    } finally {
      setSaving(false);
    }
  };

  const createSession = async () => {
    if (!selectedBasket) return;
    try {
      const response = await fetch(`${API_URL}/baskets/${selectedBasket.id}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      const result = await response.json();
      if (result.success) {
        await fetchSessions(selectedBasket.id);
      }
    } catch (error) {
      console.error('Error creating session:', error);
    }
  };

  const publishSession = async (sessionId: string) => {
    if (!selectedBasket) return;
    try {
      const response = await fetch(`${API_URL}/baskets/${selectedBasket.id}/sessions/${sessionId}/publish`, {
        method: 'POST'
      });
      if (response.ok) {
        await fetchSessions(selectedBasket.id);
      }
    } catch (error) {
      alert('Failed to publish session');
    }
  };

  const forceCompleteSession = async (sessionId: string) => {
    if (!selectedBasket) return;
    try {
      const response = await apiFetch(`${API_URL}/baskets/${selectedBasket.id}/sessions/${sessionId}/complete`, {
        method: 'POST'
      });
      if (response.ok) {
        await fetchSessions(selectedBasket.id);
      } else {
        const data = await response.json();
        alert(data.error || 'Failed to force complete session');
      }
    } catch (error) {
      alert('Failed to force complete session');
    }
  };

  const archiveSession = async (sessionId: string) => {
    if (!selectedBasket) return;
    try {
      await fetch(`${API_URL}/baskets/${selectedBasket.id}/sessions/${sessionId}/archive`, {
        method: 'POST'
      });
      await fetchSessions(selectedBasket.id);
    } catch (error) {
      alert('Failed to archive');
    }
  };

  const openDeleteSessionModal = (session: ProcessingSession) => {
    setSessionToDelete(session);
    setShowDeleteSessionModal(true);
  };

  const closeDeleteSessionModal = () => {
    setShowDeleteSessionModal(false);
    setSessionToDelete(null);
  };

  const handleDeleteSession = async () => {
    if (!selectedBasket || !sessionToDelete) return;
    setIsDeletingSession(true);
    try {
      const response = await apiFetch(`${API_URL}/baskets/${selectedBasket.id}/sessions/${sessionToDelete.id}`, {
        method: 'DELETE'
      });
      if (response.ok) {
        await fetchSessions(selectedBasket.id);
        closeDeleteSessionModal();
      } else {
        const result = await response.json();
        alert(result.error || 'Failed to delete session');
      }
    } catch (error) {
      alert('Failed to delete session');
    } finally {
      setIsDeletingSession(false);
    }
  };

  const handleClearHistory = async () => {
    if (!selectedBasket) return;
    setIsClearingHistory(true);
    try {
      const response = await apiFetch(`${API_URL}/baskets/${selectedBasket.id}/sessions`, {
        method: 'DELETE'
      });
      if (response.ok) {
        await fetchSessions(selectedBasket.id);
        setShowClearHistoryModal(false);
      } else {
        const result = await response.json();
        alert(result.error || 'Failed to clear history');
      }
    } catch (error) {
      alert('Failed to clear history');
    } finally {
      setIsClearingHistory(false);
    }
  };

  const downloadArchive = (session: ProcessingSession) => {
    if (!selectedBasket || !session.archivePath) return;
    window.open(withAuthToken(`${API_URL}/baskets/${selectedBasket.id}/sessions/${session.id}/download`), '_blank');
  };

  const deleteFile = async (fileId: string, sessionId: string) => {
    if (!selectedBasket) return;
    if (!confirm('Delete this file?')) return;
    
    try {
      const response = await apiFetch(`${API_URL}/baskets/${selectedBasket.id}/files/${fileId}`, {
        method: 'DELETE'
      });
      
      if (response.ok) {
        // Refresh files
        const paging = filesPaging[sessionId];
        if (paging) {
          await fetchSessionFiles(selectedBasket.id, sessionId, paging.page, filesSearch[sessionId] || '');
        }
        await fetchSessions(selectedBasket.id);
      } else {
        let msg = `HTTP ${response.status}`;
        try { msg = (await response.json()).error || msg; } catch { /* non-JSON, e.g. a Cloudflare block page */ }
        alert(`Delete failed: ${msg}`);
      }
    } catch (error) {
      alert(`Delete failed: ${error instanceof Error ? error.message : 'network error'}`);
    }
  };

  const uploadFiles = async (files: FileList | null, sessionId: string) => {
    if (!files || !selectedBasket) return;
    
    // Add uploading files to state
    const newUploadingFiles: UploadingFile[] = Array.from(files).map((file, index) => ({
      id: `upload-${Date.now()}-${index}`,
      name: file.name,
      progress: 0,
      status: 'uploading' as const
    }));
    
    setUploadingFiles(prev => ({
      ...prev,
      [sessionId]: [...(prev[sessionId] || []), ...newUploadingFiles]
    }));
    
    const refreshAfterUpload = () => {
      fetchSessions(selectedBasket.id);
      const paging = filesPaging[sessionId];
      if (paging && (expandedSession === sessionId || fullscreenSession === sessionId)) {
        fetchSessionFiles(selectedBasket.id, sessionId, paging.page, filesSearch[sessionId] || '');
      }
    };

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const uploadId = newUploadingFiles[i].id;
      
      const setUf = (patch: Partial<UploadingFile>) => setUploadingFiles(prev => ({
        ...prev,
        [sessionId]: prev[sessionId]?.map(uf => uf.id === uploadId ? { ...uf, ...patch } : uf) || []
      }));
      try {
        await uploadFileB64(`${API_URL}/baskets/${selectedBasket.id}/files`, file, { filename: file.name, sessionId }, {},
          (progress) => setUf({ progress }));
        setUf({ progress: 100, status: 'completed' });
        // show the file right away instead of after the whole batch
        refreshAfterUpload();
      } catch (error) {
        setUf({ status: 'error' });
        console.error('Upload failed:', file.name, error);
        alert(`Upload failed: ${file.name}\n${error instanceof Error ? error.message : ''}`);
      }
    }

    // Clear finished upload rows shortly after the batch
    setTimeout(() => {
      setUploadingFiles(prev => ({
        ...prev,
        [sessionId]: prev[sessionId]?.filter(uf => uf.status === 'uploading') || []
      }));
      fetchSessions(selectedBasket.id);
      
      // Refresh files if expanded
      const paging = filesPaging[sessionId];
      if (paging && (expandedSession === sessionId || fullscreenSession === sessionId)) {
        fetchSessionFiles(selectedBasket.id, sessionId, paging.page, filesSearch[sessionId] || '');
      }
    }, 2000);
  };

  const handleFileSearch = async (sessionId: string, search: string) => {
    setFilesSearch(prev => ({ ...prev, [sessionId]: search }));
    if (selectedBasket) {
      await fetchSessionFiles(selectedBasket.id, sessionId, 1, search);
    }
  };

  const handleFilePageChange = async (sessionId: string, page: number) => {
    if (selectedBasket) {
      await fetchSessionFiles(selectedBasket.id, sessionId, page, filesSearch[sessionId] || '');
    }
  };

  const handleHistoryFileSearch = async (sessionId: string, search: string) => {
    setHistoryFilesSearch(prev => ({ ...prev, [sessionId]: search }));
    if (selectedBasket) {
      await fetchHistoryFiles(selectedBasket.id, sessionId, 1, search);
    }
  };

  const handleHistoryFilePageChange = async (sessionId: string, page: number) => {
    if (selectedBasket) {
      await fetchHistoryFiles(selectedBasket.id, sessionId, page, historyFilesSearch[sessionId] || '');
    }
  };

  const toggleSessionExpand = async (session: ProcessingSession) => {
    if (expandedSession === session.id) {
      setExpandedSession(null);
      setFullscreenSession(null);
    } else {
      setExpandedSession(session.id);
      if (selectedBasket) {
        // Always fetch files to ensure fileCount is up to date
        await fetchSessionFiles(selectedBasket.id, session.id, 1, filesSearch[session.id] || '');
      }
    }
  };

  const toggleFullscreenSession = (sessionId: string) => {
    if (fullscreenSession === sessionId) {
      setFullscreenSession(null);
    } else {
      setFullscreenSession(sessionId);
      setExpandedSession(sessionId);
    }
  };

  const toggleHistorySessionExpand = async (session: ProcessingSession) => {
    if (expandedHistorySession === session.id) {
      setExpandedHistorySession(null);
      setFullscreenHistorySession(null);
    } else {
      setExpandedHistorySession(session.id);
      if (selectedBasket) {
        // Always fetch files to ensure fileCount is up to date
        await fetchHistoryFiles(selectedBasket.id, session.id, 1, historyFilesSearch[session.id] || '');
      }
    }
  };

  const toggleFullscreenHistorySession = (sessionId: string) => {
    if (fullscreenHistorySession === sessionId) {
      setFullscreenHistorySession(null);
    } else {
      setFullscreenHistorySession(sessionId);
      setExpandedHistorySession(sessionId);
    }
  };

  const handleDeleteBasket = async () => {
    if (!basketToDelete) return;
    
    setIsDeleting(true);
    try {
      const response = await apiFetch(`${API_URL}/baskets/${basketToDelete.id}`, {
        method: 'DELETE',
        credentials: 'include'
      });
      const result = await response.json();
      
      if (result.success) {
        setBaskets(prev => prev.filter(b => b.id !== basketToDelete.id));
        setShowDeleteModal(false);
        setBasketToDelete(null);
      } else {
        alert(result.error || 'Failed to delete basket');
      }
    } catch (error) {
      console.error('Error deleting basket:', error);
      alert('Failed to delete basket');
    } finally {
      setIsDeleting(false);
    }
  };

  const handleUpdateSessionName = async (sessionId: string, newName: string) => {
    if (!selectedBasket || !newName.trim()) return;
    
    try {
      const response = await apiFetch(`${API_URL}/baskets/${selectedBasket.id}/sessions/${sessionId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batchName: newName.trim() })
      });
      
      if (response.ok) {
        // Update local sessions state
        setSessions(prev => prev.map(s => 
          s.id === sessionId ? { ...s, batchName: newName.trim() } : s
        ));
        // Also update basket sessions
        setBasketSessions(prev => ({
          ...prev,
          [selectedBasket.id]: (prev[selectedBasket.id] || []).map(s =>
            s.id === sessionId ? { ...s, batchName: newName.trim() } : s
          )
        }));
        setEditingSessionId(null);
      } else {
        alert('Failed to update session name');
      }
    } catch (error) {
      console.error('Error updating session name:', error);
      alert('Failed to update session name');
    }
  };

  const startEditingSession = (session: ProcessingSession) => {
    setEditingSessionId(session.id);
    setEditingSessionName(session.batchName);
  };

  const cancelEditingSession = () => {
    setEditingSessionId(null);
    setEditingSessionName('');
  };

  const handleDeleteClick = (basket: Basket) => {
    setBasketToDelete(basket);
    setShowDeleteModal(true);
  };



  // Inline editing for basket detail modal
  const startEditingBasketDetail = () => {
    if (!selectedBasket) return;
    setIsEditingBasketDetail(true);
    setEditBasketDetailName(selectedBasket.name);
    setEditBasketDetailDesc(selectedBasket.description || '');
  };

  const cancelEditingBasketDetail = () => {
    setIsEditingBasketDetail(false);
    if (selectedBasket) {
      setEditBasketDetailName(selectedBasket.name);
      setEditBasketDetailDesc(selectedBasket.description || '');
    }
  };

  const saveBasketDetailChanges = async () => {
    if (!selectedBasket || !editBasketDetailName.trim()) return;
    setIsSavingBasketDetail(true);
    try {
      const response = await apiFetch(`${API_URL}/baskets/${selectedBasket.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: editBasketDetailName.trim(),
          description: editBasketDetailDesc.trim()
        })
      });
      if (response.ok) {
        // Update the selected basket in state
        setSelectedBasket({
          ...selectedBasket,
          name: editBasketDetailName.trim(),
          description: editBasketDetailDesc.trim()
        });
        await fetchBaskets();
        setIsEditingBasketDetail(false);
      } else {
        const result = await response.json();
        alert(result.error || 'Failed to update basket');
      }
    } catch (error) {
      alert('Failed to update basket');
    } finally {
      setIsSavingBasketDetail(false);
    }
  };

  // Drag and drop handlers
  const handleDragStart = (e: React.DragEvent, basket: Basket) => {
    setDraggedBasket(basket);
    
    // Set drag image (same pattern as connections)
    const dragImage = document.createElement('div');
    dragImage.className = 'bg-white border border-blue-400 rounded-lg p-3 shadow-lg text-sm font-medium';
    dragImage.textContent = basket.name;
    dragImage.style.position = 'absolute';
    dragImage.style.top = '-1000px';
    document.body.appendChild(dragImage);
    e.dataTransfer.setDragImage(dragImage, 0, 0);
    setTimeout(() => document.body.removeChild(dragImage), 0);
  };

  const handleDragOver = (e: React.DragEvent, targetBasket: Basket) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (draggedBasket && draggedBasket.id !== targetBasket.id) {
      setDragOverBasketId(targetBasket.id);
    }
  };

  const handleDragLeave = () => {
    setDragOverBasketId(null);
  };

  const handleDrop = async (e: React.DragEvent, targetBasket: Basket) => {
    e.preventDefault();
    setDragOverBasketId(null);
    
    if (!draggedBasket || draggedBasket.id === targetBasket.id) {
      setDraggedBasket(null);
      return;
    }
    
    // Get filtered baskets (same as displayed)
    const currentList = [...baskets.filter(b => b.name.toLowerCase().includes(searchQuery.toLowerCase()))];
    const draggedIndex = currentList.findIndex(b => b.id === draggedBasket.id);
    const targetIndex = currentList.findIndex(b => b.id === targetBasket.id);
    
    if (draggedIndex === -1 || targetIndex === -1) {
      setDraggedBasket(null);
      return;
    }
    
    // Swap positions
    const [removed] = currentList.splice(draggedIndex, 1);
    currentList.splice(targetIndex, 0, removed);
    
    // Update baskets state with new displayOrder
    const updatedBaskets = baskets.map(b => {
      const newIndex = currentList.findIndex(bb => bb.id === b.id);
      if (newIndex !== -1) {
        return { ...b, displayOrder: newIndex };
      }
      return b;
    });
    
    // Sort by displayOrder
    updatedBaskets.sort((a, b) => (a.displayOrder || 0) - (b.displayOrder || 0));
    setBaskets(updatedBaskets);
    setDraggedBasket(null);
    
    // Auto-save positions to backend
    try {
      const positions = currentList.map((b, index) => ({
        basketId: b.id,
        position: index,
      }));
      await fetch(`${API_URL}/baskets/position`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ positions }),
      });
    } catch (error) {
      console.error('Error saving basket positions:', error);
    }
  };

  const handleDragEnd = () => {
    setDraggedBasket(null);
    setDragOverBasketId(null);
  };

  const resetForm = () => {
    setFormData({
      name: '',
      description: '',
      type: 'batch',
      projectId: project.id,
      maxFiles: '',
      maxFileSize: '',
      allowedTypes: '',
      namingPattern: '',
      sessionPattern: 'Batch-{YYYYMMDD}-{NNN}',
      autoArchive: false,
      autoPublish: 'manual',
      autoPublishThreshold: '100',
      sftpMode: 'local',
      sftpConnectionId: '',
    });
  };

  const viewFile = (basketId: string, fileId: string, fileName?: string) => {
    const basePath = (import.meta.env.VITE_BASE_PATH || '/').replace(/\/$/, '');
    if (fileName && /\.xlsx?$/i.test(fileName)) {
      window.open(`${basePath}/viewer/xlsx?basketId=${basketId}&fileId=${fileId}`, '_blank');
      return;
    }
    if (fileName && /\.(txt|csv|tsv|log|dat)$/i.test(fileName)) {
      window.open(`${basePath}/viewer/txt?basketId=${basketId}&fileId=${fileId}`, '_blank');
      return;
    }
    window.open(withAuthToken(`${API_URL}/baskets/${basketId}/files/${fileId}/view`), '_blank');
  };

  const downloadFile = (basketId: string, fileId: string, fileName: string) => {
    const link = document.createElement('a');
    link.href = withAuthToken(`${API_URL}/baskets/${basketId}/files/${fileId}/download`);
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-gray-900">Baskets</h2>
          <p className="text-xs sm:text-sm text-gray-500">File storage with processing sessions & auto-archive</p>
        </div>
        <button
          onClick={() => { resetForm(); setShowCreateModal(true); }}
          className="flex items-center gap-1.5 h-9 px-3 text-[14px] bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors shrink-0"
        >
          <Plus className="h-4 w-4" />
          <span className="hidden sm:inline">Create Basket</span>
          <span className="sm:hidden">Create</span>
        </button>
      </div>

      {/* Search */}
      <div className="flex items-center gap-3 mb-6">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <input
            type="text"
            placeholder="Search baskets..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-4 py-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
          />
        </div>
      </div>

      {/* Baskets List */}
      {baskets.filter(b => b.name.toLowerCase().includes(searchQuery.toLowerCase())).length > 0 ? (
        <div className="space-y-2">
          {baskets.filter(b => b.name.toLowerCase().includes(searchQuery.toLowerCase())).map(basket => (
            <div 
              key={basket.id}
              draggable={true}
              onDragStart={(e) => handleDragStart(e, basket)}
              onDragOver={(e) => handleDragOver(e, basket)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, basket)}
              onDragEnd={handleDragEnd}
              onClick={() => openBasketModal(basket)}
              className={`bg-white rounded-lg border px-3 py-2 cursor-pointer transition-all duration-200 group
                ${dragOverBasketId === basket.id && draggedBasket?.id !== basket.id 
                  ? 'opacity-30 scale-[0.98] border-blue-400' 
                  : 'hover:shadow-md hover:border-blue-200 border-gray-200'}`}
            >
              <div className="flex items-center gap-3">
                <div className={`w-8 h-8 rounded-md flex items-center justify-center flex-shrink-0 ${
                  basket.type === 'sftp' ? 'bg-purple-100 text-purple-600' :
                  basket.type === 'shares' ? 'bg-cyan-100 text-cyan-600' :
                  'bg-orange-100 text-orange-600'
                }`}>
                  {basket.type === 'sftp' ? <Server className="h-4 w-4" /> :
                   basket.type === 'shares' ? <Folder className="h-4 w-4" /> :
                   <Package className="h-4 w-4" />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="font-medium text-sm text-gray-900 truncate">{basket.name}</h3>
                    {basket.type === 'sftp' ? (
                      <span className="px-1.5 py-0 bg-purple-50 text-purple-600 text-[12px] rounded-full border border-purple-100 flex items-center gap-1">
                        <Server className="h-3 w-3" /> SFTP
                      </span>
                    ) : basket.type === 'shares' ? (
                      <span className="px-1.5 py-0 bg-cyan-50 text-cyan-600 text-[12px] rounded-full border border-cyan-100 flex items-center gap-1">
                        <Folder className="h-3 w-3" /> File Explorer
                      </span>
                    ) : (
                      <span className="px-1.5 py-0 bg-orange-50 text-orange-600 text-[12px] rounded-full border border-orange-100">Batch</span>
                    )}
                    {basket.autoArchive && (
                      <span className="px-1.5 py-0 bg-green-50 text-green-600 text-[12px] rounded-full border border-green-100">Auto-ZIP</span>
                    )}
                    {basket.autoPublish !== 'manual' && (
                      <span className="px-1.5 py-0 bg-purple-50 text-purple-600 text-[12px] rounded-full border border-purple-100">Auto-Pub</span>
                    )}
                  </div>
                  <p className="text-xs text-gray-500 truncate">
                    {(() => {
                      if (basket.type === 'sftp') {
                        // SFTP baskets: don't show file count (files not stored in system)
                        return <>SFTP Connection</>;
                      }
                      if (basket.type === 'shares') {
                        // Shares baskets: show file count
                        const fileCount = (basket as any).fileCount || (basket as any)._count?.basketFiles || 0;
                        return <>{fileCount} files</>;
                      }
                      // For batch baskets: use session-based counting
                      const sessions = basketSessions[basket.id] || [];
                      const activeSessions = sessions.filter(s => ['open', 'published', 'processing'].includes(s.status));
                      const totalFiles = activeSessions.reduce((sum, s) => sum + (s.fileCount || 0), 0);
                      const openSessions = sessions.filter(s => s.status === 'open').length;
                      const publishedSessions = sessions.filter(s => s.status === 'published').length;
                      const processingSessions = sessions.filter(s => s.status === 'processing').length;
                      const totalActive = openSessions + publishedSessions + processingSessions;
                      return (
                        <>
                          {totalFiles} files
                          {totalActive > 0 && (
                            <span className="ml-2">
                              • {openSessions > 0 && <span className="text-blue-600">{openSessions} open</span>}
                              {openSessions > 0 && (publishedSessions > 0 || processingSessions > 0) && <span className="text-gray-400"> / </span>}
                              {publishedSessions > 0 && <span className="text-purple-600">{publishedSessions} published</span>}
                              {publishedSessions > 0 && processingSessions > 0 && <span className="text-gray-400"> / </span>}
                              {processingSessions > 0 && <span className="text-yellow-600">{processingSessions} processing</span>}
                            </span>
                          )}
                        </>
                      );
                    })()}
                  </p>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  <button
                    onClick={(e) => { e.stopPropagation(); openBasketModal(basket); }}
                    className="p-2 text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                    title="View Basket"
                  >
                    <Folder className="h-4 w-4" />
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleDeleteClick(basket); }}
                    className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                    title="Delete"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-center py-12 bg-gray-50 rounded-lg border border-dashed border-gray-200">
          <Package className="h-12 w-12 text-gray-300 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-gray-900 mb-2">No baskets yet</h3>
          <p className="text-gray-500">Create a basket to organize files into processing sessions</p>
        </div>
      )}

      {/* Create Basket Modal */}
      {showCreateModal && (
        <BasketFormModal
          title="Create New Basket"
          formData={formData}
          setFormData={setFormData}
          onSubmit={handleCreateBasket}
          onClose={() => { setShowCreateModal(false); resetForm(); }}
          saving={saving}
          isCreate={true}
          sftpConnections={sftpConnections}
          sftpConnectionsLoading={sftpConnectionsLoading}
        />
      )}

      {/* Shares Basket Detail Modal */}
      {showSharesDetail && sharesBasket && (
        <SharesBasketDetail
          basket={sharesBasket}
          project={project}
          onBack={() => {
            setShowSharesDetail(false);
            setSharesBasket(null);
            fetchBaskets();
          }}
          isSharedReadOnly={sharesBasket._isShared && sharesBasket._sharePermission !== 'write'}
        />
      )}

      {/* SFTP Basket Detail Modal */}
      {showSftpDetail && sftpBasket && (
        <SftpBasketDetail
          basket={sftpBasket}
          project={project}
          sftpConnections={sftpConnections}
          onBack={() => {
            setShowSftpDetail(false);
            setSftpBasket(null);
            fetchBaskets();
          }}
        />
      )}

      {/* Basket Detail Modal */}
      {showBasketModal && selectedBasket && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-0 sm:p-4">
          <div className={`bg-white sm:rounded-xl w-full flex flex-col transition-all duration-300 h-full sm:h-[90vh] sm:max-w-5xl ${
            (fullscreenSession || fullscreenHistorySession) ? 'sm:h-[95vh] sm:max-w-6xl' : ''
          }`}>
            {/* Modal Header with Inline Editing */}
            <div className="px-5 py-3 border-b border-gray-200 flex items-center justify-between flex-shrink-0">
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
                    <h3 
                      className="text-lg font-semibold text-gray-900 cursor-text hover:text-blue-600 transition-colors"
                      onClick={startEditingBasketDetail}
                      title="Click to edit"
                    >
                      {selectedBasket.name}
                    </h3>
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
                      className={`text-sm cursor-text hover:text-blue-600 transition-colors ${selectedBasket.description ? 'text-gray-600' : 'text-gray-400 italic'}`}
                      onClick={startEditingBasketDetail}
                      title="Click to edit"
                    >
                      {selectedBasket.description || 'Add description...'}
                    </p>
                  )}
                </div>
                
                {/* Edit Actions */}
                {isEditingBasketDetail && (
                  <div className="flex items-center gap-2 mt-2">
                    <button
                      onClick={saveBasketDetailChanges}
                      disabled={isSavingBasketDetail || !editBasketDetailName.trim()}
                      className="inline-flex items-center justify-center text-[13px] px-2 h-8 rounded disabled:opacity-50 whitespace-nowrap bg-blue-600 text-white hover:bg-blue-700"
                    >
                      {isSavingBasketDetail ? 'Saving...' : 'Save'}
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
              <button onClick={() => setShowBasketModal(false)} className="p-2 text-gray-400 hover:text-gray-600 ml-4 flex-shrink-0">
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Tabs */}
            <div className="px-5 border-b border-gray-200 flex items-center gap-1 flex-shrink-0">
              <button
                onClick={() => setActiveTab('sessions')}
                className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                  activeTab === 'sessions' ? 'border-blue-500 text-blue-600' : 'border-transparent text-gray-600 hover:text-gray-900'
                }`}
              >
                Sessions ({sessions.filter(s => ['open', 'published', 'processing'].includes(s.status)).length})
              </button>
              <button
                onClick={() => { setActiveTab('history'); fetchHistory(); }}
                className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                  activeTab === 'history' ? 'border-blue-500 text-blue-600' : 'border-transparent text-gray-600 hover:text-gray-900'
                }`}
              >
                Histories ({sessions.filter(s => s.status === 'completed' || s.status === 'archived').length})
              </button>
              <button
                onClick={() => setActiveTab('settings')}
                className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                  activeTab === 'settings' ? 'border-blue-500 text-blue-600' : 'border-transparent text-gray-600 hover:text-gray-900'
                }`}
              >
                Settings
              </button>
            </div>

            {/* Tab Content */}
            <div className="flex-1 overflow-auto relative">
              {/* Sessions Tab */}
              {activeTab === 'sessions' && (
                <div className="p-5 relative min-h-0 h-full">
                  {fullscreenSession ? (
                    // Fullscreen mode - show only the fullscreen session
                    <div className="h-full flex flex-col">
                      <div className="flex-1 min-h-0">
                        {(() => {
                          const session = sessions.find(s => s.id === fullscreenSession);
                          return session ? (
                            <SessionCard
                              session={session}
                              basketId={selectedBasket.id}
                              expanded={true}
                              fullscreen={true}
                              onToggle={() => {}}
                              onToggleFullscreen={() => setFullscreenSession(null)}
                              onPublish={() => publishSession(session.id)}
                              onForceComplete={() => forceCompleteSession(session.id)}
                              onArchive={() => archiveSession(session.id)}
                              onDelete={() => openDeleteSessionModal(session)}
                              files={sessionFiles[session.id] || []}
                              filesLoading={filesLoading[session.id]}
                              filesPaging={filesPaging[session.id]}
                              filesSearch={filesSearch[session.id] || ''}
                              onSearch={(search) => handleFileSearch(session.id, search)}
                              onPageChange={(page) => handleFilePageChange(session.id, page)}
                              uploadingFiles={uploadingFiles[session.id] || []}
                              onUpload={(files) => uploadFiles(files, session.id)}
                              onDeleteFile={deleteFile}
                              onViewFile={(fileId, fileName) => viewFile(selectedBasket.id, fileId, fileName)}
                              onDownloadFile={(fileId, fileName) => downloadFile(selectedBasket.id, fileId, fileName)}
                              isEditing={editingSessionId === session.id}
                              editingName={editingSessionName}
                              onStartEdit={() => startEditingSession(session)}
                              onSaveEdit={() => handleUpdateSessionName(session.id, editingSessionName)}
                              onCancelEdit={cancelEditingSession}
                              onEditingNameChange={setEditingSessionName}
                            />
                          ) : null;
                        })()}
                      </div>
                    </div>
                  ) : (
                    // Normal mode - show list
                    <>
                      <div className="flex items-center gap-3 mb-4">
                        <button
                          onClick={createSession}
                          className="flex items-center gap-2 px-3 h-9 rounded-lg text-[14px] whitespace-nowrap bg-blue-600 text-white hover:bg-blue-700"
                        >
                          <Plus className="h-4 w-4" />
                          New Session
                        </button>
                        <div className="relative flex-1 max-w-xs">
                          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                          <input
                            type="text"
                            placeholder="Search active sessions..."
                            value={sessionSearch}
                            onChange={(e) => setSessionSearch(e.target.value)}
                            className="w-full pl-10 pr-3 py-2 border border-gray-200 rounded-lg text-sm"
                          />
                        </div>
                      </div>

                      {sessionsLoading ? (
                        <div className="flex items-center justify-center py-12">
                          <Loader2 className="h-8 w-8 text-blue-500 animate-spin" />
                        </div>
                      ) : sessions.filter(s => ['open', 'published', 'processing'].includes(s.status)).length > 0 ? (
                        <div className="space-y-3">
                          {sessions
                            .filter(s => ['open', 'published', 'processing'].includes(s.status))
                            .filter(s => s.batchName.toLowerCase().includes(sessionSearch.toLowerCase()))
                            .map(session => (
                            <SessionCard
                              key={session.id}
                              session={session}
                              basketId={selectedBasket.id}
                              expanded={expandedSession === session.id}
                              fullscreen={false}
                              onToggle={() => toggleSessionExpand(session)}
                              onToggleFullscreen={() => toggleFullscreenSession(session.id)}
                              onPublish={() => publishSession(session.id)}
                              onForceComplete={() => forceCompleteSession(session.id)}
                              onArchive={() => archiveSession(session.id)}
                              onDelete={() => openDeleteSessionModal(session)}
                              files={sessionFiles[session.id] || []}
                              filesLoading={filesLoading[session.id]}
                              filesPaging={filesPaging[session.id]}
                              filesSearch={filesSearch[session.id] || ''}
                              onSearch={(search) => handleFileSearch(session.id, search)}
                              onPageChange={(page) => handleFilePageChange(session.id, page)}
                              uploadingFiles={uploadingFiles[session.id] || []}
                              onUpload={(files) => uploadFiles(files, session.id)}
                              onDeleteFile={deleteFile}
                              onViewFile={(fileId, fileName) => viewFile(selectedBasket.id, fileId, fileName)}
                              onDownloadFile={(fileId, fileName) => downloadFile(selectedBasket.id, fileId, fileName)}
                              isEditing={editingSessionId === session.id}
                              editingName={editingSessionName}
                              onStartEdit={() => startEditingSession(session)}
                              onSaveEdit={() => handleUpdateSessionName(session.id, editingSessionName)}
                              onCancelEdit={cancelEditingSession}
                              onEditingNameChange={setEditingSessionName}
                            />
                          ))}
                        </div>
                      ) : (
                        <div className="text-center py-12 text-gray-500">
                          <Folder className="h-12 w-12 text-gray-300 mx-auto mb-4" />
                          <p>No active sessions</p>
                          <p className="text-sm mt-1">
                            {sessions.filter(s => s.status === 'completed' || s.status === 'archived').length > 0 
                              ? `Completed/archived sessions are in the Histories tab (${sessions.filter(s => s.status === 'completed' || s.status === 'archived').length})`
                              : 'Create a new session to start uploading files'}
                          </p>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}

              {/* History Tab */}
              {activeTab === 'history' && (
                <div className="p-5 relative min-h-0 h-full">
                  {fullscreenHistorySession ? (
                    // Fullscreen mode - show only the fullscreen session
                    <div className="h-full flex flex-col">
                      <div className="flex-1 min-h-0">
                        {(() => {
                          const session = sessions.find(s => s.id === fullscreenHistorySession);
                          return session ? (
                            <HistorySessionCard
                              session={session}
                              basketId={selectedBasket.id}
                              expanded={true}
                              fullscreen={true}
                              onToggle={() => {}}
                              onToggleFullscreen={() => setFullscreenHistorySession(null)}
                              files={historyFiles[session.id] || []}
                              filesLoading={historyFilesLoading[session.id]}
                              filesPaging={historyFilesPaging[session.id]}
                              filesSearch={historyFilesSearch[session.id] || ''}
                              onSearch={(search) => handleHistoryFileSearch(session.id, search)}
                              onPageChange={(page) => handleHistoryFilePageChange(session.id, page)}
                              onArchive={() => archiveSession(session.id)}
                              onDownloadArchive={() => downloadArchive(session)}
                              onViewFile={(fileId, fileName) => viewFile(selectedBasket.id, fileId, fileName)}
                              onDownloadFile={(fileId, fileName) => downloadFile(selectedBasket.id, fileId, fileName)}
                            />
                          ) : null;
                        })()}
                      </div>
                    </div>
                  ) : (
                    // Normal mode - show list
                    <>
                      <div className="flex items-center gap-3 mb-4">
                        <div className="relative flex-1 max-w-xs">
                          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                          <input
                            type="text"
                            placeholder="Search completed sessions..."
                            value={historySearch}
                            onChange={(e) => setHistorySearch(e.target.value)}
                            className="w-full pl-10 pr-3 py-2 border border-gray-200 rounded-lg text-sm"
                          />
                        </div>
                        <div className="flex items-center gap-2">
                          <input type="date" value={historyDateRange.from} onChange={(e) => setHistoryDateRange(prev => ({ ...prev, from: e.target.value }))} className="px-3 py-2 border border-gray-200 rounded-lg text-sm" />
                          <span className="text-gray-400">to</span>
                          <input type="date" value={historyDateRange.to} onChange={(e) => setHistoryDateRange(prev => ({ ...prev, to: e.target.value }))} className="px-3 py-2 border border-gray-200 rounded-lg text-sm" />
                        </div>
                        {sessions.filter(s => s.status === 'completed' || s.status === 'archived').length > 0 && (
                          <button
                            onClick={() => setShowClearHistoryModal(true)}
                            className="flex items-center gap-2 px-3 h-9 text-red-600 hover:bg-red-50 rounded-lg text-[14px] border border-red-200 whitespace-nowrap"
                            title="Clear all history sessions"
                          >
                            <Trash2 className="h-4 w-4" />
                            Clear All
                          </button>
                        )}
                      </div>

                      {sessions.filter(s => s.status === 'completed' || s.status === 'archived').filter(s => s.batchName.toLowerCase().includes(historySearch.toLowerCase())).length > 0 ? (
                        <div className="space-y-3">
                          {sessions.filter(s => s.status === 'completed' || s.status === 'archived').filter(s => s.batchName.toLowerCase().includes(historySearch.toLowerCase())).map(session => (
                            <HistorySessionCard
                              key={session.id}
                              session={session}
                              basketId={selectedBasket.id}
                              expanded={expandedHistorySession === session.id}
                              fullscreen={false}
                              onToggle={() => toggleHistorySessionExpand(session)}
                              onToggleFullscreen={() => toggleFullscreenHistorySession(session.id)}
                              files={historyFiles[session.id] || []}
                              filesLoading={historyFilesLoading[session.id]}
                              filesPaging={historyFilesPaging[session.id]}
                              filesSearch={historyFilesSearch[session.id] || ''}
                              onSearch={(search) => handleHistoryFileSearch(session.id, search)}
                              onPageChange={(page) => handleHistoryFilePageChange(session.id, page)}
                              onArchive={() => archiveSession(session.id)}
                              onDownloadArchive={() => downloadArchive(session)}
                              onViewFile={(fileId, fileName) => viewFile(selectedBasket.id, fileId, fileName)}
                              onDownloadFile={(fileId, fileName) => downloadFile(selectedBasket.id, fileId, fileName)}
                            />
                          ))}
                        </div>
                      ) : (
                        <div className="text-center py-12 text-gray-500">
                          <History className="h-12 w-12 text-gray-300 mx-auto mb-4" />
                          <p>No completed or archived sessions</p>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}

              {/* Settings Tab */}
              {activeTab === 'settings' && (
                <div className="p-5 max-w-2xl">
                  <div className="space-y-6">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Session Naming Pattern</label>
                      <input type="text" value={formData.sessionPattern} onChange={(e) => setFormData({ ...formData, sessionPattern: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500" placeholder="Batch-{YYYYMMDD}-{NNN}" />
                      <p className="text-xs text-gray-500 mt-1">Variables: {'{YYYY}'}, {'{YYYY+543}'}, {'{MM}'}, {'{DD}'}, {'{YYYYMMDD}'}, {'{N}'}, {'{NN}'}, {'{NNN}'}</p>
                    </div>

                    <div className="flex items-center justify-between p-4 bg-gray-50 rounded-lg">
                      <div><span className="font-medium text-gray-900">Auto Archive to ZIP</span><p className="text-sm text-gray-500">Create ZIP when session is published</p></div>
                      <button type="button" onClick={() => setFormData({ ...formData, autoArchive: !formData.autoArchive })} className={`relative inline-flex h-6 w-11 items-center rounded-full ${formData.autoArchive ? 'bg-blue-600' : 'bg-gray-200'}`}><span className={`inline-block h-4 w-4 transform rounded-full bg-white transition ${formData.autoArchive ? 'translate-x-6' : 'translate-x-1'}`} /></button>
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Auto Publish Mode</label>
                      <select value={formData.autoPublish} onChange={(e) => setFormData({ ...formData, autoPublish: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500">
                        <option value="manual">Manual - Click Publish button</option>
                        <option value="immediate">Immediate - Auto publish on upload</option>
                        <option value="threshold">Threshold - Publish when file count reached</option>
                      </select>
                    </div>

                    {formData.autoPublish === 'threshold' && (
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">File Threshold</label>
                        <input type="number" value={formData.autoPublishThreshold} onChange={(e) => setFormData({ ...formData, autoPublishThreshold: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500" placeholder="100" />
                      </div>
                    )}

                    <div className="border-t border-gray-200 pt-6">
                      <h4 className="font-medium text-gray-900 mb-4">Validation Rules</h4>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
                        <div><label className="block text-sm font-medium text-gray-700 mb-1">Max Files</label><input type="number" value={formData.maxFiles} onChange={(e) => setFormData({ ...formData, maxFiles: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg" placeholder="Unlimited" /></div>
                        <div><label className="block text-sm font-medium text-gray-700 mb-1">Max Size (MB)</label><input type="number" value={formData.maxFileSize} onChange={(e) => setFormData({ ...formData, maxFileSize: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg" placeholder="Unlimited" /></div>
                      </div>
                      <div className="mb-4"><label className="block text-sm font-medium text-gray-700 mb-1">Allowed File Types</label><input type="text" value={formData.allowedTypes} onChange={(e) => setFormData({ ...formData, allowedTypes: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg" placeholder="image/*, application/pdf" /></div>
                      <div><label className="block text-sm font-medium text-gray-700 mb-1">Naming Pattern (Regex)</label><input type="text" value={formData.namingPattern} onChange={(e) => setFormData({ ...formData, namingPattern: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg font-mono text-sm" placeholder="^[A-Z]{3}-\d{4}\.pdf$" /></div>
                    </div>

                    <div className="flex justify-end pt-4 border-t border-gray-200">
                      <button onClick={handleUpdateSettings} disabled={saving} className="flex items-center gap-2 px-3 h-9 rounded-lg disabled:opacity-50 whitespace-nowrap bg-blue-600 text-white hover:bg-blue-700">
                        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                        Save Settings
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {showDeleteModal && basketToDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm mx-4">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
              <h2 className="text-lg font-semibold text-gray-900">Delete Basket</h2>
              <button 
                onClick={() => setShowDeleteModal(false)}
                className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
              >
                <X className="h-5 w-5 text-gray-500" />
              </button>
            </div>
            <div className="p-6">
              <div className="flex items-center gap-3 text-amber-500 mb-3">
                <AlertCircle className="h-8 w-8" />
              </div>
              <p className="text-sm text-gray-600">
                Are you sure you want to delete <strong>{basketToDelete.name}</strong>?
              </p>
              <p className="text-sm text-gray-500 mt-2">
                This action cannot be undone. All files and sessions in this basket will be permanently deleted.
              </p>
            </div>
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200 bg-gray-50 rounded-b-xl">
              <Button variant="ghost" onClick={() => setShowDeleteModal(false)}>
                Cancel
              </Button>
              <Button 
                variant="danger" 
                onClick={handleDeleteBasket}
                isLoading={isDeleting}
              >
                Delete Basket
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Session Confirmation Modal */}
      {showDeleteSessionModal && sessionToDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm mx-4">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
              <h2 className="text-lg font-semibold text-gray-900">Delete Session</h2>
              <button 
                onClick={closeDeleteSessionModal}
                className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
              >
                <X className="h-5 w-5 text-gray-500" />
              </button>
            </div>
            <div className="p-6">
              <div className="flex items-center gap-3 text-amber-500 mb-3">
                <AlertCircle className="h-8 w-8" />
              </div>
              <p className="text-sm text-gray-600">
                Are you sure you want to delete <strong>{sessionToDelete.batchName}</strong>?
              </p>
              <p className="text-sm text-gray-500 mt-2">
                This action cannot be undone. All {sessionToDelete.fileCount} files in this session will be permanently deleted.
              </p>
            </div>
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200 bg-gray-50 rounded-b-xl">
              <Button variant="ghost" onClick={closeDeleteSessionModal}>
                Cancel
              </Button>
              <Button 
                variant="danger" 
                onClick={handleDeleteSession}
                isLoading={isDeletingSession}
              >
                Delete Session
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Clear History Confirmation Modal */}
      {showClearHistoryModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm mx-4">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
              <h2 className="text-lg font-semibold text-gray-900">Clear History</h2>
              <button
                onClick={() => setShowClearHistoryModal(false)}
                className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
              >
                <X className="h-5 w-5 text-gray-500" />
              </button>
            </div>
            <div className="p-6">
              <div className="flex items-center gap-3 text-amber-500 mb-3">
                <AlertCircle className="h-8 w-8" />
              </div>
              <p className="text-sm text-gray-600">
                Are you sure you want to clear all history sessions?
              </p>
              <p className="text-sm text-gray-500 mt-2">
                This will permanently delete all completed and archived sessions. This action cannot be undone.
              </p>
            </div>
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200 bg-gray-50 rounded-b-xl">
              <Button variant="ghost" onClick={() => setShowClearHistoryModal(false)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={handleClearHistory}
                isLoading={isClearingHistory}
              >
                Clear All History
              </Button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
};

// Session Card Component with Pagination, Drop Zone, and Fullscreen
function SessionCard({ 
  session, basketId: _basketId, expanded, fullscreen, onToggle, onToggleFullscreen, onPublish, onForceComplete, onArchive, onDelete,
  files, filesLoading, filesPaging, filesSearch, onSearch, onPageChange,
  uploadingFiles, onUpload, onDeleteFile, onViewFile, onDownloadFile,
  isEditing, editingName, onStartEdit, onSaveEdit, onCancelEdit, onEditingNameChange
}: {
  session: ProcessingSession;
  basketId: string;
  expanded: boolean;
  fullscreen: boolean;
  onToggle: () => void;
  onToggleFullscreen: () => void;
  onPublish: () => void;
  onForceComplete?: () => void;
  onArchive?: () => void;
  onDelete?: () => void;
  files: BasketFile[];
  filesLoading?: boolean;
  filesPaging?: FilePaging;
  filesSearch: string;
  onSearch: (search: string) => void;
  onPageChange: (page: number) => void;
  uploadingFiles: UploadingFile[];
  onUpload: (files: FileList | null) => void;
  onDeleteFile: (fileId: string, sessionId: string) => void;
  onViewFile: (fileId: string, fileName?: string) => void;
  onDownloadFile: (fileId: string, fileName: string) => void;
  isEditing?: boolean;
  editingName?: string;
  onStartEdit?: () => void;
  onSaveEdit?: () => void;
  onCancelEdit?: () => void;
  onEditingNameChange?: (name: string) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const StatusIcon = session.status === 'processing' ? Loader2 : session.status === 'published' ? Play : session.status === 'completed' ? CheckCircle : Folder;
  
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    if (session.status === 'open' && e.dataTransfer.files.length > 0) {
      onUpload(e.dataTransfer.files);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (session.status === 'open') {
      setIsDragOver(true);
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  };
  
  // Combine existing files with uploading files
  const allFiles = [...files, ...uploadingFiles.map(uf => ({
    id: uf.id,
    fileName: uf.name,
    originalName: uf.name,
    size: 0,
    mimeType: 'application/octet-stream',
    status: uf.status === 'uploading' ? 'uploading' : uf.status === 'completed' ? 'completed' : 'error',
    isUploading: true,
    progress: uf.progress
  }))];
  
  return (
    <div className={`border border-gray-200 rounded-lg overflow-hidden transition-all duration-300 ${
      fullscreen ? 'flex flex-col h-full' : 
      expanded ? 'flex flex-col' : ''
    }`} style={expanded && !fullscreen ? { minHeight: '400px' } : {}}>
      {/* Session Header with Drop Zone */}
      <div 
        className={`px-4 py-2 flex items-center gap-3 transition-colors min-h-[56px] ${
          isDragOver ? 'bg-blue-100 border-2 border-blue-400 border-dashed' : 'bg-gray-50 hover:bg-gray-100'
        } ${expanded || fullscreen ? 'cursor-default' : 'cursor-pointer'}`}
        onClick={!expanded && !fullscreen ? onToggle : undefined}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
      >
        <div className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${getStatusColor(session.status)}`}>
          <StatusIcon className={`h-5 w-5 ${session.status === 'processing' ? 'animate-spin' : ''}`} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            {isEditing ? (
              <div className="flex items-center gap-2 flex-1">
                <input
                  type="text"
                  value={editingName}
                  onChange={(e) => onEditingNameChange?.(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') onSaveEdit?.();
                    if (e.key === 'Escape') onCancelEdit?.();
                  }}
                  onClick={(e) => e.stopPropagation()}
                  className="font-medium text-gray-900 text-base outline-none border-b-2 border-blue-500 bg-transparent px-0 py-0 w-auto min-w-[100px] max-w-md"
                  style={{ width: `${(editingName || '').length + 2}ch` }}
                  autoFocus
                />
              </div>
            ) : (
              <>
                <h4 
                  className="font-medium text-gray-900 truncate text-base cursor-text hover:text-blue-600"
                  onClick={(e) => { e.stopPropagation(); onStartEdit?.(); }}
                  title="Click to edit"
                >
                  {session.batchName}
                </h4>
                <span className={`px-2 py-0.5 text-xs rounded-full border ${getStatusColor(session.status)}`}>{session.status}</span>
                {session.lockedBy && <span className="px-2 py-0.5 text-xs rounded-full bg-orange-100 text-orange-700 border border-orange-200 flex-shrink-0">Locked</span>}
                {isDragOver && <span className="text-xs text-blue-600 flex-shrink-0 font-medium animate-pulse">Drop files here...</span>}
              </>
            )}
          </div>
          <p className="text-sm text-gray-500 truncate">
            {filesPaging?.total !== undefined ? filesPaging.total : session.fileCount} files • {formatFileSize(session.totalSize)} • Started {new Date(session.startedAt).toLocaleString('en-GB', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}
            {uploadingFiles.length > 0 && <span className="text-blue-600 ml-2">({uploadingFiles.filter(uf => uf.status === 'uploading').length} uploading)</span>}
          </p>
        </div>
        
        {/* Drop Zone Indicator */}
        {session.status === 'open' && (
          <div 
            className={`hidden sm:flex items-center justify-center gap-2 px-6 py-2 rounded-lg border-2 border-dashed transition-all duration-200 min-w-[160px] ${
              isDragOver 
                ? 'bg-blue-200 border-blue-500 scale-105' 
                : 'bg-white/80 border-gray-300 hover:border-blue-400 hover:bg-blue-50'
            }`}
            onClick={(e) => {
              e.stopPropagation();
              fileInputRef.current?.click();
            }}
          >
            <Upload className={`h-5 w-5 ${isDragOver ? 'text-blue-600' : 'text-gray-400'}`} />
            <div className="flex flex-col items-start">
              <span className={`text-xs font-medium ${isDragOver ? 'text-blue-700' : 'text-gray-600'}`}>
                Drop files here
              </span>
              <span className={`text-[12px] ${isDragOver ? 'text-blue-500' : 'text-gray-400'}`}>
                or click to browse
              </span>
            </div>
          </div>
        )}
        
        <div className="flex items-center gap-1 flex-shrink-0">
          {/* Fullscreen Toggle */}
          <button 
            onClick={(e) => { e.stopPropagation(); onToggleFullscreen(); }}
            className="p-2 text-gray-500 hover:bg-gray-200 rounded-lg"
            title={fullscreen ? "Exit Fullscreen" : "Fullscreen"}
          >
            {fullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </button>
          
          {session.status === 'open' && (
            <>
              <input ref={fileInputRef} type="file" multiple onChange={(e) => onUpload(e.target.files)} className="hidden" />
              <button 
                onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click(); }} 
                disabled={uploadingFiles.some(uf => uf.status === 'uploading')}
                className="p-2 text-blue-600 hover:bg-blue-50 rounded-lg disabled:opacity-50" 
                title="Upload Files"
              >
                <Upload className="h-4 w-4" />
              </button>
            </>
          )}
          {(session.status === 'open' || session.status === 'error') && (
            <button
              onClick={(e) => { e.stopPropagation(); onPublish(); }}
              className={`p-2 ${session.status === 'error' ? 'text-red-600 hover:bg-red-50' : 'text-purple-600 hover:bg-purple-50'} rounded-lg`}
              title={session.status === 'error' ? 'Re-publish Session (retry)' : 'Publish Session'}
            >
              <Play className="h-4 w-4" />
            </button>
          )}
          {session.status === 'processing' && onForceComplete && (
            <button
              onClick={(e) => { e.stopPropagation(); onForceComplete(); }}
              className="p-2 text-green-600 hover:bg-green-50 rounded-lg"
              title="Force Complete (stuck processing)"
            >
              <CheckCircle className="h-4 w-4" />
            </button>
          )}
          {onArchive && (
            <button 
              onClick={(e) => { e.stopPropagation(); onArchive(); }} 
              className="p-2 text-orange-600 hover:bg-orange-50 rounded-lg" 
              title="Archive Session"
            >
              <Archive className="h-4 w-4" />
            </button>
          )}
          {onDelete && (
            <button 
              onClick={(e) => { e.stopPropagation(); onDelete(); }} 
              className="p-2 text-red-600 hover:bg-red-50 rounded-lg" 
              title="Delete Session"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}
          <button 
            onClick={(e) => { e.stopPropagation(); onToggle(); }}
            className="p-2 text-gray-400 hover:text-gray-600"
          >
            {expanded || fullscreen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </button>
        </div>
      </div>
      
      {/* Expanded File List with Pagination */}
      {(expanded || fullscreen) && (
        <div className="border-t border-gray-200 flex-1 flex flex-col min-h-0">
          {/* Search and Pagination Controls */}
          <div className="px-4 py-3 border-b border-gray-100 flex flex-wrap items-center justify-between gap-2 flex-shrink-0">
            <div className="relative w-full sm:w-64">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
              <input
                type="text"
                placeholder="Search files..."
                value={filesSearch}
                onChange={(e) => onSearch(e.target.value)}
                className="w-full pl-10 pr-3 py-2 border border-gray-200 rounded-lg text-sm"
              />
            </div>
            {filesPaging && filesPaging.totalPages > 1 && (
              <div className="flex items-center gap-2">
                <button 
                  onClick={() => onPageChange(filesPaging.page - 1)} 
                  disabled={filesPaging.page === 1} 
                  className="inline-flex items-center justify-center px-3 h-9 text-[14px] border border-gray-200 rounded hover:bg-gray-50 disabled:opacity-50 whitespace-nowrap"
                >
                  Previous
                </button>
                <span className="text-sm text-gray-600 px-2">
                  Page {filesPaging.page} of {filesPaging.totalPages}
                </span>
                <button 
                  onClick={() => onPageChange(filesPaging.page + 1)} 
                  disabled={filesPaging.page === filesPaging.totalPages} 
                  className="inline-flex items-center justify-center px-3 h-9 text-[14px] border border-gray-200 rounded hover:bg-gray-50 disabled:opacity-50 whitespace-nowrap"
                >
                  Next
                </button>
              </div>
            )}
          </div>
          
          {/* File List - Scrollable */}
          <div className="flex-1 overflow-auto px-4">
            {filesLoading ? (
              <div className="flex items-center justify-center py-8"><Loader2 className="h-6 w-6 text-blue-500 animate-spin" /></div>
            ) : allFiles.length > 0 ? (
              <table className="w-full text-sm">
                <thead className="bg-gray-50 sticky top-0">
                  <tr>
                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">File</th>
                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 w-24">Size</th>
                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 w-36">Updated</th>
                    <th className="px-3 py-2 text-center text-xs font-medium text-gray-500 w-20">Status</th>
                    <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 w-24">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {allFiles.map((file: any) => {
                    const FileIcon = getFileIcon(file.mimeType);
                    return (
                      <tr key={file.id} className={`hover:bg-gray-50 ${file.isUploading ? 'bg-blue-50/50' : ''}`}>
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-2">
                            <FileIcon className="h-4 w-4 text-gray-400 flex-shrink-0" />
                            <span className="truncate max-w-[300px]" title={file.originalName}>{file.originalName}</span>
                          </div>
                        </td>
                        <td className="px-3 py-2 text-gray-600 whitespace-nowrap">
                          {file.isUploading ? '-' : formatFileSize(file.size)}
                        </td>
                        <td className="px-3 py-2 text-xs text-gray-500 whitespace-nowrap">
                          {file.isUploading ? '-' : new Date(file.remoteModifiedAt || file.updatedAt || file.createdAt).toLocaleString('en-GB', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}
                        </td>
                        <td className="px-3 py-2 text-center">
                          {file.isUploading ? (
                            <div className="flex items-center justify-center gap-2">
                              <div className="w-16 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                                <div 
                                  className="h-full bg-blue-500 transition-all duration-300"
                                  style={{ width: `${file.progress}%` }}
                                />
                              </div>
                              <span className="text-xs text-gray-500">{file.progress}%</span>
                            </div>
                          ) : (
                            <span className={`px-2 py-0.5 text-xs rounded-full ${getStatusColor(file.status)}`}>
                              {file.status}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex items-center justify-end gap-1">
                            {!file.isUploading && (
                              <>
                                <button 
                                  onClick={() => onViewFile(file.id, file.originalName)}
                                  className="p-1.5 text-blue-600 hover:bg-blue-50 rounded" 
                                  title="Open"
                                >
                                  <ExternalLink className="h-3.5 w-3.5" />
                                </button>
                                <button 
                                  onClick={() => onDownloadFile(file.id, file.originalName)} 
                                  className="p-1.5 text-green-600 hover:bg-green-50 rounded" 
                                  title="Download"
                                >
                                  <Download className="h-3.5 w-3.5" />
                                </button>
                                {session.status === 'open' && (
                                  <button 
                                    onClick={() => onDeleteFile(file.id, session.id)} 
                                    className="p-1.5 text-red-600 hover:bg-red-50 rounded" 
                                    title="Delete"
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </button>
                                )}
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <p className="text-center text-gray-500 py-4">{filesSearch ? 'No files match your search' : 'No files in this session'}</p>
            )}
          </div>
          
          {/* Bottom Info */}
          {filesPaging && (
            <div className="px-4 py-3 border-t border-gray-100 flex items-center justify-between flex-shrink-0">
              <span className="text-xs text-gray-500">
                Showing {((filesPaging.page - 1) * filesPaging.limit) + 1} - {Math.min(filesPaging.page * filesPaging.limit, filesPaging.total)} of {filesPaging.total} files
              </span>
              {uploadingFiles.length > 0 && (
                <span className="text-xs text-blue-600">
                  {uploadingFiles.filter(uf => uf.status === 'uploading').length} file(s) uploading
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// History Session Card with collapsible file list
function HistorySessionCard({ 
  session, basketId: _basketId, expanded, fullscreen, onToggle, onToggleFullscreen,
  files, filesLoading, filesPaging, filesSearch, onSearch, onPageChange,
  onArchive, onDownloadArchive, onViewFile, onDownloadFile
}: {
  session: ProcessingSession;
  basketId: string;
  expanded: boolean;
  fullscreen: boolean;
  onToggle: () => void;
  onToggleFullscreen: () => void;
  files: BasketFile[];
  filesLoading?: boolean;
  filesPaging?: FilePaging;
  filesSearch: string;
  onSearch: (search: string) => void;
  onPageChange: (page: number) => void;
  onArchive: () => void;
  onDownloadArchive: () => void;
  onViewFile: (fileId: string, fileName?: string) => void;
  onDownloadFile: (fileId: string, fileName: string) => void;
}) {
  const StatusIcon = session.status === 'archived' ? Archive : CheckCircle;
  
  return (
    <div className={`border border-gray-200 rounded-lg overflow-hidden transition-all duration-300 ${
      fullscreen ? 'flex flex-col h-full' : 
      expanded ? 'flex flex-col' : ''
    }`} style={expanded && !fullscreen ? { minHeight: '400px' } : {}}>
      {/* Session Header */}
      <div 
        className={`px-4 py-2 bg-gray-50 flex items-center gap-3 transition-colors min-h-[56px] ${
          expanded || fullscreen ? 'cursor-default' : 'cursor-pointer hover:bg-gray-100'
        }`}
        onClick={!expanded && !fullscreen ? onToggle : undefined}
      >
        <div className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${getStatusColor(session.status)}`}>
          <StatusIcon className="h-5 w-5" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h4 className="font-medium text-gray-900 truncate">{session.batchName}</h4>
            <span className={`px-2 py-0.5 text-xs rounded-full border ${getStatusColor(session.status)}`}>{session.status}</span>
          </div>
          <p className="text-sm text-gray-500 truncate">{filesPaging?.total !== undefined ? filesPaging.total : session.fileCount} files • {formatFileSize(session.totalSize)} • Completed: {session.completedAt ? new Date(session.completedAt).toLocaleString('en-GB', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : 'N/A'}</p>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {/* Fullscreen Toggle */}
          <button 
            onClick={(e) => { e.stopPropagation(); onToggleFullscreen(); }}
            className="p-2 text-gray-500 hover:bg-gray-200 rounded-lg"
            title={fullscreen ? "Exit Fullscreen" : "Fullscreen"}
          >
            {fullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </button>
          
          {session.status === 'completed' && !session.archivePath && (
            <button onClick={(e) => { e.stopPropagation(); onArchive(); }} className="p-2 text-blue-600 hover:bg-blue-50 rounded-lg" title="Archive"><Archive className="h-4 w-4" /></button>
          )}
          {session.archivePath && (
            <button onClick={(e) => { e.stopPropagation(); onDownloadArchive(); }} className="p-2 text-green-600 hover:bg-green-50 rounded-lg" title="Download ZIP"><Download className="h-4 w-4" /></button>
          )}
          <button onClick={(e) => { e.stopPropagation(); onToggle(); }} className="p-2 text-gray-400 hover:text-gray-600">
            {expanded || fullscreen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </button>
        </div>
      </div>
      
      {/* Expanded File List */}
      {(expanded || fullscreen) && (
        <div className="border-t border-gray-200 flex-1 flex flex-col min-h-0">
          {/* Search and Pagination Controls */}
          <div className="px-4 py-3 border-b border-gray-100 flex flex-wrap items-center justify-between gap-2 flex-shrink-0">
            <div className="relative w-full sm:w-64">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
              <input
                type="text"
                placeholder="Search files..."
                value={filesSearch}
                onChange={(e) => onSearch(e.target.value)}
                className="w-full pl-10 pr-3 py-2 border border-gray-200 rounded-lg text-sm"
              />
            </div>
            {filesPaging && filesPaging.totalPages > 1 && (
              <div className="flex items-center gap-2">
                <button 
                  onClick={() => onPageChange(filesPaging.page - 1)} 
                  disabled={filesPaging.page === 1} 
                  className="inline-flex items-center justify-center px-3 h-9 text-[14px] border border-gray-200 rounded hover:bg-gray-50 disabled:opacity-50 whitespace-nowrap"
                >
                  Previous
                </button>
                <span className="text-sm text-gray-600 px-2">
                  Page {filesPaging.page} of {filesPaging.totalPages}
                </span>
                <button 
                  onClick={() => onPageChange(filesPaging.page + 1)} 
                  disabled={filesPaging.page === filesPaging.totalPages} 
                  className="inline-flex items-center justify-center px-3 h-9 text-[14px] border border-gray-200 rounded hover:bg-gray-50 disabled:opacity-50 whitespace-nowrap"
                >
                  Next
                </button>
              </div>
            )}
          </div>
          
          {/* File List - Scrollable */}
          <div className="flex-1 overflow-auto px-4">
            {filesLoading ? (
              <div className="flex items-center justify-center py-8"><Loader2 className="h-6 w-6 text-blue-500 animate-spin" /></div>
            ) : files.length > 0 ? (
              <table className="w-full text-sm">
                <thead className="bg-gray-50 sticky top-0">
                  <tr>
                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">File</th>
                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 w-24">Size</th>
                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 w-36">Updated</th>
                    <th className="px-3 py-2 text-center text-xs font-medium text-gray-500 w-20">Status</th>
                    <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 w-24">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {files.map(file => {
                    const FileIcon = getFileIcon(file.mimeType);
                    return (
                      <tr key={file.id} className="hover:bg-gray-50">
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-2">
                            <FileIcon className="h-4 w-4 text-gray-400 flex-shrink-0" />
                            <span className="truncate max-w-[300px]" title={file.originalName}>{file.originalName}</span>
                          </div>
                        </td>
                        <td className="px-3 py-2 text-gray-600 whitespace-nowrap">{formatFileSize(file.size)}</td>
                        <td className="px-3 py-2 text-xs text-gray-500 whitespace-nowrap">
                          {new Date(file.updatedAt || file.createdAt).toLocaleString('en-GB', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}
                        </td>
                        <td className="px-3 py-2 text-center">
                          <span className={`px-2 py-0.5 text-xs rounded-full ${getStatusColor(file.status)}`}>
                            {file.status}
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex items-center justify-end gap-1">
                            <button 
                              onClick={() => onViewFile(file.id, file.originalName)}
                              className="p-1.5 text-blue-600 hover:bg-blue-50 rounded" 
                              title="Open"
                            >
                              <ExternalLink className="h-3.5 w-3.5" />
                            </button>
                            <button 
                              onClick={() => onDownloadFile(file.id, file.originalName)} 
                              className="p-1.5 text-green-600 hover:bg-green-50 rounded" 
                              title="Download"
                            >
                              <Download className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <p className="text-center text-gray-500 py-4">{filesSearch ? 'No files match your search' : 'No files in this session'}</p>
            )}
          </div>
          
          {/* Bottom Info */}
          {filesPaging && (
            <div className="px-4 py-3 border-t border-gray-100 flex items-center justify-between flex-shrink-0">
              <span className="text-xs text-gray-500">
                Showing {((filesPaging.page - 1) * filesPaging.limit) + 1} - {Math.min(filesPaging.page * filesPaging.limit, filesPaging.total)} of {filesPaging.total} files
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Basket Form Modal
function BasketFormModal({ title, formData, setFormData, onSubmit, onClose, saving, isCreate, sftpConnections = [], sftpConnectionsLoading = false }: any) {
  // For create mode: show type selection first, then show form based on selected type
  // For edit mode: show form based on existing type
  const [step, setStep] = useState<'type' | 'form'>(isCreate ? 'type' : 'form');

  // SFTP connection dropdown state
  const [sftpDropdownOpen, setSftpDropdownOpen] = useState(false);
  const sftpDropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (sftpDropdownRef.current && !sftpDropdownRef.current.contains(event.target as Node)) {
        setSftpDropdownOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);
  
  const handleTypeSelect = (type: 'batch' | 'shares' | 'sftp') => {
    setFormData({ ...formData, type });
    setStep('form');
  };
  
  const handleBackToType = () => {
    setStep('type');
  };
  
  // Type Selection Step (Create only) - Clean design without descriptions
  if (step === 'type' && isCreate) {
    return (
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
        <div className="bg-white rounded-xl w-full max-w-lg">
          <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
            <h3 className="text-lg font-semibold text-gray-900">Select Basket Type</h3>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X className="h-5 w-5" /></button>
          </div>
          <div className="p-6">
            <div className="space-y-3">
              {/* Batch Basket Option */}
              <button
                type="button"
                onClick={() => handleTypeSelect('batch')}
                className="w-full p-4 border-2 border-gray-200 rounded-xl hover:border-orange-500 hover:bg-orange-50 transition-all text-left flex items-center gap-4 group"
              >
                <div className="w-12 h-12 bg-orange-100 group-hover:bg-orange-500 rounded-xl flex items-center justify-center transition-colors">
                  <Package className="h-6 w-6 text-orange-600 group-hover:text-white transition-colors" />
                </div>
                <div>
                  <h4 className="text-base font-semibold text-gray-900">Batch Basket</h4>
                  <p className="text-sm text-gray-500">Processing sessions with auto-archive</p>
                </div>
              </button>
              
              {/* Shares Basket Option */}
              <button
                type="button"
                onClick={() => handleTypeSelect('shares')}
                className="w-full p-4 border-2 border-gray-200 rounded-xl hover:border-cyan-500 hover:bg-cyan-50 transition-all text-left flex items-center gap-4 group"
              >
                <div className="w-12 h-12 bg-cyan-100 group-hover:bg-cyan-500 rounded-xl flex items-center justify-center transition-colors">
                  <Folder className="h-6 w-6 text-cyan-600 group-hover:text-white transition-colors" />
                </div>
                <div>
                  <h4 className="text-base font-semibold text-gray-900">File Explorer</h4>
                  <p className="text-sm text-gray-500">ตะกร้าเอกสาร — โฟลเดอร์ อัปโหลด แชร์ให้ project อื่นได้</p>
                </div>
              </button>
              
              {/* SFTP Basket Option */}
              <button
                type="button"
                onClick={() => handleTypeSelect('sftp')}
                className="w-full p-4 border-2 border-gray-200 rounded-xl hover:border-purple-500 hover:bg-purple-50 transition-all text-left flex items-center gap-4 group"
              >
                <div className="w-12 h-12 bg-purple-100 group-hover:bg-purple-500 rounded-xl flex items-center justify-center transition-colors">
                  <Server className="h-6 w-6 text-purple-600 group-hover:text-white transition-colors" />
                </div>
                <div>
                  <h4 className="text-base font-semibold text-gray-900">SFTP Basket</h4>
                  <p className="text-sm text-gray-500">SFTP server directory for file transfers</p>
                </div>
              </button>
            </div>
          </div>
          <div className="px-6 py-4 border-t border-gray-200 flex justify-end">
            <button type="button" onClick={onClose} className="inline-flex items-center justify-center h-9 px-3 text-[14px] font-medium border border-gray-300 bg-white text-gray-700 rounded-lg hover:bg-gray-50 transition-colors whitespace-nowrap">Cancel</button>
          </div>
        </div>
      </div>
    );
  }
  
  // Form Step
  const isBatch = formData.type === 'batch';
  const isSftp = formData.type === 'sftp';
  
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl w-full max-w-2xl max-h-[90vh] overflow-auto">
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
          <div className="flex items-center gap-3">
            {isCreate && (
              <button 
                type="button" 
                onClick={handleBackToType}
                className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg"
              >
                <ArrowLeft className="h-5 w-5" />
              </button>
            )}
            <div>
              <h3 className="text-lg font-semibold text-gray-900">{title}</h3>
              <div className="flex items-center gap-2 mt-0.5">
                <span className={`text-xs px-2 py-0.5 rounded-full ${
                  isBatch ? 'bg-orange-100 text-orange-700' : 
                  isSftp ? 'bg-purple-100 text-purple-700' : 
                  'bg-cyan-100 text-cyan-700'
                }`}>
                  {isBatch ? 'Batch Basket' : isSftp ? 'SFTP Basket' : 'File Explorer'}
                </span>
              </div>
            </div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X className="h-5 w-5" /></button>
        </div>
        <form onSubmit={onSubmit} className="p-6 space-y-6">
          {/* SFTP Connection Selection */}
          {isSftp && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1 flex items-center gap-2">
                <Server className="h-4 w-4" />
                SFTP Connection
              </label>
              {sftpConnectionsLoading ? (
                <div className="flex items-center gap-2 px-4 py-3 border-2 border-gray-200 rounded-xl bg-gray-50 text-gray-500 text-sm">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading connections...
                </div>
              ) : sftpConnections.length === 0 ? (
                <div className="px-4 py-5 border-2 border-dashed border-gray-300 rounded-xl text-center">
                  <Server className="h-8 w-8 text-gray-300 mx-auto mb-2" />
                  <p className="text-sm text-gray-500 mb-2">No SFTP connections found</p>
                  <Link
                    to={`/projects/${formData.projectId}/connections`}
                    className="inline-flex items-center gap-1.5 text-sm text-purple-600 hover:text-purple-700 font-medium"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Create SFTP Connection
                  </Link>
                </div>
              ) : (
                <div className="relative" ref={sftpDropdownRef}>
                  {/* Trigger Button */}
                  <button
                    type="button"
                    onClick={() => setSftpDropdownOpen(!sftpDropdownOpen)}
                    className={`w-full flex items-center justify-between px-3 py-2 bg-white border rounded-lg text-sm transition-all duration-200 ${
                      sftpDropdownOpen
                        ? 'border-purple-500 ring-2 ring-purple-100'
                        : 'border-gray-300 hover:border-purple-300'
                    }`}
                  >
                    {formData.sftpConnectionId ? (
                      (() => {
                        const selected = sftpConnections.find((c: any) => c.id === formData.sftpConnectionId);
                        if (!selected) return <span className="text-gray-400">Select SFTP connection...</span>;
                        const host = selected.config?.host || '';
                        const port = selected.config?.port || 22;
                        const username = selected.config?.username || '';
                        const detail = host ? ` — ${username ? username + '@' : ''}${host}:${port}` : '';
                        return (
                          <span className="text-gray-900 truncate">{selected.name}<span className="text-gray-400 font-normal">{detail}</span></span>
                        );
                      })()
                    ) : (
                      <span className="text-gray-400">Select SFTP connection...</span>
                    )}
                    <ChevronDown className={`h-4 w-4 text-gray-400 transition-transform duration-200 flex-shrink-0 ml-2 ${sftpDropdownOpen ? 'rotate-180' : ''}`} />
                  </button>

                  {/* Dropdown Menu */}
                  {sftpDropdownOpen && (
                    <div className="absolute z-[100] w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg overflow-hidden">
                      <div className="max-h-48 overflow-y-auto py-1">
                        {sftpConnections.map((conn: any) => {
                          const isSelected = formData.sftpConnectionId === conn.id;
                          const host = conn.config?.host || '';
                          const port = conn.config?.port || 22;
                          const username = conn.config?.username || '';
                          return (
                            <button
                              key={conn.id}
                              type="button"
                              onClick={() => {
                                setFormData({ ...formData, sftpConnectionId: conn.id });
                                setSftpDropdownOpen(false);
                              }}
                              className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left transition-colors ${
                                isSelected
                                  ? 'bg-purple-50 text-purple-900'
                                  : 'hover:bg-gray-50 text-gray-700'
                              }`}
                            >
                              <Server className={`h-3.5 w-3.5 flex-shrink-0 ${isSelected ? 'text-purple-500' : 'text-gray-400'}`} />
                              <span className="flex-1 truncate font-medium">{conn.name}</span>
                              {host && (
                                <span className="text-xs text-gray-400 truncate max-w-[40%]">
                                  {username ? `${username}@` : ''}{host}:{port}
                                </span>
                              )}
                              {conn.lastTestStatus === 'success' && (
                                <CheckCircle className="h-3 w-3 text-green-500 flex-shrink-0" />
                              )}
                              {isSelected && (
                                <svg className="w-3.5 h-3.5 text-purple-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                                </svg>
                              )}
                            </button>
                          );
                        })}
                      </div>
                      <div className="border-t border-gray-100 px-3 py-1.5">
                        <Link
                          to={`/projects/${formData.projectId}/connections`}
                          className="inline-flex items-center gap-1 text-xs text-purple-600 hover:text-purple-700 font-medium"
                        >
                          <Plus className="h-3 w-3" />
                          Manage Connections
                        </Link>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          {/* Common Fields */}
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Name <span className="text-red-500">*</span></label>
              <input 
                type="text" 
                required 
                value={formData.name} 
                onChange={(e) => setFormData({ ...formData, name: e.target.value })} 
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500" 
                placeholder={isBatch ? "e.g., Incoming Invoices" : "e.g., Shared Documents"} 
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
              <textarea 
                value={formData.description} 
                onChange={(e) => setFormData({ ...formData, description: e.target.value })} 
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 resize-none" 
                rows={2}
                placeholder={isBatch ? "Describe the batch processing workflow..." : "Describe the shared folder purpose..."}
              />
            </div>
          </div>
          
          {/* Batch-specific Settings */}
          {isBatch && (
            <div className="border-t border-gray-200 pt-6">
              <h4 className="font-medium text-gray-900 mb-4 flex items-center gap-2">
                <Settings2 className="h-4 w-4" />
                Session & Processing Settings
              </h4>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Session Naming Pattern</label>
                  <input 
                    type="text" 
                    value={formData.sessionPattern} 
                    onChange={(e) => setFormData({ ...formData, sessionPattern: e.target.value })} 
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500" 
                    placeholder="Batch-{YYYYMMDD}-{NNN}" 
                  />
                  <p className="text-xs text-gray-500 mt-1">Variables: {'{YYYY}'}, {'{YYYY+543}'}, {'{MM}'}, {'{DD}'}, {'{YYYYMMDD}'}, {'{N}'}, {'{NN}'}, {'{NNN}'}</p>
                </div>
                <div className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                  <div>
                    <span className="font-medium text-gray-900">Auto Archive to ZIP</span>
                    <p className="text-sm text-gray-500">Create ZIP when session is published</p>
                  </div>
                  <button 
                    type="button" 
                    onClick={() => setFormData({ ...formData, autoArchive: !formData.autoArchive })} 
                    className={`relative inline-flex h-6 w-11 items-center rounded-full ${formData.autoArchive ? 'bg-blue-600' : 'bg-gray-200'}`}
                  >
                    <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition ${formData.autoArchive ? 'translate-x-6' : 'translate-x-1'}`} />
                  </button>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Auto Publish Mode</label>
                  <select 
                    value={formData.autoPublish} 
                    onChange={(e) => setFormData({ ...formData, autoPublish: e.target.value })} 
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="manual">Manual - Click Publish button</option>
                    <option value="immediate">Immediate - Auto publish on upload</option>
                    <option value="threshold">Threshold - Publish when file count reached</option>
                  </select>
                </div>
                {formData.autoPublish === 'threshold' && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">File Threshold</label>
                    <input 
                      type="number" 
                      value={formData.autoPublishThreshold} 
                      onChange={(e) => setFormData({ ...formData, autoPublishThreshold: e.target.value })} 
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500" 
                      placeholder="100" 
                    />
                  </div>
                )}
              </div>
            </div>
          )}
          
          {/* Shares Basket - no special settings, just validation rules below */}
          
          {/* Validation Rules (Common) */}
          <div className="border-t border-gray-200 pt-6">
            <h4 className="font-medium text-gray-900 mb-4">Validation Rules (Optional)</h4>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Max Files</label>
                <input 
                  type="number" 
                  value={formData.maxFiles} 
                  onChange={(e) => setFormData({ ...formData, maxFiles: e.target.value })} 
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg" 
                  placeholder="Unlimited" 
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Max Size (MB)</label>
                <input 
                  type="number" 
                  value={formData.maxFileSize} 
                  onChange={(e) => setFormData({ ...formData, maxFileSize: e.target.value })} 
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg" 
                  placeholder="Unlimited" 
                />
              </div>
            </div>
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">Allowed File Types</label>
              <input 
                type="text" 
                value={formData.allowedTypes} 
                onChange={(e) => setFormData({ ...formData, allowedTypes: e.target.value })} 
                className="w-full px-3 py-2 border border-gray-300 rounded-lg" 
                placeholder="image/*, application/pdf" 
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Naming Pattern (Regex)</label>
              <input 
                type="text" 
                value={formData.namingPattern} 
                onChange={(e) => setFormData({ ...formData, namingPattern: e.target.value })} 
                className="w-full px-3 py-2 border border-gray-300 rounded-lg font-mono text-sm" 
                placeholder="^[A-Z]{3}-\d{4}\.pdf$" 
              />
            </div>
          </div>
          <div className="flex justify-end gap-3 pt-4 border-t border-gray-200">
            <button type="button" onClick={onClose} className="inline-flex items-center justify-center h-9 px-3 text-[14px] font-medium border border-gray-300 bg-white text-gray-700 rounded-lg hover:bg-gray-50 transition-colors whitespace-nowrap">Cancel</button>
            <button type="submit" disabled={saving || !formData.name.trim()} className="inline-flex items-center justify-center px-3 h-9 rounded-lg disabled:opacity-50 whitespace-nowrap bg-blue-600 text-white hover:bg-blue-700">
              {saving ? 'Saving...' : isCreate ? 'Create Basket' : 'Update Basket'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default ProjectBaskets;
