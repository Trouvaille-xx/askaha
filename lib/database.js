/**
 * 统一数据库访问层
 * 支持: mysql, postgresql, sqlite, mssql
 */

const mysql = require('mysql2/promise');
const { Pool } = require('pg');
const sql = require('mssql');
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

class Database {
  constructor(config) {
    this.config = config;
    this.type = config.type;
    this.pool = null;
    this.conn = null;
    this.db = null; // sqlite (sql.js)
    this._sqlJs = null;
  }

  async _connect() {
    if (this.type === 'mysql') {
      this.pool = await mysql.createConnection({
        host: this.config.host,
        port: this.config.port || 3306,
        user: this.config.user,
        password: this.config.password,
        database: this.config.database,
        connectTimeout: 10000
      });
    } else if (this.type === 'postgres') {
      this.pool = new Pool({
        host: this.config.host,
        port: this.config.port || 5432,
        user: this.config.user,
        password: this.config.password,
        database: this.config.database,
        connectionTimeoutMillis: 10000
      });
      this.conn = await this.pool.connect();
    } else if (this.type === 'sqlite') {
      this._sqlJs = await initSqlJs();
      if (this.config.database && fs.existsSync(this.config.database)) {
        const buf = fs.readFileSync(this.config.database);
        this.db = new this._sqlJs.Database(buf);
      } else {
        this.db = new this._sqlJs.Database();
      }
    } else if (this.type === 'mssql') {
      this.pool = await sql.connect({
        server: this.config.host,
        port: this.config.port || 1433,
        user: this.config.user,
        password: this.config.password,
        database: this.config.database,
        options: { encrypt: false, trustServerCertificate: true },
        connectionTimeout: 10000,
        requestTimeout: 15000
      });
    } else {
      throw new Error('不支持的数据库类型: ' + this.type);
    }
  }

  async test() {
    await this._connect();
    const result = { type: this.type, version: '', database: this.config.database };
    if (this.type === 'mysql') {
      const [rows] = await this.pool.query('SELECT VERSION() AS v');
      result.version = rows[0].v;
    } else if (this.type === 'postgres') {
      const r = await this.conn.query('SELECT version()');
      result.version = r.rows[0].version;
    } else if (this.type === 'sqlite') {
      const r = this.db.exec('SELECT sqlite_version() AS v');
      result.version = r[0]?.values?.[0]?.[0] || '';
    } else if (this.type === 'mssql') {
      const r = await this.pool.request().query('SELECT @@VERSION AS v');
      result.version = r.recordset[0].v;
    }
    return result;
  }

  async listTables() {
    await this._connect();
    let sqlText, params = [];
    if (this.type === 'mysql') {
      sqlText = 'SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME';
      params = [this.config.database];
      const [rows] = await this.pool.query(sqlText, params);
      return rows.map((r) => r.name);
    } else if (this.type === 'postgres') {
      sqlText = `SELECT table_name AS name FROM information_schema.tables 
                 WHERE table_schema = 'public' ORDER BY table_name`;
      const r = await this.conn.query(sqlText);
      return r.rows.map((row) => row.name);
    } else if (this.type === 'sqlite') {
      const r = this.db.exec(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      );
      if (!r.length) return [];
      const cols = r[0].columns;
      const idx = cols.indexOf('name');
      return r[0].values.map((row) => row[idx]);
    } else if (this.type === 'mssql') {
      const r = await this.pool
        .request()
        .query(
          "SELECT TABLE_NAME AS name FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME"
        );
      return r.recordset.map((row) => row.name);
    }
    return [];
  }

  async describeTable(table) {
    await this._connect();
    if (this.type === 'mysql') {
      const [rows] = await this.pool.query('DESCRIBE ??', [table]);
      return rows.map((r) => ({ field: r.Field, type: r.Type, null: r.Null, key: r.Key, default: r.Default }));
    } else if (this.type === 'postgres') {
      const r = await this.conn.query(
        `SELECT column_name AS field, data_type AS type, is_nullable AS nullable, column_default AS default
         FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position`,
        [table]
      );
      return r.rows.map((row) => ({
        field: row.field,
        type: row.type,
        nullable: row.nullable,
        default: row.default
      }));
    } else if (this.type === 'sqlite') {
      const r = this.db.exec(`PRAGMA table_info("${String(table).replace(/"/g, '""')}")`);
      if (!r.length) return [];
      const rows = r[0].values.map(([cid, name, type, notnull, dflt, pk]) => ({
        field: name,
        type,
        notnull: !!notnull,
        default: dflt,
        pk: !!pk
      }));
      return rows;
    } else if (this.type === 'mssql') {
      const r = await this.pool
        .request()
        .input('t', sql.NVarChar, table)
        .query(
          "SELECT COLUMN_NAME AS field, DATA_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS def FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = @t ORDER BY ORDINAL_POSITION"
        );
      return r.recordset.map((row) => ({ field: row.field, type: row.type, nullable: row.nullable, default: row.def }));
    }
    return [];
  }

  /**
   * 执行 SQL（只允许 SELECT，避免误操作）
   * 返回: { columns, rows, rowCount, elapsedMs }
   */
  async query(sqlText) {
    const t0 = Date.now();
    await this._connect();
    const trimmed = (sqlText || '').trim();
    if (!trimmed) throw new Error('SQL 为空');
    if (!/^\s*(select|with|pragma|explain)\b/i.test(trimmed)) {
      throw new Error('MVP 版本只允许执行 SELECT/WITH/PRAGMA/EXPLAIN 语句');
    }
    if (this.type === 'mysql') {
      const [rows] = await this.pool.query(trimmed);
      const elapsedMs = Date.now() - t0;
      const columns = rows.length ? Object.keys(rows[0]) : [];
      return { columns, rows, rowCount: rows.length, elapsedMs };
    } else if (this.type === 'postgres') {
      const r = await this.conn.query(trimmed);
      const elapsedMs = Date.now() - t0;
      const columns = r.fields ? r.fields.map((f) => f.name) : [];
      return { columns, rows: r.rows, rowCount: r.rowCount || r.rows.length, elapsedMs };
    } else if (this.type === 'sqlite') {
      const r = this.db.exec(trimmed);
      const elapsedMs = Date.now() - t0;
      if (!r.length) {
        return { columns: [], rows: [], rowCount: 0, elapsedMs };
      }
      const { columns, values } = r[0];
      const rows = values.map((arr) => {
        const obj = {};
        for (let i = 0; i < columns.length; i++) obj[columns[i]] = arr[i];
        return obj;
      });
      return { columns, rows, rowCount: rows.length, elapsedMs };
    } else if (this.type === 'mssql') {
      const r = await this.pool.request().query(trimmed);
      const elapsedMs = Date.now() - t0;
      const rows = r.recordset || [];
      const columns = rows.length ? Object.keys(rows[0]) : [];
      return { columns, rows, rowCount: rows.length, elapsedMs };
    }
    throw new Error('不支持的数据库类型');
  }

  async close() {
    try {
      if (this.type === 'mysql' && this.pool) await this.pool.end();
      if (this.type === 'postgres') {
        if (this.conn) this.conn.release();
        if (this.pool) await this.pool.end();
      }
      if (this.type === 'sqlite' && this.db) {
        try { this.db.close(); } catch (e) {}
      }
      if (this.type === 'mssql' && this.pool) await this.pool.close();
    } catch (e) {
      // ignore
    }
  }
}

function quoteIdent(name, type) {
  if (type === 'sqlite') return '"' + String(name).replace(/"/g, '""') + '"';
  return '"' + String(name).replace(/"/g, '""') + '"';
}

module.exports = Database;
