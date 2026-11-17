package main

// PostgreSQL side of the database executor. The TS executor goes through
// Prisma ($queryRawUnsafe / $executeRawUnsafe); this file reproduces what
// Prisma does with parameters (JS strings bind as text, integers as int8,
// fractions as numeric), with result values (int8 → BigInt → toJsonSafe,
// numeric → Decimal → string, dates → ISO strings, bytea → Uint8Array) and
// with error messages ("\nInvalid `prisma.$queryRawUnsafe()` invocation:…").

import (
	"context"
	"errors"
	"fmt"
	"math"
	"net"
	"net/netip"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	dbPgMu    sync.Mutex
	dbPgPools = map[string]*dbPg{}
)

type dbPg struct {
	pool             *pgxpool.Pool
	host, user, db   string
	port             string
	connectStringErr error
}

// dbPgQuerier is a pool or a transaction.
type dbPgQuerier interface{}

// dbPgConn returns the connection to run on (from the pool, or the
// transaction's) and a release func.
func dbPgConn(q dbPgQuerier) (*pgx.Conn, func(), error) {
	switch t := q.(type) {
	case pgx.Tx:
		return t.Conn(), func() {}, nil
	case *pgxpool.Pool:
		c, err := t.Acquire(context.Background())
		if err != nil {
			return nil, nil, err
		}
		return c.Conn(), c.Release, nil
	}
	return nil, nil, errors.New("engine: no PostgreSQL connection")
}

// dbPgParams encodes JS values the way Prisma sends them: text-format
// values with a declared type (string → text, integer → int8, fraction →
// numeric, boolean → bool, Date → timestamptz, object → json text), null
// untyped.
func dbPgParams(args []any) ([][]byte, []uint32) {
	vals := make([][]byte, len(args))
	oids := make([]uint32, len(args))
	for i, a := range args {
		switch t := a.(type) {
		case nil:
		case string:
			vals[i], oids[i] = []byte(t), pgtype.TextOID
		case bool:
			vals[i], oids[i] = []byte(strconv.FormatBool(t)), pgtype.BoolOID
		case float64:
			if t == math.Trunc(t) && math.Abs(t) < 9.2e18 {
				vals[i], oids[i] = []byte(strconv.FormatInt(int64(t), 10)), pgtype.Int8OID
			} else if math.IsNaN(t) || math.IsInf(t, 0) {
				vals[i], oids[i] = []byte(jsNumber(t)), pgtype.Float8OID
			} else {
				vals[i], oids[i] = []byte(strconv.FormatFloat(t, 'f', -1, 64)), pgtype.NumericOID
			}
		case int64:
			vals[i], oids[i] = []byte(strconv.FormatInt(t, 10)), pgtype.Int8OID
		case int:
			vals[i], oids[i] = []byte(strconv.Itoa(t)), pgtype.Int8OID
		case time.Time:
			vals[i], oids[i] = []byte(t.UTC().Format("2006-01-02 15:04:05.000Z07:00")), pgtype.TimestamptzOID
		case map[string]any, []any:
			vals[i], oids[i] = []byte(dbJSONString(t)), pgtype.JSONOID
		default:
			vals[i], oids[i] = []byte(dbJSString(t)), pgtype.TextOID
		}
	}
	return vals, oids
}

// dbPgClient returns the cached pool of a connection (getPrismaClient).
func dbPgClient(connID string, cfg map[string]any) *dbPg {
	dbPgMu.Lock()
	defer dbPgMu.Unlock()
	if c, ok := dbPgPools[connID]; ok {
		return c
	}
	port := "5432"
	if p, ok := cfg["port"]; ok && truthy(p) {
		port = jsString(p)
	}
	ssl := ""
	if truthy(cfg["ssl"]) {
		ssl = "?sslmode=require"
	}
	url := fmt.Sprintf("postgresql://%s:%s@%s:%s/%s%s", jsString(cfg["username"]), jsString(cfg["password"]),
		jsString(cfg["host"]), port, jsString(cfg["database"]), ssl)
	c := &dbPg{host: jsString(cfg["host"]), port: port, user: jsString(cfg["username"]), db: jsString(cfg["database"])}
	pc, err := pgxpool.ParseConfig(url)
	if err != nil {
		c.connectStringErr = err
	} else {
		pc.MaxConnIdleTime = 5 * time.Minute
		c.pool, c.connectStringErr = pgxpool.NewWithConfig(context.Background(), pc)
	}
	dbPgPools[connID] = c
	return c
}

// dbPgQuery is client.$queryRawUnsafe(sql, ...args): rows as plain objects.
func dbPgQuery(c *dbPg, q dbPgQuerier, sql string, args ...any) ([]any, error) {
	const m = "$queryRawUnsafe"
	if c.connectStringErr != nil {
		return nil, c.prismaErr(m, c.connectStringErr)
	}
	conn, release, err := dbPgConn(q)
	if err != nil {
		return nil, c.prismaErr(m, err)
	}
	defer release()
	vals, oids := dbPgParams(args)
	rr := conn.PgConn().ExecParams(context.Background(), sql, vals, oids, nil, nil)
	rows := pgx.RowsFromResultReader(conn.TypeMap(), rr)
	defer rows.Close()
	fields := rows.FieldDescriptions()
	names := make([]string, len(fields))
	for i, f := range fields {
		names[i] = f.Name
	}
	out := []any{}
	for rows.Next() {
		vs, err := rows.Values()
		if err != nil {
			return nil, c.prismaErr(m, err)
		}
		row := make(map[string]any, len(vs))
		for i, v := range vs {
			row[fields[i].Name] = dbPgValue(v)
		}
		jsOrder(row, names) // column order, like Prisma's row objects
		out = append(out, row)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, c.prismaErr(m, err)
	}
	return out, nil
}

// dbPgExec is client.$executeRawUnsafe(sql, ...args): affected row count.
func dbPgExec(c *dbPg, q dbPgQuerier, sql string, args ...any) (float64, error) {
	const m = "$executeRawUnsafe"
	if c.connectStringErr != nil {
		return 0, c.prismaErr(m, c.connectStringErr)
	}
	conn, release, err := dbPgConn(q)
	if err != nil {
		return 0, c.prismaErr(m, err)
	}
	defer release()
	vals, oids := dbPgParams(args)
	res := conn.PgConn().ExecParams(context.Background(), sql, vals, oids, nil, nil).Read()
	if res.Err != nil {
		return 0, c.prismaErr(m, res.Err)
	}
	return float64(res.CommandTag.RowsAffected()), nil
}

// dbPgValue turns a pgx value into what the Prisma value becomes after
// toJsonSafe and JSON serialisation.
func dbPgValue(v any) any {
	switch t := v.(type) {
	case nil, string, bool:
		return t
	case int16:
		return float64(t)
	case int32:
		return float64(t)
	case uint32:
		return float64(t)
	case int64:
		return dbSafeInt(t)
	case float32:
		f, _ := strconv.ParseFloat(strconv.FormatFloat(float64(t), 'g', -1, 32), 64)
		if math.IsNaN(f) || math.IsInf(f, 0) {
			return nil
		}
		return f
	case float64:
		if math.IsNaN(t) || math.IsInf(t, 0) {
			return nil
		}
		return t
	case pgtype.Numeric:
		if !t.Valid {
			return nil
		}
		if t.NaN {
			return "NaN"
		}
		if t.InfinityModifier == pgtype.Infinity {
			return "Infinity"
		}
		if t.InfinityModifier == pgtype.NegativeInfinity {
			return "-Infinity"
		}
		return dbDecimalString(t.Int, int(t.Exp))
	case time.Time:
		return t.UTC().Truncate(time.Millisecond) // a JS Date (ms precision): ISO in JSON, toString() in text
	case pgtype.Time:
		if !t.Valid {
			return nil
		}
		return time.Date(1970, 1, 1, 0, 0, 0, 0, time.UTC).Add(time.Duration(t.Microseconds) * time.Microsecond).Truncate(time.Millisecond)
	case [16]byte:
		return fmt.Sprintf("%x-%x-%x-%x-%x", t[0:4], t[4:6], t[6:8], t[8:10], t[10:16])
	case []byte:
		// Uint8Array → {"0":b0,"1":b1,…}
		m := make(map[string]any, len(t))
		for i, b := range t {
			m[strconv.Itoa(i)] = float64(b)
		}
		return m
	case netip.Prefix:
		if t.IsSingleIP() {
			return t.Addr().String()
		}
		return t.String()
	case netip.Addr:
		return t.String()
	case net.HardwareAddr:
		return t.String()
	case map[string]any:
		return t // json / jsonb, already decoded
	case []any:
		out := make([]any, len(t))
		for i, x := range t {
			out[i] = dbPgValue(x)
		}
		return out
	case fmt.Stringer:
		return t.String()
	}
	return fmt.Sprint(v)
}

var (
	dbPgArgCount  = regexp.MustCompile(`expected (\d+) arguments, got (\d+)`)
	dbPgBindCount = regexp.MustCompile(`bind message supplies (\d+) parameters, but prepared statement "[^"]*" requires (\d+)`)
)

// prismaErr words a driver error the way Prisma's raw-query errors read.
func (c *dbPg) prismaErr(method string, err error) error {
	head := "\nInvalid `prisma." + method + "()` invocation:\n\n\n"
	var pe *pgconn.PgError
	var ce *pgconn.ConnectError
	if errors.As(err, &ce) {
		hostPort := c.host + ":" + c.port
		if errors.As(err, &pe) {
			switch pe.Code {
			case "28P01", "28000":
				return &dbError{msg: head + fmt.Sprintf("Authentication failed against database server at `%s`, the provided database credentials for `%s` are not valid.\n\nPlease make sure to provide valid database credentials for the database server at `%s`.", c.host, c.user, c.host)}
			case "3D000":
				return &dbError{msg: head + fmt.Sprintf("Database `%s` does not exist", c.db)}
			}
			return &dbError{msg: head + pe.Message}
		}
		return &dbError{msg: head + fmt.Sprintf("Can't reach database server at `%s`\n\nPlease make sure your database server is running at `%s`.", hostPort, hostPort)}
	}
	if errors.As(err, &pe) && pe.Code == "08P01" {
		if m := dbPgBindCount.FindStringSubmatch(pe.Message); m != nil {
			return &dbError{msg: head + "Your raw query had an incorrect number of parameters. Expected: `" + m[2] + "`, actual: `" + m[1] + "`."}
		}
	}
	if errors.As(err, &pe) {
		msg := ""
		switch pe.Code {
		case "23505", "23502", "23503":
			msg = pe.Detail
			if msg == "" {
				msg = pe.Message
			}
		case "42P01", "42703":
			msg = pe.Message
		default:
			msg = pe.Severity + ": " + pe.Message
			if pe.Detail != "" {
				msg += "\nDETAIL: " + pe.Detail
			}
			if pe.Hint != "" {
				msg += "\nHINT: " + pe.Hint
			}
		}
		return &dbError{msg: head + "Raw query failed. Code: `" + pe.Code + "`. Message: `" + msg + "`"}
	}
	if m := dbPgArgCount.FindStringSubmatch(err.Error()); m != nil {
		return &dbError{msg: head + "Your raw query had an incorrect number of parameters. Expected: `" + m[1] + "`, actual: `" + m[2] + "`."}
	}
	var ne net.Error
	if errors.As(err, &ne) {
		hostPort := c.host + ":" + c.port
		return &dbError{msg: head + fmt.Sprintf("Can't reach database server at `%s`\n\nPlease make sure your database server is running at `%s`.", hostPort, hostPort)}
	}
	return &dbError{msg: head + err.Error()}
}

// dbPgColumnTypes ports pgColumnTypes: column -> udt_name, empty on error.
func dbPgColumnTypes(c *dbPg, q dbPgQuerier, table string) map[string]string {
	out := map[string]string{}
	parts := strings.Split(strings.ReplaceAll(table, `"`, ""), ".")
	name := parts[len(parts)-1]
	var rows []any
	var err error
	if len(parts) > 1 {
		rows, err = dbPgQuery(c, q, "SELECT column_name, udt_name FROM information_schema.columns WHERE table_name = $1 AND table_schema = $2", name, parts[0])
	} else {
		rows, err = dbPgQuery(c, q, "SELECT column_name, udt_name FROM information_schema.columns WHERE table_name = $1", name)
	}
	if err != nil {
		return out
	}
	for _, r := range rows {
		m := asMap(r)
		out[jsString(m["column_name"])] = jsString(m["udt_name"])
	}
	return out
}

var dbTypeName = regexp.MustCompile(`(?i)^[a-z0-9_]+$`)

// dbCast ports castPlaceholder.
func dbCast(n int, column string, types map[string]string) string {
	t, ok := types[strings.ReplaceAll(column, `"`, "")]
	if ok && t != "" && dbTypeName.MatchString(t) {
		return "$" + strconv.Itoa(n) + "::" + t
	}
	return "$" + strconv.Itoa(n)
}
