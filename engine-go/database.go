package main

// Port of server/src/sdk/execution/executors/DatabaseExecutor.ts: operations
// select/query, code, insert, update, delete, bulk-insert, execute on
// PostgreSQL (TS: Prisma raw queries) and Oracle (TS: oracledb thin).

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/dop251/goja"
	"github.com/jackc/pgx/v5"
)

func init() { nativeExecutors["database"] = execDatabase }

// dbError is an error whose message is final (already worded like TS).
type dbError struct{ msg string }

func (e *dbError) Error() string { return e.msg }

// dbClient is what executeWithConnection hands to an operation.
type dbClient struct {
	isOracle bool
	ora      *sql.Conn
	pg       *dbPg
}

func execDatabase(r *Run, node *Node, ctx *Ctx) (any, error) {
	d := node.Data
	connID := jsString(d["connectionId"])
	if !truthy(d["connectionId"]) {
		return nil, errors.New("Database connection ID is required")
	}
	op := "select"
	if truthy(d["operation"]) {
		op = jsString(d["operation"])
	}
	e := &dbExec{r: r, node: node, ctx: ctx, d: d, connID: connID}
	switch op {
	case "select", "query":
		return e.selectOp()
	case "code":
		return e.codeOp()
	case "insert":
		return e.insertOp()
	case "update":
		return e.updateOp()
	case "delete":
		return e.deleteOp()
	case "bulk-insert":
		return e.bulkInsert()
	case "execute":
		return e.executeOp()
	}
	return nil, fmt.Errorf("Unknown operation: %s", op)
}

type dbExec struct {
	r      *Run
	node   *Node
	ctx    *Ctx
	d      map[string]any
	connID string
}

func (e *dbExec) log(level, msg string, data any) {
	if data != nil {
		data = dbDeepCopyJSON(data)
	}
	e.r.log(level, e.node.ID, msg, data)
}

func (e *dbExec) table() string { return jsString(e.d["table"]) }

// withConnection ports executeWithConnection, including its error mapping.
func (e *dbExec) withConnection(fn func(c *dbClient) (any, error)) (any, error) {
	conn, err := e.r.fallback.connection(e.connID)
	if err != nil {
		return nil, err
	}
	status := jsString(conn["status"])
	if status != "Active" && status != "Connected" {
		return nil, fmt.Errorf("Connection is not active: %s (status: %s)", jsString(conn["name"]), jsString(conn["status"]))
	}
	var cfg map[string]any
	switch c := conn["config"].(type) {
	case map[string]any:
		cfg = c
	case string:
		if err := json.Unmarshal([]byte(c), &cfg); err != nil {
			return nil, fmt.Errorf("%s is not valid JSON", strconv.Quote(c))
		}
	default:
		cfg = map[string]any{}
	}
	isOracle := jsString(cfg["type"]) == "oracle"
	out, err := func() (any, error) {
		if isOracle {
			oc, err := dbOraConn(e.connID, cfg)
			if err != nil {
				return nil, err
			}
			defer oc.Close()
			return fn(&dbClient{isOracle: true, ora: oc})
		}
		return fn(&dbClient{pg: dbPgClient(e.connID, cfg)})
	}()
	if err != nil {
		return nil, dbMapError(err)
	}
	return out, nil
}

var dbConnRe = regexp.MustCompile(`(?i)ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENOTFOUND|Can't reach database server|connection (refused|terminated|timed out)`)

func dbMapError(err error) error {
	code := dbOraCode(err)
	msg := err.Error()
	switch code {
	case "ORA-12154", "ORA-12541", "ORA-12543", "NJS-510":
		return fmt.Errorf("Cannot connect to Oracle database: %s", msg)
	case "ORA-01017":
		return errors.New("Oracle authentication failed. Please check username and password.")
	case "ORA-00942":
		return errors.New("Table or view does not exist.")
	case "ORA-01722":
		return errors.New("Invalid number format in query.")
	}
	// Prisma raw-query errors carry code P2010 (never 42P01/28P01/3D000), so
	// only the message tests apply on PostgreSQL.
	if strings.Contains(msg, "relation") && strings.Contains(msg, "does not exist") {
		return errors.New("Table not found. Please check if the table exists.")
	}
	if dbConnRe.MatchString(msg) {
		return fmt.Errorf("Cannot connect to database server (%s). Please check if database is running.", msg)
	}
	return fmt.Errorf("Database query failed: %s", msg)
}

func dbRowCount(v any) float64 {
	if arr, ok := v.([]any); ok {
		return float64(len(arr))
	}
	return 1
}

// ── select / query ───────────────────────────────────────────────────────────

func (e *dbExec) selectOp() (any, error) {
	sqlText := "SELECT 1"
	if truthy(e.d["sql"]) {
		sqlText = jsString(e.d["sql"])
	}
	sqlText = dbResolveStr(e.ctx, sqlText)
	ld := om("sql", sqlText, "connectionId", e.d["connectionId"])
	if p, ok := asMap(e.ctx.Input)["params"]; ok {
		jsSet(ld, "inputParams", p)
	}
	e.log("debug", "Database SELECT", ld)
	return e.withConnection(func(c *dbClient) (any, error) {
		var result any
		var err error
		if c.isOracle {
			result, err = dbOraReadOnly(c.ora, func(q dbOraQ) (any, error) { return dbOraQuery(q, sqlText, nil) })
		} else {
			result, err = dbPgQuery(c.pg, c.pg.pool, sqlText)
		}
		if err != nil {
			return nil, err
		}
		sample := result
		if arr, ok := result.([]any); ok && len(arr) > 0 {
			sample = arr[0]
		}
		e.log("debug", "Database SELECT Result", om("rowCount", dbRowCount(result), "sample", sample))
		return om("rows", result, "rowCount", dbRowCount(result), "command", "SELECT"), nil
	})
}

// ── code ─────────────────────────────────────────────────────────────────────

var dbPLSQL = regexp.MustCompile(`(?i)^\s*(BEGIN|DECLARE)\b`)

func (e *dbExec) codeOp() (any, error) {
	code := jsString(e.d["code"])
	if !truthy(e.d["code"]) {
		return nil, errors.New("Code is required for code operation")
	}
	in := asMap(e.ctx.Input)
	input := any(map[string]any{})
	if truthy(in["body"]) {
		input = in["body"]
	} else if truthy(e.ctx.Input) {
		input = e.ctx.Input
	}
	vm := newVM(e.r, e.ctx)
	fn, err := vm.RunString("(function(input, vars, context) {\n" + code + "\n})")
	if err != nil {
		return nil, fmt.Errorf("Code execution error: %s", jsErr(err))
	}
	call, _ := goja.AssertFunction(fn)
	ret, err := call(goja.Undefined(), jsIn(vm, input), jsIn(vm, varsObject(e.ctx)), contextObject(vm, e.r, e.ctx))
	if err != nil {
		if needsNode(err) {
			return nil, errUseFallback
		}
		return nil, fmt.Errorf("Code execution error: %s", jsErr(err))
	}

	isObj := false
	var obj *goja.Object
	sqlText := ""
	if s, ok := ret.Export().(string); ok {
		sqlText = s
	} else if o, ok := ret.(*goja.Object); ok && !goja.IsNull(ret) {
		isObj, obj = true, o
		if sv := o.Get("sql"); sv != nil {
			if s, ok := sv.Export().(string); ok {
				sqlText = s
			}
		}
	}
	if sqlText == "" {
		return nil, errors.New("Code must return a SQL string or an object with .sql property")
	}

	// params: an object (named binds) or an array (positional)
	var named map[string]any
	var namedKeys []string
	var positional []any
	hasParams, isArray := false, false
	if isObj {
		if pv := obj.Get("params"); pv != nil && !goja.IsUndefined(pv) && !goja.IsNull(pv) {
			if po, ok := pv.(*goja.Object); ok {
				hasParams = true
				if po.ClassName() == "Array" {
					isArray = true
					positional, _ = jsOut(po).([]any)
					if positional == nil {
						positional = []any{}
					}
				} else {
					named = map[string]any{}
					for _, k := range po.Keys() {
						namedKeys = append(namedKeys, k)
						named[k] = dbExportJS(po.Get(k))
					}
				}
			} else if truthy(jsOut(pv)) {
				hasParams = true // a primitive: TS ignores it after this point
			}
		}
	}
	var summary any
	hasSummary := false
	if isObj {
		if sv := obj.Get("summary"); sv != nil && !goja.IsUndefined(sv) {
			summary, hasSummary = jsOut(sv), true
		}
	}
	resultType := "object"
	if !isObj {
		resultType = "string"
	}
	e.log("debug", "Database CODE", om(
		"sqlLength", float64(len(dbUTF16(sqlText))), "connectionId", e.d["connectionId"],
		"resultType", resultType, "hasParams", hasParams,
	))
	isPLSQL := dbPLSQL.MatchString(strings.TrimSpace(sqlText))

	withSummary := func(m map[string]any) map[string]any {
		if isObj && hasSummary {
			jsSet(m, "summary", summary)
		}
		return m
	}
	return e.withConnection(func(c *dbClient) (any, error) {
		if c.isOracle {
			var rows any = []any{}
			rowCount := 0.0
			var err error
			if isPLSQL {
				if named != nil {
					rowCount, err = dbOraExec(c.ora, sqlText, dbOraNamed(namedKeys, named))
				} else if isArray {
					rowCount, err = dbOraNonQuery(c.ora, sqlText, positional)
				} else {
					rowCount, err = dbOraNonQuery(c.ora, sqlText, nil)
				}
				if err != nil {
					return nil, err
				}
			} else {
				rows, err = dbOraReadOnly(c.ora, func(q dbOraQ) (any, error) {
					if named != nil {
						return dbOraRows(q, sqlText, dbOraNamed(namedKeys, named), false)
					}
					return dbOraQuery(q, sqlText, positional)
				})
				if err != nil {
					return nil, err
				}
				if arr, ok := rows.([]any); ok {
					rowCount = float64(len(arr))
				}
			}
			command := "CODE"
			if isPLSQL {
				command = "PLSQL"
			}
			return withSummary(om("rows", rows, "rowCount", rowCount, "command", command)), nil
		}
		resolved := sqlText
		if named != nil {
			for _, k := range namedKeys {
				re, err := regexp.Compile(":" + k + `\b`)
				if err != nil {
					continue
				}
				resolved = dbJSReplace(re, resolved, dbEscape(named[k]))
			}
		}
		result, err := dbPgQuery(c.pg, c.pg.pool, resolved, positional...)
		if err != nil {
			return nil, err
		}
		return withSummary(om("rows", result, "rowCount", dbRowCount(result), "command", "CODE")), nil
	})
}

// dbExportJS exports a goja value keeping Dates as time.Time.
func dbExportJS(v goja.Value) any {
	if v == nil || goja.IsUndefined(v) || goja.IsNull(v) {
		return nil
	}
	if t, ok := v.Export().(time.Time); ok {
		return t
	}
	return jsOut(v)
}

// dbUTF16 returns s as UTF-16 code units (len() of it is JS .length).
func dbUTF16(s string) []struct{} {
	n := 0
	for _, r := range s {
		if r > 0xFFFF {
			n += 2
		} else {
			n++
		}
	}
	return make([]struct{}, n)
}

// ── insert / update / delete ─────────────────────────────────────────────────

type dbMapping struct {
	Column string
	Value  any
}

func (e *dbExec) mappings() ([]dbMapping, []any) {
	raw, _ := e.d["columnMapping"].([]any)
	var out []dbMapping
	for _, m := range raw {
		mm := asMap(m)
		out = append(out, dbMapping{Column: jsString(mm["column"]), Value: mm["value"]})
	}
	return out, raw
}

func (e *dbExec) resolveValue(v any) any {
	r := dbResolve(e.ctx, v)
	if s, ok := r.(string); ok && s == "NULL" {
		return nil
	}
	return r
}

func (e *dbExec) insertOp() (any, error) {
	if !truthy(e.d["table"]) {
		return nil, errors.New("Table name is required for INSERT")
	}
	maps, rawMaps := e.mappings()
	if len(maps) == 0 {
		return nil, errors.New("Column mapping is required for INSERT")
	}
	table := e.table()
	return e.withConnection(func(c *dbClient) (any, error) {
		cols := make([]string, len(maps))
		vals := make([]any, len(maps))
		for i, m := range maps {
			cols[i] = m.Column
			vals[i] = e.resolveValue(m.Value)
		}
		var sqlText string
		if c.isOracle {
			ph := make([]string, len(vals))
			for i := range vals {
				ph[i] = ":" + strconv.Itoa(i+1)
			}
			sqlText = fmt.Sprintf("INSERT INTO %s (%s) VALUES (%s)", table, strings.Join(cols, ", "), strings.Join(ph, ", "))
		} else {
			types := dbPgColumnTypes(c.pg, c.pg.pool, table)
			ph := make([]string, len(vals))
			for i := range vals {
				ph[i] = dbCast(i+1, cols[i], types)
			}
			sqlText = fmt.Sprintf(`INSERT INTO "%s" (%s) VALUES (%s) RETURNING *`, table, strings.Join(cols, ", "), strings.Join(ph, ", "))
		}
		e.log("debug", "Database INSERT", om("table", e.d["table"], "sql", sqlText, "parameters", vals, "columnMapping", rawMaps))
		var result []any
		if c.isOracle {
			n, err := dbOraNonQuery(c.ora, sqlText, vals)
			if err != nil {
				return nil, err
			}
			result = []any{map[string]any{"rowsAffected": n}}
		} else {
			rows, err := dbPgQuery(c.pg, c.pg.pool, sqlText, vals...)
			if err != nil {
				return nil, err
			}
			result = rows
		}
		e.log("debug", "Database INSERT Result", om("rowCount", float64(len(result)), "rows", result))
		return om("rows", result, "rowCount", float64(len(result)), "command", "INSERT"), nil
	})
}

func (e *dbExec) updateOp() (any, error) {
	if !truthy(e.d["table"]) {
		return nil, errors.New("Table name is required for UPDATE")
	}
	maps, _ := e.mappings()
	if len(maps) == 0 {
		return nil, errors.New("Column mapping is required for UPDATE")
	}
	table := e.table()
	return e.withConnection(func(c *dbClient) (any, error) {
		var types map[string]string
		if !c.isOracle {
			types = dbPgColumnTypes(c.pg, c.pg.pool, table)
		}
		sets := make([]string, len(maps))
		vals := make([]any, len(maps))
		for i, m := range maps {
			if c.isOracle {
				sets[i] = fmt.Sprintf("%s = :%d", m.Column, i+1)
			} else {
				sets[i] = m.Column + " = " + dbCast(i+1, m.Column, types)
			}
			vals[i] = e.resolveValue(m.Value)
		}
		var sqlText string
		if c.isOracle {
			sqlText = fmt.Sprintf("UPDATE %s SET %s", table, strings.Join(sets, ", "))
		} else {
			sqlText = fmt.Sprintf(`UPDATE "%s" SET %s`, table, strings.Join(sets, ", "))
		}
		if truthy(e.d["whereClause"]) {
			sqlText += " WHERE " + jsString(dbResolve(e.ctx, e.d["whereClause"]))
		}
		ld := om("table", e.d["table"], "sql", sqlText, "parameters", vals)
		if w, ok := e.d["whereClause"]; ok {
			jsSet(ld, "whereClause", w)
		}
		e.log("debug", "Database UPDATE", ld)
		var n float64
		var err error
		if c.isOracle {
			n, err = dbOraNonQuery(c.ora, sqlText, vals)
		} else {
			n, err = dbPgExec(c.pg, c.pg.pool, sqlText, vals...)
		}
		if err != nil {
			return nil, err
		}
		e.log("debug", "Database UPDATE Result", map[string]any{"rowCount": n})
		return om("rows", []any{}, "rowCount", n, "command", "UPDATE"), nil
	})
}

func (e *dbExec) deleteOp() (any, error) {
	if !truthy(e.d["table"]) {
		return nil, errors.New("Table name is required for DELETE")
	}
	table := e.table()
	return e.withConnection(func(c *dbClient) (any, error) {
		sqlText := `DELETE FROM "` + table + `"`
		if c.isOracle {
			sqlText = "DELETE FROM " + table
		}
		if truthy(e.d["whereClause"]) {
			sqlText += " WHERE " + jsString(dbResolve(e.ctx, e.d["whereClause"]))
		}
		ld := om("table", e.d["table"], "sql", sqlText)
		if w, ok := e.d["whereClause"]; ok {
			jsSet(ld, "whereClause", w)
		}
		e.log("debug", "Database DELETE", ld)
		var n float64
		var err error
		if c.isOracle {
			n, err = dbOraNonQuery(c.ora, sqlText, nil)
		} else {
			n, err = dbPgExec(c.pg, c.pg.pool, sqlText)
		}
		if err != nil {
			return nil, err
		}
		e.log("debug", "Database DELETE Result", map[string]any{"rowCount": n})
		return om("rows", []any{}, "rowCount", n, "command", "DELETE"), nil
	})
}

// ── execute ──────────────────────────────────────────────────────────────────

var (
	dbWholeTpl = regexp.MustCompile(`^\{\{(.+)\}\}$`)
	dbLazyTpl  = regexp.MustCompile(`\{\{(.+?)\}\}`)
	dbNonQuery = regexp.MustCompile(`(?i)^\s*(INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE)\b`)
)

func (e *dbExec) executeOp() (any, error) {
	if !truthy(e.d["sql"]) {
		return nil, errors.New("SQL is required for execute operation")
	}
	sqlText := dbResolveStr(e.ctx, jsString(e.d["sql"]))

	bind := map[string]any{}
	var keys []string
	if p, ok := e.d["params"].(map[string]any); ok {
		order := e.node.keyOrder("params")
		if len(order) != len(p) {
			order = dbKeys(p)
		}
		for _, k := range order {
			v := p[k]
			keys = append(keys, k)
			s, isStr := v.(string)
			if !isStr {
				bind[k] = v
				continue
			}
			tr := strings.TrimSpace(s)
			if m := dbWholeTpl.FindStringSubmatch(tr); m != nil {
				if x, ok := e.ctx.standardValue(strings.TrimSpace(m[1])); ok {
					bind[k] = x
				} else {
					bind[k] = nil
				}
			} else if strings.Contains(tr, "{{") {
				bind[k] = dbLazyTpl.ReplaceAllStringFunc(tr, func(m string) string {
					if x, ok := e.ctx.standardValue(strings.TrimSpace(m[2 : len(m)-2])); ok {
						return jsString(x)
					}
					return ""
				})
			} else {
				bind[k] = v
			}
		}
	}
	tr := strings.TrimSpace(sqlText)
	isPLSQL := dbPLSQL.MatchString(tr)
	isNonQuery := dbNonQuery.MatchString(tr)
	pk := make([]any, len(keys))
	for i, k := range keys {
		pk[i] = k
	}
	e.log("debug", "Database EXECUTE", om(
		"sqlLength", float64(len(dbUTF16(sqlText))), "connectionId", e.d["connectionId"], "isPLSQL", isPLSQL,
		"paramCount", float64(len(keys)), "paramKeys", pk,
	))
	return e.withConnection(func(c *dbClient) (any, error) {
		if c.isOracle {
			if isPLSQL || isNonQuery {
				n, err := dbOraExec(c.ora, sqlText, dbOraNamed(keys, bind))
				if err != nil {
					return nil, err
				}
				command := "EXECUTE"
				if isPLSQL {
					command = "PLSQL"
				}
				e.log("debug", "Database EXECUTE Result", om("rowsAffected", n, "command", command))
				return om("rows", []any{}, "rowCount", n, "command", command), nil
			}
			res, err := dbOraReadOnly(c.ora, func(q dbOraQ) (any, error) {
				return dbOraRows(q, sqlText, dbOraNamed(keys, bind), false)
			})
			if err != nil {
				return nil, err
			}
			rows := res.([]any)
			var sample any
			if len(rows) > 0 {
				sample = rows[0]
			}
			e.log("debug", "Database EXECUTE Result", om("rowCount", float64(len(rows)), "sample", sample))
			return om("rows", rows, "rowCount", float64(len(rows)), "command", "EXECUTE"), nil
		}
		resolved := sqlText
		for _, k := range keys {
			re, err := regexp.Compile(":" + k + `\b`)
			if err != nil {
				continue
			}
			resolved = dbJSReplace(re, resolved, dbEscape(bind[k]))
		}
		if isPLSQL || isNonQuery {
			n, err := dbPgExec(c.pg, c.pg.pool, resolved)
			if err != nil {
				return nil, err
			}
			return om("rows", []any{}, "rowCount", n, "command", "EXECUTE"), nil
		}
		rows, err := dbPgQuery(c.pg, c.pg.pool, resolved)
		if err != nil {
			return nil, err
		}
		return om("rows", rows, "rowCount", dbRowCount(rows), "command", "EXECUTE"), nil
	})
}

// ── bulk-insert ──────────────────────────────────────────────────────────────

var dbArrPart = regexp.MustCompile(`^(.+)\[(\d+)\]$`)

// dbValueByPath2 ports getValueByPath2: a dot path over the execution
// context ("vars.x…", "variables.x…", "input.…").
func dbValueByPath2(ctx *Ctx, path string) (any, bool) {
	parts := strings.Split(path, ".")
	var value any
	atContext := true
	for i := 0; i < len(parts); i++ {
		if !atContext && value == nil {
			return nil, false
		}
		part := parts[i]
		if (part == "vars" || part == "variables") && atContext {
			atContext = false
			if i+1 < len(parts) && parts[i+1] != "" {
				next := parts[i+1]
				if m := dbArrPart.FindStringSubmatch(next); m != nil {
					value = ctx.Vars[m[1]]
					if arr, ok := value.([]any); ok {
						n, _ := strconv.Atoi(m[2])
						if n < len(arr) {
							value = arr[n]
						} else {
							value = nil
							if i+2 >= len(parts) {
								return nil, false
							}
						}
					}
				} else {
					v, ok := ctx.Vars[next]
					if !ok && i+2 >= len(parts) {
						return nil, false
					}
					value = v
				}
				i++
			}
			continue
		}
		if atContext {
			atContext = false
			var root any
			found := true
			switch part {
			case "input":
				root = ctx.Input
			case "flow":
				root = map[string]any{"operationId": ctx.run.flow.OperationID}
			default:
				if m := dbArrPart.FindStringSubmatch(part); m != nil && m[1] == "input" {
					root = ctx.Input
					arr, ok := root.([]any)
					if !ok {
						return nil, false
					}
					n, _ := strconv.Atoi(m[2])
					if n >= len(arr) {
						return nil, false
					}
					value = arr[n]
					continue
				}
				found = false
			}
			if !found {
				return nil, false
			}
			value = root
			if root == nil && i+1 == len(parts) {
				return nil, false
			}
			continue
		}
		if m := dbArrPart.FindStringSubmatch(part); m != nil {
			v, _ := dbIndex(value, m[1])
			arr, ok := v.([]any)
			if !ok {
				return nil, false
			}
			n, _ := strconv.Atoi(m[2])
			if n >= len(arr) {
				return nil, false
			}
			value = arr[n]
			continue
		}
		v, ok := dbIndex(value, part)
		if !ok {
			return nil, false
		}
		value = v
	}
	return value, true
}

type dbKeySpec struct {
	Column       string
	PrefixLength int
	Value        any
	HasValue     bool
}

func (e *dbExec) keySpecs() []dbKeySpec {
	raw, _ := e.d["deleteKeys"].([]any)
	var out []dbKeySpec
	for _, k := range raw {
		switch t := k.(type) {
		case string:
			if t != "" {
				out = append(out, dbKeySpec{Column: t})
			}
		case map[string]any:
			if !truthy(t["column"]) {
				continue
			}
			s := dbKeySpec{Column: jsString(t["column"])}
			if p, ok := num(t, "prefixLength"); ok && p > 0 {
				s.PrefixLength = int(p)
			}
			if v, ok := t["value"]; ok && v != nil && v != "" {
				s.Value, s.HasValue = v, true
			}
			out = append(out, s)
		}
	}
	return out
}

// explicitKeys resolves keys with an explicit value ("{{year}}"); empty or
// unresolved templates fall back to per-row extraction.
var dbTplLeft = regexp.MustCompile(`\{\{.*\}\}`)

func (e *dbExec) explicitKeys(specs []dbKeySpec) map[string]any {
	out := map[string]any{}
	for _, k := range specs {
		if !k.HasValue {
			continue
		}
		v := dbResolveStr(e.ctx, dbJSString(k.Value))
		if v != "" && !dbTplLeft.MatchString(v) {
			out[k.Column] = v
		}
	}
	return out
}

func dbStrList(v any) ([]string, bool) {
	arr, ok := v.([]any)
	if !ok {
		return nil, false
	}
	out := make([]string, len(arr))
	for i, x := range arr {
		out[i] = jsString(x)
	}
	return out, true
}

func dbContains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

func dbIndexOf(list []string, s string) int {
	for i, x := range list {
		if x == s {
			return i
		}
	}
	return -1
}

// dbDoneSet reads the per-table set of deleted key tuples (a Set in TS; a
// list of signatures here so it survives JSON transport).
func dbDoneSet(v any) map[string]bool {
	out := map[string]bool{}
	if arr, ok := v.([]any); ok {
		for _, x := range arr {
			if s, ok := x.(string); ok {
				out[s] = true
			}
		}
	}
	return out
}

func dbDoneList(order []string) []any {
	out := make([]any, len(order))
	for i, s := range order {
		out[i] = s
	}
	return out
}

func (e *dbExec) bulkInsert() (any, error) {
	if !truthy(e.d["table"]) {
		return nil, errors.New("Table name is required for bulk-insert")
	}
	table := e.table()
	skip := 0
	if n, ok := num(e.d, "skipRows"); ok && n > 0 {
		skip = int(n)
	}
	var rows []any
	if truthy(e.d["filesPath"]) {
		fp := jsString(e.d["filesPath"])
		files, found := dbValueByPath2(e.ctx, fp)
		arr, ok := files.([]any)
		if !found || !ok {
			return nil, fmt.Errorf("No files array found at path: %s (got %s)", fp, dbTypeof(files, found))
		}
		rows = []any{}
		for _, f := range arr {
			fm, _ := f.(map[string]any)
			data, ok := fm["data"].([]any)
			if ok && len(data) > skip {
				sliced := data[skip:]
				rows = append(rows, sliced...)
				name := "?"
				if truthy(fm["fileName"]) {
					name = jsString(fm["fileName"])
				}
				e.log("info", fmt.Sprintf("File %s: %d data rows (skipped %d)", name, len(sliced), skip), nil)
			}
		}
	} else {
		dp := "vars.fileread.files[0].data"
		if truthy(e.d["dataPath"]) {
			dp = jsString(e.d["dataPath"])
		}
		raw, found := dbValueByPath2(e.ctx, dp)
		arr, ok := raw.([]any)
		if !found || !ok || !truthy(raw) {
			return nil, fmt.Errorf("No array data found at path: %s (got %s)", dp, dbTypeof(raw, found))
		}
		rows = arr
		if skip > 0 {
			if skip < len(arr) {
				rows = arr[skip:]
			} else {
				rows = []any{}
			}
		}
	}
	if len(rows) == 0 {
		return om("rows", []any{}, "rowCount", 0.0, "command", "BULK-INSERT", "message", "No rows to insert"), nil
	}

	fileColumns, hasFileCols := dbStrList(e.d["fileColumns"])
	dataColumns, hasCols := dbStrList(e.d["columns"])
	if !hasFileCols {
		// Object.keys(rows[0]) — the key order of rows that came through JSON
		// is lost here. With columns[] mapping positionally onto it that would
		// put values into the wrong columns, so Node runs this node.
		if hasCols && len(dbKeys(rows[0])) > 1 {
			return nil, errUseFallback
		}
		fileColumns = dbKeys(rows[0])
	}
	dbColumns := fileColumns
	if hasCols {
		dbColumns = dataColumns
	}
	if len(fileColumns) != len(dbColumns) {
		return nil, fmt.Errorf("Column count mismatch: file has %d, db expects %d", len(fileColumns), len(dbColumns))
	}
	type extra struct{ column, value string }
	var extras []extra
	if xs, ok := e.d["extraColumns"].([]any); ok {
		for _, x := range xs {
			m := asMap(x)
			extras = append(extras, extra{jsString(m["column"]), jsString(m["value"])})
		}
	}
	idColumn := ""
	if truthy(e.d["idColumn"]) {
		idColumn = jsString(e.d["idColumn"])
	}
	var all []string
	if idColumn != "" {
		all = append(all, idColumn)
	}
	all = append(all, dbColumns...)
	for _, x := range extras {
		all = append(all, x.column)
	}

	batchSize := 5000.0
	if v, ok := num(e.d, "batchSize"); ok && v != 0 && !math.IsNaN(v) {
		batchSize = v
	}
	commitEvery := 10.0
	if v, ok := num(e.d, "commitEvery"); ok && v != 0 {
		commitEvery = v
	}
	truncateMode := "truncate"
	if truthy(e.d["truncateMode"]) {
		truncateMode = jsString(e.d["truncateMode"])
	}
	mode := "append"
	if im, ok := e.d["importMode"]; ok && im != nil {
		mode = jsString(im)
	} else if truthy(e.d["truncateFirst"]) {
		mode = "truncate"
		if truncateMode == "delete" {
			mode = "delete-all"
		}
	}
	e.log("info", fmt.Sprintf("Bulk insert: %s rows into %s (batch=%s, commit every %s batches)",
		dbLocale(float64(len(rows))), table, jsNumber(batchSize), jsNumber(commitEvery)), nil)

	b := &dbBulk{e: e, table: table, rows: rows, fileColumns: fileColumns, dataColumns: dataColumns, hasCols: hasCols,
		hasFileCols: hasFileCols, all: all, idColumn: idColumn, batchSize: batchSize, commitEvery: commitEvery, mode: mode}
	for _, x := range extras {
		b.extraCols = append(b.extraCols, x.column)
		b.extraVals = append(b.extraVals, x.value)
	}
	return e.withConnection(func(c *dbClient) (any, error) {
		if !c.isOracle {
			return b.postgres(c.pg)
		}
		return b.oracle(c.ora)
	})
}

type dbBulk struct {
	e                        *dbExec
	table                    string
	rows                     []any
	fileColumns, dataColumns []string
	hasCols, hasFileCols     bool
	all                      []string
	idColumn                 string
	extraCols, extraVals     []string
	batchSize, commitEvery   float64
	mode                     string
}

// pick is row[col], else the first key equal ignoring case.
func dbPick(row any, col string) (any, bool) {
	if v, ok := dbIndex(row, col); ok {
		return v, true
	}
	lc := strings.ToLower(col)
	for _, k := range dbKeys(row) {
		if strings.ToLower(k) == lc {
			return dbIndex(row, k)
		}
	}
	return nil, false
}

// dbTextOf ports textOf in bulkInsertPostgres.
func dbTextOf(v any, found bool) any {
	if !found || v == nil {
		return nil
	}
	switch t := v.(type) {
	case string:
		if t == "" {
			return nil
		}
		return t
	case time.Time:
		return dbISO(t)
	case map[string]any, []any:
		return dbJSONString(t)
	}
	return dbJSString(v)
}

func dbIdent(c string) string {
	parts := strings.Split(c, ".")
	for i, p := range parts {
		parts[i] = `"` + strings.ReplaceAll(p, `"`, "") + `"`
	}
	return strings.Join(parts, ".")
}

func (b *dbBulk) postgres(pg *dbPg) (any, error) {
	e := b.e
	types := dbPgColumnTypes(pg, pg.pool, b.table)
	if len(types) == 0 {
		return nil, fmt.Errorf("bulk-insert: table %s not found (or this connection is not PostgreSQL/Oracle)", b.table)
	}
	specs := e.keySpecs()
	if b.mode == "delete-by-key" && len(specs) == 0 {
		return nil, errors.New(`Import mode "delete-by-key" requires deleteKeys[] — list at least one column to match for deletion.`)
	}
	table := dbIdent(b.table)
	toValues := func(row any) []any {
		var out []any
		if b.idColumn != "" {
			out = append(out, dbUUID())
		}
		for _, c := range b.fileColumns {
			out = append(out, dbTextOf(dbPick(row, c)))
		}
		for _, v := range b.extraVals {
			r := dbResolveStr(e.ctx, v)
			if r == "NULL" {
				out = append(out, nil)
			} else {
				out = append(out, dbTextOf(r, true))
			}
		}
		return out
	}
	start := time.Now()
	perBatch := math.Max(1, math.Min(b.batchSize, math.Floor(30000/math.Max(1, float64(len(b.all))))))
	inserted := 0.0

	if pg.connectStringErr != nil {
		return nil, pg.prismaErr("$transaction", pg.connectStringErr)
	}
	tctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()
	bctx, bcancel := context.WithTimeout(tctx, 60*time.Second)
	tx, err := pg.pool.BeginTx(bctx, pgx.TxOptions{})
	bcancel()
	if err != nil {
		return nil, pg.prismaErr("$transaction", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()

	cleanupKey := "_bulkCleanupDone:" + b.table
	if (b.mode == "truncate" || b.mode == "delete-all") && !truthy(e.ctx.Vars[cleanupKey]) {
		e.ctx.set(cleanupKey, true)
		q := "DELETE FROM " + table
		if b.mode == "truncate" {
			q = "TRUNCATE TABLE " + table
		}
		n, err := dbPgExec(pg, tx, q)
		if err != nil {
			return nil, err
		}
		if b.mode == "truncate" {
			e.log("info", "✓ Truncated "+b.table, nil)
		} else {
			e.log("info", fmt.Sprintf("✓ Deleted %s rows from %s", jsNumber(n), b.table), nil)
		}
	} else if b.mode == "delete-by-key" {
		explicit := e.explicitKeys(specs)
		propOf := func(col string) string {
			ci := dbIndexOf(b.dataColumns, col)
			if ci >= 0 && b.hasFileCols && ci < len(b.fileColumns) && b.fileColumns[ci] != "" {
				return b.fileColumns[ci]
			}
			return col
		}
		doneKey := "_bulkDeletedTuples:" + b.table
		done := dbDoneSet(e.ctx.Vars[doneKey])
		order, _ := e.ctx.Vars[doneKey].([]any)
		var doneOrder []string
		for _, x := range order {
			if s, ok := x.(string); ok {
				doneOrder = append(doneOrder, s)
			}
		}
		conds := make([]string, len(specs))
		for i, k := range specs {
			if k.PrefixLength > 0 {
				conds[i] = fmt.Sprintf("CAST(%s AS TEXT) LIKE $%d || '%%'", dbIdent(k.Column), i+1)
			} else {
				conds[i] = dbIdent(k.Column) + " = " + dbCast(i+1, k.Column, types)
			}
		}
		deleted := 0.0
		for _, r := range b.rows {
			tup := make([]any, len(specs))
			for i, k := range specs {
				var t any
				if v, ok := explicit[k.Column]; ok {
					t = dbTextOf(v, true)
				} else {
					t = dbTextOf(dbPick(r, propOf(k.Column)))
				}
				if s, ok := t.(string); ok && k.PrefixLength > 0 {
					t = dbSlice(s, k.PrefixLength)
				}
				tup[i] = t
			}
			sig := dbJSONString(tup)
			if done[sig] {
				continue
			}
			done[sig] = true
			doneOrder = append(doneOrder, sig)
			n, err := dbPgExec(pg, tx, "DELETE FROM "+table+" WHERE "+strings.Join(conds, " AND "), tup...)
			if err != nil {
				return nil, err
			}
			deleted += n
		}
		e.ctx.set(doneKey, dbDoneList(doneOrder))
		cols := make([]string, len(specs))
		for i, k := range specs {
			cols[i] = k.Column
		}
		e.log("info", fmt.Sprintf("✓ Deleted %s rows matching (%s)", jsNumber(deleted), strings.Join(cols, ",")), nil)
	}

	colList := make([]string, len(b.all))
	for i, c := range b.all {
		colList[i] = dbIdent(c)
	}
	cols := strings.Join(colList, ", ")
	pb := int(perBatch)
	for i := 0; i < len(b.rows); i += pb {
		end := i + pb
		if end > len(b.rows) {
			end = len(b.rows)
		}
		batch := b.rows[i:end]
		var params []any
		tuples := make([]string, len(batch))
		for bi, row := range batch {
			vals := toValues(row)
			ph := make([]string, len(vals))
			for j, v := range vals {
				params = append(params, v)
				col := ""
				if j < len(b.all) {
					col = b.all[j]
				}
				ph[j] = dbCast(len(params), col, types)
			}
			tuples[bi] = "(" + strings.Join(ph, ", ") + ")"
		}
		n, err := dbPgExec(pg, tx, fmt.Sprintf("INSERT INTO %s (%s) VALUES %s", table, cols, strings.Join(tuples, ", ")), params...)
		if err != nil {
			return nil, fmt.Errorf("Rows %d-%d failed: %s", i+1, i+len(batch), err.Error())
		}
		inserted += n
	}
	if err := tx.Commit(context.Background()); err != nil {
		return nil, pg.prismaErr("$transaction", err)
	}
	sec := float64(time.Since(start).Milliseconds()) / 1000
	e.log("info", fmt.Sprintf("Bulk insert completed: %s rows in %ss", dbLocale(inserted), dbFixed1(sec)), nil)
	return om("rows", []any{}, "rowCount", inserted, "inserted", inserted, "command", "BULK-INSERT",
		"table", e.d["table"], "batchSize", perBatch, "durationSec", sec), nil
}

// ── bulk-insert, Oracle ──────────────────────────────────────────────────────

var dbISOPrefix = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}`)

// dbOraMetaSQL builds the column-type lookup for table ("OWNER.NAME" or "NAME").
func dbOraMetaSQL(table string) string {
	parts := strings.Split(table, ".")
	tname := strings.ToUpper(parts[len(parts)-1])
	if len(parts) > 1 {
		return fmt.Sprintf("SELECT column_name, data_type FROM all_tab_columns WHERE owner='%s' AND table_name='%s'", strings.ToUpper(parts[0]), tname)
	}
	return fmt.Sprintf("SELECT column_name, data_type FROM user_tab_columns WHERE table_name='%s'", tname)
}

// dbOraColType classifies an Oracle data_type for coercion.
func dbOraColType(dt string) string {
	t := strings.ToUpper(dt)
	switch {
	case t == "NUMBER" || t == "FLOAT" || t == "INTEGER" || t == "BINARY_FLOAT" || t == "BINARY_DOUBLE":
		return "number"
	case t == "DATE" || strings.HasPrefix(t, "TIMESTAMP"):
		return "date"
	}
	return "string"
}

// dbCoerce ports coerceValue.
func dbCoerce(val any, t string) any {
	if val == nil {
		return nil
	}
	switch t {
	case "number":
		switch v := val.(type) {
		case float64:
			return v
		case string:
			s := strings.TrimSpace(v)
			if s == "" {
				return nil
			}
			n := dbParseFloat(strings.ReplaceAll(s, ",", ""))
			if math.IsNaN(n) {
				return val
			}
			return n
		case time.Time:
			return float64(v.UnixMilli())
		}
		return val
	case "date":
		switch v := val.(type) {
		case time.Time:
			return v
		case string:
			if d, ok := dbParseDate(v); ok {
				return d
			}
			return val
		}
		return val
	}
	switch v := val.(type) {
	case string:
		return v
	case time.Time:
		return dbISO(v)
	}
	return dbJSString(val)
}

// dbOraRowValues builds one row of binds (the executeMany row array).
func (b *dbBulk) oraRowValues(row any, colType map[string]string) []any {
	var vals []any
	if b.idColumn != "" {
		vals = append(vals, dbUUID())
	}
	keys := dbKeys(row)
	ci := map[string]string{}
	for _, k := range keys {
		ci[strings.ToLower(k)] = k
	}
	for i, col := range b.fileColumns {
		dbCol := col
		if b.hasCols && i < len(b.dataColumns) {
			dbCol = b.dataColumns[i]
		}
		v, found := dbIndex(row, col)
		if !found {
			if real, ok := ci[strings.ToLower(col)]; ok {
				v, found = dbIndex(row, real)
			}
		}
		if !found || v == "" {
			v = nil
		}
		vals = append(vals, dbCoerce(v, colType[dbCol]))
	}
	for _, x := range b.extraVals {
		r := dbResolveStr(b.e.ctx, x)
		if r == "NULL" {
			vals = append(vals, nil)
		} else if dbISOPrefix.MatchString(r) {
			if d, ok := dbParseDate(r); ok {
				vals = append(vals, d)
			} else {
				vals = append(vals, r)
			}
		} else {
			vals = append(vals, r)
		}
	}
	return vals
}

// dbOraColumns turns rows of binds into per-column arrays for go-ora's array
// DML (executeMany). A column whose values have mixed Go types is sent as
// text, since one array has one bind type.
func dbOraColumns(binds [][]any, width int) []any {
	cols := make([]any, width)
	for c := 0; c < width; c++ {
		col := make([]any, len(binds))
		kind := ""
		mixed := false
		for r := range binds {
			v := dbOraBind(binds[r][c])
			col[r] = v
			if v == nil {
				continue
			}
			k := fmt.Sprintf("%T", v)
			if kind == "" {
				kind = k
			} else if kind != k {
				mixed = true
			}
		}
		if mixed {
			for r, v := range col {
				switch t := v.(type) {
				case nil, string:
				case time.Time:
					col[r] = dbISO(t)
				default:
					col[r] = jsString(t)
				}
			}
		}
		cols[c] = col
	}
	return cols
}

func (b *dbBulk) oracle(conn *sql.Conn) (any, error) {
	e := b.e
	destructive := b.mode != "append"
	specs := e.keySpecs()
	if b.mode == "delete-by-key" {
		if len(specs) == 0 {
			return nil, errors.New(`Import mode "delete-by-key" requires deleteKeys[] — list at least one column to match for deletion.`)
		}
		for _, k := range specs {
			if k.HasValue {
				continue
			}
			if !dbContains(b.all, k.Column) && !dbContains(b.dataColumns, k.Column) && !(b.hasFileCols && dbContains(b.fileColumns, k.Column)) {
				return nil, fmt.Errorf(`deleteKey "%s" not present in columns[] — cannot extract delete value from incoming rows (or set an explicit "value").`, k.Column)
			}
		}
	}

	tx, err := conn.BeginTx(context.Background(), nil)
	if err != nil {
		return nil, err
	}
	rollback := func() { _ = tx.Rollback() }

	cleanupKey := "_bulkCleanupDone:" + b.table
	if destructive && b.mode != "delete-by-key" && !truthy(e.ctx.Vars[cleanupKey]) {
		e.ctx.set(cleanupKey, true)
		t0 := time.Now()
		if b.mode == "truncate" {
			e.log("info", fmt.Sprintf("TRUNCATE TABLE %s (DDL — fast, auto-commits)...", b.table), nil)
			if _, err := dbOraExec(tx, "TRUNCATE TABLE "+b.table, nil); err != nil {
				rollback()
				return nil, err
			}
			e.log("info", fmt.Sprintf("✓ Truncated %s in %ss", b.table, dbFixed1(dbSince(t0))), nil)
		} else if b.mode == "delete-all" {
			e.log("info", fmt.Sprintf("DELETE FROM %s (rollback-safe, UNDO logged)...", b.table), nil)
			n, err := dbOraExec(tx, "DELETE FROM "+b.table, nil)
			if err != nil {
				rollback()
				return nil, err
			}
			e.log("info", fmt.Sprintf("✓ Deleted %s rows from %s in %ss", jsNumber(n), b.table, dbFixed1(dbSince(t0))), nil)
		}
	} else if b.mode == "delete-by-key" {
		t0 := time.Now()
		tuples, sql, keyDesc := b.oraDeleteTuples(specs)
		if len(tuples) == 0 {
			e.log("info", fmt.Sprintf("No new key tuples to pre-delete for %s — skipping pre-delete.", b.table), nil)
		} else {
			e.log("info", fmt.Sprintf("DELETE-BY-KEY %s matching %d distinct (%s) tuples…", b.table, len(tuples), keyDesc), nil)
			total := 0.0
			for i := 0; i < len(tuples); i += 1000 {
				end := i + 1000
				if end > len(tuples) {
					end = len(tuples)
				}
				n, err := dbOraExec(tx, sql, dbOraColumns(tuples[i:end], len(specs)))
				if err != nil {
					rollback()
					return nil, err
				}
				total += n
			}
			e.log("info", fmt.Sprintf("✓ Deleted %s matching rows in %ss", jsNumber(total), dbFixed1(dbSince(t0))), nil)
		}
	}

	ph := make([]string, len(b.all))
	for i := range b.all {
		ph[i] = ":" + strconv.Itoa(i+1)
	}
	insertSQL := fmt.Sprintf("INSERT INTO %s (%s) VALUES (%s)", b.table, strings.Join(b.all, ", "), strings.Join(ph, ", "))

	colType := map[string]string{}
	if meta, err := dbOraRows(tx, dbOraMetaSQL(b.table), nil, false); err != nil {
		e.log("warn", fmt.Sprintf("Could not introspect column types for %s — string-only coercion: %s", b.table, err.Error()), nil)
	} else {
		for _, m := range meta {
			mm := asMap(m)
			colType[jsString(mm["COLUMN_NAME"])] = dbOraColType(jsString(mm["DATA_TYPE"]))
		}
	}

	start := time.Now()
	total := 0.0
	sinceCommit := 0.0
	bs := int(b.batchSize)
	if bs < 1 {
		bs = 1
	}
	totalBatches := int(math.Ceil(float64(len(b.rows)) / b.batchSize))
	nrows := float64(len(b.rows))
	for i := 0; i < len(b.rows); i += bs {
		end := i + bs
		if end > len(b.rows) {
			end = len(b.rows)
		}
		batch := b.rows[i:end]
		batchNum := i/bs + 1
		binds := make([][]any, len(batch))
		for r, row := range batch {
			binds[r] = b.oraRowValues(row, colType)
		}
		if _, err := dbOraExec(tx, insertSQL, dbOraColumns(binds, len(b.all))); err != nil {
			rollback()
			return nil, fmt.Errorf("Batch %d/%d (rows %d-%d) failed: %s", batchNum, totalBatches, i+1, i+len(batch), err.Error())
		}
		total += float64(len(batch))
		sinceCommit++
		if sinceCommit >= b.commitEvery {
			if err := tx.Commit(); err != nil {
				return nil, err
			}
			if tx, err = conn.BeginTx(context.Background(), nil); err != nil {
				return nil, err
			}
			sinceCommit = 0
			elapsed := dbSince(start)
			rps := dbRound(total / elapsed)
			e.log("info", fmt.Sprintf("  ▸ %s/%s rows (%s%%, %s rows/s) — committed", dbLocale(total), dbLocale(nrows),
				jsNumber(dbRound(total*100/nrows)), dbLocale(rps)), nil)
		}
	}
	if sinceCommit > 0 {
		if err := tx.Commit(); err != nil {
			rollback()
			return nil, err
		}
	} else {
		rollback() // nothing pending; ends the transaction
	}
	sec := dbSince(start)
	rps := total
	if sec > 0 {
		rps = dbRound(total / sec)
	}
	e.log("info", fmt.Sprintf("Bulk insert completed: %s rows in %ss (%s rows/s)", dbLocale(total), dbFixed1(sec), dbLocale(rps)), nil)
	return om("rows", []any{}, "rowCount", total, "inserted", total, "command", "BULK-INSERT",
		"table", e.d["table"], "batchSize", b.batchSize, "durationSec", sec), nil
}

func dbSince(t time.Time) float64 { return float64(time.Since(t).Milliseconds()) / 1000 }

// oraDeleteTuples collects the distinct key tuples not deleted yet in this
// execution and returns them with the DELETE statement and key description.
func (b *dbBulk) oraDeleteTuples(specs []dbKeySpec) ([][]any, string, string) {
	e := b.e
	sample := any(map[string]any{})
	if len(b.rows) > 0 && b.rows[0] != nil {
		sample = b.rows[0]
	}
	lc := map[string]string{}
	for _, p := range dbKeys(sample) {
		lc[strings.ToLower(p)] = p
	}
	keyToProp := map[string]string{}
	for _, k := range specs {
		ci := dbIndexOf(b.dataColumns, k.Column)
		if ci >= 0 && b.hasFileCols && ci < len(b.fileColumns) && b.fileColumns[ci] != "" {
			keyToProp[k.Column] = b.fileColumns[ci]
		} else if p, ok := lc[strings.ToLower(k.Column)]; ok {
			keyToProp[k.Column] = p
		} else {
			keyToProp[k.Column] = k.Column
		}
	}
	explicit := e.explicitKeys(specs)
	doneKey := "_bulkDeletedTuples:" + b.table
	done := dbDoneSet(e.ctx.Vars[doneKey])
	var doneOrder []string
	if arr, ok := e.ctx.Vars[doneKey].([]any); ok {
		for _, x := range arr {
			if s, ok := x.(string); ok {
				doneOrder = append(doneOrder, s)
			}
		}
	}
	var tuples [][]any
	for _, r := range b.rows {
		tup := make([]any, len(specs))
		for i, k := range specs {
			var raw any
			if v, ok := explicit[k.Column]; ok {
				raw = v
			} else if v, ok := dbIndex(r, keyToProp[k.Column]); ok {
				raw = v
			}
			if raw != nil && k.PrefixLength > 0 {
				raw = dbSlice(dbJSString(raw), k.PrefixLength)
			}
			tup[i] = raw
		}
		sig := dbJSONString(tup)
		if !done[sig] {
			done[sig] = true
			doneOrder = append(doneOrder, sig)
			tuples = append(tuples, tup)
		}
	}
	e.ctx.set(doneKey, dbDoneList(doneOrder))
	conds := make([]string, len(specs))
	desc := make([]string, len(specs))
	for i, k := range specs {
		if k.PrefixLength > 0 {
			conds[i] = fmt.Sprintf("%s LIKE :%d || '%%'", k.Column, i+1)
			desc[i] = fmt.Sprintf("%s[1..%d]", k.Column, k.PrefixLength)
		} else {
			conds[i] = fmt.Sprintf("%s = :%d", k.Column, i+1)
			desc[i] = k.Column
		}
	}
	return tuples, fmt.Sprintf("DELETE FROM %s WHERE %s", b.table, strings.Join(conds, " AND ")), strings.Join(desc, ",")
}
