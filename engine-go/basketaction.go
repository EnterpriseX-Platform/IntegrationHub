package main

// Port of server/src/sdk/execution/executors/BasketActionExecutor.ts:
// copy / zip / copy-and-zip files between baskets (shares-basket folders
// included) and extract a ZIP produced by an earlier node into a basket.

import (
	"archive/zip"
	"compress/flate"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

func init() { nativeExecutors["basket-action"] = execBasketAction }

type sbSrcFile struct {
	ID, Name, Path string
	Size           int64
}

func execBasketAction(r *Run, node *Node, ctx *Ctx) (any, error) {
	d := node.Data
	op := sbDef(d, "operation")
	if op == "extract" {
		return sbExtractToBasket(r, d, ctx)
	}
	if !truthy(d["sourceBasketId"]) {
		return nil, errors.New("Source basket ID is required")
	}
	if !truthy(d["destinationBasketId"]) {
		return nil, errors.New("Destination basket ID is required")
	}
	srcID, dstID := sbStrOf(d["sourceBasketId"]), sbStrOf(d["destinationBasketId"])
	src, err := sbBasket(srcID)
	if err != nil {
		return nil, err
	}
	if src == nil {
		return nil, fmt.Errorf("Source basket not found: %s", srcID)
	}
	dst, err := sbBasket(dstID)
	if err != nil {
		return nil, err
	}
	if dst == nil {
		return nil, fmt.Errorf("Destination basket not found: %s", dstID)
	}

	targetFolder := sbResolveTargetFolder(r, sbStrOf(d["targetFolder"]), ctx)
	files, err := sbCollectSourceFiles(d, ctx, srcID)
	if err != nil {
		return nil, err
	}
	var tf any = undefinedV
	if targetFolder != "" {
		tf = targetFolder
	}
	if len(files) == 0 {
		log.Printf("[BasketAction] No source files found")
		out := om(
			"sourceBasket", sbS(src, "name"), "destinationBasket", sbS(dst, "name"),
			"filesFound", float64(0), "status", "empty", "message", "No source files found",
		)
		sbPut(out, "operation", op)
		sbPut(out, "targetFolder", tf)
		return out, nil
	}
	log.Printf("[BasketAction] %s: %d files from \"%s\" → \"%s/%s\"", sbStrOrUndef(op), len(files), sbS(src, "name"), sbS(dst, "name"), targetFolder)

	result := om(
		"sourceBasket", sbS(src, "name"), "destinationBasket", sbS(dst, "name"), "filesFound", float64(len(files)),
	)
	sbPut(result, "operation", op)
	sbPut(result, "targetFolder", tf)

	destDir, folderID, err := sbEnsureDestinationFolder(dst, targetFolder)
	if err != nil {
		return nil, err
	}

	switch op {
	case "copy":
		result["copied"], err = sbCopyFiles(r, files, destDir, targetFolder, folderID, d)
	case "zip":
		result["zip"], err = sbZipFiles(r, files, destDir, dst, targetFolder, folderID, d)
	case "copy-and-zip":
		if result["copied"], err = sbCopyFiles(r, files, destDir, targetFolder, folderID, d); err == nil {
			result["zip"], err = sbZipFiles(r, files, destDir, dst, targetFolder, folderID, d)
		}
	default:
		return nil, fmt.Errorf("Unknown operation: %s", sbStrOrUndef(op))
	}
	if err != nil {
		return nil, err
	}
	if truthy(d["deleteSource"]) {
		jsSet(result, "deleted", sbDeleteSourceFiles(files))
	}
	if folderID != "" {
		jsSet(result, "folderId", folderID)
	} else {
		jsSet(result, "folderId", nil)
	}
	jsSet(result, "timestamp", sbISO(sbNow()))
	return result, nil
}

// sbStrOrUndef is `${x}` for a value that may be undefined.
func sbStrOrUndef(v any) string {
	if v == undefinedV {
		return "undefined"
	}
	return jsString(v)
}

// ── extract ──────────────────────────────────────────────────────────────────

func sbMimeExtract(name string) string {
	switch strings.ToLower(sbExtname(name)) {
	case ".pdf":
		return "application/pdf"
	case ".xml":
		return "application/xml"
	case ".csv":
		return "text/csv"
	case ".txt":
		return "text/plain"
	case ".json":
		return "application/json"
	case ".zip":
		return "application/zip"
	case ".xlsx", ".xls":
		return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
	}
	return "application/octet-stream"
}

func sbExtractToBasket(r *Run, d map[string]any, ctx *Ctx) (any, error) {
	if !truthy(d["destinationBasketId"]) {
		return nil, errors.New("Destination basket is required for extract")
	}
	var resolved any = ""
	if s, ok := d["sourceFilePath"].(string); ok && s != "" {
		resolved = ctx.resolveTemplate(s)
	} else if truthy(d["sourceFilePath"]) {
		resolved = d["sourceFilePath"]
	}
	zipPath := ""
	if truthy(resolved) {
		zipPath = strings.Trim(jsString(resolved), sbJSSpace)
	}
	if zipPath == "" {
		return nil, errors.New("Source file path is required for extract (e.g. {{dl.localPath}})")
	}
	if !sbExists(zipPath) {
		return nil, fmt.Errorf("Source file not found: %s", zipPath)
	}
	basket, err := sbBasket(sbStrOf(d["destinationBasketId"]))
	if err != nil {
		return nil, err
	}
	if basket == nil {
		return nil, fmt.Errorf("Destination basket not found: %s", sbStrOf(d["destinationBasketId"]))
	}

	sessionID := ""
	targetDir := sbJoin(sbS(basket, "path"), "incoming")
	if sbS(basket, "type") == "batch" && d["autoCreateSession"] != false {
		sid, folder, err := sbEnsureBatchSessionBA(basket, sbStrOf(d["sessionMode"]))
		if err != nil {
			return nil, err
		}
		sessionID, targetDir = sid, folder
	}
	if !sbExists(targetDir) {
		if err := sbMkdirAll(targetDir); err != nil {
			return nil, err
		}
	}

	zr, err := zip.OpenReader(zipPath)
	if err != nil {
		return nil, errors.New("Invalid or unsupported zip format. No END header found")
	}
	defer zr.Close()
	count, total := 0, int64(0)
	for _, f := range zr.File {
		if strings.HasSuffix(f.Name, "/") {
			continue
		}
		base := sbBasename(f.Name)
		if base == "" {
			continue
		}
		rnd := make([]byte, 8)
		_, _ = rand.Read(rnd)
		eID := "f" + strconv.FormatInt(time.Now().UnixMilli(), 36) + hex.EncodeToString(rnd)
		stored := eID + "_" + base
		ePath := sbJoin(targetDir, stored)
		data, err := sbZipEntryData(f)
		if err != nil {
			return nil, err
		}
		if err := sbWriteFile(ePath, data); err != nil {
			return nil, err
		}
		size, err := sbStatSize(ePath)
		if err != nil {
			return nil, err
		}
		total += size
		status := "pending"
		if sessionID != "" {
			status = "uploaded"
		}
		if _, err := sbCreateFile(sbFileRow{ID: eID, FileName: stored, OriginalName: base, Path: ePath, Size: size,
			MimeType: sbMimeExtract(base), BasketID: sbS(basket, "id"), SessionID: sessionID, Status: status,
			Metadata: sbStringify(sbObj{{"source", "basket-action-extract"}, {"zip", sbBasename(zipPath)}, {"entry", f.Name}})}); err != nil {
			return nil, err
		}
		count++
	}
	if sessionID != "" {
		_, _ = appExec(`UPDATE processing_sessions SET "fileCount"="fileCount"+$1, "totalSize"="totalSize"+$2 WHERE "id"=$3`, int32(count), int32(total), sessionID)
	}
	_ = sbCreateBasketLog(sbS(basket, "id"), "upload", fmt.Sprintf("Extracted %d file(s) from %s", count, sbBasename(zipPath)), int64(count), total)

	sfx := ""
	if sessionID != "" {
		sfx = fmt.Sprintf(" (session %s)", sessionID)
	}
	log.Printf("[BasketAction] extract: %d file(s) from %s → \"%s\"%s", count, zipPath, sbS(basket, "name"), sfx)
	out := om(
		"operation", "extract", "destinationBasket", sbS(basket, "name"), "sourceFile", zipPath,
		"extracted", float64(count), "totalSize", float64(total), "status", "success", "timestamp", sbISO(sbNow()),
	)
	if sessionID != "" {
		jsSet(out, "sessionId", sessionID)
	}
	return out, nil
}

func sbZipEntryData(f *zip.File) ([]byte, error) {
	rc, err := f.Open()
	if err != nil {
		return nil, err
	}
	defer rc.Close()
	return io.ReadAll(rc)
}

// genBatchName of BasketActionExecutor (all placeholders replaced globally).
func sbGenBatchNameBA(pattern string) string {
	now := time.Now()
	y := now.Year()
	by := y + 543
	ys, bys := strconv.Itoa(y), strconv.Itoa(by)
	name := pattern
	for _, kv := range [][2]string{
		{"{YYYY+543}", bys}, {"{BYYYY}", bys}, {"{YYYY}", ys}, {"{YY}", ys[len(ys)-2:]}, {"{BYY}", bys[len(bys)-2:]},
		{"{MM}", sbPad2(int(now.Month()))}, {"{DD}", sbPad2(now.Day())},
		{"{YYYYMMDD}", fmt.Sprintf("%d%s%s", y, sbPad2(int(now.Month())), sbPad2(now.Day()))},
		{"{HH}", sbPad2(now.Hour())}, {"{mm}", sbPad2(now.Minute())}, {"{ss}", sbPad2(now.Second())},
	} {
		name = strings.ReplaceAll(name, kv[0], kv[1])
	}
	name = strings.ReplaceAll(name, "{NNN}", "{SEQ3}")
	name = strings.ReplaceAll(name, "{NN}", "{SEQ2}")
	return strings.ReplaceAll(name, "{N}", "{SEQ1}")
}

var sbSeqRe = regexp.MustCompile(`\{SEQ(\d)?\}`)

func sbEnsureBatchSessionBA(basket map[string]any, mode string) (string, string, error) {
	if mode == "" {
		mode = "existing_or_new"
	}
	bid := sbS(basket, "id")
	var session map[string]any
	var err error
	if mode == "existing_or_new" || mode == "reuse_existing" {
		session, err = sbOne(`SELECT * FROM processing_sessions WHERE "basketId"=$1 AND "status"='open' ORDER BY "startedAt" DESC LIMIT 1`, bid)
		if err != nil {
			return "", "", err
		}
	}
	if mode == "reuse_existing" && session == nil {
		return "", "", errors.New(`No open session found for basket — create one first or use sessionMode "existing_or_new".`)
	}
	if session == nil {
		pat := sbS(basket, "sessionPattern")
		if pat == "" {
			pat = "{YYYY+543}-{NN}"
		}
		base := sbGenBatchNameBA(pat)
		if m := sbSeqRe.FindStringSubmatchIndex(base); m != nil {
			digits := 3
			if m[2] >= 0 {
				digits, _ = strconv.Atoi(base[m[2]:m[3]])
			}
			from := sbLocalMidnight(time.Now().Year(), 1, 1)
			rows, err := appQuery(`SELECT count(*)::int AS n FROM processing_sessions WHERE "basketId"=$1 AND "startedAt" >= $2`, bid, from)
			if err != nil {
				return "", "", err
			}
			n := sbI(rows[0], "n") + 1
			seq := strconv.FormatInt(n, 10)
			if digits != 1 {
				seq = fmt.Sprintf("%0*d", digits, n)
			}
			base = base[:m[0]] + seq + base[m[1]:]
		}
		nm, sfx := base, 1
		for {
			ex, err := sbOne(`SELECT "id" FROM processing_sessions WHERE "batchName"=$1 AND "basketId"=$2 LIMIT 1`, nm, bid)
			if err != nil {
				return "", "", err
			}
			if ex == nil {
				break
			}
			nm = fmt.Sprintf("%s-%d", base, sfx)
			sfx++
		}
		if session, err = sbCreateSession(bid, nm, 0, 0); err != nil {
			return "", "", err
		}
	}
	folder := sbJoin(sbS(basket, "path"), "sessions", sbS(session, "batchName"))
	if !sbExists(folder) {
		if err := sbMkdirAll(folder); err != nil {
			return "", "", err
		}
	}
	return sbS(session, "id"), folder, nil
}

// ── destination folder / source files ──────────────────────────────────────

func sbEnsureDestinationFolder(dst map[string]any, targetFolder string) (string, string, error) {
	if targetFolder == "" {
		return sbS(dst, "path"), "", nil
	}
	if sbS(dst, "type") == "shares" {
		disk := sbJoin(sbS(dst, "path"), "folders", targetFolder)
		if !sbExists(disk) {
			if err := sbMkdirAll(disk); err != nil {
				return "", "", err
			}
		}
		parentID, cur, folderID := "", "", ""
		for _, part := range strings.Split(targetFolder, "/") {
			if part == "" {
				continue
			}
			if cur == "" {
				cur = part
			} else {
				cur = cur + "/" + part
			}
			f, err := sbOne(`SELECT * FROM basket_folders WHERE "basketId"=$1 AND "path"=$2 LIMIT 1`, sbS(dst, "id"), cur)
			if err != nil {
				return "", "", err
			}
			if f == nil {
				if f, err = sbCreateFolder(sbS(dst, "id"), part, cur, parentID); err != nil {
					return "", "", err
				}
				log.Printf("[BasketAction] Created folder \"%s\" in basket \"%s\"", cur, sbS(dst, "name"))
			}
			parentID = sbS(f, "id")
			folderID = parentID
		}
		return disk, folderID, nil
	}
	dir := sbJoin(sbS(dst, "path"), targetFolder)
	if !sbExists(dir) {
		if err := sbMkdirAll(dir); err != nil {
			return "", "", err
		}
	}
	return dir, "", nil
}

func sbMatchPatternBA(name, pattern string) (bool, error) {
	if pattern == "*" || pattern == "*.*" {
		return true, nil
	}
	re, err := sbGlobLoose(pattern, true)
	if err != nil {
		return false, err
	}
	return re.MatchString(name), nil
}

func sbCollectSourceFiles(d map[string]any, ctx *Ctx, srcID string) ([]sbSrcFile, error) {
	pattern := "*"
	if truthy(d["filePattern"]) {
		pattern = sbStrOf(d["filePattern"])
	}
	sessionID := ""
	if truthy(d["sourceSessionId"]) {
		sessionID = sbStrOf(d["sourceSessionId"])
	}
	if sessionID == "" {
		if v := asMap(ctx.Input)["sessionId"]; truthy(v) {
			sessionID = sbStrOf(v)
		}
	}
	if sessionID == "" {
		s, err := sbOne(`SELECT "id" FROM processing_sessions WHERE "basketId"=$1 ORDER BY "startedAt" DESC LIMIT 1`, srcID)
		if err != nil {
			return nil, err
		}
		if s != nil {
			sessionID = sbS(s, "id")
		}
	}
	q := `SELECT * FROM basket_files WHERE "basketId"=$1`
	args := []any{srcID}
	if sessionID != "" {
		args = append(args, sessionID)
		q += fmt.Sprintf(` AND "sessionId"=$%d`, len(args))
	}
	if fs := d["fileStatus"]; truthy(fs) && fs != "all" {
		args = append(args, sbStrOf(fs))
		q += fmt.Sprintf(` AND "status"=$%d`, len(args))
	}
	q += ` ORDER BY "createdAt" ASC`
	rows, err := appQuery(q, args...)
	if err != nil {
		return nil, err
	}
	var out []sbSrcFile
	for _, bf := range rows {
		ok, err := sbMatchPatternBA(sbS(bf, "fileName"), pattern)
		if err != nil {
			return nil, err
		}
		if ok && sbExists(sbS(bf, "path")) {
			out = append(out, sbSrcFile{ID: sbS(bf, "id"), Name: sbS(bf, "fileName"), Path: sbS(bf, "path"), Size: sbI(bf, "size")})
		}
	}
	return out, nil
}

func sbMimeBA(name string) string {
	switch strings.ToLower(sbExtname(name)) {
	case ".csv":
		return "text/csv"
	case ".txt":
		return "text/plain"
	case ".json":
		return "application/json"
	case ".xml":
		return "application/xml"
	case ".xlsx":
		return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
	case ".pdf":
		return "application/pdf"
	case ".zip":
		return "application/zip"
	}
	return "application/octet-stream"
}

func sbFlowID(r *Run) any {
	if r.flow == nil || r.flow.OperationID == "" {
		return undefinedV
	}
	return r.flow.OperationID
}

// ── copy ─────────────────────────────────────────────────────────────────────

func sbCopyFiles(r *Run, files []sbSrcFile, destDir, targetFolder, folderID string, d map[string]any) (any, error) {
	dstID := sbStrOf(d["destinationBasketId"])
	var results []any
	copied, skipped := 0, 0
	var total int64
	for _, f := range files {
		err := func() error {
			destPath := sbJoin(destDir, f.Name)
			if sbExists(destPath) {
				if !truthy(d["overwrite"]) {
					results = append(results, om("name", f.Name, "size", float64(f.Size), "success", true, "error", "skipped (exists)"))
					skipped++
					return nil
				}
				q := `DELETE FROM basket_files WHERE "basketId"=$1 AND "fileName"=$2`
				args := []any{dstID, f.Name}
				if folderID != "" {
					q += ` AND "folderId"=$3`
					args = append(args, folderID)
				}
				if _, err := appExec(q, args...); err != nil {
					return err
				}
			}
			if err := sbCopyFile(f.Path, destPath); err != nil {
				return err
			}
			size, err := sbStatSize(destPath)
			if err != nil {
				return err
			}
			total += size
			meta := sbStringify(sbObj{{"source", "basket-action"}, {"operation", "copy"}, {"sourceBasketId", sbDef(d, "sourceBasketId")},
				{"targetFolder", targetFolder}, {"flowId", sbFlowID(r)}, {"copiedAt", sbISO(sbNow())}})
			if _, err := sbCreateFile(sbFileRow{BasketID: dstID, FileName: f.Name, OriginalName: f.Name, Size: size,
				MimeType: sbMimeBA(f.Name), Path: destPath, Status: "uploaded", FolderID: folderID, Metadata: meta}); err != nil {
				return err
			}
			results = append(results, om("name", f.Name, "size", float64(size), "success", true))
			copied++
			return nil
		}()
		if err != nil {
			results = append(results, om("name", f.Name, "size", float64(f.Size), "success", false, "error", err.Error()))
		}
	}
	if results == nil {
		results = []any{}
	}
	// "skipped" counts every result whose error mentions it (a copy error
	// text containing "skipped" would count too, as in the TS).
	skipped = 0
	copied = 0
	for _, x := range results {
		m := x.(map[string]any)
		e, _ := m["error"].(string)
		if m["success"] == true && !strings.Contains(e, "skipped") {
			copied++
		}
		if strings.Contains(e, "skipped") {
			skipped++
		}
	}
	return om("filesCopied", float64(copied), "filesSkipped", float64(skipped), "totalSize", float64(total), "files", results), nil
}

// ── zip ──────────────────────────────────────────────────────────────────────

func sbZipFiles(r *Run, files []sbSrcFile, destDir string, dst map[string]any, targetFolder, folderID string, d map[string]any) (any, error) {
	dstID := sbStrOf(d["destinationBasketId"])
	now := time.Now()
	year := now.Year()
	by := strconv.Itoa(year + 543)
	first := "archive"
	if len(files) > 0 {
		first = sbBasename(files[0].Name, sbExtname(files[0].Name))
	}
	name := sbS(dst, "name") + "_{{date}}.zip"
	if truthy(d["zipFileName"]) {
		name = sbStrOf(d["zipFileName"])
	}
	for _, kv := range [][2]string{
		{"{{fileName}}", first}, {"{{timestamp}}", strconv.FormatInt(time.Now().UnixMilli(), 10)},
		{"{{date}}", sbISO(now)[:10]}, {"{{year}}", strconv.Itoa(year)}, {"{{buddhistYear}}", by}, {"{{BYYYY}}", by},
		{"{YYYY+543}", by}, {"{BYYYY}", by}, {"{YYYY}", strconv.Itoa(year)},
		{"{MM}", sbPad2(int(now.Month()))}, {"{DD}", sbPad2(now.Day())},
	} {
		name = strings.ReplaceAll(name, kv[0], kv[1])
	}
	if !strings.HasSuffix(strings.ToLower(name), ".zip") {
		name += ".zip"
	}

	tmp := sbJoin("/tmp", fmt.Sprintf("basket_zip_%d_%s", time.Now().UnixMilli(), name))
	level := 6
	if l, ok := num(d, "compressionLevel"); ok && l != 0 {
		level = int(l)
	}
	if err := sbCreateZip(files, tmp, level); err != nil {
		return nil, err
	}
	zipSize, err := sbStatSize(tmp)
	if err != nil {
		return nil, err
	}
	destZip := sbJoin(destDir, name)
	if d["overwrite"] != false && sbExists(destZip) {
		q := `DELETE FROM basket_files WHERE "basketId"=$1 AND "fileName"=$2`
		args := []any{dstID, name}
		if folderID != "" {
			q += ` AND "folderId"=$3`
			args = append(args, folderID)
		}
		if _, err := appExec(q, args...); err != nil {
			return nil, err
		}
	} else if d["overwrite"] == false && sbExists(destZip) {
		_ = os.Remove(tmp)
		return om("fileName", name, "filePath", destZip, "skipped", true, "reason", "File already exists and overwrite is disabled"), nil
	}
	if err := sbCopyFile(tmp, destZip); err != nil {
		return nil, err
	}
	_ = os.Remove(tmp)

	names := make([]string, len(files))
	namesAny := make([]any, len(files))
	var orig int64
	for i, f := range files {
		names[i] = f.Name
		namesAny[i] = f.Name
		orig += f.Size
	}
	meta := sbStringify(sbObj{{"source", "basket-action"}, {"operation", "zip"}, {"sourceBasketId", sbDef(d, "sourceBasketId")},
		{"targetFolder", targetFolder}, {"flowId", sbFlowID(r)}, {"filesIncluded", len(files)}, {"fileNames", names}, {"createdAt", sbISO(sbNow())}})
	fileID, err := sbCreateFile(sbFileRow{BasketID: dstID, FileName: name, OriginalName: name, Size: zipSize, MimeType: "application/zip",
		Path: destZip, Status: "uploaded", FolderID: folderID, Metadata: meta})
	if err != nil {
		return nil, err
	}
	logMeta := sbStringify(sbObj{{"sourceBasket", sbDef(d, "sourceBasketId")}, {"filesIncluded", len(files)}, {"zipSize", zipSize}, {"originalSize", orig}})
	if err := sbCreateFileLog(fileID, "file_created", "success", fmt.Sprintf("ZIP %s created with %d files", name, len(files)), logMeta); err != nil {
		return nil, err
	}
	log.Printf("[BasketAction/ZIP] Created %s: %d bytes (%d files)", name, zipSize, len(files))
	return om(
		"fileName", name, "filePath", destZip, "fileId", fileID, "zipSize", float64(zipSize),
		"originalSize", float64(orig), "filesIncluded", float64(len(files)), "fileNames", namesAny,
	), nil
}

// sbCreateZip writes the files into a deflate ZIP (archiver 'zip' with zlib level).
func sbCreateZip(files []sbSrcFile, out string, level int) error {
	if level < -1 || level > 9 {
		return fmt.Errorf("Invalid compression level: %d", level)
	}
	f, err := os.Create(out)
	if err != nil {
		return sbFsErr(err, "open", out)
	}
	zw := zip.NewWriter(f)
	zw.RegisterCompressor(zip.Deflate, func(w io.Writer) (io.WriteCloser, error) { return flate.NewWriter(w, level) })
	for _, sf := range files {
		st, err := os.Stat(sf.Path)
		if err != nil {
			zw.Close()
			f.Close()
			return sbFsErr(err, "stat", sf.Path)
		}
		h, _ := zip.FileInfoHeader(st)
		h.Name = sf.Name
		h.Method = zip.Deflate
		w, err := zw.CreateHeader(h)
		if err != nil {
			zw.Close()
			f.Close()
			return err
		}
		in, err := os.Open(sf.Path)
		if err != nil {
			zw.Close()
			f.Close()
			return sbFsErr(err, "open", sf.Path)
		}
		_, err = io.Copy(w, in)
		in.Close()
		if err != nil {
			zw.Close()
			f.Close()
			return err
		}
	}
	if err := zw.Close(); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

func sbDeleteSourceFiles(files []sbSrcFile) any {
	deleted := 0
	for _, f := range files {
		if sbExists(f.Path) {
			if err := os.Remove(f.Path); err != nil {
				continue
			}
		}
		if err := sbUpdate("basket_files", f.ID, true, sbObj{{"status", "archived"}}); err != nil {
			continue
		}
		deleted++
	}
	return om("filesDeleted", float64(deleted), "totalFiles", float64(len(files)))
}

// ── target folder ────────────────────────────────────────────────────────────

var sbCtxTemplate = regexp.MustCompile(`\{\{([^}]+)\}\}`)

func sbResolveTargetFolder(r *Run, folder string, ctx *Ctx) string {
	if folder == "" {
		return ""
	}
	now := time.Now()
	y := now.Year()
	ys, bys := strconv.Itoa(y), strconv.Itoa(y+543)
	s := folder
	for _, kv := range [][2]string{
		{"{YYYY+543}", bys}, {"{BYYYY}", bys}, {"{YYYY}", ys}, {"{YY}", ys[len(ys)-2:]}, {"{BYY}", bys[len(bys)-2:]},
		{"{MM}", sbPad2(int(now.Month()))}, {"{DD}", sbPad2(now.Day())},
		{"{YYYYMMDD}", strings.ReplaceAll(sbISO(now)[:10], "-", "")},
	} {
		s = strings.ReplaceAll(s, kv[0], kv[1])
	}
	if !strings.Contains(s, "{{") {
		return s
	}
	// {{a.b}} walks the ExecutionContext object: input, flow (variables is a
	// Map there, so {{variables.x}} stays unresolved).
	var flowObj any = undefinedV
	if r.flow != nil {
		b, _ := json.Marshal(r.flow)
		var m map[string]any
		_ = json.Unmarshal(b, &m)
		flowObj = m
	}
	root := om("input", ctx.Input, "flow", flowObj, "variables", map[string]any{})
	return sbCtxTemplate.ReplaceAllStringFunc(s, func(m string) string {
		keys := strings.Split(strings.TrimSpace(m[2:len(m)-2]), ".")
		var v any = root
		for _, k := range keys {
			if v == nil || v == undefinedV {
				v = undefinedV
				break
			}
			v = prop(v, k)
		}
		if v == undefinedV {
			return m
		}
		return jsString(v)
	})
}
