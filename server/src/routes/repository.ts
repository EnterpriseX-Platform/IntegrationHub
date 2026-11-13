// Data Repository — Backend Routes
// Data stored physically in PostgreSQL schema `repo_data` as dynamic tables rt_<tableId>

import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { authMiddleware } from './auth';
import { currentUser, tableRole, roleAllows, visibleTableIds, MEMBER_ROLES } from '../lib/access';
import { base64Upload } from '../middleware/base64Upload';
import { Pool as PgPool } from 'pg';
import * as crypto from 'crypto';
import * as iconv from 'iconv-lite';
import multer from 'multer';
import path from 'path';
import fs from 'fs';

// Tiny cuid-style id generator: 'c' + base36 timestamp + 16 hex random chars.
// Used for the {{cuid}} template var in import default values. Avoids pulling
// in @paralleldrive/cuid2 which is ESM-only and breaks our CommonJS build.
function makeCuidLike(): string {
  return 'c' + Date.now().toString(36) + crypto.randomBytes(8).toString('hex');
}

const router = Router();
router.use(authMiddleware);

// Non-admins only reach the tables granted to them or to one of their groups:
// viewer can read, query and export; editor can also import, sync and change rows.
// Everything not about a single table (connections, API keys, SQL, folders,
// adding/removing tables, granting access) is admin only.
router.use(async (req, res, next) => {
  try {
    if ((await currentUser(req)).isAdmin || req.path.startsWith('/ext/')) return next();
    if (req.method === 'GET' && (req.path === '/tables' || req.path === '/folders')) return next();
    const m = req.path.match(/^\/tables\/([^/]+)(\/.*)?$/);
    const sub = m?.[2] || '';
    if (m && sub && !sub.startsWith('/members')) {
      const read = req.method === 'GET' || (req.method === 'POST' && sub === '/query');
      if (roleAllows(await tableRole(req, m[1]), read ? 'viewer' : 'editor')) return next();
      return res.status(403).json({ success: false, error: 'You do not have access to this table' });
    }
    if (m && !sub && req.method === 'GET') {
      if (roleAllows(await tableRole(req, m[1]), 'viewer')) return next();
      return res.status(403).json({ success: false, error: 'You do not have access to this table' });
    }
    return res.status(403).json({ success: false, error: 'Admin only' });
  } catch (err) { return next(err); }
});

// Upload dir for repository imports
const uploadDir = path.join(process.env.PATH_UPLOAD_DIR || '/data/uploads', 'repository');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const IMPORT_EXTENSIONS = ['.csv', '.tsv', '.json', '.xlsx', '.xls', '.zip'];
const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (IMPORT_EXTENSIONS.includes(ext)) cb(null, true);
    else cb(new Error(`Unsupported file type: ${ext}`));
  },
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function generateKey(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(24).toString('hex')}`;
}

interface ColSchema { name: string; type: string; nullable: boolean }

// ── Column type inference (internal canonical types) ─────────────────────────
function inferCanonicalType(values: any[]): string {
  const samples = values.filter(v => v !== null && v !== undefined && v !== '').slice(0, 200);
  if (samples.length === 0) return 'TEXT';
  const strs = samples.map(v => String(v).trim());
  if (strs.every(v => /^-?\d+$/.test(v))) {
    return Math.max(...strs.map(v => Math.abs(Number(v)))) > 2147483647 ? 'BIGINT' : 'INTEGER';
  }
  if (strs.every(v => /^-?\d*\.?\d+$/.test(v) && v !== '')) return 'NUMERIC';
  if (strs.every(v => /^(true|false)$/i.test(v))) return 'BOOLEAN';
  if (strs.every(v => /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2})?/.test(v) && !isNaN(Date.parse(v)))) return 'DATETIME';
  return 'TEXT';
}

function inferColumnTypes(columns: ColSchema[], rows: Record<string, any>[]): ColSchema[] {
  return columns.map(col => ({ ...col, type: inferCanonicalType(rows.map(r => r[col.name])) }));
}

// ── DB type mapping per engine ────────────────────────────────────────────────
type DbEngine = 'postgresql' | 'mysql' | 'oracle';

function toDbType(canonical: string, engine: DbEngine): string {
  if (engine === 'mysql') {
    const m: Record<string, string> = { INTEGER: 'INT', BIGINT: 'BIGINT', NUMERIC: 'DECIMAL(20,6)', BOOLEAN: 'TINYINT(1)', DATETIME: 'DATETIME', TEXT: 'LONGTEXT' };
    return m[canonical] ?? 'LONGTEXT';
  }
  if (engine === 'oracle') {
    const m: Record<string, string> = { INTEGER: 'NUMBER(10)', BIGINT: 'NUMBER(19)', NUMERIC: 'NUMBER', BOOLEAN: 'NUMBER(1)', DATETIME: 'TIMESTAMP WITH TIME ZONE', TEXT: 'VARCHAR2(4000)' };
    return m[canonical] ?? 'VARCHAR2(4000)';
  }
  // PostgreSQL
  const m: Record<string, string> = { INTEGER: 'INTEGER', BIGINT: 'BIGINT', NUMERIC: 'NUMERIC', BOOLEAN: 'BOOLEAN', DATETIME: 'TIMESTAMPTZ', TEXT: 'TEXT' };
  return m[canonical] ?? 'TEXT';
}

function quoteIdent(name: string, engine: DbEngine): string {
  // Split on dot so "APP.IMPORT_DATA" becomes "APP"."IMPORT_DATA"
  // — otherwise Oracle treats the whole quoted string as one identifier.
  const parts = name.split('.');
  if (engine === 'mysql') return parts.map(p => `\`${p.replace(/`/g, '``')}\``).join('.');
  return parts.map(p => `"${p.replace(/"/g, '""')}"`).join('.');
}

// Physical table name — use the original table name directly (connect to source DB)
function physicalTableName(name: string): string {
  return name;
}

function detectEngine(type: string): DbEngine {
  if (type.includes('mysql')) return 'mysql';
  if (type.includes('oracle')) return 'oracle';
  return 'postgresql';
}

// ── Connection helpers ────────────────────────────────────────────────────────

async function getConnInfo(connectionId: string): Promise<{ engine: DbEngine; cfg: any }> {
  const conn = await prisma.repoConnection.findUnique({ where: { id: connectionId } });
  if (!conn) throw new Error('Connection not found');
  let cfg: any = {};
  try { cfg = JSON.parse(conn.config); } catch {}
  return { engine: detectEngine(conn.type), cfg };
}

async function withPgClient<T>(cfg: any, fn: (client: any) => Promise<T>): Promise<T> {
  const pool = new PgPool({ host: cfg.host, port: parseInt(cfg.port || '5432'), database: cfg.database, user: cfg.username || cfg.user, password: cfg.password, ssl: cfg.ssl ? { rejectUnauthorized: false } : false, connectionTimeoutMillis: 15000 });
  const client = await pool.connect();
  try { return await fn(client); } finally { client.release(); await pool.end(); }
}

async function withMysqlConn<T>(cfg: any, fn: (c: any) => Promise<T>): Promise<T> {
  const mysql = await import('mysql2/promise' as any);
  const c = await (mysql as any).createConnection({ host: cfg.host, port: parseInt(cfg.port || '3306'), database: cfg.database, user: cfg.username || cfg.user, password: cfg.password, connectTimeout: 15000 });
  try { return await fn(c); } finally { await c.end(); }
}

async function withOracleConn<T>(cfg: any, fn: (c: any) => Promise<T>): Promise<T> {
  const oracledb = require('oracledb');
  oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;
  const svc = cfg.options?.serviceName || cfg.serviceName || cfg.database;
  const c = await oracledb.getConnection({ user: cfg.username || cfg.user, password: cfg.password, connectString: `${cfg.host}:${cfg.port || 1521}/${svc}` });
  try { return await fn(c); } finally { await c.close(); }
}

// ── DDL: create/replace table in target DB ────────────────────────────────────

async function createOrReplaceTable(connectionId: string, tableName: string, columns: ColSchema[]): Promise<void> {
  if (columns.length === 0) return;
  const { engine, cfg } = await getConnInfo(connectionId);
  const q = (n: string) => quoteIdent(n, engine);
  const tbl = q(tableName);
  const colDefs = columns.map(c => `${q(c.name)} ${toDbType(c.type, engine)}`).join(', ');

  if (engine === 'postgresql') {
    await withPgClient(cfg, async (client) => {
      await client.query(`DROP TABLE IF EXISTS ${tbl}`);
      await client.query(`CREATE TABLE ${tbl} (${colDefs})`);
    });
  } else if (engine === 'mysql') {
    await withMysqlConn(cfg, async (c) => {
      await c.execute(`DROP TABLE IF EXISTS ${tbl}`);
      await c.execute(`CREATE TABLE ${tbl} (${colDefs})`);
    });
  } else if (engine === 'oracle') {
    await withOracleConn(cfg, async (c) => {
      await c.execute(`BEGIN EXECUTE IMMEDIATE 'DROP TABLE ${tbl}'; EXCEPTION WHEN OTHERS THEN NULL; END;`);
      await c.execute(`CREATE TABLE ${tbl} (${colDefs})`);
    });
  }
}

// ── DDL: ALTER TABLE ADD COLUMN (idempotent — duplicate-column errors are swallowed)
// Used by the import flow when the user requested new destination columns via
// the Mapping modal's "Create new column" form. The chosen type is passed
// verbatim, e.g. VARCHAR2(500) (Oracle), VARCHAR(255) (PG/MySQL), NUMBER, DATE.
//
// Returns the list of column names that were actually added (excluding ones
// the engine reported as already existing).
async function addColumnsToTable(
  connectionId: string,
  tableName: string,
  newCols: { name: string; type: string }[]
): Promise<string[]> {
  if (newCols.length === 0) return [];
  const { engine, cfg } = await getConnInfo(connectionId);
  const q = (n: string) => quoteIdent(n, engine);
  const tbl = q(tableName);
  // Engine-specific "column already exists" detection.
  // Oracle ORA-01430, PG SQLSTATE 42701, MySQL ER_DUP_FIELDNAME (1060).
  const isDuplicate = (err: any): boolean => {
    const msg = String(err?.message || err || '').toLowerCase();
    return /ora-01430/.test(msg) || /already exists/.test(msg) || /duplicate column/.test(msg) || err?.code === '42701' || err?.errno === 1060;
  };
  const added: string[] = [];
  for (const c of newCols) {
    const colName = (c.name || '').trim();
    const colType = (c.type || '').trim();
    if (!colName || !colType) continue;
    // Whitelist allowed characters in the type string to prevent SQL injection
    // (we still bind nothing — this is DDL — so be strict).
    if (!/^[A-Za-z0-9_(),\s.]+$/.test(colType)) {
      throw new Error(`Invalid column type: "${colType}"`);
    }
    try {
      if (engine === 'oracle') {
        await withOracleConn(cfg, async (cn) => {
          await cn.execute(`ALTER TABLE ${tbl} ADD (${q(colName)} ${colType})`);
          await cn.commit();
        });
      } else if (engine === 'postgresql') {
        await withPgClient(cfg, async (client) => {
          await client.query(`ALTER TABLE ${tbl} ADD COLUMN IF NOT EXISTS ${q(colName)} ${colType}`);
        });
      } else if (engine === 'mysql') {
        await withMysqlConn(cfg, async (cn) => {
          await cn.execute(`ALTER TABLE ${tbl} ADD COLUMN ${q(colName)} ${colType}`);
        });
      }
      added.push(colName);
    } catch (e: any) {
      if (isDuplicate(e)) {
        // already exists — fine, treat as no-op
        continue;
      }
      throw new Error(`ALTER TABLE ${tableName} ADD ${colName} ${colType} failed: ${e?.message || e}`);
    }
  }
  return added;
}

// ── DML: bulk insert rows ─────────────────────────────────────────────────────

function castValue(v: any, type: string): any {
  if (v === '' || v === undefined) return null;
  if (v === null) return null;
  if (type === 'BOOLEAN') return /^(true|yes|1)$/i.test(String(v));
  if (type === 'INTEGER' || type === 'BIGINT') return parseInt(String(v), 10) || null;
  if (type === 'NUMERIC') return parseFloat(String(v)) || null;
  return v;
}

/**
 * Delete rows in `tableName` whose values in `keyCols` match any tuple present in `rows`.
 * Used by import mode='merge' to upsert: delete matching, then bulk-insert.
 * Returns total number of rows deleted.
 */
async function deleteByKeys(
  connectionId: string,
  tableName: string,
  keyCols: string[],
  rows: Record<string, any>[]
): Promise<number> {
  if (rows.length === 0 || keyCols.length === 0) return 0;
  const { engine, cfg } = await getConnInfo(connectionId);
  const q = (n: string) => quoteIdent(n, engine);

  // Collect distinct key tuples (case-insensitive lookup so file headers can be lowercase)
  const seen = new Set<string>();
  const tuples: any[][] = [];
  for (const r of rows) {
    const rowKeysCi: Record<string, string> = {};
    for (const k of Object.keys(r)) rowKeysCi[k.toLowerCase()] = k;
    const tup = keyCols.map(k => {
      const realKey = rowKeysCi[k.toLowerCase()];
      return realKey === undefined ? null : r[realKey];
    });
    const sig = JSON.stringify(tup);
    if (!seen.has(sig)) { seen.add(sig); tuples.push(tup); }
  }
  if (tuples.length === 0) return 0;

  let deleted = 0;
  const CHUNK = 500;
  if (engine === 'oracle') {
    await withOracleConn(cfg, async (c) => {
      const ph = keyCols.map((_, i) => ':' + (i + 1)).join(' AND ' + keyCols.map(() => '').join(''));
      const where = keyCols.map((k, i) => `${q(k)} = :${i + 1}`).join(' AND ');
      const sql = `DELETE FROM ${quoteTable(tableName, engine)} WHERE ${where}`;
      for (let i = 0; i < tuples.length; i += CHUNK) {
        const batch = tuples.slice(i, i + CHUNK);
        const res = await (c as any).executeMany(sql, batch, { autoCommit: false });
        deleted += res.rowsAffected || 0;
      }
      await c.commit();
      void ph; // silence unused warning
    });
  } else if (engine === 'postgresql') {
    await withPgClient(cfg, async (client) => {
      for (let i = 0; i < tuples.length; i += CHUNK) {
        const batch = tuples.slice(i, i + CHUNK);
        // Build "WHERE (k1,k2) IN ((v1,v2),(v3,v4))"
        const params: any[] = [];
        const tuplePh = batch.map(tup => '(' + tup.map(v => { params.push(v); return '$' + params.length; }).join(',') + ')').join(',');
        const sql = `DELETE FROM ${quoteTable(tableName, engine)} WHERE (${keyCols.map(q).join(',')}) IN (${tuplePh})`;
        const r = await client.query(sql, params);
        deleted += r.rowCount || 0;
      }
    });
  } else if (engine === 'mysql') {
    await withMysqlConn(cfg, async (c) => {
      for (let i = 0; i < tuples.length; i += CHUNK) {
        const batch = tuples.slice(i, i + CHUNK);
        const params: any[] = [];
        const tuplePh = batch.map(tup => '(' + tup.map(v => { params.push(v); return '?'; }).join(',') + ')').join(',');
        const sql = `DELETE FROM ${quoteTable(tableName, engine)} WHERE (${keyCols.map(q).join(',')}) IN (${tuplePh})`;
        const [r]: any = await c.execute(sql, params);
        deleted += r.affectedRows || 0;
      }
    });
  }
  return deleted;
}

/** Helper to quote `OWNER.TABLE` properly across engines */
function quoteTable(tableName: string, engine: any): string {
  const parts = tableName.split('.');
  return parts.map(p => quoteIdent(p, engine)).join('.');
}

/**
 * Delete rows matching multiple conditions joined by AND, where each condition
 * is "column IN (values…)".  Example:
 *   conditions = [
 *     { column: "SOURCE", values: ["SRC_A", "SRC_B"] },
 *     { column: "FYEAR",  values: ["2567"] }
 *   ]
 * Generates: DELETE FROM tbl WHERE SOURCE IN ('SRC_A', 'SRC_B') AND FYEAR IN ('2567')
 */
async function deleteByConditions(
  connectionId: string,
  tableName: string,
  conditions: { column: string; values: any[] }[]
): Promise<number> {
  if (conditions.length === 0) return 0;
  const valid = conditions.filter(c => c.column && Array.isArray(c.values) && c.values.length > 0);
  if (valid.length === 0) return 0;

  const { engine, cfg } = await getConnInfo(connectionId);
  const q = (n: string) => quoteIdent(n, engine);
  const tbl = quoteTable(tableName, engine);

  if (engine === 'oracle') {
    return withOracleConn(cfg, async (c) => {
      const binds: any[] = [];
      const where = valid.map(cond => {
        const ph = cond.values.map(v => { binds.push(v); return ':' + binds.length; }).join(', ');
        return `${q(cond.column)} IN (${ph})`;
      }).join(' AND ');
      const sql = `DELETE FROM ${tbl} WHERE ${where}`;
      const res = await c.execute(sql, binds);
      await c.commit();
      return res.rowsAffected || 0;
    });
  } else if (engine === 'postgresql') {
    return withPgClient(cfg, async (client) => {
      const params: any[] = [];
      const where = valid.map(cond => {
        const ph = cond.values.map(v => { params.push(v); return '$' + params.length; }).join(', ');
        return `${q(cond.column)} IN (${ph})`;
      }).join(' AND ');
      const sql = `DELETE FROM ${tbl} WHERE ${where}`;
      const r = await client.query(sql, params);
      return r.rowCount || 0;
    });
  } else if (engine === 'mysql') {
    return withMysqlConn(cfg, async (c) => {
      const params: any[] = [];
      const where = valid.map(cond => {
        const ph = cond.values.map(v => { params.push(v); return '?'; }).join(', ');
        return `${q(cond.column)} IN (${ph})`;
      }).join(' AND ');
      const sql = `DELETE FROM ${tbl} WHERE ${where}`;
      const [r]: any = await c.execute(sql, params);
      return r.affectedRows || 0;
    });
  }
  return 0;
}

async function bulkInsert(connectionId: string, tableName: string, columns: ColSchema[], rows: Record<string, any>[]): Promise<number> {
  if (rows.length === 0 || columns.length === 0) return 0;
  const { engine, cfg } = await getConnInfo(connectionId);
  const q = (n: string) => quoteIdent(n, engine);
  const tbl = q(tableName);
  // Oracle: uppercase column names to avoid case-sensitivity issues with double-quoted identifiers
  const colNames = columns.map(c => q(engine === 'oracle' ? c.name.toUpperCase() : c.name)).join(', ');
  const CHUNK = 500;
  let inserted = 0;

  if (engine === 'postgresql') {
    await withPgClient(cfg, async (client) => {
      await client.query('BEGIN');
      for (let i = 0; i < rows.length; i += CHUNK) {
        const chunk = rows.slice(i, i + CHUNK);
        const placeholders = chunk.map((_, ri) => `(${columns.map((_, ci) => `$${ri * columns.length + ci + 1}`).join(', ')})`).join(', ');
        const params = chunk.flatMap(row => columns.map(c => castValue(row[c.name], c.type)));
        await client.query(`INSERT INTO ${tbl} (${colNames}) VALUES ${placeholders}`, params);
        inserted += chunk.length;
      }
      await client.query('COMMIT');
    });
  } else if (engine === 'mysql') {
    await withMysqlConn(cfg, async (c) => {
      await c.beginTransaction();
      for (let i = 0; i < rows.length; i += CHUNK) {
        const chunk = rows.slice(i, i + CHUNK);
        const placeholders = chunk.map(() => `(${columns.map(() => '?').join(', ')})`).join(', ');
        const params = chunk.flatMap(row => columns.map(c => castValue(row[c.name], c.type)));
        await c.execute(`INSERT INTO ${tbl} (${colNames}) VALUES ${placeholders}`, params);
        inserted += chunk.length;
      }
      await c.commit();
    });
  } else if (engine === 'oracle') {
    await withOracleConn(cfg, async (c) => {
      // Get actual Oracle column types for proper casting
      const colTypeResult = await c.execute(
        `SELECT COLUMN_NAME, DATA_TYPE FROM USER_TAB_COLUMNS WHERE TABLE_NAME = :1`,
        [tableName.toUpperCase()]
      );
      const oraTypes: Record<string, string> = {};
      if (colTypeResult.rows) {
        for (const r of colTypeResult.rows as any[]) {
          oraTypes[r[0]] = r[1];
        }
      }
      const castOracle = (v: any, colName: string): any => {
        if (v === '' || v === undefined || v === null || v === 'NULL' || v === 'null') return null;
        const dt = oraTypes[colName.toUpperCase()];
        if (dt === 'NUMBER') {
          if (typeof v === 'number') return v;
          const s = String(v).trim();
          if (s === '' || s === '-') return null;
          const n = parseFloat(s);
          return isNaN(n) ? null : n;
        }
        if (dt === 'DATE' || (dt && dt.startsWith('TIMESTAMP'))) {
          const s = String(v).trim();
          if (!s) return null;
          return s;
        }
        return String(v);
      };
      const bindNames = columns.map((_, ci) => `:${ci + 1}`).join(', ');
      const sql = `INSERT INTO ${tbl} (${colNames}) VALUES (${bindNames})`;
      // Use row-by-row for reliability (executeMany has issues with mixed null/number patterns)
      let errCount = 0;
      for (let i = 0; i < rows.length; i += CHUNK) {
        const chunk = rows.slice(i, i + CHUNK);
        for (const row of chunk) {
          try {
            const binds = columns.map(col => castOracle(row[col.name], col.name));
            await c.execute(sql, binds);
          } catch (rowErr: any) {
            errCount++;
            if (errCount <= 3) {
              console.error(`[bulk-insert] Row error in ${tableName}:`, rowErr.message);
              const problemCols = columns.map(col => {
                const dt = oraTypes[col.name.toUpperCase()];
                const raw = row[col.name];
                const cast = castOracle(row[col.name], col.name);
                return dt === 'NUMBER' ? `${col.name}=${JSON.stringify(raw)}->${cast}` : null;
              }).filter(Boolean);
              if (problemCols.length) console.error(`  NUMBER cols:`, problemCols.join(', '));
            }
          }
        }
        inserted += chunk.length;
        if (i % (CHUNK * 10) === 0 && i > 0) await c.commit();
      }
      await c.commit();
    });
  }
  return inserted;
}

// ── Query from target DB ──────────────────────────────────────────────────────

async function buildRepoFolderWhere(folderId: string, engine: DbEngine): Promise<string> {
  const parts: string[] = [];
  let current: string | null = folderId;
  while (current) {
    const folder: any = await prisma.repoFolder.findUnique({ where: { id: current } });
    if (!folder) break;
    parts.unshift(`${quoteIdent(folder.partitionField, engine)} = '${folder.partitionValue.replace(/'/g, "''")}'`);
    current = folder.parentId;
  }
  return parts.join(' AND ');
}

// ── Data-tab filters ─────────────────────────────────────────────────────────
//
// The registry lives in `repo_tables.filter_columns`, comma-separated, one
// entry per filterable column:
//
//   COLUMN:label:labelSource:optionsFrom:default
//
//   labelSource  a sibling column holding the display name, or a lookup written
//                as SCHEMA.TABLE.CODE.NAME for tables that store codes only
//   optionsFrom  SCHEMA.TABLE.CODE.NAME — read the dropdown from a small
//                registry table instead of scanning the real one.  May carry a
//                parent clause "@PARENT_COL=parentField" meaning "narrow this
//                list by the value picked in the `parentField` filter"
//   default      value the screen selects on open (big tables need one, or the
//                first query runs unfiltered)

interface FilterSpec {
  column: string;
  label: string;
  labelSource?: string;
  optionsFrom?: string;
  defaultValue?: string;
  parentColumn?: string;
  parentField?: string;
}

// op 'eq' → COLUMN = value (registry filters, exact codes)
// op 'contains' → case-insensitive substring, for the search box on a column head
interface FilterCond { column: string; values: string[]; op?: 'eq' | 'contains' }

const FILTER_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_$#]*$/;

function parseFilterSpecs(raw?: string | null): FilterSpec[] {
  if (!raw) return [];
  const out: FilterSpec[] = [];
  for (const entry of String(raw).split(',')) {
    const text = entry.trim();
    if (!text) continue;
    const [column, label, labelSource, optionsFromRaw, defaultValue] = text.split(':').map(p => p.trim());
    if (!column) continue;
    let optionsFrom = optionsFromRaw || undefined;
    let parentColumn: string | undefined;
    let parentField: string | undefined;
    if (optionsFrom && optionsFrom.includes('@')) {
      const [src, clause] = optionsFrom.split('@');
      optionsFrom = src.trim() || undefined;
      const [pc, pf] = (clause || '').split('=');
      parentColumn = (pc || '').trim() || undefined;
      parentField = (pf || '').trim() || undefined;
    }
    out.push({
      column,
      label: label || column,
      labelSource: labelSource || undefined,
      optionsFrom,
      defaultValue: defaultValue || undefined,
      parentColumn,
      parentField,
    });
  }
  return out;
}

/** Columns the screen may filter on — the registry first, falling back to the
 *  stored schema (a table can be registered before its schema is ever read). */
function allowedFilterColumns(table: { schema?: string | null; filterColumns?: string | null }): Set<string> {
  const out = new Set<string>();
  for (const spec of parseFilterSpecs(table.filterColumns)) out.add(spec.column.toUpperCase());
  try {
    for (const c of JSON.parse(table.schema || '[]') as ColSchema[]) out.add(String(c.name).toUpperCase());
  } catch { /* schema not readable — registry alone decides */ }
  return out;
}

/** Column names a filter payload asks for, in either shape normalizeFilters accepts. */
function filterColumnNames(raw: any): string[] {
  if (Array.isArray(raw)) return raw.map(f => String(f?.column || ''));
  if (raw && typeof raw === 'object') return Object.keys(raw);
  return [];
}

/**
 * allowedFilterColumns, but a column the cached `schema` has never heard of
 * sends us to the database catalog once and the new columns are appended to
 * the cache. Columns added with ALTER TABLE (a table's new columns,
 * STATUS, UPDATED_AT) were otherwise refused as "unknown
 * column" and their filter menus stayed empty.
 */
async function allowedFilterColumnsFor(
  table: { id: string; name: string; connectionId: string | null; schema?: string | null; filterColumns?: string | null },
  wanted: string[],
): Promise<Set<string>> {
  const allowed = allowedFilterColumns(table);
  const missing = wanted.map(c => c.trim().toUpperCase()).filter(c => c && !allowed.has(c));
  if (missing.length === 0 || !table.connectionId) return allowed;
  try {
    const { columns } = await readLiveColumns(table.connectionId, table.name);
    let cached: ColSchema[] = [];
    try { cached = JSON.parse(table.schema || '[]'); } catch { /* rebuild below */ }
    const known = new Set(cached.map(c => String(c.name).toUpperCase()));
    const added = columns
      .filter(c => !known.has(String(c.name).toUpperCase()))
      .map(c => ({ name: String(c.name), type: 'TEXT', nullable: true }));
    if (added.length > 0) {
      table.schema = JSON.stringify([...cached, ...added]);
      await prisma.repoTable.update({ where: { id: table.id }, data: { schema: table.schema } });
    }
    for (const c of columns) allowed.add(String(c.name).toUpperCase());
  } catch { /* catalog unreadable — keep the cached answer */ }
  return allowed;
}

/** Accepts either [{column, value|values}] or a plain {COLUMN: value} map, and
 *  drops anything the table has not declared as filterable. */
function normalizeFilters(raw: any, allowed: Set<string>): FilterCond[] {
  const entries: { column: any; values: any; op?: any }[] = [];
  if (Array.isArray(raw)) {
    for (const f of raw) entries.push({ column: f?.column, values: f?.values !== undefined ? f.values : f?.value, op: f?.op });
  } else if (raw && typeof raw === 'object') {
    for (const [column, values] of Object.entries(raw)) entries.push({ column, values });
  }
  const out: FilterCond[] = [];
  for (const e of entries) {
    const column = String(e.column || '').trim();
    if (!column || !FILTER_IDENT_RE.test(column)) continue;
    if (allowed.size > 0 && !allowed.has(column.toUpperCase())) continue;
    const op: 'eq' | 'contains' = e.op === 'contains' ? 'contains' : 'eq';
    const values = (Array.isArray(e.values) ? e.values : [e.values])
      .filter(v => v !== null && v !== undefined && String(v).trim() !== '')
      .map(v => String(v));
    if (values.length === 0) continue;
    // A substring search is one needle, never a list.
    out.push({ column, values: op === 'contains' ? [values[0]] : values, op });
  }
  return out;
}

/** Searchable text of a column.  Cast so the search works on numbers and dates
 *  too; Oracle's UPPER() converts implicitly and copes with CLOB, which
 *  TO_CHAR does not. */
function likeTarget(quotedCol: string, engine: DbEngine): string {
  if (engine === 'postgresql') return `UPPER(${quotedCol}::text)`;
  if (engine === 'mysql') return `UPPER(CAST(${quotedCol} AS CHAR))`;
  return `UPPER(${quotedCol})`;
}

/** % and _ are LIKE wildcards — a user typing them means the characters. */
function likeNeedle(v: string): string {
  return `%${v.replace(/([\\%_])/g, '\\$1')}%`;
}

/** Builds "COL = ?" / "COL IN (?, ?)" joined by AND, numbering placeholders
 *  from `startIndex` so the caller can append its own LIMIT/OFFSET binds. */
function buildFilterClause(
  filters: FilterCond[],
  engine: DbEngine,
  startIndex: number
): { sql: string; params: any[]; nextIndex: number } {
  const parts: string[] = [];
  const params: any[] = [];
  let i = startIndex;
  const ph = () => {
    const p = engine === 'mysql' ? '?' : engine === 'oracle' ? `:${i}` : `$${i}`;
    i++;
    return p;
  };
  for (const f of filters) {
    const col = quoteIdent(f.column, engine);
    if (f.op === 'contains') {
      const p = ph();
      params.push(likeNeedle(f.values[0]));
      parts.push(`${likeTarget(col, engine)} LIKE UPPER(${p}) ESCAPE '\\'`);
      continue;
    }
    if (f.values.length === 1) {
      const p = ph();
      params.push(f.values[0]);
      parts.push(`${col} = ${p}`);
    } else {
      const list = f.values.map(v => { const p = ph(); params.push(v); return p; });
      parts.push(`${col} IN (${list.join(', ')})`);
    }
  }
  return { sql: parts.join(' AND '), params, nextIndex: i };
}

/** Run one SELECT on a repository connection. Placeholders must already be in
 *  the engine's own style. */
async function runSelectRows(engine: DbEngine, cfg: any, sql: string, params: any[] = []): Promise<any[]> {
  if (engine === 'postgresql') return withPgClient(cfg, async (c) => (await c.query(sql, params)).rows);
  if (engine === 'mysql') return withMysqlConn(cfg, async (c) => { const [rows]: any = await c.execute(sql, params); return rows as any[]; });
  return withOracleConn(cfg, async (c) => ((await c.execute(sql, params)).rows as any[]) || []);
}

/** Splits SCHEMA.TABLE.CODE.NAME (schema optional) into its parts. */
function parseLookupRef(ref?: string): { table: string; codeCol: string; nameCol: string } | null {
  if (!ref) return null;
  const parts = ref.split('.').map(p => p.trim()).filter(Boolean);
  if (parts.length < 3) return null;
  const nameCol = parts[parts.length - 1];
  const codeCol = parts[parts.length - 2];
  const table = parts.slice(0, parts.length - 2).join('.');
  if (!FILTER_IDENT_RE.test(nameCol) || !FILTER_IDENT_RE.test(codeCol)) return null;
  if (!table.split('.').every(p => FILTER_IDENT_RE.test(p))) return null;
  return { table, codeCol, nameCol };
}

async function queryRepoTable(
  connectionId: string,
  tableName: string,
  folderId: string | undefined,
  limit: number,
  offset: number,
  filters: FilterCond[] = []
): Promise<{ rows: any[]; columns: { name: string; type: string }[]; totalCount: number }> {
  const { engine, cfg } = await getConnInfo(connectionId);
  const q = (n: string) => quoteIdent(n, engine);
  const tbl = q(tableName);
  const conds: string[] = [];
  if (folderId) {
    const cond = await buildRepoFolderWhere(folderId, engine);
    if (cond) conds.push(cond);
  }
  // Filter binds come first so LIMIT/OFFSET can keep numbering after them.
  const filt = buildFilterClause(filters, engine, 1);
  if (filt.sql) conds.push(filt.sql);
  const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';

  if (engine === 'postgresql') {
    return withPgClient(cfg, async (client) => {
      const countRes = await client.query(`SELECT COUNT(*) AS cnt FROM ${tbl} ${where}`, filt.params);
      const totalCount = parseInt(countRes.rows[0].cnt, 10);
      const dataRes = await client.query(
        `SELECT *, ctid::text AS "_rid" FROM ${tbl} ${where} LIMIT $${filt.nextIndex} OFFSET $${filt.nextIndex + 1}`,
        [...filt.params, limit, offset]
      );
      const columns = dataRes.fields.filter((f: any) => f.name !== '_rid').map((f: any) => ({ name: f.name, type: 'text' }));
      return { rows: dataRes.rows, columns, totalCount };
    });
  }
  if (engine === 'mysql') {
    return withMysqlConn(cfg, async (c) => {
      const [countRows]: any = await c.execute(`SELECT COUNT(*) AS cnt FROM ${tbl} ${where}`, filt.params);
      const totalCount = Number(countRows[0].cnt);
      const [rows, fields]: any = await c.execute(`SELECT * FROM ${tbl} ${where} LIMIT ? OFFSET ?`, [...filt.params, limit, offset]);
      const rowsWithRid = (rows as any[]).map((r: any, i: number) => ({ ...r, _rid: `mysql:${offset + i}` }));
      const columns = (fields as any[]).map((f: any) => ({ name: f.name, type: 'text' }));
      return { rows: rowsWithRid, columns, totalCount };
    });
  }
  if (engine === 'oracle') {
    return withOracleConn(cfg, async (c) => {
      const oracledb = require('oracledb');
      const countRes = await c.execute(`SELECT COUNT(*) AS CNT FROM ${tbl} ${where}`, filt.params);
      const totalCount = Number((countRes.rows as any[])[0].CNT);
      const dataRes = await c.execute(
        `SELECT t.*, t.ROWID AS "_rid" FROM ${tbl} t ${where} OFFSET :${filt.nextIndex} ROWS FETCH NEXT :${filt.nextIndex + 1} ROWS ONLY`,
        [...filt.params, offset, limit],
        {
          // Coerce CLOB/BLOB to string/buffer so rows serialize cleanly.
          // Without this, oracledb returns Lob objects with circular refs and
          // JSON.stringify throws "Converting circular structure to JSON".
          fetchTypeHandler: (m: any) => {
            if (m.dbType === oracledb.DB_TYPE_CLOB || m.dbType === oracledb.DB_TYPE_NCLOB) return { type: oracledb.STRING };
            if (m.dbType === oracledb.DB_TYPE_BLOB) return { type: oracledb.BUFFER };
            return undefined;
          },
        }
      );
      const columns = (dataRes.metaData as any[]).filter((m: any) => m.name !== '_rid').map((m: any) => ({ name: m.name, type: 'text' }));
      return { rows: dataRes.rows as any[], columns, totalCount };
    });
  }
  throw new Error(`Unsupported engine: ${engine}`);
}

// ── Fetch from source DB (for sync) ──────────────────────────────────────────

async function fetchFromSource(connectionId: string, sql: string): Promise<{ columns: ColSchema[]; rows: Record<string, any>[]; rowsAffected?: number }> {
  const { engine, cfg } = await getConnInfo(connectionId);
  const cleanSql = sql.trim().replace(/;+$/, '');
  // Detect non-SELECT statements so we can run them as DML/DDL (TRUNCATE, DELETE, INSERT, UPDATE, CREATE, DROP, ALTER, MERGE)
  const isNonQuery = /^\s*(INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|COMMENT|BEGIN|COMMIT|ROLLBACK)\b/i.test(cleanSql);

  if (engine === 'postgresql') {
    return withPgClient(cfg, async (client) => {
      const result = await client.query(cleanSql);
      const fields = result.fields || [];
      const columns: ColSchema[] = fields.map((f: any) => ({ name: f.name, type: 'TEXT', nullable: true }));
      const rows = result.rows || [];
      return {
        columns: rows.length > 0 ? inferColumnTypes(columns, rows) : columns,
        rows,
        rowsAffected: result.rowCount ?? 0,
      };
    });
  }
  if (engine === 'mysql') {
    return withMysqlConn(cfg, async (c) => {
      const [rows, fields]: any = await c.execute(cleanSql);
      // For DML, mysql2 returns an object {affectedRows, ...} as rows
      if (isNonQuery || !Array.isArray(rows)) {
        return { columns: [], rows: [], rowsAffected: (rows as any)?.affectedRows ?? 0 };
      }
      const columns: ColSchema[] = (fields as any[] || []).map((f: any) => ({ name: f.name, type: 'TEXT', nullable: true }));
      return { columns: inferColumnTypes(columns, rows), rows, rowsAffected: rows.length };
    });
  }
  if (engine === 'oracle') {
    return withOracleConn(cfg, async (c) => {
      const oracledb = require('oracledb');
      const result = await c.execute(cleanSql, [], {
        autoCommit: true,
        // Coerce CLOB/BLOB so SELECT results with large-text columns serialize cleanly.
        fetchTypeHandler: (m: any) => {
          if (m.dbType === oracledb.DB_TYPE_CLOB || m.dbType === oracledb.DB_TYPE_NCLOB) return { type: oracledb.STRING };
          if (m.dbType === oracledb.DB_TYPE_BLOB) return { type: oracledb.BUFFER };
          return undefined;
        },
      });
      // metaData is only present for SELECT — for INSERT/UPDATE/DELETE/TRUNCATE etc. it's undefined
      const meta = (result.metaData as any[]) || [];
      const rows = (result.rows as any[]) || [];
      const columns: ColSchema[] = meta.map((m: any) => ({ name: m.name, type: 'TEXT', nullable: true }));
      return {
        columns: rows.length > 0 ? inferColumnTypes(columns, rows) : columns,
        rows,
        rowsAffected: result.rowsAffected ?? (isNonQuery ? 0 : rows.length),
      };
    });
  }
  throw new Error(`Unsupported source type: ${engine}`);
}

// ── Append rows (for ext/push) ────────────────────────────────────────────────

async function appendRows(table: { id: string; name: string; connectionId: string | null; schema: string }, rows: Record<string, any>[]): Promise<number> {
  if (!table.connectionId) throw new Error('No connection configured for this table');
  const tableName = physicalTableName(table.name);
  let columns: ColSchema[] = [];
  try { columns = JSON.parse(table.schema || '[]'); } catch {}
  if (columns.length === 0) throw new Error('Table schema not available — please import data first');
  return bulkInsert(table.connectionId, tableName, columns, rows);
}

// ── File parsers ─────────────────────────────────────────────────────────────

interface ParseResult { columns: ColSchema[]; rows: Record<string, any>[] }

async function parseCsvFile(filePath: string, delimiter: string, encoding: string): Promise<ParseResult> {
  const buf = fs.readFileSync(filePath);
  const content = encoding && encoding !== 'utf8' ? iconv.decode(buf, encoding) : buf.toString('utf8');
  const lines = content.split(/\r?\n/).filter(l => l.trim());
  if (lines.length === 0) return { columns: [], rows: [] };
  const parseLine = (line: string): string[] => {
    const result: string[] = [];
    let cur = '', inQuote = false;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '"') {
        if (inQuote && line[i + 1] === '"') { cur += '"'; i++; }
        else inQuote = !inQuote;
      } else if (line[i] === delimiter && !inQuote) { result.push(cur); cur = ''; }
      else cur += line[i];
    }
    result.push(cur);
    return result;
  };
  const headers = parseLine(lines[0]).map(h => h.trim());
  const rows = lines.slice(1).map(line => {
    const vals = parseLine(line);
    const obj: Record<string, any> = {};
    headers.forEach((h, i) => { obj[h] = vals[i] ?? null; });
    return obj;
  });
  const columns: ColSchema[] = headers.map(name => ({ name, type: 'TEXT', nullable: true }));
  return { columns: inferColumnTypes(columns, rows), rows };
}

async function parseJsonFile(filePath: string): Promise<ParseResult> {
  const content = fs.readFileSync(filePath, 'utf8');
  const data = JSON.parse(content);
  const rows: Record<string, any>[] = Array.isArray(data) ? data : [data];
  if (rows.length === 0) return { columns: [], rows: [] };
  const keys = [...new Set(rows.flatMap(r => Object.keys(r)))];
  const columns: ColSchema[] = keys.map(name => ({ name, type: 'TEXT', nullable: true }));
  return { columns: inferColumnTypes(columns, rows), rows };
}

async function parseXlsxFile(filePath: string): Promise<ParseResult> {
  const ExcelJS = require('exceljs');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheet = workbook.worksheets[0];
  if (!sheet) return { columns: [], rows: [] };
  const headers: string[] = [];
  sheet.getRow(1).eachCell({ includeEmpty: false }, (cell: any, col: number) => {
    headers[col - 1] = String(cell.value ?? `col${col}`).trim();
  });
  const rows: Record<string, any>[] = [];
  sheet.eachRow({ includeEmpty: false }, (row: any, rowNum: number) => {
    if (rowNum === 1) return;
    const obj: Record<string, any> = {};
    row.eachCell({ includeEmpty: true }, (cell: any, col: number) => {
      const h = headers[col - 1];
      if (!h) return;
      let v = cell.value;
      if (v instanceof Date) v = v.toISOString();
      else if (v && typeof v === 'object' && 'result' in v) v = v.result;
      else if (v && typeof v === 'object' && 'text' in v) v = v.text;
      obj[h] = v;
    });
    rows.push(obj);
  });
  const columns: ColSchema[] = headers.map(name => ({ name, type: 'TEXT', nullable: true }));
  return { columns: inferColumnTypes(columns, rows), rows };
}

async function parseFile(filePath: string, ext: string, encoding = 'utf8'): Promise<ParseResult> {
  switch (ext) {
    case 'csv': return parseCsvFile(filePath, ',', encoding);
    case 'tsv': return parseCsvFile(filePath, '\t', encoding);
    case 'json': return parseJsonFile(filePath);
    case 'xlsx': case 'xls': return parseXlsxFile(filePath);
    default: throw new Error(`Unsupported file type: ${ext}`);
  }
}

// ─── Connections ──────────────────────────────────────────────────────────────

router.get('/connections', async (_req: Request, res: Response) => {
  try {
    const connections = await prisma.repoConnection.findMany({ orderBy: { createdAt: 'asc' } });
    res.json({ success: true, data: { connections } });
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});

router.post('/connections', async (req: Request, res: Response) => {
  try {
    const { name, type, config } = req.body;
    if (!name || !type) { res.status(400).json({ success: false, error: 'name and type required' }); return; }
    const conn = await prisma.repoConnection.create({
      data: { id: `rpc${crypto.randomBytes(10).toString('hex')}`, name, type, config: JSON.stringify(config || {}) },
    });
    res.json({ success: true, data: { connection: conn } });
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});

router.put('/connections/:id', async (req: Request, res: Response) => {
  try {
    const { name, type, config, status } = req.body;
    const conn = await prisma.repoConnection.update({
      where: { id: req.params.id },
      data: {
        ...(name && { name }), ...(type && { type }),
        ...(config !== undefined && { config: JSON.stringify(config) }),
        ...(status && { status }),
      },
    });
    res.json({ success: true, data: { connection: conn } });
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});

router.delete('/connections/:id', async (req: Request, res: Response) => {
  try {
    await prisma.repoConnection.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});

// Discover tables from a connection's database
router.get('/connections/:id/tables', async (req: Request, res: Response) => {
  try {
    const conn = await prisma.repoConnection.findUnique({ where: { id: req.params.id } });
    if (!conn) { res.status(404).json({ success: false, error: 'Not found' }); return; }
    let cfg: any = {};
    try { cfg = JSON.parse(conn.config); } catch {}
    const type = conn.type;
    let tables: { name: string; schema?: string }[] = [];

    if (type.includes('postgresql') || type === 'postgres') {
      tables = await withPgClient(cfg, async (client) => {
        const res = await client.query(`SELECT table_name AS name, table_schema AS schema FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema') AND table_type = 'BASE TABLE' ORDER BY table_schema, table_name`);
        return res.rows;
      });
    } else if (type === 'mysql') {
      tables = await withMysqlConn(cfg, async (c) => {
        const [rows]: any = await c.execute(`SELECT TABLE_NAME AS name, TABLE_SCHEMA AS \`schema\` FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`);
        return rows;
      });
    } else if (type === 'oracle') {
      tables = await withOracleConn(cfg, async (c) => {
        const result = await c.execute(`SELECT TABLE_NAME AS "name", OWNER AS "schema" FROM ALL_TABLES WHERE OWNER = USER ORDER BY TABLE_NAME`);
        return result.rows as any[];
      });
    }

    res.json({ success: true, data: { tables } });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /connections/:id/columns?table=OWNER.TABLE — column list for the SQL
// editor's schema tree.  Each engine keeps this in its own catalog; Oracle has
// no information_schema at all, which is why the editor used to expand into
// nothing on every connection.
router.get('/connections/:id/columns', async (req: Request, res: Response) => {
  try {
    const conn = await prisma.repoConnection.findUnique({ where: { id: req.params.id } });
    if (!conn) { res.status(404).json({ success: false, error: 'Not found' }); return; }
    const raw = String(req.query.table || '').trim();
    if (!raw) { res.status(400).json({ success: false, error: 'table query param required' }); return; }
    const parts = raw.split('.').map(p => p.trim()).filter(Boolean);
    if (parts.length > 2 || !parts.every(p => FILTER_IDENT_RE.test(p))) {
      res.status(400).json({ success: false, error: 'invalid table name' });
      return;
    }
    const owner = parts.length === 2 ? parts[0] : null;
    const table = parts[parts.length - 1];

    let cfg: any = {};
    try { cfg = JSON.parse(conn.config); } catch {}
    const engine = detectEngine(conn.type);

    let columns: { name: string; type: string }[] = [];
    if (engine === 'postgresql') {
      columns = await withPgClient(cfg, async (client) => {
        const r = await client.query(
          `SELECT column_name AS name, data_type AS type FROM information_schema.columns
            WHERE table_name = $1 AND ($2::text IS NULL OR table_schema = $2) ORDER BY ordinal_position`,
          [table, owner]
        );
        return r.rows;
      });
    } else if (engine === 'mysql') {
      columns = await withMysqlConn(cfg, async (c) => {
        const [rows]: any = await c.execute(
          `SELECT COLUMN_NAME AS name, DATA_TYPE AS type FROM information_schema.COLUMNS
            WHERE TABLE_NAME = ? AND TABLE_SCHEMA = COALESCE(?, DATABASE()) ORDER BY ORDINAL_POSITION`,
          [table, owner]
        );
        return rows as any[];
      });
    } else {
      columns = await withOracleConn(cfg, async (c) => {
        const r = await c.execute(
          `SELECT COLUMN_NAME AS "name", DATA_TYPE AS "type" FROM ALL_TAB_COLUMNS
            WHERE TABLE_NAME = :1 AND OWNER = NVL(:2, USER) ORDER BY COLUMN_ID`,
          [table, owner]
        );
        return (r.rows as any[]) || [];
      });
    }

    res.json({ success: true, data: { columns } });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/connections/:id/test', async (req: Request, res: Response) => {
  try {
    const conn = await prisma.repoConnection.findUnique({ where: { id: req.params.id } });
    if (!conn) { res.status(404).json({ success: false, error: 'Not found' }); return; }
    let cfg: any = {};
    try { cfg = JSON.parse(conn.config); } catch {}
    const type = conn.type;
    let ok = false;
    if (type.includes('postgresql') || type === 'postgres') {
      const pool = new PgPool({ host: cfg.host, port: parseInt(cfg.port || '5432'), database: cfg.database, user: cfg.username || cfg.user, password: cfg.password, ssl: cfg.ssl ? { rejectUnauthorized: false } : false });
      const client = await pool.connect();
      try { await client.query('SELECT 1'); ok = true; } finally { client.release(); await pool.end(); }
    } else if (type === 'mysql') {
      await withMysqlConn(cfg, async (c) => {
        await c.execute('SELECT 1'); ok = true;
      });
    } else if (type === 'oracle') {
      await withOracleConn(cfg, async (c) => {
        await c.execute('SELECT 1 FROM DUAL'); ok = true;
      });
    }
    await prisma.repoConnection.update({ where: { id: req.params.id }, data: { status: ok ? 'Connected' : 'Error' } });
    res.json({ success: true, data: { connected: ok } });
  } catch (err: any) {
    await prisma.repoConnection.update({ where: { id: req.params.id }, data: { status: 'Error' } }).catch(() => {});
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── API Keys ─────────────────────────────────────────────────────────────────

router.get('/api-keys', async (_req: Request, res: Response) => {
  try {
    const keys = await prisma.repoApiKey.findMany({ orderBy: { createdAt: 'desc' } });
    res.json({ success: true, data: { keys } });
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});

router.post('/api-keys', async (req: Request, res: Response) => {
  try {
    const { name, permissions, expiresAt } = req.body;
    if (!name) { res.status(400).json({ success: false, error: 'name required' }); return; }
    const key = await prisma.repoApiKey.create({
      data: {
        id: `rpk${crypto.randomBytes(10).toString('hex')}`,
        name, key: generateKey('repo'),
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
    const key = await prisma.repoApiKey.update({
      where: { id: req.params.id },
      data: {
        ...(name && { name }), ...(permissions && { permissions }),
        ...(isActive !== undefined && { isActive }),
        ...(expiresAt !== undefined && { expiresAt: expiresAt ? new Date(expiresAt) : null }),
      },
    });
    res.json({ success: true, data: { key } });
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});

router.delete('/api-keys/:id', async (req: Request, res: Response) => {
  try {
    await prisma.repoApiKey.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});

// ─── Tables ───────────────────────────────────────────────────────────────────

router.get('/tables', async (req: Request, res: Response) => {
  try {
    const visible = await visibleTableIds(req);
    const tables = await prisma.repoTable.findMany({
      where: visible ? { id: { in: visible } } : undefined,
      include: { connection: { select: { id: true, name: true, type: true } } },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
    });
    res.json({ success: true, data: { tables } });
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});

router.get('/tables/:id', async (req: Request, res: Response) => {
  try {
    const table = await prisma.repoTable.findUnique({
      where: { id: req.params.id },
      include: {
        connection: { select: { id: true, name: true, type: true } },
        folder: true,
      },
    });
    if (!table) { res.status(404).json({ success: false, error: 'Table not found' }); return; }
    res.json({ success: true, data: { table } });
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});

// ─── Table access (admin) ────────────────────────────────────────────────────

router.get('/tables/:id/members', async (req: Request, res: Response) => {
  try {
    const members = await prisma.repoTableMember.findMany({
      where: { tableId: req.params.id },
      include: {
        user: { select: { id: true, email: true, name: true, status: true } },
        group: { select: { id: true, name: true, _count: { select: { members: true } } } },
      },
      orderBy: { createdAt: 'asc' },
    });
    const [users, groups] = await Promise.all([
      prisma.user.findMany({ where: { role: { not: 'admin' } }, select: { id: true, email: true, name: true, status: true }, orderBy: { name: 'asc' } }),
      prisma.userGroup.findMany({ select: { id: true, name: true, _count: { select: { members: true } } }, orderBy: { name: 'asc' } }),
    ]);
    res.json({ success: true, data: { members, users, groups } });
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});

router.post('/tables/:id/members', async (req: Request, res: Response) => {
  try {
    const { userId, groupId, role = 'viewer' } = req.body || {};
    const roles = MEMBER_ROLES.filter((r) => r !== 'owner');
    if (!!userId === !!groupId || !roles.includes(role)) {
      res.status(400).json({ success: false, error: `Give either userId or groupId, and role (${roles.join('/')})` }); return;
    }
    const tableId = req.params.id;
    const member = userId
      ? await prisma.repoTableMember.upsert({ where: { tableId_userId: { tableId, userId } }, create: { tableId, userId, role }, update: { role } })
      : await prisma.repoTableMember.upsert({ where: { tableId_groupId: { tableId, groupId } }, create: { tableId, groupId, role }, update: { role } });
    res.json({ success: true, data: member });
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});

router.delete('/tables/:id/members/:memberId', async (req: Request, res: Response) => {
  try {
    await prisma.repoTableMember.deleteMany({ where: { id: req.params.memberId, tableId: req.params.id } });
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});

// Create new table reference in repository
router.post('/tables', async (req: Request, res: Response) => {
  try {
    const { name, description, connectionId, folderId, schema: schemaDef } = req.body;
    if (!name) { res.status(400).json({ success: false, error: 'name required' }); return; }
    // Get next sort order
    const maxSort = await prisma.repoTable.aggregate({ _max: { sortOrder: true } });
    const table = await prisma.repoTable.create({
      data: {
        id: `rpt${crypto.randomBytes(10).toString('hex')}`,
        name, description: description || null,
        connectionId: connectionId || null,
        folderId: folderId || null,
        sortOrder: (maxSort._max.sortOrder ?? 0) + 1,
        schema: JSON.stringify(schemaDef || []),
      },
    });
    res.json({ success: true, data: { table } });
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});

router.put('/tables/:id', async (req: Request, res: Response) => {
  try {
    const { name, description, connectionId, folderId, sortOrder, filterColumns } = req.body;
    const table = await prisma.repoTable.update({
      where: { id: req.params.id },
      data: {
        ...(name && { name }),
        ...(description !== undefined && { description }),
        ...(connectionId !== undefined && { connectionId: connectionId || null }),
        ...(folderId !== undefined && { folderId: folderId || null }),
        ...(sortOrder !== undefined && { sortOrder }),
        ...(filterColumns !== undefined && { filterColumns: filterColumns ? String(filterColumns).trim() : null }),
      },
    });
    res.json({ success: true, data: { table } });
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});

router.delete('/tables/:id', async (req: Request, res: Response) => {
  try {
    // Only remove from repository — never drop the actual database table
    await prisma.repoTable.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});

// POST /tables/:id/import — parse file and store into the table's connection DB
//
// Modes (query/body param `mode`):
//   - "append"  (default if the table already exists with a schema): preserve existing
//                table structure; just INSERT new rows. Column types are NOT changed.
//   - "replace": DROP + CREATE the table with column types inferred from the file's data.
//                Use this only when (re)defining the schema.
//
// Optional `mapping` (body, JSON-stringified):
//   { dbCol: { source: 'file'|'default'|'skip', fileCol?, defaultValue? } }
//   - source='file'   : take value from file's `fileCol`
//   - source='default': use literal `defaultValue` for every row
//   - source='skip'   : leave NULL
//   The mapping is persisted on `repo_tables.last_import_config` so the UI can
//   pre-fill the same mapping next time.
router.post('/tables/:id/import', upload.single('file'), ...base64Upload(uploadDir, IMPORT_EXTENSIONS), async (req: Request, res: Response) => {
  const tmpPath: string | undefined = (req as any).file?.path;
  // Pre-create an Execution row so the import shows up in the system log and
  // its id can be used as the {{execution_id}} template var in default values.
  let executionId: string | null = null;
  const startedAt = new Date();
  try {
    const table = await prisma.repoTable.findUnique({ where: { id: req.params.id } });
    if (!table) { res.status(404).json({ success: false, error: 'Table not found' }); return; }
    if (!table.connectionId) { res.status(400).json({ success: false, error: 'No connection configured for this table' }); return; }
    if (!tmpPath) { res.status(400).json({ success: false, error: 'No file uploaded' }); return; }

    const origName: string = (req as any).file.originalname;
    const ext = path.extname(origName).toLowerCase().slice(1);
    const encoding: string = (req.body.encoding as string) || 'utf8';
    const tableName = physicalTableName(table.name);

    // Caller info — X-User-Name header is percent-encoded by the client; decode
    // so Thai user names land readable in the execution log.
    let callerName = 'Manual Import';
    const rawCaller = (req.headers['x-user-name'] as string) || '';
    if (rawCaller) {
      try { callerName = decodeURIComponent(rawCaller); } catch { callerName = rawCaller; }
    }

    // Create Execution row up-front so we have an id to thread into the
    // mapping templates and so the user sees the import appear immediately.
    const execution = await prisma.execution.create({
      data: {
        sourceType: 'repo-import',
        sourceId: table.id,
        status: 'Running',
        startedAt,
        triggerType: 'import',
        callerName,
        input: JSON.stringify({
          fileName: origName,
          fileSize: (req as any).file?.size,
          tableName: table.name,
          tableId: table.id,
        }),
      },
    });
    executionId = execution.id;

    // Parse mapping if provided
    type Mapping = Record<string, { source: 'file' | 'default' | 'skip'; fileCol?: string; defaultValue?: any }>;
    let mapping: Mapping | null = null;
    if (req.body.mapping) {
      try {
        mapping = typeof req.body.mapping === 'string' ? JSON.parse(req.body.mapping) : req.body.mapping;
      } catch (e) {
        res.status(400).json({ success: false, error: 'Invalid `mapping` JSON' });
        return;
      }
    }

    // User-requested new destination columns (from the "+ Create new column"
    // form in the Mapping modal). Run ALTER TABLE ADD before any insert.
    let addColumnsList: { name: string; type: string }[] = [];
    if (req.body.addColumns) {
      try {
        const parsed = typeof req.body.addColumns === 'string' ? JSON.parse(req.body.addColumns) : req.body.addColumns;
        if (Array.isArray(parsed)) addColumnsList = parsed.filter((c: any) => c && c.name && c.type);
      } catch {
        res.status(400).json({ success: false, error: 'Invalid `addColumns` JSON' });
        return;
      }
    }
    let addedColumnNames: string[] = [];
    if (addColumnsList.length > 0) {
      try {
        addedColumnNames = await addColumnsToTable(table.connectionId, tableName, addColumnsList);
      } catch (alterErr: any) {
        res.status(400).json({ success: false, error: alterErr?.message || 'Failed to add new columns' });
        return;
      }
      // After ALTER, refresh the stored schema cache so future operations
      // see the new columns. Best-effort; import works regardless.
      try {
        const prevSchema: ColSchema[] = (() => {
          try { return JSON.parse(table.schema || '[]'); } catch { return []; }
        })();
        const merged: ColSchema[] = [
          ...prevSchema,
          ...addColumnsList
            .filter(c => addedColumnNames.includes(c.name) && !prevSchema.some(p => p.name === c.name))
            .map(c => ({ name: c.name, type: c.type } as ColSchema)),
        ];
        await prisma.repoTable.update({ where: { id: table.id }, data: { schema: JSON.stringify(merged) } });
      } catch {/* ignore */}
    }

    // Template substitution for default values. Supports:
    //   {{execution_id}}      — this import's execution id (same across all rows)
    //   {{now}} / {{now:iso}} — ISO timestamp (start of import; same across rows)
    //   {{now:date}}          — YYYY-MM-DD
    //   {{sysdate}}           — alias for {{now}} (Oracle SYSDATE semantics)
    //   {{user}}              — callerName
    //   {{table_id}}          — repo table id
    //   {{table_name}}        — repo table name
    //   {{cuid}}              — NEW cuid PER ROW (good for synthetic PKs)
    //   {{uuid}}              — NEW RFC-4122 v4 UUID PER ROW
    // Both bare strings and embedded uses (e.g. "IMP-{{execution_id}}") are
    // supported. Non-string defaults pass through unchanged.
    const tpl = (raw: any): any => {
      if (typeof raw !== 'string' || raw.indexOf('{{') === -1) return raw;
      return raw.replace(/\{\{\s*([a-zA-Z_][\w:]*)\s*\}\}/g, (_m, key: string) => {
        const k = String(key).toLowerCase();
        if (k === 'execution_id' || k === 'executionid') return executionId || '';
        if (k === 'user' || k === 'username') return callerName;
        if (k === 'now' || k === 'now:iso' || k === 'sysdate') return startedAt.toISOString();
        if (k === 'now:date') return startedAt.toISOString().slice(0, 10);
        if (k === 'table_id' || k === 'tableid') return table.id;
        if (k === 'table_name' || k === 'tablename') return table.name;
        if (k === 'cuid') return makeCuidLike();
        if (k === 'uuid') return crypto.randomUUID();
        return ''; // unknown var → empty
      });
    };

    // Apply the mapping to a parsed row set: returns rows + column list aligned to mapping
    const applyMapping = (parsedRows: Record<string, any>[]): { rows: Record<string, any>[]; columns: string[] } => {
      if (!mapping) return { rows: parsedRows, columns: parsedRows[0] ? Object.keys(parsedRows[0]) : [] };
      const dbCols = Object.keys(mapping).filter(c => mapping![c].source !== 'skip');
      const mapped = parsedRows.map(src => {
        const out: Record<string, any> = {};
        for (const dbCol of dbCols) {
          const m = mapping![dbCol];
          if (m.source === 'default') {
            out[dbCol] = tpl(m.defaultValue ?? null);
          } else if (m.source === 'file' && m.fileCol) {
            // Case-insensitive fallback so "Min" in file matches "MIN" db col
            let v = src[m.fileCol];
            if (v === undefined) {
              const key = Object.keys(src).find(k => k.toLowerCase() === m.fileCol!.toLowerCase());
              if (key !== undefined) v = src[key];
            }
            out[dbCol] = v === undefined || v === '' ? null : v;
          } else {
            out[dbCol] = null;
          }
        }
        return out;
      });
      return { rows: mapped, columns: dbCols };
    };

    // Determine mode: explicit param wins; otherwise default to "append" if table
    // already has a schema (rowCount > 0 OR schema array non-empty).
    let existingSchema: ColSchema[] = [];
    try { existingSchema = JSON.parse(table.schema || '[]'); } catch {}
    const hasExisting = (table.rowCount ?? 0) > 0 || existingSchema.length > 0;
    const requested = String(req.body.mode || req.query.mode || '').toLowerCase();
    // Modes:
    //   append  — INSERT only, never touch existing rows (no key needed)
    //   merge   — DELETE rows where (key cols) match each incoming tuple, then INSERT
    //   replace — DELETE rows where (key cols) match any incoming row, then INSERT
    //             (semantically the same as merge — both require key columns to be safe)
    //   recreate — DROP table and CREATE from file (legacy, only used when table is empty)
    const mode: 'append' | 'replace' | 'merge' | 'recreate' =
      requested === 'replace' ? 'replace'
      : requested === 'merge' ? 'merge'
      : requested === 'recreate' ? 'recreate'
      : requested === 'append' ? 'append'
      : (hasExisting ? 'append' : 'recreate');

    // Merge AND Replace require key columns to prevent accidentally wiping the table.
    let mergeKeys: string[] = [];
    if (mode === 'merge' || mode === 'replace') {
      try {
        const raw = req.body.mergeKeys ?? req.body.replaceKeys;
        mergeKeys = typeof raw === 'string' ? JSON.parse(raw) : (Array.isArray(raw) ? raw : []);
      } catch (e) {
        res.status(400).json({ success: false, error: 'Invalid `mergeKeys` / `replaceKeys` JSON' });
        return;
      }
      mergeKeys = (mergeKeys || []).filter(Boolean);
      if (mergeKeys.length === 0) {
        res.status(400).json({ success: false, error: `${mode} mode requires at least one key column to prevent data loss` });
        return;
      }
    }

    let totalRows = 0;
    let finalColumns: ColSchema[] = existingSchema;
    let totalMergeDeleted = 0;

    // Helper — apply mode-specific pre-insert step (drop+create / delete-by-key / no-op)
    const isDeleteByKey = (mode === 'merge' || mode === 'replace');

    if (ext === 'zip') {
      const AdmZip = (await import('adm-zip')).default;
      const zip = new AdmZip(tmpPath);
      const entries = zip.getEntries().filter(e => !e.isDirectory && /\.(csv|tsv|xlsx|xls|json)$/i.test(e.entryName));
      if (entries.length === 0) throw new Error('No supported files found in ZIP');
      let schemaSet = (mode === 'append' || isDeleteByKey); // skip schema-set unless 'recreate'
      for (const entry of entries) {
        const entryExt = path.extname(entry.entryName).toLowerCase().slice(1);
        const tmpEntry = path.join(uploadDir, `tmp_${Date.now()}_${entry.name}`);
        zip.extractEntryTo(entry, path.dirname(tmpEntry), false, true, undefined, path.basename(tmpEntry));
        try {
          const parsed = await parseFile(tmpEntry, entryExt, encoding);
          const { rows: insertRows, columns: dbColNames } = applyMapping(parsed.rows);
          const replaceCols = mapping
            ? dbColNames.map(n => ({ name: n, type: 'TEXT', nullable: true }))
            : parsed.columns;
          if (mode === 'recreate' && !schemaSet && replaceCols.length > 0) {
            await createOrReplaceTable(table.connectionId!, tableName, replaceCols);
            finalColumns = replaceCols;
            schemaSet = true;
          }
          if (mapping) {
            finalColumns = replaceCols;
          } else if (finalColumns.length === 0 && replaceCols.length > 0) {
            finalColumns = replaceCols;
          }
          if (isDeleteByKey && mergeKeys.length > 0 && insertRows.length > 0) {
            totalMergeDeleted += await deleteByKeys(table.connectionId!, tableName, mergeKeys, insertRows);
          }
          totalRows += await bulkInsert(table.connectionId!, tableName, finalColumns, insertRows);
        } finally { fs.unlink(tmpEntry, () => {}); }
      }
    } else {
      const parsed = await parseFile(tmpPath, ext, encoding);
      if (parsed.columns.length === 0) throw new Error('No columns found in file');
      const { rows: insertRows, columns: dbColNames } = applyMapping(parsed.rows);
      const replaceCols = mapping
        ? dbColNames.map(n => ({ name: n, type: 'TEXT', nullable: true }))
        : parsed.columns;
      if (mode === 'recreate') {
        await createOrReplaceTable(table.connectionId, tableName, replaceCols);
        finalColumns = replaceCols;
      } else if (mapping) {
        // mapping is the source of truth — overrides cached schema (which can be stale)
        finalColumns = replaceCols;
      } else if (finalColumns.length === 0) {
        finalColumns = replaceCols;
      }
      // Merge/Replace: delete existing rows matching key tuples, then insert
      if (isDeleteByKey && mergeKeys.length > 0 && insertRows.length > 0) {
        totalMergeDeleted += await deleteByKeys(table.connectionId, tableName, mergeKeys, insertRows);
      }
      totalRows = await bulkInsert(table.connectionId, tableName, finalColumns, insertRows);
    }

    await prisma.repoTable.update({
      where: { id: table.id },
      data: {
        rowCount: mode === 'recreate'
          ? totalRows
          // For merge/replace/append: existing + inserted - deleted-by-key
          : (table.rowCount ?? 0) + totalRows - totalMergeDeleted,
        lastSyncAt: new Date(),
        syncStatus: 'idle',
        syncError: null,
        schema: JSON.stringify(finalColumns),
      },
    });

    // Persist mapping for next-time pre-fill — now using the typed column.
    if (mapping) {
      try {
        await prisma.repoTable.update({
          where: { id: table.id },
          data: {
            lastImportConfig: JSON.stringify({
              mapping, mode, mergeKeys,
              savedAt: new Date().toISOString(),
            }),
          },
        });
      } catch (e: any) {
        console.warn('[import] persist mapping failed:', e.message);
      }
    }
    let msg: string;
    if (mode === 'recreate') msg = `${totalRows} row(s) — table recreated from file`;
    else if (mode === 'replace') msg = `${totalRows} row(s) inserted (replaced ${totalMergeDeleted} existing via key: ${mergeKeys.join(', ')})`;
    else if (mode === 'merge') msg = `${totalRows} row(s) merged (${totalMergeDeleted} existing replaced via key: ${mergeKeys.join(', ')})`;
    else msg = `${totalRows} row(s) appended`;
    if (addedColumnNames.length > 0) {
      msg += ` · added ${addedColumnNames.length} new column(s): ${addedColumnNames.join(', ')}`;
    }

    // Mark the execution row as completed with the import outcome
    if (executionId) {
      const endedAt = new Date();
      const output = {
        mode, rowCount: totalRows, mergeDeleted: totalMergeDeleted,
        mergeKeys, columns: finalColumns.map(c => c.name),
        addedColumns: addedColumnNames,
      };
      await prisma.execution.update({
        where: { id: executionId },
        data: {
          status: 'Completed',
          endedAt,
          durationMs: endedAt.getTime() - startedAt.getTime(),
          output: JSON.stringify(output),
          result: JSON.stringify({ message: msg, ...output }),
        },
      }).catch((e) => console.warn('[import] update execution failed:', e?.message));
    }

    res.json({
      success: true,
      data: { mode, rowCount: totalRows, mergeDeleted: totalMergeDeleted, mergeKeys, columns: finalColumns, addedColumns: addedColumnNames, message: msg, executionId },
    });
  } catch (err: any) {
    // Mark the execution row as failed
    if (executionId) {
      const endedAt = new Date();
      await prisma.execution.update({
        where: { id: executionId },
        data: {
          status: 'Failed',
          endedAt,
          durationMs: endedAt.getTime() - startedAt.getTime(),
          error: err?.message || 'Import failed',
          errorType: 'import_error',
        },
      }).catch(() => {});
    }
    res.status(500).json({ success: false, error: err.message, executionId });
  } finally {
    if (tmpPath) fs.unlink(tmpPath, () => {});
  }
});

// GET /tables/:id/last-import-config — fetch the last-used mapping so the import modal can pre-fill
router.get('/tables/:id/last-import-config', async (req: Request, res: Response) => {
  try {
    const table = await prisma.repoTable.findUnique({
      where: { id: req.params.id },
      select: { lastImportConfig: true },
    });
    if (!table) {
      res.status(404).json({ success: false, error: 'Table not found' });
      return;
    }
    if (!table.lastImportConfig) {
      res.json({ success: true, data: null });
      return;
    }
    let parsed: any = null;
    try { parsed = JSON.parse(table.lastImportConfig); } catch { parsed = null; }
    res.json({ success: true, data: parsed });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /tables/:id/sync — fetch from connection via SQL, store into same connection
router.post('/tables/:id/sync', async (req: Request, res: Response) => {
  try {
    const { sql } = req.body;
    const table = await prisma.repoTable.findUnique({ where: { id: req.params.id } });
    if (!table) { res.status(404).json({ success: false, error: 'Table not found' }); return; }
    if (!table.connectionId) { res.status(400).json({ success: false, error: 'No connection configured' }); return; }
    if (!sql) { res.status(400).json({ success: false, error: 'sql is required' }); return; }

    const tableName = physicalTableName(table.name);
    await prisma.repoTable.update({ where: { id: table.id }, data: { syncStatus: 'syncing', syncError: null } });
    try {
      const { columns, rows } = await fetchFromSource(table.connectionId, sql);
      await createOrReplaceTable(table.connectionId, tableName, columns);
      const rowCount = await bulkInsert(table.connectionId, tableName, columns, rows);
      await prisma.repoTable.update({
        where: { id: table.id },
        data: { rowCount, lastSyncAt: new Date(), syncStatus: 'idle', syncError: null, schema: JSON.stringify(columns) },
      });
      res.json({ success: true, data: { rowCount, columns } });
    } catch (err: any) {
      await prisma.repoTable.update({ where: { id: table.id }, data: { syncStatus: 'error', syncError: err.message } });
      throw err;
    }
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});

// POST /tables/:id/query — query with paging + optional folder filter
router.post('/tables/:id/query', async (req: Request, res: Response) => {
  try {
    const { folderId, limit = 200, offset = 0, filters } = req.body;
    const table = await prisma.repoTable.findUnique({ where: { id: req.params.id } });
    if (!table) { res.status(404).json({ success: false, error: 'Table not found' }); return; }
    if (!table.connectionId) { res.status(400).json({ success: false, error: 'No connection configured' }); return; }
    const lim = Math.min(Number(limit), 5000);
    const off = Number(offset);
    const conds = normalizeFilters(filters, await allowedFilterColumnsFor(table, filterColumnNames(filters)));
    const tableName = physicalTableName(table.name);
    try {
      const result = await queryRepoTable(table.connectionId, tableName, folderId, lim, off, conds);
      // Update stored rowCount if it differs — only when nothing is filtered out,
      // otherwise the registry's default filter would rewrite rowCount to a subset.
      if (off === 0 && conds.length === 0 && result.totalCount !== (table.rowCount || 0)) {
        await prisma.repoTable.update({ where: { id: req.params.id }, data: { rowCount: result.totalCount } }).catch(() => {});
      }
      res.json({ success: true, data: result });
    } catch (queryErr: any) {
      // Handle ORA-00942 and similar "table not found" errors gracefully
      const msg = queryErr.message || '';
      if (msg.includes('ORA-00942') || msg.includes('does not exist') || msg.includes('doesn\'t exist')) {
        res.json({ success: true, data: { rows: [], columns: [], totalCount: 0, error: `Table "${tableName}" does not exist in the database. It may have been removed or renamed.` } });
      } else {
        throw queryErr;
      }
    }
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});

// ─── SQL Editor: saved statements ────────────────────────────────────────────
//
// Kept per install, not per user: the point is that the next person opening the
// editor finds the query someone already worked out.

router.get('/sql/saved', async (_req: Request, res: Response) => {
  try {
    const queries = await prisma.repoSqlQuery.findMany({ orderBy: [{ updatedAt: 'desc' }] });
    res.json({ success: true, data: { queries } });
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});

router.post('/sql/saved', async (req: Request, res: Response) => {
  try {
    const { name, sql, connectionId } = req.body;
    if (!name || !String(name).trim()) { res.status(400).json({ success: false, error: 'name required' }); return; }
    if (!sql || !String(sql).trim()) { res.status(400).json({ success: false, error: 'sql required' }); return; }
    const user = (req as any).user;
    const query = await prisma.repoSqlQuery.create({
      data: {
        id: `rsq${crypto.randomBytes(10).toString('hex')}`,
        name: String(name).trim().slice(0, 120),
        sql: String(sql),
        connectionId: connectionId || null,
        createdBy: user?.email || user?.name || null,
      },
    });
    res.json({ success: true, data: { query } });
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});

router.put('/sql/saved/:id', async (req: Request, res: Response) => {
  try {
    const { name, sql, connectionId } = req.body;
    const query = await prisma.repoSqlQuery.update({
      where: { id: req.params.id },
      data: {
        ...(name !== undefined && { name: String(name).trim().slice(0, 120) }),
        ...(sql !== undefined && { sql: String(sql) }),
        ...(connectionId !== undefined && { connectionId: connectionId || null }),
      },
    });
    res.json({ success: true, data: { query } });
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});

router.delete('/sql/saved/:id', async (req: Request, res: Response) => {
  try {
    await prisma.repoSqlQuery.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});

// ─── SQL Editor: execute arbitrary SQL ───────────────────────────────────────

router.post('/sql/execute', async (req: Request, res: Response) => {
  try {
    const { connectionId, sql } = req.body;
    if (!connectionId || !sql) { res.status(400).json({ success: false, error: 'connectionId and sql required' }); return; }
    const result = await fetchFromSource(connectionId, sql);
    res.json({
      success: true,
      data: {
        columns: result.columns.map(c => ({ name: c.name, type: c.type })),
        rows: result.rows.slice(0, 5000),
        rowsAffected: result.rowsAffected,
      },
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── DML (INSERT/UPDATE/DELETE) ──────────────────────────────────────────────

router.post('/sql/dml', async (req: Request, res: Response) => {
  try {
    const { connectionId, sql } = req.body;
    if (!connectionId || !sql) { res.status(400).json({ success: false, error: 'connectionId and sql required' }); return; }
    const { engine, cfg } = await getConnInfo(connectionId);
    let rowCount = 0;
    if (engine === 'oracle') {
      await withOracleConn(cfg, async (c) => {
        const result = await c.execute(sql.trim().replace(/;+$/, ''));
        rowCount = result.rowsAffected || 0;
        await c.commit();
      });
    } else if (engine === 'postgresql') {
      await withPgClient(cfg, async (client) => {
        const result = await client.query(sql.trim().replace(/;+$/, ''));
        rowCount = result.rowCount || 0;
      });
    } else if (engine === 'mysql') {
      await withMysqlConn(cfg, async (c) => {
        const [result]: any = await c.execute(sql.trim().replace(/;+$/, ''));
        rowCount = result.affectedRows || 0;
      });
    }
    res.json({ success: true, data: { rowCount } });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/sql/bulk-insert', async (req: Request, res: Response) => {
  try {
    const { connectionId, tableName, columns, rows } = req.body;
    if (!connectionId || !tableName || !columns || !rows) {
      res.status(400).json({ success: false, error: 'connectionId, tableName, columns, and rows required' });
      return;
    }
    const colSchemas: ColSchema[] = columns.map((c: any) => ({ name: c.name || c, type: c.type || 'TEXT', nullable: true }));
    const rowCount = await bulkInsert(connectionId, tableName, colSchemas, rows);
    res.json({ success: true, data: { rowCount } });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Folders ──────────────────────────────────────────────────────────────────

router.get('/folders', async (req: Request, res: Response) => {
  try {
    const folders = await prisma.repoFolder.findMany({
      include: { children: { include: { children: true } }, tables: { select: { id: true } } },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    // Non-admins only see folders that lead to a table granted to them
    const visible = await visibleTableIds(req);
    if (visible) {
      const allowed = new Set(visible);
      const parent = new Map(folders.map((f) => [f.id, f.parentId]));
      const keep = new Set<string>();
      for (const f of folders) {
        if (!f.tables.some((t) => allowed.has(t.id))) continue;
        for (let id: string | null | undefined = f.id; id && !keep.has(id); id = parent.get(id)) keep.add(id);
      }
      const trimmed = folders
        .filter((f) => keep.has(f.id))
        .map((f) => ({
          ...f,
          tables: f.tables.filter((t) => allowed.has(t.id)),
          children: f.children.filter((c) => keep.has(c.id)).map((c) => ({ ...c, children: c.children.filter((g) => keep.has(g.id)) })),
        }));
      res.json({ success: true, data: { folders: trimmed } });
      return;
    }
    res.json({ success: true, data: { folders } });
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});

router.post('/folders', async (req: Request, res: Response) => {
  try {
    const { name, parentId } = req.body;
    if (!name) { res.status(400).json({ success: false, error: 'name required' }); return; }
    const maxSort = await prisma.repoFolder.aggregate({ _max: { sortOrder: true } });
    const folder = await prisma.repoFolder.create({
      data: {
        id: `rpf${crypto.randomBytes(10).toString('hex')}`,
        parentId: parentId || null,
        name,
        sortOrder: (maxSort._max.sortOrder ?? 0) + 1,
      },
    });
    res.json({ success: true, data: { folder } });
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});

router.put('/folders/:id', async (req: Request, res: Response) => {
  try {
    const { name, parentId, sortOrder } = req.body;
    const folder = await prisma.repoFolder.update({
      where: { id: req.params.id },
      data: {
        ...(name && { name }),
        ...(parentId !== undefined && { parentId: parentId || null }),
        ...(sortOrder !== undefined && { sortOrder }),
      },
    });
    res.json({ success: true, data: { folder } });
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});

router.delete('/folders/:id', async (req: Request, res: Response) => {
  try {
    // Move tables out of this folder before deleting
    await prisma.repoTable.updateMany({ where: { folderId: req.params.id }, data: { folderId: null } });
    // Move child folders out
    await prisma.repoFolder.updateMany({ where: { parentId: req.params.id }, data: { parentId: null } });
    await prisma.repoFolder.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});

// ── Reorder (batch update sortOrder / folderId) ─────────────────────────────

router.post('/reorder', async (req: Request, res: Response) => {
  try {
    const { items } = req.body; // [{ id, type: 'table'|'folder', sortOrder, folderId? }]
    if (!Array.isArray(items)) { res.status(400).json({ success: false, error: 'items required' }); return; }
    for (const item of items) {
      if (item.type === 'table') {
        await prisma.repoTable.update({
          where: { id: item.id },
          data: { sortOrder: item.sortOrder, ...(item.folderId !== undefined && { folderId: item.folderId || null }) },
        });
      } else if (item.type === 'folder') {
        await prisma.repoFolder.update({
          where: { id: item.id },
          data: { sortOrder: item.sortOrder, ...(item.parentId !== undefined && { parentId: item.parentId || null }) },
        });
      }
    }
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});

// ── Table structure (columns from actual DB) ─────────────────────────────────

// Column list straight from the database catalog — not the cached `schema`,
// which goes stale when someone ALTERs the table.
type LiveColumn = { name: string; type: string; nullable: boolean; length?: number; precision?: number; scale?: number };
async function readLiveColumns(connectionId: string, tableName: string): Promise<{ engine: DbEngine; columns: LiveColumn[] }> {
  const { engine, cfg } = await getConnInfo(connectionId);
  let columns: LiveColumn[] = [];

  if (engine === 'postgresql') {
    columns = await withPgClient(cfg, async (client) => {
      const r = await client.query(
        `SELECT column_name AS name, data_type AS type, is_nullable = 'YES' AS nullable,
                character_maximum_length AS length, numeric_precision AS precision, numeric_scale AS scale
         FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position`, [tableName.toLowerCase()]);
      return r.rows;
    });
  } else if (engine === 'mysql') {
    columns = await withMysqlConn(cfg, async (c) => {
      const [rows]: any = await c.execute(
        `SELECT COLUMN_NAME AS name, DATA_TYPE AS type, IS_NULLABLE = 'YES' AS nullable,
                CHARACTER_MAXIMUM_LENGTH AS \`length\`, NUMERIC_PRECISION AS \`precision\`, NUMERIC_SCALE AS scale
         FROM information_schema.COLUMNS WHERE TABLE_NAME = ? AND TABLE_SCHEMA = DATABASE() ORDER BY ORDINAL_POSITION`, [tableName]);
      return rows;
    });
  } else if (engine === 'oracle') {
    // If tableName has dot (e.g. "APP.IMPORT_DATA"), use ALL_TAB_COLUMNS
    // with OWNER filter. Otherwise USER_TAB_COLUMNS (current schema).
    const dotIdx = tableName.indexOf('.');
    columns = await withOracleConn(cfg, async (c) => {
      let r;
      if (dotIdx > 0) {
        const owner = tableName.slice(0, dotIdx).toUpperCase();
        const tbl = tableName.slice(dotIdx + 1).toUpperCase();
        r = await c.execute(
          `SELECT COLUMN_NAME AS "name", DATA_TYPE AS "type", NULLABLE AS "nullable",
                  DATA_LENGTH AS "length", DATA_PRECISION AS "precision", DATA_SCALE AS "scale"
           FROM ALL_TAB_COLUMNS WHERE OWNER = :1 AND TABLE_NAME = :2 ORDER BY COLUMN_ID`,
          [owner, tbl]
        );
      } else {
        r = await c.execute(
          `SELECT COLUMN_NAME AS "name", DATA_TYPE AS "type", NULLABLE AS "nullable",
                  DATA_LENGTH AS "length", DATA_PRECISION AS "precision", DATA_SCALE AS "scale"
           FROM USER_TAB_COLUMNS WHERE TABLE_NAME = :1 ORDER BY COLUMN_ID`,
          [tableName.toUpperCase()]
        );
      }
      return (r.rows as any[]).map((row: any) => ({
        ...row, nullable: row.nullable === 'Y',
      }));
    });
  }
  return { engine, columns };
}

router.get('/tables/:id/structure', async (req: Request, res: Response) => {
  try {
    const table = await prisma.repoTable.findUnique({ where: { id: req.params.id } });
    if (!table) { res.status(404).json({ success: false, error: 'Table not found' }); return; }
    if (!table.connectionId) { res.status(400).json({ success: false, error: 'No connection configured' }); return; }
    const tableName = table.name;
    const { engine, columns } = await readLiveColumns(table.connectionId, tableName);
    res.json({ success: true, data: { columns, tableName, engine } });
  } catch (err: any) {
    const msg = err.message || '';
    if (msg.includes('ORA-00942') || msg.includes('does not exist')) {
      res.json({ success: true, data: { columns: [], tableName: '', engine: '', error: 'Table does not exist in the database' } });
    } else {
      res.status(500).json({ success: false, error: err.message });
    }
  }
});

// ── Streaming export (CSV/XLSX) — handles millions of rows without loading
//    everything into memory. Uses Oracle/Pg/MySQL cursor + chunked HTTP response.
router.get('/tables/:id/export', async (req: Request, res: Response) => {
  let oracleConn: any = null;
  try {
    const fmt = ((req.query.format as string) || 'csv').toLowerCase();
    if (fmt !== 'csv' && fmt !== 'xlsx') {
      res.status(400).json({ success: false, error: 'format must be csv or xlsx' });
      return;
    }
    const table = await prisma.repoTable.findUnique({ where: { id: req.params.id } });
    if (!table) { res.status(404).json({ success: false, error: 'Table not found' }); return; }
    if (!table.connectionId) { res.status(400).json({ success: false, error: 'No connection configured' }); return; }
    const { engine, cfg } = await getConnInfo(table.connectionId);
    const tableName = physicalTableName(table.name);
    const tbl = quoteIdent(tableName, engine);
    const safeFile = table.name.replace(/[^a-zA-Z0-9._-]/g, '_');

    // An export has to match what the screen shows — same filters, same rows.
    let exportFilters: FilterCond[] = [];
    try {
      const raw = req.query.filters ? JSON.parse(String(req.query.filters)) : [];
      exportFilters = normalizeFilters(raw, await allowedFilterColumnsFor(table, filterColumnNames(raw)));
    } catch { /* malformed filters param — fall back to the whole table */ }
    const filt = buildFilterClause(exportFilters, engine, 1);
    const where = filt.sql ? `WHERE ${filt.sql}` : '';

    res.setHeader('Content-Disposition', `attachment; filename="${safeFile}.${fmt}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (fmt === 'csv') res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    else res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

    const safeStringify = (v: any): string => {
      // Handle Oracle types that have circular refs (NVPair, etc.) and large blobs
      if (v === null || v === undefined) return '';
      if (v instanceof Date) return v.toISOString();
      if (typeof v !== 'object') return String(v);
      if (Buffer.isBuffer(v)) return v.toString('utf8');
      // Oracle Lob — read synchronously not possible; just mark
      if (v.constructor && /Lob/i.test(v.constructor.name || '')) return '[LOB]';
      try { return JSON.stringify(v); }
      catch { return String(v); }
    };
    const escapeCsv = (v: any): string => {
      const s = safeStringify(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    if (fmt === 'csv') {
      // BOM for Excel UTF-8
      res.write('﻿');
    }

    // Helper streams: depending on format, accumulate rows
    let xlsxWb: any = null;
    let xlsxWs: any = null;
    if (fmt === 'xlsx') {
      const ExcelJS = (await import('exceljs')).default as any;
      xlsxWb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res });
      xlsxWs = xlsxWb.addWorksheet(table.name.substring(0, 31).replace(/[\\/?*\[\]:]/g, '_'));
    }

    let columnNames: string[] = [];
    let rowsWritten = 0;
    const HEAD_BATCH = 5000;

    if (engine === 'oracle') {
      const oracledb = require('oracledb');
      oracleConn = await oracledb.getConnection({
        user: cfg.username || cfg.user,
        password: cfg.password,
        connectString: `${cfg.host}:${cfg.port || 1521}/${cfg.options?.serviceName || cfg.serviceName || cfg.database}`,
      });
      const result = await oracleConn.execute(`SELECT * FROM ${tbl} ${where}`, filt.params, {
        outFormat: oracledb.OUT_FORMAT_ARRAY,
        resultSet: true,
        fetchArraySize: HEAD_BATCH,
        // Coerce CLOB/BLOB to string so they serialize cleanly (avoid circular Lob refs)
        fetchTypeHandler: (m: any) => {
          if (m.dbType === oracledb.DB_TYPE_CLOB || m.dbType === oracledb.DB_TYPE_NCLOB) {
            return { type: oracledb.STRING };
          }
          if (m.dbType === oracledb.DB_TYPE_BLOB) {
            return { type: oracledb.BUFFER };
          }
          return undefined;
        },
      });
      const rs = result.resultSet;
      columnNames = result.metaData.map((m: any) => m.name);
      // Header
      if (fmt === 'csv') res.write(columnNames.map(escapeCsv).join(',') + '\n');
      else { xlsxWs.columns = columnNames.map(n => ({ header: n, key: n })); xlsxWs.getRow(1).commit(); }

      while (true) {
        const rows: any[][] = await rs.getRows(HEAD_BATCH);
        if (rows.length === 0) break;
        if (fmt === 'csv') {
          let buf = '';
          for (const row of rows) buf += row.map(escapeCsv).join(',') + '\n';
          res.write(buf);
        } else {
          for (const row of rows) {
            const obj: any = {};
            row.forEach((v, i) => {
              // ExcelJS may also stringify; pass primitives where possible
              if (v == null) obj[columnNames[i]] = '';
              else if (v instanceof Date) obj[columnNames[i]] = v;
              else if (typeof v === 'object') obj[columnNames[i]] = safeStringify(v);
              else obj[columnNames[i]] = v;
            });
            xlsxWs.addRow(obj).commit();
          }
        }
        rowsWritten += rows.length;
      }
      await rs.close();
    } else if (engine === 'postgresql') {
      // pg streaming via LIMIT/OFFSET pagination (no pg-cursor dep needed)
      const { Client } = require('pg');
      const client = new Client({
        host: cfg.host, port: cfg.port || 5432, database: cfg.database,
        user: cfg.username || cfg.user, password: cfg.password,
      });
      await client.connect();
      try {
        let offset = 0;
        let first = true;
        while (true) {
          const r = await client.query(
            `SELECT * FROM ${tbl} ${where} LIMIT $${filt.nextIndex} OFFSET $${filt.nextIndex + 1}`,
            [...filt.params, HEAD_BATCH, offset]
          );
          if (r.rows.length === 0) break;
          if (first) {
            columnNames = r.fields.map((f: any) => f.name);
            if (fmt === 'csv') res.write(columnNames.map(escapeCsv).join(',') + '\n');
            else { xlsxWs.columns = columnNames.map(n => ({ header: n, key: n })); xlsxWs.getRow(1).commit(); }
            first = false;
          }
          if (fmt === 'csv') {
            let buf = '';
            for (const row of r.rows) buf += columnNames.map(c => escapeCsv(row[c])).join(',') + '\n';
            res.write(buf);
          } else {
            for (const row of r.rows) xlsxWs.addRow(row).commit();
          }
          rowsWritten += r.rows.length;
          if (r.rows.length < HEAD_BATCH) break;
          offset += HEAD_BATCH;
        }
      } finally { await client.end(); }
    } else if (engine === 'mysql') {
      const mysql = require('mysql2/promise');
      const conn = await mysql.createConnection({ host: cfg.host, port: cfg.port || 3306, database: cfg.database, user: cfg.username || cfg.user, password: cfg.password });
      try {
        const conn2 = (conn as any).connection;
        await new Promise<void>((resolve, reject) => {
          const q = conn2.query(`SELECT * FROM ${tbl} ${where}`, filt.params);
          q.on('error', reject);
          q.on('fields', (fields: any[]) => {
            columnNames = fields.map((f: any) => f.name);
            if (fmt === 'csv') res.write(columnNames.map(escapeCsv).join(',') + '\n');
            else { xlsxWs.columns = columnNames.map(n => ({ header: n, key: n })); xlsxWs.getRow(1).commit(); }
          });
          q.on('result', (row: any) => {
            if (fmt === 'csv') res.write(columnNames.map(c => escapeCsv(row[c])).join(',') + '\n');
            else xlsxWs.addRow(row).commit();
            rowsWritten++;
          });
          q.on('end', () => resolve());
        });
      } finally { await conn.end(); }
    }

    if (fmt === 'xlsx' && xlsxWb) {
      await xlsxWb.commit();
    } else {
      res.end();
    }
    console.log(`[export] ${table.name}.${fmt} streamed ${rowsWritten} rows${exportFilters.length ? ` (${exportFilters.length} filter(s))` : ''}`);
  } catch (err: any) {
    console.error('[export] error:', err);
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: err.message });
    } else {
      res.end();
    }
  } finally {
    if (oracleConn) { try { await oracleConn.close(); } catch (_) {} }
  }
});

// ── Single-row DML helpers ────────────────────────────────────────────────────

async function updateRepoRow(
  connectionId: string,
  tableName: string,
  columns: ColSchema[],
  rid: string,
  newValues: Record<string, any>,
  originalRow: Record<string, any>
): Promise<void> {
  const { engine, cfg } = await getConnInfo(connectionId);
  const q = (n: string) => quoteIdent(n, engine);
  const tbl = q(tableName);
  // The grid sends every column back as text. Write only what the user
  // actually changed — rewriting an untouched DATE with its display string
  // ("2026-05-28T09:47:07.000Z") fails on Oracle.
  const asText = (v: any) => (v === null || v === undefined ? '' : String(v));
  const hasOriginal = originalRow && Object.keys(originalRow).length > 0;
  const updateCols = columns.filter(c =>
    c.name in newValues && (!hasOriginal || asText(newValues[c.name]) !== asText(originalRow[c.name])));
  if (updateCols.length === 0) return;

  if (engine === 'postgresql') {
    await withPgClient(cfg, async (client) => {
      const setClauses = updateCols.map((c, i) => `${q(c.name)} = $${i + 2}`).join(', ');
      const params = [rid, ...updateCols.map(c => castValue(newValues[c.name], c.type))];
      await client.query(`UPDATE ${tbl} SET ${setClauses} WHERE ctid = $1::tid`, params);
    });
  } else if (engine === 'oracle') {
    await withOracleConn(cfg, async (c) => {
      // Named binds: node-oracledb matches an array of binds to placeholders
      // in the order they appear in the SQL, not by their number, so with the
      // old ":2 … :1" layout the new value landed in CHARTOROWID() and every
      // edit failed with ORA-01410 (invalid ROWID).
      const setClauses = updateCols.map((col, i) => `${q(col.name)} = :v${i}`).join(', ');
      const binds: Record<string, any> = { rid };
      // A date the grid showed comes back as an ISO string; bind it as a Date.
      const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
      updateCols.forEach((col, i) => {
        const v = castValue(newValues[col.name], col.type);
        binds[`v${i}`] = typeof v === 'string' && ISO_TS.test(v) ? new Date(v) : v;
      });
      await c.execute(`UPDATE ${tbl} SET ${setClauses} WHERE ROWID = CHARTOROWID(:rid)`, binds);
      await c.commit();
    });
  } else if (engine === 'mysql') {
    await withMysqlConn(cfg, async (c) => {
      await c.beginTransaction();
      const setColExprs = updateCols.map(col => `${q(col.name)} = ?`).join(', ');
      const whereEntries = Object.entries(originalRow).filter(([k]) => k !== '_rid');
      const whereClauses = whereEntries.map(([k, v]) => v === null ? `${q(k)} IS NULL` : `${q(k)} = ?`).join(' AND ');
      const setParams = updateCols.map(col => castValue(newValues[col.name], col.type));
      const whereParams = whereEntries.filter(([, v]) => v !== null).map(([, v]) => v);
      await c.execute(`UPDATE ${tbl} SET ${setColExprs} WHERE ${whereClauses} LIMIT 1`, [...setParams, ...whereParams]);
      await c.commit();
    });
  }
}

async function deleteRepoRow(
  connectionId: string,
  tableName: string,
  rid: string,
  originalRow: Record<string, any>
): Promise<void> {
  const { engine, cfg } = await getConnInfo(connectionId);
  const q = (n: string) => quoteIdent(n, engine);
  const tbl = q(tableName);

  if (engine === 'postgresql') {
    await withPgClient(cfg, async (client) => {
      await client.query(`DELETE FROM ${tbl} WHERE ctid = $1::tid`, [rid]);
    });
  } else if (engine === 'oracle') {
    await withOracleConn(cfg, async (c) => {
      // Use CHARTOROWID() to explicitly convert the string bind to ROWID type
      // to avoid ORA-01410 (invalid ROWID) on implicit conversion.
      await c.execute(`DELETE FROM ${tbl} WHERE ROWID = CHARTOROWID(:1)`, [rid]);
      await c.commit();
    });
  } else if (engine === 'mysql') {
    await withMysqlConn(cfg, async (c) => {
      await c.beginTransaction();
      const whereEntries = Object.entries(originalRow).filter(([k]) => k !== '_rid');
      const whereClauses = whereEntries.map(([k, v]) => v === null ? `${q(k)} IS NULL` : `${q(k)} = ?`).join(' AND ');
      const whereParams = whereEntries.filter(([, v]) => v !== null).map(([, v]) => v);
      await c.execute(`DELETE FROM ${tbl} WHERE ${whereClauses} LIMIT 1`, whereParams);
      await c.commit();
    });
  }
}

// ─── Row CRUD endpoints ───────────────────────────────────────────────────────

// GET /tables/:id/schema — return parsed column schema
router.get('/tables/:id/schema', async (req: Request, res: Response) => {
  try {
    const table = await prisma.repoTable.findUnique({ where: { id: req.params.id } });
    if (!table) { res.status(404).json({ success: false, error: 'Table not found' }); return; }
    let columns: ColSchema[] = [];
    try { columns = JSON.parse(table.schema || '[]'); } catch {}
    res.json({ success: true, data: { columns } });
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});

// POST /tables/:id/rows — insert a single row
router.post('/tables/:id/rows', async (req: Request, res: Response) => {
  try {
    const table = await prisma.repoTable.findUnique({ where: { id: req.params.id } });
    if (!table) { res.status(404).json({ success: false, error: 'Table not found' }); return; }
    if (!table.connectionId) { res.status(400).json({ success: false, error: 'No connection configured' }); return; }
    const { values } = req.body;
    if (!values || typeof values !== 'object') { res.status(400).json({ success: false, error: 'values object required' }); return; }
    let columns: ColSchema[] = [];
    try { columns = JSON.parse(table.schema || '[]'); } catch {}
    if (columns.length === 0) { res.status(400).json({ success: false, error: 'Table has no schema — import data first' }); return; }
    const tableName = physicalTableName(table.name);
    await bulkInsert(table.connectionId, tableName, columns, [values]);
    const newCount = (table.rowCount || 0) + 1;
    await prisma.repoTable.update({ where: { id: table.id }, data: { rowCount: newCount } });
    res.json({ success: true, data: { rowCount: newCount } });
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});

// PATCH /tables/:id/rows — update a row by _rid
router.patch('/tables/:id/rows', async (req: Request, res: Response) => {
  try {
    const table = await prisma.repoTable.findUnique({ where: { id: req.params.id } });
    if (!table) { res.status(404).json({ success: false, error: 'Table not found' }); return; }
    if (!table.connectionId) { res.status(400).json({ success: false, error: 'No connection configured' }); return; }
    const { rid, newValues, originalRow } = req.body;
    if (!rid || !newValues) { res.status(400).json({ success: false, error: 'rid and newValues required' }); return; }
    // Columns added by ALTER TABLE after registration are missing from the
    // cached schema, and an edit to one of them would be dropped silently.
    await allowedFilterColumnsFor(table, Object.keys(newValues));
    let columns: ColSchema[] = [];
    try { columns = JSON.parse(table.schema || '[]'); } catch {}
    const tableName = physicalTableName(table.name);
    await updateRepoRow(table.connectionId, tableName, columns, rid, newValues, originalRow || {});
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});

// DELETE /tables/:id/rows — delete a row by _rid
router.delete('/tables/:id/rows', async (req: Request, res: Response) => {
  try {
    const table = await prisma.repoTable.findUnique({ where: { id: req.params.id } });
    if (!table) { res.status(404).json({ success: false, error: 'Table not found' }); return; }
    if (!table.connectionId) { res.status(400).json({ success: false, error: 'No connection configured' }); return; }
    const { rid, originalRow } = req.body;
    if (!rid) { res.status(400).json({ success: false, error: 'rid required' }); return; }
    const tableName = physicalTableName(table.name);
    await deleteRepoRow(table.connectionId, tableName, rid, originalRow || {});
    const newCount = Math.max(0, (table.rowCount || 1) - 1);
    await prisma.repoTable.update({ where: { id: table.id }, data: { rowCount: newCount } });
    res.json({ success: true, data: { rowCount: newCount } });
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});

// GET /tables/:id/distinct?column=X&limit=200 — return distinct values for one column
// Used by the Clear-by-key modal to show "existing values" as clickable chips.
// GET /tables/:id/distinct — option list for one filter column
//
//   ?column=DEPT            required
//   ?parentValue=21000     value picked in the parent filter, when the
//                          registry entry carries "@PARENT_COL=parentField"
//   ?limit=2000
//
// How the list is built follows the table's own registry (filter_columns) —
// never a table name sent by the caller:
//   optionsFrom  → read code+name straight from the small registry table
//   labelSource  → DISTINCT on this table, names from a sibling column or a
//                  lookup (slow on big tables; prefer optionsFrom)
//   neither      → plain DISTINCT, values only
router.get('/tables/:id/distinct', async (req: Request, res: Response) => {
  try {
    const table = await prisma.repoTable.findUnique({ where: { id: req.params.id } });
    if (!table) { res.status(404).json({ success: false, error: 'Table not found' }); return; }
    if (!table.connectionId) { res.status(400).json({ success: false, error: 'No connection configured' }); return; }
    const column = String(req.query.column || '').trim();
    if (!column) { res.status(400).json({ success: false, error: 'column query param required' }); return; }
    if (!FILTER_IDENT_RE.test(column)) { res.status(400).json({ success: false, error: 'invalid column name' }); return; }
    const limit = Math.min(parseInt(String(req.query.limit || '200'), 10) || 200, 5000);
    const parentValue = String(req.query.parentValue || '').trim();

    const spec = parseFilterSpecs(table.filterColumns).find(f => f.column.toUpperCase() === column.toUpperCase());

    const { engine, cfg } = await getConnInfo(table.connectionId);
    const tableName = physicalTableName(table.name);
    const q = (n: string) => quoteIdent(n, engine);
    const tbl = quoteTable(tableName, engine);
    const col = q(column);
    // Oracle has no LIMIT; wrap the ordered query instead.
    const capped = (sql: string, n: number) => engine === 'oracle' ? `SELECT * FROM (${sql}) WHERE ROWNUM <= ${n}` : `${sql} LIMIT ${n}`;
    // Oracle upper-cases unquoted aliases, Postgres/MySQL keep them lower.
    const pick = (r: any, k: string) => r[k] ?? r[k.toUpperCase()] ?? r[k.toLowerCase()];
    const ph = (i: number) => engine === 'mysql' ? '?' : engine === 'oracle' ? `:${i}` : `$${i}`;

    let options: { value: string; label: string }[] = [];
    let totalDistinct = 0;

    const lookup = parseLookupRef(spec?.optionsFrom);
    if (lookup) {
      // ── Read the dropdown from the registry table, not the real one ────────
      // GROUP BY code + MIN(name): registries that keep one row per fiscal year
      // would otherwise show the same code several times.
      const lk = quoteTable(lookup.table, engine);
      const code = q(lookup.codeCol);
      const name = q(lookup.nameCol);
      const params: any[] = [];
      let where = `WHERE ${code} IS NOT NULL`;
      if (spec?.parentColumn && parentValue) {
        if (!FILTER_IDENT_RE.test(spec.parentColumn)) { res.status(400).json({ success: false, error: 'invalid parent column in registry' }); return; }
        where += ` AND ${q(spec.parentColumn)} = ${ph(1)}`;
        params.push(parentValue);
      }
      const sql = capped(`SELECT ${code} AS v, MIN(${name}) AS l FROM ${lk} ${where} GROUP BY ${code} ORDER BY ${code}`, limit);
      const rows = await runSelectRows(engine, cfg, sql, params);
      options = rows.map(r => ({ value: String(pick(r, 'v') ?? ''), label: String(pick(r, 'l') ?? pick(r, 'v') ?? '') }));
      totalDistinct = options.length;
    } else {
      // ── DISTINCT over the table itself ─────────────────────────────────────
      const countSql = `SELECT COUNT(DISTINCT ${col}) AS cnt FROM ${tbl}`;
      const siblingLabel = spec?.labelSource && !spec.labelSource.includes('.') ? spec.labelSource : undefined;
      if (siblingLabel && !FILTER_IDENT_RE.test(siblingLabel)) { res.status(400).json({ success: false, error: 'invalid label source in registry' }); return; }

      const valuesSql = siblingLabel
        ? capped(`SELECT ${col} AS v, MIN(${q(siblingLabel)}) AS l FROM ${tbl} WHERE ${col} IS NOT NULL GROUP BY ${col} ORDER BY ${col}`, limit)
        : capped(`SELECT DISTINCT ${col} AS v FROM ${tbl} WHERE ${col} IS NOT NULL ORDER BY ${col}`, limit);

      const [countRows, valueRows] = await Promise.all([
        runSelectRows(engine, cfg, countSql, []),
        runSelectRows(engine, cfg, valuesSql, []),
      ]);
      totalDistinct = Number(pick(countRows[0] || {}, 'cnt') || 0);
      options = valueRows.map(r => {
        const v = pick(r, 'v');
        const l = pick(r, 'l');
        return { value: v === null || v === undefined ? '' : String(v), label: l === null || l === undefined ? String(v ?? '') : String(l) };
      });

      // labelSource written as SCHEMA.TABLE.CODE.NAME — names come from there
      const labelLookup = parseLookupRef(spec?.labelSource);
      if (labelLookup && options.length > 0) {
        const lk = quoteTable(labelLookup.table, engine);
        const code = q(labelLookup.codeCol);
        const name = q(labelLookup.nameCol);
        const codes = options.map(o => o.value);
        const list = codes.map((_, i) => ph(i + 1)).join(', ');
        const sql = `SELECT ${code} AS v, MIN(${name}) AS l FROM ${lk} WHERE ${code} IN (${list}) GROUP BY ${code}`;
        const nameRows = await runSelectRows(engine, cfg, sql, codes);
        const byCode = new Map<string, string>();
        for (const r of nameRows) byCode.set(String(pick(r, 'v') ?? ''), String(pick(r, 'l') ?? ''));
        options = options.map(o => ({ ...o, label: byCode.get(o.value) || o.label }));
      }
    }

    // `values` kept for the older callers (clear-by-key) that only read codes.
    res.json({
      success: true,
      data: {
        values: options.map(o => o.value),
        options,
        totalDistinct,
        truncated: totalDistinct > options.length,
      },
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /tables/:id/suggest — typeahead for the search box on a column head
//
//   ?column=DEPT&q=abc&limit=8&filters=<json>
//
// Deliberately cheap: no COUNT, capped rows, and the filters already applied on
// the screen narrow the scan.  A slow or failing lookup must never block typing
// — the screen falls back to the values on the current page.
router.get('/tables/:id/suggest', async (req: Request, res: Response) => {
  try {
    const table = await prisma.repoTable.findUnique({ where: { id: req.params.id } });
    if (!table) { res.status(404).json({ success: false, error: 'Table not found' }); return; }
    if (!table.connectionId) { res.status(400).json({ success: false, error: 'No connection configured' }); return; }
    const column = String(req.query.column || '').trim();
    if (!column || !FILTER_IDENT_RE.test(column)) { res.status(400).json({ success: false, error: 'valid column query param required' }); return; }
    let rawFilters: any = [];
    try { rawFilters = req.query.filters ? JSON.parse(String(req.query.filters)) : []; } catch { /* handled below */ }
    const allowed = await allowedFilterColumnsFor(table, [column, ...filterColumnNames(rawFilters)]);
    if (allowed.size > 0 && !allowed.has(column.toUpperCase())) { res.status(400).json({ success: false, error: 'unknown column' }); return; }

    const q = String(req.query.q || '').trim();
    const limit = Math.min(parseInt(String(req.query.limit || '8'), 10) || 8, 50);

    const { engine, cfg } = await getConnInfo(table.connectionId);
    const tbl = quoteTable(physicalTableName(table.name), engine);
    const col = quoteIdent(column, engine);

    // Everything filtered on screen except this column's own search box.
    let conds: FilterCond[] = [];
    try {
      const raw = req.query.filters ? JSON.parse(String(req.query.filters)) : [];
      conds = normalizeFilters(raw, allowed).filter(c => c.column.toUpperCase() !== column.toUpperCase());
    } catch { /* malformed filters — suggest across the whole table */ }
    const filt = buildFilterClause(conds, engine, 1);

    const where = [`${col} IS NOT NULL`];
    const params = [...filt.params];
    if (filt.sql) where.push(filt.sql);
    if (q) {
      const i = filt.nextIndex;
      const p = engine === 'mysql' ? '?' : engine === 'oracle' ? `:${i}` : `$${i}`;
      where.push(`${likeTarget(col, engine)} LIKE UPPER(${p}) ESCAPE '\\'`);
      params.push(likeNeedle(q));
    }
    const inner = `SELECT DISTINCT ${col} AS v FROM ${tbl} WHERE ${where.join(' AND ')} ORDER BY ${col}`;
    const sql = engine === 'oracle' ? `SELECT * FROM (${inner}) WHERE ROWNUM <= ${limit}` : `${inner} LIMIT ${limit}`;

    const rows = await runSelectRows(engine, cfg, sql, params);
    const values = rows
      .map(r => r.v ?? r.V)
      .filter(v => v !== null && v !== undefined)
      .map(v => String(v));
    res.json({ success: true, data: { values } });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /tables/:id/clear — bulk-delete rows by conditions
// Three accepted body shapes (in priority order):
//   1) { conditions: [{column, values: []}, ...] }     — AND across, IN within
//   2) { keyColumns: ["FYEAR"], values: [["2568"]] }   — composite-key tuples
//   3) { keyColumn:  "FYEAR",  keyValues: ["2568"] }   — single-key shorthand
router.post('/tables/:id/clear', async (req: Request, res: Response) => {
  try {
    const table = await prisma.repoTable.findUnique({ where: { id: req.params.id } });
    if (!table) { res.status(404).json({ success: false, error: 'Table not found' }); return; }
    if (!table.connectionId) { res.status(400).json({ success: false, error: 'No connection configured' }); return; }

    const body = req.body || {};
    const tableName = physicalTableName(table.name);
    let deleted = 0;

    if (Array.isArray(body.conditions)) {
      // Form 1: conditions array
      const conditions = body.conditions
        .map((c: any) => ({
          column: typeof c?.column === 'string' ? c.column : '',
          values: Array.isArray(c?.values) ? c.values : [],
        }))
        .filter((c: any) => c.column && c.values.length > 0);
      if (conditions.length === 0) {
        res.status(400).json({ success: false, error: 'At least one valid condition required (column + values)' });
        return;
      }
      deleted = await deleteByConditions(table.connectionId, tableName, conditions);
    } else {
      // Form 2 / 3: tuple-based
      let keyColumns: string[] = [];
      let rows: Record<string, any>[] = [];
      if (Array.isArray(body.keyColumns) && Array.isArray(body.values)) {
        keyColumns = body.keyColumns.map((k: any) => String(k));
        rows = (body.values as any[][]).map(tup => {
          const r: Record<string, any> = {};
          keyColumns.forEach((col, i) => { r[col] = tup?.[i] ?? null; });
          return r;
        });
      } else if (typeof body.keyColumn === 'string' && Array.isArray(body.keyValues)) {
        keyColumns = [body.keyColumn];
        rows = (body.keyValues as any[]).map(v => ({ [body.keyColumn]: v }));
      } else {
        res.status(400).json({
          success: false,
          error: 'Provide {conditions:[{column,values}]} or {keyColumns:[], values:[[...]]} or {keyColumn, keyValues:[]}',
        });
        return;
      }
      if (keyColumns.length === 0) {
        res.status(400).json({ success: false, error: 'At least one key column required' });
        return;
      }
      if (rows.length === 0) {
        res.status(400).json({ success: false, error: 'At least one value required' });
        return;
      }
      deleted = await deleteByKeys(table.connectionId, tableName, keyColumns, rows);
    }

    // Refresh row count
    const newCount = Math.max(0, (table.rowCount || 0) - deleted);
    await prisma.repoTable.update({ where: { id: table.id }, data: { rowCount: newCount } });

    res.json({ success: true, data: { rowsDeleted: deleted, rowCount: newCount } });
  } catch (err: any) {
    console.error('clear failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── External Public API (API Key auth, no JWT required) ─────────────────────

async function repoApiKeyAuth(req: Request, res: Response, next: Function) {
  const key = (req.headers['x-api-key'] as string) || (req.query.apiKey as string);
  if (!key) { res.status(401).json({ success: false, error: 'API key required' }); return; }
  const apiKey = await prisma.repoApiKey.findFirst({ where: { key, isActive: true } });
  if (!apiKey) { res.status(401).json({ success: false, error: 'Invalid or inactive API key' }); return; }
  if (apiKey.expiresAt && new Date(apiKey.expiresAt) < new Date()) {
    res.status(401).json({ success: false, error: 'API key expired' }); return;
  }
  (req as any).repoApiKey = apiKey;
  next();
}

// GET /data-repository/ext/tables — list available tables
router.get('/ext/tables', repoApiKeyAuth, async (_req: Request, res: Response) => {
  try {
    const tables = await prisma.repoTable.findMany({
      select: { id: true, name: true, description: true, rowCount: true, syncStatus: true, lastSyncAt: true },
      orderBy: { name: 'asc' },
    });
    res.json({ success: true, data: { tables } });
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});

// POST /data-repository/ext/query — query table via API key
router.post('/ext/query', repoApiKeyAuth, async (req: Request, res: Response) => {
  try {
    const { tableId, folderId, limit = 200, offset = 0, filters } = req.body;
    if (!tableId) { res.status(400).json({ success: false, error: 'tableId required' }); return; }
    const table = await prisma.repoTable.findUnique({ where: { id: tableId } });
    if (!table) { res.status(404).json({ success: false, error: 'Table not found' }); return; }
    if (!table.connectionId) { res.status(400).json({ success: false, error: 'No connection configured' }); return; }
    const tableName = physicalTableName(table.name);
    // Same filter shape as the screen: [{column, values}] over declared columns.
    const conds = normalizeFilters(filters, await allowedFilterColumnsFor(table, filterColumnNames(filters)));
    const result = await queryRepoTable(table.connectionId, tableName, folderId, Math.min(Number(limit), 5000), Number(offset), conds);
    res.json({ success: true, data: result });
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});

// POST /data-repository/ext/push — append rows via API key (write/admin permission required)
router.post('/ext/push', repoApiKeyAuth, async (req: Request, res: Response) => {
  try {
    const apiKey = (req as any).repoApiKey;
    if (apiKey.permissions === 'read') { res.status(403).json({ success: false, error: 'Write permission required' }); return; }
    const { tableId, rows } = req.body;
    if (!tableId || !Array.isArray(rows) || rows.length === 0) {
      res.status(400).json({ success: false, error: 'tableId and rows[] required' }); return;
    }
    const table = await prisma.repoTable.findUnique({ where: { id: tableId } });
    if (!table) { res.status(404).json({ success: false, error: 'Table not found' }); return; }
    const inserted = await appendRows(table, rows);
    const newCount = (table.rowCount || 0) + inserted;
    await prisma.repoTable.update({ where: { id: tableId }, data: { rowCount: newCount } });
    res.json({ success: true, data: { inserted, totalRows: newCount } });
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});

export default router;
