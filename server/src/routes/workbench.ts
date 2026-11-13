// Analytics Workbench — Backend Routes
// Connections, API Keys, Datasets, Folders, Saved Queries, Query execution

import { Router, Request, Response } from 'express';
import { adminOnly } from '../lib/access';
import { prisma } from '../lib/prisma';
import { authMiddleware } from './auth';
import { Pool as PgPool } from 'pg';
import * as crypto from 'crypto';
import * as oracledb from 'oracledb';

const router = Router();
router.use(authMiddleware);

// Not tied to a project, so admin only (the /ext routes use their own API key)
router.use((req, res, next) => (req.path.startsWith('/ext/') ? next() : adminOnly(req, res, next)));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function generateKey(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(24).toString('hex')}`;
}

interface ColInfo { name: string; type: string; nullable: boolean }

/** Execute a raw SQL query against a WbConnection and return rows + column metadata */
async function execWbQuery(
  connectionId: string,
  sql: string,
  limit?: number,
  offset?: number,
  extraWhere?: string
): Promise<{ rows: any[]; columns: ColInfo[]; totalCount: number }> {
  const conn = await prisma.wbConnection.findUnique({ where: { id: connectionId } });
  if (!conn) throw new Error('Connection not found');

  let cfg: any = {};
  try { cfg = JSON.parse(conn.config); } catch {}

  const type = conn.type;
  const base = sql.trim().replace(/;+$/, '');
  const wherePart = extraWhere ? `WHERE ${extraWhere}` : '';

  if (type.includes('postgresql') || type === 'postgres') {
    const pool = new PgPool({
      host: cfg.host, port: parseInt(cfg.port || '5432'),
      database: cfg.database, user: cfg.username || cfg.user,
      password: cfg.password,
      ssl: cfg.ssl ? { rejectUnauthorized: false } : false,
      connectionTimeoutMillis: 15000,
    });
    const client = await pool.connect();
    try {
      let totalCount = 0;
      if (limit !== undefined) {
        const cr = await client.query(`SELECT COUNT(*) AS cnt FROM (${base}) AS _q ${wherePart}`);
        totalCount = Number(cr.rows[0]?.cnt ?? 0);
      }
      const q = limit !== undefined
        ? `SELECT * FROM (${base}) AS _q ${wherePart} LIMIT $1 OFFSET $2`
        : `${base}`;
      const params = limit !== undefined ? [limit, offset ?? 0] : [];
      const dr = await client.query(q, params);
      const columns: ColInfo[] = dr.fields.map(f => ({ name: f.name, type: 'text', nullable: true }));
      return { rows: dr.rows, columns, totalCount: totalCount || dr.rows.length };
    } finally {
      client.release();
      await pool.end();
    }
  } else if (type.includes('mysql')) {
    const mysql = await import('mysql2/promise' as any);
    const c = await (mysql as any).createConnection({
      host: cfg.host, port: parseInt(cfg.port || '3306'),
      database: cfg.database, user: cfg.username || cfg.user, password: cfg.password,
    });
    try {
      let totalCount = 0;
      if (limit !== undefined) {
        const [cr]: any = await c.execute(`SELECT COUNT(*) AS cnt FROM (${base}) AS _q ${wherePart}`);
        totalCount = Number(cr[0]?.cnt ?? 0);
      }
      const q = limit !== undefined
        ? `SELECT * FROM (${base}) AS _q ${wherePart} LIMIT ? OFFSET ?`
        : base;
      const params = limit !== undefined ? [limit, offset ?? 0] : [];
      const [rows, fields]: any = await c.execute(q, params);
      const columns: ColInfo[] = (fields as any[]).map((f: any) => ({ name: f.name, type: 'text', nullable: true }));
      return { rows, columns, totalCount: totalCount || rows.length };
    } finally {
      await c.end();
    }
  } else if (type.includes('oracle')) {
    const svc = cfg.options?.serviceName || cfg.serviceName || cfg.database;
    const cs = `${cfg.host}:${cfg.port || 1521}/${svc}`;
    const c = await oracledb.getConnection({ user: cfg.username || cfg.user, password: cfg.password, connectString: cs });
    try {
      let totalCount = 0;
      if (limit !== undefined) {
        const cr = await c.execute(`SELECT COUNT(*) AS CNT FROM (${base}) t ${wherePart}`);
        totalCount = Number((cr.rows as any[])[0]?.[0] ?? 0);
      }
      const q = limit !== undefined
        ? `SELECT * FROM (${base}) t ${wherePart} OFFSET ${offset ?? 0} ROWS FETCH FIRST ${limit} ROWS ONLY`
        : base;
      const dr = await c.execute(q, [], { outFormat: oracledb.OUT_FORMAT_OBJECT });
      const rows = (dr.rows || []) as any[];
      const columns: ColInfo[] = (dr.metaData || []).map((m: any) => ({ name: m.name, type: 'text', nullable: true }));
      return { rows, columns, totalCount: totalCount || rows.length };
    } finally {
      await c.close();
    }
  }
  throw new Error(`Unsupported connection type: ${type}`);
}

/** Get list of tables/views from a connection */
async function getTableList(connectionId: string): Promise<string[]> {
  const conn = await prisma.wbConnection.findUnique({ where: { id: connectionId } });
  if (!conn) throw new Error('Connection not found');
  let cfg: any = {};
  try { cfg = JSON.parse(conn.config); } catch {}
  const type = conn.type;

  if (type.includes('postgresql') || type === 'postgres') {
    const pool = new PgPool({
      host: cfg.host, port: parseInt(cfg.port || '5432'),
      database: cfg.database, user: cfg.username || cfg.user, password: cfg.password,
      ssl: cfg.ssl ? { rejectUnauthorized: false } : false,
    });
    const client = await pool.connect();
    try {
      const r = await client.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`
      );
      return r.rows.map((row: any) => row.table_name);
    } finally { client.release(); await pool.end(); }
  } else if (type.includes('mysql')) {
    const mysql = await import('mysql2/promise' as any);
    const c = await (mysql as any).createConnection({
      host: cfg.host, port: parseInt(cfg.port || '3306'),
      database: cfg.database, user: cfg.username || cfg.user, password: cfg.password,
    });
    try {
      const [rows]: any = await c.execute('SHOW TABLES');
      return rows.map((r: any) => Object.values(r)[0] as string);
    } finally { await c.end(); }
  } else if (type.includes('oracle')) {
    const svc = cfg.options?.serviceName || cfg.serviceName || cfg.database;
    const cs = `${cfg.host}:${cfg.port || 1521}/${svc}`;
    const c = await oracledb.getConnection({ user: cfg.username || cfg.user, password: cfg.password, connectString: cs });
    try {
      const r = await c.execute(`SELECT table_name FROM user_tables ORDER BY table_name`, [], { outFormat: oracledb.OUT_FORMAT_OBJECT });
      return ((r.rows || []) as any[]).map((row: any) => row.TABLE_NAME);
    } finally { await c.close(); }
  }
  throw new Error(`Unsupported connection type: ${type}`);
}

/** Get column schema for a table */
async function getTableSchema(connectionId: string, tableName: string): Promise<ColInfo[]> {
  const conn = await prisma.wbConnection.findUnique({ where: { id: connectionId } });
  if (!conn) throw new Error('Connection not found');
  let cfg: any = {};
  try { cfg = JSON.parse(conn.config); } catch {}
  const type = conn.type;

  if (type.includes('postgresql') || type === 'postgres') {
    const pool = new PgPool({
      host: cfg.host, port: parseInt(cfg.port || '5432'),
      database: cfg.database, user: cfg.username || cfg.user, password: cfg.password,
      ssl: cfg.ssl ? { rejectUnauthorized: false } : false,
    });
    const client = await pool.connect();
    try {
      const r = await client.query(
        `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`,
        [tableName]
      );
      return r.rows.map((row: any) => ({ name: row.column_name, type: row.data_type, nullable: row.is_nullable === 'YES' }));
    } finally { client.release(); await pool.end(); }
  } else if (type.includes('mysql')) {
    const mysql = await import('mysql2/promise' as any);
    const c = await (mysql as any).createConnection({
      host: cfg.host, port: parseInt(cfg.port || '3306'),
      database: cfg.database, user: cfg.username || cfg.user, password: cfg.password,
    });
    try {
      const [rows]: any = await c.execute(`DESCRIBE \`${tableName}\``);
      return rows.map((r: any) => ({ name: r.Field, type: r.Type, nullable: r.Null === 'YES' }));
    } finally { await c.end(); }
  } else if (type.includes('oracle')) {
    const svc = cfg.options?.serviceName || cfg.serviceName || cfg.database;
    const cs = `${cfg.host}:${cfg.port || 1521}/${svc}`;
    const c = await oracledb.getConnection({ user: cfg.username || cfg.user, password: cfg.password, connectString: cs });
    try {
      const r = await c.execute(
        `SELECT column_name, data_type, nullable FROM user_tab_columns WHERE table_name=:1 ORDER BY column_id`,
        [tableName.toUpperCase()], { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );
      return ((r.rows || []) as any[]).map((row: any) => ({ name: row.COLUMN_NAME, type: row.DATA_TYPE, nullable: row.NULLABLE === 'Y' }));
    } finally { await c.close(); }
  }
  throw new Error(`Unsupported connection type: ${type}`);
}

/** Build WHERE clause from folder path (all ancestor partitions) */
async function buildFolderWhere(folderId: string): Promise<string> {
  const conditions: string[] = [];
  let currentId: string | null = folderId;
  while (currentId) {
    const folder: any = await prisma.wbFolder.findUnique({ where: { id: currentId } });
    if (!folder) break;
    conditions.unshift(`"${folder.partitionField}" = '${folder.partitionValue.replace(/'/g, "''")}'`);
    currentId = folder.parentId;
  }
  return conditions.join(' AND ');
}

// ─── Connections ──────────────────────────────────────────────────────────────

router.get('/connections', async (_req: Request, res: Response) => {
  try {
    const connections = await prisma.wbConnection.findMany({ orderBy: { createdAt: 'asc' } });
    res.json({ success: true, data: { connections } });
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});

router.post('/connections', async (req: Request, res: Response) => {
  try {
    const { name, type, config } = req.body;
    if (!name || !type) { res.status(400).json({ success: false, error: 'name and type are required' }); return; }
    const conn = await prisma.wbConnection.create({
      data: { id: `wbc${crypto.randomBytes(10).toString('hex')}`, name, type, config: JSON.stringify(config || {}) },
    });
    res.json({ success: true, data: { connection: conn } });
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});

router.put('/connections/:id', async (req: Request, res: Response) => {
  try {
    const { name, type, config, status } = req.body;
    const conn = await prisma.wbConnection.update({
      where: { id: req.params.id },
      data: {
        ...(name && { name }),
        ...(type && { type }),
        ...(config !== undefined && { config: JSON.stringify(config) }),
        ...(status && { status }),
      },
    });
    res.json({ success: true, data: { connection: conn } });
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});

router.delete('/connections/:id', async (req: Request, res: Response) => {
  try {
    await prisma.wbConnection.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});

// Test connection + list tables
router.post('/connections/:id/test', async (req: Request, res: Response) => {
  try {
    const tables = await getTableList(req.params.id);
    await prisma.wbConnection.update({ where: { id: req.params.id }, data: { status: 'Connected' } });
    res.json({ success: true, data: { tables, count: tables.length } });
  } catch (err: any) {
    await prisma.wbConnection.update({ where: { id: req.params.id }, data: { status: 'Error' } }).catch(() => {});
    res.status(500).json({ success: false, error: err.message });
  }
});

// Browse tables from connection
router.get('/connections/:id/tables', async (req: Request, res: Response) => {
  try {
    const { search } = req.query;
    let tables = await getTableList(req.params.id);
    if (search) tables = tables.filter(t => t.toLowerCase().includes((search as string).toLowerCase()));
    res.json({ success: true, data: { tables } });
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});

// Get column schema for a specific table
router.get('/connections/:id/tables/:tableName/schema', async (req: Request, res: Response) => {
  try {
    const columns = await getTableSchema(req.params.id, req.params.tableName);
    res.json({ success: true, data: { columns } });
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});

// ─── API Keys ─────────────────────────────────────────────────────────────────

router.get('/api-keys', async (_req: Request, res: Response) => {
  try {
    const keys = await prisma.wbApiKey.findMany({ orderBy: { createdAt: 'desc' } });
    res.json({ success: true, data: { keys } });
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});

router.post('/api-keys', async (req: Request, res: Response) => {
  try {
    const { name, permissions, expiresAt } = req.body;
    if (!name) { res.status(400).json({ success: false, error: 'name is required' }); return; }
    const key = await prisma.wbApiKey.create({
      data: {
        id: `wbk${crypto.randomBytes(10).toString('hex')}`,
        name,
        key: generateKey('wb'),
        permissions: permissions || 'read',
        expiresAt: expiresAt ? new Date(expiresAt) : null,
      },
    });
    res.json({ success: true, data: { key } });
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});

router.put('/api-keys/:id', async (req: Request, res: Response) => {
  try {
    const { name, permissions, isActive, expiresAt } = req.body;
    const key = await prisma.wbApiKey.update({
      where: { id: req.params.id },
      data: {
        ...(name && { name }),
        ...(permissions && { permissions }),
        ...(isActive !== undefined && { isActive }),
        ...(expiresAt !== undefined && { expiresAt: expiresAt ? new Date(expiresAt) : null }),
      },
    });
    res.json({ success: true, data: { key } });
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});

router.delete('/api-keys/:id', async (req: Request, res: Response) => {
  try {
    await prisma.wbApiKey.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});

// ─── Datasets ─────────────────────────────────────────────────────────────────

router.get('/datasets', async (_req: Request, res: Response) => {
  try {
    const datasets = await prisma.wbDataset.findMany({
      include: { connection: { select: { id: true, name: true, type: true, status: true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ success: true, data: { datasets } });
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});

router.get('/datasets/:id', async (req: Request, res: Response) => {
  try {
    const dataset = await prisma.wbDataset.findUnique({
      where: { id: req.params.id },
      include: {
        connection: { select: { id: true, name: true, type: true, status: true } },
        folders: { orderBy: { path: 'asc' } },
        savedQueries: { orderBy: { updatedAt: 'desc' } },
      },
    });
    if (!dataset) { res.status(404).json({ success: false, error: 'Dataset not found' }); return; }
    res.json({ success: true, data: { dataset } });
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});

// Add a table from connection as a dataset
router.post('/datasets', async (req: Request, res: Response) => {
  try {
    const { connectionId, tableName, name, description } = req.body;
    if (!connectionId || !tableName) { res.status(400).json({ success: false, error: 'connectionId and tableName required' }); return; }

    // Fetch schema live from connection
    const columns = await getTableSchema(connectionId, tableName);

    const dataset = await prisma.wbDataset.create({
      data: {
        id: `wbd${crypto.randomBytes(10).toString('hex')}`,
        connectionId,
        tableName,
        name: name || tableName,
        description: description || null,
        schema: JSON.stringify(columns),
      },
      include: { connection: { select: { id: true, name: true, type: true } } },
    });
    res.json({ success: true, data: { dataset } });
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});

router.put('/datasets/:id', async (req: Request, res: Response) => {
  try {
    const { name, description } = req.body;
    const dataset = await prisma.wbDataset.update({
      where: { id: req.params.id },
      data: { ...(name && { name }), ...(description !== undefined && { description }) },
    });
    res.json({ success: true, data: { dataset } });
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});

router.delete('/datasets/:id', async (req: Request, res: Response) => {
  try {
    await prisma.wbDataset.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});

// Refresh schema from live connection
router.post('/datasets/:id/refresh-schema', async (req: Request, res: Response) => {
  try {
    const dataset = await prisma.wbDataset.findUnique({ where: { id: req.params.id } });
    if (!dataset) { res.status(404).json({ success: false, error: 'Dataset not found' }); return; }
    const columns = await getTableSchema(dataset.connectionId, dataset.tableName);
    await prisma.wbDataset.update({ where: { id: dataset.id }, data: { schema: JSON.stringify(columns), updatedAt: new Date() } });
    res.json({ success: true, data: { columns } });
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});

// ─── Folders (Virtual Partition) ─────────────────────────────────────────────

router.get('/datasets/:datasetId/folders', async (req: Request, res: Response) => {
  try {
    const folders = await prisma.wbFolder.findMany({
      where: { datasetId: req.params.datasetId, parentId: null },
      include: { children: { include: { children: true } } },
      orderBy: { path: 'asc' },
    });
    res.json({ success: true, data: { folders } });
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});

router.post('/datasets/:datasetId/folders', async (req: Request, res: Response) => {
  try {
    const { name, partitionField, partitionValue, parentId } = req.body;
    if (!name || !partitionField || !partitionValue) {
      res.status(400).json({ success: false, error: 'name, partitionField, partitionValue required' }); return;
    }

    let parentPath = '';
    if (parentId) {
      const parent = await prisma.wbFolder.findUnique({ where: { id: parentId } });
      if (!parent) { res.status(400).json({ success: false, error: 'Parent folder not found' }); return; }
      parentPath = parent.path;
    }
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    const path = parentPath ? `${parentPath}/${slug}` : slug;

    const folder = await prisma.wbFolder.create({
      data: {
        id: `wbf${crypto.randomBytes(10).toString('hex')}`,
        datasetId: req.params.datasetId,
        parentId: parentId || null,
        name, partitionField, partitionValue, path,
      },
    });
    res.json({ success: true, data: { folder } });
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});

router.delete('/folders/:id', async (req: Request, res: Response) => {
  try {
    await prisma.wbFolder.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});

// ─── Saved Queries ────────────────────────────────────────────────────────────

router.get('/saved-queries', async (req: Request, res: Response) => {
  try {
    const { datasetId } = req.query;
    const queries = await prisma.wbSavedQuery.findMany({
      where: datasetId ? { datasetId: datasetId as string } : {},
      orderBy: { updatedAt: 'desc' },
    });
    res.json({ success: true, data: { queries } });
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});

router.post('/saved-queries', async (req: Request, res: Response) => {
  try {
    const { name, sql, datasetId, description } = req.body;
    if (!name || !sql) { res.status(400).json({ success: false, error: 'name and sql required' }); return; }
    const query = await prisma.wbSavedQuery.create({
      data: { id: `wbq${crypto.randomBytes(10).toString('hex')}`, name, sql, datasetId: datasetId || null, description: description || null },
    });
    res.json({ success: true, data: { query } });
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});

router.put('/saved-queries/:id', async (req: Request, res: Response) => {
  try {
    const { name, sql, description } = req.body;
    const query = await prisma.wbSavedQuery.update({
      where: { id: req.params.id },
      data: { ...(name && { name }), ...(sql && { sql }), ...(description !== undefined && { description }) },
    });
    res.json({ success: true, data: { query } });
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});

router.delete('/saved-queries/:id', async (req: Request, res: Response) => {
  try {
    await prisma.wbSavedQuery.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});

// ─── Dataset Schema & Field Query ────────────────────────────────────────────

// GET /datasets/:id/schema — return cached column list (refresh if empty)
router.get('/datasets/:id/schema', async (req: Request, res: Response) => {
  try {
    const dataset = await prisma.wbDataset.findUnique({ where: { id: req.params.id } });
    if (!dataset) { res.status(404).json({ success: false, error: 'Dataset not found' }); return; }

    let schema: ColInfo[] = [];
    try { schema = JSON.parse(dataset.schema || '[]'); } catch {}

    if (schema.length === 0) {
      schema = await getTableSchema(dataset.connectionId, dataset.tableName);
      await prisma.wbDataset.update({ where: { id: dataset.id }, data: { schema: JSON.stringify(schema) } });
    }

    res.json({ success: true, data: { columns: schema } });
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});

// POST /datasets/:id/query — build + execute SQL from field list & filters
router.post('/datasets/:id/query', async (req: Request, res: Response) => {
  try {
    const dataset = await prisma.wbDataset.findUnique({ where: { id: req.params.id } });
    if (!dataset) { res.status(404).json({ success: false, error: 'Dataset not found' }); return; }

    const {
      fields = [] as string[],
      filters = [] as { field: string; op: string; value: string; logic: 'AND' | 'OR' }[],
      limit = 100,
      offset = 0,
    } = req.body;

    // Build SELECT clause
    const selectClause = fields.length > 0
      ? fields.map((f: string) => `"${f.replace(/"/g, '""')}"`).join(', ')
      : '*';

    // Build WHERE clause from filters
    const whereParts: string[] = [];
    for (const f of filters) {
      const col = `"${f.field.replace(/"/g, '""')}"`;
      let condition = '';
      switch (f.op) {
        case '=':   condition = `${col} = '${f.value.replace(/'/g, "''")}'`; break;
        case '!=':  condition = `${col} != '${f.value.replace(/'/g, "''")}'`; break;
        case '>':   condition = `${col} > '${f.value.replace(/'/g, "''")}'`; break;
        case '<':   condition = `${col} < '${f.value.replace(/'/g, "''")}'`; break;
        case '>=':  condition = `${col} >= '${f.value.replace(/'/g, "''")}'`; break;
        case '<=':  condition = `${col} <= '${f.value.replace(/'/g, "''")}'`; break;
        case 'LIKE':    condition = `${col} LIKE '%${f.value.replace(/'/g, "''")}%'`; break;
        case 'NOT LIKE':condition = `${col} NOT LIKE '%${f.value.replace(/'/g, "''")}%'`; break;
        case 'IS NULL': condition = `${col} IS NULL`; break;
        case 'IS NOT NULL': condition = `${col} IS NOT NULL`; break;
        default: continue;
      }
      if (whereParts.length > 0) {
        condition = `${f.logic || 'AND'} ${condition}`;
      }
      whereParts.push(condition);
    }
    const whereClause = whereParts.length > 0 ? `WHERE ${whereParts.join(' ')}` : '';

    const sql = `SELECT ${selectClause} FROM "${dataset.tableName.replace(/"/g, '""')}" ${whereClause}`;
    const result = await execWbQuery(dataset.connectionId, sql, Math.min(Number(limit), 5000), Number(offset));

    res.json({ success: true, data: result });
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});

// POST /datasets/:id/pivot — pivot (GROUP BY) query against a dataset
router.post('/datasets/:id/pivot', async (req: Request, res: Response) => {
  try {
    const dataset = await prisma.wbDataset.findUnique({ where: { id: req.params.id } });
    if (!dataset) { res.status(404).json({ success: false, error: 'Dataset not found' }); return; }

    const { rows = [], columns = [], values = [], filters = [] } = req.body as {
      rows: string[];
      columns: string[];
      values: { name: string; fn: string }[];
      filters: { field: string; op: string; value: string; logic: string }[];
    };

    if (values.length === 0) {
      res.status(400).json({ success: false, error: 'At least one value field is required' }); return;
    }

    const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const allowedFns = new Set(['SUM', 'COUNT', 'AVG', 'MAX', 'MIN']);

    // SELECT: group-by fields + aggregated value fields
    const groupFields = [...rows, ...columns];
    const selectParts: string[] = groupFields.map(f => esc(f));
    for (const v of values) {
      const fn = allowedFns.has(v.fn.toUpperCase()) ? v.fn.toUpperCase() : 'SUM';
      selectParts.push(`${fn}(${esc(v.name)}) AS "${v.name} (${fn})"`);
    }

    // WHERE from filters (same logic as /datasets/:id/query)
    const whereParts: string[] = [];
    for (const f of filters) {
      const col = esc(f.field);
      let condition = '';
      switch (f.op) {
        case '=':   condition = `${col} = '${f.value.replace(/'/g, "''")}'`; break;
        case '!=':  condition = `${col} != '${f.value.replace(/'/g, "''")}'`; break;
        case '>':   condition = `${col} > '${f.value.replace(/'/g, "''")}'`; break;
        case '<':   condition = `${col} < '${f.value.replace(/'/g, "''")}'`; break;
        case '>=':  condition = `${col} >= '${f.value.replace(/'/g, "''")}'`; break;
        case '<=':  condition = `${col} <= '${f.value.replace(/'/g, "''")}'`; break;
        case 'LIKE':    condition = `${col} LIKE '%${f.value.replace(/'/g, "''")}%'`; break;
        case 'NOT LIKE':condition = `${col} NOT LIKE '%${f.value.replace(/'/g, "''")}%'`; break;
        case 'IS NULL': condition = `${col} IS NULL`; break;
        case 'IS NOT NULL': condition = `${col} IS NOT NULL`; break;
        default: continue;
      }
      if (whereParts.length > 0) {
        condition = `${f.logic || 'AND'} ${condition}`;
      }
      whereParts.push(condition);
    }
    const whereClause = whereParts.length > 0 ? `WHERE ${whereParts.join(' ')}` : '';

    // GROUP BY + ORDER BY
    const groupByClause = groupFields.length > 0
      ? `GROUP BY ${groupFields.map(f => esc(f)).join(', ')}`
      : '';
    const orderByClause = groupFields.length > 0
      ? `ORDER BY ${groupFields.map(f => esc(f)).join(', ')}`
      : '';

    const tableName = esc(dataset.tableName);
    const sql = `SELECT ${selectParts.join(', ')} FROM ${tableName} ${whereClause} ${groupByClause} ${orderByClause} LIMIT 5000`;

    const result = await execWbQuery(dataset.connectionId, sql);

    res.json({
      success: true,
      data: {
        rows: result.rows,
        columns: result.columns,
        totalRows: result.rows.length,
      },
    });
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});

// ─── Query Execution ──────────────────────────────────────────────────────────

// POST /workbench/query — execute SQL against a dataset (live)
// Optionally scoped to a folder (auto-appends WHERE)
router.post('/query', async (req: Request, res: Response) => {
  try {
    const { datasetId, sql, folderId, limit = 200, offset = 0 } = req.body;
    if (!datasetId || !sql) { res.status(400).json({ success: false, error: 'datasetId and sql required' }); return; }

    const dataset = await prisma.wbDataset.findUnique({ where: { id: datasetId } });
    if (!dataset) { res.status(404).json({ success: false, error: 'Dataset not found' }); return; }

    // Build WHERE from folder partitions
    let folderWhere = '';
    if (folderId) {
      folderWhere = await buildFolderWhere(folderId);
    }

    // Wrap user SQL as subquery, inject folder WHERE
    const innerSql = `SELECT * FROM (${sql.trim().replace(/;+$/, '')}) AS _wb`;
    const result = await execWbQuery(dataset.connectionId, innerSql, Math.min(Number(limit), 5000), Number(offset), folderWhere || undefined);

    res.json({ success: true, data: result });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET autocomplete hints (tables + columns for a dataset)
router.get('/datasets/:id/autocomplete', async (req: Request, res: Response) => {
  try {
    const dataset = await prisma.wbDataset.findUnique({ where: { id: req.params.id } });
    if (!dataset) { res.status(404).json({ success: false, error: 'Dataset not found' }); return; }

    let schema: ColInfo[] = [];
    try { schema = JSON.parse(dataset.schema || '[]'); } catch {}

    // If schema empty, refresh live
    if (schema.length === 0) {
      schema = await getTableSchema(dataset.connectionId, dataset.tableName);
    }

    res.json({
      success: true,
      data: {
        tables: [dataset.tableName],
        columns: schema.map(c => ({ table: dataset.tableName, column: c.name, type: c.type })),
      },
    });
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});

// ─── External Public API (API Key auth, no JWT required) ─────────────────────
// These routes are accessible without the internal JWT token.
// Consumers authenticate using X-API-Key or ?apiKey= query param.

async function wbApiKeyAuth(req: Request, res: Response, next: Function) {
  const key = (req.headers['x-api-key'] as string) || (req.query.apiKey as string);
  if (!key) { res.status(401).json({ success: false, error: 'API key required' }); return; }
  const apiKey = await prisma.wbApiKey.findFirst({ where: { key, isActive: true } });
  if (!apiKey) { res.status(401).json({ success: false, error: 'Invalid or inactive API key' }); return; }
  if (apiKey.expiresAt && new Date(apiKey.expiresAt) < new Date()) {
    res.status(401).json({ success: false, error: 'API key expired' }); return;
  }
  (req as any).wbApiKey = apiKey;
  next();
}

// GET /analytics-workbench/ext/datasets — list available datasets
router.get('/ext/datasets', wbApiKeyAuth, async (_req: Request, res: Response) => {
  try {
    const datasets = await prisma.wbDataset.findMany({
      select: { id: true, name: true, tableName: true, description: true },
      orderBy: { name: 'asc' },
    });
    res.json({ success: true, data: { datasets } });
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});

// POST /analytics-workbench/ext/query — execute SQL on a dataset
router.post('/ext/query', wbApiKeyAuth, async (req: Request, res: Response) => {
  try {
    const apiKey = (req as any).wbApiKey;
    if (apiKey.permissions === 'read' || apiKey.permissions === 'write' || apiKey.permissions === 'admin') {
      // All key types can query; fine-grained permission checks can be added later
    }
    const { datasetId, sql, folderId, limit = 200, offset = 0 } = req.body;
    if (!datasetId || !sql) { res.status(400).json({ success: false, error: 'datasetId and sql required' }); return; }

    const dataset = await prisma.wbDataset.findUnique({ where: { id: datasetId } });
    if (!dataset) { res.status(404).json({ success: false, error: 'Dataset not found' }); return; }

    let folderWhere = '';
    if (folderId) folderWhere = await buildFolderWhere(folderId);

    const innerSql = `SELECT * FROM (${sql.trim().replace(/;+$/, '')}) AS _wb`;
    const result = await execWbQuery(dataset.connectionId, innerSql, Math.min(Number(limit), 5000), Number(offset), folderWhere || undefined);
    res.json({ success: true, data: result });
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});

// ─── Export Excel ─────────────────────────────────────────────────────────────

// POST /analytics-workbench/export-excel
// Body: { columns: [{name, type}], rows: [...], sheetName?: string, fileName?: string }
router.post('/export-excel', async (req: Request, res: Response) => {
  try {
    const { columns, rows, sheetName = 'Sheet1', fileName = 'export' } = req.body as {
      columns: { name: string; type?: string }[];
      rows: Record<string, any>[];
      sheetName?: string;
      fileName?: string;
    };

    if (!columns?.length) { res.status(400).json({ success: false, error: 'columns required' }); return; }

    const ExcelJS = require('exceljs');
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet(sheetName.slice(0, 31));

    // Header row
    sheet.columns = columns.map(c => ({ header: c.name, key: c.name, width: Math.max(c.name.length + 2, 12) }));
    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE9D5FF' } };

    // Data rows
    for (const row of rows ?? []) {
      sheet.addRow(columns.map(c => row[c.name] ?? null));
    }

    const safeFileName = fileName.replace(/[^\w\u0E00-\u0E7F\s-]/g, '_').slice(0, 100);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(safeFileName)}.xlsx"`);

    await workbook.xlsx.write(res);
    res.end();
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});

export default router;
