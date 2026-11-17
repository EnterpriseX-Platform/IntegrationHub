package main

import (
	"archive/zip"
	"bytes"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/xuri/excelize/v2"
)

func fioSnapshot(t *testing.T, dir string) map[string][]byte {
	out := map[string][]byte{}
	filepath.Walk(dir, func(p string, info os.FileInfo, err error) error {
		if err == nil && !info.IsDir() {
			b, _ := os.ReadFile(p)
			rel, _ := filepath.Rel(dir, p)
			out[rel] = b
		}
		return nil
	})
	return out
}

// fioXlsxSummary reads back an xlsx: per sheet the values (via the Go
// reader, which matches exceljs), column widths, panes and header styles.
func fioXlsxSummary(t *testing.T, b []byte) string {
	f, err := excelize.OpenReader(bytes.NewReader(b))
	if err != nil {
		return "open error: " + err.Error()
	}
	defer f.Close()
	var sb strings.Builder
	for _, sh := range f.GetSheetList() {
		fmt.Fprintf(&sb, "sheet %q\n", sh)
		rows, _ := f.GetRows(sh, excelize.Options{RawCellValue: true})
		for i, r := range rows {
			norm := make([]string, len(r))
			for c, v := range r {
				norm[c] = v
				cell, _ := excelize.CoordinatesToCellName(c+1, i+1)
				if typ, _ := f.GetCellType(sh, cell); typ == excelize.CellTypeNumber || typ == excelize.CellTypeUnset {
					if fl, err := strconv.ParseFloat(v, 64); err == nil {
						norm[c] = fioNum(fl) // 1e+21 vs 1000000000000000000000 in <v>
					}
				}
			}
			fmt.Fprintf(&sb, " r%d %q\n", i+1, norm)
			for c := range r {
				cell, _ := excelize.CoordinatesToCellName(c+1, i+1)
				typ, _ := f.GetCellType(sh, cell)
				if typ == excelize.CellTypeSharedString || typ == excelize.CellTypeInlineString {
					typ = excelize.CellTypeSharedString
				}
				if typ == excelize.CellTypeUnset {
					typ = excelize.CellTypeNumber
				}
				if fm, _ := f.GetCellFormula(sh, cell); typ == excelize.CellTypeFormula && fm == "" {
					typ = excelize.CellTypeSharedString // t="str" (exceljs streaming) = a string
				}
				sid, _ := f.GetCellStyle(sh, cell)
				st, _ := f.GetStyle(sid)
				style := ""
				if st != nil {
					if st.Font != nil && st.Font.Bold {
						style += "B"
					}
					if st.Fill.Pattern == 1 {
						style += "F" + strings.Join(st.Fill.Color, "")
					}
					for _, bd := range st.Border {
						style += "|" + bd.Type + strconv.Itoa(bd.Style)
					}
				}
				fmt.Fprintf(&sb, "  %s t%d %s\n", cell, typ, strings.ToUpper(style))
			}
		}
		cols, _ := f.GetCols(sh)
		for c := range cols {
			name, _ := excelize.ColumnNumberToName(c + 1)
			w, _ := f.GetColWidth(sh, name)
			fmt.Fprintf(&sb, " w%s=%v\n", name, w)
		}
		p, _ := f.GetPanes(sh)
		fmt.Fprintf(&sb, " panes freeze=%v ysplit=%d xsplit=%d\n", p.Freeze, p.YSplit, p.XSplit)
	}
	props, _ := f.GetDocProps()
	fmt.Fprintf(&sb, "creator=%s\n", props.Creator)
	return sb.String()
}

func fioZipSummary(b []byte) string {
	zr, err := zip.NewReader(bytes.NewReader(b), int64(len(b)))
	if err != nil {
		return "zip error " + err.Error()
	}
	var parts []string
	for _, f := range zr.File {
		rc, _ := f.Open()
		data, _ := io.ReadAll(rc)
		rc.Close()
		parts = append(parts, fmt.Sprintf("%s=%q", f.Name, data))
	}
	sort.Strings(parts) // archiver appends entries in stat-completion order
	return strings.Join(parts, "\n")
}

func TestFileportWriteLocal(t *testing.T) {
	out := t.TempDir()
	srcDir := t.TempDir()
	os.WriteFile(filepath.Join(srcDir, "a.csv"), []byte("1,2\n"), 0o644)
	os.WriteFile(filepath.Join(srcDir, "B.CSV"), []byte("x"), 0o644)
	os.WriteFile(filepath.Join(srcDir, "c.txt"), []byte("t"), 0o644)
	os.Mkdir(filepath.Join(srcDir, "sub.csv"), 0o755)

	rows := []any{
		map[string]any{"AMOUNT": 10.5, "big": 1e21, "flag": true, "name": "A, \"quoted\"", "nil": nil, "obj": map[string]any{"a": 1}, "small": 0.0000001, "thai": "สวัสดี"},
		map[string]any{"AMOUNT": -0.0, "big": 123456789012, "flag": false, "name": "line\nbreak", "nil": "x", "obj": []any{1, nil, "b"}, "small": 1e-7, "thai": ""},
	}
	vars := map[string]any{"rows": rows, "db": map[string]any{"rows": rows, "rowCount": 2}, "year": "2567", "obj": map[string]any{"k": "v"}}
	in := map[string]any{"data": rows, "name": "inp"}
	wc := func(fmtName, file string, extra map[string]any) fioCase {
		d := map[string]any{"format": fmtName, "destination": "local", "localPath": out, "fileName": file, "dataPath": "vars.rows"}
		for k, v := range extra {
			d[k] = v
		}
		return fioCase{Kind: "write", Data: d, Input: in, Vars: vars}
	}
	big := make([]any, 10001)
	for i := range big {
		big[i] = map[string]any{"a": float64(i), "b": "row " + strconv.Itoa(i)}
	}
	cases := []fioCase{
		wc("csv", "c1_{{YYYY}}_{{BYYYY}}.{{extension}}", nil),
		wc("csv", "c2.csv", map[string]any{"columns": []any{"name", "amount", "missing"}, "includeHeader": false}),
		wc("csv", "c3.csv", map[string]any{"delimiter": ";"}),
		wc("tsv", "t1.{{extension}}", nil),
		wc("delimited", "d1.{{extension}}", nil),
		wc("delimited", "d2.txt", map[string]any{"delimiter": "~"}),
		wc("json", "j1.json", nil),
		wc("txt", "x1.txt", nil),
		wc("txt", "x2.txt", map[string]any{"dataPath": "vars.obj"}),
		wc("txt", "x3_{{year+1}}_{{obj.k}}_{{input.name}}_{{nope}}.txt", map[string]any{"dataSource": "template", "template": "Year {{year}} / {{vars.year}} / {{year-3}} / {{rows.length}} / {{obj}}"}),
		wc("csv", "c4.csv", map[string]any{"dataPath": "vars.db"}),
		wc("csv", "c5.csv", map[string]any{"dataPath": "input.data"}),
		wc("csv", "c6.csv", map[string]any{"dataPath": ""}),
		wc("csv", "c7.csv", map[string]any{"dataPath": "vars.none"}),
		wc("json", "j2.json", map[string]any{"dataPath": "vars.none"}),
		wc("csv", "c8.csv", map[string]any{"dataSource": "template", "template": "abc"}),
		wc("csv", "sub/dir/c9.csv", nil),
		wc("xlsx", "x_{{year}}.{{extension}}", map[string]any{"headerMapping": map[string]any{"name": "ชื่อ", "AMOUNT": "จำนวน"}, "sheetName": "Data"}),
		wc("xlsx", "x2.xlsx", map[string]any{"includeHeader": false, "autoFitColumns": false, "freezeHeader": false}),
		wc("xlsx", "x3.xlsx", map[string]any{"columns": []any{"name", "amount"}}),
		wc("xlsx", "x4.xlsx", map[string]any{"sheets": []any{
			map[string]any{"name": "One", "dataVar": "rows", "columns": []any{"thai", "flag"}},
			map[string]any{"name": "Two", "dataVar": "db", "headerMapping": map[string]any{"big": "BIG"}},
			map[string]any{"dataVar": "obj"},
		}}),
		wc("xlsx", "x5.xlsx", map[string]any{"sheetName": "Bad:Name"}),
		{Kind: "write", Data: map[string]any{"format": "xlsx", "destination": "local", "localPath": out, "fileName": "big.xlsx", "dataPath": "vars.big", "headerMapping": map[string]any{"a": "Alpha"}}, Vars: map[string]any{"big": big}, Input: map[string]any{}},
		wc("zip", "z1_{{YYYY}}", map[string]any{"sourceFolder": srcDir, "zipFilePattern": "*.csv"}),
		wc("zip", "z2.zip", map[string]any{"sourceFolder": srcDir, "zipFilePattern": "a.*, c.t?t", "targetFolder": "T{BYYYY}/{{year}}"}),
		wc("zip", "z3.zip", map[string]any{"sourceFolder": filepath.Join(srcDir, "none")}),
		{Kind: "write", Data: map[string]any{"format": "zip", "destination": "local", "localPath": out, "fileName": "z4.zip"},
			Input: map[string]any{"downloads": []any{map[string]any{"success": true, "localPath": filepath.Join(srcDir, "c.txt"), "fileName": "renamed.txt"}}}},
		wc("csv", "e1.csv", map[string]any{"destination": "basket"}),
		wc("csv", "e2.csv", map[string]any{"destination": "sftp"}),
		{Kind: "write", Data: map[string]any{"format": "csv", "destination": "local", "localPath": out}, Input: in},
	}
	ts := fioRunTS(t, cases)
	tsFiles := fioSnapshot(t, out)
	os.RemoveAll(out)
	os.MkdirAll(out, 0o755)
	gr := fioRunGo(t, cases)
	goFiles := fioSnapshot(t, out)

	for i := range cases {
		a, b := ts[i], gr[i]
		strip := []string{"timestamp"}
		if f := cases[i].Data["format"]; f == "xlsx" || f == "zip" {
			strip = append(strip, "size", "zipSize") // exceljs/archiver bytes differ
		}
		a.Out, b.Out = fioStrip(a.Out, strip...), fioStrip(b.Out, strip...)
		if !reflect.DeepEqual(a, b) {
			t.Errorf("case %d %v\nTS: %s\nGo: %s", i, cases[i].Data["fileName"], fioJSONText(a), fioJSONText(b))
		}
	}
	var names []string
	for k := range tsFiles {
		names = append(names, k)
	}
	for k := range goFiles {
		if _, ok := tsFiles[k]; !ok {
			names = append(names, k)
		}
	}
	sort.Strings(names)
	for _, n := range names {
		a, b := tsFiles[n], goFiles[n]
		switch {
		case strings.HasSuffix(n, ".xlsx"):
			sa, sb := fioXlsxSummary(t, a), fioXlsxSummary(t, b)
			if sa != sb {
				t.Errorf("xlsx %s differs\nTS:\n%s\nGo:\n%s", n, sa, sb)
			}
		case strings.HasSuffix(n, ".zip"):
			sa, sb := fioZipSummary(a), fioZipSummary(b)
			if sa != sb {
				t.Errorf("zip %s differs\nTS:\n%s\nGo:\n%s", n, sa, sb)
			}
		default:
			if !bytes.Equal(a, b) {
				t.Errorf("file %s differs\nTS: %q\nGo: %q", n, a, b)
			}
		}
	}
	_ = time.Now
}
