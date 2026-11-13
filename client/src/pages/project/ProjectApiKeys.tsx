import { useState, useEffect } from 'react';
import { Key, Copy, Plus, Trash2, Eye, EyeOff, Shield, Server, Webhook, Globe, History, Lock, ChevronLeft, ChevronRight, AlertCircle, X, Download, Upload, FileKey, ShieldCheck, Fingerprint } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { API_URL, apiFetch } from '../../config/api';

interface ApiKey {
  id: string;
  name: string;
  key: string;
  type: 'client' | 'server' | 'webhook' | 'service';
  scopes: string[];
  isActive: boolean;
  validateIp: boolean;
  ipWhitelist: string[];
  rateLimit?: number;
  lastUsedAt?: string;
  expiresAt?: string;
  createdAt: string;
}

interface EncryptionKey {
  id: string;
  name: string;
  algorithm: string;
  keyFormat?: string;
  publicKeyPreview?: string;
  fingerprint?: string;
  description?: string;
  isActive: boolean;
  createdAt: string;
  hasPrivateKey?: boolean;
}

interface Project {
  id: string;
  name: string;
}

const keyTypeConfig = {
  client: { label: 'Client Key', icon: Globe, color: 'text-blue-600', bg: 'bg-blue-100', desc: 'For frontend/mobile apps (Bearer token)' },
  server: { label: 'Server Key', icon: Server, color: 'text-purple-600', bg: 'bg-purple-100', desc: 'For backend services (HMAC signed)' },
  webhook: { label: 'Webhook Key', icon: Webhook, color: 'text-orange-600', bg: 'bg-orange-100', desc: 'For webhook receivers' },
  service: { label: 'Service Key', icon: Shield, color: 'text-green-600', bg: 'bg-green-100', desc: 'For microservices (Bearer token)' },
};

export const ProjectApiKeys = ({ project }: { project: Project }) => {
  // Tab state
  const [activeMainTab, setActiveMainTab] = useState<'api-keys' | 'encryption-keys'>('api-keys');

  // API Keys state
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newKeyData, setNewKeyData] = useState({
    name: '',
    type: 'client' as const,
    scopes: ['read'],
    validateIp: false,
    ipWhitelist: '',
    rateLimit: '',
  });
  const [showKeyId, setShowKeyId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [newlyCreatedKey, setNewlyCreatedKey] = useState<any>(null);
  const [_activeTab] = useState<'keys' | 'audit'>('keys');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [keyToDelete, setKeyToDelete] = useState<ApiKey | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [auditLogs, setAuditLogs] = useState<any[]>([]);
  const [auditLogsPage, setAuditLogsPage] = useState(1);
  const [auditLogsTotal, setAuditLogsTotal] = useState(0);
  const [auditLogsTotalPages, setAuditLogsTotalPages] = useState(1);
  const AUDIT_LOGS_PER_PAGE = 20;

  // Encryption Keys state
  const [encryptionKeys, setEncryptionKeys] = useState<EncryptionKey[]>([]);
  const [encryptionLoading, setEncryptionLoading] = useState(false);
  const [showGenerateModal, setShowGenerateModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [showDeleteEncKeyModal, setShowDeleteEncKeyModal] = useState(false);
  const [encKeyToDelete, setEncKeyToDelete] = useState<EncryptionKey | null>(null);
  const [isDeletingEncKey, setIsDeletingEncKey] = useState(false);
  const [generateForm, setGenerateForm] = useState({
    name: '',
    algorithm: 'PGP',
    passphrase: '',
    description: '',
    keySize: 4096 as number,
  });
  const [importForm, setImportForm] = useState({
    name: '',
    algorithm: 'PGP',
    publicKey: '',
    secretKey: '',
    passphrase: '',
    keyFormat: '',
    description: '',
  });
  const [isGenerating, setIsGenerating] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [showDownloadModal, setShowDownloadModal] = useState(false);
  const [downloadTarget, setDownloadTarget] = useState<EncryptionKey | null>(null);
  const [downloadPassword, setDownloadPassword] = useState('');
  const [showDownloadPassword, setShowDownloadPassword] = useState(false);

  useEffect(() => {
    fetchApiKeys();
  }, [project.id]);

  useEffect(() => {
    if (activeMainTab === 'encryption-keys' && encryptionKeys.length === 0 && !encryptionLoading) {
      fetchEncryptionKeys();
    }
  }, [activeMainTab, project.id]);

  const fetchApiKeys = async () => {
    try {
      const response = await fetch(`${API_URL}/projects/${project.id}/api-keys`);
      const result = await response.json();
      if (result.success) {
        setApiKeys(result.data);
      }
    } catch (error) {
      console.error('Error fetching API keys:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchEncryptionKeys = async () => {
    setEncryptionLoading(true);
    try {
      const response = await fetch(`${API_URL}/projects/${project.id}/secrets`);
      const result = await response.json();
      if (result.success) {
        // Filter only encryption keys (not API keys)
        const encKeys = (result.data || []).filter((s: any) => s.keyCategory === 'encryption-key' || s.type === 'encryption' || s.algorithm);
        setEncryptionKeys(encKeys);
      }
    } catch (error) {
      console.error('Error fetching encryption keys:', error);
    } finally {
      setEncryptionLoading(false);
    }
  };

  const fetchAuditLogs = async (keyId: string, page = 1) => {
    try {
      const response = await fetch(
        `${API_URL}/projects/${project.id}/api-keys/${keyId}/audit-logs?limit=${AUDIT_LOGS_PER_PAGE}&page=${page}`
      );
      const result = await response.json();
      if (result.success) {
        setAuditLogs(result.data);
        setAuditLogsPage(result.pagination?.page || 1);
        setAuditLogsTotal(result.pagination?.total || 0);
        setAuditLogsTotalPages(result.pagination?.totalPages || 1);
      }
    } catch (error) {
      console.error('Error fetching audit logs:', error);
    }
  };

  const createApiKey = async () => {
    if (!newKeyData.name.trim()) return;

    try {
      const response = await fetch(`${API_URL}/projects/${project.id}/api-keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newKeyData.name,
          type: newKeyData.type,
          scopes: newKeyData.scopes,
          validateIp: newKeyData.validateIp,
          ipWhitelist: newKeyData.ipWhitelist.split(',').map(ip => ip.trim()).filter(Boolean),
          rateLimit: newKeyData.rateLimit ? parseInt(newKeyData.rateLimit) : null,
        }),
      });
      const result = await response.json();
      if (result.success) {
        setNewlyCreatedKey(result.data);
        setApiKeys([{ ...result.data, isActive: true }, ...apiKeys]);
        setShowCreateModal(false);
        setNewKeyData({
          name: '',
          type: 'client',
          scopes: ['read'],
          validateIp: false,
          ipWhitelist: '',
          rateLimit: '',
        });
      }
    } catch (error) {
      console.error('Error creating API key:', error);
    }
  };

  const handleDeleteApiKey = async () => {
    if (!keyToDelete) return;

    setIsDeleting(true);
    try {
      const response = await apiFetch(`${API_URL}/projects/${project.id}/api-keys/${keyToDelete.id}`, {
        method: 'DELETE',
      });
      const result = await response.json();
      if (result.success) {
        setApiKeys(apiKeys.filter(k => k.id !== keyToDelete.id));
        setShowDeleteModal(false);
        setKeyToDelete(null);
      } else {
        alert(result.error || 'Failed to delete API key');
      }
    } catch (error) {
      console.error('Error deleting API key:', error);
      alert('Failed to delete API key');
    } finally {
      setIsDeleting(false);
    }
  };

  const handleDeleteClick = (apiKey: ApiKey) => {
    setKeyToDelete(apiKey);
    setShowDeleteModal(true);
  };

  const toggleActive = async (key: ApiKey) => {
    try {
      const response = await apiFetch(`${API_URL}/projects/${project.id}/api-keys/${key.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: !key.isActive }),
      });
      if (response.ok) {
        setApiKeys(apiKeys.map(k => k.id === key.id ? { ...k, isActive: !k.isActive } : k));
      }
    } catch (error) {
      console.error('Error updating API key:', error);
    }
  };

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const formatDate = (dateStr?: string) => {
    if (!dateStr) return 'Never';
    return new Date(dateStr).toLocaleString();
  };

  const getKeyTypeBadge = (type: string) => {
    const config = keyTypeConfig[type as keyof typeof keyTypeConfig];
    const Icon = config.icon;
    return (
      <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${config.bg} ${config.color}`}>
        <Icon className="h-3 w-3" />
        {config.label}
      </span>
    );
  };

  // Encryption Key handlers
  const handleGenerateKeyPair = async () => {
    if (!generateForm.name.trim()) return;
    setIsGenerating(true);
    try {
      const response = await fetch(`${API_URL}/projects/${project.id}/secrets/generate-keypair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: generateForm.name,
          algorithm: generateForm.algorithm === 'AES' ? `aes-${generateForm.keySize || 256}-gcm` : generateForm.algorithm.toLowerCase(),
          passphrase: generateForm.passphrase || undefined,
          description: generateForm.description || undefined,
          keySize: generateForm.keySize || 4096,
        }),
      });
      const result = await response.json();
      if (result.success) {
        setShowGenerateModal(false);
        setGenerateForm({ name: '', algorithm: 'PGP', passphrase: '', description: '', keySize: 4096 });
        fetchEncryptionKeys();
      } else {
        alert(result.error || 'Failed to generate key pair');
      }
    } catch (error) {
      console.error('Error generating key pair:', error);
      alert('Failed to generate key pair');
    } finally {
      setIsGenerating(false);
    }
  };

  const handleImportKey = async () => {
    if (!importForm.name.trim() || !importForm.publicKey.trim()) return;
    setIsImporting(true);
    try {
      const response = await apiFetch(`${API_URL}/projects/${project.id}/secrets/import-key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: importForm.name,
          algorithm: importForm.algorithm.toLowerCase(),
          publicKey: importForm.publicKey,
          secretKey: importForm.secretKey.trim() || undefined,
          passphrase: importForm.passphrase || undefined,
          keyFormat: importForm.keyFormat || undefined,
          description: importForm.description || undefined,
        }),
      });
      const result = await response.json();
      if (result.success) {
        setShowImportModal(false);
        setImportForm({ name: '', algorithm: 'PGP', publicKey: '', secretKey: '', passphrase: '', keyFormat: '', description: '' });
        fetchEncryptionKeys();
      } else {
        alert(result.error || 'Failed to import key');
      }
    } catch (error) {
      console.error('Error importing key:', error);
      alert('Failed to import key');
    } finally {
      setIsImporting(false);
    }
  };

  const handleDownloadPublicKey = (encKey: EncryptionKey) => {
    setDownloadTarget(encKey);
    setDownloadPassword('');
    setShowDownloadPassword(false);
    setShowDownloadModal(true);
  };

  const executeDownload = async (useZip: boolean) => {
    if (!downloadTarget) return;
    try {
      let url = `${API_URL}/projects/${project.id}/secrets/${downloadTarget.id}/public-key`;
      if (useZip && downloadPassword) {
        url += `?password=${encodeURIComponent(downloadPassword)}`;
      }
      const response = await fetch(url);
      if (response.ok) {
        const blob = await response.blob();
        const blobUrl = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        const safeName = downloadTarget.name.toLowerCase().replace(/[^a-z0-9-_]/g, '-');
        const keyExt = downloadTarget.algorithm === 'PGP' ? 'asc' : 'pem';
        a.download = useZip && downloadPassword
          ? `${safeName}-public.zip`
          : `${safeName}-public.${keyExt}`;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(blobUrl);
        document.body.removeChild(a);
        setShowDownloadModal(false);
      } else {
        const result = await response.json();
        alert(result.error || 'Failed to download public key');
      }
    } catch (error) {
      console.error('Error downloading public key:', error);
      alert('Failed to download public key');
    }
  };

  const handleDeleteEncKey = async () => {
    if (!encKeyToDelete) return;
    setIsDeletingEncKey(true);
    try {
      const response = await apiFetch(`${API_URL}/projects/${project.id}/secrets/${encKeyToDelete.id}`, {
        method: 'DELETE',
      });
      const result = await response.json();
      if (result.success) {
        setEncryptionKeys(encryptionKeys.filter(k => k.id !== encKeyToDelete.id));
        setShowDeleteEncKeyModal(false);
        setEncKeyToDelete(null);
      } else {
        alert(result.error || 'Failed to delete encryption key');
      }
    } catch (error) {
      console.error('Error deleting encryption key:', error);
      alert('Failed to delete encryption key');
    } finally {
      setIsDeletingEncKey(false);
    }
  };

  const toggleEncKeyActive = async (encKey: EncryptionKey) => {
    try {
      const response = await apiFetch(`${API_URL}/projects/${project.id}/secrets/${encKey.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: !encKey.isActive }),
      });
      if (response.ok) {
        setEncryptionKeys(encryptionKeys.map(k => k.id === encKey.id ? { ...k, isActive: !k.isActive } : k));
      }
    } catch (error) {
      console.error('Error updating encryption key:', error);
    }
  };

  if (loading) {
    return (
      <div className="p-6 flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6">
      {/* Tabs */}
      <div className="flex items-center gap-1 mb-4 border-b border-gray-200">
        <button
          onClick={() => setActiveMainTab('api-keys')}
          className={`flex items-center gap-1.5 px-3 py-2 text-[13px] font-medium border-b-2 transition-colors -mb-px whitespace-nowrap ${
            activeMainTab === 'api-keys'
              ? 'border-blue-500 text-blue-600'
              : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
          }`}
        >
          <Key className="h-4 w-4" />
          API Keys
        </button>
        <button
          onClick={() => setActiveMainTab('encryption-keys')}
          className={`flex items-center gap-1.5 px-3 py-2 text-[13px] font-medium border-b-2 transition-colors -mb-px whitespace-nowrap ${
            activeMainTab === 'encryption-keys'
              ? 'border-emerald-500 text-emerald-600'
              : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
          }`}
        >
          <FileKey className="h-4 w-4" />
          Encryption Keys
        </button>
      </div>

      {/* ===== API Keys Tab ===== */}
      {activeMainTab === 'api-keys' && (
        <>
          {/* Header */}
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-gray-900">API Keys</h2>
              <p className="text-xs sm:text-sm text-gray-500">
                Manage API keys for accessing project endpoints
              </p>
            </div>
            <button
              onClick={() => setShowCreateModal(true)}
              className="self-start sm:self-auto shrink-0 whitespace-nowrap flex items-center gap-1.5 h-9 px-3 text-[14px] bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors"
            >
              <Plus className="h-4 w-4" />
              Create API Key
            </button>
          </div>

          {/* Features Supported */}
          <div className="hidden sm:flex mb-4 flex-wrap items-center gap-3 text-xs text-gray-500">
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-green-500"></span>
              Bearer Token
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-purple-500"></span>
              HMAC Signature
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-blue-500"></span>
              IP Whitelist (CIDR)
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-orange-500"></span>
              Scoped Permissions
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-red-500"></span>
              Audit Logs
            </span>
          </div>

          {/* Newly Created Key Alert */}
          {newlyCreatedKey && (
            <div className="mb-6 p-4 bg-amber-50 border border-amber-200 rounded-xl">
              <div className="flex items-start gap-3">
                <Key className="h-5 w-5 text-amber-600 mt-0.5" />
                <div className="flex-1">
                  <h3 className="font-medium text-amber-900">API Key Created!</h3>
                  <p className="text-sm text-amber-700 mt-1">
                    Copy your key now. The {newlyCreatedKey.secretKey ? 'secret key ' : ''}will not be shown again.
                  </p>

                  <div className="mt-3 space-y-2">
                    <div className="bg-white border border-amber-300 rounded-lg px-3 py-2 font-mono text-sm flex items-center justify-between">
                      <span className="truncate">{newlyCreatedKey.key}</span>
                      <button
                        onClick={() => copyToClipboard(newlyCreatedKey.key, 'new-key')}
                        className="ml-2 p-1 text-amber-600 hover:bg-amber-100 rounded"
                      >
                        {copiedId === 'new-key' ? 'Copied!' : <Copy className="h-4 w-4" />}
                      </button>
                    </div>

                    {newlyCreatedKey.secretKey && (
                      <div className="bg-white border border-amber-300 rounded-lg px-3 py-2 font-mono text-sm flex items-center justify-between">
                        <span className="truncate text-purple-700">{newlyCreatedKey.secretKey}</span>
                        <button
                          onClick={() => copyToClipboard(newlyCreatedKey.secretKey, 'new-secret')}
                          className="ml-2 p-1 text-amber-600 hover:bg-amber-100 rounded"
                        >
                          {copiedId === 'new-secret' ? 'Copied!' : <Copy className="h-4 w-4" />}
                        </button>
                      </div>
                    )}
                  </div>

                  <button
                    onClick={() => setNewlyCreatedKey(null)}
                    className="mt-3 text-sm text-amber-700 hover:text-amber-900 underline"
                  >
                    I have copied the key(s)
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* API Keys List */}
          {apiKeys.length > 0 ? (
            <div className="space-y-3">
              {apiKeys.map((apiKey) => {
                const config = keyTypeConfig[apiKey.type];
                const Icon = config.icon;

                return (
                  <div
                    key={apiKey.id}
                    className={`bg-white border rounded-lg p-3 transition-colors ${
                      apiKey.isActive ? 'border-gray-200 hover:border-gray-300' : 'border-gray-200 bg-gray-50 opacity-60'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        {/* Row 1: Icon + Name + Badges */}
                        <div className="flex items-center gap-2">
                          <div className={`p-1.5 rounded-md ${config.bg}`}>
                            <Icon className={`h-3.5 w-3.5 ${config.color}`} />
                          </div>
                          <h3 className="font-medium text-sm text-gray-900 truncate">{apiKey.name}</h3>
                          {apiKey.isActive ? (
                            <span className="px-1.5 py-0.5 bg-green-100 text-green-700 text-[10px] rounded-full">
                              Active
                            </span>
                          ) : (
                            <span className="px-1.5 py-0.5 bg-gray-100 text-gray-600 text-[10px] rounded-full">
                              Inactive
                            </span>
                          )}
                        </div>

                        {/* Row 2: Type Badge + Scopes */}
                        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                          {getKeyTypeBadge(apiKey.type)}
                          {apiKey.scopes.map(scope => (
                            <span key={scope} className="px-1.5 py-0.5 bg-gray-100 text-gray-600 text-[10px] rounded">
                              {scope}
                            </span>
                          ))}
                          {apiKey.validateIp && (
                            <span className="flex items-center gap-0.5 px-1.5 py-0.5 bg-purple-50 text-purple-700 text-[10px] rounded">
                              <Lock className="h-2.5 w-2.5" />
                              IP
                            </span>
                          )}
                          {apiKey.rateLimit && (
                            <span className="px-1.5 py-0.5 bg-orange-50 text-orange-700 text-[10px] rounded">
                              {apiKey.rateLimit}/min
                            </span>
                          )}
                        </div>

                        {/* Row 3: Key Display */}
                        <div className="mt-2 flex items-center gap-1.5">
                          <div className="flex-1 bg-gray-100 rounded-md px-2 py-1.5 font-mono text-xs text-gray-600 flex items-center gap-1.5 min-w-0">
                            <Key className="h-3 w-3 text-gray-400 flex-shrink-0" />
                            {showKeyId === apiKey.id ? (
                              <span className="text-gray-800 truncate">{apiKey.key}</span>
                            ) : (
                              <span>••••••••••••••••••</span>
                            )}
                          </div>
                          <button
                            onClick={() => setShowKeyId(showKeyId === apiKey.id ? null : apiKey.id)}
                            className="p-1.5 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-md transition-colors"
                            title={showKeyId === apiKey.id ? 'Hide' : 'Show'}
                          >
                            {showKeyId === apiKey.id ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                          </button>
                          <button
                            onClick={() => copyToClipboard(apiKey.key, apiKey.id)}
                            className="p-1.5 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-md transition-colors"
                            title="Copy"
                          >
                            {copiedId === apiKey.id ? (
                              <span className="text-green-600 text-[10px] font-medium">✓</span>
                            ) : (
                              <Copy className="h-3.5 w-3.5" />
                            )}
                          </button>
                        </div>

                        {/* Row 4: Meta Info */}
                        <div className="mt-1.5 flex items-center gap-3 text-[10px] text-gray-400">
                          <span>Created {new Date(apiKey.createdAt).toLocaleString('en-GB', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}</span>
                          {apiKey.lastUsedAt && (
                            <span>Used {new Date(apiKey.lastUsedAt).toLocaleString('en-GB', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}</span>
                          )}
                          {apiKey.expiresAt && (
                            <span className="text-amber-600">
                              Expires: {formatDate(apiKey.expiresAt)}
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Actions */}
                      <div className="flex items-center gap-0.5 shrink-0">
                        <button
                          onClick={() => {
                            setSelectedKey(apiKey.id);
                            fetchAuditLogs(apiKey.id);
                          }}
                          className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-md transition-colors"
                          title="Audit Logs"
                        >
                          <History className="h-3.5 w-3.5" />
                        </button>
                        <button
                          onClick={() => toggleActive(apiKey)}
                          className={`p-1.5 rounded-md transition-colors ${
                            apiKey.isActive
                              ? 'text-green-500 hover:text-green-600 hover:bg-green-50'
                              : 'text-gray-300 hover:text-gray-500 hover:bg-gray-100'
                          }`}
                          title={apiKey.isActive ? 'Deactivate' : 'Activate'}
                        >
                          <Shield className="h-3.5 w-3.5" />
                        </button>
                        <button
                          onClick={() => handleDeleteClick(apiKey)}
                          className="p-1.5 text-red-400 hover:text-red-600 hover:bg-red-50 rounded-md transition-colors"
                          title="Delete"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="text-center py-12 bg-gray-50 rounded-xl border border-dashed border-gray-300">
              <Key className="h-12 w-12 text-gray-300 mx-auto mb-4" />
              <h3 className="text-lg font-medium text-gray-900 mb-2">No API keys yet</h3>
              <p className="text-gray-500 mb-4">
                Create an API key to start making authenticated requests
              </p>
              <button
                onClick={() => setShowCreateModal(true)}
                className="inline-flex items-center justify-center px-3.5 h-9 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors whitespace-nowrap"
              >
                Create API Key
              </button>
            </div>
          )}
        </>
      )}

      {/* ===== Encryption Keys Tab ===== */}
      {activeMainTab === 'encryption-keys' && (
        <>
          {/* Header */}
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-gray-900">Encryption Keys</h2>
              <p className="text-xs sm:text-sm text-gray-500">
                Manage PGP/RSA key pairs for encrypting and signing data
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={() => setShowImportModal(true)}
                className="whitespace-nowrap flex items-center gap-1.5 h-9 px-3 text-[14px] bg-white border border-emerald-300 text-emerald-700 rounded-lg hover:bg-emerald-50 transition-colors"
              >
                <Upload className="h-4 w-4" />
                Import Public Key
              </button>
              <button
                onClick={() => setShowGenerateModal(true)}
                className="whitespace-nowrap flex items-center gap-1.5 h-9 px-3 text-[14px] bg-emerald-500 text-white rounded-lg hover:bg-emerald-600 transition-colors"
              >
                <Plus className="h-4 w-4" />
                Generate Key Pair
              </button>
            </div>
          </div>

          {/* Features */}
          <div className="hidden sm:flex mb-4 flex-wrap items-center gap-3 text-xs text-gray-500">
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
              PGP Encryption
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-green-500"></span>
              RSA Key Pairs
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-teal-500"></span>
              Public Key Download
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-cyan-500"></span>
              Key Import
            </span>
          </div>

          {encryptionLoading ? (
            <div className="flex items-center justify-center h-40">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-emerald-500"></div>
            </div>
          ) : encryptionKeys.length > 0 ? (
            <div className="space-y-3">
              {encryptionKeys.map((encKey) => (
                <div
                  key={encKey.id}
                  className={`bg-white border rounded-lg p-3 transition-colors ${
                    encKey.isActive ? 'border-gray-200 hover:border-emerald-200' : 'border-gray-200 bg-gray-50 opacity-60'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      {/* Row 1: Icon + Name + Status */}
                      <div className="flex items-center gap-2">
                        <div className="p-1.5 rounded-md bg-emerald-100">
                          <FileKey className="h-3.5 w-3.5 text-emerald-600" />
                        </div>
                        <h3 className="font-medium text-sm text-gray-900 truncate">{encKey.name}</h3>
                        {encKey.isActive ? (
                          <span className="px-1.5 py-0.5 bg-emerald-100 text-emerald-700 text-[10px] rounded-full">
                            Active
                          </span>
                        ) : (
                          <span className="px-1.5 py-0.5 bg-gray-100 text-gray-600 text-[10px] rounded-full">
                            Inactive
                          </span>
                        )}
                      </div>

                      {/* Row 2: Algorithm + Format badges */}
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-100 text-emerald-700">
                          <ShieldCheck className="h-3 w-3" />
                          {encKey.algorithm}
                        </span>
                        {encKey.keyFormat && (
                          <span className="px-1.5 py-0.5 bg-gray-100 text-gray-600 text-[10px] rounded">
                            {encKey.keyFormat}
                          </span>
                        )}
                        {/* Private Key indicator — only for asymmetric keys */}
                        {encKey.algorithm && !encKey.algorithm.startsWith('aes') && (
                          encKey.hasPrivateKey ? (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-100 text-blue-700" title="Private key stored in system">
                              <Lock className="h-3 w-3" />
                              มี Private Key
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 text-amber-700" title="No private key — encrypt only">
                              <Lock className="h-3 w-3" />
                              Public Only
                            </span>
                          )
                        )}
                        {encKey.description && (
                          <span className="px-1.5 py-0.5 bg-gray-50 text-gray-500 text-[10px] rounded italic">
                            {encKey.description}
                          </span>
                        )}
                      </div>

                      {/* Row 3: Fingerprint / Public Key Preview */}
                      {(encKey.fingerprint || encKey.publicKeyPreview) && <div className="mt-2 flex items-center gap-1.5">
                        <div className="flex-1 bg-gray-100 rounded-md px-2 py-1.5 font-mono text-xs text-gray-600 flex items-center gap-1.5 min-w-0">
                          <Fingerprint className="h-3 w-3 text-gray-400 flex-shrink-0" />
                          <span className="truncate">
                            {encKey.fingerprint || encKey.publicKeyPreview}
                          </span>
                        </div>
                      </div>}

                      {/* Row 4: Meta Info */}
                      <div className="mt-1.5 flex items-center gap-3 text-[10px] text-gray-400">
                        <span>Created {new Date(encKey.createdAt).toLocaleString('en-GB', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}</span>
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-0.5 shrink-0">
                      <button
                        onClick={() => handleDownloadPublicKey(encKey)}
                        className="p-1.5 text-emerald-400 hover:text-emerald-600 hover:bg-emerald-50 rounded-md transition-colors"
                        title="Download Public Key"
                      >
                        <Download className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => toggleEncKeyActive(encKey)}
                        className={`p-1.5 rounded-md transition-colors ${
                          encKey.isActive
                            ? 'text-emerald-500 hover:text-emerald-600 hover:bg-emerald-50'
                            : 'text-gray-300 hover:text-gray-500 hover:bg-gray-100'
                        }`}
                        title={encKey.isActive ? 'Deactivate' : 'Activate'}
                      >
                        <ShieldCheck className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => {
                          setEncKeyToDelete(encKey);
                          setShowDeleteEncKeyModal(true);
                        }}
                        className="p-1.5 text-red-400 hover:text-red-600 hover:bg-red-50 rounded-md transition-colors"
                        title="Delete"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-12 bg-gray-50 rounded-xl border border-dashed border-emerald-300">
              <FileKey className="h-12 w-12 text-emerald-300 mx-auto mb-4" />
              <h3 className="text-lg font-medium text-gray-900 mb-2">No encryption keys yet</h3>
              <p className="text-gray-500 mb-4">
                Generate a key pair or import a public key to get started
              </p>
              <div className="flex items-center justify-center gap-3">
                <button
                  onClick={() => setShowImportModal(true)}
                  className="inline-flex items-center justify-center px-3.5 h-9 bg-white border border-emerald-300 text-emerald-700 rounded-lg hover:bg-emerald-50 transition-colors whitespace-nowrap"
                >
                  Import Public Key
                </button>
                <button
                  onClick={() => setShowGenerateModal(true)}
                  className="inline-flex items-center justify-center px-3.5 h-9 bg-emerald-500 text-white rounded-lg hover:bg-emerald-600 transition-colors whitespace-nowrap"
                >
                  Generate Key Pair
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {/* ===== Modals ===== */}

      {/* Create API Key Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">Create New API Key</h3>

            <div className="space-y-4">
              {/* Key Name */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Key Name *
                </label>
                <input
                  type="text"
                  value={newKeyData.name}
                  onChange={(e) => setNewKeyData({ ...newKeyData, name: e.target.value })}
                  placeholder="e.g., Production API Key"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  autoFocus
                />
              </div>

              {/* Key Type */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Key Type
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {Object.entries(keyTypeConfig).map(([type, config]) => {
                    const Icon = config.icon;
                    return (
                      <button
                        key={type}
                        onClick={() => setNewKeyData({ ...newKeyData, type: type as any })}
                        className={`px-3 py-2 rounded-lg border text-left transition-colors min-w-0 ${
                          newKeyData.type === type
                            ? 'border-blue-500 bg-blue-50'
                            : 'border-gray-200 hover:border-gray-300'
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <Icon className={`h-4 w-4 ${config.color}`} />
                          <span className="font-medium text-sm">{config.label}</span>
                        </div>
                        <p className="text-xs text-gray-500 mt-1">{config.desc}</p>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Scopes */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Permissions (Scopes)
                </label>
                <div className="flex flex-wrap gap-2">
                  {['read', 'write', 'delete', 'admin'].map(scope => (
                    <label key={scope} className="flex items-center gap-2 px-3 h-9 border rounded-lg cursor-pointer hover:bg-gray-50 whitespace-nowrap">
                      <input
                        type="checkbox"
                        checked={newKeyData.scopes.includes(scope)}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setNewKeyData({ ...newKeyData, scopes: [...newKeyData.scopes, scope] });
                          } else {
                            setNewKeyData({ ...newKeyData, scopes: newKeyData.scopes.filter(s => s !== scope) });
                          }
                        }}
                        className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                      />
                      <span className="text-sm capitalize">{scope}</span>
                    </label>
                  ))}
                </div>
              </div>

              {/* IP Validation */}
              <div className="border-t pt-4">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={newKeyData.validateIp}
                    onChange={(e) => setNewKeyData({ ...newKeyData, validateIp: e.target.checked })}
                    className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  />
                  <span className="text-sm font-medium text-gray-700">Enable IP Whitelist</span>
                </label>

                {newKeyData.validateIp && (
                  <div className="mt-2">
                    <input
                      type="text"
                      value={newKeyData.ipWhitelist}
                      onChange={(e) => setNewKeyData({ ...newKeyData, ipWhitelist: e.target.value })}
                      placeholder="192.168.1.0/24, 10.0.0.5"
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    />
                    <p className="text-xs text-gray-500 mt-1">
                      Comma-separated IPs or CIDR ranges. Empty = allow all.
                    </p>
                  </div>
                )}
              </div>

              {/* Rate Limit */}
              <div className="border-t pt-4">
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Rate Limit (requests per minute)
                </label>
                <input
                  type="number"
                  value={newKeyData.rateLimit}
                  onChange={(e) => setNewKeyData({ ...newKeyData, rateLimit: e.target.value })}
                  placeholder="Leave empty for unlimited"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 mt-6">
              <button
                onClick={() => {
                  setShowCreateModal(false);
                  setNewKeyData({
                    name: '',
                    type: 'client',
                    scopes: ['read'],
                    validateIp: false,
                    ipWhitelist: '',
                    rateLimit: '',
                  });
                }}
                className="inline-flex items-center justify-center px-3.5 h-9 text-gray-600 hover:text-gray-900 whitespace-nowrap"
              >
                Cancel
              </button>
              <button
                onClick={createApiKey}
                disabled={!newKeyData.name.trim()}
                className="inline-flex items-center justify-center px-3 h-9 rounded-lg transition-colors disabled:opacity-50 whitespace-nowrap bg-blue-600 text-white hover:bg-blue-700"
              >
                Create Key
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete API Key Confirmation Modal */}
      {showDeleteModal && keyToDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm mx-4">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
              <h2 className="text-lg font-semibold text-gray-900">Delete API Key</h2>
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
                Are you sure you want to delete <strong>{keyToDelete.name}</strong>?
              </p>
              <p className="text-sm text-gray-500 mt-2">
                This action cannot be undone. Applications using this key will immediately lose access.
              </p>
            </div>
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200 bg-gray-50 rounded-b-xl">
              <Button variant="ghost" onClick={() => setShowDeleteModal(false)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={handleDeleteApiKey}
                isLoading={isDeleting}
              >
                Delete Key
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Audit Logs Modal */}
      {selectedKey && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl p-6 w-full max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-gray-900">Audit Logs</h3>
              <button
                onClick={() => setSelectedKey(null)}
                className="text-gray-400 hover:text-gray-600"
              >
                ✕
              </button>
            </div>

            <div className="flex-1 overflow-auto">
              {auditLogs.length > 0 ? (
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 sticky top-0">
                    <tr>
                      <th className="px-4 py-2 text-left font-medium text-gray-700">Time</th>
                      <th className="px-4 py-2 text-left font-medium text-gray-700">Action</th>
                      <th className="px-4 py-2 text-left font-medium text-gray-700">IP Address</th>
                      <th className="px-4 py-2 text-left font-medium text-gray-700">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200">
                    {auditLogs.map((log) => (
                      <tr key={log.id}>
                        <td className="px-4 py-2 text-gray-600">
                          {new Date(log.createdAt).toLocaleString()}
                        </td>
                        <td className="px-4 py-2">
                          <span className={`px-2 py-0.5 rounded text-xs ${
                            log.action === 'authenticate' ? 'bg-green-100 text-green-700' :
                            log.action.startsWith('denied') ? 'bg-red-100 text-red-700' :
                            'bg-gray-100 text-gray-700'
                          }`}>
                            {log.action}
                          </span>
                        </td>
                        <td className="px-4 py-2 text-gray-600 font-mono text-xs">
                          {log.ipAddress}
                        </td>
                        <td className="px-4 py-2">
                          {log.success ? (
                            <span className="text-green-600">✓ Success</span>
                          ) : (
                            <span className="text-red-600" title={log.errorMessage}>✗ Failed</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="text-center py-8 text-gray-500">
                  No audit logs found
                </div>
              )}
            </div>

            {/* Pagination */}
            {auditLogsTotalPages > 1 && (
              <div className="mt-4 pt-4 border-t border-gray-200 flex items-center justify-between">
                <div className="text-xs text-gray-500">
                  {auditLogsTotal} total logs
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => fetchAuditLogs(selectedKey, auditLogsPage - 1)}
                    disabled={auditLogsPage <= 1}
                    className="p-1.5 border border-gray-200 rounded hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </button>
                  <span className="text-sm text-gray-600">
                    Page {auditLogsPage} of {auditLogsTotalPages}
                  </span>
                  <button
                    onClick={() => fetchAuditLogs(selectedKey, auditLogsPage + 1)}
                    disabled={auditLogsPage >= auditLogsTotalPages}
                    className="p-1.5 border border-gray-200 rounded hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <ChevronRight className="h-4 w-4" />
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Generate Key Pair Modal */}
      {showGenerateModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">Generate Key Pair</h3>

            <div className="space-y-4">
              {/* Name */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Key Name *
                </label>
                <input
                  type="text"
                  value={generateForm.name}
                  onChange={(e) => setGenerateForm({ ...generateForm, name: e.target.value })}
                  placeholder="e.g., Production PGP Key"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
                  autoFocus
                />
              </div>

              {/* Algorithm */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Algorithm
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {[
                    { value: 'PGP', label: 'PGP', desc: 'OpenPGP standard' },
                    { value: 'RSA', label: 'RSA', desc: 'Public-key crypto' },
                    { value: 'AES', label: 'AES', desc: 'Password-based' },
                  ].map((alg) => (
                    <button
                      key={alg.value}
                      type="button"
                      onClick={() => setGenerateForm({ ...generateForm, algorithm: alg.value, keySize: alg.value === 'AES' ? 256 : 4096 })}
                      className={`p-3 rounded-lg border text-left transition-colors ${
                        generateForm.algorithm === alg.value
                          ? 'border-emerald-500 bg-emerald-50'
                          : 'border-gray-200 hover:border-gray-300'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <ShieldCheck className={`h-4 w-4 ${generateForm.algorithm === alg.value ? 'text-emerald-600' : 'text-gray-400'}`} />
                        <span className="font-medium text-sm">{alg.label}</span>
                      </div>
                      <p className="text-xs text-gray-500 mt-0.5 truncate" title={alg.desc}>{alg.desc}</p>
                    </button>
                  ))}
                </div>
              </div>

              {/* Key Size (PGP/RSA only) */}
              {/* Key Size */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Key Size
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {(generateForm.algorithm === 'AES'
                    ? [
                        { value: 128, label: '128-bit', desc: 'Fast' },
                        { value: 192, label: '192-bit', desc: 'Balanced' },
                        { value: 256, label: '256-bit', desc: 'Most secure' },
                      ]
                    : [
                        { value: 2048, label: '2048-bit', desc: 'Fast' },
                        { value: 3072, label: '3072-bit', desc: 'Balanced' },
                        { value: 4096, label: '4096-bit', desc: 'Most secure' },
                      ]
                  ).map((ks) => (
                    <button
                      key={ks.value}
                      type="button"
                      onClick={() => setGenerateForm({ ...generateForm, keySize: ks.value })}
                      className={`inline-flex items-center justify-center px-2 h-9 rounded-lg border text-center transition-colors text-[14px] ${
                        (generateForm.keySize || (generateForm.algorithm === 'AES' ? 256 : 4096)) === ks.value
                          ? 'border-emerald-500 bg-emerald-50 font-medium'
                          : 'border-gray-200 hover:border-gray-300'
                      } whitespace-nowrap`}
                    >
                      {ks.label}
                      <span className="block text-xs text-gray-400">{ks.desc}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Passphrase — not for RSA: its private key is stored unlocked so flows can decrypt */}
              {generateForm.algorithm !== 'RSA' && <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {generateForm.algorithm === 'AES' ? 'Password *' : 'Passphrase'}
                </label>
                <input
                  type="password"
                  autoComplete="new-password"
                  value={generateForm.passphrase}
                  onChange={(e) => setGenerateForm({ ...generateForm, passphrase: e.target.value })}
                  placeholder={generateForm.algorithm === 'AES' ? 'Required — used to derive AES key (PBKDF2)' : 'Optional passphrase for private key'}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
                />
                <p className="text-xs text-gray-500 mt-1">
                  {generateForm.algorithm === 'AES'
                    ? 'Key derived from password using PBKDF2 (100,000 iterations, SHA-256).'
                    : 'Leave empty for no passphrase protection.'}
                </p>
              </div>}

              {/* Description */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Description
                </label>
                <textarea
                  value={generateForm.description}
                  onChange={(e) => setGenerateForm({ ...generateForm, description: e.target.value })}
                  placeholder="Optional description for this key pair"
                  rows={2}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent resize-none"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 mt-6">
              <button
                onClick={() => {
                  setShowGenerateModal(false);
                  setGenerateForm({ name: '', algorithm: 'PGP', passphrase: '', description: '', keySize: 4096 });
                }}
                className="inline-flex items-center justify-center px-3.5 h-9 text-gray-600 hover:text-gray-900 whitespace-nowrap"
              >
                Cancel
              </button>
              <button
                onClick={handleGenerateKeyPair}
                disabled={!generateForm.name.trim() || isGenerating || (generateForm.algorithm === 'AES' && !generateForm.passphrase.trim())}
                className="px-3 h-9 rounded-lg transition-colors disabled:opacity-50 flex items-center gap-2 whitespace-nowrap bg-blue-600 text-white hover:bg-blue-700"
              >
                {isGenerating ? (
                  <>
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                    Generating...
                  </>
                ) : (
                  'Generate Key Pair'
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Import Key Modal */}
      {showImportModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">
              {importForm.algorithm.startsWith('AES') ? 'Import Secret Key' : 'Import Key Pair'}
            </h3>

            <div className="space-y-4">
              {/* Name */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Key Name *
                </label>
                <input
                  type="text"
                  value={importForm.name}
                  onChange={(e) => setImportForm({ ...importForm, name: e.target.value })}
                  placeholder={importForm.algorithm.startsWith('AES') ? 'e.g., SRC_A AES Key' : 'e.g., Partner Public Key'}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
                  autoFocus
                />
              </div>

              {/* Algorithm */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Algorithm
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {[
                    { value: 'PGP', label: 'PGP', desc: 'Asymmetric' },
                    { value: 'RSA', label: 'RSA', desc: 'Asymmetric' },
                    { value: 'AES-256-GCM', label: 'AES-256', desc: 'Symmetric' },
                  ].map((alg) => (
                    <button
                      key={alg.value}
                      type="button"
                      onClick={() => setImportForm({ ...importForm, algorithm: alg.value })}
                      className={`p-2 rounded-lg border text-center transition-colors ${
                        importForm.algorithm === alg.value
                          ? 'border-emerald-500 bg-emerald-50 text-emerald-700'
                          : 'border-gray-200 hover:border-gray-300 text-gray-700'
                      }`}
                    >
                      <div className="text-sm font-medium">{alg.label}</div>
                      <div className="text-xs opacity-60">{alg.desc}</div>
                    </button>
                  ))}
                </div>
                {importForm.algorithm.startsWith('AES') && (
                  <div className="mt-2">
                    <select
                      value={importForm.algorithm}
                      onChange={(e) => setImportForm({ ...importForm, algorithm: e.target.value })}
                      className="w-full px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
                    >
                      <option value="AES-256-GCM">AES-256-GCM (recommended)</option>
                      <option value="AES-256-CBC">AES-256-CBC</option>
                      <option value="AES-192-GCM">AES-192-GCM</option>
                      <option value="AES-192-CBC">AES-192-CBC</option>
                      <option value="AES-128-GCM">AES-128-GCM</option>
                      <option value="AES-128-CBC">AES-128-CBC</option>
                    </select>
                  </div>
                )}
              </div>

              {/* Key Input */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {importForm.algorithm.startsWith('AES') ? 'Secret Key *' : 'Public Key *'}
                </label>
                <textarea
                  value={importForm.publicKey}
                  onChange={(e) => setImportForm({ ...importForm, publicKey: e.target.value })}
                  placeholder={importForm.algorithm.startsWith('AES')
                    ? 'Paste the secret key here (Base64 format)...'
                    : importForm.algorithm === 'RSA'
                      ? 'Paste the RSA public key: -----BEGIN PUBLIC KEY-----, -----BEGIN RSA PUBLIC KEY-----, a certificate or ssh-rsa AAAA...'
                      : 'Paste the public key here (-----BEGIN PGP PUBLIC KEY BLOCK-----)...'}
                  rows={importForm.algorithm.startsWith('AES') ? 3 : 6}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent font-mono text-xs resize-none"
                />
                {importForm.algorithm.startsWith('AES') && (
                  <p className="mt-1 text-xs text-gray-500">
                    AES ใช้ key เดียวกันทั้งเข้ารหัสและถอดรหัส (Symmetric) รองรับ Base64 หรือ JSON format
                  </p>
                )}
              </div>

              {/* Private Key (PGP/RSA only) - optional, for decryption */}
              {!importForm.algorithm.startsWith('AES') && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Private Key <span className="text-gray-400 font-normal">(optional — ใช้สำหรับ decrypt)</span>
                  </label>
                  <textarea
                    value={importForm.secretKey}
                    onChange={(e) => setImportForm({ ...importForm, secretKey: e.target.value })}
                    placeholder="Paste the private key here (-----BEGIN PGP PRIVATE KEY BLOCK-----)..."
                    rows={6}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent font-mono text-xs resize-none"
                  />
                  <p className="mt-1 text-xs text-gray-500">
                    ถ้าต้องการ decrypt ไฟล์ที่ได้รับจาก partner ให้ใส่ Private Key ด้วย
                  </p>
                </div>
              )}

              {/* RSA private key passphrase — used once to unlock the key on import */}
              {importForm.algorithm === 'RSA' && importForm.secretKey.includes('ENCRYPTED') && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Private Key Passphrase *</label>
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={importForm.passphrase}
                    onChange={(e) => setImportForm({ ...importForm, passphrase: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
                  />
                  <p className="mt-1 text-xs text-gray-500">ใช้ปลดล็อก Private Key ตอน import เท่านั้น — ระบบเก็บคีย์ที่ปลดล็อกแล้วเพื่อให้ flow ถอดรหัสได้เอง</p>
                </div>
              )}

              {/* Key Format */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Key Format
                </label>
                <input
                  type="text"
                  value={importForm.keyFormat}
                  onChange={(e) => setImportForm({ ...importForm, keyFormat: e.target.value })}
                  placeholder="e.g., PEM, armored (optional)"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
                />
              </div>

              {/* Description */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Description
                </label>
                <textarea
                  value={importForm.description}
                  onChange={(e) => setImportForm({ ...importForm, description: e.target.value })}
                  placeholder="Optional description"
                  rows={2}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent resize-none"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 mt-6">
              <button
                onClick={() => {
                  setShowImportModal(false);
                  setImportForm({ name: '', algorithm: 'PGP', publicKey: '', secretKey: '', passphrase: '', keyFormat: '', description: '' });
                }}
                className="inline-flex items-center justify-center px-3.5 h-9 text-gray-600 hover:text-gray-900 whitespace-nowrap"
              >
                Cancel
              </button>
              <button
                onClick={handleImportKey}
                disabled={!importForm.name.trim() || !importForm.publicKey.trim() || isImporting}
                className="px-3 h-9 rounded-lg transition-colors disabled:opacity-50 flex items-center gap-2 whitespace-nowrap bg-blue-600 text-white hover:bg-blue-700"
              >
                {isImporting ? (
                  <>
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                    Importing...
                  </>
                ) : (
                  <>
                    <Upload className="h-4 w-4" />
                    Import Key
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Encryption Key Confirmation Modal */}
      {/* Download Public Key Modal */}
      {showDownloadModal && downloadTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm mx-4">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
              <h2 className="text-lg font-semibold text-gray-900">Download Public Key</h2>
              <button
                onClick={() => setShowDownloadModal(false)}
                className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
              >
                <X className="h-5 w-5 text-gray-500" />
              </button>
            </div>
            <div className="p-6 space-y-4">
              <p className="text-sm text-gray-600">
                Download <strong>{downloadTarget.name}</strong> public key
              </p>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  ZIP Password <span className="text-gray-400">(optional)</span>
                </label>
                <div className="relative">
                  <input
                    type={showDownloadPassword ? 'text' : 'password'}
                    value={downloadPassword}
                    onChange={(e) => setDownloadPassword(e.target.value)}
                    placeholder="Enter password for ZIP protection"
                    className="w-full px-3 py-2 pr-10 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <button
                    type="button"
                    onClick={() => setShowDownloadPassword(!showDownloadPassword)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-gray-400 hover:text-gray-600"
                  >
                    {showDownloadPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
                <p className="text-[10px] text-gray-400 mt-1">
                  Leave empty to download as plain file
                </p>
              </div>
            </div>
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200 bg-gray-50 rounded-b-xl">
              <Button variant="ghost" onClick={() => setShowDownloadModal(false)}>
                Cancel
              </Button>
              <Button
                onClick={() => executeDownload(!!downloadPassword)}
              >
                <Download className="h-4 w-4 mr-1.5" />
                {downloadPassword ? 'Download ZIP' : 'Download'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {showDeleteEncKeyModal && encKeyToDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm mx-4">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
              <h2 className="text-lg font-semibold text-gray-900">Delete Encryption Key</h2>
              <button
                onClick={() => setShowDeleteEncKeyModal(false)}
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
                Are you sure you want to delete <strong>{encKeyToDelete.name}</strong>?
              </p>
              <p className="text-sm text-gray-500 mt-2">
                This action cannot be undone. Any data encrypted with this key may become inaccessible.
              </p>
            </div>
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200 bg-gray-50 rounded-b-xl">
              <Button variant="ghost" onClick={() => setShowDeleteEncKeyModal(false)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={handleDeleteEncKey}
                isLoading={isDeletingEncKey}
              >
                Delete Key
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ProjectApiKeys;
