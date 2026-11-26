package main

// Oracle side of the database executor (oracledb thin mode in TS, go-ora
// here). Pools are cached per connection id with at most 5 connections; each
// call is bounded by ORACLE_CALL_TIMEOUT_MS (default 600000, 0 = off).

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	go_ora "github.com/sijms/go-ora/v2"
	"github.com/sijms/go-ora/v2/network"
)

var (
	dbOraMu    sync.Mutex
	dbOraPools = map[string]*sql.DB{}

	dbOraCallTimeout = func() time.Duration {
		v := os.Getenv("ORACLE_CALL_TIMEOUT_MS")
		if v == "" {
			v = "600000"
		}
		n, _ := strconv.Atoi(strings.TrimSpace(v))
		return time.Duration(n) * time.Millisecond
	}()
)

// dbOraQ is a *sql.Conn or a *sql.Tx.
type dbOraQ interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

func dbOraPool(connID string, cfg map[string]any) *sql.DB {
	dbOraMu.Lock()
	defer dbOraMu.Unlock()
	if p, ok := dbOraPools[connID]; ok {
		return p
	}
	service := ""
	if o, ok := cfg["options"].(map[string]any); ok && truthy(o["serviceName"]) {
		service = jsString(o["serviceName"])
	} else if truthy(cfg["serviceName"]) {
		service = jsString(cfg["serviceName"])
	} else {
		service = jsString(cfg["database"])
	}
	port := 1521
	if p, ok := num(cfg, "port"); ok && p != 0 {
		port = int(p)
	}
	url := go_ora.BuildUrl(jsString(cfg["host"]), port, service, jsString(cfg["username"]), jsString(cfg["password"]), nil)
	db, _ := sql.Open("oracle", url) // sql.Open never dials
	db.SetMaxOpenConns(5)
	db.SetMaxIdleConns(5)
	db.SetConnMaxIdleTime(60 * time.Second)
	dbOraPools[connID] = db
	return db
}

// dbOraConn is pool.getConnection with the TS retry: on failure the pool is
// closed, dropped from the cache and a fresh one is tried once.
func dbOraConn(connID string, cfg map[string]any) (*sql.Conn, error) {
	ctx, cancel := dbOraCtx()
	defer cancel()
	c, err := dbOraPool(connID, cfg).Conn(ctx)
	if err == nil {
		err = c.PingContext(ctx)
		if err != nil {
			_ = c.Close()
		}
	}
	if err == nil {
		return c, nil
	}
	dbOraMu.Lock()
	if p, ok := dbOraPools[connID]; ok {
		_ = p.Close()
		delete(dbOraPools, connID)
	}
	dbOraMu.Unlock()
	ctx2, cancel2 := dbOraCtx()
	defer cancel2()
	c, err = dbOraPool(connID, cfg).Conn(ctx2)
	if err == nil {
		if err = c.PingContext(ctx2); err != nil {
			_ = c.Close()
			return nil, err
		}
	}
	return c, err
}

func dbOraCtx() (context.Context, context.CancelFunc) {
	if dbOraCallTimeout > 0 {
		return context.WithTimeout(context.Background(), dbOraCallTimeout)
	}
	return context.WithCancel(context.Background())
}

var (
	dbTrailingSemi = regexp.MustCompile(`;+$`)
	dbDollarParam  = regexp.MustCompile(`\$(\d+)`)
	dbQMark        = regexp.MustCompile(`\?`)
)

// dbOraRewrite ports the placeholder handling shared by executeOracleQuery
// and executeOracleNonQuery: trailing semicolons stripped, $N → :k (binding
// params[N-1] when it exists), and — only when nothing was bound that way —
// every ? → :k binding params in order.
func dbOraRewrite(sqlText string, params []any) (string, []any) {
	s := dbTrailingSemi.ReplaceAllString(strings.TrimSpace(sqlText), "")
	var binds []any
	idx := 1
	s = dbDollarParam.ReplaceAllStringFunc(s, func(m string) string {
		n, _ := strconv.Atoi(m[1:])
		if n-1 >= 0 && n-1 < len(params) {
			binds = append(binds, params[n-1])
		}
		r := ":" + strconv.Itoa(idx)
		idx++
		return r
	})
	if len(binds) == 0 && len(params) > 0 {
		q := 0
		s = dbQMark.ReplaceAllStringFunc(s, func(string) string {
			var v any
			if q < len(params) {
				v = params[q]
			}
			q++
			binds = append(binds, v)
			r := ":" + strconv.Itoa(idx)
			idx++
			return r
		})
	}
	// SQL built with :1, :2 … placeholders (insert / update / delete) takes
	// the params as they are.
	if idx == 1 && len(params) > 0 && dbOraPositional.MatchString(s) {
		binds = append(binds, params...)
	}
	return s, binds
}

var dbOraPositional = regexp.MustCompile(`:\d+`)

// dbOraBind converts a JS value for go-ora. Dates are bound as local
// wall-clock time, as oracledb does.
func dbOraBind(v any) any {
	switch t := v.(type) {
	case time.Time:
		return t.Local()
	case int:
		return int64(t)
	case map[string]any:
		// oracledb bind definition { val, dir, type }: only the value is used
		if x, ok := t["val"]; ok {
			return dbOraBind(x)
		}
		return dbJSONString(t)
	case []any:
		return dbJSONString(t)
	}
	return v
}

func dbOraBinds(vals []any) []any {
	out := make([]any, len(vals))
	for i, v := range vals {
		out[i] = dbOraBind(v)
	}
	return out
}

// dbOraNamed turns {name: value} into named binds, in key order.
func dbOraNamed(keys []string, vals map[string]any) []any {
	out := make([]any, 0, len(keys))
	for _, k := range keys {
		out = append(out, sql.Named(k, dbOraBind(vals[k])))
	}
	return out
}

// dbOraRows runs a query and returns rows as objects keyed by column name
// (OUT_FORMAT_OBJECT). lobs=true applies executeOracleQuery's LOB handling:
// CLOB / BLOB / RAW values become strings, JSON-looking ones are parsed.
func dbOraRows(q dbOraQ, sqlText string, args []any, lobs bool) ([]any, error) {
	ctx, cancel := dbOraCtx()
	defer cancel()
	rows, err := q.QueryContext(ctx, sqlText, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	cols, _ := rows.Columns()
	types, _ := rows.ColumnTypes()
	out := []any{}
	for rows.Next() {
		vals := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			return nil, err
		}
		row := make(map[string]any, len(cols))
		for i, c := range cols {
			tn := ""
			if i < len(types) {
				tn = strings.ToUpper(types[i].DatabaseTypeName())
			}
			row[c] = dbOraValue(vals[i], tn, lobs)
		}
		jsOrder(row, cols)
		out = append(out, row)
	}
	return out, rows.Err()
}

func dbOraValue(v any, typeName string, lobs bool) any {
	var lobStr *string
	switch t := v.(type) {
	case nil:
		return nil
	case go_ora.Clob:
		if !t.Valid {
			return nil
		}
		s := t.String
		lobStr = &s
	case go_ora.NClob:
		if !t.Valid {
			return nil
		}
		s := t.String
		lobStr = &s
	case go_ora.Blob:
		if t.Data == nil {
			return nil
		}
		s := string(t.Data)
		lobStr = &s
	case []byte:
		s := string(t)
		lobStr = &s
	case string:
		if strings.Contains(typeName, "LOB") {
			lobStr = &t
		} else if typeName == "NUMBER" || typeName == "FLOAT" || typeName == "BINARY_FLOAT" || typeName == "BINARY_DOUBLE" || typeName == "INTEGER" {
			if f, err := strconv.ParseFloat(strings.TrimSpace(t), 64); err == nil {
				return f
			}
			return t
		} else {
			return t
		}
	case int64:
		return float64(t)
	case float32:
		return float64(t)
	case float64:
		return t
	case time.Time:
		// A JS Date (ms precision), as the Postgres side returns.
		if strings.Contains(typeName, "TIME ZONE") || strings.Contains(typeName, "TZ") {
			return t.UTC().Truncate(time.Millisecond)
		}
		// DATE / TIMESTAMP carry no zone: oracledb reads the wall clock as
		// local time of the process.
		return time.Date(t.Year(), t.Month(), t.Day(), t.Hour(), t.Minute(), t.Second(), t.Nanosecond(), time.Local).UTC().Truncate(time.Millisecond)
	default:
		return fmt.Sprint(t)
	}
	if !lobs {
		if _, isBytes := v.([]byte); isBytes {
			// Buffer → {"type":"Buffer","data":[…]}
			b := v.([]byte)
			data := make([]any, len(b))
			for i, x := range b {
				data[i] = float64(x)
			}
			return om("type", "Buffer", "data", data)
		}
		return *lobStr
	}
	s := *lobStr
	tr := strings.TrimLeft(s, " \t\n\r\v\f\u00a0\ufeff\u2028\u2029")
	if strings.HasPrefix(tr, "[") || strings.HasPrefix(tr, "{") {
		var parsed any
		if err := json.Unmarshal([]byte(s), &parsed); err == nil {
			return parsed
		}
	}
	return s
}

// dbOraQuery ports executeOracleQuery.
func dbOraQuery(q dbOraQ, sqlText string, params []any) (any, error) {
	s, binds := dbOraRewrite(sqlText, params)
	rows, err := dbOraRows(q, s, dbOraBinds(binds), true)
	if err != nil {
		return nil, err
	}
	if len(rows) == 1 {
		m := rows[0].(map[string]any)
		if len(m) == 1 {
			for _, v := range m {
				if arr, ok := v.([]any); ok {
					return arr, nil
				}
			}
		}
	}
	return rows, nil
}

// dbOraNonQuery ports executeOracleNonQuery (autoCommit: true).
func dbOraNonQuery(q dbOraQ, sqlText string, params []any) (float64, error) {
	s, binds := dbOraRewrite(sqlText, params)
	return dbOraExec(q, s, dbOraBinds(binds))
}

func dbOraExec(q dbOraQ, sqlText string, args []any) (float64, error) {
	ctx, cancel := dbOraCtx()
	defer cancel()
	res, err := q.ExecContext(ctx, sqlText, args...)
	if err != nil {
		return 0, err
	}
	if dbOraPLSQL.MatchString(sqlText) {
		return 0, nil // oracledb leaves rowsAffected undefined for PL/SQL blocks
	}
	n, _ := res.RowsAffected()
	return float64(n), nil
}

var dbOraPLSQL = regexp.MustCompile(`(?i)^\s*(BEGIN|DECLARE)\b`)

// dbOraErrText formats an Oracle error as node-oracledb does: the server
// message followed by a Help link, without go-ora's "error occur at
// position" suffix.
func dbOraErrText(err error) string {
	var oe *network.OracleError
	if !errors.As(err, &oe) {
		return err.Error()
	}
	raw := oe.Error()
	if oe.ErrMsg == "" {
		return err.Error()
	}
	msg := strings.TrimRight(oe.ErrMsg, "\n") + fmt.Sprintf("\nHelp: https://docs.oracle.com/error-help/db/ora-%05d/", oe.ErrCode)
	return strings.Replace(err.Error(), raw, msg, 1)
}

// dbOraReadOnly runs fn in a transaction that is rolled back afterwards:
// oracledb runs these statements without autoCommit and releasing the
// connection rolls back whatever they changed.
func dbOraReadOnly(conn *sql.Conn, fn func(q dbOraQ) (any, error)) (any, error) {
	tx, err := conn.BeginTx(context.Background(), nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	return fn(tx)
}

// dbOraCode returns the "ORA-NNNNN" code of an Oracle error.
func dbOraCode(err error) string {
	var oe *network.OracleError
	if errors.As(err, &oe) {
		return fmt.Sprintf("ORA-%05d", oe.ErrCode)
	}
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		var op *net.OpError
		if errors.As(err, &op) && op.Op == "dial" {
			return "NJS-510"
		}
	}
	return ""
}
