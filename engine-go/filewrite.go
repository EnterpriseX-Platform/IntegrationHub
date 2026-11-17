package main

// Port of server/src/sdk/execution/executors/FileWriteExecutor.ts: build a
// csv / tsv / delimited / json / txt / xlsx / zip file and write it to a
// basket (batch with sessions, shares, sftp), an SFTP server or a local path.

import (
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

func init() { nativeExecutors["file-write"] = execFileWrite }

// fioContent is `string | Buffer`.
type fioContent struct {
	text   string
	buf    []byte
	isText bool
}

func execFileWrite(r *Run, node *Node, ctx *Ctx) (any, error) {
	d := node.Data
	if d == nil {
		d = map[string]any{}
	}
	switch d["format"] {
	case "zip":
		return fioZipWrite(r, node, ctx, d)
	case "xlsx":
		return fioXlsxWrite(r, node, ctx, d)
	}

	src, err := fioSourceData(r, ctx, d)
	if err != nil {
		return nil, err
	}
	content, ext, err := fioGenerate(src, d)
	if err != nil {
		return nil, err
	}

	fileName, err := fioDataFileName(d)
	if err != nil {
		return nil, err
	}
	fileName = fioFilePlaceholders(fileName, time.Now(), ext)
	fileName = fioWriteTemplate(r, ctx, fileName)

	c := fioContent{text: content, isText: true}
	res, err := fioWriteDest(r, ctx, d, c, fileName, d, "")
	if err != nil {
		return nil, err
	}
	return fioResult(d, fioData(d, "format"), fileName, res), nil
}

func fioDataFileName(d map[string]any) (string, error) {
	fn, ok := d["fileName"].(string)
	if !ok {
		return "", fioTypeErrProp(fioData(d, "fileName"), "replace")
	}
	return fn, nil
}

// fioResult is `{destination, format, fileName, ...result, timestamp}`.
func fioResult(d map[string]any, format any, fileName string, res map[string]any) map[string]any {
	out := om("destination", fioData(d, "destination"), "format", format, "fileName", fileName)
	jsAssign(out, res)
	jsSet(out, "timestamp", isoNow())
	return out
}

// fioWriteDest writes content to the configured destination. targetFolder
// overrides data.targetFolder when non-empty (zip resolves it first).
func fioWriteDest(r *Run, ctx *Ctx, d map[string]any, c fioContent, fileName string, cfg map[string]any, localSub string) (map[string]any, error) {
	switch d["destination"] {
	case "sftp":
		return fioWriteSFTP(r, ctx, c, fileName, cfg)
	case "local":
		dir := fioStrOr(d, "localPath", "/tmp")
		return fioWriteLocal(c, fioJoin(dir, localSub, fileName))
	default:
		if !fioTruthy(d["basketId"]) {
			return nil, errors.New("Basket ID is required when destination is basket")
		}
		return fioWriteBasket(r, ctx, c, fileName, cfg)
	}
}

// fioFilePlaceholders replaces the {{...}} date placeholders of fileName
// (same order as the TS chain).
func fioFilePlaceholders(name string, now time.Time, ext string) string {
	Y := strconv.Itoa(now.Year())
	MM, DD := fioPad2(int(now.Month())), fioPad2(now.Day())
	HH, mi, ss := fioPad2(now.Hour()), fioPad2(now.Minute()), fioPad2(now.Second())
	ymd := Y + MM + DD
	hms := HH + mi + ss
	by := strconv.Itoa(now.Year() + 543)
	reps := [][2]string{
		{"{{timestamp}}", strconv.FormatInt(now.UnixMilli(), 10)},
		{"{{datetime}}", ymd + "_" + hms},
		{"{{YYYYMMDD}}", ymd},
		{"{{date}}", now.UTC().Format("2006-01-02")},
		{"{{HHmmss}}", hms},
		{"{{HHmm}}", HH + mi},
		{"{{time}}", hms},
		{"{{YYYY}}", Y},
		{"{{MM}}", MM},
		{"{{DD}}", DD},
		{"{{HH}}", HH},
		{"{{mm}}", mi},
		{"{{ss}}", ss},
		{"{{year}}", Y},
		{"{{buddhistYear}}", by},
		{"{{BYYYY}}", by},
		{"{{extension}}", ext},
	}
	for _, rp := range reps {
		name = strings.ReplaceAll(name, rp[0], rp[1])
	}
	return name
}

// fioSourceData is the data-source block of executeNode / executeXlsxWrite,
// including the `columns` remapping.
func fioSourceData(r *Run, ctx *Ctx, d map[string]any) (any, error) {
	var src any
	if d["dataSource"] == "template" && fioTruthy(d["template"]) {
		src = fioWriteTemplate(r, ctx, fioStr(d["template"]))
	} else {
		dataPath := fioStrOr(d, "dataPath", "input.data")
		src = fioDataFromPath(r, ctx, dataPath)
		if !fioTruthy(src) && dataPath == "input.data" {
			src = fioDataFromPath(r, ctx, "input")
		}
		if src != nil && src != fioUndef {
			if rows := fioProp(src, "rows"); fioTruthy(rows) {
				src = rows
			}
		}
	}
	if !fioTruthy(src) {
		src = []any{}
	}
	cols := fioColumns(d["columns"])
	if arr, ok := src.([]any); ok && len(cols) > 0 {
		mapped := make([]any, len(arr))
		for i, row := range arr {
			if row == nil || row == fioUndef {
				return nil, fioTypeErrProp(row, "hasOwnProperty")
			}
			m := map[string]any{}
			for _, col := range cols {
				if fioHasOwn(row, col) {
					m[col] = fioProp(row, col)
					continue
				}
				found := false
				lc := strings.ToLower(col)
				for _, k := range fioKeys(row) {
					if strings.ToLower(k) == lc {
						m[col], found = fioProp(row, k), true
						break
					}
				}
				if !found {
					m[col] = ""
				}
			}
			mapped[i] = m
		}
		src = mapped
	}
	return src, nil
}

func fioColumns(v any) []string {
	a, ok := v.([]any)
	if !ok {
		return nil
	}
	out := make([]string, len(a))
	for i, x := range a {
		out[i] = fioStr(x)
	}
	return out
}

func fioGenerate(data any, d map[string]any) (string, string, error) {
	includeHeader := d["includeHeader"] != false
	cols := fioColumns(d["columns"])
	switch d["format"] {
	case "csv":
		s, err := fioToCSV(data, fioStrOr(d, "delimiter", ","), includeHeader, cols)
		return s, "csv", err
	case "tsv":
		s, err := fioToCSV(data, fioStrOr(d, "delimiter", "\t"), includeHeader, cols)
		return s, "tsv", err
	case "delimited":
		s, err := fioToCSV(data, fioStrOr(d, "delimiter", "|"), includeHeader, cols)
		return s, "txt", err
	case "json":
		return fioJSON(data, "  "), "json", nil
	}
	s, err := fioToTXT(data)
	return s, "txt", err
}

// fioToCSV is toCSV.
func fioToCSV(data any, delim string, includeHeader bool, custom []string) (string, error) {
	arr, ok := data.([]any)
	if !ok {
		arr = []any{data}
	}
	headers := custom
	if len(headers) == 0 {
		if len(arr) > 0 {
			headers = fioKeys(arr[0])
		} else {
			headers = nil
		}
	}
	if len(arr) == 0 && len(headers) == 0 {
		return "", nil
	}
	var b strings.Builder
	if includeHeader {
		b.WriteString(strings.Join(headers, delim) + "\n")
	}
	for _, row := range arr {
		vals := make([]string, len(headers))
		for i, h := range headers {
			if row == nil || row == fioUndef {
				return "", fioTypeErrProp(row, h)
			}
			v := fioProp(row, h)
			if v == nil || v == fioUndef {
				continue
			}
			s := fioStr(v)
			if strings.Contains(s, delim) || strings.Contains(s, "\n") || strings.Contains(s, `"`) {
				s = `"` + strings.ReplaceAll(s, `"`, `""`) + `"`
			}
			vals[i] = s
		}
		b.WriteString(strings.Join(vals, delim) + "\n")
	}
	return b.String(), nil
}

// fioToTXT is toTXT.
func fioToTXT(data any) (string, error) {
	switch t := data.(type) {
	case string:
		return t, nil
	case []any:
		lines := make([]string, len(t))
		for i, row := range t {
			if row == nil {
				return "", errors.New("Cannot convert undefined or null to object")
			}
			if fioTypeofObject(row) {
				vals := []string{}
				for _, k := range fioKeys(row) {
					v := fioProp(row, k)
					if v == nil || v == fioUndef {
						vals = append(vals, "")
					} else {
						vals = append(vals, fioStr(v))
					}
				}
				lines[i] = strings.Join(vals, " | ")
			} else {
				lines[i] = fioStr(row)
			}
		}
		return strings.Join(lines, "\n"), nil
	case map[string]any:
		var lines []string
		for _, k := range fioKeys(t) {
			lines = append(lines, k+": "+fioStr(t[k]))
		}
		return strings.Join(lines, "\n"), nil
	}
	return fioStr(data), nil
}

func fioWriteLocal(c fioContent, filePath string) (map[string]any, error) {
	dir := fioDir(filePath)
	if !fioExists(dir) {
		if err := fioMkdirAll(dir); err != nil {
			return nil, err
		}
	}
	b := c.buf
	if c.isText {
		b = []byte(c.text) // writeToLocal is never given an encoding: utf8
	}
	if err := fioWriteFile(filePath, b); err != nil {
		return nil, err
	}
	st, err := fioStat(filePath)
	if err != nil {
		return nil, err
	}
	return om("path", filePath, "size", float64(st.Size())), nil
}

// fioEncoded is `fs.writeFileSync(p, content, {encoding: data.encoding || 'utf8'})`.
func fioEncoded(c fioContent, d map[string]any) ([]byte, error) {
	if !c.isText {
		return c.buf, nil
	}
	return fioBufferEncode(c.text, fioStrOr(d, "encoding", "utf8"))
}

func fioWriteSFTP(r *Run, ctx *Ctx, c fioContent, fileName string, d map[string]any) (map[string]any, error) {
	if !fioTruthy(d["sftpConnectionId"]) || !fioTruthy(d["sftpRemotePath"]) {
		return nil, errors.New("SFTP connection and remote path required")
	}
	conn, cfg, err := fioConnection(r, fioStr(d["sftpConnectionId"]))
	if err != nil {
		return nil, err
	}
	remoteDir := fioWriteTemplate(r, ctx, fioStr(d["sftpRemotePath"]))
	remotePath := fioJoin(remoteDir, fileName)

	tempPath := "/tmp/" + fileName
	b, err := fioEncoded(c, d)
	if err != nil {
		return nil, err
	}
	if err := fioWriteFile(tempPath, b); err != nil {
		return nil, err
	}
	defer os.Remove(tempPath)

	s, err := fioSFTPConnect(cfg)
	if err != nil {
		return nil, err
	}
	defer s.Close()
	_ = s.client.Mkdir(remoteDir)
	src, err := os.Open(tempPath)
	if err != nil {
		return nil, fmt.Errorf("Cannot read temp file %s: %s", tempPath, fioFsErr(err).Error())
	}
	defer src.Close()
	dst, err := s.client.OpenFile(remotePath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC)
	if err != nil {
		return nil, fioSFTPErr(err)
	}
	if _, err := io.Copy(dst, src); err != nil {
		dst.Close()
		return nil, fioSFTPErr(err)
	}
	if err := dst.Close(); err != nil {
		return nil, fioSFTPErr(err)
	}
	return om("remotePath", remotePath, "connection", conn["name"], "size", float64(len(b))), nil
}

// fioMatchPattern is FileWriteExecutor.matchPattern (case-insensitive, * and
// ?, comma-separated alternatives).
func fioMatchPattern(fileName, pattern string) bool {
	if pattern == "*" || pattern == "*.*" {
		return true
	}
	pats := []string{pattern}
	if strings.Contains(pattern, ",") {
		pats = nil
		for _, p := range strings.Split(pattern, ",") {
			pats = append(pats, fioTrim(p))
		}
	}
	for _, p := range pats {
		src := "^" + strings.ReplaceAll(strings.ReplaceAll(strings.ReplaceAll(p, ".", `\.`), "*", ".*"), "?", ".") + "$"
		re, err := regexp.Compile("(?i)" + src)
		if err == nil && re.MatchString(fileName) {
			return true
		}
	}
	return false
}
