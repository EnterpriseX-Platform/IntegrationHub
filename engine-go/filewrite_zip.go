package main

// format 'zip' of FileWriteExecutor.ts: collect files (source basket/session,
// previous node's downloads, input basket, or a local folder), zip them
// (archiver there, archive/zip here) and write the zip to the destination.

import (
	"archive/zip"
	"bytes"
	"compress/flate"
	"fmt"
	"io"
	"log"
	"os"
	"strconv"
	"strings"
	"time"
)

type fioZipEntry struct{ name, path string }

func fioZipWrite(r *Run, node *Node, ctx *Ctx, d map[string]any) (any, error) {
	now := time.Now()
	fn, err := fioDataFileName(d)
	if err != nil {
		return nil, err
	}
	fileName := fioZipPlaceholders(fn, now)
	fileName = fioWriteTemplate(r, ctx, fileName)
	if !strings.HasSuffix(strings.ToLower(fileName), ".zip") {
		fileName += ".zip"
	}

	targetFolder := fioStrOr(d, "targetFolder", "")
	if targetFolder != "" {
		y := now.Year()
		by := y + 543
		ys, bys := strconv.Itoa(y), strconv.Itoa(by)
		for _, rp := range [][2]string{
			{"{YYYY+543}", bys}, {"{BYYYY}", bys}, {"{YYYY}", ys}, {"{YY}", ys[len(ys)-2:]}, {"{BYY}", bys[len(bys)-2:]},
			{"{MM}", fioPad2(int(now.Month()))}, {"{DD}", fioPad2(now.Day())}, {"{YYYYMMDD}", now.UTC().Format("20060102")},
		} {
			targetFolder = strings.ReplaceAll(targetFolder, rp[0], rp[1])
		}
		targetFolder = fioWriteTemplate(r, ctx, targetFolder)
	}

	files, err := fioCollectZip(r, ctx, d)
	if err != nil {
		return nil, err
	}
	if len(files) == 0 {
		log.Printf("[FileWrite/ZIP] No files found to zip")
		return om("destination", fioData(d, "destination"), "format", "zip", "fileName", fileName,
			"filesCollected", float64(0), "status", "empty", "message", "No files found to zip",
			"timestamp", fioISO(now)), nil
	}
	log.Printf("[FileWrite/ZIP] Zipping %d files into %s", len(files), fileName)

	level := 6
	if lv, ok := d["compressionLevel"]; ok && lv != nil {
		level = int(fioToNumber(lv))
	}
	zipBytes, err := fioCreateZip(files, level)
	if err != nil {
		return nil, err
	}
	log.Printf("[FileWrite/ZIP] ZIP created: %d bytes (%d files)", len(zipBytes), len(files))

	cfg := make(map[string]any, len(d)+1)
	for k, v := range d {
		cfg[k] = v
	}
	jsSet(cfg, "targetFolder", targetFolder)
	res, err := fioWriteDest(r, ctx, d, fioContent{buf: zipBytes}, fileName, cfg, targetFolder)
	if err != nil {
		return nil, err
	}
	names := make([]any, len(files))
	for i, f := range files {
		names[i] = f.name
	}
	var tf any = fioUndef // targetFolder || undefined
	if targetFolder != "" {
		tf = targetFolder
	}
	out := om("destination", fioData(d, "destination"), "format", "zip", "fileName", fileName,
		"targetFolder", tf, "filesCollected", float64(len(files)), "fileNames", names,
		"zipSize", float64(len(zipBytes)))
	jsAssign(out, res)
	jsSet(out, "timestamp", fioISO(now))
	return out, nil
}

func fioZipPlaceholders(name string, now time.Time) string {
	Y := strconv.Itoa(now.Year())
	MM, DD := fioPad2(int(now.Month())), fioPad2(now.Day())
	HH, mi, ss := fioPad2(now.Hour()), fioPad2(now.Minute()), fioPad2(now.Second())
	ymd, hms := Y+MM+DD, HH+mi+ss
	by := strconv.Itoa(now.Year() + 543)
	for _, rp := range [][2]string{
		{"{{timestamp}}", strconv.FormatInt(time.Now().UnixMilli(), 10)},
		{"{{datetime}}", ymd + "_" + hms}, {"{{YYYYMMDD}}", ymd}, {"{{date}}", now.UTC().Format("2006-01-02")},
		{"{{HHmmss}}", hms}, {"{{HHmm}}", HH + mi}, {"{{time}}", hms}, {"{{YYYY}}", Y}, {"{{MM}}", MM}, {"{{DD}}", DD},
		{"{{HH}}", HH}, {"{{mm}}", mi}, {"{{ss}}", ss}, {"{{extension}}", "zip"}, {"{{year}}", Y},
		{"{{buddhistYear}}", by}, {"{{BYYYY}}", by},
	} {
		name = strings.ReplaceAll(name, rp[0], rp[1])
	}
	return name
}

func fioBasketFilesForZip(basketID string, sessionID any, pattern string) ([]fioZipEntry, error) {
	q := `SELECT "fileName", path FROM basket_files WHERE "basketId" = $1 ORDER BY "createdAt" ASC`
	args := []any{basketID}
	if fioTruthy(sessionID) {
		q = `SELECT "fileName", path FROM basket_files WHERE "basketId" = $1 AND "sessionId" = $2 ORDER BY "createdAt" ASC`
		args = append(args, fioStr(sessionID))
	}
	rows, err := appQuery(q, args...)
	if err != nil {
		return nil, err
	}
	var out []fioZipEntry
	for _, bf := range rows {
		name, _ := bf["fileName"].(string)
		p, _ := bf["path"].(string)
		if fioMatchPattern(name, pattern) && fioExists(p) {
			out = append(out, fioZipEntry{name: name, path: p})
		}
	}
	return out, nil
}

// fioCollectZip is collectFilesForZip.
func fioCollectZip(r *Run, ctx *Ctx, d map[string]any) ([]fioZipEntry, error) {
	pattern := fioStrOr(d, "zipFilePattern", "*")
	in := ctx.Input

	if sb := d["sourceBasketId"]; fioTruthy(sb) {
		bid := fioStr(sb)
		b, err := fioLoadBasket(bid)
		if err != nil {
			return nil, err
		}
		if b == nil {
			return nil, fmt.Errorf("Source basket not found: %s", bid)
		}
		sessionID := d["sourceSessionId"]
		if !fioTruthy(sessionID) {
			if s := fioProp(in, "sessionId"); fioTruthy(s) {
				sessionID = s
			}
		}
		if !fioTruthy(sessionID) {
			rows, err := appQuery(`SELECT id FROM processing_sessions WHERE "basketId" = $1 ORDER BY "startedAt" DESC LIMIT 1`, bid)
			if err != nil {
				return nil, err
			}
			if len(rows) > 0 {
				sessionID = rows[0]["id"]
			}
		}
		files, err := fioBasketFilesForZip(bid, sessionID, pattern)
		if files == nil && err == nil {
			files = []fioZipEntry{}
		}
		return files, err
	}

	var files []fioZipEntry
	if dls, ok := fioProp(in, "downloads").([]any); ok {
		for _, dl := range dls {
			lp, _ := fioProp(dl, "localPath").(string)
			if fioTruthy(fioProp(dl, "success")) && lp != "" && fioExists(lp) {
				ns := fioStr(fioProp(dl, "fileName"))
				if fioMatchPattern(ns, pattern) {
					files = append(files, fioZipEntry{name: ns, path: lp})
				}
			}
		}
		if len(files) > 0 {
			return files, nil
		}
	}

	if fioTruthy(fioProp(in, "basketPath")) || fioTruthy(fioProp(in, "basketId")) {
		bid := fioOr(fioProp(in, "basketId"), d["sourceBasketId"])
		sid := fioOr(fioProp(in, "sessionId"), d["sourceSessionId"])
		if fioTruthy(bid) {
			got, err := fioBasketFilesForZip(fioStr(bid), sid, pattern)
			if err != nil {
				return nil, err
			}
			files = append(files, got...)
			if len(files) > 0 {
				return files, nil
			}
		}
	}

	if sf := d["sourceFolder"]; fioTruthy(sf) {
		folder := fioWriteTemplate(r, ctx, fioStr(sf))
		if st, err := os.Stat(folder); err == nil && st.IsDir() {
			entries, err := os.ReadDir(folder)
			if err != nil {
				return nil, fioFsErr(err)
			}
			for _, e := range entries {
				full := fioJoin(folder, e.Name())
				st, err := fioStat(full)
				if err != nil {
					return nil, err
				}
				if st.Mode().IsRegular() && fioMatchPattern(e.Name(), pattern) {
					files = append(files, fioZipEntry{name: e.Name(), path: full})
				}
			}
		}
	}
	return files, nil
}

// fioCreateZip zips the files (entry name, mtime and mode of each file).
func fioCreateZip(files []fioZipEntry, level int) ([]byte, error) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	if level > 0 && level <= 9 {
		zw.RegisterCompressor(zip.Deflate, func(w io.Writer) (io.WriteCloser, error) { return flate.NewWriter(w, level) })
	}
	for _, f := range files {
		st, err := os.Stat(f.path)
		if err != nil {
			return nil, fioFsErr(err)
		}
		hdr, err := zip.FileInfoHeader(st)
		if err != nil {
			return nil, err
		}
		hdr.Name = f.name
		hdr.Method = zip.Deflate
		if level == 0 {
			hdr.Method = zip.Store
		}
		w, err := zw.CreateHeader(hdr)
		if err != nil {
			return nil, err
		}
		src, err := os.Open(f.path)
		if err != nil {
			return nil, fioFsErr(err)
		}
		_, err = io.Copy(w, src)
		src.Close()
		if err != nil {
			return nil, err
		}
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
