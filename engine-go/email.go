package main

// Port of server/src/sdk/execution/executors/EmailActionExecutor.ts: send a
// mail through a stored SMTP connection (nodemailer in TS), optionally with
// the attachments zipped (and ZipCrypto-encrypted with a password, like
// archiver-zip-encryptable).

import (
	"bytes"
	"crypto/hmac"
	"crypto/md5"
	"crypto/rand"
	"crypto/tls"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"mime"
	"net"
	"net/textproto"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

func init() { nativeExecutors["email-action"] = execEmailAction }

// pxSMTPDelay is the wait between retries (a var so tests can shorten it).
var pxSMTPDelay = 10 * time.Second

var pxAddrSplit = regexp.MustCompile(`[,;\n]`)

func pxSplitAddresses(v any) ([]string, error) {
	s, ok := v.(string)
	if !ok {
		if v == nil {
			return nil, errors.New("Cannot read properties of undefined (reading 'split')")
		}
		return nil, errors.New("value.split is not a function")
	}
	out := []string{}
	for _, p := range pxAddrSplit.Split(s, -1) {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out, nil
}

// pxCollectPaths flattens whatever a template resolved to into file paths.
func pxCollectPaths(v any, out *[]string) {
	switch t := v.(type) {
	case nil:
		return
	case *undefinedT:
		return
	case string:
		s := strings.TrimSpace(t)
		if s == "" {
			return
		}
		if strings.HasPrefix(s, "[") || strings.HasPrefix(s, "{") {
			var parsed any
			if json.Unmarshal([]byte(s), &parsed) == nil {
				pxCollectPaths(parsed, out)
				return
			}
		}
		*out = append(*out, s)
	case []any:
		for _, x := range t {
			pxCollectPaths(x, out)
		}
	case map[string]any:
		var p any
		for _, k := range []string{"localPath", "filePath", "path"} {
			if x, ok := t[k]; ok && x != nil {
				p = x
				break
			}
		}
		if s, ok := p.(string); ok {
			*out = append(*out, s)
			return
		}
		if files, ok := t["files"].([]any); ok {
			pxCollectPaths(files, out)
		}
	}
}

type pxAttachment struct{ filename, path string }

func execEmailAction(r *Run, node *Node, ctx *Ctx) (any, error) {
	d := node.Data
	connID := str(d, "connectionId")
	if connID == "" {
		return nil, errors.New("Email action: select an SMTP connection")
	}
	conn, err := r.fallback.connection(connID)
	if err != nil {
		if strings.HasPrefix(err.Error(), "Connection not found") {
			return nil, fmt.Errorf("Email action: connection not found (%s)", connID)
		}
		return nil, err
	}
	if t, _ := conn["type"].(string); t != "smtp" {
		return nil, fmt.Errorf(`Email action: "%s" is not an SMTP connection`, jsString(conn["name"]))
	}
	cfg := asMap(conn["config"])

	tpl := func(k string) any { return ctx.resolveTemplate(str(d, k)) }
	to, err := pxSplitAddresses(tpl("to"))
	if err != nil {
		return nil, err
	}
	if len(to) == 0 {
		r.log("warn", node.ID, "Email skipped: no recipient (To) configured", nil)
		return pxClean(om("status", "skipped", "reason", "no recipient", "subject", pxTemplate(ctx, str(d, "subject")))), nil
	}
	cc, err := pxSplitAddresses(tpl("cc"))
	if err != nil {
		return nil, err
	}
	bcc, err := pxSplitAddresses(tpl("bcc"))
	if err != nil {
		return nil, err
	}
	subjectV := tpl("subject")
	bodyV := tpl("body")

	paths := []string{}
	attCfg := str(d, "attachments")
	for _, line := range strings.Split(attCfg, "\n") {
		if line = strings.TrimSpace(line); line != "" {
			pxCollectPaths(pxTemplate(ctx, line), &paths)
		}
	}
	if len(paths) == 0 && strings.TrimSpace(attCfg) != "" {
		return nil, fmt.Errorf(`Email action: attachments "%s" resolved to no file path`, strings.TrimSpace(attCfg))
	}
	for _, p := range paths {
		if !pxExists(p) {
			return nil, fmt.Errorf("Email action: attachment not found: %s", p)
		}
	}

	var temps []string
	defer func() {
		for _, f := range temps {
			_ = os.Remove(f)
		}
	}()
	atts := make([]pxAttachment, len(paths))
	for i, p := range paths {
		atts[i] = pxAttachment{filepath.Base(p), p}
	}
	if truthy(d["zipAttachments"]) && len(atts) > 0 {
		zn := ctx.resolveTemplate(str(d, "zipName"))
		if !truthy(zn) {
			zn = "attachments"
		}
		zipName := regexp.MustCompile(`(?i)\.zip$`).ReplaceAllString(jsString(zn), "") + ".zip"
		password := ""
		if pw := ctx.resolveTemplate(str(d, "zipPassword")); pw != nil {
			password = jsString(pw)
		}
		zipPath := filepath.Join(os.TempDir(), fmt.Sprintf("email-%d-%s.zip", time.Now().UnixMilli(), pxRand36()))
		temps = append(temps, zipPath)
		if err := pxZip(atts, zipPath, password); err != nil {
			return nil, err
		}
		atts = []pxAttachment{{zipName, zipPath}}
		suffix := ""
		if password != "" {
			suffix = " (password protected)"
		}
		r.log("info", node.ID, fmt.Sprintf("Zipped %d file(s) into %s%s", len(paths), zipName, suffix), nil)
	}

	var total int64
	for _, a := range atts {
		st, err := os.Stat(a.path)
		if err != nil {
			return nil, pxFsErr(err, "stat", a.path)
		}
		total += st.Size()
	}
	maxMB := 20.0
	if v, ok := d["maxAttachmentMB"]; ok && v != nil {
		if n, ok := pxNumber(v).(float64); ok {
			maxMB = n
		}
	}
	if float64(total) > maxMB*1024*1024 {
		return nil, fmt.Errorf(`Email action: attachments are %s MB, over the %s MB limit. Send a link instead, or raise "Max attachment size" if the mail server accepts it.`,
			pxToFixed(float64(total)/1048576, 1), pxMaxLabel(d["maxAttachmentMB"], maxMB))
	}

	port := 587
	if p, ok := pxNumber(cfg["port"]).(float64); ok && p != 0 && !math.IsNaN(p) {
		port = int(p)
	}
	portNum, _ := pxNumber(cfg["port"]).(float64)
	tr := pxSMTP{
		host:     jsString(cfg["host"]),
		port:     port,
		secure:   cfg["secure"] == true || cfg["secure"] == "true" || portNum == 465,
		insecure: truthy(cfg["allowSelfSigned"]),
		timeout:  60 * time.Second,
	}
	if cfg["host"] == nil {
		tr.host = "localhost"
	}
	if truthy(cfg["username"]) {
		tr.user, tr.pass = jsString(cfg["username"]), pxStrOrEmpty(cfg["password"])
	}

	fromAddr := pxOr(cfg["fromAddress"], cfg["username"])
	from := pxStrOrEmpty(fromAddr)
	if truthy(cfg["fromName"]) {
		from = fmt.Sprintf(`"%s" <%s>`, jsString(cfg["fromName"]), pxJSString(fromAddr))
	}
	subject, body := pxStrOrEmpty(subjectV), pxStrOrEmpty(bodyV)
	html := str(d, "bodyFormat") == "html"

	envFrom := pxAddrOnly(from)
	domain := "localhost"
	if envFrom != "" {
		domain = envFrom[strings.LastIndex(envFrom, "@")+1:]
	} else if h := pxHeloName(); h != "" {
		domain = strings.Trim(h, "[]")
	}
	messageID := "<" + pxRandHex(4) + "-" + pxRandHex(2) + "-" + pxRandHex(2) + "-" + pxRandHex(2) + "-" + pxRandHex(6) + "@" + domain + ">"
	raw, err := pxBuildMessage(from, to, cc, subject, body, html, atts, messageID)
	if err != nil {
		return nil, err
	}
	rcpts := []string{}
	for _, a := range append(append(append([]string{}, to...), cc...), bcc...) {
		if x := pxAddrOnly(a); x != "" {
			rcpts = append(rcpts, x)
		}
	}

	var info *pxSMTPInfo
	for attempt := 1; ; attempt++ {
		info, err = tr.send(envFrom, rcpts, raw)
		if err == nil {
			break
		}
		var se *pxSMTPError
		transient := false
		if errors.As(err, &se) {
			switch se.code {
			case "ETIMEDOUT", "ECONNECTION", "ESOCKET", "ECONNRESET", "ECONNREFUSED":
				transient = true
			}
		}
		if regexp.MustCompile(`(?i)greeting never received|timeout`).MatchString(err.Error()) {
			transient = true
		}
		if !transient || attempt >= 3 {
			return nil, err
		}
		r.log("warn", node.ID, fmt.Sprintf("Mail server did not answer (%s); retry %d/2 in 10 s", err.Error(), attempt), nil)
		time.Sleep(pxSMTPDelay)
	}

	r.log("info", node.ID, fmt.Sprintf("Email sent to %s (%s)", strings.Join(to, ", "), messageID), nil)
	names := make([]any, len(atts))
	for i, a := range atts {
		names[i] = a.filename
	}
	return om(
		"to", pxStrList(to), "cc", pxStrList(cc), "bcc", pxStrList(bcc), "subject", pxClean(subjectV),
		"attachments", names, "attachmentBytes", float64(total), "messageId", messageID,
		"accepted", pxStrList(info.accepted), "rejected", pxStrList(info.rejected),
		"status", "sent", "sentAt", isoNow(),
	), nil
}

func pxStrOrEmpty(v any) string {
	if v == nil || v == undefinedV {
		return ""
	}
	return jsString(v)
}

func pxStrList(s []string) []any {
	out := make([]any, len(s))
	for i, x := range s {
		out[i] = x
	}
	return out
}

func pxRandHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

var pxAngleAddr = regexp.MustCompile(`<([^<>]*)>\s*$`)

func pxAddrOnly(a string) string {
	if m := pxAngleAddr.FindStringSubmatch(a); m != nil {
		return strings.TrimSpace(m[1])
	}
	return strings.TrimSpace(a)
}

func pxHeloName() string {
	h, err := os.Hostname()
	if err != nil {
		h = "localhost"
	}
	if h == "" || !strings.Contains(h, ".") {
		return "[127.0.0.1]"
	}
	if net.ParseIP(h) != nil {
		return "[" + h + "]"
	}
	return h
}

// ── MIME ─────────────────────────────────────────────────────────────────────

func pxIsASCII(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] >= 0x80 {
			return false
		}
	}
	return true
}

func pxHeaderWord(s string) string {
	if pxIsASCII(s) {
		return s
	}
	return mime.BEncoding.Encode("UTF-8", s)
}

// pxEncodeFrom formats a display name like nodemailer: bare when it is
// only word characters, quoted when printable ASCII, encoded-word otherwise.
func pxEncodeFrom(from string) string {
	m := regexp.MustCompile(`^"(.*)" <(.*)>$`).FindStringSubmatch(from)
	if m == nil {
		return from
	}
	name := m[1]
	switch {
	case regexp.MustCompile(`^[\w ']*$`).MatchString(name):
	case regexp.MustCompile(`^[\x20-\x7e]*$`).MatchString(name):
		name = `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(name) + `"`
	default:
		name = mime.QEncoding.Encode("UTF-8", name)
	}
	return name + " <" + m[2] + ">"
}

func pxWrap76(b []byte) string {
	enc := base64.StdEncoding.EncodeToString(b)
	var sb strings.Builder
	for len(enc) > 76 {
		sb.WriteString(enc[:76] + "\r\n")
		enc = enc[76:]
	}
	sb.WriteString(enc)
	return sb.String()
}

// pxTextBody returns the transfer encoding and encoded text body.
func pxTextBody(body string) (string, string) {
	short := true
	for _, l := range strings.Split(body, "\n") {
		if len(l) > 76 {
			short = false
		}
	}
	if pxIsASCII(body) && short {
		return "7bit", strings.ReplaceAll(strings.ReplaceAll(body, "\r\n", "\n"), "\n", "\r\n")
	}
	return "base64", pxWrap76([]byte(body))
}

func pxBuildMessage(from string, to, cc []string, subject, body string, html bool, atts []pxAttachment, messageID string) ([]byte, error) {
	var buf bytes.Buffer
	boundary := "--_NmP-" + pxRandHex(8) + "-Part_1"
	ct := "text/plain"
	if html {
		ct = "text/html"
	}
	cte, enc := pxTextBody(body)
	if from != "" {
		buf.WriteString("From: " + pxEncodeFrom(from) + "\r\n")
	}
	buf.WriteString("To: " + strings.Join(to, ", ") + "\r\n")
	if len(cc) > 0 {
		buf.WriteString("Cc: " + strings.Join(cc, ", ") + "\r\n")
	}
	buf.WriteString("Subject: " + pxHeaderWord(subject) + "\r\n")
	buf.WriteString("Message-ID: " + messageID + "\r\n")
	if len(atts) == 0 {
		buf.WriteString("Content-Transfer-Encoding: " + cte + "\r\n")
	}
	buf.WriteString("Date: " + time.Now().UTC().Format("Mon, 02 Jan 2006 15:04:05 +0000") + "\r\n")
	buf.WriteString("MIME-Version: 1.0\r\n")
	if len(atts) == 0 {
		buf.WriteString("Content-Type: " + ct + "; charset=utf-8\r\n\r\n" + enc + "\r\n")
		return buf.Bytes(), nil
	}
	buf.WriteString(`Content-Type: multipart/mixed; boundary="` + boundary + "\"\r\n\r\n")
	buf.WriteString("--" + boundary + "\r\n")
	buf.WriteString("Content-Type: " + ct + "; charset=utf-8\r\nContent-Transfer-Encoding: " + cte + "\r\n\r\n" + enc + "\r\n")
	for _, a := range atts {
		data, err := os.ReadFile(a.path)
		if err != nil {
			return nil, pxFsErr(err, "open", a.path)
		}
		ct := mime.TypeByExtension(strings.ToLower(filepath.Ext(a.filename)))
		if ct == "" {
			ct = "application/octet-stream"
		}
		if i := strings.Index(ct, ";"); i >= 0 {
			ct = ct[:i]
		}
		name := `"` + a.filename + `"`
		if !pxIsASCII(a.filename) {
			name = `"` + mime.BEncoding.Encode("UTF-8", a.filename) + `"`
		}
		buf.WriteString("--" + boundary + "\r\n")
		buf.WriteString("Content-Type: " + ct + "; name=" + name + "\r\n")
		buf.WriteString("Content-Transfer-Encoding: base64\r\n")
		buf.WriteString("Content-Disposition: attachment; filename=" + name + "\r\n\r\n")
		buf.WriteString(pxWrap76(data) + "\r\n")
	}
	buf.WriteString("--" + boundary + "--\r\n")
	return buf.Bytes(), nil
}

// ── SMTP (the parts of nodemailer's smtp-connection the executor relies on) ──

type pxSMTP struct {
	host, user, pass string
	port             int
	secure, insecure bool
	timeout          time.Duration
}

type pxSMTPInfo struct{ accepted, rejected []string }

type pxSMTPError struct{ msg, code string }

func (e *pxSMTPError) Error() string { return e.msg }

type pxDeadlineConn struct {
	net.Conn
	d time.Duration
}

func (c *pxDeadlineConn) Read(b []byte) (int, error) {
	_ = c.Conn.SetDeadline(time.Now().Add(c.d))
	return c.Conn.Read(b)
}

func (c *pxDeadlineConn) Write(b []byte) (int, error) {
	_ = c.Conn.SetDeadline(time.Now().Add(c.d))
	return c.Conn.Write(b)
}

func pxSockErr(err error) error {
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		return &pxSMTPError{"Timeout", "ETIMEDOUT"}
	}
	if strings.Contains(err.Error(), "connection reset") {
		return &pxSMTPError{"read ECONNRESET", "ESOCKET"}
	}
	if errors.Is(err, net.ErrClosed) || err.Error() == "EOF" {
		return &pxSMTPError{"Connection closed unexpectedly", "EPROTOCOL"}
	}
	return &pxSMTPError{err.Error(), "ESOCKET"}
}

func (s *pxSMTP) send(from string, rcpts []string, msg []byte) (*pxSMTPInfo, error) {
	addr := net.JoinHostPort(s.host, strconv.Itoa(s.port))
	dialer := &net.Dialer{Timeout: s.timeout}
	tlsCfg := &tls.Config{ServerName: s.host, InsecureSkipVerify: s.insecure}
	var raw net.Conn
	var err error
	if s.secure {
		raw, err = tls.DialWithDialer(dialer, "tcp", addr, tlsCfg)
	} else {
		raw, err = dialer.Dial("tcp", addr)
	}
	if err != nil {
		var ne net.Error
		var dns *net.DNSError
		switch {
		case errors.As(err, &dns):
			return nil, &pxSMTPError{"getaddrinfo ENOTFOUND " + s.host, "EDNS"}
		case errors.As(err, &ne) && ne.Timeout():
			return nil, &pxSMTPError{"Connection timeout", "ETIMEDOUT"}
		case strings.Contains(err.Error(), "connection refused"):
			ip := addr
			var op *net.OpError
			if errors.As(err, &op) && op.Addr != nil {
				ip = op.Addr.String()
			}
			return nil, &pxSMTPError{"connect ECONNREFUSED " + ip, "ESOCKET"}
		}
		return nil, &pxSMTPError{err.Error(), "ESOCKET"}
	}
	defer raw.Close()
	conn := &pxDeadlineConn{raw, s.timeout}
	tp := textproto.NewConn(conn)

	read := func() (int, string, error) {
		code, m, err := tp.ReadResponse(0)
		if err != nil {
			if _, ok := err.(*textproto.Error); !ok {
				return 0, "", pxSockErr(err)
			}
		}
		lines := strings.Split(m, "\n")
		for i := range lines {
			sep := " "
			if i < len(lines)-1 {
				sep = "-"
			}
			lines[i] = strconv.Itoa(code) + sep + lines[i]
		}
		return code, strings.Join(lines, "\n"), nil
	}
	cmd := func(line string) (int, string, error) {
		if err := tp.PrintfLine("%s", line); err != nil {
			return 0, "", pxSockErr(err)
		}
		return read()
	}

	code, resp, err := read()
	if err != nil {
		var se *pxSMTPError
		if errors.As(err, &se) && se.code == "ETIMEDOUT" {
			return nil, &pxSMTPError{"Greeting never received", "ETIMEDOUT"}
		}
		return nil, err
	}
	if code != 220 {
		return nil, &pxSMTPError{"Invalid greeting. response=" + resp + ": " + resp, "EPROTOCOL"}
	}
	name := pxHeloName()
	ehlo := func() (string, error) {
		c, r, err := cmd("EHLO " + name)
		if err != nil {
			return "", err
		}
		if c/100 != 2 {
			c, r, err = cmd("HELO " + name)
			if err != nil {
				return "", err
			}
			if c/100 != 2 {
				return "", &pxSMTPError{"Invalid response for EHLO/HELO: " + r, "EPROTOCOL"}
			}
		}
		return r, nil
	}
	caps, err := ehlo()
	if err != nil {
		return nil, err
	}
	if !s.secure && regexp.MustCompile(`(?i)[ -]STARTTLS\b`).MatchString(caps) {
		c, r, err := cmd("STARTTLS")
		if err != nil {
			return nil, err
		}
		if c != 220 {
			return nil, &pxSMTPError{"Error upgrading connection with STARTTLS: " + r, "ETLS"}
		}
		tc := tls.Client(raw, tlsCfg)
		_ = raw.SetDeadline(time.Now().Add(s.timeout))
		if err := tc.Handshake(); err != nil {
			return nil, &pxSMTPError{err.Error(), "ESOCKET"}
		}
		conn = &pxDeadlineConn{tc, s.timeout}
		tp = textproto.NewConn(conn)
		if caps, err = ehlo(); err != nil {
			return nil, err
		}
	}
	if s.user != "" {
		method := "PLAIN"
		var supported []string
		for _, m := range []string{"PLAIN", "LOGIN", "CRAM-MD5", "XOAUTH2"} {
			if regexp.MustCompile(`(?i)[ -]AUTH(?:(\s+|=)[^\n]*\s+|\s+|=)` + m).MatchString(caps) {
				supported = append(supported, m)
			}
		}
		if len(supported) > 0 {
			method = supported[0]
		}
		if err := s.auth(cmd, method); err != nil {
			return nil, err
		}
	}
	c, r, err := cmd("MAIL FROM:<" + from + ">")
	if err != nil {
		return nil, err
	}
	if c/100 != 2 {
		return nil, &pxSMTPError{"Mail command failed: " + r, "EENVELOPE"}
	}
	info := &pxSMTPInfo{accepted: []string{}, rejected: []string{}}
	last := ""
	for _, rc := range rcpts {
		c, r, err := cmd("RCPT TO:<" + rc + ">")
		if err != nil {
			return nil, err
		}
		if c/100 == 2 {
			info.accepted = append(info.accepted, rc)
		} else {
			info.rejected = append(info.rejected, rc)
			last = r
		}
	}
	if len(info.accepted) == 0 {
		return nil, &pxSMTPError{"Can't send mail - all recipients were rejected: " + last, "EENVELOPE"}
	}
	c, r, err = cmd("DATA")
	if err != nil {
		return nil, err
	}
	if c != 354 {
		return nil, &pxSMTPError{"Data command failed: " + r, "EENVELOPE"}
	}
	w := tp.DotWriter()
	if _, err := w.Write(msg); err != nil {
		return nil, pxSockErr(err)
	}
	if err := w.Close(); err != nil {
		return nil, pxSockErr(err)
	}
	c, r, err = read()
	if err != nil {
		return nil, err
	}
	if c/100 != 2 {
		return nil, &pxSMTPError{"Message failed: " + r, "EMESSAGE"}
	}
	_, _, _ = cmd("QUIT")
	return info, nil
}

func (s *pxSMTP) auth(cmd func(string) (int, string, error), method string) error {
	b64 := func(x string) string { return base64.StdEncoding.EncodeToString([]byte(x)) }
	fail := func(r string) error { return &pxSMTPError{"Invalid login: " + r, "EAUTH"} }
	switch method {
	case "LOGIN":
		c, r, err := cmd("AUTH LOGIN")
		if err != nil {
			return err
		}
		if c != 334 || !strings.Contains(r, "VXNlcm5hbWU6") {
			return &pxSMTPError{`Invalid login sequence while waiting for "334 VXNlcm5hbWU6": ` + r, "EAUTH"}
		}
		c, r, err = cmd(b64(s.user))
		if err != nil {
			return err
		}
		if c != 334 || !strings.Contains(r, "UGFzc3dvcmQ6") {
			return &pxSMTPError{`Invalid login sequence while waiting for "334 UGFzc3dvcmQ6": ` + r, "EAUTH"}
		}
		c, r, err = cmd(b64(s.pass))
		if err != nil {
			return err
		}
		if c != 235 {
			return fail(r)
		}
	case "CRAM-MD5":
		c, r, err := cmd("AUTH CRAM-MD5")
		if err != nil {
			return err
		}
		ch, derr := base64.StdEncoding.DecodeString(strings.TrimSpace(strings.TrimPrefix(r, "334")))
		if c != 334 || derr != nil {
			return &pxSMTPError{"Invalid login sequence while waiting for server challenge string: " + r, "EAUTH"}
		}
		h := hmac.New(md5.New, []byte(s.pass))
		h.Write(ch)
		c, r, err = cmd(b64(s.user + " " + hex.EncodeToString(h.Sum(nil))))
		if err != nil {
			return err
		}
		if c != 235 {
			return &pxSMTPError{`Invalid login sequence while waiting for "235": ` + r, "EAUTH"}
		}
	default: // PLAIN
		c, r, err := cmd("AUTH PLAIN " + b64("\x00"+s.user+"\x00"+s.pass))
		if err != nil {
			return err
		}
		if c != 235 {
			return fail(r)
		}
	}
	return nil
}

func pxMaxLabel(v any, n float64) string {
	if s, ok := v.(string); ok {
		return s
	}
	return jsNumber(n)
}
