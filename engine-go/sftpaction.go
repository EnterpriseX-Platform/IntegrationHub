package main

// Port of server/src/sdk/execution/executors/SFTPActionExecutor.ts:
// upload basket files to SFTP (status uploaded→transferred→archived, session
// completion) and download SFTP files into a basket (session per run for
// batch baskets, re-download de-duplication, decryption, ZIP extraction).

import (
	"errors"
	"fmt"
	"log"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"archive/zip"
	"encoding/json"
)

func init() { nativeExecutors["sftp-action"] = execSFTPAction }

// sbConnLookup returns a stored connection (overridable in tests).
var sbConnLookup = func(r *Run, id string) (map[string]any, error) { return r.fallback.connection(id) }

func execSFTPAction(r *Run, node *Node, ctx *Ctx) (any, error) {
	d := node.Data
	if !truthy(d["connectionId"]) {
		return nil, errors.New("SFTP connection ID is required")
	}
	conn, err := sbConnLookup(r, sbStrOf(d["connectionId"]))
	if err != nil {
		return nil, err
	}
	var config map[string]any
	switch c := conn["config"].(type) {
	case map[string]any:
		config = c
	case string:
		if err := json.Unmarshal([]byte(c), &config); err != nil {
			return nil, fmt.Errorf("Unexpected token in JSON at position 0")
		}
	}
	if config == nil {
		config = map[string]any{}
	}

	op := "upload"
	if truthy(d["operation"]) {
		op = sbStrOf(d["operation"])
	}
	if op == "download-new-folders" || (op == "download" && d["newFoldersOnly"] == true) {
		tmpl := func(k string) any {
			s, ok := d[k].(string)
			if !ok || s == "" {
				return nil
			}
			return ctx.resolveTemplate(s)
		}
		remote := ""
		if s, ok := d["remotePath"].(string); ok {
			remote = sbStrOf(ctx.resolveTemplate(s))
		}
		link := sbStrOf(d["linkBaseUrl"])
		if link == "" {
			link = os.Getenv("PUBLIC_APP_URL")
		}
		maxF, _ := num(d, "maxFolders")
		opts := sbFolderSyncOpts{
			RemotePath: remote, FilePattern: sbStrOf(d["filePattern"]),
			TargetFolder: sbStrOf(tmpl("targetFolder")), StartFromFolder: sbStrOf(tmpl("startFromFolder")),
			MaxFolders: int(maxF), LinkBaseURL: link, GroupByFiscalYear: d["groupByFiscalYear"] == true,
			BasketID: sbStrOf(d["basketId"]), ExplorerBasketID: sbStrOf(d["explorerBasketId"]), EncryptionKeyID: sbStrOf(d["encryptionKeyId"]),
		}
		return sbDownloadNewFolders(config, opts, func(level, msg string) { r.log(level, node.ID, msg, nil) })
	}
	if op == "download" {
		return sbExecuteDownload(config, d)
	}
	return sbExecuteUpload(r, node, config, d, ctx)
}

var sbUploadStatusMap = map[string][]string{
	"ready":       {"pending", "uploaded", "published"},
	"all":         {"pending", "uploaded", "published", "processing", "transferred", "archived", "failed"},
	"pending":     {"pending"},
	"uploaded":    {"uploaded"},
	"published":   {"published"},
	"processing":  {"processing"},
	"transferred": {"transferred"},
	"archived":    {"archived"},
	"failed":      {"failed"},
}

// sbAsStrings reads a variable holding a string array ([]any from JSON or []string).
func sbAsStrings(v any) ([]string, bool) {
	switch t := v.(type) {
	case []string:
		return t, true
	case []any:
		out := make([]string, len(t))
		for i, x := range t {
			out[i] = jsString(x)
		}
		return out, true
	}
	return nil, false
}

// ── upload ───────────────────────────────────────────────────────────────────

func sbExecuteUpload(r *Run, node *Node, config, d map[string]any, ctx *Ctx) (any, error) {
	fileStatus := "published"
	if truthy(d["fileStatus"]) {
		fileStatus = sbStrOf(d["fileStatus"])
	}
	pattern := "*.*"
	if truthy(d["filePattern"]) {
		pattern = sbStrOf(d["filePattern"])
	}
	var files []map[string]any
	var sessionID any = undefinedV
	basketID := sbStrOf(d["basketId"])
	if truthy(d["basketId"]) {
		b, err := sbBasket(basketID)
		if err != nil {
			return nil, err
		}
		if b == nil {
			return nil, fmt.Errorf("Basket not found: %s", basketID)
		}
		selected, ok := sbUploadStatusMap[fileStatus]
		if !ok {
			selected = []string{"pending", "uploaded", "published"}
		}
		tIDs, isArr := sbAsStrings(ctx.Vars["triggerSessionIds"])
		tBasket, _ := ctx.Vars["basketId"].(string)
		if isArr && len(tIDs) > 0 && tBasket == basketID {
			files, err = appQuery(`SELECT * FROM basket_files WHERE "basketId"=$1 AND "sessionId" = ANY($2) AND "status" = ANY($3) ORDER BY "createdAt" ASC`,
				basketID, tIDs, []string{"pending", "uploaded", "published"})
			if err != nil {
				return nil, err
			}
			r.log("info", node.ID, "Sending ready files from triggering session(s): "+strings.Join(tIDs, ", "), nil)
		} else {
			files, err = appQuery(`SELECT * FROM basket_files WHERE "basketId"=$1 AND "status" = ANY($2) ORDER BY "createdAt" ASC`, basketID, selected)
			if err != nil {
				return nil, err
			}
		}
		re, err := sbGlobLoose(pattern, false)
		if err != nil {
			return nil, err
		}
		kept := files[:0]
		for _, f := range files {
			if re.MatchString(sbS(f, "fileName")) {
				kept = append(kept, f)
			}
		}
		files = kept
		if len(files) > 0 && sbS(files[0], "sessionId") != "" {
			sessionID = sbS(files[0], "sessionId")
		}
	}

	base := func() map[string]any {
		m := om("operation", "upload", "pattern", pattern, "fileStatus", fileStatus)
		sbPut(m, "basketId", sbDef(d, "basketId"))
		sbPut(m, "sessionId", sessionID)
		return m
	}
	if len(files) == 0 {
		m := base()
		jsSet(m, "filesFound", float64(0))
		jsSet(m, "uploads", []any{})
		jsSet(m, "status", "no_files")
		jsSet(m, "message", fmt.Sprintf("No %s files matching \"%s\" found", fileStatus, pattern))
		jsSet(m, "executedAt", sbISO(sbNow()))
		return m, nil
	}

	var uploads []map[string]any
	for _, f := range files {
		res := sbUploadSingleFile(config, f, d)
		uploads = append(uploads, res)
		if truthy(d["deleteAfterUpload"]) && res["success"] == true {
			p := sbS(f, "path")
			err := func() error {
				if sbExists(p) {
					if err := sbUnlink(p); err != nil {
						return err
					}
				}
				return sbDeleteByID("basket_files", sbS(f, "id"))
			}()
			if err != nil {
				log.Printf("Failed to delete file %s: %s", p, err.Error())
			}
		}
	}

	ok := map[string]bool{}
	allOK := true
	for _, u := range uploads {
		if u["success"] == true {
			ok[u["fileId"].(string)] = true
		} else {
			allOK = false
		}
	}
	if len(ok) > 0 && truthy(d["archiveAfterUpload"]) {
		var order []string
		by := map[string][]string{}
		for _, f := range files {
			id := sbS(f, "id")
			if !ok[id] {
				continue
			}
			sid := sbS(f, "sessionId")
			if sid == "" {
				sid = "__none__"
			}
			if _, seen := by[sid]; !seen {
				order = append(order, sid)
			}
			by[sid] = append(by[sid], id)
		}
		for _, sid := range order {
			if sid != "__none__" {
				sbArchiveSessionFiles(sid, by[sid])
			} else {
				_, _ = appExec(`UPDATE basket_files SET "status"='archived', "updatedAt"=$2 WHERE "id" = ANY($1)`, by[sid], sbNow())
			}
		}
	}
	var sessionResult any
	if sid, isStr := sessionID.(string); isStr && len(uploads) > 0 && allOK && (truthy(d["archiveAfterUpload"]) || truthy(d["publishAfterTransfer"])) {
		sessionResult = sbCompleteSession(sid, true)
	}

	m := base()
	jsSet(m, "filesFound", float64(len(files)))
	ups := make([]any, len(uploads))
	for i, u := range uploads {
		ups[i] = u
	}
	jsSet(m, "uploads", ups)
	jsSet(m, "sessionResult", sessionResult)
	jsSet(m, "status", "success")
	jsSet(m, "executedAt", sbISO(sbNow()))
	return m, nil
}

func sbResolveFileName(tmpl, original string) string {
	s := strings.ReplaceAll(tmpl, "{{original}}", original)
	s = strings.ReplaceAll(s, "{{date}}", sbISO(sbNow())[:10])
	s = strings.ReplaceAll(s, "{{timestamp}}", strconv.FormatInt(time.Now().UnixMilli(), 10))
	noExt := regexp.MustCompile(`\.[^/.]+$`).ReplaceAllString(original, "")
	s = strings.ReplaceAll(s, "{{filename}}", noExt)
	ext := original
	if i := strings.LastIndex(original, "."); i >= 0 {
		ext = original[i+1:]
	}
	return strings.ReplaceAll(s, "{{extension}}", ext)
}

func sbUploadSingleFile(config, f, d map[string]any) map[string]any {
	original := sbS(f, "originalName")
	if original == "" {
		original = sbS(f, "fileName")
	}
	remoteName := original
	if truthy(d["remoteFileName"]) {
		remoteName = sbResolveFileName(sbStrOf(d["remoteFileName"]), original)
	}
	basePath := "/"
	if truthy(config["basePath"]) {
		basePath = sbStrOf(config["basePath"])
	}
	remotePath := ""
	if truthy(d["remotePath"]) {
		remotePath = sbStrOf(d["remotePath"])
	}
	local := sbS(f, "path")
	uploadPath := local
	finalName := remoteName
	encrypted := false
	encAlg := ""
	if truthy(d["encryptionKeyId"]) {
		out, alg, err := sbEncryptFile(local, sbStrOf(d["encryptionKeyId"]))
		if err != nil {
			return om("fileId", sbS(f, "id"), "fileName", original, "success", false, "error", "Encryption failed: "+err.Error())
		}
		uploadPath = out
		if alg == "pgp" {
			finalName = remoteName + ".pgp"
		} else {
			finalName = remoteName + ".enc"
		}
		encrypted, encAlg = true, alg
	}
	full := sbJoin(basePath, remotePath, finalName)
	err := sbUploadFile(config, uploadPath, full)
	if encrypted && uploadPath != local {
		_ = os.Remove(uploadPath)
	}
	if err == nil {
		err = sbUpdate("basket_files", sbS(f, "id"), true, sbObj{{"status", "transferred"}})
		if err == nil {
			m := om("fileId", sbS(f, "id"), "localFile", local, "fileName", original, "remotePath", full,
				"remoteFileName", finalName, "size", float64(sbI(f, "size")), "encrypted", encrypted, "success", true)
			if encAlg != "" {
				jsSet(m, "encryptionAlgorithm", encAlg)
			}
			return m
		}
	}
	return om("fileId", sbS(f, "id"), "localFile", local, "fileName", original, "remotePath", full,
		"remoteFileName", finalName, "success", false, "error", err.Error())
}

// sbUploadFile: connect, mkdir(dirname) ignoring errors, stream the file.
func sbUploadFile(config map[string]any, localPath, remotePath string) error {
	s, err := sbConnect(config, sbConnOpts{})
	if err != nil {
		return err
	}
	defer s.Close()
	_ = s.client.Mkdir(sbDirname(remotePath))
	in, err := os.Open(localPath)
	if err != nil {
		return fmt.Errorf("Cannot read local file %s: %s", localPath, sbFsErr(err, "open", localPath).Error())
	}
	defer in.Close()
	out, err := s.client.OpenFile(remotePath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC)
	if err != nil {
		return sbSFTPErr(err)
	}
	if _, err := out.ReadFrom(in); err != nil {
		out.Close()
		var pe *os.PathError
		if errors.As(err, &pe) {
			return fmt.Errorf("Cannot read local file %s: %s", localPath, sbFsErr(err, "read").Error())
		}
		return sbSFTPErr(err)
	}
	return sbSFTPErr(out.Close())
}

func sbArchiveSessionFiles(sessionID string, ids []string) {
	err := func() error {
		sess, err := sbOne(`SELECT s."batchName", b."path" AS "basketPath" FROM processing_sessions s JOIN baskets b ON b."id"=s."basketId" WHERE s."id"=$1`, sessionID)
		if err != nil {
			return err
		}
		if sess == nil {
			return nil
		}
		dir := sbJoin(sbS(sess, "basketPath"), "archive", sbS(sess, "batchName"))
		if !sbExists(dir) {
			if err := sbMkdirAll(dir); err != nil {
				return err
			}
		}
		for _, id := range ids {
			f, err := sbOne(`SELECT "path","fileName" FROM basket_files WHERE "id"=$1`, id)
			if err != nil {
				return err
			}
			if f != nil && sbExists(sbS(f, "path")) {
				ap := sbJoin(dir, sbS(f, "fileName"))
				if err := sbRename(sbS(f, "path"), ap); err != nil {
					return err
				}
				if err := sbUpdate("basket_files", id, true, sbObj{{"status", "archived"}, {"path", ap}}); err != nil {
					return err
				}
			}
		}
		log.Printf("[SFTP] Archived %d files to %s", len(ids), dir)
		return nil
	}()
	if err != nil {
		log.Printf("Failed to archive session files: %s", err.Error())
	}
}

func sbCompleteSession(sessionID string, allSuccess bool) any {
	status := "archived"
	if allSuccess {
		status = "completed"
	}
	now := sbNow()
	if err := sbUpdate("processing_sessions", sessionID, false, sbObj{{"status", status}, {"completedAt", now}}); err != nil {
		log.Printf("Failed to complete session: %s", err.Error())
		return om("success", false, "error", "Error: "+err.Error())
	}
	meta := sbStringify(sbObj{{"allSuccess", allSuccess}, {"completedAt", sbNow()}})
	if err := sbCreateSessionLog(sessionID, "session_completed", fmt.Sprintf("Session %s after SFTP transfer", status), meta); err != nil {
		log.Printf("Failed to complete session: %s", err.Error())
		return om("success", false, "error", "Error: "+err.Error())
	}
	log.Printf("[SFTP] Session %s marked as %s", sessionID, status)
	return om("success", true, "status", status, "completedAt", sbISO(now))
}

// ── download ─────────────────────────────────────────────────────────────────

func sbExecuteDownload(config, d map[string]any) (any, error) {
	base := "/"
	if truthy(config["basePath"]) {
		base = sbStrOf(config["basePath"])
	}
	remotePath := base
	if rp := sbStrOf(d["remotePath"]); truthy(d["remotePath"]) && rp != "/" {
		remotePath = sbJoin(base, rp)
	}
	pattern := "*.*"
	if truthy(d["filePattern"]) {
		pattern = sbStrOf(d["filePattern"])
	}
	basketPath := "/data/incoming"
	var basketID any = undefinedV
	if truthy(d["basketId"]) {
		b, err := sbBasket(sbStrOf(d["basketId"]))
		if err != nil {
			return nil, err
		}
		if b != nil {
			basketPath = sbS(b, "path")
			basketID = sbS(b, "id")
		}
	}
	if !sbExists(basketPath) {
		if err := sbMkdirAll(basketPath); err != nil {
			return nil, err
		}
	}
	bid, _ := basketID.(string)
	downloads, err := sbDownloadFiles(config, remotePath, basketPath, pattern, truthy(d["deleteAfterDownload"]), bid, d["autoCreateSession"], sbStrOf(d["sessionMode"]))
	if err != nil {
		return nil, err
	}
	var sessionID string
	for _, dl := range downloads {
		if dl["success"] == true {
			sessionID, _ = dl["sessionId"].(string)
			break
		}
	}

	var decrypted []any
	if truthy(d["encryptionKeyId"]) {
		for _, dl := range downloads {
			if dl["success"] != true {
				continue
			}
			lp := dl["localPath"].(string)
			out, alg, err := sbDecryptFile(lp, sbStrOf(d["encryptionKeyId"]))
			if err == nil && sbExists(out) && out != lp {
				err = func() error {
					if err := sbUnlink(lp); err != nil {
						return err
					}
					jsSet(dl, "localPath", out)
					jsSet(dl, "fileName", sbBasename(out))
					jsSet(dl, "decrypted", true)
					jsSet(dl, "decryptionAlgorithm", alg)
					size, err := sbStatSize(out)
					if err != nil {
						return err
					}
					jsSet(dl, "size", float64(size))
					if fid, ok := dl["fileId"].(string); ok && fid != "" {
						return sbUpdate("basket_files", fid, true, sbObj{{"fileName", dl["fileName"]}, {"originalName", dl["fileName"]}, {"path", out}, {"size", int32(size)}})
					}
					return nil
				}()
			}
			if err != nil {
				decrypted = append(decrypted, om("file", dl["fileName"], "success", false, "error", err.Error()))
			} else {
				decrypted = append(decrypted, om("file", dl["fileName"], "algorithm", alg, "success", true))
			}
		}
	}

	var extracted []any
	if truthy(d["extractZipFiles"]) {
		for _, dl := range downloads {
			name, _ := dl["fileName"].(string)
			if dl["success"] != true || !strings.HasSuffix(strings.ToLower(name), ".zip") {
				continue
			}
			list, err := sbExtractZipFile(dl["localPath"].(string), basketPath, bid, sessionID)
			if err != nil {
				log.Printf("Failed to extract %s: %s", name, err.Error())
				extracted = append(extracted, om("zipFile", name, "error", err.Error()))
			} else {
				extracted = append(extracted, om("zipFile", name, "extracted", list))
			}
		}
	}

	ok, skipped := 0, 0
	dls := make([]any, len(downloads))
	for i, dl := range downloads {
		if dl["success"] == true {
			ok++
		}
		if dl["skipped"] == true {
			skipped++
		}
		dls[i] = dl
	}
	out := om(
		"operation", "download", "remotePath", remotePath, "basketPath", basketPath, "pattern", pattern,
		"filesDownloaded", float64(ok), "filesSkipped", float64(skipped), "downloads", dls,
		"status", "success", "executedAt", sbISO(sbNow()),
	)
	sbPut(out, "basketId", basketID)
	if len(extracted) > 0 {
		jsSet(out, "extractedFiles", extracted)
	}
	if len(decrypted) > 0 {
		jsSet(out, "decryptedFiles", decrypted)
	}
	return out, nil
}

// sbExtractZipFile ports extractZipFile (adm-zip extractEntryTo, keeping paths).
func sbExtractZipFile(zipPath, extractTo, basketID, sessionID string) ([]any, error) {
	zr, err := zip.OpenReader(zipPath)
	if err != nil {
		return nil, errors.New("Invalid or unsupported zip format. No END header found")
	}
	defer zr.Close()
	folder := sbJoin(extractTo, sbBasename(zipPath, ".zip"))
	if !sbExists(folder) {
		if err := sbMkdirAll(folder); err != nil {
			return nil, err
		}
	}
	out := []any{}
	for _, f := range zr.File {
		if strings.HasSuffix(f.Name, "/") {
			continue
		}
		entryPath := sbJoin(folder, f.Name)
		if parent := sbDirname(entryPath); !sbExists(parent) {
			if err := sbMkdirAll(parent); err != nil {
				return nil, err
			}
		}
		target := sbAdmSanitize(folder, f.Name)
		if err := sbMkdirAll(sbDirname(target)); err != nil {
			return nil, err
		}
		data, err := sbZipEntryData(f)
		if err != nil {
			return nil, err
		}
		if err := sbWriteFile(target, data); err != nil {
			return nil, err
		}
		out = append(out, f.Name)
		if basketID != "" {
			size, err := sbStatSize(entryPath)
			if err != nil {
				return nil, err
			}
			if _, err := sbCreateFile(sbFileRow{BasketID: basketID, SessionID: sessionID, FileName: f.Name, OriginalName: f.Name,
				Size: size, MimeType: "application/octet-stream", Path: entryPath, Status: "uploaded"}); err != nil {
				return nil, err
			}
		}
	}
	return out, nil
}

// sbAdmSanitize ports adm-zip's sanitize(prefix, name): the entry path kept
// inside prefix (a "../" entry cannot escape the folder).
func sbAdmSanitize(prefix, name string) string {
	prefix = sbNormalize(prefix)
	if !strings.HasPrefix(prefix, "/") {
		wd, _ := os.Getwd()
		prefix = sbJoin(wd, prefix)
	}
	prefix = strings.TrimSuffix(prefix, "/")
	parts := strings.Split(name, "/")
	for i := range parts {
		p := sbNormalize(sbJoin(prefix, strings.Join(parts[i:], "/")))
		if strings.HasPrefix(p, prefix) {
			return p
		}
	}
	return sbNormalize(sbJoin(prefix, sbBasename(name)))
}

// generateBatchName of SFTPActionExecutor (only the first {NNN}/{NN}/{N}).
func sbGenBatchNameSFTP(pattern string) string {
	now := time.Now()
	y := now.Year()
	ys, bys := strconv.Itoa(y), strconv.Itoa(y+543)
	date := strings.ReplaceAll(sbISO(now)[:10], "-", "")
	tm := fmt.Sprintf("%s%s%s", sbPad2(now.Hour()), sbPad2(now.Minute()), sbPad2(now.Second()))
	name := pattern
	for _, kv := range [][2]string{
		{"{YYYY+543}", bys}, {"{BYYYY}", bys}, {"{YYYY}", ys}, {"{YY}", ys[len(ys)-2:]}, {"{BYY}", bys[len(bys)-2:]},
		{"{MM}", sbPad2(int(now.Month()))}, {"{DD}", sbPad2(now.Day())}, {"{YYYYMMDD}", date},
		{"{HH}", sbPad2(now.Hour())}, {"{mm}", sbPad2(now.Minute())}, {"{ss}", sbPad2(now.Second())}, {"{HHMMSS}", tm},
	} {
		name = strings.ReplaceAll(name, kv[0], kv[1])
	}
	name = strings.Replace(name, "{NNN}", "{SEQ3}", 1)
	name = strings.Replace(name, "{NN}", "{SEQ2}", 1)
	return strings.Replace(name, "{N}", "{SEQ1}", 1)
}

func sbStoredNamesFor(remote string) []string {
	names := []string{remote}
	if m := regexp.MustCompile(`(?i)^(.+)\.(pgp|gpg|asc|enc)$`).FindStringSubmatch(remote); m != nil {
		names = append(names, m[1])
	}
	return names
}

func sbDownloadFiles(config map[string]any, remotePath, localPath, pattern string, deleteAfter bool, basketID string, autoCreate any, sessionMode string) ([]map[string]any, error) {
	s, err := sbConnect(config, sbConnOpts{})
	if err != nil {
		return nil, err
	}
	defer s.Close()
	downloads := []map[string]any{}
	deduped := 0

	list, err := s.sbReadDir(remotePath)
	if err != nil {
		return nil, err
	}
	re, err := sbGlobLoose(pattern, false)
	if err != nil {
		return nil, err
	}
	var files []sbRemoteEntry
	for _, e := range list {
		if re.MatchString(e.Name) && e.isFile() {
			files = append(files, e)
		}
	}
	mtimeOf := func(e sbRemoteEntry) *time.Time {
		if e.Mtime == 0 {
			return nil
		}
		t := time.Unix(e.Mtime, 0).UTC()
		return &t
	}

	if basketID != "" {
		var fresh []sbRemoteEntry
		for _, f := range files {
			seen := false
			if mt := mtimeOf(f); mt != nil {
				row, err := sbOne(`SELECT "id" FROM basket_files WHERE "basketId"=$1 AND "fileName" = ANY($2) AND "remoteModifiedAt"=$3 LIMIT 1`,
					basketID, sbStoredNamesFor(f.Name), *mt)
				if err != nil {
					return nil, err
				}
				seen = row != nil
			}
			if seen {
				downloads = append(downloads, om("fileName", f.Name, "remotePath", sbJoin(remotePath, f.Name),
					"success", false, "skipped", true, "reason", "already downloaded into this basket"))
			} else {
				fresh = append(fresh, f)
			}
		}
		if len(fresh) < len(files) {
			log.Printf("[SFTP] Skipped %d of %d file(s) already downloaded into basket %s", len(files)-len(fresh), len(files), basketID)
		}
		files = fresh
	}
	if len(files) == 0 {
		return downloads, nil
	}

	sessionID := ""
	sessionFolder := localPath
	if basketID != "" {
		b, err := sbBasket(basketID)
		if err != nil {
			return nil, err
		}
		if b != nil && sbS(b, "type") == "batch" && autoCreate != false {
			mode := sessionMode
			if mode == "" {
				mode = "existing_or_new"
			}
			var reuse map[string]any
			if mode == "existing_or_new" || mode == "reuse_existing" {
				if reuse, err = sbOne(`SELECT * FROM processing_sessions WHERE "basketId"=$1 AND "status"='open' ORDER BY "startedAt" DESC LIMIT 1`, basketID); err != nil {
					return nil, err
				}
			}
			if mode == "reuse_existing" && reuse == nil {
				return nil, errors.New("No open session found for basket. Please create a session first or use sessionMode: existing_or_new")
			}
			if reuse != nil {
				sessionID = sbS(reuse, "id")
				log.Printf("[SFTP] Reusing existing open session \"%s\" (%s) for basket %s", sbS(reuse, "batchName"), sessionID, basketID)
				sessionFolder = sbJoin(localPath, "sessions", sbS(reuse, "batchName"))
			} else {
				pat := sbS(b, "sessionPattern")
				if pat == "" {
					pat = "{YYYY+543}-{NN}"
				}
				baseName := sbGenBatchNameSFTP(pat)
				if m := sbSeqRe.FindStringSubmatchIndex(baseName); m != nil {
					digits := 3
					if m[2] >= 0 {
						digits, _ = strconv.Atoi(baseName[m[2]:m[3]])
					}
					now := time.Now()
					var from time.Time
					switch {
					case strings.Contains(pat, "{YYYY-MM-DD}"):
						from = sbLocalMidnight(now.Year(), now.Month(), now.Day())
					case strings.Contains(pat, "{YYYY-MM}") || strings.Contains(pat, "{MM}"):
						from = sbLocalMidnight(now.Year(), now.Month(), 1)
					case strings.Contains(pat, "{YYYY+543}") || strings.Contains(pat, "{BYYYY}") || strings.Contains(pat, "{YYYY}"):
						from = sbLocalMidnight(now.Year(), 1, 1)
					default:
						from = sbLocalMidnight(now.Year(), now.Month(), now.Day())
					}
					rows, err := appQuery(`SELECT count(*)::int AS n FROM processing_sessions WHERE "basketId"=$1 AND "startedAt" >= $2 AND "status" = ANY($3)`,
						basketID, from, []string{"open", "published", "processing", "completed", "archived"})
					if err != nil {
						return nil, err
					}
					n := sbI(rows[0], "n") + 1
					seq := strconv.FormatInt(n, 10)
					if digits != 1 {
						seq = fmt.Sprintf("%0*d", digits, n)
					}
					baseName = baseName[:m[0]] + seq + baseName[m[1]:]
				}
				name, sfx := baseName, 1
				for {
					ex, err := sbOne(`SELECT "id" FROM processing_sessions WHERE "batchName"=$1 AND "basketId"=$2 LIMIT 1`, name, basketID)
					if err != nil {
						return nil, err
					}
					if ex == nil {
						break
					}
					name = fmt.Sprintf("%s-%d", baseName, sfx)
					sfx++
				}
				var total int64
				for _, f := range files {
					total += f.Size
				}
				sess, err := sbCreateSession(basketID, name, int64(len(files)), total)
				if err != nil {
					return nil, err
				}
				sessionID = sbS(sess, "id")
				log.Printf("[SFTP] Created new session \"%s\" (%s) for basket %s", name, sessionID, basketID)
				sessionFolder = sbJoin(localPath, "sessions", name)
			}
			if !sbExists(sessionFolder) {
				if err := sbMkdirAll(sessionFolder); err != nil {
					return nil, err
				}
			}
		}
	}

	for _, f := range files {
		remoteFile := sbJoin(remotePath, f.Name)
		localFile := sbJoin(sessionFolder, f.Name)
		var fileID any = undefinedV
		err := func() error {
			if err := s.sbFastGet(remoteFile, localFile); err != nil {
				return err
			}
			if basketID == "" {
				return nil
			}
			mt := mtimeOf(f)
			var existing map[string]any
			if sessionID != "" {
				var err error
				if existing, err = sbOne(`SELECT "id" FROM basket_files WHERE "sessionId"=$1 AND "fileName" = ANY($2) LIMIT 1`, sessionID, sbStoredNamesFor(f.Name)); err != nil {
					return err
				}
			}
			if existing != nil {
				set := sbObj{{"size", int32(f.Size)}, {"path", localFile}}
				if mt != nil {
					set = append(set, sbKV{"remoteModifiedAt", *mt})
				}
				if err := sbUpdate("basket_files", sbS(existing, "id"), true, set); err != nil {
					return err
				}
				fileID = sbS(existing, "id")
				deduped++
				return nil
			}
			id, err := sbCreateFile(sbFileRow{BasketID: basketID, SessionID: sessionID, FileName: f.Name, OriginalName: f.Name, Size: f.Size,
				MimeType: "application/octet-stream", Path: localFile, Status: "uploaded", RemoteModifiedAt: mt})
			if err != nil {
				return err
			}
			fileID = id
			return nil
		}()
		if err != nil {
			downloads = append(downloads, om("fileName", f.Name, "remotePath", remoteFile, "error", err.Error(), "success", false))
			continue
		}
		dl := om("fileName", f.Name, "remotePath", remoteFile, "localPath", localFile, "size", float64(f.Size), "success", true)
		if sessionID != "" {
			jsSet(dl, "sessionId", sessionID)
		}
		sbPut(dl, "fileId", fileID)
		downloads = append(downloads, dl)
		if deleteAfter {
			_ = s.client.Remove(remoteFile)
		}
	}

	if sessionID != "" {
		rows, err := appQuery(`SELECT count(*)::int AS n, COALESCE(sum("size"),0)::bigint AS s FROM basket_files WHERE "sessionId"=$1`, sessionID)
		if err == nil {
			err = sbUpdate("processing_sessions", sessionID, false, sbObj{{"fileCount", int32(sbI(rows[0], "n"))}, {"totalSize", sbI(rows[0], "s")}})
		}
		if err != nil {
			log.Printf("[SFTP] Failed to refresh session counters: %s", err.Error())
		}
	}
	if deduped > 0 {
		log.Printf("[SFTP] %d of %d file(s) already tracked in this session — refreshed instead of duplicated", deduped, len(files))
	}
	return downloads, nil
}
