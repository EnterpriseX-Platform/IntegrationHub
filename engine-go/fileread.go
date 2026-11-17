package main

// Port of server/src/sdk/execution/executors/FileReadExecutor.ts: read files
// from a basket / SFTP / local path / the previous node, then parse them as
// csv, tsv, json, txt, xlsx, list or download.

import (
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

func init() { nativeExecutors["file-read"] = execFileRead }

// fioFile is one file the executor found ({path, size, fileId?, sessionId?,
// originalName?, content?}).
type fioFile struct {
	path         string
	size         any // number (undefined → fioUndef)
	fileID       any
	sessionID    any
	originalName any
	content      any // string (inline) or nil
	buf          []byte
	text         string
	binary       bool
}

func execFileRead(r *Run, node *Node, ctx *Ctx) (any, error) {
	d := node.Data
	if d == nil {
		d = map[string]any{}
	}
	parseAs := fioStr(fioData(d, "parseAs"))
	if fioData(d, "parseAs") == fioUndef {
		parseAs = ""
	}
	// parseAs 'raw' returns a Buffer, which only the Node executor can keep.
	if parseAs == "raw" {
		return nil, errUseFallback
	}

	var files []*fioFile
	var err error
	source := fioData(d, "source")
	switch source {
	case "basket":
		files, err = fioReadBasket(r, ctx, d)
	case "sftp":
		files, err = fioReadSFTP(r, ctx, d)
	case "local":
		files, err = fioReadLocal(r, ctx, d)
	default:
		files, err = fioReadInput(ctx)
	}
	if err != nil {
		return nil, err
	}
	if len(files) == 0 {
		return nil, errors.New("No files found to read")
	}

	if parseAs == "download" {
		f := files[0]
		fileName := fioBase(f.path)
		if fioTruthy(f.originalName) {
			fileName = fioStr(f.originalName)
		}
		mimes := map[string]string{
			".zip": "application/zip", ".pdf": "application/pdf",
			".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
			".csv":  "text/csv", ".txt": "text/plain", ".json": "application/json", ".xml": "application/xml",
		}
		ct, ok := mimes[strings.ToLower(fioExt(fileName))]
		if !ok {
			ct = "application/octet-stream"
		}
		dl := om("filePath", f.path, "fileName", fileName)
		if f.size != fioUndef {
			jsSet(dl, "size", f.size)
		}
		return om(
			"_fileDownload", dl,
			"headers", om(
				"Content-Type", ct,
				"Content-Disposition", `attachment; filename="`+fioEncodeURIComponent(fileName)+`"`,
				"Content-Length", fioStr(f.size),
			),
		), nil
	}

	encoding := fioStrOr(d, "encoding", "utf-8")
	useIconv := fioBufferEnc(encoding) == ""
	for _, f := range files {
		ext := ""
		if f.path != "" {
			parts := strings.Split(strings.ToLower(f.path), ".")
			ext = parts[len(parts)-1]
		}
		f.binary = parseAs == "xlsx" || (parseAs == "auto" && (ext == "xlsx" || ext == "xlsm"))
		b, err := fioReadFile(f.path)
		if err != nil {
			return nil, err
		}
		if f.binary {
			f.buf = b
			continue
		}
		if useIconv {
			f.text, err = fioIconvDecode(b, encoding)
			if err != nil {
				return nil, err
			}
		} else {
			f.text, _ = fioDecode(b, encoding)
		}
	}

	parsed := make([]any, 0, len(files))
	for _, f := range files {
		p, err := fioParseFile(f, d, parseAs)
		if err != nil {
			return nil, err
		}
		entry := om("fileName", fioBase(f.path), "path", f.path, "size", f.size)
		jsAssign(entry, p)
		parsed = append(parsed, entry)
	}
	var dataOut any
	if len(parsed) == 1 {
		dataOut = parsed[0].(map[string]any)["data"]
	} else {
		all := make([]any, len(parsed))
		for i, p := range parsed {
			all[i] = p.(map[string]any)["data"]
		}
		dataOut = all
	}
	return om(
		"source", source,
		"filesFound", float64(len(files)),
		"files", parsed,
		"data", dataOut,
		"timestamp", isoNow(),
	), nil
}

// fioEncodeURIComponent is JavaScript's encodeURIComponent.
func fioEncodeURIComponent(s string) string {
	e := url.QueryEscape(s)
	e = strings.ReplaceAll(e, "+", "%20")
	for _, c := range []string{"!", "'", "(", ")", "*"} {
		e = strings.ReplaceAll(e, url.QueryEscape(c), c)
	}
	e = strings.ReplaceAll(e, "%7E", "~")
	return e
}

// fioGlobRead is the FileReadExecutor glob: '.' literal, '*' any (case-sensitive).
func fioGlobRead(pattern string) (*regexp.Regexp, error) {
	return fioJSRegex("^"+strings.ReplaceAll(strings.ReplaceAll(pattern, ".", `\.`), "*", ".*")+"$", false)
}

func fioSlash(p string) string {
	if strings.HasPrefix(p, "/") {
		return p
	}
	return "/" + p
}

func fioOr(v any, alt any) any {
	if fioTruthy(v) {
		return v
	}
	return alt
}

func fioReadBasket(r *Run, ctx *Ctx, d map[string]any) ([]*fioFile, error) {
	pattern := fioStrOr(d, "filePattern", "*.*")
	fileStatus := fioStrOr(d, "fileStatus", "open")
	sessionSource := fioStrOr(d, "sessionSource", "auto")

	if m := regexp.MustCompile(`^\{\{(.+?)\}\}$`).FindStringSubmatch(pattern); m != nil {
		item := ctx.Vars[m[1]]
		if p := fioProp(item, "path"); fioTruthy(p) {
			ps, _ := p.(string)
			fp := fioSlash(ps)
			if st, err := os.Stat(fp); err == nil {
				return []*fioFile{{path: fp, size: float64(st.Size()),
					fileID: fioUndefOr(fioOr(fioProp(item, "id"), fioProp(item, "fileId"))), sessionID: fioProp(item, "sessionId"),
					originalName: fioUndef}}, nil
			}
		}
	}

	re, err := fioGlobRead(pattern)
	if err != nil {
		return nil, err
	}

	if basketID := d["basketId"]; fioTruthy(basketID) {
		bid := fioStr(basketID)
		rows, err := appQuery(`SELECT id FROM baskets WHERE id = $1`, bid)
		if err != nil {
			return nil, err
		}
		if len(rows) == 0 {
			return nil, fmt.Errorf("Basket not found: %s", bid)
		}

		_, hasTrigger := ctx.Vars["triggerFiles"]
		if sessionSource == "trigger" || (sessionSource == "auto" && hasTrigger) {
			if tf, ok := ctx.Vars["triggerFiles"].([]any); ok {
				var out []*fioFile
				for _, f := range tf {
					name := fioProp(f, "fileName")
					p := fioProp(f, "path")
					if !fioTruthy(name) {
						ps, ok := p.(string)
						if !ok {
							return nil, fmt.Errorf(`The "path" argument must be of type string. Received %s`, fioTypeDesc(p))
						}
						name = fioBase(ps)
					}
					if !re.MatchString(fioStr(name)) {
						continue
					}
					ps, ok := p.(string)
					if !ok {
						return nil, fioTypeErrProp(p, "startsWith")
					}
					out = append(out, &fioFile{path: fioSlash(ps), size: fioProp(f, "size"),
						fileID: fioUndefOr(fioOr(fioProp(f, "id"), fioProp(f, "fileId"))), sessionID: fioProp(f, "sessionId"), originalName: fioUndef})
				}
				return out, nil
			}
			if sessionSource == "trigger" {
				return nil, nil
			}
		}

		const cols = `id, "fileName", "originalName", size, path, "sessionId"`
		if sessionSource == "latest" {
			s, err := appQuery(`SELECT id FROM processing_sessions WHERE "basketId" = $1 ORDER BY "startedAt" DESC LIMIT 1`, bid)
			if err != nil {
				return nil, err
			}
			if len(s) == 0 {
				return nil, nil
			}
			rows, err := appQuery(`SELECT `+cols+` FROM basket_files WHERE "basketId" = $1 AND "sessionId" = $2 ORDER BY "createdAt" DESC`, bid, s[0]["id"])
			if err != nil {
				return nil, err
			}
			return fioBasketRows(rows, re), nil
		}
		if sid := d["sessionId"]; sessionSource == "specific" && fioTruthy(sid) {
			rows, err := appQuery(`SELECT `+cols+` FROM basket_files WHERE "basketId" = $1 AND "sessionId" = $2 ORDER BY "createdAt" DESC`, bid, fioStr(sid))
			if err != nil {
				return nil, err
			}
			return fioBasketRows(rows, re), nil
		}
		var statuses []string
		switch fileStatus {
		case "all":
			statuses = []string{"open", "active", "published", "uploaded", "pending"}
		case "open":
			statuses = []string{"open", "active", "uploaded", "pending"}
		default:
			statuses = []string{fileStatus}
		}
		rows, err = appQuery(`SELECT `+cols+` FROM basket_files WHERE "basketId" = $1 AND status = ANY($2) ORDER BY "createdAt" DESC`, bid, statuses)
		if err != nil {
			return nil, err
		}
		return fioBasketRows(rows, re), nil
	}

	basketPath := fioStrOr(d, "basketPath", "/data/incoming")
	if !fioExists(basketPath) {
		return nil, nil
	}
	entries, err := os.ReadDir(basketPath)
	if err != nil {
		var pe *os.PathError
		if errors.As(err, &pe) {
			pe.Op = "scandir"
		}
		return nil, fioFsErr(err)
	}
	var out []*fioFile
	for _, e := range entries {
		if !re.MatchString(e.Name()) {
			continue
		}
		full := fioJoin(basketPath, e.Name())
		st, err := fioStat(full)
		if err != nil {
			return nil, err
		}
		out = append(out, &fioFile{path: full, size: float64(st.Size()), fileID: fioUndef, sessionID: fioUndef, originalName: fioUndef})
	}
	return out, nil
}

func fioUndefOr(v any) any {
	if v == nil {
		return nil
	}
	return v
}

func fioTypeDesc(v any) string {
	switch t := v.(type) {
	case *fioUndefT:
		return "undefined"
	case nil:
		return "null"
	case float64:
		return "type number (" + fioNum(t) + ")"
	case bool:
		return fmt.Sprintf("type boolean (%v)", t)
	}
	return "an instance of Object"
}

func fioBasketRows(rows []map[string]any, re *regexp.Regexp) []*fioFile {
	var out []*fioFile
	for _, f := range rows {
		name, _ := f["fileName"].(string)
		if !re.MatchString(name) {
			continue
		}
		p, _ := f["path"].(string)
		orig := any(f["originalName"])
		if !fioTruthy(orig) {
			orig = name
		}
		out = append(out, &fioFile{path: fioSlash(p), size: fioDBNum(f["size"]), fileID: f["id"], sessionID: f["sessionId"], originalName: orig})
	}
	return out
}

func fioDBNum(v any) any {
	switch t := v.(type) {
	case int32:
		return float64(t)
	case int64:
		return float64(t)
	case int:
		return float64(t)
	case float64:
		return t
	}
	return v
}

func fioReadSFTP(r *Run, ctx *Ctx, d map[string]any) ([]*fioFile, error) {
	if !fioTruthy(d["sftpConnectionId"]) {
		return nil, errors.New("SFTP connection ID required")
	}
	if !fioTruthy(d["sftpRemotePath"]) {
		return nil, errors.New("SFTP remote path required")
	}
	_, cfg, err := fioConnection(r, fioStr(d["sftpConnectionId"]))
	if err != nil {
		return nil, err
	}
	remotePath := fioReadTemplate(r, ctx, fioStr(d["sftpRemotePath"]))
	localTemp := fmt.Sprintf("/tmp/sftp-%d", time.Now().UnixMilli())
	if err := fioMkdirAll(localTemp); err != nil {
		return nil, err
	}
	s, err := fioSFTPConnect(cfg)
	if err != nil {
		return nil, err
	}
	defer s.Close()

	download := func(remote, local string) error {
		src, err := s.client.Open(remote)
		if err != nil {
			return fmt.Errorf("Cannot read remote file %s: %s", remote, fioSFTPErr(err).Error())
		}
		defer src.Close()
		dst, err := os.Create(local)
		if err != nil {
			return fioFsErr(err)
		}
		if _, err := io.Copy(dst, src); err != nil {
			dst.Close()
			return fmt.Errorf("Cannot read remote file %s: %s", remote, fioSFTPErr(err).Error())
		}
		return dst.Close()
	}

	if strings.Contains(remotePath, ".") {
		local := filepath.Join(localTemp, fioBase(remotePath))
		if err := download(remotePath, local); err != nil {
			return nil, err
		}
		st, err := fioStat(local)
		if err != nil {
			return nil, err
		}
		return []*fioFile{{path: local, size: float64(st.Size()), fileID: fioUndef, sessionID: fioUndef, originalName: fioUndef}}, nil
	}

	list, err := s.client.ReadDir(remotePath)
	if err != nil {
		return nil, fioSFTPErr(err)
	}
	re, err := fioGlobRead(fioStrOr(d, "filePattern", "*.*"))
	if err != nil {
		return nil, err
	}
	var out []*fioFile
	for _, fi := range list {
		if !re.MatchString(fi.Name()) || fi.IsDir() {
			continue
		}
		remote := fioJoin(remotePath, fi.Name())
		local := fioJoin(localTemp, fi.Name())
		if err := download(remote, local); err != nil {
			return nil, err
		}
		out = append(out, &fioFile{path: local, size: float64(fi.Size()), fileID: fioUndef, sessionID: fioUndef, originalName: fioUndef})
	}
	return out, nil
}

func fioReadLocal(r *Run, ctx *Ctx, d map[string]any) ([]*fioFile, error) {
	fp := ""
	if lp := d["localPath"]; fioTruthy(lp) {
		fp = fioReadTemplate(r, ctx, fioStr(lp))
	}
	if fp == "" || !fioExists(fp) {
		return nil, nil
	}
	st, err := fioStat(fp)
	if err != nil {
		return nil, err
	}
	return []*fioFile{{path: fp, size: float64(st.Size()), fileID: fioUndef, sessionID: fioUndef, originalName: fioUndef}}, nil
}

func fioReadInput(ctx *Ctx) ([]*fioFile, error) {
	in := ctx.Input
	if dls, ok := fioProp(in, "downloads").([]any); ok {
		var out []*fioFile
		for _, dl := range dls {
			lp, _ := fioProp(dl, "localPath").(string)
			if !fioTruthy(fioProp(dl, "success")) || lp == "" || !fioExists(lp) {
				continue
			}
			st, err := fioStat(lp)
			if err != nil {
				return nil, err
			}
			out = append(out, &fioFile{path: lp, size: float64(st.Size()), fileID: fioUndef, sessionID: fioUndef, originalName: fioUndef})
		}
		if len(out) > 0 {
			return out, nil
		}
	}
	for _, k := range []string{"localPath", "path"} {
		if p, ok := fioProp(in, k).(string); ok && p != "" && fioExists(p) {
			st, err := fioStat(p)
			if err != nil {
				return nil, err
			}
			return []*fioFile{{path: p, size: float64(st.Size()), fileID: fioUndef, sessionID: fioUndef, originalName: fioUndef}}, nil
		}
	}
	if s, ok := fioProp(in, "data").(string); ok {
		return []*fioFile{{path: "inline://from-http-response", size: float64(fioLen16(s)), content: s,
			fileID: fioUndef, sessionID: fioUndef, originalName: fioUndef}}, nil
	}
	return nil, nil
}

// fioParseFile is FileReadExecutor.parseFile.
func fioParseFile(f *fioFile, d map[string]any, parseAs string) (map[string]any, error) {
	if parseAs == "list" {
		data := om("fileName", fioBase(f.path), "path", f.path,
			"size", f.size, "fileId", f.fileID, "sessionId", f.sessionID)
		return om("data", data, "format", "list"), nil
	}

	content := f.text
	if !f.binary && content == "" {
		// `file.content || fs.readFileSync(path, encoding)`
		enc := fioStrOr(d, "encoding", "utf-8")
		be := fioBufferEnc(enc)
		if be == "" {
			return nil, fmt.Errorf("The argument '%s' is invalid encoding. Received 'encoding'", enc)
		}
		b, err := fioReadFile(f.path)
		if err != nil {
			return nil, err
		}
		content = fioBufferDecode(b, be)
	}
	ext := ""
	if f.path != "" {
		ext = strings.ToLower(fioExt(f.path))
	}
	format := parseAs
	if format == "auto" {
		switch ext {
		case ".csv":
			format = "csv"
		case ".tsv":
			format = "tsv"
		case ".json":
			format = "json"
		case ".xlsx", ".xlsm":
			format = "xlsx"
		default:
			format = "txt"
		}
	}

	var customHeaders []string
	if ch := d["customHeaders"]; fioTruthy(ch) {
		for _, h := range strings.Split(fioStr(ch), ",") {
			customHeaders = append(customHeaders, fioTrim(h))
		}
	}
	hasHeader := d["hasHeader"] != false

	var parsed any
	var rowCount float64
	var keyOrder []string // insertion order of the first row's keys, when known
	switch format {
	case "csv", "tsv":
		def := ","
		if format == "tsv" {
			def = "\t"
		}
		if f.binary {
			content = string(f.buf)
		}
		rows, order := fioParseCSV(content, fioStrOr(d, "delimiter", def), hasHeader, customHeaders)
		parsed, rowCount, keyOrder = rows, float64(len(rows)), order
	case "json":
		if f.binary {
			content = string(f.buf)
		}
		v, order, err := fioJSONParseOrder(content)
		if err != nil {
			return nil, err
		}
		keyOrder = order
		parsed = v
		if a, ok := v.([]any); ok {
			rowCount = float64(len(a))
		} else {
			rowCount = 1
		}
	case "xlsx":
		buf := f.buf
		if buf == nil {
			b, err := fioReadFile(f.path)
			if err != nil {
				return nil, err
			}
			buf = b
		}
		sheet := ""
		if sn := d["sheetName"]; fioTruthy(sn) {
			sheet = fioStr(sn)
		}
		rows, order, err := fioParseXLSX(buf, hasHeader, customHeaders, sheet)
		if err != nil {
			return nil, err
		}
		parsed, rowCount, keyOrder = rows, float64(len(rows)), order
	default:
		if f.binary {
			content = fioDecodeUTF8(f.buf)
		}
		lines := fioParseTXT(content)
		parsed, rowCount = lines, float64(len(lines))
	}

	if mr, ok := num(d, "maxRows"); ok && fioTruthy(d["maxRows"]) && mr > 0 {
		if a, ok := parsed.([]any); ok {
			n := int(mr) // slice() truncates the end index
			if n < len(a) {
				a = a[:n]
			}
			parsed, rowCount = a, float64(len(a))
		}
	}

	var headers any
	if a, ok := parsed.([]any); ok && len(a) > 0 && fioTypeofObject(a[0]) {
		if a[0] == nil {
			return nil, errors.New("Cannot convert undefined or null to object")
		}
		ks := fioKeys(a[0])
		if keyOrder != nil {
			ks = fioInsertionKeys(keyOrder)
		}
		h := make([]any, len(ks))
		for i, k := range ks {
			h[i] = k
		}
		headers = h
	}
	return om("format", format, "rowCount", rowCount, "data", parsed, "headers", headers), nil
}

func fioTypeofObject(v any) bool {
	switch v.(type) {
	case nil, map[string]any, []any, time.Time:
		return true
	}
	return false
}

// fioDetectDelimiter is detectDelimiter.
func fioDetectDelimiter(sample string) string {
	var lines []string
	for _, l := range strings.Split(sample, "\n") {
		if fioTrim(l) != "" {
			lines = append(lines, l)
			if len(lines) == 5 {
				break
			}
		}
	}
	if len(lines) == 0 {
		return ","
	}
	best, bestScore, found := ",", 0.0, false
	for _, d := range []string{"|", "\t", ";", ","} {
		cols := len(strings.Split(lines[0], d))
		if cols < 2 {
			continue
		}
		stable := true
		for _, l := range lines {
			if len(strings.Split(l, d)) != cols {
				stable = false
			}
		}
		score := float64(cols)
		if stable {
			score += 100
		}
		if d == "|" {
			score += 0.5
		}
		if !found || score > bestScore {
			best, bestScore, found = d, score, true
		}
	}
	return best
}

var fioQuoteEnds = regexp.MustCompile(`^"|"$`)

func fioCSVCell(s string) string { return fioQuoteEnds.ReplaceAllString(fioTrim(s), "") }

// fioParseCSV is parseCSV: a plain split on the delimiter (no quote
// handling), one leading/trailing quote removed, values trimmed.
func fioParseCSV(content, delimiter string, hasHeader bool, customHeaders []string) ([]any, []string) {
	var lines []string
	for _, l := range strings.Split(content, "\n") {
		if fioTrim(l) != "" {
			lines = append(lines, l)
		}
	}
	if len(lines) == 0 {
		return []any{}, nil
	}
	eff := delimiter
	if eff == "auto" || (eff == "," && len(strings.Split(lines[0], ",")) == 1) {
		eff = fioDetectDelimiter(content)
	}
	var headers []string
	start := 0
	switch {
	case hasHeader:
		for _, h := range fioSplitJS(lines[0], eff) {
			headers = append(headers, fioCSVCell(h))
		}
		start = 1
	case len(customHeaders) > 0:
		headers = customHeaders
	default:
		n := len(fioSplitJS(lines[0], eff))
		for i := 0; i < n; i++ {
			headers = append(headers, fmt.Sprintf("col%d", i))
		}
	}
	out := make([]any, 0, len(lines)-start)
	for _, l := range lines[start:] {
		raw := fioSplitJS(l, eff)
		row := make(map[string]any, len(headers))
		for i, h := range headers {
			v := ""
			if i < len(raw) {
				v = fioCSVCell(raw[i])
			}
			row[h] = v
		}
		jsOrder(row, headers)
		out = append(out, row)
	}
	return out, headers
}

// fioInsertionKeys is the Object.keys order of an object whose keys were
// assigned in this order: integer-like keys ascending first, then the rest
// by first assignment.
func fioInsertionKeys(order []string) []string {
	seen := map[string]bool{}
	m := map[string]any{}
	var rest []string
	for _, k := range order {
		if seen[k] {
			continue
		}
		seen[k] = true
		if fioIsArrayIndex(k) {
			m[k] = true
		} else {
			rest = append(rest, k)
		}
	}
	return append(fioSortedKeys(m), rest...)
}

// fioSplitJS is String.prototype.split(sep) (an empty separator splits into
// UTF-16 units).
func fioSplitJS(s, sep string) []string {
	if sep == "" {
		var out []string
		for _, r := range s {
			out = append(out, string(r))
		}
		return out
	}
	return strings.Split(s, sep)
}

func fioParseTXT(content string) []any {
	out := []any{}
	for _, l := range strings.Split(content, "\n") {
		if t := fioTrim(l); t != "" {
			out = append(out, t)
		}
	}
	return out
}
