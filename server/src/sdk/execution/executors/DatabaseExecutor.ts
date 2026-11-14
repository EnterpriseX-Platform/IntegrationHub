// Database Executor - SQL operations using connection-specific databases
// Supports: PostgreSQL, MySQL, SQLite (via Prisma), Oracle (via oracledb)

import { NodeExecutor } from '../NodeExecutor';
import { ExecutionNode, ExecutionContext } from '../types';
import { PrismaClient } from '@prisma/client';
import * as oracledb from 'oracledb';
import * as crypto from 'crypto';

const prisma = new PrismaClient();

// Dynamic clients cache per connection
const connectionClients = new Map<string, PrismaClient>();
const oraclePools = new Map<string, oracledb.Pool>();

// Per-call ceiling for Oracle round-trips (ms). Generous enough for the bulk
// loads these flows do, but finite so a lock wait can't hang a run forever.
// Set ORACLE_CALL_TIMEOUT_MS=0 to disable.
const ORACLE_CALL_TIMEOUT_MS = parseInt(process.env.ORACLE_CALL_TIMEOUT_MS || '600000', 10);

interface DatabaseNodeData {
  connectionId: string;
  operation: 'select' | 'insert' | 'update' | 'delete' | 'query' | 'code' | 'bulk-insert' | 'execute';
  sql?: string;
  code?: string;
  parameters?: string[];
  params?: Record<string, string>;  // Named bind parameters with template values (for execute operation)
  table?: string;
  columnMapping?: { column: string; value: string }[];
  whereClause?: string;
  // bulk-insert specific
  dataPath?: string;          // path to array of rows in context (e.g. "vars.fileread.files[0].data")
  filesPath?: string;         // path to files array (e.g. "vars.fileread.files") — merges all .data arrays
  batchSize?: number;         // rows per batch (default 1000)
  truncateFirst?: boolean;    // [legacy] DELETE FROM table before insert. Prefer importMode.
  /**
   * Import mode (overrides truncateFirst):
   *   'append'        — insert only; existing rows untouched (default)
   *   'truncate'      — TRUNCATE the whole table first (DDL, fast, no rollback)
   *   'delete-all'    — DELETE FROM table (DML, slow but rollback-safe)
   *   'delete-by-key' — DELETE rows matching deleteKeys[] from incoming data, then insert
   *                     (idempotent re-import: same key values get replaced)
   */
  importMode?: 'append' | 'truncate' | 'delete-all' | 'delete-by-key';
  /**
   * For 'delete-by-key' mode: which columns identify the rows to pre-delete.
   * Entry forms:
   *   'FISCAL_YEAR'                                  — exact match, value taken from incoming rows
   *   { column: 'PERIOD_CODE', prefixLength: 4 } — match rows whose column starts
   *     with the first N chars of the incoming value (e.g. year "2569" of "2569-00")
   *   { column: 'FISCAL_YEAR', value: '{{year}}' }   — explicit value (template-resolved,
   *     e.g. a run parameter); falls back to row extraction when it resolves empty
   */
  deleteKeys?: Array<string | { column: string; prefixLength?: number; value?: string }>;
  columns?: string[];         // column names to insert
  fileColumns?: string[];     // column names from file (if different from DB columns)
  extraColumns?: { column: string; value: string }[]; // extra static columns to add (e.g. POST_DATE)
  idColumn?: string;          // auto-generate UUID for this column (e.g. "RECORD_ID")
  skipRows?: number;          // skip first N rows per file (e.g. skip Grand Total row)
}

interface ConnectionConfig {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  type: 'postgresql' | 'mysql' | 'sqlite' | 'oracle' | string;
  ssl?: boolean;
  serviceName?: string;
  sid?: string;
}

export class DatabaseExecutor extends NodeExecutor {
  readonly type = 'database';

  async executeNode(node: ExecutionNode, context: ExecutionContext): Promise<any> {
    // Postgres COUNT/SUM/BIGINT columns come back as JS BigInt, which JSON.stringify
    // cannot serialise — the execution then failed when its output was stored.
    return toJsonSafe(await this.runOperation(node, context));
  }

  private async runOperation(node: ExecutionNode, context: ExecutionContext): Promise<any> {
    const data = node.data as DatabaseNodeData;
    
    if (!data.connectionId) {
      throw new Error('Database connection ID is required');
    }

    const operation = data.operation || 'select';

    switch (operation) {
      case 'select':
      case 'query':
        return this.executeSelect(data, context);
      case 'code':
        return this.executeCode(data, context);
      case 'insert':
        return this.executeInsert(data, context);
      case 'update':
        return this.executeUpdate(data, context);
      case 'delete':
        return this.executeDelete(data, context);
      case 'bulk-insert':
        return this.executeBulkInsert(data, context);
      case 'execute':
        return this.executeExecute(data, context);
      default:
        throw new Error(`Unknown operation: ${operation}`);
    }
  }

  private async getConnectionConfig(connectionId: string): Promise<ConnectionConfig> {
    const conn = await prisma.connection.findUnique({
      where: { id: connectionId }
    });
    
    if (!conn) {
      throw new Error(`Connection not found: ${connectionId}`);
    }
    
    if (conn.status !== 'Active' && conn.status !== 'Connected') {
      throw new Error(`Connection is not active: ${conn.name} (status: ${conn.status})`);
    }
    
    return JSON.parse(conn.config) as ConnectionConfig;
  }

  private buildConnectionUrl(config: ConnectionConfig): string {
    const port = config.port || 5432;
    const sslParam = config.ssl ? '?sslmode=require' : '';
    return `postgresql://${config.username}:${config.password}@${config.host}:${port}/${config.database}${sslParam}`;
  }

  private async getPrismaClient(connectionId: string, config: ConnectionConfig): Promise<PrismaClient> {
    if (connectionClients.has(connectionId)) {
      return connectionClients.get(connectionId)!;
    }

    const databaseUrl = this.buildConnectionUrl(config);
    
    const client = new PrismaClient({
      datasources: {
        db: {
          url: databaseUrl,
        },
      },
    });

    connectionClients.set(connectionId, client);
    return client;
  }

  private async getOraclePool(connectionId: string, config: ConnectionConfig): Promise<oracledb.Pool> {
    if (oraclePools.has(connectionId)) {
      return oraclePools.get(connectionId)!;
    }

    // Use simple connect string for thin mode compatibility
    const serviceName = (config as any).options?.serviceName || config.serviceName || config.database;
    const connectString = `${config.host}:${config.port || 1521}/${serviceName}`;

    console.log(`[Oracle] Connect string: ${connectString}`);

    const pool = await oracledb.createPool({
      user: config.username,
      password: config.password,
      connectString: connectString,
      poolMin: 0,
      poolMax: 5,
      poolIncrement: 1,
      poolTimeout: 60,
    });

    oraclePools.set(connectionId, pool);
    return pool;
  }

  private async executeWithConnection<T>(
    connectionId: string, 
    fn: (client: any, isOracle: boolean) => Promise<T>
  ): Promise<T> {
    const config = await this.getConnectionConfig(connectionId);
    const isOracle = config.type === 'oracle';

    try {
      if (isOracle) {
        console.log(`[Oracle] Connecting to ${config.host}:${config.port || 1521}/${config.database}...`);
        let pool = await this.getOraclePool(connectionId, config);
        console.log(`[Oracle] Pool created, getting connection...`);
        let connection: oracledb.Connection;
        try {
          connection = await pool.getConnection();
        } catch (poolErr: any) {
          // If pool connection fails, clear cached pool and retry once
          console.log(`[Oracle] Pool connection failed (${poolErr.message}), retrying with fresh pool...`);
          try { await pool.close(0); } catch(_) {}
          oraclePools.delete(connectionId);
          pool = await this.getOraclePool(connectionId, config);
          connection = await pool.getConnection();
        }
        console.log(`[Oracle] Connection acquired`);
        // Bound each round-trip. A DML blocked on a row lock held by another
        // session otherwise waits forever, and the whole flow hangs with it.
        if (ORACLE_CALL_TIMEOUT_MS > 0) {
          connection.callTimeout = ORACLE_CALL_TIMEOUT_MS;
        }
        try {
          return await fn(connection, true);
        } finally {
          await connection.close();
        }
      } else {
        const client = await this.getPrismaClient(connectionId, config);
        return await fn(client, false);
      }
    } catch (error: any) {
      console.error(`[Oracle] Error:`, error);
      const errorCode = error?.code;
      const errorMessage = error?.message || String(error);
      
      // Oracle error codes
      if (errorCode === 'ORA-12154' || errorCode === 'ORA-12541' || errorCode === 'ORA-12543' || errorCode === 'NJS-510') {
        throw new Error(`Cannot connect to Oracle database: ${errorMessage}`);
      }
      if (errorCode === 'ORA-01017') {
        throw new Error(`Oracle authentication failed. Please check username and password.`);
      }
      if (errorCode === 'ORA-00942') {
        throw new Error(`Table or view does not exist.`);
      }
      if (errorCode === 'ORA-01722') {
        throw new Error(`Invalid number format in query.`);
      }
      
      // PostgreSQL error codes
      if (errorCode === '42P01' || errorMessage.includes('relation') && errorMessage.includes('does not exist')) {
        throw new Error(`Table not found. Please check if the table exists.`);
      }
      if (errorCode === '28P01') {
        throw new Error(`Database authentication failed. Please check credentials.`);
      }
      if (errorCode === '3D000') {
        throw new Error(`Database does not exist.`);
      }
      if (errorCode === 'P1001' || (errorMessage.includes('connect') && !errorMessage.includes('ORA-') && !errorMessage.includes('NJS-'))) {
        throw new Error(`Cannot connect to database server. Please check if database is running.`);
      }
      
      throw new Error(`Database query failed: ${errorMessage}`);
    }
  }

  private async executeOracleQuery(connection: oracledb.Connection, sql: string, params: any[] = []): Promise<any> {
    // Strip trailing semicolons — Oracle OCI does not accept them (causes ORA-00933)
    let oracleSql = sql.trim().replace(/;+$/, '');
    const oracleParams: any[] = [];

    // Handle $1, $2 style parameters
    let paramIndex = 1;
    oracleSql = oracleSql.replace(/\$(\d+)/g, (_, num) => {
      const idx = parseInt(num) - 1;
      if (params[idx] !== undefined) {
        oracleParams.push(params[idx]);
      }
      return `:${paramIndex++}`;
    });

    // Handle ? style parameters
    if (oracleParams.length === 0 && params.length > 0) {
      let qIndex = 0;
      oracleSql = oracleSql.replace(/\?/g, () => {
        oracleParams.push(params[qIndex++]);
        return `:${paramIndex++}`;
      });
    }

    const result = await connection.execute(oracleSql, oracleParams, {
      outFormat: oracledb.OUT_FORMAT_OBJECT,
      // Auto-convert CLOB columns to string — required for JSON_ARRAYAGG(...RETURNING CLOB)
      fetchInfo: {},
    });

    // Convert any remaining CLOB/Buffer objects in rows to string, then try JSON.parse
    const rows = (result.rows || []) as any[];
    for (const row of rows) {
      for (const key of Object.keys(row)) {
        const val = row[key];
        let strVal: string | null = null;
        if (val && typeof val === 'object' && typeof val.getData === 'function') {
          // oracledb Lob object — read it as string
          strVal = await val.getData();
        } else if (Buffer.isBuffer(val)) {
          strVal = val.toString('utf8');
        }
        if (strVal !== null) {
          // Auto-parse JSON strings (e.g. JSON_ARRAYAGG(...RETURNING CLOB) results)
          const trimmed = strVal.trimStart();
          if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
            try {
              row[key] = JSON.parse(strVal);
            } catch {
              row[key] = strVal;
            }
          } else {
            row[key] = strVal;
          }
        }
      }
    }

    // If query returns a single row with a single column that is an array,
    // unwrap it so the executor returns the array directly (avoids [{RESULT: [...]}])
    if (rows.length === 1) {
      const keys = Object.keys(rows[0]);
      if (keys.length === 1 && Array.isArray(rows[0][keys[0]])) {
        return rows[0][keys[0]];
      }
    }

    return rows;
  }

  private async executeOracleNonQuery(connection: oracledb.Connection, sql: string, params: any[] = []): Promise<number> {
    // Strip trailing semicolons — Oracle OCI does not accept them (causes ORA-00933)
    let oracleSql = sql.trim().replace(/;+$/, '');
    const oracleParams: any[] = [];

    let paramIndex = 1;
    oracleSql = oracleSql.replace(/\$(\d+)/g, (_, num) => {
      const idx = parseInt(num) - 1;
      if (params[idx] !== undefined) {
        oracleParams.push(params[idx]);
      }
      return `:${paramIndex++}`;
    });

    if (oracleParams.length === 0 && params.length > 0) {
      let qIndex = 0;
      oracleSql = oracleSql.replace(/\?/g, () => {
        oracleParams.push(params[qIndex++]);
        return `:${paramIndex++}`;
      });
    }

    const result = await connection.execute(oracleSql, oracleParams, {
      autoCommit: true,
    });

    return result.rowsAffected || 0;
  }

  private async executeSelect(data: DatabaseNodeData, context: ExecutionContext): Promise<any> {
    let sql = data.sql || 'SELECT 1';
    
    // Resolve template parameters
    sql = this.resolveTemplate(sql, context);
    
    // Debug logging
    this.log(context, 'debug', 'Database SELECT', {
      sql,
      connectionId: data.connectionId,
      inputParams: context.input?.params,
    });

    return this.executeWithConnection(data.connectionId, async (client, isOracle) => {
      let result;
      if (isOracle) {
        result = await this.executeOracleQuery(client, sql);
      } else {
        result = await client.$queryRawUnsafe(sql);
      }
      
      // Debug logging result
      this.log(context, 'debug', 'Database SELECT Result', {
        rowCount: Array.isArray(result) ? result.length : 1,
        sample: Array.isArray(result) && result.length > 0 ? result[0] : result,
      });
      
      return {
        rows: result,
        rowCount: Array.isArray(result) ? result.length : 1,
        command: 'SELECT',
      };
    });
  }

  private async executeCode(data: DatabaseNodeData, context: ExecutionContext): Promise<any> {
    const code = data.code;
    if (!code) {
      throw new Error('Code is required for code operation');
    }

    // Build vars from context (same as TransformExecutor)
    const vars = Object.fromEntries(context.variables || new Map());
    const input = context.input?.body || context.input || {};

    // Execute JavaScript code to generate SQL
    let codeResult: any;
    try {
      const fn = new Function('input', 'vars', 'context', code);
      codeResult = fn(input, vars, context);
    } catch (err: any) {
      throw new Error(`Code execution error: ${err.message}`);
    }

    // Extract SQL from result
    const sql = typeof codeResult === 'string' ? codeResult : codeResult?.sql;
    if (!sql || typeof sql !== 'string') {
      throw new Error('Code must return a SQL string or an object with .sql property');
    }

    // Extract optional bind params from code result (supports named bind variables)
    const codeParams = typeof codeResult === 'object' ? (codeResult?.params || null) : null;

    this.log(context, 'debug', 'Database CODE', {
      sqlLength: sql.length,
      connectionId: data.connectionId,
      resultType: typeof codeResult === 'string' ? 'string' : 'object',
      hasParams: !!codeParams,
    });

    // Detect PL/SQL blocks (BEGIN...END)
    const isPLSQL = /^\s*(BEGIN|DECLARE)\b/i.test(sql.trim());

    // Execute the generated SQL
    return this.executeWithConnection(data.connectionId, async (client, isOracle) => {
      if (isOracle) {
        const conn = client as oracledb.Connection;
        let rows: any;
        let rowCount = 0;
        if (isPLSQL) {
          // PL/SQL blocks — use named bind params if provided
          console.log(`[Oracle] Executing PL/SQL block (${sql.length} chars${codeParams ? `, ${Object.keys(codeParams).length} params` : ''})...`);
          if (codeParams && typeof codeParams === 'object' && !Array.isArray(codeParams)) {
            // Named bind params from code result
            const result = await conn.execute(sql, codeParams, { autoCommit: true });
            rowCount = result.rowsAffected || 0;
          } else if (Array.isArray(codeParams)) {
            rowCount = await this.executeOracleNonQuery(conn, sql, codeParams);
          } else {
            rowCount = await this.executeOracleNonQuery(conn, sql);
          }
          rows = [];
        } else {
          if (codeParams && typeof codeParams === 'object' && !Array.isArray(codeParams)) {
            const result = await conn.execute(sql, codeParams, { outFormat: oracledb.OUT_FORMAT_OBJECT });
            rows = result.rows || [];
          } else {
            rows = await this.executeOracleQuery(conn, sql, Array.isArray(codeParams) ? codeParams : []);
          }
          rowCount = Array.isArray(rows) ? rows.length : 0;
        }
        return {
          rows,
          rowCount,
          command: isPLSQL ? 'PLSQL' : 'CODE',
          ...(typeof codeResult === 'object' ? { summary: codeResult.summary } : {}),
        };
      } else {
        // Non-Oracle: resolve named params inline if provided
        let resolvedSql = sql;
        if (codeParams && typeof codeParams === 'object' && !Array.isArray(codeParams)) {
          for (const [key, value] of Object.entries(codeParams)) {
            resolvedSql = resolvedSql.replace(new RegExp(`:${key}\\b`, 'g'), this.escapeSqlValue(value));
          }
        }
        const result = await client.$queryRawUnsafe(resolvedSql);
        return {
          rows: result,
          rowCount: Array.isArray(result) ? result.length : 1,
          command: 'CODE',
          ...(typeof codeResult === 'object' ? { summary: codeResult.summary } : {}),
        };
      }
    });
  }

  private async executeInsert(data: DatabaseNodeData, context: ExecutionContext): Promise<any> {
    if (!data.table) {
      throw new Error('Table name is required for INSERT');
    }

    const mappings = data.columnMapping || [];
    if (mappings.length === 0) {
      throw new Error('Column mapping is required for INSERT');
    }

    return this.executeWithConnection(data.connectionId, async (client, isOracle) => {
      const columns: string[] = [];
      const values: any[] = [];

      mappings.forEach((mapping) => {
        columns.push(mapping.column);
        const resolvedValue = this.resolveTemplate(mapping.value, context);
        values.push(resolvedValue === 'NULL' ? null : resolvedValue);
      });

      let sql: string;
      if (isOracle) {
        // Oracle uses RETURNING INTO syntax
        const placeholders = values.map((_, i) => `:${i + 1}`).join(', ');
        sql = `INSERT INTO ${data.table} (${columns.join(', ')}) VALUES (${placeholders})`;
      } else {
        const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');
        sql = `INSERT INTO "${data.table}" (${columns.join(', ')}) VALUES (${placeholders}) RETURNING *`;
      }

      // Debug logging
      this.log(context, 'debug', 'Database INSERT', {
        table: data.table,
        sql,
        parameters: values,
        columnMapping: mappings,
      });

      let result;
      if (isOracle) {
        const rowsAffected = await this.executeOracleNonQuery(client, sql, values);
        result = [{ rowsAffected }];
      } else {
        result = await client.$queryRawUnsafe(sql, ...values);
      }
      
      // Debug logging result
      this.log(context, 'debug', 'Database INSERT Result', {
        rowCount: Array.isArray(result) ? result.length : 1,
        rows: Array.isArray(result) ? result : [result],
      });
      
      return {
        rows: Array.isArray(result) ? result : [result],
        rowCount: Array.isArray(result) ? result.length : 1,
        command: 'INSERT',
      };
    });
  }

  private async executeUpdate(data: DatabaseNodeData, context: ExecutionContext): Promise<any> {
    if (!data.table) {
      throw new Error('Table name is required for UPDATE');
    }

    const mappings = data.columnMapping || [];
    if (mappings.length === 0) {
      throw new Error('Column mapping is required for UPDATE');
    }

    return this.executeWithConnection(data.connectionId, async (client, isOracle) => {
      const setClauses: string[] = [];
      const values: any[] = [];

      mappings.forEach((mapping, index) => {
        if (isOracle) {
          setClauses.push(`${mapping.column} = :${index + 1}`);
        } else {
          setClauses.push(`${mapping.column} = $${index + 1}`);
        }
        const resolvedValue = this.resolveTemplate(mapping.value, context);
        values.push(resolvedValue === 'NULL' ? null : resolvedValue);
      });

      let sql = isOracle 
        ? `UPDATE ${data.table} SET ${setClauses.join(', ')}`
        : `UPDATE "${data.table}" SET ${setClauses.join(', ')}`;

      if (data.whereClause) {
        const whereSql = this.resolveTemplate(data.whereClause, context);
        sql += ` WHERE ${whereSql}`;
      }

      // Debug logging
      this.log(context, 'debug', 'Database UPDATE', {
        table: data.table,
        sql,
        parameters: values,
        whereClause: data.whereClause,
      });

      let result;
      if (isOracle) {
        result = await this.executeOracleNonQuery(client, sql, values);
      } else {
        result = await client.$executeRawUnsafe(sql, ...values);
      }

      // Debug logging result
      this.log(context, 'debug', 'Database UPDATE Result', {
        rowCount: result,
      });

      return {
        rows: [],
        rowCount: result,
        command: 'UPDATE',
      };
    });
  }

  private async executeDelete(data: DatabaseNodeData, context: ExecutionContext): Promise<any> {
    if (!data.table) {
      throw new Error('Table name is required for DELETE');
    }

    return this.executeWithConnection(data.connectionId, async (client, isOracle) => {
      let sql = isOracle
        ? `DELETE FROM ${data.table}`
        : `DELETE FROM "${data.table}"`;

      if (data.whereClause) {
        const whereSql = this.resolveTemplate(data.whereClause, context);
        sql += ` WHERE ${whereSql}`;
      }

      // Debug logging
      this.log(context, 'debug', 'Database DELETE', {
        table: data.table,
        sql,
        whereClause: data.whereClause,
      });

      let result;
      if (isOracle) {
        result = await this.executeOracleNonQuery(client, sql);
      } else {
        result = await client.$executeRawUnsafe(sql);
      }

      // Debug logging result
      this.log(context, 'debug', 'Database DELETE Result', {
        rowCount: result,
      });

      return {
        rows: [],
        rowCount: result,
        command: 'DELETE',
      };
    });
  }

  private async executeBulkInsert(data: DatabaseNodeData, context: ExecutionContext): Promise<any> {
    if (!data.table) {
      throw new Error('Table name is required for bulk-insert');
    }

    // Get data rows from context — supports single array (dataPath) or multi-file (filesPath)
    let rows: any[];
    if (data.filesPath) {
      const files = this.getValueByPath2(context, data.filesPath);
      if (!files || !Array.isArray(files)) {
        throw new Error(`No files array found at path: ${data.filesPath} (got ${typeof files})`);
      }
      rows = [];
      const skipRows = data.skipRows || 0;
      for (const file of files) {
        const fileData = file?.data;
        if (Array.isArray(fileData) && fileData.length > skipRows) {
          const sliced = fileData.slice(skipRows);
          rows = rows.concat(sliced);
          this.log(context, 'info', `File ${file.fileName || '?'}: ${sliced.length} data rows (skipped ${skipRows})`);
        }
      }
    } else {
      const dataPath = data.dataPath || 'vars.fileread.files[0].data';
      const rawData = this.getValueByPath2(context, dataPath);
      if (!rawData || !Array.isArray(rawData)) {
        throw new Error(`No array data found at path: ${dataPath} (got ${typeof rawData})`);
      }
      rows = data.skipRows ? rawData.slice(data.skipRows) : rawData;
    }
    if (rows.length === 0) {
      return { rows: [], rowCount: 0, command: 'BULK-INSERT', message: 'No rows to insert' };
    }

    // Determine columns from data or config
    const fileColumns = data.fileColumns || Object.keys(rows[0]);
    const dbColumns = data.columns || fileColumns;

    if (fileColumns.length !== dbColumns.length) {
      throw new Error(`Column count mismatch: file has ${fileColumns.length}, db expects ${dbColumns.length}`);
    }

    // Add extra static columns and ID column
    const extraCols = data.extraColumns || [];
    const idColumn = data.idColumn;
    const allDbColumns = [
      ...(idColumn ? [idColumn] : []),
      ...dbColumns,
      ...extraCols.map(e => e.column),
    ];

    const batchSize = data.batchSize || 5000;
    // Commit every N batches to reduce UNDO pressure on large imports (default 10 → 50K rows per commit)
    const commitEvery = (data as any).commitEvery || 10;
    // truncateMode: 'truncate' (DDL, fast, no rollback) | 'delete' (DML, slow but reversible). Default = truncate for performance.
    const truncateMode = (data as any).truncateMode || 'truncate';

    this.log(context, 'info', `Bulk insert: ${rows.length.toLocaleString()} rows into ${data.table} (batch=${batchSize}, commit every ${commitEvery} batches)`);

    return this.executeWithConnection(data.connectionId, async (client, isOracle) => {
      if (!isOracle) {
        throw new Error('bulk-insert is currently only supported for Oracle connections');
      }

      const conn = client as oracledb.Connection;

      // Determine effective import mode. importMode is the new field;
      // truncateFirst (legacy) is still respected when importMode is unset.
      const effectiveMode: 'append' | 'truncate' | 'delete-all' | 'delete-by-key' =
        data.importMode
          ?? (data.truncateFirst ? (truncateMode === 'delete' ? 'delete-all' : 'truncate') : 'append');

      const isDestructive = effectiveMode !== 'append';
      // Normalize deleteKeys — entries are either a column name (exact match) or
      // { column, prefixLength } (match on the first N chars of the incoming value)
      const deleteKeySpecs = (data.deleteKeys || [])
        .map(k => (typeof k === 'string' ? { column: k } : k))
        .filter((k): k is { column: string; prefixLength?: number; value?: string } => !!k && !!k.column);

      // Validate delete-by-key has keys
      if (effectiveMode === 'delete-by-key') {
        if (deleteKeySpecs.length === 0) {
          throw new Error('Import mode "delete-by-key" requires deleteKeys[] — list at least one column to match for deletion.');
        }
        // Keys without an explicit value are extracted from incoming rows —
        // make sure those columns exist in the inserted columns
        for (const k of deleteKeySpecs) {
          if (k.value !== undefined && k.value !== '') continue;
          if (!allDbColumns.includes(k.column) && !(data.columns || []).includes(k.column) && !(data.fileColumns || []).includes(k.column)) {
            throw new Error(`deleteKey "${k.column}" not present in columns[] — cannot extract delete value from incoming rows (or set an explicit "value").`);
          }
        }
      }

      // Run pre-insert cleanup based on mode.
      // truncate / delete-all: once per table per execution — keyed by table (not
      // loop index) so a for-each whose branches import into different tables
      // still cleans each table before its first insert.
      // delete-by-key: every execution, but each distinct key tuple is deleted at
      // most once per table per execution, so later loop iterations carrying the
      // same key (e.g. part files of the same year) don't wipe rows inserted by
      // earlier iterations, while a new key (another year) still gets its pre-delete.
      const cleanupDoneKey = `_bulkCleanupDone:${data.table}`;
      if (isDestructive && effectiveMode !== 'delete-by-key' && !context.variables.get(cleanupDoneKey)) {
        context.variables.set(cleanupDoneKey, true);
        const t0 = Date.now();
        if (effectiveMode === 'truncate') {
          this.log(context, 'info', `TRUNCATE TABLE ${data.table} (DDL — fast, auto-commits)...`);
          await conn.execute(`TRUNCATE TABLE ${data.table}`);
          this.log(context, 'info', `✓ Truncated ${data.table} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
        } else if (effectiveMode === 'delete-all') {
          this.log(context, 'info', `DELETE FROM ${data.table} (rollback-safe, UNDO logged)...`);
          const r = await conn.execute(`DELETE FROM ${data.table}`, [], { autoCommit: false });
          this.log(context, 'info', `✓ Deleted ${r.rowsAffected ?? 0} rows from ${data.table} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
        }
      } else if (effectiveMode === 'delete-by-key') {
        const t0 = Date.now();
        // Resolve each key column to the row property that carries its value:
        // prefer the columns[i] -> fileColumns[i] mapping (rows from parsed files
        // are keyed by file headers, e.g. Thai report headers), then fall back to
        // a case-insensitive match against the first row's properties.
        const sampleRow = rows[0] || {};
        const lcRow: Record<string, string> = {};
        for (const p of Object.keys(sampleRow)) lcRow[p.toLowerCase()] = p;
        const keyToProp: Record<string, string> = {};
        for (const k of deleteKeySpecs) {
          const ci = (data.columns || []).indexOf(k.column);
          keyToProp[k.column] = (ci >= 0 && data.fileColumns?.[ci])
            ? data.fileColumns[ci]
            : (lcRow[k.column.toLowerCase()] ?? k.column);
        }

        // Explicit key values (template-resolved, e.g. a "{{year}}" run parameter).
        // An empty/unresolved template falls back to per-row extraction, so
        // batch-triggered runs work without parameters while manual runs can
        // pin the year to delete.
        const explicitVals: Record<string, any> = {};
        for (const k of deleteKeySpecs) {
          if (k.value === undefined || k.value === '') continue;
          const v = this.resolveTemplate(String(k.value), context);
          if (v !== undefined && v !== null && String(v) !== '' && !/\{\{.*\}\}/.test(String(v))) {
            explicitVals[k.column] = v;
          }
        }

        // Collect distinct key tuples from incoming rows, skipping tuples already
        // deleted earlier in this execution (tracked per table in context)
        const deletedTuplesKey = `_bulkDeletedTuples:${data.table}`;
        const alreadyDeleted: Set<string> = context.variables.get(deletedTuplesKey) instanceof Set
          ? context.variables.get(deletedTuplesKey)
          : new Set<string>();
        const tuples: any[][] = [];
        for (const r of rows) {
          const tup = deleteKeySpecs.map(k => {
            const raw = (k.column in explicitVals) ? explicitVals[k.column] : (r[keyToProp[k.column]] ?? null);
            return raw != null && k.prefixLength ? String(raw).slice(0, k.prefixLength) : raw;
          });
          const sig = JSON.stringify(tup);
          if (!alreadyDeleted.has(sig)) { alreadyDeleted.add(sig); tuples.push(tup); }
        }
        context.variables.set(deletedTuplesKey, alreadyDeleted);

        if (tuples.length === 0) {
          this.log(context, 'info', `No new key tuples to pre-delete for ${data.table} — skipping pre-delete.`);
        } else {
          // Build DELETE statement using AND on each key. executeMany runs this per tuple.
          // (Oracle's composite-IN syntax "(k1,k2) = (v1,v2)" is parsed as row-value
          // expression and rejected by some versions of Oracle DB with ORA-00920.)
          // prefixLength keys match on the leading chars (e.g. year "2569" of "2569-00").
          const conds = deleteKeySpecs.map((k, i) =>
            k.prefixLength ? `${k.column} LIKE :${i + 1} || '%'` : `${k.column} = :${i + 1}`);
          const deleteSql = `DELETE FROM ${data.table} WHERE ${conds.join(' AND ')}`;
          const keyDesc = deleteKeySpecs.map(k => k.prefixLength ? `${k.column}[1..${k.prefixLength}]` : k.column).join(',');
          this.log(context, 'info', `DELETE-BY-KEY ${data.table} matching ${tuples.length} distinct (${keyDesc}) tuples…`);
          let totalDeleted = 0;
          for (let i = 0; i < tuples.length; i += 1000) {
            const chunk = tuples.slice(i, i + 1000);
            const dres = await (conn as any).executeMany(deleteSql, chunk, { autoCommit: false });
            totalDeleted += (dres.rowsAffected ?? 0);
          }
          this.log(context, 'info', `✓ Deleted ${totalDeleted} matching rows in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
        }
      }

      // Build INSERT SQL with bind variables
      const placeholders = allDbColumns.map((_, i) => `:${i + 1}`).join(', ');
      const sql = `INSERT INTO ${data.table} (${allDbColumns.join(', ')}) VALUES (${placeholders})`;

      // Look up the actual DB column types so we can auto-coerce string inputs
      // (e.g. xlsx parsers keep "00001" as a string but the DB column may be NUMBER).
      // Without coercion executeMany throws NJS-011 ("bind value and type mismatch").
      const colTypeMap: Record<string, 'number' | 'date' | 'string'> = {};
      try {
        // data.table may be "APP.ORDERS" — split owner/name (Oracle assumption)
        const tableParts = String(data.table || '').split('.');
        const owner = tableParts.length > 1 ? tableParts[0].toUpperCase() : null;
        const tname = (tableParts[tableParts.length - 1] || '').toUpperCase();
        const sqlMeta = owner
          ? `SELECT column_name, data_type FROM all_tab_columns WHERE owner='${owner}' AND table_name='${tname}'`
          : `SELECT column_name, data_type FROM user_tab_columns WHERE table_name='${tname}'`;
        const meta = await (conn as any).execute(sqlMeta);
        for (const [cn, dt] of (meta.rows as any[])) {
          const t = String(dt).toUpperCase();
          if (t === 'NUMBER' || t === 'FLOAT' || t === 'INTEGER' || t === 'BINARY_FLOAT' || t === 'BINARY_DOUBLE') colTypeMap[cn] = 'number';
          else if (t === 'DATE' || t.startsWith('TIMESTAMP')) colTypeMap[cn] = 'date';
          else colTypeMap[cn] = 'string';
        }
      } catch (e: any) {
        this.log(context, 'warn', `Could not introspect column types for ${data.table} — string-only coercion: ${e.message}`);
      }

      const coerceValue = (val: any, dbColName: string): any => {
        if (val === null || val === undefined) return null;
        const t = colTypeMap[dbColName];
        if (t === 'number') {
          if (typeof val === 'number') return val;
          if (typeof val === 'string') {
            const s = val.trim();
            if (s === '') return null;
            // Strip thousands separators; parseFloat handles leading zeros + decimals
            const n = parseFloat(s.replace(/,/g, ''));
            return isNaN(n) ? val : n;  // pass through (let DB error) if not a number
          }
          if (val instanceof Date) return val.getTime();
          return val;
        }
        if (t === 'date') {
          if (val instanceof Date) return val;
          if (typeof val === 'string') {
            const d = new Date(val);
            return isNaN(d.getTime()) ? val : d;
          }
          return val;
        }
        // string column — convert non-strings to string form
        if (typeof val === 'string') return val;
        if (val instanceof Date) return val.toISOString();
        return String(val);
      };

      // bindDefs intentionally omitted — extra columns may be Date objects (POST_DATE, CREATED_DATE),
      // which mismatch a one-size-fits-all STRING bindDef. Auto-detect is slightly slower but correct.

      const startTime = Date.now();
      let totalInserted = 0;
      let batchesSinceCommit = 0;
      const totalBatches = Math.ceil(rows.length / batchSize);

      try {
        for (let i = 0; i < rows.length; i += batchSize) {
          const batch = rows.slice(i, i + batchSize);
          const batchNum = Math.floor(i / batchSize) + 1;

          // Build bind data for executeMany
          const binds: any[][] = batch.map(row => {
            const values: any[] = [];
            if (idColumn) {
              values.push(crypto.randomUUID());
            }
            // Pre-build case-insensitive lookup once per row (file headers may differ
            // in case from configured fileColumns — e.g. xlsx has "Min" but config has "MIN")
            const rowKeysCi: Record<string, string> = {};
            for (const k of Object.keys(row)) rowKeysCi[k.toLowerCase()] = k;
            for (let ci = 0; ci < fileColumns.length; ci++) {
              const col = fileColumns[ci];
              const dbCol = data.columns?.[ci] ?? col;  // map to DB column for type lookup
              let val = row[col];
              if (val === undefined) {
                // Fall back to case-insensitive lookup
                const realKey = rowKeysCi[col.toLowerCase()];
                if (realKey !== undefined) val = row[realKey];
              }
              if (val === '' || val === undefined) val = null;
              values.push(coerceValue(val, dbCol));
            }
            for (const extra of extraCols) {
              const resolved = this.resolveTemplate(extra.value, context);
              if (resolved === 'NULL' || resolved === null) {
                values.push(null);
              } else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(resolved)) {
                values.push(new Date(resolved));
              } else {
                values.push(resolved);
              }
            }
            return values;
          });

          try {
            await (conn as any).executeMany(sql, binds, {
              autoCommit: false,
              dmlRowCounts: false,
            });
          } catch (batchErr: any) {
            throw new Error(`Batch ${batchNum}/${totalBatches} (rows ${i + 1}-${i + batch.length}) failed: ${batchErr.message}`);
          }

          totalInserted += batch.length;
          batchesSinceCommit++;

          // Periodic commit to release UNDO and avoid one giant transaction
          if (batchesSinceCommit >= commitEvery) {
            await (conn as any).commit();
            batchesSinceCommit = 0;
            const elapsed = (Date.now() - startTime) / 1000;
            const rowsPerSec = Math.round(totalInserted / elapsed);
            this.log(context, 'info', `  ▸ ${totalInserted.toLocaleString()}/${rows.length.toLocaleString()} rows (${Math.round(totalInserted * 100 / rows.length)}%, ${rowsPerSec.toLocaleString()} rows/s) — committed`);
          }
        }

        // Final commit for any remaining batches
        if (batchesSinceCommit > 0) {
          await (conn as any).commit();
        }
      } catch (err) {
        // Rollback any uncommitted batches before re-throwing
        try { await (conn as any).rollback(); } catch (_) { /* best-effort */ }
        throw err;
      }

      const totalSec = (Date.now() - startTime) / 1000;
      const rowsPerSec = totalSec > 0 ? Math.round(totalInserted / totalSec) : totalInserted;
      this.log(context, 'info', `Bulk insert completed: ${totalInserted.toLocaleString()} rows in ${totalSec.toFixed(1)}s (${rowsPerSec.toLocaleString()} rows/s)`);

      return {
        rows: [],
        rowCount: totalInserted,
        inserted: totalInserted,
        command: 'BULK-INSERT',
        table: data.table,
        batchSize,
        durationSec: totalSec,
      };
    });
  }

  /**
   * Execute operation — supports raw SQL/PL/SQL with named bind parameters.
   * Uses Oracle named bind variables (:paramName) directly for safe parameterized queries.
   * For non-Oracle DBs, named params are resolved inline.
   */
  private async executeExecute(data: DatabaseNodeData, context: ExecutionContext): Promise<any> {
    let sql = data.sql;
    if (!sql) {
      throw new Error('SQL is required for execute operation');
    }

    // Resolve {{}} and ${} templates in SQL (won't affect :paramName Oracle bind vars)
    sql = this.resolveTemplate(sql, context);

    // Resolve named bind parameters from templates
    const bindParams: Record<string, any> = {};
    if (data.params) {
      for (const [key, value] of Object.entries(data.params)) {
        if (typeof value !== 'string') {
          bindParams[key] = value;
          continue;
        }
        const trimmed = value.trim();
        // Check if it's a template like {{vars.risk.riskId}}
        const match = trimmed.match(/^\{\{(.+)\}\}$/);
        if (match) {
          const resolved = this.getStandardValue(context, match[1].trim());
          bindParams[key] = resolved !== undefined ? resolved : null;
        } else if (trimmed.includes('{{')) {
          // Mixed template like "prefix_{{vars.id}}_suffix"
          bindParams[key] = trimmed.replace(/\{\{(.+?)\}\}/g, (_m: string, p: string) => {
            const v = this.getStandardValue(context, p.trim());
            return v !== undefined ? String(v) : '';
          });
        } else {
          // Literal value
          bindParams[key] = value;
        }
      }
    }

    // Detect SQL type
    const isPLSQL = /^\s*(BEGIN|DECLARE)\b/i.test(sql.trim());
    const isNonQuery = /^\s*(INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE)\b/i.test(sql.trim());

    this.log(context, 'debug', 'Database EXECUTE', {
      sqlLength: sql.length,
      connectionId: data.connectionId,
      isPLSQL,
      paramCount: Object.keys(bindParams).length,
      paramKeys: Object.keys(bindParams),
    });

    return this.executeWithConnection(data.connectionId, async (client, isOracle) => {
      if (isOracle) {
        const conn = client as oracledb.Connection;

        if (isPLSQL || isNonQuery) {
          console.log(`[Oracle] Executing ${isPLSQL ? 'PL/SQL' : 'DML'} (${sql.length} chars, ${Object.keys(bindParams).length} bind params)...`);
          const result = await conn.execute(sql, bindParams as any, { autoCommit: true });

          this.log(context, 'debug', 'Database EXECUTE Result', {
            rowsAffected: result.rowsAffected,
            command: isPLSQL ? 'PLSQL' : 'EXECUTE',
          });

          return {
            rows: [],
            rowCount: result.rowsAffected || 0,
            command: isPLSQL ? 'PLSQL' : 'EXECUTE',
          };
        } else {
          // SELECT query with named bind params
          const result = await conn.execute(sql, bindParams as any, {
            outFormat: oracledb.OUT_FORMAT_OBJECT,
          });
          const rows = result.rows || [];

          this.log(context, 'debug', 'Database EXECUTE Result', {
            rowCount: rows.length,
            sample: rows.length > 0 ? rows[0] : null,
          });

          return {
            rows,
            rowCount: rows.length,
            command: 'EXECUTE',
          };
        }
      } else {
        // Non-Oracle: resolve named params inline (replace :paramName with escaped values)
        let resolvedSql = sql;
        for (const [key, value] of Object.entries(bindParams)) {
          resolvedSql = resolvedSql.replace(new RegExp(`:${key}\\b`, 'g'), this.escapeSqlValue(value));
        }

        if (isPLSQL || isNonQuery) {
          const result = await client.$executeRawUnsafe(resolvedSql);
          return { rows: [], rowCount: result, command: 'EXECUTE' };
        } else {
          const result = await client.$queryRawUnsafe(resolvedSql);
          return {
            rows: result,
            rowCount: Array.isArray(result) ? result.length : 1,
            command: 'EXECUTE',
          };
        }
      }
    });
  }

  // Helper to get value from context by dot-notation path supporting vars Map
  private getValueByPath2(context: ExecutionContext, path: string): any {
    const parts = path.split('.');
    let value: any = context;

    for (let i = 0; i < parts.length; i++) {
      if (value === null || value === undefined) return undefined;

      const part = parts[i];
      // Handle array index like "files[0]"
      const arrMatch = part.match(/^(.+)\[(\d+)\]$/);

      if (part === 'vars' || part === 'variables') {
        if (value === context && context.variables instanceof Map) {
          const nextKey = parts[i + 1];
          if (nextKey) {
            const arrM = nextKey.match(/^(.+)\[(\d+)\]$/);
            if (arrM) {
              value = context.variables.get(arrM[1]);
              if (Array.isArray(value)) value = value[parseInt(arrM[2])];
              i++;
            } else {
              value = context.variables.get(nextKey);
              i++;
            }
          }
          continue;
        }
      }

      if (arrMatch) {
        value = value[arrMatch[1]];
        if (Array.isArray(value)) {
          value = value[parseInt(arrMatch[2])];
        } else {
          return undefined;
        }
      } else {
        value = value[part];
      }
    }
    return value;
  }

  protected resolveTemplate(template: string, context: ExecutionContext): string {
    if (typeof template !== 'string') return template;
    
    if (!template.includes('{{') && !template.includes('${')) return template;
    
    // Replace ${...} syntax
    let result = template.replace(/\$\{([^}]+)\}/g, (_match, path) => {
      const value = this.getStandardValue(context, path.trim());
      return value !== undefined ? this.escapeSqlValue(value) : 'NULL';
    });
    
    // Replace {{...}} syntax
    result = result.replace(/\{\{([^}]+)\}\}/g, (match, path) => {
      const value = this.getStandardValue(context, path.trim());
      return value !== undefined ? String(value) : match;
    });
    
    return result;
  }

  private escapeSqlValue(value: any): string {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (value instanceof Date) return `'${value.toISOString()}'`;
    if (typeof value === 'string') {
      // If string looks like a number, return as unquoted number for SQL
      if (/^-?\d+$/.test(value)) {
        return value; // Integer
      }
      if (/^-?\d+\.\d+$/.test(value)) {
        return value; // Decimal
      }
      return "'" + value.replace(/'/g, "''") + "'";
    }
    return this.escapeSqlValue(String(value));
  }

  // Cleanup method for Oracle pools
  static async cleanup(): Promise<void> {
    for (const [id, pool] of oraclePools.entries()) {
      try {
        await pool.close(10);
        console.log(`Closed Oracle pool for connection: ${id}`);
      } catch (error) {
        console.error(`Error closing Oracle pool ${id}:`, error);
      }
    }
    oraclePools.clear();
    connectionClients.clear();
  }
}

/** BigInt → number when it fits exactly, else a decimal string; walks arrays and plain objects. */
export function toJsonSafe(value: any): any {
  if (typeof value === 'bigint') {
    return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) out[k] = toJsonSafe(v);
    return out;
  }
  return value;
}
