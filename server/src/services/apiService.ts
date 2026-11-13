// ApiService - Manages API flow deployments and URL routing cache
// Follows the same singleton pattern as SchedulerService

import { prisma } from '../lib/prisma';

export interface ApiMapping {
  flowId: string;
  projectId: string;
  projectCode: string;
  basePath: string;
  config: any;
}

class ApiService {
  private apiCache: ApiMapping[] = [];
  private projectCodeCache = new Map<string, string>();
  private deployedUrlCache = new Map<string, ApiMapping>();
  private isInitialized = false;

  /**
   * Initialize API service - load all active API specs from database
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      console.log('[ApiService] Already initialized');
      return;
    }

    console.log('[ApiService] Initializing...');

    await this.loadMappings();

    this.isInitialized = true;
    console.log('[ApiService] Initialization complete');
  }

  /**
   * Reload API mappings after a flow is deployed
   */
  async deploy(flowId: string): Promise<void> {
    console.log(`[ApiService] Deploying flow ${flowId}, reloading mappings...`);
    await this.loadMappings();
  }

  /**
   * Reload API mappings after a flow is undeployed
   */
  async undeploy(flowId: string): Promise<void> {
    console.log(`[ApiService] Undeploying flow ${flowId}, reloading mappings...`);
    await this.loadMappings();
  }

  /**
   * Manual reload of all API mappings
   */
  async reload(): Promise<void> {
    await this.loadMappings();
  }

  /**
   * Shutdown - clear all caches (called on SIGTERM/SIGINT)
   */
  shutdown(): void {
    console.log('[ApiService] Shutting down...');
    this.apiCache = [];
    this.projectCodeCache.clear();
    this.deployedUrlCache.clear();
    this.isInitialized = false;
    console.log('[ApiService] Shutdown complete');
  }

  // ============================================================
  // Accessors for route handlers
  // ============================================================

  getApiCache(): ApiMapping[] {
    return this.apiCache;
  }

  getProjectCodeCache(): Map<string, string> {
    return this.projectCodeCache;
  }

  getDeployedUrlCache(): Map<string, ApiMapping> {
    return this.deployedUrlCache;
  }

  /**
   * Find matching API for a project code + remaining path
   */
  findMatchingApi(
    projectCode: string,
    remainingPath: string
  ): { api: ApiMapping; operationPath: string } | null {
    const projectApis = this.apiCache.filter(a => a.projectCode === projectCode);
    if (projectApis.length === 0) return null;

    // Sort by basePath length (longest first) for greedy matching
    const sortedApis = projectApis.sort((a, b) => b.basePath.length - a.basePath.length);

    for (const api of sortedApis) {
      if (remainingPath.startsWith(api.basePath + '/') || remainingPath === api.basePath) {
        const operationPath = remainingPath.slice(api.basePath.length) || '/';
        return { api, operationPath };
      }
    }

    // Fallback to default API with basePath "/"
    const defaultApi = projectApis.find(a => a.basePath === '/');
    if (defaultApi) {
      return { api: defaultApi, operationPath: remainingPath };
    }

    return null;
  }

  /**
   * Check if service has loaded any API specs
   */
  hasApiSpecs(): boolean {
    return this.apiCache.length > 0;
  }

  /**
   * Get active API count for monitoring
   */
  getActiveApiCount(): number {
    return this.apiCache.length;
  }

  /**
   * Get deployed URL count for monitoring
   */
  getDeployedUrlCount(): number {
    return this.deployedUrlCache.size;
  }

  // ============================================================
  // Private: Load mappings from database (safe reload)
  // ============================================================

  private async loadMappings(): Promise<void> {
    try {
      const flows = await prisma.flow.findMany({
        where: { type: 'API_SPEC', status: 'Active' },
        include: { project: { select: { id: true, code: true, name: true } } },
      });

      // Build new caches first, only swap on success
      const newApiCache: ApiMapping[] = [];
      const newProjectCodeCache = new Map<string, string>();
      const newDeployedUrlCache = new Map<string, ApiMapping>();

      const projects = await prisma.project.findMany({
        select: { id: true, code: true },
      });
      for (const p of projects) {
        if (p.code) {
          newProjectCodeCache.set(p.code, p.id);
        }
      }

      for (const flow of flows) {
        let config: any = {};
        try {
          config = flow.config ? JSON.parse(flow.config as string) : {};
        } catch (e) {
          config = flow.config || {};
        }

        const basePath = config.apiSpec?.basePath || '/';

        const mapping: ApiMapping = {
          flowId: flow.id,
          projectId: flow.projectId,
          projectCode: flow.project?.code || '',
          basePath,
          config,
        };
        newApiCache.push(mapping);

        // Build deployed URL cache
        const publicUrl = config?.deployment?.publicUrl;
        if (publicUrl && config?.deployment?.enabled !== false) {
          const normalizedUrl = publicUrl.replace(/\/+$/, '');
          newDeployedUrlCache.set(normalizedUrl, mapping);
        }
      }

      // Atomic swap - old cache stays intact until new one is ready
      this.apiCache = newApiCache;
      this.projectCodeCache = newProjectCodeCache;
      this.deployedUrlCache = newDeployedUrlCache;

      console.log(`[ApiService] Loaded ${this.apiCache.length} API spec(s)`);
      for (const api of this.apiCache) {
        console.log(`  /api/${api.projectCode}${api.basePath} -> ${api.flowId}`);
      }
      if (this.deployedUrlCache.size > 0) {
        console.log(`[ApiService] Deployed URL mappings:`);
        this.deployedUrlCache.forEach((api, url) => {
          console.log(`  ${url}/* -> ${api.flowId} (${api.projectCode})`);
        });
      }
    } catch (err: any) {
      // Keep existing cache on failure - API stays alive with stale data
      console.error(`[ApiService] Failed to reload mappings, keeping existing cache (${this.apiCache.length} specs): ${err.message}`);
    }
  }
}

export const apiService = new ApiService();
