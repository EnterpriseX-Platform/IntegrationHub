package main

// Port of server/src/sdk/execution/executors/sftpFolderSync.ts
// (sftp-action operation "download-new-folders"), with the File Explorer
// helpers from lib/fileExplorerBasket.ts and getOrCreateShareLink from
// routes/shareLinks.ts.

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

type sbFolderSyncOpts struct {
	RemotePath, FilePattern, TargetFolder, StartFromFolder string
	MaxFolders                                             int
	LinkBaseURL                                            string
	GroupByFiscalYear                                      bool
	BasketID, ExplorerBasketID, EncryptionKeyID            string
}

type sbRemoteFile struct {
	Name  string
	Size  int64
	Mtime int64
}

func sbMetaMap(row map[string]any) map[string]any {
	s := sbS(row, "metadata")
	if s == "" {
		return nil
	}
	var m map[string]any
	if json.Unmarshal([]byte(s), &m) != nil {
		return nil
	}
	return m
}

func sbRemoteNameOf(row map[string]any) string {
	if m := sbMetaMap(row); m != nil {
		if rp, ok := m["remotePath"].(string); ok {
			return sbBasename(rp)
		}
	}
	return sbS(row, "originalName")
}

func sbRemoteSizeOf(row map[string]any) float64 {
	if m := sbMetaMap(row); m != nil {
		if n, ok := m["remoteSize"].(float64); ok {
			return n
		}
	}
	return float64(sbI(row, "size"))
}

func sbMimeOf(name string) string {
	switch strings.ToLower(sbExtname(name)) {
	case ".csv":
		return "text/csv"
	case ".txt":
		return "text/plain"
	case ".json":
		return "application/json"
	}
	return "application/octet-stream"
}

func sbIsCurrentCopy(row map[string]any, rf sbRemoteFile) bool {
	if sbRemoteSizeOf(row) != float64(rf.Size) || !sbExists(sbS(row, "path")) {
		return false
	}
	if t, ok := sbT(row, "remoteModifiedAt"); ok && rf.Mtime != 0 {
		if math.Abs(float64(t.UnixMilli())/1000-float64(rf.Mtime)) >= 1 {
			return false
		}
	}
	return true
}

var sbFYRe = regexp.MustCompile(`^(\d{4})-?(\d{2})`)

// sbFiscalYearOf: Thai fiscal year (1 Oct – 30 Sep, named after its end year).
func sbFiscalYearOf(name string) any {
	m := sbFYRe.FindStringSubmatch(name)
	if m == nil {
		return nil
	}
	y, _ := strconv.Atoi(m[1])
	mo, _ := strconv.Atoi(m[2])
	if mo < 1 || mo > 12 {
		return nil
	}
	if mo >= 10 {
		return strconv.Itoa(y + 1)
	}
	return strconv.Itoa(y)
}

// sbBEDate: Buddhist-era date (Asia/Bangkok) of a unix time.
func sbBEDate(unix int64) string {
	ms := float64(unix) * 1000
	if unix == 0 {
		ms = float64(time.Now().UnixMilli())
	}
	d := time.UnixMilli(int64(ms) + 7*3600*1000).UTC()
	return fmt.Sprintf("%d-%s-%s", d.Year()+543, sbPad2(int(d.Month())), sbPad2(d.Day()))
}

func sbFormatSize(n int64) string {
	if n < 1024 {
		return fmt.Sprintf("%d B", n)
	}
	u := []string{"KB", "MB", "GB", "TB"}
	v := float64(n) / 1024
	i := 0
	for v >= 1024 && i < len(u)-1 {
		v /= 1024
		i++
	}
	return sbToFixed(v, 1) + " " + u[i]
}

// ── lib/fileExplorerBasket.ts ────────────────────────────────────────────────

func sbBasketsDir() string {
	if v := os.Getenv("BASKETS_DIR"); v != "" {
		return v
	}
	return "./baskets"
}

func sbFolderPath(name, parentPath string) string {
	seg := strings.ToLower(sbSanitizeSeg(name))
	if parentPath != "" {
		return sbJoin(parentPath, seg)
	}
	return seg
}

func sbEnsureFEFolder(basket map[string]any, name string, parent map[string]any) (map[string]any, error) {
	bid := sbS(basket, "id")
	var f map[string]any
	var err error
	if parent != nil {
		f, err = sbOne(`SELECT * FROM basket_folders WHERE "basketId"=$1 AND "name"=$2 AND "parentId"=$3 LIMIT 1`, bid, name, sbS(parent, "id"))
	} else {
		f, err = sbOne(`SELECT * FROM basket_folders WHERE "basketId"=$1 AND "name"=$2 AND "parentId" IS NULL LIMIT 1`, bid, name)
	}
	if err != nil {
		return nil, err
	}
	if f == nil {
		if f, err = sbCreateFolder(bid, name, sbFolderPath(name, sbS(parent, "path")), sbS(parent, "id")); err != nil {
			return nil, err
		}
	}
	if err := sbMkdirAll(sbJoin(sbS(basket, "path"), "folders", sbS(f, "path"))); err != nil {
		return nil, err
	}
	return f, nil
}

func sbUpsertSystemConfig(key, value, description, category string, setDescOnUpdate bool) error {
	ex, err := sbOne(`SELECT "id" FROM system_configs WHERE "key"=$1`, key)
	if err != nil {
		return err
	}
	if ex != nil {
		if setDescOnUpdate {
			_, err = appExec(`UPDATE system_configs SET "value"=$1, "description"=$2, "updatedAt"=$3 WHERE "key"=$4`, value, description, sbNow(), key)
		} else {
			_, err = appExec(`UPDATE system_configs SET "value"=$1, "updatedAt"=$2 WHERE "key"=$3`, value, sbNow(), key)
		}
		return err
	}
	_, err = appExec(`INSERT INTO system_configs ("id","key","value","description","category","isSecret","updatedAt") VALUES ($1,$2,$3,$4,$5,false,$6)`,
		newCUID(), key, value, description, category, sbNow())
	return err
}

func sbCreateBasket(projectID, name, description, typ, path, settings string, autoArchive bool) (string, error) {
	id := newCUID()
	now := sbNow()
	if settings == "" {
		settings = "{}"
	}
	_, err := appExec(`INSERT INTO baskets ("id","projectId","name","description","path","type","allowedTypes","sessionPattern","autoArchive","autoPublish","autoPublishConfig","displayOrder","tags","settings","createdAt","updatedAt")
		VALUES ($1,$2,$3,$4,$5,$6,'{}','Batch-{YYYYMMDD}-{NNN}',$7,'manual','{}',0,'[]',$8,$9,$9)`,
		id, projectID, name, sbNullStr(description), path, typ, autoArchive, settings, now)
	return id, err
}

func sbGetOrCreateFEBasket() (map[string]any, error) {
	cfg, err := sbOne(`SELECT "value" FROM system_configs WHERE "key"='fileExplorerBasketId' LIMIT 1`)
	if err != nil {
		return nil, err
	}
	if v := sbS(cfg, "value"); v != "" {
		if b, err := sbBasket(v); err != nil || b != nil {
			return b, err
		}
	}
	proj, err := sbOne(`SELECT "id" FROM projects ORDER BY "createdAt" ASC LIMIT 1`)
	if err != nil {
		return nil, err
	}
	if proj == nil {
		return nil, errors.New("Cannot initialise File Explorer: no project exists yet.")
	}
	dir := sbJoin(sbBasketsDir(), fmt.Sprintf("file-explorer-%d", time.Now().UnixMilli()))
	if err := sbMkdirAll(sbJoin(dir, "folders")); err != nil {
		return nil, err
	}
	id, err := sbCreateBasket(sbS(proj, "id"), "File Explorer", "Personal workspace — copy files from any basket and organise into folders.", "shares", dir, "", false)
	if err != nil {
		return nil, err
	}
	if err := sbUpsertSystemConfig("fileExplorerBasketId", id, "ID of the global File Explorer basket", "platform", true); err != nil {
		return nil, err
	}
	return sbBasket(id)
}

func sbEnsureProjectBasket(projectID string) (map[string]any, error) {
	proj, err := sbOne(`SELECT "id","name" FROM projects WHERE "id"=$1`, projectID)
	if err != nil {
		return nil, err
	}
	if proj == nil {
		return nil, fmt.Errorf("Project not found: %s", projectID)
	}
	pname := sbS(proj, "name")
	basket, err := sbOne(`SELECT * FROM baskets WHERE "projectId"=$1 AND "type"='shares' AND "settings" LIKE $2 LIMIT 1`, projectID, `%"feProjectBasket":true%`)
	if err != nil {
		return nil, err
	}
	if basket == nil {
		id, err := sbCreateBasket(projectID, pname, "", "shares", "", sbStringify(sbObj{{"feProjectBasket", true}}), false)
		if err != nil {
			return nil, err
		}
		dir := sbJoin(sbBasketsDir(), id)
		if err := sbMkdirAll(sbJoin(dir, "folders")); err != nil {
			return nil, err
		}
		if err := sbUpdate("baskets", id, true, sbObj{{"path", dir}}); err != nil {
			return nil, err
		}
		if basket, err = sbBasket(id); err != nil {
			return nil, err
		}
		log.Printf("[FileExplorer] created project basket \"%s\" (%s)", pname, id)
	} else if sbS(basket, "name") != pname {
		if err := sbUpdate("baskets", sbS(basket, "id"), true, sbObj{{"name", pname}}); err != nil {
			return nil, err
		}
		if basket, err = sbBasket(sbS(basket, "id")); err != nil {
			return nil, err
		}
	}
	// File Explorer links (system_configs.fileExplorerLinks, a JSON array).
	cfg, err := sbOne(`SELECT "value" FROM system_configs WHERE "key"='fileExplorerLinks' LIMIT 1`)
	if err != nil {
		return nil, err
	}
	var links []map[string]any
	if v := sbS(cfg, "value"); v != "" {
		if json.Unmarshal([]byte(v), &links) != nil {
			links = nil
		}
	}
	bid := sbS(basket, "id")
	var link map[string]any
	for _, l := range links {
		if l["basketId"] == bid {
			link = l
			break
		}
	}
	write := func(ls []map[string]any) error {
		arr := make([]any, len(ls))
		for i, l := range ls {
			arr[i] = sbLinkObj(l)
		}
		return sbUpsertSystemConfig("fileExplorerLinks", sbStringify(arr), "Baskets shown in the File Explorer", "general", false)
	}
	if link == nil {
		nl := om("id", "lnk_"+bid, "basketId", bid, "name", pname, "createdAt", sbISO(sbNow()), "projectBasket", true)
		if err := write(append(links, nl)); err != nil {
			return nil, err
		}
	} else if link["name"] != pname || link["projectBasket"] != true {
		for _, l := range links {
			if l["basketId"] == bid {
				l["name"] = pname
				l["projectBasket"] = true
			}
		}
		if err := write(links); err != nil {
			return nil, err
		}
	}
	return basket, nil
}

// sbLinkObj keeps a BasketLink's keys in their usual order for JSON.stringify.
func sbLinkObj(l map[string]any) sbObj {
	order := []string{"id", "basketId", "name", "createdAt", "createdBy", "projectBasket"}
	var o sbObj
	seen := map[string]bool{}
	for _, k := range order {
		if v, ok := l[k]; ok {
			o = append(o, sbKV{k, v})
			seen[k] = true
		}
	}
	var rest []string
	for k := range l {
		if !seen[k] {
			rest = append(rest, k)
		}
	}
	sort.Strings(rest)
	for _, k := range rest {
		o = append(o, sbKV{k, l[k]})
	}
	return o
}

func sbMoveFolder(basket, folder, newParent map[string]any) error {
	newPath := sbFolderPath(sbS(folder, "name"), sbS(newParent, "path"))
	from := sbJoin(sbS(basket, "path"), "folders", sbS(folder, "path"))
	to := sbJoin(sbS(basket, "path"), "folders", newPath)
	if err := sbMkdirAll(sbDirname(to)); err != nil {
		return err
	}
	if sbExists(from) && !sbExists(to) {
		if err := sbRename(from, to); err != nil {
			return err
		}
	}
	if err := sbUpdate("basket_folders", sbS(folder, "id"), true, sbObj{{"parentId", sbS(newParent, "id")}, {"path", newPath}}); err != nil {
		return err
	}
	files, err := appQuery(`SELECT "id","path" FROM basket_files WHERE "basketId"=$1 AND "folderId"=$2`, sbS(basket, "id"), sbS(folder, "id"))
	if err != nil {
		return err
	}
	for _, f := range files {
		if p := sbS(f, "path"); strings.HasPrefix(p, from) {
			if err := sbUpdate("basket_files", sbS(f, "id"), true, sbObj{{"path", to + p[len(from):]}}); err != nil {
				return err
			}
		}
	}
	return nil
}

func sbGetOrCreateShareLink(folderID string) (string, error) {
	fe, err := sbGetOrCreateFEBasket()
	if err != nil {
		return "", err
	}
	l, err := sbOne(`SELECT "id" FROM share_links WHERE "basketId"=$1 AND "folderId"=$2 AND "fileId" IS NULL AND "revokedAt" IS NULL LIMIT 1`, sbS(fe, "id"), folderID)
	if err != nil {
		return "", err
	}
	if l != nil {
		return sbS(l, "id"), nil
	}
	id := newCUID()
	_, err = appExec(`INSERT INTO share_links ("id","basketId","folderId","createdAt") VALUES ($1,$2,$3,$4)`, id, sbS(fe, "id"), folderID, sbNow())
	return id, err
}

// ── downloadNewFolders ───────────────────────────────────────────────────────

type sbDelivery struct {
	DirName, RemoteDir string
	Files              []sbRemoteFile // set for loose files grouped by day
}

type sbLocal struct {
	Path, Name string
	Size       int64
	Decrypted  bool
}

func sbDownloadNewFolders(config map[string]any, o sbFolderSyncOpts, logf func(level, msg string)) (any, error) {
	var remoteRoot string
	if strings.HasPrefix(o.RemotePath, "/") {
		remoteRoot = sbNormalize(o.RemotePath)
	} else {
		base := "/"
		if truthy(config["basePath"]) {
			base = sbStrOf(config["basePath"])
		}
		remoteRoot = sbJoin(base, o.RemotePath)
	}
	fp := o.FilePattern
	if fp == "" {
		fp = "*"
	}
	pattern := sbGlobStrict(fp)

	var landing map[string]any
	var err error
	if o.BasketID != "" {
		if landing, err = sbBasket(o.BasketID); err != nil {
			return nil, err
		}
		if landing == nil {
			return nil, fmt.Errorf("Basket not found: %s", o.BasketID)
		}
	}
	var chosen map[string]any
	if o.ExplorerBasketID != "" {
		if chosen, err = sbBasket(o.ExplorerBasketID); err != nil {
			return nil, err
		}
		if sbS(chosen, "type") != "shares" {
			return nil, fmt.Errorf("File Explorer basket not found: %s", o.ExplorerBasketID)
		}
	}
	own := chosen != nil || landing != nil
	var basket map[string]any
	switch {
	case chosen != nil:
		basket = chosen
	case landing != nil:
		basket, err = sbEnsureProjectBasket(sbS(landing, "projectId"))
	default:
		basket, err = sbGetOrCreateFEBasket()
	}
	if err != nil {
		return nil, err
	}
	var parentName string
	if own {
		parentName = sbS(basket, "name")
	} else {
		parentName = o.TargetFolder
		if parentName == "" {
			parentName = sbBasename(remoteRoot)
		}
		if parentName == "" {
			parentName = "downloads"
		}
		parentName = strings.Trim(parentName, sbJSSpace)
	}
	var parent map[string]any
	if !own {
		if parent, err = sbEnsureFEFolder(basket, parentName, nil); err != nil {
			return nil, err
		}
	}
	var key *sbKey
	if o.EncryptionKeyID != "" {
		if key, err = sbLoadKey(o.EncryptionKeyID); err != nil {
			return nil, err
		}
		if key == nil {
			return nil, fmt.Errorf("Encryption key not found: %s", o.EncryptionKeyID)
		}
	}

	s, err := sbConnect(config, sbConnOpts{folderSync: true})
	if err != nil {
		return nil, err
	}
	defer s.Close()

	entries, err := s.sbReadDir(remoteRoot)
	if err != nil {
		return nil, err
	}
	toRF := func(e sbRemoteEntry) sbRemoteFile { return sbRemoteFile{Name: e.Name, Size: e.Size, Mtime: e.Mtime} }
	var deliveries []sbDelivery
	for _, e := range entries {
		if e.isDir() {
			deliveries = append(deliveries, sbDelivery{DirName: e.Name, RemoteDir: sbJoin(remoteRoot, e.Name)})
		}
	}
	var dayOrder []string
	byDay := map[string][]sbRemoteFile{}
	for _, e := range entries {
		if e.isFile() && pattern.MatchString(e.Name) {
			day := sbBEDate(e.Mtime)
			if _, ok := byDay[day]; !ok {
				dayOrder = append(dayOrder, day)
			}
			byDay[day] = append(byDay[day], toRF(e))
		}
	}
	for _, day := range dayOrder {
		deliveries = append(deliveries, sbDelivery{DirName: day, RemoteDir: remoteRoot, Files: byDay[day]})
	}
	var dirs []sbDelivery
	for _, dl := range deliveries {
		if o.StartFromFolder == "" || sbLocaleCompare(dl.DirName, o.StartFromFolder) >= 0 {
			dirs = append(dirs, dl)
		}
	}
	sort.SliceStable(dirs, func(i, j int) bool { return sbLocaleCompare(dirs[i].DirName, dirs[j].DirName) < 0 })

	copied := []map[string]any{}
	upToDate := []any{}
	var totalBytes int64
	fileCount := 0

	for _, dl := range dirs {
		if o.MaxFolders > 0 && len(copied) >= o.MaxFolders {
			logf("info", fmt.Sprintf("Stopping after %d folder(s); the rest will be copied on the next run", o.MaxFolders))
			break
		}
		remoteFiles := dl.Files
		if remoteFiles == nil {
			list, err := s.sbReadDir(dl.RemoteDir)
			if err != nil {
				return nil, err
			}
			for _, e := range list {
				if e.isFile() && pattern.MatchString(e.Name) {
					remoteFiles = append(remoteFiles, toRF(e))
				}
			}
		}
		if len(remoteFiles) == 0 {
			continue
		}

		var fy any
		if o.GroupByFiscalYear {
			fy = sbFiscalYearOf(dl.DirName)
		}
		home := parent
		if fy != nil {
			if home, err = sbEnsureFEFolder(basket, fy.(string), parent); err != nil {
				return nil, err
			}
		}
		if fy != nil && home != nil {
			var legacy map[string]any
			if parent != nil {
				legacy, err = sbOne(`SELECT * FROM basket_folders WHERE "basketId"=$1 AND "name"=$2 AND "parentId"=$3 LIMIT 1`, sbS(basket, "id"), dl.DirName, sbS(parent, "id"))
			} else {
				legacy, err = sbOne(`SELECT * FROM basket_folders WHERE "basketId"=$1 AND "name"=$2 AND "parentId" IS NULL LIMIT 1`, sbS(basket, "id"), dl.DirName)
			}
			if err != nil {
				return nil, err
			}
			already, err := sbOne(`SELECT "id" FROM basket_folders WHERE "basketId"=$1 AND "name"=$2 AND "parentId"=$3 LIMIT 1`, sbS(basket, "id"), dl.DirName, sbS(home, "id"))
			if err != nil {
				return nil, err
			}
			if legacy != nil && already == nil {
				if err := sbMoveFolder(basket, legacy, home); err != nil {
					return nil, err
				}
				logf("info", fmt.Sprintf("Moved %s/%s to %s/%s/%s", parentName, dl.DirName, parentName, fy, dl.DirName))
			}
		}
		folder, err := sbEnsureFEFolder(basket, dl.DirName, home)
		if err != nil {
			return nil, err
		}
		localDir := sbJoin(sbS(basket, "path"), "folders", sbS(folder, "path"))
		existing, err := appQuery(`SELECT * FROM basket_files WHERE "basketId"=$1 AND "folderId"=$2`, sbS(basket, "id"), sbS(folder, "id"))
		if err != nil {
			return nil, err
		}
		findRow := func(rows []map[string]any, name string) map[string]any {
			for _, x := range rows {
				if sbRemoteNameOf(x) == name {
					return x
				}
			}
			return nil
		}
		var todo []sbRemoteFile
		for _, rf := range remoteFiles {
			row := findRow(existing, rf.Name)
			if row == nil || !sbIsCurrentCopy(row, rf) {
				todo = append(todo, rf)
			}
		}
		if len(todo) == 0 {
			upToDate = append(upToDate, dl.DirName)
			continue
		}
		logf("info", fmt.Sprintf("%s: copying %d of %d file(s)", dl.DirName, len(todo), len(remoteFiles)))

		var session map[string]any
		sessionDir := ""
		if landing != nil {
			if session, err = sbOne(`SELECT * FROM processing_sessions WHERE "basketId"=$1 AND "batchName"=$2 LIMIT 1`, sbS(landing, "id"), dl.DirName); err != nil {
				return nil, err
			}
			if session == nil {
				if session, err = sbCreateSession(sbS(landing, "id"), dl.DirName, 0, 0); err != nil {
					return nil, err
				}
			}
			sessionDir = sbJoin(sbS(landing, "path"), "sessions", dl.DirName)
			if err := sbMkdirAll(sessionDir); err != nil {
				return nil, err
			}
		}
		files := []any{}
		var dirBytes int64
		for _, rf := range todo {
			for _, old := range existing {
				if sbRemoteNameOf(old) != rf.Name {
					continue
				}
				_ = sbDeleteByID("basket_files", sbS(old, "id"))
				if p := sbS(old, "path"); p != "" && sbExists(p) {
					if err := sbUnlink(p); err != nil {
						return nil, err
					}
				}
			}
			t0 := time.Now()
			fetchTo := func(dir string) (*sbLocal, error) {
				part := sbJoin(dir, rf.Name+".part")
				if err := s.sbFastGet(sbJoin(dl.RemoteDir, rf.Name), part); err != nil {
					return nil, err
				}
				got, err := sbStatSize(part)
				if err != nil {
					return nil, err
				}
				if got != rf.Size {
					if err := sbUnlink(part); err != nil {
						return nil, err
					}
					return nil, fmt.Errorf("%s/%s: got %d bytes, expected %d", dl.DirName, rf.Name, got, rf.Size)
				}
				if key != nil {
					name := sbDecryptedName(rf.Name)
					target := sbJoin(dir, name)
					ok, derr := sbDecryptIfEncrypted(part, target, rf.Name, key)
					if derr != nil {
						if err := sbUnlink(part); err != nil {
							return nil, err
						}
						logf("warn", fmt.Sprintf("  %s: cannot decrypt with \"%s\" (%s) — skipped", rf.Name, key.Name, derr.Error()))
						return nil, nil
					}
					if ok {
						if err := sbUnlink(part); err != nil {
							return nil, err
						}
						size, err := sbStatSize(target)
						if err != nil {
							return nil, err
						}
						return &sbLocal{Path: target, Name: name, Size: size, Decrypted: true}, nil
					}
				}
				target := sbJoin(dir, rf.Name)
				if err := sbRename(part, target); err != nil {
					return nil, err
				}
				return &sbLocal{Path: target, Name: rf.Name, Size: rf.Size}, nil
			}
			var mtp *time.Time
			if rf.Mtime != 0 {
				t := time.Unix(rf.Mtime, 0).UTC()
				mtp = &t
			}
			var local *sbLocal
			if landing != nil && session != nil {
				rows, err := appQuery(`SELECT * FROM basket_files WHERE "basketId"=$1 AND "sessionId"=$2`, sbS(landing, "id"), sbS(session, "id"))
				if err != nil {
					return nil, err
				}
				row := findRow(rows, rf.Name)
				if row != nil && sbIsCurrentCopy(row, rf) {
					local = &sbLocal{Path: sbS(row, "path"), Name: sbS(row, "fileName"), Size: sbI(row, "size"), Decrypted: sbS(row, "fileName") != rf.Name}
				} else {
					if row != nil {
						_ = sbDeleteByID("basket_files", sbS(row, "id"))
					}
					if local, err = fetchTo(sessionDir); err != nil {
						return nil, err
					}
					if local == nil {
						continue
					}
					meta := sbStringify(sbObj{{"source", "sftp"}, {"remotePath", sbJoin(dl.RemoteDir, rf.Name)}, {"remoteSize", rf.Size}, {"decrypted", local.Decrypted}})
					if _, err := sbCreateFile(sbFileRow{BasketID: sbS(landing, "id"), SessionID: sbS(session, "id"), FileName: local.Name, OriginalName: local.Name,
						Size: local.Size, MimeType: sbMimeOf(local.Name), Path: local.Path, Status: "uploaded", RemoteModifiedAt: mtp, Metadata: meta}); err != nil {
						return nil, err
					}
				}
				dest := sbJoin(localDir, local.Name)
				if err := sbCopyFile(local.Path, dest+".part"); err != nil {
					return nil, err
				}
				if err := sbRename(dest+".part", dest); err != nil {
					return nil, err
				}
				local = &sbLocal{Path: dest, Name: local.Name, Size: local.Size, Decrypted: local.Decrypted}
			} else {
				if local, err = fetchTo(localDir); err != nil {
					return nil, err
				}
				if local == nil {
					continue
				}
			}
			meta := sbStringify(sbObj{{"source", "sftp"}, {"remotePath", sbJoin(dl.RemoteDir, rf.Name)}, {"remoteSize", rf.Size},
				{"decrypted", local.Decrypted}, {"downloadedAt", sbISO(sbNow())}})
			if _, err := sbCreateFile(sbFileRow{BasketID: sbS(basket, "id"), FolderID: sbS(folder, "id"), FileName: local.Name, OriginalName: local.Name,
				Size: local.Size, MimeType: sbMimeOf(local.Name), Path: local.Path, Status: "uploaded", RemoteModifiedAt: mtp, Metadata: meta}); err != nil {
				return nil, err
			}
			if local.Decrypted {
				logf("info", fmt.Sprintf("  %s decrypted → %s", rf.Name, local.Name))
			}
			logf("info", fmt.Sprintf("  %s %s in %ss", rf.Name, sbFormatSize(rf.Size), sbToFixed(float64(time.Since(t0).Milliseconds())/1000, 0)))
			fm := om("name", local.Name, "size", float64(local.Size), "path", local.Path)
			if local.Decrypted {
				fm["decrypted"] = true
			}
			files = append(files, fm)
			dirBytes += local.Size
			totalBytes += local.Size
			fileCount++
		}

		if landing != nil && session != nil {
			rows, err := appQuery(`SELECT "size" FROM basket_files WHERE "basketId"=$1 AND "sessionId"=$2`, sbS(landing, "id"), sbS(session, "id"))
			if err != nil {
				return nil, err
			}
			var bytes int64
			for _, x := range rows {
				bytes += sbI(x, "size")
			}
			if bytes > 2147483647 {
				bytes = 2147483647
			}
			if err := sbUpdate("processing_sessions", sbS(session, "id"), false, sbObj{{"fileCount", int32(len(rows))}, {"totalSize", int32(bytes)}}); err != nil {
				return nil, err
			}
		}

		var link any
		if o.LinkBaseURL != "" {
			id, err := sbGetOrCreateShareLink(sbS(folder, "id"))
			if err != nil {
				return nil, err
			}
			link = strings.TrimSuffix(o.LinkBaseURL, "/") + "/share/" + id
		}
		fePath := parentName + "/" + dl.DirName
		if fy != nil {
			fePath = fmt.Sprintf("%s/%s/%s", parentName, fy, dl.DirName)
		}
		copied = append(copied, om(
			"name", dl.DirName, "remotePath", dl.RemoteDir, "fiscalYear", fy, "fileExplorerPath", fePath,
			"files", files, "totalBytes", float64(dirBytes), "link", link,
		))
	}

	summary := "No new folders."
	if len(copied) > 0 {
		var blocks []string
		for _, f := range copied {
			fl := f["files"].([]any)
			lines := []string{fmt.Sprintf("%s (%d files, %s)", f["name"], len(fl), sbFormatSize(int64(f["totalBytes"].(float64))))}
			for _, x := range fl {
				m := x.(map[string]any)
				lines = append(lines, fmt.Sprintf("  - %s  %s", m["name"], sbFormatSize(int64(m["size"].(float64)))))
			}
			if l, ok := f["link"].(string); ok && l != "" {
				lines = append(lines, "  "+l)
			}
			blocks = append(blocks, strings.Join(lines, "\n"))
		}
		summary = strings.Join(blocks, "\n\n")
	}
	newFolders := make([]any, len(copied))
	names := make([]any, len(copied))
	for i, f := range copied {
		newFolders[i] = f
		names[i] = f["name"]
	}
	return om(
		"operation", "download-new-folders", "remotePath", remoteRoot, "fileExplorerFolder", parentName,
		"newFolders", newFolders, "newFolderCount", float64(len(copied)), "newFolderNames", names,
		"upToDateFolders", upToDate, "fileCount", float64(fileCount), "totalBytes", float64(totalBytes),
		"hasNew", len(copied) > 0, "summary", summary,
	), nil
}
