import { useState, useEffect } from 'react';
import { Key, Copy, Plus, Trash2, Eye, EyeOff, Shield, Server, Webhook, Globe, History, Lock, ChevronLeft, ChevronRight, AlertCircle, Download, Upload, FileKey, ShieldCheck, Fingerprint } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Modal } from '../../components/ui/Modal';
import {
  TextInput, NumberInput, PasswordInput, TextArea, Select, SelectItem, Checkbox, Tag, Loading,
  IconButton, Tabs, TabList, Tab, InlineNotification,
  TableContainer, Table, TableHead, TableRow, TableHeader, TableBody, TableCell,
} from '@carbon/react';
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
  const [, setShowDownloadPassword] = useState(false);

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
      <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[12px] font-medium ${config.bg} ${config.color}`}>
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
        <Loading withOverlay={false} small description="Loading" />
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6">
      {/* Tabs */}
      <div className="mb-4">
        <Tabs
          selectedIndex={activeMainTab === 'api-keys' ? 0 : 1}
          onChange={({ selectedIndex }: { selectedIndex: number }) =>
            setActiveMainTab(selectedIndex === 0 ? 'api-keys' : 'encryption-keys')
          }
        >
          <TabList aria-label="Key management tabs">
            <Tab renderIcon={() => <Key className="h-4 w-4" />}>API Keys</Tab>
            <Tab renderIcon={() => <FileKey className="h-4 w-4" />}>Encryption Keys</Tab>
          </TabList>
        </Tabs>
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
            <Button
              onClick={() => setShowCreateModal(true)}
              className="self-start sm:self-auto shrink-0"
              leftIcon={<Plus className="h-4 w-4" />}
            >
              Create API Key
            </Button>
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
            <div className="mb-6">
              <InlineNotification
                kind="warning"
                lowContrast
                hideCloseButton
                title="API Key Created!"
                subtitle={`Copy your key now. The ${newlyCreatedKey.secretKey ? 'secret key ' : ''}will not be shown again.`}
              />
              <div className="flex items-start gap-3 mt-2">
                <div className="flex-1">

                  <div className="mt-3 space-y-2">
                    <div className="bg-white border border-amber-300 rounded-lg px-3 py-2 font-mono text-sm flex items-center justify-between">
                      <span className="truncate">{newlyCreatedKey.key}</span>
                      <IconButton kind="ghost" size="sm" label={copiedId === 'new-key' ? 'Copied!' : 'Copy key'} onClick={() => copyToClipboard(newlyCreatedKey.key, 'new-key')} className="ml-2">
                        {copiedId === 'new-key' ? <span className="text-[12px]">Copied!</span> : <Copy className="h-4 w-4" />}
                      </IconButton>
                    </div>

                    {newlyCreatedKey.secretKey && (
                      <div className="bg-white border border-amber-300 rounded-lg px-3 py-2 font-mono text-sm flex items-center justify-between">
                        <span className="truncate text-purple-700">{newlyCreatedKey.secretKey}</span>
                        <IconButton kind="ghost" size="sm" label={copiedId === 'new-secret' ? 'Copied!' : 'Copy secret key'} onClick={() => copyToClipboard(newlyCreatedKey.secretKey, 'new-secret')} className="ml-2">
                          {copiedId === 'new-secret' ? <span className="text-[12px]">Copied!</span> : <Copy className="h-4 w-4" />}
                        </IconButton>
                      </div>
                    )}
                  </div>

                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setNewlyCreatedKey(null)}
                    className="mt-3"
                  >
                    I have copied the key(s)
                  </Button>
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
                    className={`cds--tile app-tile p-3 transition-colors ${
                      apiKey.isActive ? '' : 'opacity-60'
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
                            <Tag size="sm" type="green">Active</Tag>
                          ) : (
                            <Tag size="sm" type="gray">Inactive</Tag>
                          )}
                        </div>

                        {/* Row 2: Type Badge + Scopes */}
                        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                          {getKeyTypeBadge(apiKey.type)}
                          {apiKey.scopes.map(scope => (
                            <Tag key={scope} size="sm" type="gray">{scope}</Tag>
                          ))}
                          {apiKey.validateIp && (
                            <Tag size="sm" type="purple" renderIcon={() => <Lock className="h-2.5 w-2.5" />}>IP</Tag>
                          )}
                          {apiKey.rateLimit && (
                            <Tag size="sm" type="warm-gray">{apiKey.rateLimit}/min</Tag>
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
                          <IconButton
                            kind="ghost"
                            size="sm"
                            label={showKeyId === apiKey.id ? 'Hide' : 'Show'}
                            onClick={() => setShowKeyId(showKeyId === apiKey.id ? null : apiKey.id)}
                          >
                            {showKeyId === apiKey.id ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                          </IconButton>
                          <IconButton
                            kind="ghost"
                            size="sm"
                            label="Copy"
                            onClick={() => copyToClipboard(apiKey.key, apiKey.id)}
                          >
                            {copiedId === apiKey.id ? (
                              <span className="text-green-600 text-[12px] font-medium">✓</span>
                            ) : (
                              <Copy className="h-3.5 w-3.5" />
                            )}
                          </IconButton>
                        </div>

                        {/* Row 4: Meta Info */}
                        <div className="mt-1.5 flex items-center gap-3 text-[12px] text-gray-400">
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
                        <IconButton
                          kind="ghost"
                          size="sm"
                          label="Audit Logs"
                          onClick={() => {
                            setSelectedKey(apiKey.id);
                            fetchAuditLogs(apiKey.id);
                          }}
                        >
                          <History className="h-3.5 w-3.5" />
                        </IconButton>
                        <IconButton
                          kind="ghost"
                          size="sm"
                          label={apiKey.isActive ? 'Deactivate' : 'Activate'}
                          onClick={() => toggleActive(apiKey)}
                        >
                          <Shield className={`h-3.5 w-3.5 ${apiKey.isActive ? 'text-green-500' : 'text-gray-300'}`} />
                        </IconButton>
                        <IconButton
                          kind="ghost"
                          size="sm"
                          label="Delete"
                          onClick={() => handleDeleteClick(apiKey)}
                        >
                          <Trash2 className="h-3.5 w-3.5 text-red-500" />
                        </IconButton>
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
              <Button onClick={() => setShowCreateModal(true)}>
                Create API Key
              </Button>
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
              <Button variant="secondary" onClick={() => setShowImportModal(true)} leftIcon={<Upload className="h-4 w-4" />}>
                Import Public Key
              </Button>
              <Button onClick={() => setShowGenerateModal(true)} leftIcon={<Plus className="h-4 w-4" />}>
                Generate Key Pair
              </Button>
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
              <Loading withOverlay={false} small description="Loading encryption keys" />
            </div>
          ) : encryptionKeys.length > 0 ? (
            <div className="space-y-3">
              {encryptionKeys.map((encKey) => (
                <div
                  key={encKey.id}
                  className={`cds--tile app-tile p-3 transition-colors ${
                    encKey.isActive ? '' : 'opacity-60'
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
                          <Tag size="sm" type="green">Active</Tag>
                        ) : (
                          <Tag size="sm" type="gray">Inactive</Tag>
                        )}
                      </div>

                      {/* Row 2: Algorithm + Format badges */}
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        <Tag size="sm" type="green" renderIcon={() => <ShieldCheck className="h-3 w-3" />}>{encKey.algorithm}</Tag>
                        {encKey.keyFormat && (
                          <Tag size="sm" type="gray">{encKey.keyFormat}</Tag>
                        )}
                        {/* Private Key indicator — only for asymmetric keys */}
                        {encKey.algorithm && !encKey.algorithm.startsWith('aes') && (
                          encKey.hasPrivateKey ? (
                            <Tag size="sm" type="blue" title="Private key stored in system" renderIcon={() => <Lock className="h-3 w-3" />}>มี Private Key</Tag>
                          ) : (
                            <Tag size="sm" type="warm-gray" title="No private key — encrypt only" renderIcon={() => <Lock className="h-3 w-3" />}>Public Only</Tag>
                          )
                        )}
                        {encKey.description && (
                          <span className="px-1.5 py-0.5 bg-gray-50 text-gray-500 text-[12px] rounded italic">
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
                      <div className="mt-1.5 flex items-center gap-3 text-[12px] text-gray-400">
                        <span>Created {new Date(encKey.createdAt).toLocaleString('en-GB', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}</span>
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-0.5 shrink-0">
                      <IconButton
                        kind="ghost"
                        size="sm"
                        label="Download Public Key"
                        onClick={() => handleDownloadPublicKey(encKey)}
                      >
                        <Download className="h-3.5 w-3.5 text-emerald-600" />
                      </IconButton>
                      <IconButton
                        kind="ghost"
                        size="sm"
                        label={encKey.isActive ? 'Deactivate' : 'Activate'}
                        onClick={() => toggleEncKeyActive(encKey)}
                      >
                        <ShieldCheck className={`h-3.5 w-3.5 ${encKey.isActive ? 'text-emerald-500' : 'text-gray-300'}`} />
                      </IconButton>
                      <IconButton
                        kind="ghost"
                        size="sm"
                        label="Delete"
                        onClick={() => {
                          setEncKeyToDelete(encKey);
                          setShowDeleteEncKeyModal(true);
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5 text-red-500" />
                      </IconButton>
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
                <Button variant="secondary" onClick={() => setShowImportModal(true)}>
                  Import Public Key
                </Button>
                <Button onClick={() => setShowGenerateModal(true)}>
                  Generate Key Pair
                </Button>
              </div>
            </div>
          )}
        </>
      )}

      {/* ===== Modals ===== */}

      {/* Create API Key Modal */}
      <Modal
        isOpen={showCreateModal}
        onClose={() => {
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
        title="Create New API Key"
        size="xl"
      >

            <div className="space-y-4">
              {/* Key Name */}
              <TextInput
                id="api-key-name"
                labelText="Key Name *"
                value={newKeyData.name}
                onChange={(e) => setNewKeyData({ ...newKeyData, name: e.target.value })}
                placeholder="e.g., Production API Key"
                autoFocus
              />

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
                    <Checkbox
                      key={scope}
                      id={`api-key-scope-${scope}`}
                      labelText={<span className="capitalize">{scope}</span>}
                      checked={newKeyData.scopes.includes(scope)}
                      onChange={(_e, { checked }) => {
                        if (checked) {
                          setNewKeyData({ ...newKeyData, scopes: [...newKeyData.scopes, scope] });
                        } else {
                          setNewKeyData({ ...newKeyData, scopes: newKeyData.scopes.filter(s => s !== scope) });
                        }
                      }}
                    />
                  ))}
                </div>
              </div>

              {/* IP Validation */}
              <div className="border-t pt-4">
                <Checkbox
                  id="api-key-validate-ip"
                  labelText="Enable IP Whitelist"
                  checked={newKeyData.validateIp}
                  onChange={(_e, { checked }) => setNewKeyData({ ...newKeyData, validateIp: checked })}
                />

                {newKeyData.validateIp && (
                  <div className="mt-2">
                    <TextInput
                      id="api-key-ip-whitelist"
                      labelText="IP whitelist"
                      hideLabel
                      value={newKeyData.ipWhitelist}
                      onChange={(e) => setNewKeyData({ ...newKeyData, ipWhitelist: e.target.value })}
                      placeholder="192.168.1.0/24, 10.0.0.5"
                      helperText="Comma-separated IPs or CIDR ranges. Empty = allow all."
                    />
                  </div>
                )}
              </div>

              {/* Rate Limit */}
              <div className="border-t pt-4">
                <NumberInput
                  id="api-key-rate-limit"
                  label="Rate Limit (requests per minute)"
                  hideSteppers
                  allowEmpty
                  value={newKeyData.rateLimit === '' ? '' : Number(newKeyData.rateLimit)}
                  onChange={(e: any) => setNewKeyData({ ...newKeyData, rateLimit: e.target.value })}
                  placeholder="Leave empty for unlimited"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 mt-6">
              <Button
                variant="ghost"
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
              >
                Cancel
              </Button>
              <Button
                onClick={createApiKey}
                disabled={!newKeyData.name.trim()}
              >
                Create Key
              </Button>
            </div>
      </Modal>

      {/* Delete API Key Confirmation Modal */}
      <Modal
        isOpen={showDeleteModal && !!keyToDelete}
        onClose={() => setShowDeleteModal(false)}
        title="Delete API Key"
        size="md"
      >
        {keyToDelete && (
          <>
            <div>
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
            <div className="flex items-center justify-end gap-3 pt-4 mt-4 border-t border-gray-200">
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
          </>
        )}
      </Modal>

      {/* Audit Logs Modal */}
      <Modal
        isOpen={!!selectedKey}
        onClose={() => setSelectedKey(null)}
        title="Audit Logs"
        size="2xl"
      >
        {selectedKey && (
          <>
            <div className="max-h-[60vh] overflow-auto">
              {auditLogs.length > 0 ? (
                <TableContainer>
                  <Table size="sm">
                    <TableHead>
                      <TableRow>
                        <TableHeader>Time</TableHeader>
                        <TableHeader>Action</TableHeader>
                        <TableHeader>IP Address</TableHeader>
                        <TableHeader>Status</TableHeader>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {auditLogs.map((log) => (
                        <TableRow key={log.id}>
                          <TableCell className="text-gray-600">
                            {new Date(log.createdAt).toLocaleString()}
                          </TableCell>
                          <TableCell>
                            <Tag
                              size="sm"
                              type={
                                log.action === 'authenticate' ? 'green' :
                                log.action.startsWith('denied') ? 'red' :
                                'gray'
                              }
                            >
                              {log.action}
                            </Tag>
                          </TableCell>
                          <TableCell className="text-gray-600 font-mono text-xs">
                            {log.ipAddress}
                          </TableCell>
                          <TableCell>
                            {log.success ? (
                              <span className="text-green-600">✓ Success</span>
                            ) : (
                              <span className="text-red-600" title={log.errorMessage}>✗ Failed</span>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableContainer>
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
                  <IconButton
                    kind="ghost"
                    size="sm"
                    label="Previous page"
                    onClick={() => fetchAuditLogs(selectedKey, auditLogsPage - 1)}
                    disabled={auditLogsPage <= 1}
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </IconButton>
                  <span className="text-sm text-gray-600">
                    Page {auditLogsPage} of {auditLogsTotalPages}
                  </span>
                  <IconButton
                    kind="ghost"
                    size="sm"
                    label="Next page"
                    onClick={() => fetchAuditLogs(selectedKey, auditLogsPage + 1)}
                    disabled={auditLogsPage >= auditLogsTotalPages}
                  >
                    <ChevronRight className="h-4 w-4" />
                  </IconButton>
                </div>
              </div>
            )}
          </>
        )}
      </Modal>

      {/* Generate Key Pair Modal */}
      <Modal
        isOpen={showGenerateModal}
        onClose={() => {
          setShowGenerateModal(false);
          setGenerateForm({ name: '', algorithm: 'PGP', passphrase: '', description: '', keySize: 4096 });
        }}
        title="Generate Key Pair"
        size="xl"
      >

            <div className="space-y-4">
              {/* Name */}
              <TextInput
                id="generate-key-name"
                labelText="Key Name *"
                value={generateForm.name}
                onChange={(e) => setGenerateForm({ ...generateForm, name: e.target.value })}
                placeholder="e.g., Production PGP Key"
                autoFocus
              />

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
                <PasswordInput
                  id="generate-key-passphrase"
                  labelText={generateForm.algorithm === 'AES' ? 'Password *' : 'Passphrase'}
                  autoComplete="new-password"
                  value={generateForm.passphrase}
                  onChange={(e) => setGenerateForm({ ...generateForm, passphrase: e.target.value })}
                  placeholder={generateForm.algorithm === 'AES' ? 'Required — used to derive AES key (PBKDF2)' : 'Optional passphrase for private key'}
                  helperText={generateForm.algorithm === 'AES'
                    ? 'Key derived from password using PBKDF2 (100,000 iterations, SHA-256).'
                    : 'Leave empty for no passphrase protection.'}
                />
              </div>}

              {/* Description */}
              <div>
                <TextArea
                  id="generate-key-description"
                  labelText="Description"
                  value={generateForm.description}
                  onChange={(e) => setGenerateForm({ ...generateForm, description: e.target.value })}
                  placeholder="Optional description for this key pair"
                  rows={2}
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 mt-6">
              <Button
                variant="ghost"
                onClick={() => {
                  setShowGenerateModal(false);
                  setGenerateForm({ name: '', algorithm: 'PGP', passphrase: '', description: '', keySize: 4096 });
                }}
              >
                Cancel
              </Button>
              <Button
                onClick={handleGenerateKeyPair}
                disabled={!generateForm.name.trim() || (generateForm.algorithm === 'AES' && !generateForm.passphrase.trim())}
                isLoading={isGenerating}
              >
                {isGenerating ? 'Generating...' : 'Generate Key Pair'}
              </Button>
            </div>
      </Modal>

      {/* Import Key Modal */}
      <Modal
        isOpen={showImportModal}
        onClose={() => {
          setShowImportModal(false);
          setImportForm({ name: '', algorithm: 'PGP', publicKey: '', secretKey: '', passphrase: '', keyFormat: '', description: '' });
        }}
        title={importForm.algorithm.startsWith('AES') ? 'Import Secret Key' : 'Import Key Pair'}
        size="xl"
      >

            <div className="space-y-4">
              {/* Name */}
              <TextInput
                id="import-key-name"
                labelText="Key Name *"
                value={importForm.name}
                onChange={(e) => setImportForm({ ...importForm, name: e.target.value })}
                placeholder={importForm.algorithm.startsWith('AES') ? 'e.g., SRC_A AES Key' : 'e.g., Partner Public Key'}
                autoFocus
              />

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
                    <Select
                      id="import-key-aes-variant"
                      labelText="AES variant"
                      hideLabel
                      size="sm"
                      value={importForm.algorithm}
                      onChange={(e) => setImportForm({ ...importForm, algorithm: e.target.value })}
                    >
                      <SelectItem value="AES-256-GCM" text="AES-256-GCM (recommended)" />
                      <SelectItem value="AES-256-CBC" text="AES-256-CBC" />
                      <SelectItem value="AES-192-GCM" text="AES-192-GCM" />
                      <SelectItem value="AES-192-CBC" text="AES-192-CBC" />
                      <SelectItem value="AES-128-GCM" text="AES-128-GCM" />
                      <SelectItem value="AES-128-CBC" text="AES-128-CBC" />
                    </Select>
                  </div>
                )}
              </div>

              {/* Key Input */}
              <div>
                <TextArea
                  id="import-key-public"
                  labelText={importForm.algorithm.startsWith('AES') ? 'Secret Key *' : 'Public Key *'}
                  value={importForm.publicKey}
                  onChange={(e) => setImportForm({ ...importForm, publicKey: e.target.value })}
                  placeholder={importForm.algorithm.startsWith('AES')
                    ? 'Paste the secret key here (Base64 format)...'
                    : importForm.algorithm === 'RSA'
                      ? 'Paste the RSA public key: -----BEGIN PUBLIC KEY-----, -----BEGIN RSA PUBLIC KEY-----, a certificate or ssh-rsa AAAA...'
                      : 'Paste the public key here (-----BEGIN PGP PUBLIC KEY BLOCK-----)...'}
                  rows={importForm.algorithm.startsWith('AES') ? 3 : 6}
                  className="font-mono text-xs"
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
                  <TextArea
                    id="import-key-private"
                    labelText={<>Private Key <span className="text-gray-400 font-normal">(optional — ใช้สำหรับ decrypt)</span></>}
                    value={importForm.secretKey}
                    onChange={(e) => setImportForm({ ...importForm, secretKey: e.target.value })}
                    placeholder="Paste the private key here (-----BEGIN PGP PRIVATE KEY BLOCK-----)..."
                    rows={6}
                    className="font-mono text-xs"
                  />
                  <p className="mt-1 text-xs text-gray-500">
                    ถ้าต้องการ decrypt ไฟล์ที่ได้รับจาก partner ให้ใส่ Private Key ด้วย
                  </p>
                </div>
              )}

              {/* RSA private key passphrase — used once to unlock the key on import */}
              {importForm.algorithm === 'RSA' && importForm.secretKey.includes('ENCRYPTED') && (
                <div>
                  <PasswordInput
                    id="import-key-passphrase"
                    labelText="Private Key Passphrase *"
                    autoComplete="new-password"
                    value={importForm.passphrase}
                    onChange={(e) => setImportForm({ ...importForm, passphrase: e.target.value })}
                  />
                  <p className="mt-1 text-xs text-gray-500">ใช้ปลดล็อก Private Key ตอน import เท่านั้น — ระบบเก็บคีย์ที่ปลดล็อกแล้วเพื่อให้ flow ถอดรหัสได้เอง</p>
                </div>
              )}

              {/* Key Format */}
              <TextInput
                id="import-key-format"
                labelText="Key Format"
                value={importForm.keyFormat}
                onChange={(e) => setImportForm({ ...importForm, keyFormat: e.target.value })}
                placeholder="e.g., PEM, armored (optional)"
              />

              {/* Description */}
              <div>
                <TextArea
                  id="import-key-description"
                  labelText="Description"
                  value={importForm.description}
                  onChange={(e) => setImportForm({ ...importForm, description: e.target.value })}
                  placeholder="Optional description"
                  rows={2}
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 mt-6">
              <Button
                variant="ghost"
                onClick={() => {
                  setShowImportModal(false);
                  setImportForm({ name: '', algorithm: 'PGP', publicKey: '', secretKey: '', passphrase: '', keyFormat: '', description: '' });
                }}
              >
                Cancel
              </Button>
              <Button
                onClick={handleImportKey}
                disabled={!importForm.name.trim() || !importForm.publicKey.trim()}
                isLoading={isImporting}
                leftIcon={<Upload className="h-4 w-4" />}
              >
                {isImporting ? 'Importing...' : 'Import Key'}
              </Button>
            </div>
      </Modal>

      {/* Delete Encryption Key Confirmation Modal */}
      {/* Download Public Key Modal */}
      <Modal
        isOpen={showDownloadModal && !!downloadTarget}
        onClose={() => setShowDownloadModal(false)}
        title="Download Public Key"
        size="md"
      >
        {downloadTarget && (
          <>
            <div className="space-y-4">
              <p className="text-sm text-gray-600">
                Download <strong>{downloadTarget.name}</strong> public key
              </p>
              <PasswordInput
                id="download-zip-password"
                labelText={<>ZIP Password <span className="text-gray-400">(optional)</span></>}
                value={downloadPassword}
                onChange={(e) => setDownloadPassword(e.target.value)}
                placeholder="Enter password for ZIP protection"
                helperText="Leave empty to download as plain file"
                showPasswordLabel="Show password"
                hidePasswordLabel="Hide password"
              />
            </div>
            <div className="flex items-center justify-end gap-3 pt-4 mt-4 border-t border-gray-200">
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
          </>
        )}
      </Modal>

      <Modal
        isOpen={showDeleteEncKeyModal && !!encKeyToDelete}
        onClose={() => setShowDeleteEncKeyModal(false)}
        title="Delete Encryption Key"
        size="md"
      >
        {encKeyToDelete && (
          <>
            <div>
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
            <div className="flex items-center justify-end gap-3 pt-4 mt-4 border-t border-gray-200">
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
          </>
        )}
      </Modal>
    </div>
  );
};

export default ProjectApiKeys;
