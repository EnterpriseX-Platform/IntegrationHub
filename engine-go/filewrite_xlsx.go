package main

// format 'xlsx' of FileWriteExecutor.ts (exceljs there, excelize here). The
// sheet contents follow addXlsxSheet / generateXlsxStreaming: header row
// (headerMapping) styled bold + #E8E8E8 fill + thin bottom border, data rows,
// auto-fit widths min(max(ceil(len*1.3)+2, 10), 60) from the first 200 rows,
// header frozen, creator APP_NAME || 'IntegrationX'.

import (
	"bytes"
	"errors"
	"fmt"
	"math"
	"os"
	"regexp"
	"time"

	"github.com/xuri/excelize/v2"
)

type fioSheetSpec struct {
	name    any // string, or fioUndef → exceljs default "sheet<id>"
	data    []any
	columns []string
	mapping map[string]any
	isArray bool
	rawLen  float64
}

func fioXlsxWrite(r *Run, node *Node, ctx *Ctx, d map[string]any) (any, error) {
	src, err := fioSourceData(r, ctx, d)
	if err != nil {
		return nil, err
	}
	buf, err := fioXlsxContent(src, d, ctx)
	if err != nil {
		return nil, err
	}
	fn, ok := d["fileName"].(string)
	var fileName string
	if ok {
		fileName = fioFilePlaceholders(fioWriteTemplate(r, ctx, fn), time.Now(), "xlsx")
	} else {
		// resolveTemplate(undefined) throws on `.includes`
		return nil, fioTypeErrProp(fioData(d, "fileName"), "includes")
	}
	res, err := fioWriteDest(r, ctx, d, fioContent{buf: buf}, fileName, d, "")
	if err != nil {
		return nil, err
	}
	r.log("info", "", "Generated XLSX file: "+fileName, nil)
	return fioResult(d, "xlsx", fileName, res), nil
}

func fioMapping(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}

func fioXlsxContent(src any, d map[string]any, ctx *Ctx) ([]byte, error) {
	var sheets []fioSheetSpec
	if cfgSheets, ok := d["sheets"].([]any); ok && len(cfgSheets) > 0 {
		for _, sc := range cfgSheets {
			sd := ctx.Vars[fioStr(fioProp(sc, "dataVar"))]
			if sd != nil {
				if rows := fioProp(sd, "rows"); fioTruthy(rows) {
					sd = rows
				}
			}
			arr, isArr := sd.([]any)
			if !isArr {
				if fioTruthy(sd) {
					arr = []any{sd}
				} else {
					arr = []any{}
				}
			}
			mapping := fioMapping(fioProp(sc, "headerMapping"))
			if !fioTruthy(fioProp(sc, "headerMapping")) {
				mapping = fioMapping(d["headerMapping"])
			}
			sheets = append(sheets, fioSheetSpec{name: fioProp(sc, "name"), data: arr, columns: fioColumns(fioProp(sc, "columns")),
				mapping: mapping, isArray: true, rawLen: float64(len(arr))})
		}
	} else {
		spec := fioSheetSpec{name: fioStrOr(d, "sheetName", "Sheet1"), columns: fioColumns(d["columns"]), mapping: fioMapping(d["headerMapping"])}
		switch t := src.(type) {
		case []any:
			spec.data, spec.isArray, spec.rawLen = t, true, float64(len(t))
		case string:
			spec.data, spec.rawLen = []any{t}, float64(fioLen16(t))
		default:
			spec.data, spec.rawLen = []any{t}, math.NaN()
		}
		sheets = append(sheets, spec)
	}
	total := 0.0
	for _, s := range sheets {
		total += s.rawLen
	}
	streaming := total > 10000

	f := excelize.NewFile()
	defer f.Close()
	creator := os.Getenv("APP_NAME")
	if creator == "" {
		creator = "IntegrationX"
	}
	now := time.Now().UTC().Format(time.RFC3339)
	_ = f.SetDocProps(&excelize.DocProperties{Creator: creator, Created: now, Modified: now})

	includeHeader := d["includeHeader"] != false
	autoFit := d["autoFitColumns"] != false
	freeze := d["freezeHeader"] != false

	headStyle, err := f.NewStyle(&excelize.Style{
		Font:   &excelize.Font{Bold: true},
		Fill:   excelize.Fill{Type: "pattern", Pattern: 1, Color: []string{"E8E8E8"}},
		Border: []excelize.Border{{Type: "bottom", Style: 1, Color: "000000"}},
	})
	if err != nil {
		return nil, err
	}
	boldRow, _ := f.NewStyle(&excelize.Style{Font: &excelize.Font{Bold: true}})

	var names []string
	written := 0
	for i, s := range sheets {
		if streaming && !s.isArray {
			continue // generateXlsxStreaming skips non-array data
		}
		name, err := fioSheetName(s.name, i+1, names, streaming)
		if err != nil {
			return nil, err
		}
		names = append(names, name)
		if written == 0 {
			if err := f.SetSheetName("Sheet1", name); err != nil {
				return nil, err
			}
		} else if _, err := f.NewSheet(name); err != nil {
			return nil, err
		}
		written++
		if err := fioWriteSheet(f, name, s, includeHeader, autoFit, freeze, streaming, headStyle, boldRow); err != nil {
			return nil, err
		}
	}
	if written == 0 {
		// exceljs writes a workbook without worksheets; excelize needs one.
		_ = f.SetSheetName("Sheet1", "Sheet1")
	}
	f.SetActiveSheet(0)
	var out bytes.Buffer
	if err := f.Write(&out); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

var fioBadSheetChars = regexp.MustCompile(`[*?:/\\[\]]`)

// fioSheetName applies exceljs Worksheet name rules (in-memory workbook).
func fioSheetName(v any, id int, existing []string, streaming bool) (string, error) {
	if v == fioUndef || (streaming && !fioTruthy(v)) {
		return fmt.Sprintf("sheet%d", id), nil
	}
	name, ok := v.(string)
	if !ok {
		if streaming {
			return fioStr(v), nil
		}
		return "", errors.New("The name has to be a string.")
	}
	if streaming {
		return name, nil
	}
	if name == "" {
		return "", errors.New("The name can't be empty.")
	}
	if name == "History" {
		return "", errors.New(`The name "History" is protected. Please use a different name.`)
	}
	if fioBadSheetChars.MatchString(name) {
		return "", fmt.Errorf("Worksheet name %s cannot include any of the following characters: * ? : \\ / [ ]", name)
	}
	if regexp.MustCompile(`(^')|('$)`).MatchString(name) {
		return "", fmt.Errorf("The first or last character of worksheet name cannot be a single quotation mark: %s", name)
	}
	if fioLen16(name) > 31 {
		u := []rune(name)
		n := 0
		cut := 0
		for i, r := range u {
			w := 1
			if r >= 0x10000 {
				w = 2
			}
			if n+w > 31 {
				break
			}
			n += w
			cut = i + 1
		}
		name = string(u[:cut])
	}
	for _, e := range existing {
		if equalFoldJS(e, name) {
			return "", fmt.Errorf("Worksheet name already exists: %s", name)
		}
	}
	return name, nil
}

func equalFoldJS(a, b string) bool { return bytes.EqualFold([]byte(a), []byte(b)) }

// fioCellValue is `row[field] ?? row[keyMap[field.toLowerCase()]] ?? ”`.
func fioCellValue(row any, field string, keyMap map[string]string) any {
	v := fioProp(row, field)
	if v == nil || v == fioUndef {
		if k, ok := keyMap[toLowerJS(field)]; ok {
			v = fioProp(row, k)
		} else {
			v = fioProp(row, "undefined")
		}
	}
	if v == nil || v == fioUndef {
		return ""
	}
	return v
}

func toLowerJS(s string) string { return string(bytes.ToLower([]byte(s))) }

func fioWriteSheet(f *excelize.File, name string, s fioSheetSpec, includeHeader, autoFit, freeze, streaming bool, headStyle, boldRow int) error {
	data := s.data
	fields := s.columns
	if len(fields) == 0 {
		if len(data) > 0 {
			fields = fioKeys(data[0])
		} else {
			fields = []string{}
		}
	}
	keyMap := map[string]string{}
	if len(data) > 0 {
		for _, k := range fioKeys(data[0]) {
			keyMap[toLowerJS(k)] = k
		}
	}
	header := func(field string) string {
		if v := s.mapping[field]; fioTruthy(v) {
			return fioStr(v)
		}
		return field
	}

	// Column widths (computed before writing, like the streaming writer).
	widths := make([]float64, len(fields))
	if autoFit {
		sample := len(data)
		if sample > 200 {
			sample = 200
		}
		for c, field := range fields {
			var maxLen int
			if streaming {
				maxLen = fioLen16(header(field))
			} else if includeHeader && header(field) != "" {
				maxLen = fioLen16(header(field))
			} else {
				maxLen = 8
			}
			for r := 0; r < sample; r++ {
				if data[r] == nil || data[r] == fioUndef {
					return fioTypeErrProp(data[r], field)
				}
				if l := fioLen16(fioXlsxString(fioCellValue(data[r], field, keyMap))); l > maxLen {
					maxLen = l
				}
			}
			widths[c] = math.Min(math.Max(math.Ceil(float64(maxLen)*1.3)+2, 10), 60)
		}
	}

	sw, err := f.NewStreamWriter(name)
	if err != nil {
		return err
	}
	if freeze {
		if err := sw.SetPanes(&excelize.Panes{Freeze: true, YSplit: 1, TopLeftCell: "A2", ActivePane: "bottomLeft",
			Selection: []excelize.Selection{{SQRef: "A2", ActiveCell: "A2", Pane: "bottomLeft"}}}); err != nil {
			return err
		}
	}
	if autoFit {
		for c, w := range widths {
			if err := sw.SetColWidth(c+1, c+1, w); err != nil {
				return err
			}
		}
	}
	rowNum := 1
	if includeHeader && len(fields) > 0 {
		cells := make([]any, len(fields))
		for i, field := range fields {
			if streaming {
				// exceljs WorkbookWriter without useStyles drops all styles
				cells[i] = header(field)
			} else {
				cells[i] = excelize.Cell{StyleID: headStyle, Value: header(field)}
			}
		}
		cell, _ := excelize.CoordinatesToCellName(1, rowNum)
		opts := []excelize.RowOpts{}
		if !streaming {
			opts = append(opts, excelize.RowOpts{StyleID: boldRow})
		}
		if err := sw.SetRow(cell, cells, opts...); err != nil {
			return err
		}
		rowNum++
	}
	for _, row := range data {
		cells := make([]any, len(fields))
		for i, field := range fields {
			if row == nil || row == fioUndef {
				return fioTypeErrProp(row, field)
			}
			cells[i] = fioXlsxCell(fioCellValue(row, field, keyMap))
		}
		cell, _ := excelize.CoordinatesToCellName(1, rowNum)
		if err := sw.SetRow(cell, cells); err != nil {
			return err
		}
		rowNum++
	}
	return sw.Flush()
}

// fioXlsxString is String(val) as used for width estimation.
func fioXlsxString(v any) string { return fioStr(v) }

// fioXlsxCell maps a value the way exceljs Value.getType does.
func fioXlsxCell(v any) any {
	switch t := v.(type) {
	case string, bool, float64, int, int64, int32, time.Time:
		return t
	case map[string]any:
		if fioTruthy(t["text"]) && fioTruthy(t["hyperlink"]) {
			return fioStr(t["text"])
		}
		if fioTruthy(t["formula"]) || fioTruthy(t["sharedFormula"]) {
			c := excelize.Cell{Formula: fioStr(fioOr(t["formula"], t["sharedFormula"]))}
			if res, ok := t["result"]; ok && res != nil {
				c.Value = res
			}
			return c
		}
		if rt, ok := t["richText"].([]any); ok && fioTruthy(t["richText"]) {
			s := ""
			for _, p := range rt {
				if x := fioProp(p, "text"); x != fioUndef && x != nil {
					s += fioStr(x)
				}
			}
			return s
		}
		if fioTruthy(t["error"]) {
			return fioStr(t["error"])
		}
	}
	return fioJSON(v, "")
}
