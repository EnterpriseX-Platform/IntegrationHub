package main

// Application-DB access for the basket / sftp executors: the Prisma queries
// the TS executors run, written as SQL on the tables Prisma maps them to.

import (
	"fmt"
	"strings"
	"time"
)

// sbOne returns the first row of a query, or nil.
func sbOne(sql string, args ...any) (map[string]any, error) {
	rows, err := appQuery(sql, args...)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, nil
	}
	return rows[0], nil
}

func sbS(row map[string]any, k string) string {
	if row == nil {
		return ""
	}
	if s, ok := row[k].(string); ok {
		return s
	}
	return ""
}

func sbI(row map[string]any, k string) int64 {
	if row == nil {
		return 0
	}
	switch t := row[k].(type) {
	case int32:
		return int64(t)
	case int64:
		return t
	case int:
		return int64(t)
	case float64:
		return int64(t)
	}
	return 0
}

func sbT(row map[string]any, k string) (time.Time, bool) {
	if row == nil {
		return time.Time{}, false
	}
	t, ok := row[k].(time.Time)
	return t, ok
}

// sbJSRow turns a DB row into what a Prisma result looks like once it has
// gone through JSON: dates as ISO strings, ints as numbers.
func sbJSRow(row map[string]any) map[string]any {
	out := make(map[string]any, len(row))
	for k, v := range row {
		out[k] = sbJSVal(v)
	}
	copyOrder(out, row)
	return out
}

func sbJSVal(v any) any {
	switch t := v.(type) {
	case time.Time:
		return t.UTC() // Prisma gives Date objects; JSON makes them ISO strings
	case int32:
		return float64(t)
	case int64:
		return float64(t)
	case int:
		return float64(t)
	case int16:
		return float64(t)
	case []any:
		out := make([]any, len(t))
		for i, x := range t {
			out[i] = sbJSVal(x)
		}
		return out
	case []string:
		out := make([]any, len(t))
		for i, x := range t {
			out[i] = x
		}
		return out
	}
	return v
}

// sbNullStr maps "" to SQL NULL (Prisma `field: x || undefined` / null).
func sbNullStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// ── basket_files ─────────────────────────────────────────────────────────────

type sbFileRow struct {
	ID, BasketID, SessionID, FolderID string
	FileName, OriginalName, MimeType  string
	Path, Status, Metadata            string
	Size                              int64
	RemoteModifiedAt                  *time.Time
}

// sbCreateFile inserts a basket_files row (prisma.basketFile.create).
func sbCreateFile(f sbFileRow) (string, error) {
	if f.ID == "" {
		f.ID = newCUID()
	}
	if f.Status == "" {
		f.Status = "pending"
	}
	if f.Metadata == "" {
		f.Metadata = "{}"
	}
	now := sbNow()
	var rm any
	if f.RemoteModifiedAt != nil {
		rm = f.RemoteModifiedAt.UTC()
	}
	_, err := appExec(`INSERT INTO basket_files ("id","basketId","sessionId","folderId","fileName","originalName","size","mimeType","path","status","metadata","remoteModifiedAt","createdAt","updatedAt")
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)`,
		f.ID, f.BasketID, sbNullStr(f.SessionID), sbNullStr(f.FolderID), f.FileName, f.OriginalName, int32(f.Size), f.MimeType, f.Path, f.Status, f.Metadata, rm, now)
	if err != nil {
		return "", err
	}
	return f.ID, nil
}

// sbUpdate runs "UPDATE table SET cols... WHERE id" and fails like Prisma's
// update when the row does not exist.
func sbUpdate(table, id string, touch bool, set sbObj) error {
	var cols []string
	var args []any
	for _, kv := range set {
		args = append(args, kv.Val)
		cols = append(cols, fmt.Sprintf(`"%s"=$%d`, kv.Key, len(args)))
	}
	if touch {
		args = append(args, sbNow())
		cols = append(cols, fmt.Sprintf(`"updatedAt"=$%d`, len(args)))
	}
	args = append(args, id)
	n, err := appExec(fmt.Sprintf(`UPDATE %s SET %s WHERE "id"=$%d`, table, strings.Join(cols, ","), len(args)), args...)
	if err != nil {
		return err
	}
	if n == 0 {
		return fmt.Errorf("An operation failed because it depends on one or more records that were required but not found. Record to update not found.")
	}
	return nil
}

func sbDeleteByID(table, id string) error {
	n, err := appExec(fmt.Sprintf(`DELETE FROM %s WHERE "id"=$1`, table), id)
	if err != nil {
		return err
	}
	if n == 0 {
		return fmt.Errorf("An operation failed because it depends on one or more records that were required but not found. Record to delete does not exist.")
	}
	return nil
}

// ── processing_sessions / logs ──────────────────────────────────────────────

func sbCreateSession(basketID, batchName string, fileCount, totalSize int64) (map[string]any, error) {
	id := newCUID()
	now := sbNow()
	_, err := appExec(`INSERT INTO processing_sessions ("id","basketId","batchName","status","publishMode","fileCount","totalSize","startedAt")
		VALUES ($1,$2,$3,'open','manual',$4,$5,$6)`, id, basketID, batchName, int32(fileCount), int32(totalSize), now)
	if err != nil {
		return nil, err
	}
	return sbOne(`SELECT * FROM processing_sessions WHERE "id"=$1`, id)
}

func sbBasket(id string) (map[string]any, error) {
	return sbOne(`SELECT * FROM baskets WHERE "id"=$1`, id)
}

func sbCreateBasketLog(basketID, typ, msg string, fileCount, fileSize int64) error {
	_, err := appExec(`INSERT INTO basket_logs ("id","basketId","type","message","fileCount","fileSize","metadata","createdAt") VALUES ($1,$2,$3,$4,$5,$6,'{}',$7)`,
		newCUID(), basketID, typ, msg, int32(fileCount), int32(fileSize), sbNow())
	return err
}

func sbCreateSessionLog(sessionID, typ, msg, metadata string) error {
	_, err := appExec(`INSERT INTO session_logs ("id","sessionId","type","message","metadata","createdAt") VALUES ($1,$2,$3,$4,$5,$6)`,
		newCUID(), sessionID, typ, msg, metadata, sbNow())
	return err
}

func sbCreateFileLog(fileID, action, status, msg, metadata string) error {
	_, err := appExec(`INSERT INTO basket_file_logs ("id","fileId","action","status","message","metadata","createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7)`,
		newCUID(), fileID, action, status, msg, metadata, sbNow())
	return err
}

// ── basket_folders ──────────────────────────────────────────────────────────

func sbCreateFolder(basketID, name, path, parentID string) (map[string]any, error) {
	id := newCUID()
	now := sbNow()
	_, err := appExec(`INSERT INTO basket_folders ("id","basketId","name","path","parentId","createdAt","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$6)`,
		id, basketID, name, path, sbNullStr(parentID), now)
	if err != nil {
		return nil, err
	}
	return sbOne(`SELECT * FROM basket_folders WHERE "id"=$1`, id)
}

// ── Batch session names ──────────────────────────────────────────────────────

// sbSeqFrom is the start of the period a {SEQ} counter runs over, as the
// UTC instant of local midnight (like new Date(y, m, d) in Node).
func sbLocalMidnight(y int, m time.Month, d int) time.Time {
	return time.Date(y, m, d, 0, 0, 0, 0, time.Local).UTC()
}
