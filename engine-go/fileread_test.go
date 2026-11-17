package main

import (
	"archive/zip"
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/xuri/excelize/v2"
)

const fioExcelJSFixture = `
const ExcelJS = require(require('path').join(process.argv[2], 'node_modules/exceljs'));
(async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Data');
  ws.getRow(1).values = ['id', ' name ', 'amount', 'when', 'flag', 'calc', 'link', 'rich', 'err', 42];
  ws.addRow([1, 'สมชาย', 12.5, new Date(Date.UTC(2024, 0, 15, 10, 30)), true, { formula: 'C2*2', result: 25 }, { text: 'site', hyperlink: 'https://x.test' }, { richText: [{ text: 'a' }, { font: { bold: true }, text: 'b' }] }, { error: '#N/A' }, 'x']);
  ws.addRow([2, '', null, null, false, { formula: 'C3*2' }, null, null, null]);
  ws.addRow([]);
  ws.addRow([3, 'merged', 7]);
  ws.mergeCells('B5:C6');
  ws.getCell('D5').value = 45000; ws.getCell('D5').numFmt = 'yyyy-mm-dd';
  ws.getCell('E5').value = 0.5; ws.getCell('E5').numFmt = '0.00%';
  ws.getCell('A7').value = 'tail';
  const ws2 = wb.addWorksheet('Second');
  ws2.addRow(['k', 'v']); ws2.addRow(['a', 1]);
  await wb.xlsx.writeFile(process.argv[3]);
  const wb2 = new ExcelJS.Workbook();
  const s = wb2.addWorksheet('Holes');
  s.getCell('A1').value = 'h1'; s.getCell('C1').value = 'h3';
  s.getCell('A2').value = 'x'; s.getCell('B2').value = 'y'; s.getCell('C2').value = 'z'; s.getCell('D2').value = 'w';
  s.getCell('B3').value = 5;
  await wb2.xlsx.writeFile(process.argv[4]);
})();
`

// fioRawXLSX builds an xlsx by hand (cells without values, styled empties,
// inline strings, shared rich strings, 1904 dates).
func fioRawXLSX(t *testing.T, path string) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	add := func(name, body string) {
		w, _ := zw.Create(name)
		w.Write([]byte(body))
	}
	add("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`)
	add("_rels/.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`)
	add("xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr date1904="1"/><sheets><sheet name="Raw" sheetId="1" r:id="rId1"/></sheets></workbook>`)
	add("xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`)
	add("xl/sharedStrings.xml", `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="3" uniqueCount="3"><si><t>col A</t></si><si><r><t>ri</t></r><r><rPr><b/></rPr><t>ch</t></r></si><si><t xml:space="preserve"> sp </t></si></sst>`)
	add("xl/styles.xml", `<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="[$-409]d/m/yyyy"/></numFmts><cellXfs count="4"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/><xf numFmtId="4"/></cellXfs></styleSheet>`)
	add("xl/worksheets/sheet1.xml", `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>`+
		`<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"/><c r="C1" s="3"/><c r="D1" t="s"><v>1</v></c><c r="E1" t="inlineStr"><is><t>inl</t></is></c></row>`+
		`<row r="2"><c r="A2" s="1"><v>100</v></c><c r="B2" t="s"><v>2</v></c><c r="C2" s="2"><v>40000.75</v></c><c r="D2" t="b"><v>1</v></c><c r="E2" t="str"><f>A2&amp;"x"</f><v>100x</v></c></row>`+
		`<row r="3"><c r="A3" s="3"/><c r="B3"/></row>`+
		`<row r="4"><c r="A4" t="e"><v>#DIV/0!</v></c><c r="C4" s="3"><v>1.5</v></c><c r="E4" t="inlineStr"><is><r><t>x</t></r><r><t>y</t></r></is></c></row>`+
		`</sheetData></worksheet>`)
	zw.Close()
	if err := os.WriteFile(path, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestFileportRead(t *testing.T) {
	dir := t.TempDir()
	w := func(name string, b []byte) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, b, 0o644); err != nil {
			t.Fatal(err)
		}
		return p
	}
	csv1 := w("a.csv", []byte("\uFEFFid, name ,\"amount\"\r\n1,\"Alice\",10\r\n\r\n2,Bob\r\n3,\"C,D\",x,extra\n  \n"))
	pipe := w("p.txt", []byte("a|b|c\n1|2|3\n4|5|6\n"))
	semi := w("s.csv", []byte("a;b\n1;2\n"))
	tsv := w("t.tsv", []byte("x\ty\n1\t2\n"))
	js := w("d.json", []byte(`[{"b":1,"a":"x","n":null,"arr":[1,2.5,1e21,0.000001]}]`))
	jsObj := w("o.json", []byte(`{"k":{"z":true}}`))
	badJS := w("bad.json", []byte(`{"a":1,}`))
	bomJS := w("bom.json", []byte("\uFEFF[1]"))
	txt := w("t.txt", []byte("  line1 \n\nline2\r\n"))
	empty := w("e.csv", []byte(""))
	// สวัสดี in TIS-620 / Windows-874, with the cp874 euro sign 0x80
	thai := w("thai.csv", []byte{'n', 'a', 'm', 'e', '\n', 0xCA, 0xC7, 0xD1, 0xCA, 0xB4, 0xD5, 0x80, '\n'})
	invalid := w("inv.txt", []byte{'a', 0xff, 0xe0, 0xb8, 'b', '\n'})
	noext := w("data", []byte("q\n"))

	xl1 := filepath.Join(dir, "fx.xlsx")
	xl2 := filepath.Join(dir, "holes.xlsx")
	script := filepath.Join(dir, "fixture.js")
	os.WriteFile(script, []byte(fioExcelJSFixture), 0o644)
	if out, err := exec.Command(fioNode(t), script, fioServerDir(), xl1, xl2).CombinedOutput(); err != nil {
		t.Fatalf("fixture: %v %s", err, out)
	}
	raw := filepath.Join(dir, "raw.xlsx")
	fioRawXLSX(t, raw)
	// excelize-made workbook (shared strings, numbers, dates)
	ez := filepath.Join(dir, "ez.xlsx")
	{
		f := excelize.NewFile()
		f.SetSheetRow("Sheet1", "A1", &[]any{"name", "qty", "date"})
		f.SetSheetRow("Sheet1", "A2", &[]any{"ก", 3, 45123.5})
		st, _ := f.NewStyle(&excelize.Style{NumFmt: 22})
		f.SetCellStyle("Sheet1", "C2", "C2", st)
		f.SetCellFormula("Sheet1", "B3", "B2*2")
		f.MergeCell("Sheet1", "A4", "A5")
		f.SetCellValue("Sheet1", "A4", "m")
		f.SaveAs(ez)
		f.Close()
	}

	local := func(p string, extra map[string]any) fioCase {
		d := map[string]any{"source": "local", "localPath": p, "parseAs": "auto"}
		for k, v := range extra {
			d[k] = v
		}
		return fioCase{Kind: "read", Data: d, Input: map[string]any{}}
	}
	cases := []fioCase{
		local(csv1, nil),
		local(csv1, map[string]any{"hasHeader": false}),
		local(csv1, map[string]any{"hasHeader": false, "customHeaders": " a, b ,c"}),
		local(csv1, map[string]any{"maxRows": 2}),
		local(csv1, map[string]any{"parseAs": "csv", "delimiter": "auto"}),
		local(pipe, map[string]any{"parseAs": "csv"}),
		local(semi, nil),
		local(tsv, nil),
		local(tsv, map[string]any{"parseAs": "tsv", "hasHeader": false}),
		local(js, nil),
		local(jsObj, nil),
		local(badJS, nil),
		local(bomJS, nil),
		local(txt, nil),
		local(txt, map[string]any{"parseAs": "txt", "maxRows": "1"}),
		local(empty, nil),
		local(thai, map[string]any{"encoding": "tis620"}),
		local(thai, map[string]any{"encoding": "windows-874"}),
		local(thai, map[string]any{"encoding": "TIS-620"}),
		local(thai, map[string]any{"encoding": "latin1"}),
		local(thai, map[string]any{"encoding": "nope-enc"}),
		local(invalid, nil),
		local(noext, nil),
		local(csv1, map[string]any{"parseAs": "list"}),
		local(csv1, map[string]any{"parseAs": "download"}),
		local(xl1, map[string]any{"parseAs": "download"}),
		local(xl1, nil),
		local(xl1, map[string]any{"sheetName": "Second"}),
		local(xl1, map[string]any{"sheetName": "Missing"}),
		local(xl1, map[string]any{"hasHeader": false}),
		local(xl1, map[string]any{"hasHeader": false, "customHeaders": "a,b"}),
		local(xl2, nil),
		local(xl2, map[string]any{"hasHeader": false}),
		local(raw, nil),
		local(raw, map[string]any{"hasHeader": false}),
		local(ez, map[string]any{"parseAs": "xlsx"}),
		local(csv1, map[string]any{"parseAs": "xlsx"}),
		local(filepath.Join(dir, "missing.csv"), nil),
		{Kind: "read", Data: map[string]any{"source": "local", "localPath": "{{input.p}}", "parseAs": "csv"}, Input: map[string]any{"p": csv1}},
		{Kind: "read", Data: map[string]any{"source": "input", "parseAs": "auto"}, Input: map[string]any{"localPath": txt}},
		{Kind: "read", Data: map[string]any{"parseAs": "csv"}, Input: map[string]any{"downloads": []any{map[string]any{"success": true, "localPath": csv1}, map[string]any{"success": false, "localPath": tsv}, map[string]any{"success": true, "localPath": pipe}}}},
		{Kind: "read", Data: map[string]any{"parseAs": "csv"}, Input: map[string]any{"data": "a,b\n1,2"}},
		{Kind: "read", Data: map[string]any{"parseAs": "csv"}, Input: map[string]any{}},
		{Kind: "read", Data: map[string]any{"source": "basket", "basketPath": dir, "filePattern": "*.csv", "parseAs": "list"}, Input: map[string]any{}},
		{Kind: "read", Data: map[string]any{"source": "basket", "basketPath": dir, "filePattern": "{{cur}}", "parseAs": "list"}, Input: map[string]any{}, Vars: map[string]any{"cur": map[string]any{"path": csv1[1:], "id": "f1", "sessionId": nil}}},
		{Kind: "read", Data: map[string]any{"source": "basket", "basketPath": filepath.Join(dir, "nope")}, Input: map[string]any{}},
		{Kind: "read", Data: map[string]any{"source": "sftp"}, Input: map[string]any{}},
		{Kind: "read", Data: map[string]any{"source": "sftp", "sftpConnectionId": "x"}, Input: map[string]any{}},
	}
	ts := fioRunTS(t, cases)
	gr := fioRunGo(t, cases)
	for i := range cases {
		a, b := ts[i], gr[i]
		a.Out, b.Out = fioStrip(a.Out, "timestamp"), fioStrip(b.Out, "timestamp")
		a.Logs, b.Logs = nil, nil
		if !reflect.DeepEqual(a, b) {
			t.Errorf("case %d %v\nTS: %s\nGo: %s", i, cases[i].Data, fioJSONText(a), fioJSONText(b))
		}
	}
}
