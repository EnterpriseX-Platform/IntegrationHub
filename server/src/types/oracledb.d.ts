declare module 'oracledb' {
  export interface Connection {
    /** Max ms per round-trip to the DB; 0 disables. Guards against lock waits. */
    callTimeout?: number;
    execute(sql: string, binds?: any[], options?: any): Promise<any>;
    close(): Promise<void>;
  }

  export interface Pool {
    getConnection(): Promise<Connection>;
    close(timeout?: number): Promise<void>;
  }

  export interface PoolAttributes {
    user?: string;
    password?: string;
    connectString?: string;
    poolMin?: number;
    poolMax?: number;
    poolIncrement?: number;
    [key: string]: any;
  }

  export const OUT_FORMAT_OBJECT: number;
  export const OUT_FORMAT_ARRAY: number;

  export function createPool(attributes: PoolAttributes): Promise<Pool>;
  export function getConnection(attributes: PoolAttributes): Promise<Connection>;
}
