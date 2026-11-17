package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestFileportBasket writes into a throw-away basket (t_fileport_*) in the
// local app database and checks the rows Prisma would have written. Every row
// it creates is deleted at the end.
func TestFileportBasket(t *testing.T) {
	if os.Getenv("DATABASE_URL") == "" {
		os.Setenv("DATABASE_URL", "postgresql://postgres@localhost:55500/postgres")
	}
	if _, err := appQuery(`SELECT 1 FROM baskets LIMIT 1`); err != nil {
		t.Skipf("app database not reachable: %v", err)
	}
	// column types (timestamps without time zone, as Prisma creates them)
	cols, err := appQuery(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'processing_sessions' AND column_name = 'startedAt'`)
	if err != nil || len(cols) == 0 || cols[0]["data_type"] != "timestamp without time zone" {
		t.Fatalf("unexpected processing_sessions.startedAt type: %v %v", cols, err)
	}

	dir := t.TempDir()
	stamp := time.Now().Format("150405")
	projectID, batchID, sharesID, sftpID := newCUID(), newCUID(), newCUID(), newCUID()
	mustExec := func(sql string, args ...any) {
		t.Helper()
		if _, err := appExec(sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	now := time.Now().UTC()
	mustExec(`INSERT INTO projects (id, name, "createdAt", "updatedAt") VALUES ($1, $2, $3, $3)`, projectID, "t_fileport_"+stamp, now)
	t.Cleanup(func() {
		appExec(`DELETE FROM baskets WHERE "projectId" = $1`, projectID)
		appExec(`DELETE FROM projects WHERE id = $1`, projectID)
	})
	for _, b := range []struct{ id, typ, pattern, auto string }{
		{batchID, "batch", "T-{BYYYY}-{MM}-{SEQ}", "manual"},
		{sharesID, "shares", "x", "manual"},
		{sftpID, "sftp", "x", "manual"},
	} {
		mustExec(`INSERT INTO baskets (id, "projectId", name, path, type, "sessionPattern", "autoPublish", "createdAt", "updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)`,
			b.id, projectID, "t_fileport_"+b.typ+"_"+stamp, filepath.Join(dir, b.typ), b.typ, b.pattern, b.auto, now)
	}

	rows := []any{map[string]any{"a": "1", "b": "ก"}}
	run := func(data map[string]any) (map[string]any, error) {
		req := &ExecuteRequest{Flow: Flow{OperationID: "op_fileport"}}
		r := newRun(req, func(map[string]any) {})
		ctx := &Ctx{ID: "c0", Input: map[string]any{}, Vars: map[string]any{"rows": rows, "round": "แผน"}, dirty: map[string]bool{}, run: r}
		out, err := execFileWrite(r, &Node{ID: "n1", Type: "file-write", Data: data}, ctx)
		if err != nil {
			return nil, err
		}
		return out.(map[string]any), nil
	}
	base := func(extra map[string]any) map[string]any {
		d := map[string]any{"format": "csv", "destination": "basket", "basketId": batchID, "fileName": "out.csv", "dataPath": "vars.rows"}
		for k, v := range extra {
			d[k] = v
		}
		return d
	}
	by := time.Now().Year() + 543
	mm := time.Now().Format("01")

	// always_new twice → T-<BE>-<MM>-001, -002
	o1, err := run(base(nil))
	if err != nil {
		t.Fatal(err)
	}
	o2, err := run(base(nil))
	if err != nil {
		t.Fatal(err)
	}
	want1 := "T-" + itoa(by) + "-" + mm + "-001"
	want2 := "T-" + itoa(by) + "-" + mm + "-002"
	if o1["sessionName"] != want1 || o2["sessionName"] != want2 {
		t.Fatalf("session names %v %v, want %s %s", o1["sessionName"], o2["sessionName"], want1, want2)
	}
	if o1["autoPublished"] != false || o1["publishResult"] != nil || o1["basketName"] != "t_fileport_batch_"+stamp || o1["size"] != float64(len("a,b\n1,ก\n")) {
		t.Fatalf("output: %v", o1)
	}
	if b, _ := os.ReadFile(o1["filePath"].(string)); string(b) != "a,b\n1,ก\n" {
		t.Fatalf("file content %q", b)
	}
	if o1["filePath"] != filepath.Join(dir, "batch", "sessions", want1, "out.csv") {
		t.Fatalf("file path %v", o1["filePath"])
	}
	f, _ := appQuery(`SELECT "basketId","sessionId","fileName","originalName",size,"mimeType",status,metadata FROM basket_files WHERE id = $1`, o1["fileId"])
	if len(f) != 1 || f[0]["status"] != "uploaded" || f[0]["mimeType"] != "text/csv" || f[0]["sessionId"] != o1["sessionId"] || fioDBNum(f[0]["size"]) != o1["size"] ||
		!strings.HasPrefix(f[0]["metadata"].(string), `{"source":"flow","flowId":"op_fileport","generatedAt":"`) {
		t.Fatalf("basket_files row: %v", f)
	}
	s, _ := appQuery(`SELECT status,"publishMode","fileCount","totalSize" FROM processing_sessions WHERE id = $1`, o1["sessionId"])
	if len(s) != 1 || s[0]["status"] != "open" || s[0]["publishMode"] != "manual" || fioDBNum(s[0]["fileCount"]) != 1.0 || fioDBNum(s[0]["totalSize"]) != o1["size"] {
		t.Fatalf("session row: %v", s)
	}
	sl, _ := appQuery(`SELECT type, message, metadata FROM session_logs WHERE "sessionId" = $1`, o1["sessionId"])
	if len(sl) != 1 || sl[0]["type"] != "session_created" || sl[0]["message"] != "Processing session "+want1+" created (auto)" ||
		sl[0]["metadata"] != `{"path":"`+filepath.Join(dir, "batch", "sessions", want1)+`","source":"file-write"}` {
		t.Fatalf("session log: %v", sl)
	}
	fl, _ := appQuery(`SELECT action, status, message, metadata FROM basket_file_logs WHERE "fileId" = $1`, o1["fileId"])
	if len(fl) != 1 || fl[0]["message"] != "File out.csv created via flow" || !strings.HasPrefix(fl[0]["metadata"].(string), `{"size":`) {
		t.Fatalf("file log: %v", fl)
	}

	// existing_or_new with a stable name (resolved {{round}}) → creates then reuses + overwrites
	e1, err := run(base(map[string]any{"sessionMode": "existing_or_new", "sessionNamePattern": "{{round}}", "fileName": "same.csv"}))
	if err != nil {
		t.Fatal(err)
	}
	e2, err := run(base(map[string]any{"sessionMode": "existing_or_new", "sessionNamePattern": "{{round}}", "fileName": "same.csv", "autoPublish": true}))
	if err != nil {
		t.Fatal(err)
	}
	if e1["sessionName"] != "แผน" || e2["sessionId"] != e1["sessionId"] {
		t.Fatalf("existing_or_new: %v %v", e1, e2)
	}
	cnt, _ := appQuery(`SELECT count(*)::int AS n FROM basket_files WHERE "sessionId" = $1`, e1["sessionId"])
	if fioDBNum(cnt[0]["n"]) != 1.0 {
		t.Fatalf("overwrite left %v files", cnt)
	}
	pr, _ := e2["publishResult"].(map[string]any)
	if e2["autoPublished"] != true || pr["success"] != true {
		t.Fatalf("publish: %v", e2)
	}
	s, _ = appQuery(`SELECT status,"fileCount" FROM processing_sessions WHERE id = $1`, e1["sessionId"])
	if s[0]["status"] != "published" || fioDBNum(s[0]["fileCount"]) != 1.0 {
		t.Fatalf("published session: %v", s)
	}
	logs, _ := appQuery(`SELECT type FROM session_logs WHERE "sessionId" = $1 ORDER BY "createdAt"`, e1["sessionId"])
	if len(logs) != 3 || logs[1]["type"] != "files_deleted" || logs[2]["type"] != "session_published" {
		t.Fatalf("logs: %v", logs)
	}

	// reuse_existing picks the newest open session
	r1, err := run(base(map[string]any{"sessionMode": "reuse_existing", "fileName": "r.csv"}))
	if err != nil || r1["sessionId"] != o2["sessionId"] {
		t.Fatalf("reuse_existing: %v %v", r1, err)
	}

	// encodings: Buffer encodings work, iconv-only names fail like Node
	if _, err := run(base(map[string]any{"encoding": "latin1", "fileName": "l.csv"})); err != nil {
		t.Fatal(err)
	}
	if _, err := run(base(map[string]any{"encoding": "tis620", "fileName": "t.csv"})); err == nil || err.Error() != "The argument 'tis620' is invalid encoding. Received 'encoding'" {
		t.Fatalf("tis620 write: %v", err)
	}

	// shares and sftp baskets
	sh, err := run(base(map[string]any{"basketId": sharesID, "targetFolder": "in/2567", "fileName": "s.txt", "format": "txt"}))
	if err != nil || sh["basketType"] != "shares" || sh["filePath"] != filepath.Join(dir, "shares", "in/2567", "s.txt") || sh["targetFolder"] != "in/2567" {
		t.Fatalf("shares: %v %v", sh, err)
	}
	sf, err := run(base(map[string]any{"basketId": sftpID, "fileName": "f.json", "format": "json"}))
	if err != nil || sf["basketType"] != "sftp" || sf["filePath"] != filepath.Join(dir, "sftp", "f.json") {
		t.Fatalf("sftp basket: %v %v", sf, err)
	}
	f, _ = appQuery(`SELECT "sessionId", "mimeType", metadata FROM basket_files WHERE id = $1`, sf["fileId"])
	if f[0]["sessionId"] != nil || f[0]["mimeType"] != "application/json" || !strings.Contains(f[0]["metadata"].(string), `"basketType":"sftp"`) {
		t.Fatalf("sftp basket row: %v", f)
	}

	// file-read from the basket: specific session, latest, status filter
	read := func(d map[string]any) (map[string]any, error) {
		req := &ExecuteRequest{Flow: Flow{OperationID: "op_fileport"}}
		r := newRun(req, func(map[string]any) {})
		ctx := &Ctx{ID: "c0", Input: map[string]any{}, Vars: map[string]any{}, dirty: map[string]bool{}, run: r}
		out, err := execFileRead(r, &Node{ID: "n2", Type: "file-read", Data: d}, ctx)
		if err != nil {
			return nil, err
		}
		return out.(map[string]any), nil
	}
	rd, err := read(map[string]any{"source": "basket", "basketId": batchID, "sessionSource": "specific", "sessionId": o1["sessionId"], "parseAs": "csv", "filePattern": "*.csv"})
	if err != nil || rd["filesFound"] != 1.0 {
		t.Fatalf("read specific: %v %v", rd, err)
	}
	if d := rd["data"].([]any); d[0].(map[string]any)["b"] != "ก" {
		t.Fatalf("read data: %v", rd["data"])
	}
	// latest = the empty session the failed tis620 write left behind (as in TS)
	if _, err := read(map[string]any{"source": "basket", "basketId": batchID, "sessionSource": "latest", "parseAs": "list"}); err == nil || err.Error() != "No files found to read" {
		t.Fatalf("read latest: %v", err)
	}
	ra, err := read(map[string]any{"source": "basket", "basketId": batchID, "parseAs": "list", "fileStatus": "published"})
	if err != nil || ra["filesFound"] != 1.0 {
		t.Fatalf("read published: %v %v", ra, err)
	}
	if _, err := read(map[string]any{"source": "basket", "basketId": "nope_" + stamp}); err == nil || err.Error() != "Basket not found: nope_"+stamp {
		t.Fatalf("missing basket: %v", err)
	}
	if _, err := read(map[string]any{"source": "basket", "basketId": batchID, "sessionSource": "trigger"}); err == nil || err.Error() != "No files found to read" {
		t.Fatalf("trigger without context: %v", err)
	}

	// zip from the basket's latest session into the shares basket
	z, err := run(map[string]any{"format": "zip", "destination": "basket", "basketId": sharesID, "fileName": "bundle", "sourceBasketId": batchID, "sourceSessionId": o1["sessionId"], "targetFolder": "zip/{BYYYY}"})
	if err != nil || z["filesCollected"] == 0.0 || z["targetFolder"] != "zip/"+itoa(by) {
		t.Fatalf("zip: %v %v", z, err)
	}
}

func itoa(n int) string { return fioNum(float64(n)) }
