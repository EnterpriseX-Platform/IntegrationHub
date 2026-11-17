package main

import (
	"archive/zip"
	"bytes"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ProtonMail/go-crypto/openpgp"
	"github.com/ProtonMail/go-crypto/openpgp/armor"
	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

// ── test SFTP server on 127.0.0.1 ───────────────────────────────────────────

func sbportSFTPServer(t *testing.T) (host string, port int) {
	t.Helper()
	key, _ := rsa.GenerateKey(rand.Reader, 2048)
	signer, _ := ssh.NewSignerFromKey(key)
	cfg := &ssh.ServerConfig{PasswordCallback: func(c ssh.ConnMetadata, pw []byte) (*ssh.Permissions, error) {
		if c.User() == "u" && string(pw) == "p" {
			return nil, nil
		}
		return nil, fmt.Errorf("denied")
	}}
	cfg.AddHostKey(signer)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			nc, err := ln.Accept()
			if err != nil {
				return
			}
			go func(nc net.Conn) {
				_, chans, reqs, err := ssh.NewServerConn(nc, cfg)
				if err != nil {
					nc.Close()
					return
				}
				go ssh.DiscardRequests(reqs)
				for nch := range chans {
					if nch.ChannelType() != "session" {
						nch.Reject(ssh.UnknownChannelType, "")
						continue
					}
					ch, in, _ := nch.Accept()
					go func(in <-chan *ssh.Request) {
						for req := range in {
							req.Reply(req.Type == "subsystem" && string(req.Payload[4:]) == "sftp", nil)
						}
					}(in)
					go func() {
						srv, _ := sftp.NewServer(ch)
						_ = srv.Serve()
						ch.Close()
					}()
				}
			}(nc)
		}
	}()
	a := ln.Addr().(*net.TCPAddr)
	return "127.0.0.1", a.Port
}

// ── DB fixtures (only rows named t_sbport_*) ────────────────────────────────

func sbportDB(t *testing.T) string {
	t.Helper()
	if os.Getenv("DATABASE_URL") == "" {
		t.Setenv("DATABASE_URL", "postgresql://postgres@localhost:55500/postgres")
	}
	if _, err := appDB(); err != nil {
		t.Skip("app DB not reachable:", err)
	}
	pid := newCUID()
	if _, err := appExec(`INSERT INTO projects ("id","name","updatedAt") VALUES ($1,$2,now())`, pid, "t_sbport_"+pid); err != nil {
		t.Skip("cannot create project:", err)
	}
	t.Cleanup(func() {
		_, _ = appExec(`DELETE FROM share_links WHERE "basketId" IN (SELECT "id" FROM baskets WHERE "projectId"=$1)`, pid)
		_, _ = appExec(`DELETE FROM basket_files WHERE "basketId" IN (SELECT "id" FROM baskets WHERE "projectId"=$1)`, pid)
		_, _ = appExec(`DELETE FROM api_keys WHERE "projectId"=$1`, pid)
		_, _ = appExec(`DELETE FROM projects WHERE "id"=$1`, pid)
	})
	return pid
}

func sbportBasket(t *testing.T, pid, typ, dir string) string {
	t.Helper()
	id, err := sbCreateBasket(pid, "t_sbport_"+typ, "", typ, dir, "", false)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func sbportRun(t *testing.T, config map[string]any) *Run {
	old := sbConnLookup
	sbConnLookup = func(r *Run, id string) (map[string]any, error) {
		if id != "conn1" {
			return nil, fmt.Errorf("Connection not found: %s", id)
		}
		return map[string]any{"config": config}, nil
	}
	t.Cleanup(func() { sbConnLookup = old })
	req := &ExecuteRequest{Flow: Flow{OperationID: "op_sbport"}}
	return newRun(req, func(map[string]any) {})
}

func sbportCtx(r *Run, vars map[string]any, input any) *Ctx {
	if vars == nil {
		vars = map[string]any{}
	}
	return &Ctx{ID: "root", Input: input, Vars: vars, dirty: map[string]bool{}, run: r}
}

func sbportNode(typ string, data string) *Node {
	var n Node
	if err := json.Unmarshal([]byte(`{"id":"n1","type":"`+typ+`","data":`+data+`}`), &n); err != nil {
		panic(err)
	}
	return &n
}

func sbportJSON(v any) string { b, _ := json.Marshal(v); return string(b) }

func sbportZip(t *testing.T, path string, files map[string]string) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for n, c := range files {
		w, _ := zw.Create(n)
		io.WriteString(w, c)
	}
	zw.Close()
	if err := os.WriteFile(path, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
}

// ── pure helpers ────────────────────────────────────────────────────────────

func TestSbportPathHelpers(t *testing.T) {
	cases := [][2]string{
		{sbJoin("/", "", "a.txt"), "/a.txt"}, {sbJoin("/base/", "sub/", "x"), "/base/sub/x"},
		{sbJoin("", ""), "."}, {sbJoin("a", "../b/"), "b/"}, {sbJoin("/a", "../../c"), "/c"},
		{sbNormalize("/outbox//SRC/"), "/outbox/SRC/"}, {sbBasename("/x/y.zip", ".zip"), "y"},
		{sbBasename("/x/"), "x"}, {sbExtname(".bashrc"), ""}, {sbExtname("a.tar.gz"), ".gz"}, {sbExtname("a."), "."},
		{sbDirname("/a"), "/"}, {sbDirname("a"), "."},
		{sbToFixed(0.25, 1), "0.3"}, {sbToFixed(1.05, 1), "1.1"}, {sbToFixed(2.5, 0), "3"}, {sbToFixed(1023.96, 1), "1024.0"},
		{sbFormatSize(1536), "1.5 KB"}, {sbFormatSize(10), "10 B"},
		{sbBEDate(1792540800), "2569-10-21"}, {jsString(sbFiscalYearOf("2569-10-06")), "2570"}, {jsString(sbFiscalYearOf("25690906")), "2569"},
		{sbFolderPath("ปี 2570", "a"), "a/___2570"}, {sbDecryptedName("X.CSV.ENC"), "X.CSV"},
		{sbStringify(sbObj{{"a", "x <"}, {"b", undefinedV}, {"c", []string{"q"}}, {"d", 1.5}}), "{\"a\":\"x <\",\"c\":[\"q\"],\"d\":1.5}"},
	}
	for i, c := range cases {
		if c[0] != c[1] {
			t.Errorf("case %d: got %q want %q", i, c[0], c[1])
		}
	}
	re, _ := sbGlobLoose("R3_*.txt", false)
	if !re.MatchString("R3_OUT.txt") || re.MatchString("r3_OUT.txt") || re.MatchString("R3_OUTxtxt") {
		t.Error("loose glob")
	}
	if !sbGlobStrict("*.(1).CSV").MatchString("a.(1).csv") {
		t.Error("strict glob")
	}
	if sbLocaleCompare("2569-10-06", "2569-9-30") >= 0 || sbLocaleCompare("b", "A") <= 0 {
		t.Error("localeCompare")
	}
	if n := sbGenBatchNameSFTP("B-{YYYY+543}-{NN}-{NN}"); !strings.HasSuffix(n, "-{SEQ2}-{NN}") {
		t.Errorf("sftp batch name %s", n)
	}
	if n := sbGenBatchNameBA("B-{NN}-{NN}"); n != "B-{SEQ2}-{SEQ2}" {
		t.Errorf("basket-action batch name %s", n)
	}
}

func TestSbportPPK(t *testing.T) {
	key, _ := rsa.GenerateKey(rand.Reader, 2048)
	sshStr := func(b []byte) []byte {
		l := make([]byte, 4)
		l[0], l[1], l[2], l[3] = byte(len(b)>>24), byte(len(b)>>16), byte(len(b)>>8), byte(len(b))
		return append(l, b...)
	}
	mp := func(b []byte) []byte {
		if len(b) > 0 && b[0]&0x80 != 0 {
			b = append([]byte{0}, b...)
		}
		return sshStr(b)
	}
	e := []byte{1, 0, 1}
	pub := append(append(sshStr([]byte("ssh-rsa")), mp(e)...), mp(key.N.Bytes())...)
	key.Precompute()
	priv := append(append(append(mp(key.D.Bytes()), mp(key.Primes[0].Bytes())...), mp(key.Primes[1].Bytes())...), mp(key.Precomputed.Qinv.Bytes())...)
	b64 := func(b []byte) []string {
		s := base64.StdEncoding.EncodeToString(b)
		var out []string
		for len(s) > 64 {
			out = append(out, s[:64])
			s = s[64:]
		}
		return append(out, s)
	}
	pl, vl := b64(pub), b64(priv)
	ppk := fmt.Sprintf("PuTTY-User-Key-File-2: ssh-rsa\r\nEncryption: none\r\nComment: t\r\nPublic-Lines: %d\r\n%s\r\nPrivate-Lines: %d\r\n%s\r\nPrivate-MAC: 00\r\n",
		len(pl), strings.Join(pl, "\r\n"), len(vl), strings.Join(vl, "\r\n"))
	out, err := sbNormalizePrivateKey(ppk)
	if err != nil {
		t.Fatal(err)
	}
	blk, _ := pem.Decode([]byte(out))
	k2, err := x509.ParsePKCS1PrivateKey(blk.Bytes)
	if err != nil || k2.D.Cmp(key.D) != 0 {
		t.Fatalf("converted key differs: %v", err)
	}
	if _, err := ssh.ParsePrivateKey([]byte(out)); err != nil {
		t.Fatal(err)
	}
	if _, err := sbNormalizePrivateKey(strings.Replace(ppk, "Encryption: none", "Encryption: aes256-cbc", 1)); err == nil || !strings.HasPrefix(err.Error(), "Encrypted PPK keys are not supported.") {
		t.Fatal(err)
	}
}

func TestSbportConnectErrors(t *testing.T) {
	host, port := sbportSFTPServer(t)
	if _, err := sbConnect(map[string]any{"host": host, "port": float64(port), "username": "u", "password": "bad"}, sbConnOpts{}); err == nil || err.Error() != "All configured authentication methods failed" {
		t.Fatalf("auth: %v", err)
	}
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	p := ln.Addr().(*net.TCPAddr).Port
	ln.Close()
	if _, err := sbConnect(map[string]any{"host": "127.0.0.1", "port": float64(p)}, sbConnOpts{}); err == nil || err.Error() != fmt.Sprintf("connect ECONNREFUSED 127.0.0.1:%d", p) {
		t.Fatalf("refused: %v", err)
	}
	s, err := sbConnect(map[string]any{"host": host, "port": float64(port), "username": "u", "password": "p"}, sbConnOpts{folderSync: true})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if _, err := s.sbReadDir("/definitely/not/here"); err == nil || err.Error() != "No such file" {
		t.Fatalf("readdir: %v", err)
	}
}

// ── basket-trigger ──────────────────────────────────────────────────────────

func TestSbportBasketTrigger(t *testing.T) {
	pid := sbportDB(t)
	dir := t.TempDir()
	bid := sbportBasket(t, pid, "batch", dir)
	r := sbportRun(t, nil)

	// No sessions → empty vars and message.
	ctx := sbportCtx(r, nil, map[string]any{})
	out, err := execBasketTrigger(r, sbportNode("basket-trigger", `{"basketId":"`+bid+`","filePattern":"*.csv"}`), ctx)
	if err != nil {
		t.Fatal(err)
	}
	if m := out.(map[string]any); m["triggered"] != false || m["message"] != "No sessions with status 'published'" || sbportJSON(ctx.Vars["triggerSessionIds"]) != "[]" {
		t.Fatalf("%v", out)
	}

	s1, _ := sbCreateSession(bid, "t_sbport_s1", 0, 0)
	_ = sbUpdate("processing_sessions", sbS(s1, "id"), false, sbObj{{"status", "published"}})
	f1, _ := sbCreateFile(sbFileRow{BasketID: bid, SessionID: sbS(s1, "id"), FileName: "a.csv", OriginalName: "a.csv", Size: 3, MimeType: "text/csv", Path: dir + "/a.csv", Status: "pending"})
	_, _ = sbCreateFile(sbFileRow{BasketID: bid, SessionID: sbS(s1, "id"), FileName: "b.txt", OriginalName: "b.txt", Size: 3, MimeType: "text/plain", Path: dir + "/b.txt", Status: "pending"})
	_, _ = sbCreateFile(sbFileRow{BasketID: bid, SessionID: sbS(s1, "id"), FileName: "c.csv", OriginalName: "c.csv", Size: 3, MimeType: "text/csv", Path: dir + "/c.csv", Status: "archived"})

	ctx = sbportCtx(r, nil, map[string]any{})
	out, err = execBasketTrigger(r, sbportNode("basket-trigger", `{"basketId":"`+bid+`","filePattern":"*.csv","options":{"autoProcess":true}}`), ctx)
	if err != nil {
		t.Fatal(err)
	}
	m := out.(map[string]any)
	if m["triggered"] != true || m["filesFound"] != float64(1) || sbportJSON(ctx.Vars["triggerSessionIds"]) != `["`+sbS(s1, "id")+`"]` {
		t.Fatalf("%v", sbportJSON(out))
	}
	tf := ctx.Vars["triggerFiles"].([]any)[0].(map[string]any)
	if tf["id"] != f1 || tf["sessionName"] != "t_sbport_s1" || tf["sessionStatus"] != "published" || tf["size"] != float64(3) {
		t.Fatalf("%v", tf)
	}
	if !ctx.dirty["triggerSessionIds"] || ctx.Vars["fileCount"] != float64(1) {
		t.Fatal("vars not marked")
	}
	s, _ := sbOne(`SELECT "status","publishMode" FROM processing_sessions WHERE "id"=$1`, sbS(s1, "id"))
	if sbS(s, "status") != "processing" || sbS(s, "publishMode") != "auto" {
		t.Fatalf("%v", s)
	}
	// Session is processing now: fallback picks it up for a manual run (no update).
	ctx = sbportCtx(r, nil, map[string]any{})
	out, _ = execBasketTrigger(r, sbportNode("basket-trigger", `{"basketId":"`+bid+`","filePattern":"*.csv"}`), ctx)
	if out.(map[string]any)["filesFound"] != float64(1) {
		t.Fatal("fallback")
	}
	// runOnStatuses with no match.
	out, _ = execBasketTrigger(r, sbportNode("basket-trigger", `{"basketId":"`+bid+`","runOnStatuses":["completed","error"]}`), sbportCtx(r, nil, nil))
	if out.(map[string]any)["message"] != "No sessions with status completed / error" {
		t.Fatal(out)
	}
	if _, err := execBasketTrigger(r, sbportNode("basket-trigger", `{"basketId":"nope"}`), sbportCtx(r, nil, nil)); err == nil || err.Error() != "Basket not found: nope" {
		t.Fatal(err)
	}
}

// ── sftp-action upload / download ───────────────────────────────────────────

func TestSbportSFTPUploadDownload(t *testing.T) {
	pid := sbportDB(t)
	host, port := sbportSFTPServer(t)
	remote := t.TempDir()
	local := t.TempDir()
	cfg := map[string]any{"host": host, "port": float64(port), "username": "u", "password": "p", "basePath": remote}
	r := sbportRun(t, cfg)

	up := sbportBasket(t, pid, "batch", local+"/up")
	os.MkdirAll(local+"/up/sessions/s1", 0o755)
	s1, _ := sbCreateSession(up, "t_sbport_up", 0, 0)
	os.WriteFile(local+"/up/sessions/s1/file-1-x_R3_OUT.txt", []byte("hello"), 0o644)
	fid, _ := sbCreateFile(sbFileRow{BasketID: up, SessionID: sbS(s1, "id"), FileName: "file-1-x_R3_OUT.txt", OriginalName: "R3_OUT.txt", Size: 5, MimeType: "text/plain", Path: local + "/up/sessions/s1/file-1-x_R3_OUT.txt", Status: "pending"})
	// Missing on disk: upload fails with the Node wording, server keeps running.
	fid2, _ := sbCreateFile(sbFileRow{BasketID: up, SessionID: sbS(s1, "id"), FileName: "gone.txt", OriginalName: "gone.txt", Size: 1, MimeType: "text/plain", Path: local + "/missing.txt", Status: "pending"})

	ctx := sbportCtx(r, map[string]any{"triggerSessionIds": []any{sbS(s1, "id")}, "basketId": up}, nil)
	out, err := execSFTPAction(r, sbportNode("sftp-action", `{"connectionId":"conn1","operation":"upload","basketId":"`+up+`","remotePath":"out/","filePattern":"*.txt","archiveAfterUpload":true,"remoteFileName":"{{filename}}_x.{{extension}}"}`), ctx)
	if err != nil {
		t.Fatal(err)
	}
	m := out.(map[string]any)
	ups := m["uploads"].([]any)
	if len(ups) != 2 || m["sessionResult"] != nil {
		t.Fatalf("%s", sbportJSON(out))
	}
	u0 := ups[0].(map[string]any)
	if u0["success"] != true || u0["remotePath"] != remote+"/out/R3_OUT_x.txt" {
		t.Fatalf("%s", sbportJSON(u0))
	}
	if b, _ := os.ReadFile(remote + "/out/R3_OUT_x.txt"); string(b) != "hello" {
		t.Fatal("remote content")
	}
	u1 := ups[1].(map[string]any)
	if u1["success"] != false || u1["error"] != "Cannot read local file "+local+"/missing.txt: ENOENT: no such file or directory, open '"+local+"/missing.txt'" {
		t.Fatalf("%s", sbportJSON(u1))
	}
	row, _ := sbOne(`SELECT "status","path" FROM basket_files WHERE "id"=$1`, fid)
	if sbS(row, "status") != "archived" || sbS(row, "path") != sbJoin(local, "up", "archive", "t_sbport_up", "file-1-x_R3_OUT.txt") {
		t.Fatalf("%v", row)
	}
	row, _ = sbOne(`SELECT "status" FROM basket_files WHERE "id"=$1`, fid2)
	if sbS(row, "status") != "pending" {
		t.Fatal(row)
	}
	if r.logs[len(r.logs)-1].Message != "Sending ready files from triggering session(s): "+sbS(s1, "id") {
		t.Fatal(r.logs)
	}
	// All succeed → session completed.
	_ = sbDeleteByID("basket_files", fid2)
	os.WriteFile(local+"/up/b.txt", []byte("b"), 0o644)
	_, _ = sbCreateFile(sbFileRow{BasketID: up, SessionID: sbS(s1, "id"), FileName: "b.txt", OriginalName: "b.txt", Size: 1, MimeType: "text/plain", Path: local + "/up/b.txt", Status: "uploaded"})
	out, _ = execSFTPAction(r, sbportNode("sftp-action", `{"connectionId":"conn1","basketId":"`+up+`","fileStatus":"ready","archiveAfterUpload":true}`), sbportCtx(r, nil, nil))
	if sr := out.(map[string]any)["sessionResult"].(map[string]any); sr["status"] != "completed" {
		t.Fatalf("%s", sbportJSON(out))
	}
	if lg, _ := sbOne(`SELECT "message","metadata" FROM session_logs WHERE "sessionId"=$1`, sbS(s1, "id")); sbS(lg, "message") != "Session completed after SFTP transfer" || !strings.HasPrefix(sbS(lg, "metadata"), `{"allSuccess":true,"completedAt":"`) {
		t.Fatal(lg)
	}
	out, _ = execSFTPAction(r, sbportNode("sftp-action", `{"connectionId":"conn1","basketId":"`+up+`"}`), sbportCtx(r, nil, nil))
	if out.(map[string]any)["message"] != `No published files matching "*.*" found` {
		t.Fatal(out)
	}

	// Download into a batch basket with ZIP extraction.
	os.MkdirAll(remote+"/in", 0o755)
	sbportZip(t, remote+"/in/pack.zip", map[string]string{"d/one.txt": "1", "two.txt": "22"})
	os.WriteFile(remote+"/in/plain.dat", []byte("abc"), 0o644)
	os.WriteFile(remote+"/in/skip.log", []byte("x"), 0o644)
	dn := sbportBasket(t, pid, "batch", local+"/dn")
	_, _ = appExec(`UPDATE baskets SET "sessionPattern"='T-{YYYY}-{NNN}' WHERE "id"=$1`, dn)
	node := sbportNode("sftp-action", `{"connectionId":"conn1","operation":"download","basketId":"`+dn+`","remotePath":"in","filePattern":"*.*","extractZipFiles":true,"sessionMode":"always_new"}`)
	out, err = execSFTPAction(r, node, sbportCtx(r, nil, nil))
	if err != nil {
		t.Fatal(err)
	}
	m = out.(map[string]any)
	if m["filesDownloaded"] != float64(3) || m["remotePath"] != remote+"/in" || len(m["extractedFiles"].([]any)) != 1 {
		t.Fatalf("%s", sbportJSON(out))
	}
	sess, _ := sbOne(`SELECT * FROM processing_sessions WHERE "basketId"=$1`, dn)
	if !strings.HasPrefix(sbS(sess, "batchName"), fmt.Sprintf("T-%d-", time.Now().Year())) || sbI(sess, "fileCount") != 3 {
		t.Fatalf("%v", sess)
	}
	if b, _ := os.ReadFile(sbJoin(local, "dn", "pack", "d", "one.txt")); string(b) != "1" {
		t.Fatal("extract")
	}
	// Second run: same mtimes → skipped.
	out, _ = execSFTPAction(r, node, sbportCtx(r, nil, nil))
	if m := out.(map[string]any); m["filesSkipped"] != float64(3) || m["filesDownloaded"] != float64(0) {
		t.Fatalf("%s", sbportJSON(out))
	}
	// reuse_existing with no open session (the created one is still open → reused)
	os.WriteFile(remote+"/in/new.dat", []byte("n"), 0o644)
	out, err = execSFTPAction(r, sbportNode("sftp-action", `{"connectionId":"conn1","operation":"download","basketId":"`+dn+`","remotePath":"in","sessionMode":"reuse_existing"}`), sbportCtx(r, nil, nil))
	if err != nil || out.(map[string]any)["downloads"].([]any)[3].(map[string]any)["sessionId"] != sbS(sess, "id") {
		t.Fatalf("%v %s", err, sbportJSON(out))
	}
}

// ── sftp-action download with decryption (aes / rsa / pgp keys) ─────────────

func TestSbportSFTPCrypto(t *testing.T) {
	pid := sbportDB(t)
	dir := t.TempDir()
	mk := func(alg, pub, sec string) string {
		id := newCUID()
		if _, err := appExec(`INSERT INTO api_keys ("id","projectId","name","key","algorithm","publicKey","secretKey","keyCategory") VALUES ($1,$2,'t_sbport_k',$3,$4,$5,$6,'encryption-key')`, id, pid, "t_sbport_"+id, alg, pub, sec); err != nil {
			t.Fatal(err)
		}
		return id
	}
	raw := make([]byte, 32)
	rand.Read(raw)
	aesKey := mk("aes-256-gcm", base64.StdEncoding.EncodeToString(raw), `{"keyBase64":"`+base64.StdEncoding.EncodeToString(raw)+`"}`)
	rk, _ := rsa.GenerateKey(rand.Reader, 2048)
	pubDer, _ := x509.MarshalPKIXPublicKey(&rk.PublicKey)
	privDer, _ := x509.MarshalPKCS8PrivateKey(rk)
	rsaKey := mk("rsa", string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: pubDer})), string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: privDer})))
	ent, _ := openpgp.NewEntity("t", "", "t@example.invalid", nil)
	var pubA, secA bytes.Buffer
	w, _ := armor.Encode(&pubA, openpgp.PublicKeyType, nil)
	ent.Serialize(w)
	w.Close()
	w, _ = armor.Encode(&secA, openpgp.PrivateKeyType, nil)
	ent.SerializePrivate(w, nil)
	w.Close()
	pgpKey := mk("pgp", pubA.String(), secA.String())

	for _, k := range []string{aesKey, rsaKey, pgpKey} {
		p := filepath.Join(dir, "data-"+k+".csv")
		os.WriteFile(p, []byte("a,b\n1,2\n"), 0o644)
		enc, alg, err := sbEncryptFile(p, k)
		if err != nil {
			t.Fatal(alg, err)
		}
		os.Remove(p)
		out, alg2, err := sbDecryptFile(enc, k)
		if err != nil || out != p || alg2 != alg {
			t.Fatal(alg, err, out)
		}
		if b, _ := os.ReadFile(p); string(b) != "a,b\n1,2\n" {
			t.Fatal(alg, "roundtrip")
		}
		// fileDecrypt path (folder sync)
		key, _ := sbLoadKey(k)
		if alg != "aes-256-gcm" {
			ok, err := sbDecryptIfEncrypted(enc, p+".out", filepath.Base(enc), key)
			if err != nil || !ok {
				t.Fatal(alg, "decryptIfEncrypted", err)
			}
		}
	}
	// Wrong key → Node's GCM text
	other := make([]byte, 32)
	k2 := mk("aes-256-gcm", "", `{"keyBase64":"`+base64.StdEncoding.EncodeToString(other)+`"}`)
	p := filepath.Join(dir, "z.csv")
	os.WriteFile(p, []byte("z"), 0o644)
	enc, _, _ := sbEncryptFile(p, aesKey)
	if _, _, err := sbDecryptFile(enc, k2); err == nil || err.Error() != "Unsupported state or unable to authenticate data" {
		t.Fatal(err)
	}
	if _, _, err := sbDecryptFile(enc, "nope"); err == nil || err.Error() != "Encryption key not found: nope" {
		t.Fatal(err)
	}
}

// ── download-new-folders ────────────────────────────────────────────────────

func TestSbportFolderSync(t *testing.T) {
	pid := sbportDB(t)
	host, port := sbportSFTPServer(t)
	remote := t.TempDir()
	local := t.TempDir()
	cfg := map[string]any{"host": host, "port": float64(port), "username": "u", "password": "p", "basePath": "/"}
	r := sbportRun(t, cfg)
	os.MkdirAll(remote+"/SRC/2569-10-06", 0o755)
	os.MkdirAll(remote+"/SRC/2569-09-30", 0o755)
	os.WriteFile(remote+"/SRC/2569-10-06/a.csv", []byte("aaa"), 0o644)
	os.WriteFile(remote+"/SRC/2569-10-06/b.txt", []byte("bb"), 0o644)
	os.WriteFile(remote+"/SRC/2569-09-30/c.csv", []byte("c"), 0o644)
	land := sbportBasket(t, pid, "batch", local+"/land")
	fe := sbportBasket(t, pid, "shares", local+"/fe")

	node := sbportNode("sftp-action", `{"connectionId":"conn1","operation":"download","newFoldersOnly":true,"remotePath":"`+remote+`/SRC","filePattern":"*.CSV","basketId":"`+land+`","explorerBasketId":"`+fe+`","groupByFiscalYear":true,"startFromFolder":"2569-09-01"}`)
	out, err := execSFTPAction(r, node, sbportCtx(r, nil, nil))
	if err != nil {
		t.Fatal(err)
	}
	m := out.(map[string]any)
	if m["newFolderCount"] != float64(2) || sbportJSON(m["newFolderNames"]) != `["2569-09-30","2569-10-06"]` || m["fileExplorerFolder"] != "t_sbport_shares" {
		t.Fatalf("%s", sbportJSON(out))
	}
	nf := m["newFolders"].([]any)[1].(map[string]any)
	if nf["fiscalYear"] != "2570" || nf["fileExplorerPath"] != "t_sbport_shares/2570/2569-10-06" {
		t.Fatalf("%s", sbportJSON(nf))
	}
	if b, _ := os.ReadFile(sbJoin(local, "fe", "folders", "2570", "2569-10-06", "a.csv")); string(b) != "aaa" {
		t.Fatal("explorer copy")
	}
	if b, _ := os.ReadFile(sbJoin(local, "land", "sessions", "2569-10-06", "a.csv")); string(b) != "aaa" {
		t.Fatal("landing copy")
	}
	s, _ := sbOne(`SELECT "fileCount","totalSize" FROM processing_sessions WHERE "basketId"=$1 AND "batchName"='2569-10-06'`, land)
	if sbI(s, "fileCount") != 1 || sbI(s, "totalSize") != 3 {
		t.Fatal(s)
	}
	if m["summary"] != "2569-09-30 (1 files, 1 B)\n  - c.csv  1 B\n\n2569-10-06 (1 files, 3 B)\n  - a.csv  3 B" {
		t.Fatalf("%q", m["summary"])
	}
	out, _ = execSFTPAction(r, node, sbportCtx(r, nil, nil))
	if m := out.(map[string]any); m["hasNew"] != false || sbportJSON(m["upToDateFolders"]) != `["2569-09-30","2569-10-06"]` {
		t.Fatalf("%s", sbportJSON(out))
	}
	if len(r.logs) == 0 || !strings.HasPrefix(r.logs[0].Message, "2569-09-30: copying 1 of 1 file(s)") {
		t.Fatal(r.logs)
	}
}

// ── basket-action ───────────────────────────────────────────────────────────

func TestSbportBasketAction(t *testing.T) {
	pid := sbportDB(t)
	local := t.TempDir()
	r := sbportRun(t, nil)
	src := sbportBasket(t, pid, "batch", local+"/src")
	dst := sbportBasket(t, pid, "shares", local+"/dst")
	os.MkdirAll(local+"/src", 0o755)
	s1, _ := sbCreateSession(src, "t_sbport_s", 0, 0)
	for _, n := range []string{"a.TXT", "b.txt", "c.csv"} {
		os.WriteFile(local+"/src/"+n, []byte(n), 0o644)
		sbCreateFile(sbFileRow{BasketID: src, SessionID: sbS(s1, "id"), FileName: n, OriginalName: n, Size: int64(len(n)), MimeType: "x", Path: local + "/src/" + n, Status: "uploaded"})
	}
	node := sbportNode("basket-action", `{"operation":"copy-and-zip","sourceBasketId":"`+src+`","destinationBasketId":"`+dst+`","filePattern":"*.txt","targetFolder":"{BYYYY}/{{input.sub}}","zipFileName":"pack_{{fileName}}"}`)
	out, err := execBasketAction(r, node, sbportCtx(r, nil, map[string]any{"sub": "m1"}))
	if err != nil {
		t.Fatal(err)
	}
	m := out.(map[string]any)
	by := fmt.Sprint(time.Now().Year() + 543)
	if m["targetFolder"] != by+"/m1" || m["copied"].(map[string]any)["filesCopied"] != float64(2) || m["zip"].(map[string]any)["fileName"] != "pack_a.zip" || m["folderId"] == nil {
		t.Fatalf("%s", sbportJSON(out))
	}
	zr, err := zip.OpenReader(sbJoin(local, "dst", "folders", by, "m1", "pack_a.zip"))
	if err != nil || len(zr.File) != 2 {
		t.Fatal(err)
	}
	zr.Close()
	row, _ := sbOne(`SELECT "metadata" FROM basket_files WHERE "basketId"=$1 AND "fileName"='a.TXT'`, dst)
	if !strings.HasPrefix(sbS(row, "metadata"), `{"source":"basket-action","operation":"copy","sourceBasketId":"`+src+`","targetFolder":"`+by+`/m1","flowId":"op_sbport","copiedAt":"`) {
		t.Fatal(row)
	}
	folders, _ := appQuery(`SELECT "path" FROM basket_folders WHERE "basketId"=$1 ORDER BY "path"`, dst)
	if len(folders) != 2 || sbS(folders[1], "path") != by+"/m1" {
		t.Fatal(folders)
	}
	// Again: copy skips (overwrite unset), zip overwrites.
	out, _ = execBasketAction(r, node, sbportCtx(r, nil, map[string]any{"sub": "m1"}))
	if c := out.(map[string]any)["copied"].(map[string]any); c["filesSkipped"] != float64(2) {
		t.Fatalf("%s", sbportJSON(out))
	}

	// extract into a batch basket
	zp := filepath.Join(local, "dl.zip")
	sbportZip(t, zp, map[string]string{"x/r1.pdf": "p", "dir/": ""})
	ex := sbportBasket(t, pid, "batch", local+"/ex")
	out, err = execBasketAction(r, sbportNode("basket-action", `{"operation":"extract","destinationBasketId":"`+ex+`","sourceFilePath":"{{dl.localPath}}"}`), sbportCtx(r, map[string]any{"dl": map[string]any{"localPath": zp}}, nil))
	if err != nil {
		t.Fatal(err)
	}
	if m := out.(map[string]any); m["extracted"] != float64(1) || m["sessionId"] == nil {
		t.Fatalf("%s", sbportJSON(out))
	}
	f, _ := sbOne(`SELECT * FROM basket_files WHERE "basketId"=$1`, ex)
	if sbS(f, "mimeType") != "application/pdf" || sbS(f, "status") != "uploaded" || !strings.HasPrefix(sbS(f, "id"), "f") || sbS(f, "metadata") != `{"source":"basket-action-extract","zip":"dl.zip","entry":"x/r1.pdf"}` {
		t.Fatal(f)
	}
	if s, _ := sbOne(`SELECT "fileCount","batchName" FROM processing_sessions WHERE "basketId"=$1`, ex); sbI(s, "fileCount") != 1 || sbS(s, "batchName") == "" {
		t.Fatal(s)
	}
	if _, err := execBasketAction(r, sbportNode("basket-action", `{"operation":"extract","destinationBasketId":"`+ex+`","sourceFilePath":"/no/such.zip"}`), sbportCtx(r, nil, nil)); err == nil || err.Error() != "Source file not found: /no/such.zip" {
		t.Fatal(err)
	}
}
