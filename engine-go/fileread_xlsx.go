package main

// parseXLSX of FileReadExecutor.ts. The workbook is read straight from its
// XML parts (archive/zip + encoding/xml) so cell values come out exactly as
// exceljs 4.4 loads them: shared/inline strings, rich text, numbers,
// booleans, errors ({error}), formulas (cached result), dates (numbers with a
// date number format → Date, 1900/1904 systems), merged cells (every cell of
// a merge carries the master's value) and hyperlinks ({text, hyperlink}).

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"errors"
	"io"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Cell values as exceljs represents them before parseXLSX unwraps them.
type (
	fioXRich struct{ text string }
	// fioXFormula is exceljs FormulaValue._copyModel: only truthy fields.
	fioXFormula struct {
		formula, ref, shareType, sharedFormula string
		result                                 any // fioUndef when there is no cached value
	}
	fioXError struct{ code string }
	fioXHyper struct{ text any }
	fioXDate  struct{ t time.Time }
)

type fioXSheet struct {
	name, path string
}

type fioXBook struct {
	files    map[string]*zip.File
	sheets   []fioXSheet
	date1904 bool
	shared   []any // string or fioXRich
	numFmts  map[int]string
	xfFmt    []int // cellXfs index → numFmtId
}

// Built-in number formats that exceljs knows a code for (defaultnumformats.js).
var fioDefaultNumFmt = map[int]string{
	0: "General", 1: "0", 2: "0.00", 3: "#,##0", 4: "#,##0.00", 9: "0%", 10: "0.00%", 11: "0.00E+00",
	12: "# ?/?", 13: "# ??/??", 14: "mm-dd-yy", 15: "d-mmm-yy", 16: "d-mmm", 17: "mmm-yy",
	18: "h:mm AM/PM", 19: "h:mm:ss AM/PM", 20: "h:mm", 21: "h:mm:ss", 22: `m/d/yy "h":mm`,
	37: "#,##0 ;(#,##0)", 38: "#,##0 ;[Red](#,##0)", 39: "#,##0.00 ;(#,##0.00)", 40: "#,##0.00 ;[Red](#,##0.00)",
	45: "mm:ss", 46: "[h]:mm:ss", 47: "mmss.0", 48: "##0.0E+0", 49: "@",
}

var (
	fioFmtBrackets = regexp.MustCompile(`\[[^\]]*]`)
	fioFmtQuotes   = regexp.MustCompile(`"[^"]*"`)
	fioFmtDate     = regexp.MustCompile(`[ymdhMsb]+`)
)

// fioIsDateFmt is exceljs utils.isDateFmt.
func fioIsDateFmt(f string) bool {
	if f == "" {
		return false
	}
	f = fioFmtBrackets.ReplaceAllString(f, "")
	f = fioFmtQuotes.ReplaceAllString(f, "")
	return fioFmtDate.MatchString(f)
}

// fioExcelToDate is exceljs utils.excelToDate.
func fioExcelToDate(v float64, d1904 bool) time.Time {
	off := 0.0
	if d1904 {
		off = 1462
	}
	ms := math.Floor((v-25569+off)*24*3600*1000 + 0.5)
	return time.UnixMilli(int64(ms)).UTC()
}

func (b *fioXBook) read(name string) ([]byte, bool) {
	f, ok := b.files[name]
	if !ok {
		return nil, false
	}
	rc, err := f.Open()
	if err != nil {
		return nil, false
	}
	defer rc.Close()
	data, err := io.ReadAll(rc)
	return data, err == nil
}

func fioAttr(se xml.StartElement, local string) (string, bool) {
	for _, a := range se.Attr {
		if a.Name.Local == local {
			return a.Value, true
		}
	}
	return "", false
}

// fioAttrNS finds the relationship id attribute (r:id).
func fioAttrRID(se xml.StartElement) string {
	for _, a := range se.Attr {
		if a.Name.Local == "id" && a.Name.Space != "" {
			return a.Value
		}
	}
	return ""
}

func fioXLSXOpen(buf []byte) (*fioXBook, error) {
	zr, err := zip.NewReader(bytes.NewReader(buf), int64(len(buf)))
	if err != nil {
		if len(buf) == 0 {
			return nil, errors.New("End of data reached (data length = 0, asked index = 4). Corrupted zip ?")
		}
		return nil, errors.New("Can't find end of central directory : is this a zip file ? If it is, see https://stuk.github.io/jszip/documentation/howto/read_zip.html")
	}
	b := &fioXBook{files: map[string]*zip.File{}, numFmts: map[int]string{}}
	for _, f := range zr.File {
		b.files[strings.TrimPrefix(f.Name, "/")] = f
	}

	rels := map[string]string{}
	if data, ok := b.read("xl/_rels/workbook.xml.rels"); ok {
		dec := xml.NewDecoder(bytes.NewReader(data))
		for {
			t, err := dec.Token()
			if err != nil {
				break
			}
			if se, ok := t.(xml.StartElement); ok && se.Name.Local == "Relationship" {
				id, _ := fioAttr(se, "Id")
				target, _ := fioAttr(se, "Target")
				if strings.HasPrefix(target, "/") {
					target = strings.TrimPrefix(target, "/")
				} else {
					target = fioNormalize("xl/" + target)
				}
				rels[id] = target
			}
		}
	}
	if data, ok := b.read("xl/workbook.xml"); ok {
		dec := xml.NewDecoder(bytes.NewReader(data))
		for {
			t, err := dec.Token()
			if err != nil {
				break
			}
			se, ok := t.(xml.StartElement)
			if !ok {
				continue
			}
			switch se.Name.Local {
			case "workbookPr":
				if v, ok := fioAttr(se, "date1904"); ok {
					b.date1904 = v == "1" || v == "true"
				}
			case "sheet":
				name, _ := fioAttr(se, "name")
				if p, ok := rels[fioAttrRID(se)]; ok {
					if _, exists := b.files[p]; exists {
						b.sheets = append(b.sheets, fioXSheet{name: name, path: p})
					}
				}
			}
		}
	}
	if data, ok := b.read("xl/sharedStrings.xml"); ok {
		b.parseShared(data)
	}
	if data, ok := b.read("xl/styles.xml"); ok {
		b.parseStyles(data)
	}
	return b, nil
}

func (b *fioXBook) parseShared(data []byte) {
	dec := xml.NewDecoder(bytes.NewReader(data))
	var (
		inSI, inT, inR, inRPh, rich bool
		plain, runs                 strings.Builder
	)
	for {
		t, err := dec.Token()
		if err != nil {
			return
		}
		switch e := t.(type) {
		case xml.StartElement:
			switch e.Name.Local {
			case "si":
				inSI, rich = true, false
				plain.Reset()
				runs.Reset()
			case "r":
				if inSI && !inRPh {
					inR, rich = true, true
				}
			case "rPh":
				inRPh = true
			case "t":
				inT = true
			}
		case xml.EndElement:
			switch e.Name.Local {
			case "si":
				inSI = false
				if rich {
					b.shared = append(b.shared, fioXRich{text: runs.String()})
				} else {
					b.shared = append(b.shared, plain.String())
				}
			case "r":
				inR = false
			case "rPh":
				inRPh = false
			case "t":
				inT = false
			}
		case xml.CharData:
			if inSI && inT && !inRPh {
				if inR {
					runs.Write(e)
				} else {
					plain.Write(e)
				}
			}
		}
	}
}

func (b *fioXBook) parseStyles(data []byte) {
	dec := xml.NewDecoder(bytes.NewReader(data))
	inXfs := false
	for {
		t, err := dec.Token()
		if err != nil {
			return
		}
		switch e := t.(type) {
		case xml.StartElement:
			switch e.Name.Local {
			case "numFmt":
				id, _ := fioAttr(e, "numFmtId")
				code, _ := fioAttr(e, "formatCode")
				if n, err := strconv.Atoi(id); err == nil {
					b.numFmts[n] = code
				}
			case "cellXfs":
				inXfs = true
			case "xf":
				if inXfs {
					id, _ := fioAttr(e, "numFmtId")
					n, _ := strconv.Atoi(id)
					b.xfFmt = append(b.xfFmt, n)
				}
			}
		case xml.EndElement:
			if e.Name.Local == "cellXfs" {
				inXfs = false
			}
		}
	}
}

// numFmt of a cell style (exceljs: styleId 0 means no style at all).
func (b *fioXBook) isDateStyle(styleID int) bool {
	if styleID <= 0 || styleID >= len(b.xfFmt) {
		return false
	}
	id := b.xfFmt[styleID]
	if id == 0 {
		return false
	}
	code, ok := b.numFmts[id]
	if !ok {
		code = fioDefaultNumFmt[id]
	}
	return fioIsDateFmt(code)
}

type fioXCell struct {
	val    any
	isNull bool // exceljs Null type: not part of row.values
}

type fioXRowData struct {
	cells map[int]*fioXCell
	max   int // cellCount
}

type fioXSheetData struct {
	rows    map[int]*fioXRowData
	lastRow int
}

var fioCellRef = regexp.MustCompile(`^\$?([A-Za-z]+)\$?(\d+)$`)

func fioColNum(letters string) int {
	n := 0
	for _, c := range strings.ToUpper(letters) {
		n = n*26 + int(c-'A'+1)
	}
	return n
}

func fioRef(ref string) (int, int, bool) {
	m := fioCellRef.FindStringSubmatch(ref)
	if m == nil {
		return 0, 0, false
	}
	r, _ := strconv.Atoi(m[2])
	return r, fioColNum(m[1]), true
}

func (s *fioXSheetData) cell(r, c int) *fioXCell {
	row := s.rows[r]
	if row == nil {
		row = &fioXRowData{cells: map[int]*fioXCell{}}
		s.rows[r] = row
	}
	if r > s.lastRow {
		s.lastRow = r
	}
	if c > row.max {
		row.max = c
	}
	cl := row.cells[c]
	if cl == nil {
		cl = &fioXCell{isNull: true}
		row.cells[c] = cl
	}
	return cl
}

func (b *fioXBook) loadSheet(path string) (*fioXSheetData, error) {
	data, ok := b.read(path)
	sd := &fioXSheetData{rows: map[int]*fioXRowData{}}
	if !ok {
		return sd, nil
	}
	sheetRels := map[string]string{}
	dir, file := fioDir(path), fioBase(path)
	if rd, ok := b.read(dir + "/_rels/" + file + ".rels"); ok {
		dec := xml.NewDecoder(bytes.NewReader(rd))
		for {
			t, err := dec.Token()
			if err != nil {
				break
			}
			if se, ok := t.(xml.StartElement); ok && se.Name.Local == "Relationship" {
				id, _ := fioAttr(se, "Id")
				target, _ := fioAttr(se, "Target")
				sheetRels[id] = target
			}
		}
	}

	dec := xml.NewDecoder(bytes.NewReader(data))
	var (
		rowNum, colNum     int
		inCell             bool
		cur                string // current text node: v, t, f
		t                  string
		styleID            int
		hasStyle           bool
		formula            strings.Builder
		hasF, shareType    bool
		shareT, fRef, fSi  string
		formulae           = map[string]string{}
		value              strings.Builder
		hasValue, richCell bool
		inIs, inRun, inRPh bool
		merges             []string
		hyper              = map[string]bool{}
	)
	for {
		tok, err := dec.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		switch e := tok.(type) {
		case xml.StartElement:
			switch e.Name.Local {
			case "row":
				if v, ok := fioAttr(e, "r"); ok {
					rowNum, _ = strconv.Atoi(v)
				} else {
					rowNum++
				}
				colNum = 0
				if rowNum > sd.lastRow {
					sd.lastRow = rowNum
				}
				if sd.rows[rowNum] == nil {
					sd.rows[rowNum] = &fioXRowData{cells: map[int]*fioXCell{}}
				}
			case "c":
				inCell = true
				if ref, ok := fioAttr(e, "r"); ok {
					if r, c, ok := fioRef(ref); ok {
						rowNum, colNum = r, c
					}
				} else {
					colNum++
				}
				t, _ = fioAttr(e, "t")
				sv, ok := fioAttr(e, "s")
				hasStyle = ok && sv != ""
				styleID, _ = strconv.Atoi(sv)
				formula.Reset()
				value.Reset()
				hasF, shareType, hasValue, richCell = false, false, false, false
				shareT, fRef, fSi = "", "", ""
			case "f":
				if inCell {
					hasF, cur = true, "f"
					shareT, _ = fioAttr(e, "t")
					fRef, _ = fioAttr(e, "ref")
					fSi, _ = fioAttr(e, "si")
					shareType = shareT != ""
				}
			case "v":
				cur = "v"
			case "is":
				inIs = true
			case "r":
				if inIs && !inRPh {
					inRun, richCell = true, true
				}
			case "rPh":
				inRPh = true
			case "t":
				cur = "t"
			case "mergeCell":
				if ref, ok := fioAttr(e, "ref"); ok {
					merges = append(merges, ref)
				}
			case "hyperlink":
				if ref, ok := fioAttr(e, "ref"); ok {
					if _, ok := sheetRels[fioAttrRID(e)]; ok {
						hyper[strings.ToUpper(ref)] = true
					} else if _, ok := fioAttr(e, "location"); ok {
						hyper[strings.ToUpper(ref)] = true
					}
				}
			}
		case xml.CharData:
			if !inCell || inRPh {
				continue
			}
			switch cur {
			case "f":
				formula.Write(e)
			case "v", "t":
				value.Write(e)
				hasValue = true
			}
		case xml.EndElement:
			switch e.Name.Local {
			case "f", "v":
				cur = ""
			case "t":
				cur = ""
			case "r":
				inRun = false
			case "rPh":
				inRPh = false
			case "is":
				inIs = false
			case "c":
				inCell = false
				cl := sd.cell(rowNum, colNum)
				raw := value.String()
				switch {
				case (hasF && formula.Len() > 0) || shareType:
					res := any(fioUndef)
					if hasValue && raw != "" {
						switch t {
						case "str":
							res = raw
						case "b":
							n, _ := strconv.Atoi(raw)
							res = n != 0
						case "e":
							res = fioXError{code: raw}
						default:
							f := fioParseFloat(raw)
							if b.isDateStyle(styleID) && hasStyle {
								res = fioXDate{t: fioExcelToDate(f, b.date1904)}
							} else {
								res = f
							}
						}
					}
					fv := fioXFormula{formula: formula.String(), ref: fRef, shareType: shareT, result: res}
					if shareT == "shared" {
						if fRef != "" {
							formulae[fSi] = fioColName(colNum) + strconv.Itoa(rowNum)
						} else {
							fv.sharedFormula, fv.shareType = formulae[fSi], ""
						}
					}
					cl.val, cl.isNull = fv, false
				case hasValue:
					cl.isNull = false
					switch t {
					case "s":
						i, _ := strconv.Atoi(raw)
						if i >= 0 && i < len(b.shared) {
							cl.val = b.shared[i]
						} else {
							cl.val = fioUndef
						}
					case "str":
						cl.val = raw
					case "inlineStr":
						if richCell {
							cl.val = fioXRich{text: raw}
						} else {
							cl.val = raw
						}
					case "b":
						n, _ := strconv.Atoi(raw)
						cl.val = n != 0
					case "e":
						cl.val = fioXError{code: raw}
					default:
						f := fioParseFloat(raw)
						if hasStyle && b.isDateStyle(styleID) {
							cl.val = fioXDate{t: fioExcelToDate(f, b.date1904)}
						} else {
							cl.val = f
						}
					}
				default:
					// exceljs Null (styled) or Merge-without-master: not in row.values
					cl.isNull = true
				}
				if hyper[strings.ToUpper(fioColName(colNum)+strconv.Itoa(rowNum))] && !cl.isNull {
					cl.val = fioXHyper{text: cl.val}
				}
			}
		}
	}
	_ = inRun
	for _, m := range merges {
		a, z, ok := strings.Cut(m, ":")
		if !ok {
			continue
		}
		r1, c1, ok1 := fioRef(a)
		r2, c2, ok2 := fioRef(z)
		if !ok1 || !ok2 {
			continue
		}
		if r2 < r1 {
			r1, r2 = r2, r1
		}
		if c2 < c1 {
			c1, c2 = c2, c1
		}
		master := sd.cell(r1, c1)
		mv, mNull := master.val, master.isNull
		for r := r1; r <= r2; r++ {
			for c := c1; c <= c2; c++ {
				if r == r1 && c == c1 {
					continue
				}
				cl := sd.cell(r, c)
				if mNull {
					cl.isNull, cl.val = false, nil
				} else {
					cl.isNull, cl.val = false, mv
				}
			}
		}
	}
	return sd, nil
}

func fioColName(n int) string {
	s := ""
	for n > 0 {
		n--
		s = string(rune('A'+n%26)) + s
		n /= 26
	}
	return s
}

// fioParseFloat is parseFloat (longest numeric prefix, NaN otherwise).
func fioParseFloat(s string) float64 {
	s = strings.TrimLeftFunc(s, fioIsJSSpace)
	for n := len(s); n > 0; n-- {
		if f, err := strconv.ParseFloat(s[:n], 64); err == nil {
			if p := s[:n]; strings.ContainsAny(p, "xXpP_") || strings.EqualFold(strings.TrimLeft(p, "+-"), "nan") || strings.EqualFold(strings.TrimLeft(p, "+-"), "inf") {
				continue
			}
			return f
		}
	}
	if strings.HasPrefix(s, "Infinity") || strings.HasPrefix(s, "+Infinity") {
		return math.Inf(1)
	}
	if strings.HasPrefix(s, "-Infinity") {
		return math.Inf(-1)
	}
	return math.NaN()
}

// values returns exceljs row.values (1-based, holes = not present).
func (s *fioXSheetData) values(r int) ([]any, []bool) {
	row := s.rows[r]
	if row == nil {
		return nil, nil
	}
	n := 0
	for c, cl := range row.cells {
		if !cl.isNull && c > n {
			n = c
		}
	}
	vals := make([]any, n)
	present := make([]bool, n)
	for c, cl := range row.cells {
		if !cl.isNull {
			vals[c-1], present[c-1] = cl.val, true
		}
	}
	return vals, present
}

func (s *fioXSheetData) columnCount() int {
	n := 0
	for _, r := range s.rows {
		if r.max > n {
			n = r.max
		}
	}
	return n
}

// fioXJSON turns an exceljs value into what JSON carries for it.
func fioXJSON(v any) any {
	switch t := v.(type) {
	case *fioUndefT:
		return nil
	case fioXDate:
		if t.t.Year() < -271820 || t.t.Year() > 275759 {
			return nil
		}
		return fioISO(t.t)
	case fioXError:
		return map[string]any{"error": t.code}
	case fioXRich:
		return map[string]any{"richText": []any{map[string]any{"text": t.text}}}
	case fioXFormula:
		m := map[string]any{}
		for k, v := range map[string]string{"formula": t.formula, "ref": t.ref, "shareType": t.shareType, "sharedFormula": t.sharedFormula} {
			if v != "" {
				m[k] = v
			}
		}
		if fioXTruthy(t.result) {
			m["result"] = fioXJSON(t.result)
		}
		return m
	case fioXHyper:
		return om("text", fioXJSON(t.text), "hyperlink", "")
	}
	return v
}

// fioXString is String(v) of an exceljs value (header cells).
func fioXString(v any) string {
	switch t := v.(type) {
	case nil, *fioUndefT:
		return ""
	case fioXDate:
		return fioDateString(t.t)
	case fioXError, fioXRich, fioXFormula, fioXHyper:
		return "[object Object]"
	}
	return fioStr(v)
}

// fioParseXLSX is parseXLSX.
func fioParseXLSX(buf []byte, hasHeader bool, customHeaders []string, sheetName string) ([]any, []string, error) {
	b, err := fioXLSXOpen(buf)
	if err != nil {
		return nil, nil, err
	}
	var sh *fioXSheet
	if sheetName != "" {
		for i := range b.sheets {
			if b.sheets[i].name == sheetName {
				sh = &b.sheets[i]
				break
			}
		}
	} else if len(b.sheets) > 0 {
		sh = &b.sheets[0]
	}
	if sh == nil {
		return []any{}, nil, nil
	}
	sd, err := b.loadSheet(sh.path)
	if err != nil {
		return nil, nil, err
	}

	var headers []any // string, or fioUndef for a hole
	start := 1
	switch {
	case hasHeader:
		vals, present := sd.values(1)
		for i, v := range vals {
			if !present[i] {
				headers = append(headers, fioUndef)
				continue
			}
			headers = append(headers, fioTrim(fioXString(v)))
		}
		start = 2
	case len(customHeaders) > 0:
		for _, h := range customHeaders {
			headers = append(headers, h)
		}
	default:
		for i := 0; i < sd.columnCount(); i++ {
			headers = append(headers, "col"+strconv.Itoa(i))
		}
	}

	out := []any{}
	for r := start; r <= sd.lastRow; r++ {
		vals, present := sd.values(r)
		empty := true
		for i, v := range vals {
			if !present[i] {
				continue
			}
			if v != nil && v != fioUndef && v != "" {
				empty = false
				break
			}
		}
		if empty {
			continue
		}
		obj := map[string]any{}
		for i, h := range headers {
			var v any = fioUndef
			if i < len(vals) && present[i] {
				v = vals[i]
			}
			switch t := v.(type) {
			case fioXHyper:
				v = t.text
			case fioXFormula:
				if fioXTruthy(t.result) {
					v = t.result
				}
			case fioXRich:
				v = t.text
			}
			key := "undefined"
			if s, ok := h.(string); ok {
				key = s
			}
			if v == fioUndef {
				obj[key] = nil
			} else {
				obj[key] = fioXJSON(v)
			}
		}
		out = append(out, obj)
	}
	order := make([]string, len(headers))
	for i, h := range headers {
		order[i] = "undefined"
		if s, ok := h.(string); ok {
			order[i] = s
		}
	}
	return out, order, nil
}

// fioXTruthy: a cached formula result is only kept when truthy (_copyModel).
func fioXTruthy(v any) bool {
	switch v.(type) {
	case fioXDate, fioXError:
		return true
	}
	return fioTruthy(v)
}
