package main

// Basket destinations of FileWriteExecutor.ts: batch baskets (processing
// sessions with name patterns, {SEQ} counters, overwrite-by-name, auto
// publish), shares baskets (target folder) and sftp baskets (flat folder).
// Rows go to the same tables Prisma writes (baskets, processing_sessions,
// session_logs, basket_files, basket_file_logs).

import (
	"context"
	"errors"
	"fmt"
	"log"
	"math/rand"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

type fioBasketRow struct {
	id, name, path, typ, sessionPattern, autoPublish string
}

func fioLoadBasket(id string) (*fioBasketRow, error) {
	rows, err := appQuery(`SELECT id, name, path, type, "sessionPattern", "autoPublish" FROM baskets WHERE id = $1`, id)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, nil
	}
	s := func(k string) string { v, _ := rows[0][k].(string); return v }
	return &fioBasketRow{id: s("id"), name: s("name"), path: s("path"), typ: s("type"), sessionPattern: s("sessionPattern"), autoPublish: s("autoPublish")}, nil
}

func fioFlowID(r *Run) any {
	if r == nil || r.flow == nil || r.flow.OperationID == "" {
		return fioUndef
	}
	return r.flow.OperationID
}

func fioNowDB() time.Time { return time.Now().UTC().Truncate(time.Millisecond) }

func fioWriteBasket(r *Run, ctx *Ctx, c fioContent, fileName string, d map[string]any) (map[string]any, error) {
	if !fioTruthy(d["basketId"]) {
		return nil, errors.New("Basket ID is required")
	}
	basketID := fioStr(d["basketId"])
	basket, err := fioLoadBasket(basketID)
	if err != nil {
		return nil, err
	}
	if basket == nil {
		return nil, fmt.Errorf("Basket not found: %s", basketID)
	}
	if basket.typ == "shares" || d["basketType"] == "shares" {
		return fioWriteShares(r, c, fileName, d, basket)
	}
	if basket.typ == "sftp" || d["basketType"] == "sftp" {
		return fioWriteSftpBasket(r, c, fileName, d, basket)
	}

	var sessionID, batchName string
	mode := fioStrOr(d, "sessionMode", "always_new")
	rawPattern := fioStrOr(d, "sessionNamePattern", "")
	if rawPattern == "" {
		rawPattern = basket.sessionPattern
	}
	if rawPattern == "" {
		rawPattern = "Batch-{YYYYMMDD}-{SEQ}"
	}

	switch mode {
	case "reuse_existing":
		rows, err := appQuery(`SELECT id, "batchName" FROM processing_sessions WHERE "basketId" = $1 AND status = 'open' ORDER BY "startedAt" DESC LIMIT 1`, basketID)
		if err != nil {
			return nil, err
		}
		if len(rows) == 0 {
			return nil, errors.New("No open session found for basket. Please create a session first or use different session mode.")
		}
		sessionID, _ = rows[0]["id"].(string)
		batchName, _ = rows[0]["batchName"].(string)
		fioClearFilesByName(sessionID, fileName)

	case "existing_or_new":
		resolved := fioWriteTemplate(r, ctx, rawPattern)
		unresolved := regexp.MustCompile(`\{\{[^}]+\}\}`).MatchString(resolved)
		stable := !unresolved && !regexp.MustCompile(`\{[A-Za-z0-9+_]+\}`).MatchString(resolved)
		var (
			id, name string
			created  bool
			lastErr  error
			done     bool
		)
		for attempt := 1; attempt <= 5; attempt++ {
			id, name, created, lastErr = fioFindOrCreateSession(basket, resolved, stable)
			if lastErr == nil {
				done = true
				break
			}
			msg := lastErr.Error()
			if !(strings.Contains(msg, "write conflict") || strings.Contains(msg, "deadlock") || strings.Contains(msg, "P2034") || strings.Contains(msg, "could not serialize")) {
				return nil, lastErr
			}
			backoff := 50*attempt + rand.Intn(100)
			log.Printf("[FileWrite] Session txn conflict (attempt %d/5), retrying in %dms…", attempt, backoff)
			time.Sleep(time.Duration(backoff) * time.Millisecond)
		}
		if !done {
			if lastErr == nil {
				lastErr = errors.New("Session creation failed after 5 retries")
			}
			return nil, lastErr
		}
		sessionID, batchName = id, name
		if !created {
			fioClearFilesByName(sessionID, fileName)
		}

	default:
		pattern := fioWriteTemplate(r, ctx, rawPattern)
		gen, err := fioBatchNameWithSeq(pattern, basketID, pattern)
		if err != nil {
			return nil, err
		}
		id, name, err := fioCreateSession(basket, gen)
		if err != nil {
			return nil, err
		}
		sessionID, batchName = id, name
	}

	sessionDir := fioJoin(basket.path, "sessions", batchName)
	filePath := fioJoin(sessionDir, fileName)
	if !fioExists(sessionDir) {
		if err := fioMkdirAll(sessionDir); err != nil {
			return nil, err
		}
	}
	b, err := fioEncoded(c, d)
	if err != nil {
		return nil, err
	}
	if err := fioWriteFile(filePath, b); err != nil {
		return nil, err
	}
	st, err := fioStat(filePath)
	if err != nil {
		return nil, err
	}
	size := st.Size()
	now := fioNowDB()
	flowID := fioFlowID(r)
	fileID := newCUID()
	meta := fioJSON(fioObj("source", "flow", "flowId", flowID, "generatedAt", fioISO(now)), "")
	if _, err := appExec(`INSERT INTO basket_files (id, "basketId", "sessionId", "fileName", "originalName", size, "mimeType", path, status, metadata, "createdAt", "updatedAt")
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'uploaded',$9,$10,$10)`,
		fileID, basketID, sessionID, fileName, fileName, size, fioMime(fileName, d["contentType"]), filePath, meta, now); err != nil {
		return nil, err
	}
	if _, err := appExec(`UPDATE processing_sessions SET "fileCount" = "fileCount" + 1, "totalSize" = "totalSize" + $2 WHERE id = $1`, sessionID, size); err != nil {
		return nil, err
	}
	if err := fioFileLog(fileID, fmt.Sprintf("File %s created via flow", fileName),
		fioObj("size", float64(size), "sessionId", sessionID, "flowId", flowID)); err != nil {
		return nil, err
	}

	var autoPub any
	if v, ok := d["autoPublish"]; ok {
		autoPub = v
	} else {
		autoPub = basket.autoPublish == "auto"
	}
	var publishResult any
	if fioTruthy(autoPub) {
		publishResult = fioPublishSession(sessionID)
	}
	return om(
		"basketId", basketID, "basketName", basket.name, "sessionId", sessionID, "sessionName", batchName,
		"fileId", fileID, "filePath", filePath, "size", float64(size), "autoPublished", autoPub, "publishResult", publishResult,
	), nil
}

func fioFileLog(fileID, msg string, meta *fioOrdered) error {
	_, err := appExec(`INSERT INTO basket_file_logs (id, "fileId", action, status, message, metadata, "createdAt") VALUES ($1,$2,'file_created','success',$3,$4,$5)`,
		newCUID(), fileID, msg, fioJSON(meta, ""), fioNowDB())
	return err
}

func fioSessionLog(q func(string, ...any) error, sessionID, typ, msg string, meta *fioOrdered) error {
	return q(`INSERT INTO session_logs (id, "sessionId", type, message, metadata, "createdAt") VALUES ($1,$2,$3,$4,$5,$6)`,
		newCUID(), sessionID, typ, msg, fioJSON(meta, ""), fioNowDB())
}

func fioExecQ(sql string, args ...any) error {
	_, err := appExec(sql, args...)
	return err
}

func fioPublishMode(b *fioBasketRow) string {
	if b.autoPublish == "auto" {
		return "auto"
	}
	return "manual"
}

// fioFindOrCreateSession is the serializable transaction of existing_or_new.
func fioFindOrCreateSession(basket *fioBasketRow, resolved string, stable bool) (string, string, bool, error) {
	pool, err := appDB()
	if err != nil {
		return "", "", false, err
	}
	bg := context.Background()
	tx, err := pool.BeginTx(bg, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return "", "", false, err
	}
	defer tx.Rollback(bg)

	var id, name string
	if stable {
		err = tx.QueryRow(bg, `SELECT id, "batchName" FROM processing_sessions WHERE "basketId" = $1 AND status = 'open' AND "batchName" = $2 ORDER BY "startedAt" DESC LIMIT 1`, basket.id, resolved).Scan(&id, &name)
	} else {
		err = tx.QueryRow(bg, `SELECT id, "batchName" FROM processing_sessions WHERE "basketId" = $1 AND status = 'open' ORDER BY "startedAt" DESC LIMIT 1`, basket.id).Scan(&id, &name)
	}
	if err == nil {
		if err := tx.Commit(bg); err != nil {
			return "", "", false, err
		}
		return id, name, false, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return "", "", false, err
	}

	gen, err := fioBatchNameWithSeq(resolved, basket.id, resolved)
	if err != nil {
		return "", "", false, err
	}
	unique := gen
	for suffix := 1; ; suffix++ {
		var x string
		err := tx.QueryRow(bg, `SELECT id FROM processing_sessions WHERE "batchName" = $1 AND "basketId" = $2 LIMIT 1`, unique, basket.id).Scan(&x)
		if errors.Is(err, pgx.ErrNoRows) {
			break
		}
		if err != nil {
			return "", "", false, err
		}
		unique = fmt.Sprintf("%s-%d", gen, suffix)
	}
	sessionPath := fioJoin(basket.path, "sessions", unique)
	if err := fioMkdirAll(sessionPath); err != nil {
		return "", "", false, err
	}
	id = newCUID()
	q := func(sql string, args ...any) error { _, err := tx.Exec(bg, sql, args...); return err }
	if err := q(`INSERT INTO processing_sessions (id, "basketId", "batchName", status, "publishMode", "fileCount", "totalSize", "startedAt") VALUES ($1,$2,$3,'open',$4,0,0,$5)`,
		id, basket.id, unique, fioPublishMode(basket), fioNowDB()); err != nil {
		return "", "", false, err
	}
	if err := fioSessionLog(q, id, "session_created", fmt.Sprintf("Processing session %s created (auto)", unique),
		fioObj("path", sessionPath, "source", "file-write")); err != nil {
		return "", "", false, err
	}
	if err := tx.Commit(bg); err != nil {
		return "", "", false, err
	}
	return id, unique, true, nil
}

// fioCreateSession is createProcessingSession.
func fioCreateSession(basket *fioBasketRow, baseName string) (string, string, error) {
	final, err := fioProcessSeq(baseName, basket.id, baseName)
	if err != nil {
		return "", "", err
	}
	unique := final
	for suffix := 1; ; suffix++ {
		rows, err := appQuery(`SELECT id FROM processing_sessions WHERE "batchName" = $1 AND "basketId" = $2 LIMIT 1`, unique, basket.id)
		if err != nil {
			return "", "", err
		}
		if len(rows) == 0 {
			break
		}
		unique = fmt.Sprintf("%s-%d", final, suffix)
	}
	sessionPath := fioJoin(basket.path, "sessions", unique)
	if err := fioMkdirAll(sessionPath); err != nil {
		return "", "", err
	}
	id := newCUID()
	if err := fioExecQ(`INSERT INTO processing_sessions (id, "basketId", "batchName", status, "publishMode", "fileCount", "totalSize", "startedAt") VALUES ($1,$2,$3,'open',$4,0,0,$5)`,
		id, basket.id, unique, fioPublishMode(basket), fioNowDB()); err != nil {
		return "", "", err
	}
	if err := fioSessionLog(fioExecQ, id, "session_created", fmt.Sprintf("Processing session %s created (auto)", unique),
		fioObj("path", sessionPath, "source", "file-write")); err != nil {
		return "", "", err
	}
	return id, unique, nil
}

// fioBatchName is generateBatchName.
func fioBatchName(pattern string, now time.Time) string {
	y := now.Year()
	by := y + 543
	ys, bys := strconv.Itoa(y), strconv.Itoa(by)
	reps := [][2]string{
		{"{YYYY+543}", bys}, {"{BYYYY}", bys}, {"{YYYY}", ys},
		{"{YY}", ys[len(ys)-2:]}, {"{BYY}", bys[len(bys)-2:]},
		{"{MM}", fioPad2(int(now.Month()))}, {"{DD}", fioPad2(now.Day())},
		{"{YYYYMMDD}", now.UTC().Format("20060102")},
		{"{HH}", fioPad2(now.Hour())}, {"{mm}", fioPad2(now.Minute())}, {"{ss}", fioPad2(now.Second())},
		{"{HHMMSS}", now.Format("150405")},
	}
	name := pattern
	for _, rp := range reps {
		name = strings.ReplaceAll(name, rp[0], rp[1])
	}
	name = strings.Replace(name, "{NNN}", "{SEQ3}", 1)
	name = strings.Replace(name, "{NN}", "{SEQ2}", 1)
	name = strings.Replace(name, "{N}", "{SEQ1}", 1)
	return name
}

func fioBatchNameWithSeq(pattern, basketID, original string) (string, error) {
	return fioProcessSeq(fioBatchName(pattern, time.Now()), basketID, original)
}

var fioSeqRe = regexp.MustCompile(`\{SEQ(\d)?\}`)

// fioProcessSeq is processSequencePattern.
func fioProcessSeq(base, basketID, original string) (string, error) {
	m := fioSeqRe.FindStringSubmatchIndex(base)
	if m == nil {
		return base, nil
	}
	digits := 3
	if m[2] >= 0 {
		digits, _ = strconv.Atoi(base[m[2]:m[3]])
	}
	now := time.Now()
	var from time.Time
	switch {
	case strings.Contains(original, "{YYYY-MM-DD}"):
		from = time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.Local)
	case strings.Contains(original, "{YYYY-MM}") || strings.Contains(original, "{MM}"):
		from = time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.Local)
	case strings.Contains(original, "{YYYY+543}") || strings.Contains(original, "{BYYYY}") || strings.Contains(original, "{YYYY}"):
		from = time.Date(now.Year(), 1, 1, 0, 0, 0, 0, time.Local)
	default:
		from = time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.Local)
	}
	rows, err := appQuery(`SELECT count(*)::int AS n FROM processing_sessions WHERE "basketId" = $1 AND "startedAt" >= $2 AND status = ANY($3)`,
		basketID, from.UTC(), []string{"open", "published", "processing", "completed", "archived"})
	if err != nil {
		return "", err
	}
	count := 0
	if len(rows) > 0 {
		switch n := rows[0]["n"].(type) {
		case int32:
			count = int(n)
		case int64:
			count = int(n)
		}
	}
	seq := strconv.Itoa(count + 1)
	if digits != 1 && len(seq) < digits {
		seq = strings.Repeat("0", digits-len(seq)) + seq
	}
	return base[:m[0]] + seq + base[m[1]:], nil
}

// fioClearFilesByName is clearFilesByName (errors are only logged).
func fioClearFilesByName(sessionID, fileName string) {
	err := func() error {
		rows, err := appQuery(`SELECT id, path, size FROM basket_files WHERE "sessionId" = $1 AND "fileName" = $2`, sessionID, fileName)
		if err != nil {
			return err
		}
		if len(rows) == 0 {
			return nil
		}
		total := int64(0)
		for _, f := range rows {
			p, _ := f["path"].(string)
			if fioExists(p) {
				if err := os.Remove(p); err != nil {
					log.Printf("Failed to delete file %s: %v", p, fioFsErr(err))
					continue
				}
			}
			total += int64(fioToNumber(fioDBNum(f["size"])))
		}
		if _, err := appExec(`DELETE FROM basket_files WHERE "sessionId" = $1 AND "fileName" = $2`, sessionID, fileName); err != nil {
			return err
		}
		if _, err := appExec(`UPDATE processing_sessions SET "fileCount" = "fileCount" - $2, "totalSize" = "totalSize" - $3 WHERE id = $1`, sessionID, len(rows), total); err != nil {
			return err
		}
		if err := fioSessionLog(fioExecQ, sessionID, "files_deleted", fmt.Sprintf("Cleared %d file(s) with name '%s' before overwrite", len(rows), fileName),
			fioObj("fileName", fileName, "count", float64(len(rows)), "size", float64(total))); err != nil {
			return err
		}
		log.Printf("[FileWrite] Cleared %d file(s) with name '%s' from session %s", len(rows), fileName, sessionID)
		return nil
	}()
	if err != nil {
		log.Printf("Failed to clear files by name: %v", err)
	}
}

// fioPublishSession is publishSession.
func fioPublishSession(sessionID string) any {
	now := fioNowDB()
	n, err := appExec(`UPDATE processing_sessions SET status = 'published', "publishedAt" = $2 WHERE id = $1`, sessionID, now)
	if err == nil && n == 0 {
		err = errors.New("No record was found for an update.")
	}
	if err == nil {
		err = fioSessionLog(fioExecQ, sessionID, "session_published", "Session auto-published", fioObj("auto", true))
	}
	if err == nil {
		_, err = appExec(`UPDATE basket_files SET status = 'published', "updatedAt" = $2 WHERE "sessionId" = $1`, sessionID, now)
	}
	if err != nil {
		log.Printf("Failed to auto-publish session: %v", err)
		return om("success", false, "error", "Error: "+err.Error())
	}
	return om("success", true, "publishedAt", fioISO(now))
}

func fioWriteShares(r *Run, c fioContent, fileName string, d map[string]any, basket *fioBasketRow) (map[string]any, error) {
	target := fioStrOr(d, "targetFolder", "")
	dir := fioJoin(basket.path, target)
	filePath := fioJoin(dir, fileName)
	if !fioExists(dir) {
		if err := fioMkdirAll(dir); err != nil {
			return nil, err
		}
	}
	b, err := fioEncoded(c, d)
	if err != nil {
		return nil, err
	}
	if err := fioWriteFile(filePath, b); err != nil {
		return nil, err
	}
	st, err := fioStat(filePath)
	if err != nil {
		return nil, err
	}
	size := st.Size()
	now := fioNowDB()
	flowID := fioFlowID(r)
	fileID := newCUID()
	meta := fioJSON(fioObj("source", "flow", "flowId", flowID, "targetFolder", target, "generatedAt", fioISO(now)), "")
	if _, err := appExec(`INSERT INTO basket_files (id, "basketId", "sessionId", "fileName", "originalName", size, "mimeType", path, status, metadata, "createdAt", "updatedAt")
		VALUES ($1,$2,NULL,$3,$4,$5,$6,$7,'uploaded',$8,$9,$9)`,
		fileID, basket.id, fileName, fileName, size, fioMime(fileName, d["contentType"]), filePath, meta, now); err != nil {
		return nil, err
	}
	msg := "File " + fileName + " created in shares basket"
	if target != "" {
		msg += " folder: " + target
	}
	if err := fioFileLog(fileID, msg, fioObj("size", float64(size), "flowId", flowID, "targetFolder", target)); err != nil {
		return nil, err
	}
	return om(
		"basketId", basket.id, "basketName", basket.name, "basketType", "shares", "targetFolder", target,
		"fileId", fileID, "filePath", filePath, "size", float64(size), "timestamp", isoNow(),
	), nil
}

func fioWriteSftpBasket(r *Run, c fioContent, fileName string, d map[string]any, basket *fioBasketRow) (map[string]any, error) {
	dir := basket.path
	filePath := fioJoin(dir, fileName)
	if !fioExists(dir) {
		if err := fioMkdirAll(dir); err != nil {
			return nil, err
		}
	}
	b, err := fioEncoded(c, d)
	if err != nil {
		return nil, err
	}
	if err := fioWriteFile(filePath, b); err != nil {
		return nil, err
	}
	st, err := fioStat(filePath)
	if err != nil {
		return nil, err
	}
	size := st.Size()
	now := fioNowDB()
	flowID := fioFlowID(r)
	fileID := newCUID()
	meta := fioJSON(fioObj("source", "flow", "flowId", flowID, "basketType", "sftp", "generatedAt", fioISO(now)), "")
	if _, err := appExec(`INSERT INTO basket_files (id, "basketId", "sessionId", "fileName", "originalName", size, "mimeType", path, status, metadata, "createdAt", "updatedAt")
		VALUES ($1,$2,NULL,$3,$4,$5,$6,$7,'uploaded',$8,$9,$9)`,
		fileID, basket.id, fileName, fileName, size, fioMime(fileName, d["contentType"]), filePath, meta, now); err != nil {
		return nil, err
	}
	if err := fioFileLog(fileID, "File "+fileName+" created in SFTP basket", fioObj("size", float64(size), "flowId", flowID, "basketType", "sftp")); err != nil {
		return nil, err
	}
	return om(
		"basketId", basket.id, "basketName", basket.name, "basketType", "sftp",
		"fileId", fileID, "filePath", filePath, "size", float64(size), "timestamp", isoNow(),
	), nil
}
