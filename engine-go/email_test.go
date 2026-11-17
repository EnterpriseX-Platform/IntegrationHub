package main

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"mime/quotedprintable"
	"net"
	"net/http"
	"net/http/httptest"
	"net/mail"
	"net/textproto"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"
)

// pxFakeSMTP is a tiny ESMTP server that records the transcript.
type pxFakeSMTP struct {
	ln       net.Listener
	mu       sync.Mutex
	cmds     []string
	messages [][]byte
	reject   map[string]bool // RCPT addresses to reject
	badAuth  bool
}

func pxStartSMTP(t *testing.T) *pxFakeSMTP {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	s := &pxFakeSMTP{ln: ln, reject: map[string]bool{}}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go s.serve(c)
		}
	}()
	t.Cleanup(func() { ln.Close() })
	return s
}

func (s *pxFakeSMTP) port() int { return s.ln.Addr().(*net.TCPAddr).Port }

func (s *pxFakeSMTP) reset() {
	s.mu.Lock()
	s.cmds, s.messages = nil, nil
	s.mu.Unlock()
}

func (s *pxFakeSMTP) serve(c net.Conn) {
	defer c.Close()
	rd := bufio.NewReader(c)
	say := func(l string) { fmt.Fprintf(c, "%s\r\n", l) }
	say("220 fake.test ESMTP")
	authStep := ""
	for {
		line, err := rd.ReadString('\n')
		if err != nil {
			return
		}
		line = strings.TrimRight(line, "\r\n")
		s.mu.Lock()
		s.cmds = append(s.cmds, line)
		s.mu.Unlock()
		up := strings.ToUpper(line)
		switch {
		case authStep == "user":
			authStep = "pass"
			say("334 UGFzc3dvcmQ6")
		case authStep == "pass":
			authStep = ""
			say("235 2.7.0 Authentication successful")
		case strings.HasPrefix(up, "EHLO"):
			say("250-fake.test")
			say("250-AUTH LOGIN PLAIN")
			say("250 8BITMIME")
		case strings.HasPrefix(up, "AUTH PLAIN"):
			if s.badAuth {
				say("535 5.7.8 Authentication credentials invalid")
			} else {
				say("235 2.7.0 Authentication successful")
			}
		case strings.HasPrefix(up, "AUTH LOGIN"):
			authStep = "user"
			say("334 VXNlcm5hbWU6")
		case strings.HasPrefix(up, "MAIL FROM"):
			say("250 2.1.0 OK")
		case strings.HasPrefix(up, "RCPT TO"):
			addr := strings.TrimSuffix(strings.TrimPrefix(line[8:], "<"), ">")
			if s.reject[addr] {
				say("550 5.1.1 <" + addr + "> unknown user")
			} else {
				say("250 2.1.5 OK")
			}
		case up == "DATA":
			say("354 go ahead")
			var msg []byte
			for {
				l, err := rd.ReadString('\n')
				if err != nil {
					return
				}
				if l == ".\r\n" {
					break
				}
				msg = append(msg, strings.TrimPrefix(l, ".")...)
			}
			s.mu.Lock()
			s.messages = append(s.messages, msg)
			s.mu.Unlock()
			say("250 2.0.0 queued as X1")
		case up == "QUIT":
			say("221 bye")
			return
		case up == "RSET" || up == "NOOP":
			say("250 OK")
		default:
			say("502 unknown")
		}
	}
}

// pxConnCallback is the Node server's /internal/engine/connection/:id, backed by the test DB.
func pxConnCallback(t *testing.T) *httptest.Server {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:]
		rows, _ := appQuery(`SELECT id, name, type, status, config FROM connections WHERE id = $1`, id)
		if len(rows) == 0 {
			_ = json.NewEncoder(w).Encode(map[string]any{"error": "Connection not found: " + id})
			return
		}
		var cfg any
		_ = json.Unmarshal([]byte(rows[0]["config"].(string)), &cfg)
		rows[0]["config"] = cfg
		_ = json.NewEncoder(w).Encode(rows[0])
	}))
	t.Cleanup(srv.Close)
	return srv
}

var pxMsgIDRe = regexp.MustCompile(`<[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}@[^>]+>`)

func TestPxportEmailDifferential(t *testing.T) {
	pxSetupDB(t)
	smtp := pxStartSMTP(t)
	cb := pxConnCallback(t)
	t.Cleanup(func() { _, _ = appExec(`DELETE FROM connections WHERE id LIKE 't_pxport_%'`) })
	mk := func(id, typ string, cfg map[string]any) {
		b, _ := json.Marshal(cfg)
		if _, err := appExec(`INSERT INTO connections (id, name, type, config, "updatedAt") VALUES ($1,$1,$2,$3,now())`, id, typ, string(b)); err != nil {
			t.Fatal(err)
		}
	}
	mk("t_pxport_smtp", "smtp", map[string]any{"host": "127.0.0.1", "port": fmt.Sprint(smtp.port()), "username": "bot@example.test", "password": "pw", "fromName": "Integration Bot", "fromAddress": "noreply@example.test"})
	mk("t_pxport_smtp2", "smtp", map[string]any{"host": "127.0.0.1", "port": smtp.port()})
	mk("t_pxport_http", "http", map[string]any{})

	dir := t.TempDir()
	a1, a2 := filepath.Join(dir, "report.csv"), filepath.Join(dir, "รายงาน.txt")
	_ = os.WriteFile(a1, []byte(strings.Repeat("col1,col2\n1,2\n", 50)), 0o644)
	_ = os.WriteFile(a2, []byte("ข้อมูล"), 0o644)

	base := func(kv ...any) map[string]any {
		m := map[string]any{"connectionId": "t_pxport_smtp", "to": "a@x.test; b@x.test", "cc": "{{ccList}}", "subject": "Report {{year}}", "body": "Hello {{year}}"}
		for i := 0; i+1 < len(kv); i += 2 {
			m[kv[i].(string)] = kv[i+1]
		}
		return m
	}
	vars := map[string]any{"year": "2567", "ccList": "c@x.test", "files": map[string]any{"files": []any{map[string]any{"localPath": a1}, map[string]any{"path": a2}}}, "empty": []any{}}
	cases := []struct {
		name   string
		data   map[string]any
		reject []string
		bad    bool
	}{
		{"plain", base(), nil, false},
		{"html-attach", base("bodyFormat", "html", "body", "<b>สวัสดี</b>", "attachments", "{{files}}\n"+a1), nil, false},
		{"zip-password", base("attachments", "{{files}}", "zipAttachments", true, "zipName", "pack-{{year}}.ZIP", "zipPassword", "s3cret"), nil, false},
		{"zip-plain", base("attachments", a2, "zipAttachments", true), nil, false},
		{"no-auth-from", base("connectionId", "t_pxport_smtp2", "bcc", "z@x.test"), nil, false},
		{"one-rejected", base(), []string{"b@x.test"}, false},
		{"all-rejected", base("cc", ""), []string{"a@x.test", "b@x.test"}, false},
		{"bad-auth", base(), nil, true},
		{"skip-no-to", base("to", " ; "), nil, false},
		{"no-connection", base("connectionId", ""), nil, false},
		{"missing-connection", base("connectionId", "t_pxport_none"), nil, false},
		{"not-smtp", base("connectionId", "t_pxport_http"), nil, false},
		{"attach-none", base("attachments", "{{empty}}"), nil, false},
		{"attach-missing", base("attachments", "/nonexistent/file.pdf"), nil, false},
		{"too-big", base("attachments", a1, "maxAttachmentMB", 0.0001), nil, false},
	}
	for _, c := range cases {
		spec := map[string]any{
			"flow":      map[string]any{"nodes": []any{}, "edges": []any{}},
			"node":      map[string]any{"id": "mail", "type": "email-action", "data": c.data},
			"input":     map[string]any{},
			"variables": vars,
		}
		smtp.reject = map[string]bool{}
		for _, r := range c.reject {
			smtp.reject[r] = true
		}
		smtp.badAuth = c.bad
		smtp.reset()
		ts := pxRunTS(t, "EmailActionExecutor.ts", "EmailActionExecutor", spec, "DATABASE_URL", pxTestDB)
		tsCmds, tsMsgs := smtp.cmds, smtp.messages
		smtp.reset()

		b, _ := json.Marshal(spec)
		var req struct {
			Node      Node           `json:"node"`
			Variables map[string]any `json:"variables"`
		}
		_ = json.Unmarshal(b, &req)
		er := &ExecuteRequest{RunID: "t", CallbackURL: cb.URL + "/internal/engine/node", Variables: req.Variables}
		r := newRun(er, func(map[string]any) {})
		ctx := &Ctx{ID: "root", Input: map[string]any{}, Vars: req.Variables, dirty: map[string]bool{}, run: r}
		out, err := execEmailAction(r, &req.Node, ctx)
		gor := pxTSResult{Logs: []map[string]any{}}
		if err != nil {
			gor.Error = err.Error()
		} else {
			gor.Out = pxRoundTrip(out)
		}
		for _, l := range r.logs {
			m := map[string]any{"level": l.Level, "message": l.Message}
			if l.Data != nil {
				m["data"] = l.Data
			}
			gor.Logs = append(gor.Logs, m)
		}
		goCmds, goMsgs := smtp.cmds, smtp.messages
		// the harness exits right after sendMail resolves, before nodemailer's QUIT lands
		if n := len(goCmds); n > 0 && goCmds[n-1] == "QUIT" && (len(tsCmds) == 0 || tsCmds[len(tsCmds)-1] != "QUIT") {
			goCmds = goCmds[:n-1]
		}
		norm := func(x pxTSResult) pxTSResult {
			for _, l := range x.Logs {
				l["message"] = pxMsgIDRe.ReplaceAllString(l["message"].(string), "<ID>")
			}
			return x
		}
		mask := []string{"messageId", "sentAt"}
		if c.data["zipAttachments"] == true { // zip container bytes differ (header extras); contents are compared below
			mask = append(mask, "attachmentBytes")
			t.Logf("%s: zip size TS %v / Go %v", c.name, asMap(ts.Out)["attachmentBytes"], asMap(gor.Out)["attachmentBytes"])
		}
		pxCompare(t, c.name, norm(ts), norm(gor), mask...)
		if !reflect.DeepEqual(tsCmds, goCmds) {
			t.Fatalf("%s: SMTP commands differ\nTS: %q\nGo: %q", c.name, tsCmds, goCmds)
		}
		if len(tsMsgs) != len(goMsgs) {
			t.Fatalf("%s: %d vs %d messages", c.name, len(tsMsgs), len(goMsgs))
		}
		for i := range tsMsgs {
			pxCompareMessages(t, c.name, dir, tsMsgs[i], goMsgs[i])
		}
	}
}

type pxParsed struct {
	Headers map[string]string
	Body    string
	Parts   map[string][]byte // filename → content ("" = text body)
}

func pxParseMessage(t *testing.T, raw []byte) pxParsed {
	t.Helper()
	m, err := mail.ReadMessage(strings.NewReader(string(raw)))
	if err != nil {
		t.Fatalf("parse: %v\n%s", err, raw)
	}
	dec := new(mime.WordDecoder)
	p := pxParsed{Headers: map[string]string{}, Parts: map[string][]byte{}}
	for _, h := range []string{"From", "To", "Cc", "Subject", "Bcc"} {
		v, _ := dec.DecodeHeader(m.Header.Get(h))
		p.Headers[h] = v
	}
	readPart := func(h pxTextprotoHeader, r io.Reader) []byte {
		b, _ := io.ReadAll(r)
		if strings.EqualFold(h.Get("Content-Transfer-Encoding"), "base64") {
			b, _ = base64.StdEncoding.DecodeString(strings.NewReplacer("\r", "", "\n", "").Replace(string(b)))
		} else if strings.EqualFold(h.Get("Content-Transfer-Encoding"), "quoted-printable") {
			b, _ = io.ReadAll(quotedprintable.NewReader(strings.NewReader(string(b))))
		}
		return b
	}
	mt, params, _ := mime.ParseMediaType(m.Header.Get("Content-Type"))
	if !strings.HasPrefix(mt, "multipart/") {
		p.Parts[""] = readPart(pxTextprotoHeader(m.Header), m.Body)
		p.Headers["ct"] = mt
		return p
	}
	mr := multipart.NewReader(m.Body, params["boundary"])
	for {
		part, err := mr.NextRawPart()
		if err != nil {
			break
		}
		name := ""
		if _, dp, err := mime.ParseMediaType(part.Header.Get("Content-Disposition")); err == nil {
			name = dp["filename"]
			if strings.HasPrefix(name, "=?") {
				name, _ = dec.DecodeHeader(name)
			}
		}
		if name == "" {
			pt, _, _ := mime.ParseMediaType(part.Header.Get("Content-Type"))
			p.Headers["ct"] = pt
		}
		p.Parts[name] = readPart(pxTextprotoHeader(part.Header), part)
	}
	return p
}

// pxCompareMessages compares what a mail client shows: headers, body text and
// attachments (zips by their extracted content).
func pxCompareMessages(t *testing.T, name, dir string, tsRaw, goRaw []byte) {
	t.Helper()
	a, b := pxParseMessage(t, tsRaw), pxParseMessage(t, goRaw)
	for k, v := range a.Parts {
		if strings.HasSuffix(strings.ToLower(k), ".zip") {
			a.Parts[k] = []byte(pxUnzip(t, dir, v))
			b.Parts[k] = []byte(pxUnzip(t, dir, b.Parts[k]))
		}
	}
	if !reflect.DeepEqual(a, b) {
		t.Fatalf("%s: message differs\nTS: %+v\nGo: %+v\nraw TS:\n%s\nraw Go:\n%s", name, a, b, tsRaw, goRaw)
	}
}

// pxUnzip lists name, flags, method and content of every entry (Python's
// zipfile, password s3cret, which also checks the ZipCrypto check byte).
func pxUnzip(t *testing.T, dir string, z []byte) string {
	t.Helper()
	d, _ := os.MkdirTemp(dir, "z")
	zf := filepath.Join(d, "a.zip")
	_ = os.WriteFile(zf, z, 0o644)
	out, err := exec.Command("python3", "-I", "-c", `import sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
for i in z.infolist():
    print(i.filename, hex(i.flag_bits), i.compress_type, i.external_attr >> 16, z.read(i, pwd=b"s3cret").decode())`, zf).CombinedOutput()
	if err != nil {
		t.Fatalf("unzip: %v %s", err, out)
	}
	return string(out)
}

func TestPxportEmailRetryAndRefused(t *testing.T) {
	pxSMTPDelay = 10 * time.Millisecond
	defer func() { pxSMTPDelay = 10 * time.Second }()
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	port := ln.Addr().(*net.TCPAddr).Port
	ln.Close() // nothing listens: connection refused
	tr := pxSMTP{host: "127.0.0.1", port: port, timeout: time.Second}
	_, err := tr.send("a@b", []string{"c@d"}, []byte("x"))
	if err == nil || err.Error() != fmt.Sprintf("connect ECONNREFUSED 127.0.0.1:%d", port) {
		t.Fatalf("got %v", err)
	}
	// greeting never arrives
	ln2, _ := net.Listen("tcp", "127.0.0.1:0")
	defer ln2.Close()
	go func() {
		for {
			c, err := ln2.Accept()
			if err != nil {
				return
			}
			defer c.Close()
		}
	}()
	tr = pxSMTP{host: "127.0.0.1", port: ln2.Addr().(*net.TCPAddr).Port, timeout: 200 * time.Millisecond}
	if _, err := tr.send("a@b", []string{"c@d"}, []byte("x")); err == nil || err.Error() != "Greeting never received" {
		t.Fatalf("got %v", err)
	}
}

type pxTextprotoHeader = textproto.MIMEHeader
