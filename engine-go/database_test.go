package main

import (
	"context"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

// ── pure helpers ─────────────────────────────────────────────────────────────

func TestDbportEscape(t *testing.T) {
	cases := map[any]string{
		nil: "NULL", 5.0: "5", 1.5: "1.5", true: "true", "12": "12", "-3.25": "-3.25",
		"1e5": "'1e5'", "O'Neil": "'O''Neil'", "": "''", " 1": "' 1'",
	}
	for in, want := range cases {
		if got := dbEscape(in); got != want {
			t.Errorf("dbEscape(%#v) = %q, want %q", in, got, want)
		}
	}
	if got := dbEscape(map[string]any{"a": 1.0}); got != "'[object Object]'" {
		t.Errorf("object: %q", got)
	}
	if got := dbEscape([]any{1.0, 2.0}); got != "'1,2'" {
		t.Errorf("array: %q", got)
	}
}

func dbTestCtx(input any, vars map[string]any) *Ctx {
	r := &Run{flow: &Flow{}, results: newResults()}
	return &Ctx{ID: "root", Input: input, Vars: vars, dirty: map[string]bool{}, run: r}
}

func TestDbportResolve(t *testing.T) {
	ctx := dbTestCtx(map[string]any{"params": map[string]any{"year": "2567"}, "body": map[string]any{"n": "O'x"}},
		map[string]any{"q": map[string]any{"rows": []any{map[string]any{"id": 7.0}}}, "nul": nil})
	cases := map[string]string{
		"SELECT ${path.year}":      "SELECT 2567",
		"SELECT ${body.n}":         "SELECT 'O''x'",
		"SELECT ${nope.x}":         "SELECT NULL",
		"SELECT {{path.year}}":     "SELECT 2567",
		"SELECT {{q.rows[0].id}}":  "SELECT 7",
		"SELECT {{missing}}":       "SELECT {{missing}}",
		"SELECT {{nul}}":           "SELECT null",
		"SELECT {{q}}":             "SELECT [object Object]",
		"no templates":             "no templates",
		"{{path.year}}-{{body.n}}": "2567-O'x",
	}
	for in, want := range cases {
		if got := dbResolveStr(ctx, in); got != want {
			t.Errorf("resolve(%q) = %q, want %q", in, got, want)
		}
	}
	if v := dbResolve(ctx, 5.0); v != 5.0 {
		t.Errorf("non-string resolve: %#v", v)
	}
}

func TestDbportOracleRewrite(t *testing.T) {
	s, b := dbOraRewrite("SELECT * FROM T WHERE A=$1 AND B=$2;;", []any{"x", 2.0})
	if s != "SELECT * FROM T WHERE A=:1 AND B=:2" || len(b) != 2 || b[0] != "x" {
		t.Errorf("$N: %q %v", s, b)
	}
	// $N beyond params: placeholder renumbered, nothing bound
	s, b = dbOraRewrite("SELECT $3 FROM DUAL", []any{"x"})
	if s != "SELECT :1 FROM DUAL" || len(b) != 0 {
		t.Errorf("$N missing: %q %v", s, b)
	}
	s, b = dbOraRewrite("UPDATE T SET A=? WHERE B=?", []any{"a", "b"})
	if s != "UPDATE T SET A=:1 WHERE B=:2" || len(b) != 2 || b[1] != "b" {
		t.Errorf("?: %q %v", s, b)
	}
	// insert/update SQL already uses :1…: nothing is bound (as in TS)
	s, b = dbOraRewrite("INSERT INTO T (A, B) VALUES (:1, :2)", []any{"a", "b"})
	if s != "INSERT INTO T (A, B) VALUES (:1, :2)" || len(b) != 0 {
		t.Errorf(":n: %q %v", s, b)
	}
	// PL/SQL: the final ; is stripped by executeOracleNonQuery
	s, _ = dbOraRewrite("BEGIN NULL; END;", nil)
	if s != "BEGIN NULL; END" {
		t.Errorf("plsql: %q", s)
	}
}

func TestDbportCoerce(t *testing.T) {
	if v := dbCoerce("00001", "number"); v != 1.0 {
		t.Errorf("number: %#v", v)
	}
	if v := dbCoerce(" 1,234.50 ", "number"); v != 1234.5 {
		t.Errorf("thousands: %#v", v)
	}
	if v := dbCoerce("12abc", "number"); v != 12.0 {
		t.Errorf("parseFloat prefix: %#v", v)
	}
	if v := dbCoerce("abc", "number"); v != "abc" {
		t.Errorf("NaN passthrough: %#v", v)
	}
	if v := dbCoerce("  ", "number"); v != nil {
		t.Errorf("blank: %#v", v)
	}
	if v := dbCoerce(true, "number"); v != true {
		t.Errorf("bool: %#v", v)
	}
	d, ok := dbCoerce("2026-01-15", "date").(time.Time)
	if !ok || dbISO(d) != "2026-01-15T00:00:00.000Z" {
		t.Errorf("date: %#v", d)
	}
	if v := dbCoerce("15/01/2569", "date"); v != "15/01/2569" {
		t.Errorf("invalid date passthrough: %#v", v)
	}
	if v := dbCoerce(5.0, "string"); v != "5" {
		t.Errorf("string: %#v", v)
	}
	if v := dbCoerce(5.0, ""); v != "5" {
		t.Errorf("unknown type → string: %#v", v)
	}
	if dbOraColType("TIMESTAMP(6)") != "date" || dbOraColType("BINARY_DOUBLE") != "number" || dbOraColType("VARCHAR2") != "string" {
		t.Error("colType")
	}
	if dbOraMetaSQL("appschema.orders_outgoing") != "SELECT column_name, data_type FROM all_tab_columns WHERE owner='APPSCHEMA' AND table_name='ORDERS_OUTGOING'" {
		t.Error(dbOraMetaSQL("appschema.orders_outgoing"))
	}
	if dbOraMetaSQL("t1") != "SELECT column_name, data_type FROM user_tab_columns WHERE table_name='T1'" {
		t.Error(dbOraMetaSQL("t1"))
	}
}

func TestDbportNumbers(t *testing.T) {
	for in, want := range map[float64]string{0: "0", 1234567.891: "1,234,567.891", 1000: "1,000", 12.3456: "12.346", -5000: "-5,000"} {
		if got := dbLocale(in); got != want {
			t.Errorf("locale(%v) = %q want %q", in, got, want)
		}
	}
	for in, want := range map[float64]string{0.25: "0.3", 0.75: "0.8", 0.35: "0.3", 1.05: "1.1", 12: "12.0", 0.04: "0.0"} {
		if got := dbFixed1(in); got != want {
			t.Errorf("toFixed(%v) = %q want %q", in, got, want)
		}
	}
	dec := func(s string, exp int) string { i, _ := new(big.Int).SetString(s, 10); return dbDecimalString(i, exp) }
	for _, c := range [][3]any{{"150", -2, "1.5"}, {"100", 0, "100"}, {"1", 25, "1e+25"}, {"12346", -3, "12.346"},
		{"-5", -1, "-0.5"}, {"1", -7, "1e-7"}, {"1", -6, "0.000001"}, {"0", 3, "0"}, {"123456789012345678901", 0, "123456789012345678901"}, {"1", 20, "100000000000000000000"}, {"1", 21, "1e+21"}} {
		if got := dec(c[0].(string), c[1].(int)); got != c[2] {
			t.Errorf("decimal(%v) = %q want %q", c, got, c[2])
		}
	}
	if dbSafeInt(5) != 5.0 || dbSafeInt(9007199254740993) != "9007199254740993" {
		t.Error("safe int")
	}
}

func TestDbportJSReplace(t *testing.T) {
	re := regexp.MustCompile(`:id\b`)
	if got := dbJSReplace(re, "a=:id and :idx", "'$$x$&'"); got != "a='$x:id' and :idx" {
		t.Errorf("replace: %q", got)
	}
}

func TestDbportValueByPath2(t *testing.T) {
	ctx := dbTestCtx(map[string]any{"body": map[string]any{"rows": []any{1.0}}},
		map[string]any{"fileread": map[string]any{"files": []any{map[string]any{"data": []any{"r"}}}}, "arr": []any{"z"}})
	if v, ok := dbValueByPath2(ctx, "vars.fileread.files[0].data"); !ok || len(v.([]any)) != 1 {
		t.Errorf("vars path: %v %v", v, ok)
	}
	if v, ok := dbValueByPath2(ctx, "input.body.rows"); !ok || len(v.([]any)) != 1 {
		t.Errorf("input path: %v %v", v, ok)
	}
	if v, ok := dbValueByPath2(ctx, "vars.arr[0]"); !ok || v != "z" {
		t.Errorf("vars index: %v %v", v, ok)
	}
	if _, ok := dbValueByPath2(ctx, "vars.nope.x"); ok {
		t.Error("missing should be undefined")
	}
	if got := dbTypeof(nil, false); got != "undefined" {
		t.Error(got)
	}
}

func TestDbportDeleteTuplesOracle(t *testing.T) {
	ctx := dbTestCtx(map[string]any{}, map[string]any{"year": "2569"})
	e := &dbExec{ctx: ctx, d: map[string]any{"deleteKeys": []any{
		"FISCAL_YEAR", map[string]any{"column": "MONTH_YEAR_CODE", "prefixLength": 4.0}, map[string]any{"column": "Y", "value": "{{year}}"},
		map[string]any{"column": "Z", "value": "{{nothing}}"},
	}}}
	specs := e.keySpecs()
	b := &dbBulk{e: e, table: "S.T", rows: []any{
		map[string]any{"fiscal_year": 2569.0, "MONTH_YEAR_CODE": "2569-01", "Z": "z1"},
		map[string]any{"fiscal_year": 2569.0, "MONTH_YEAR_CODE": "2569-02", "Z": "z1"},
		map[string]any{"fiscal_year": 2570.0, "MONTH_YEAR_CODE": "2570-01", "Z": nil},
	}}
	tuples, sql, desc := b.oraDeleteTuples(specs)
	if sql != "DELETE FROM S.T WHERE FISCAL_YEAR = :1 AND MONTH_YEAR_CODE LIKE :2 || '%' AND Y = :3 AND Z = :4" {
		t.Error(sql)
	}
	if desc != "FISCAL_YEAR,MONTH_YEAR_CODE[1..4],Y,Z" {
		t.Error(desc)
	}
	if len(tuples) != 2 || tuples[0][0] != 2569.0 || tuples[0][1] != "2569" || tuples[0][2] != "2569" || tuples[1][3] != nil {
		t.Errorf("tuples: %v", tuples)
	}
	// second run in the same execution: nothing new
	tuples, _, _ = b.oraDeleteTuples(specs)
	if len(tuples) != 0 {
		t.Errorf("repeat: %v", tuples)
	}
	if got := ctx.Vars["_bulkDeletedTuples:S.T"].([]any)[0]; got != `[2569,"2569","2569","z1"]` {
		t.Errorf("sig: %v", got)
	}
	cols := dbOraColumns([][]any{{1.0, "a"}, {"x", nil}}, 2)
	if c0 := cols[0].([]any); c0[0] != "1" || c0[1] != "x" {
		t.Errorf("mixed column → text: %v", c0)
	}
}

func TestDbportOracleRowValues(t *testing.T) {
	ctx := dbTestCtx(map[string]any{}, map[string]any{"d": "2026-01-15T10:00:00.000Z"})
	b := &dbBulk{e: &dbExec{ctx: ctx, d: map[string]any{}}, fileColumns: []string{"Min", "name", "when"}, dataColumns: []string{"MIN_V", "NAME", "WHEN_D"},
		hasCols: true, idColumn: "ID", extraVals: []string{"{{d}}", "NULL", "x"}}
	vals := b.oraRowValues(map[string]any{"MIN": "00012", "name": "", "when": "2026-01-02"}, map[string]string{"MIN_V": "number", "WHEN_D": "date"})
	if len(vals) != 7 || len(vals[0].(string)) != 36 || vals[1] != 12.0 || vals[2] != nil || vals[5] != nil || vals[6] != "x" {
		t.Errorf("vals: %#v", vals)
	}
	if d, ok := vals[4].(time.Time); !ok || dbISO(d) != "2026-01-15T10:00:00.000Z" {
		t.Errorf("extra date: %#v", vals[4])
	}
	if d, ok := vals[3].(time.Time); !ok || dbISO(d) != "2026-01-02T00:00:00.000Z" {
		t.Errorf("coerced date: %#v", vals[3])
	}
}

func TestDbportOraValue(t *testing.T) {
	if v := dbOraValue("12.50", "NUMBER", true); v != 12.5 {
		t.Errorf("number: %#v", v)
	}
	if v := dbOraValue(`[{"a":1}]`, "CLOB", true); len(v.([]any)) != 1 {
		t.Errorf("clob json: %#v", v)
	}
	if v := dbOraValue(`[oops`, "CLOB", true); v != "[oops" {
		t.Errorf("clob bad json: %#v", v)
	}
	if v := dbOraValue(`[1]`, "VARCHAR2", true); v != "[1]" {
		t.Errorf("varchar stays text: %#v", v)
	}
}

// ── PostgreSQL integration (local server) ────────────────────────────────────

const dbTestURL = "postgresql://postgres@localhost:55500/postgres"

func dbTestRun(t *testing.T, cfg map[string]any, status string) (*Run, func()) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		id := req.URL.Path[strings.LastIndex(req.URL.Path, "/")+1:]
		if id == "missing" {
			_ = json.NewEncoder(w).Encode(map[string]any{"error": "Connection not found: missing"})
			return
		}
		b, _ := json.Marshal(cfg)
		_ = json.NewEncoder(w).Encode(map[string]any{"id": id, "name": "Local PG", "type": "postgresql", "status": status, "config": string(b)})
	}))
	r := newRun(&ExecuteRequest{RunID: "t", CallbackURL: srv.URL + "/internal/engine/node", Flow: Flow{}}, func(map[string]any) {})
	return r, srv.Close
}

func dbTestNode(t *testing.T, data string) *Node {
	var n Node
	if err := json.Unmarshal([]byte(`{"id":"db1","type":"database","data":`+data+`}`), &n); err != nil {
		t.Fatal(err)
	}
	return &n
}

// dbTestOut compares values: JS-encoded (dates, numbers) then keys sorted.
func dbTestOut(t *testing.T, v any) string {
	var m any
	if err := json.Unmarshal(jsEncode(v), &m); err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(m)
	return string(b)
}

func dbPgAvailable(t *testing.T) {
	c, err := pgx.Connect(context.Background(), dbTestURL)
	if err != nil {
		t.Skip("local PostgreSQL not available:", err)
	}
	_ = c.Close(context.Background())
}

func dbTestExec(t *testing.T, sql string) {
	c, err := pgx.Connect(context.Background(), dbTestURL)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close(context.Background())
	if _, err := c.Exec(context.Background(), sql); err != nil {
		t.Fatal(err)
	}
}

func TestDbportPostgres(t *testing.T) {
	dbPgAvailable(t)
	cfg := map[string]any{"type": "postgresql", "host": "localhost", "port": 55500.0, "database": "postgres", "username": "postgres", "password": ""}
	r, stop := dbTestRun(t, cfg, "Active")
	defer stop()
	dbTestExec(t, `DROP TABLE IF EXISTS t_dbport_a; CREATE TABLE t_dbport_a (id int4 primary key, code text, amt numeric(12,2), d date, ts timestamptz, flag bool, big int8, uid uuid, fy int4, ym text)`)
	defer dbTestExec(t, `DROP TABLE IF EXISTS t_dbport_a`)
	ctx := dbTestCtx(map[string]any{"params": map[string]any{"year": "2569"}, "body": map[string]any{"code": "A'1"}}, map[string]any{
		"fileread": map[string]any{"files": []any{map[string]any{"fileName": "f.csv", "data": []any{
			map[string]any{"ID": "00001", "CODE": "x", "AMT": "1,5", "D": "2026-01-15", "FY": "2569", "YM": "2569-01"},
		}}}},
		"rows": []any{
			map[string]any{"id": "1", "code": "a", "amt": "12.5", "fy": "2569", "ym": "2569-01"},
			map[string]any{"id": "2", "code": "", "amt": nil, "fy": "2569", "ym": "2569-02"},
			map[string]any{"id": "3", "code": "c", "amt": "7", "fy": "2570", "ym": "2570-01"},
		},
	})
	run := func(data string) (any, error) { return execDatabase(r, dbTestNode(t, data), ctx) }
	must := func(data string) string {
		out, err := run(data)
		if err != nil {
			t.Fatalf("%s: %v", data, err)
		}
		return dbTestOut(t, out)
	}

	// select: value types after Prisma + toJsonSafe + JSON
	got := must(`{"connectionId":"c1","operation":"select","sql":"SELECT 1::int4 a, 9007199254740993::int8 b, 5::int8 b2, 1.50::numeric c, 1.5::float8 d, '2026-01-15'::date e, '2026-01-15 10:11:12.345678'::timestamp f, '2026-01-15 10:11:12+07'::timestamptz g, true h, '{\"z\":1}'::jsonb j, 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'::uuid k, '\\x0102'::bytea l, '10:11:12'::time m, null::text o, ARRAY[1,2]::int4[] p, 1e25::numeric v, 'NaN'::float8 y, '{{path.year}}' yr"}`)
	want := `{"command":"SELECT","rowCount":1,"rows":[{"a":1,"b":"9007199254740993","b2":5,"c":"1.5","d":1.5,"e":"2026-01-15T00:00:00.000Z","f":"2026-01-15T10:11:12.345Z","g":"2026-01-15T03:11:12.000Z","h":true,"j":{"z":1},"k":"a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11","l":{"0":1,"1":2},"m":"1970-01-01T10:11:12.000Z","o":null,"p":[1,2],"v":"1e+25","y":null,"yr":"2569"}]}`
	if got != want {
		t.Errorf("select:\n got %s\nwant %s", got, want)
	}

	// insert with casts + RETURNING *
	got = must(`{"connectionId":"c1","operation":"insert","table":"t_dbport_a","columnMapping":[{"column":"id","value":"10"},{"column":"code","value":"{{body.code}}"},{"column":"amt","value":"NULL"},{"column":"fy","value":"{{path.year}}"}]}`)
	if !strings.Contains(got, `"rows":[{"amt":null,"big":null,"code":"A'1","d":null,"flag":null,"fy":2569,"id":10,`) || !strings.Contains(got, `"command":"INSERT","rowCount":1`) {
		t.Errorf("insert: %s", got)
	}
	got = must(`{"connectionId":"c1","operation":"update","table":"t_dbport_a","columnMapping":[{"column":"amt","value":"3.25"}],"whereClause":"id = ${path.year} - 2559"}`)
	if got != `{"command":"UPDATE","rowCount":1,"rows":[]}` {
		t.Errorf("update: %s", got)
	}
	got = must(`{"connectionId":"c1","operation":"execute","sql":"UPDATE t_dbport_a SET code = :c WHERE id = :id","params":{"c":"{{body.code}}","id":"10"}}`)
	if got != `{"command":"EXECUTE","rowCount":1,"rows":[]}` {
		t.Errorf("execute dml: %s", got)
	}
	got = must(`{"connectionId":"c1","operation":"execute","sql":"SELECT code, amt FROM t_dbport_a WHERE id = :id","params":{"id":"{{path.year}}"}}`)
	if got != `{"command":"EXECUTE","rowCount":0,"rows":[]}` {
		t.Errorf("execute select: %s", got)
	}
	got = must(`{"connectionId":"c1","operation":"code","code":"return { sql: 'SELECT code FROM t_dbport_a WHERE fy = $1 AND id < 0', params: [2569], summary: {n: 1} }"}`)
	if got != `{"command":"CODE","rowCount":0,"rows":[],"summary":{"n":1}}` {
		// positional $1 bound as int8 like Prisma's JS number
		t.Errorf("code positional: %s", got)
	}
	got = must(`{"connectionId":"c1","operation":"code","code":"return { sql: 'SELECT code, amt FROM t_dbport_a WHERE id = :id', params: { id: 10 } }"}`)
	if got != `{"command":"CODE","rowCount":1,"rows":[{"amt":"3.25","code":"A'1"}]}` {
		t.Errorf("code named: %s", got)
	}
	got = must(`{"connectionId":"c1","operation":"code","code":"return 'SELECT count(*) AS n FROM t_dbport_a'"}`)
	if got != `{"command":"CODE","rowCount":1,"rows":[{"n":1}]}` {
		t.Errorf("code string: %s", got)
	}

	// bulk-insert: truncate once per table, then delete-by-key
	got = must(`{"connectionId":"c1","operation":"bulk-insert","table":"t_dbport_a","dataPath":"vars.rows","fileColumns":["id","code","amt","fy","ym"],"columns":["id","code","amt","fy","ym"],"importMode":"truncate"}`)
	if !strings.Contains(got, `"batchSize":5000,"command":"BULK-INSERT","durationSec":`) || !strings.Contains(got, `"inserted":3,"rowCount":3,"rows":[],"table":"t_dbport_a"`) {
		t.Errorf("bulk truncate: %s", got)
	}
	got = must(`{"connectionId":"c1","operation":"bulk-insert","table":"t_dbport_a","dataPath":"vars.rows","fileColumns":["id","code","amt","fy","ym"],"importMode":"delete-by-key","deleteKeys":["fy",{"column":"ym","prefixLength":4}]}`)
	if !strings.Contains(got, `"inserted":3`) {
		t.Errorf("bulk delete-by-key: %s", got)
	}
	// same keys again in this execution: no pre-delete → duplicate key error
	_, err := run(`{"connectionId":"c1","operation":"bulk-insert","table":"t_dbport_a","dataPath":"vars.rows","fileColumns":["id","code","amt","fy","ym"],"importMode":"delete-by-key","deleteKeys":["fy",{"column":"ym","prefixLength":4}]}`)
	if err == nil || err.Error() != "Database query failed: Rows 1-3 failed: \nInvalid `prisma.$executeRawUnsafe()` invocation:\n\n\nRaw query failed. Code: `23505`. Message: `Key (id)=(1) already exists.`" {
		t.Errorf("dup error: %v", err)
	}
	got = must(`{"connectionId":"c1","operation":"select","sql":"SELECT id, code, amt, fy, ym FROM t_dbport_a ORDER BY id"}`)
	if got != `{"command":"SELECT","rowCount":3,"rows":[{"amt":"12.5","code":"a","fy":2569,"id":1,"ym":"2569-01"},{"amt":null,"code":null,"fy":2569,"id":2,"ym":"2569-02"},{"amt":"7","code":"c","fy":2570,"id":3,"ym":"2570-01"}]}` {
		t.Errorf("after bulk: %s", got)
	}
	got = must(`{"connectionId":"c1","operation":"delete","table":"t_dbport_a","whereClause":"fy = {{path.year}}"}`)
	if got != `{"command":"DELETE","rowCount":2,"rows":[]}` {
		t.Errorf("delete: %s", got)
	}

	// errors
	for data, want := range map[string]string{
		`{"operation":"select"}`:                                    "Database connection ID is required",
		`{"connectionId":"c1","operation":"bogus"}`:                 "Unknown operation: bogus",
		`{"connectionId":"c1","sql":"SELECT * FROM t_dbport_nope"}`: "Table not found. Please check if the table exists.",
		`{"connectionId":"c1","sql":"SELEC 1"}`:                     "Database query failed: \nInvalid `prisma.$queryRawUnsafe()` invocation:\n\n\nRaw query failed. Code: `42601`. Message: `ERROR: syntax error at or near \"SELEC\"`",
		`{"connectionId":"c1","sql":"SELECT 1 WHERE 1 = $1","operation":"code","code":"return {sql: this.x || 'SELECT 1 WHERE 1 = $1', params: ['1']}"}`: "Database query failed: \nInvalid `prisma.$queryRawUnsafe()` invocation:\n\n\nRaw query failed. Code: `42883`. Message: `ERROR: operator does not exist: integer = text\nHINT: No operator matches the given name and argument types. You might need to add explicit type casts.`",
		`{"connectionId":"c1","operation":"code","code":"return {sql: 'SELECT $1::int4, $2', params: [1]}"}`:                                             "Database query failed: \nInvalid `prisma.$queryRawUnsafe()` invocation:\n\n\nYour raw query had an incorrect number of parameters. Expected: `2`, actual: `1`.",
		`{"connectionId":"c1","operation":"code","code":"throw new Error('boom')"}`:                                                                      "Code execution error: boom",
		`{"connectionId":"c1","operation":"code","code":"return 5"}`:                                                                                     "Code must return a SQL string or an object with .sql property",
		`{"connectionId":"c1","operation":"insert","table":"t"}`:                                                                                         "Column mapping is required for INSERT",
		`{"connectionId":"c1","operation":"bulk-insert","table":"t_dbport_a","dataPath":"vars.nothing"}`:                                                 "No array data found at path: vars.nothing (got undefined)",
		`{"connectionId":"c1","operation":"bulk-insert","table":"t_dbport_zz","dataPath":"vars.rows","fileColumns":["id"]}`:                              "Database query failed: bulk-insert: table t_dbport_zz not found (or this connection is not PostgreSQL/Oracle)",
		`{"connectionId":"c1","operation":"bulk-insert","table":"t_dbport_a","dataPath":"vars.rows","fileColumns":["id"],"importMode":"delete-by-key"}`:  "Database query failed: Import mode \"delete-by-key\" requires deleteKeys[] — list at least one column to match for deletion.",
		`{"connectionId":"missing","sql":"SELECT 1"}`:                                                                                                    "Connection not found: missing",
	} {
		_, err := run(data)
		if err == nil || err.Error() != want {
			t.Errorf("%s\n got %v\nwant %s", data, err, want)
		}
	}

	// connection status and unreachable server
	r2, stop2 := dbTestRun(t, cfg, "Inactive")
	defer stop2()
	if _, err := execDatabase(r2, dbTestNode(t, `{"connectionId":"c2"}`), ctx); err == nil || err.Error() != "Connection is not active: Local PG (status: Inactive)" {
		t.Errorf("status: %v", err)
	}
	bad := map[string]any{"type": "postgresql", "host": "localhost", "port": 1.0, "database": "postgres", "username": "postgres", "password": ""}
	r3, stop3 := dbTestRun(t, bad, "Connected")
	defer stop3()
	_, err = execDatabase(r3, dbTestNode(t, `{"connectionId":"c3"}`), ctx)
	if err == nil || err.Error() != "Cannot connect to database server (\nInvalid `prisma.$queryRawUnsafe()` invocation:\n\n\nCan't reach database server at `localhost:1`\n\nPlease make sure your database server is running at `localhost:1`.). Please check if database is running." {
		t.Errorf("unreachable: %v", err)
	}
}
