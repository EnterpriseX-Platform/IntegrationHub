package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

// fioTestSFTPServer runs an in-process SSH/SFTP server (password "pw").
func fioTestSFTPServer(t *testing.T) (string, int) {
	_, key, _ := ed25519.GenerateKey(rand.Reader)
	signer, _ := ssh.NewSignerFromKey(key)
	cfg := &ssh.ServerConfig{PasswordCallback: func(c ssh.ConnMetadata, pw []byte) (*ssh.Permissions, error) {
		if c.User() == "u" && string(pw) == "pw" {
			return nil, nil
		}
		return nil, os.ErrPermission
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
			go func() {
				_, chans, reqs, err := ssh.NewServerConn(nc, cfg)
				if err != nil {
					return
				}
				go ssh.DiscardRequests(reqs)
				for nch := range chans {
					ch, creqs, _ := nch.Accept()
					go func() {
						for req := range creqs {
							ok := req.Type == "subsystem" && string(req.Payload[4:]) == "sftp"
							req.Reply(ok, nil)
							if ok {
								srv, _ := sftp.NewServer(ch)
								srv.Serve()
								ch.Close()
							}
						}
					}()
				}
			}()
		}
	}()
	addr := ln.Addr().(*net.TCPAddr)
	return addr.IP.String(), addr.Port
}

func TestFileportSFTP(t *testing.T) {
	host, port := fioTestSFTPServer(t)
	remote := t.TempDir()
	os.WriteFile(filepath.Join(remote, "a.csv"), []byte("k,v\n1,2\n"), 0o644)
	os.WriteFile(filepath.Join(remote, "b.csv"), []byte("k,v\n3,4\n"), 0o644)
	os.WriteFile(filepath.Join(remote, "c.txt"), []byte("x\n"), 0o644)

	conns := map[string]any{
		"ok":  map[string]any{"id": "ok", "name": "Test SFTP", "type": "sftp", "config": map[string]any{"host": host, "port": port, "username": "u", "password": "pw"}},
		"bad": map[string]any{"id": "bad", "name": "Bad", "type": "sftp", "config": `{"host":"` + host + `","port":` + strconv.Itoa(port) + `,"username":"u","password":"no"}`},
	}
	hs := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := strings.TrimPrefix(r.URL.Path, "/internal/engine/connection/")
		c, ok := conns[id]
		if !ok {
			json.NewEncoder(w).Encode(map[string]any{"error": "Connection not found: " + id})
			return
		}
		json.NewEncoder(w).Encode(c)
	}))
	defer hs.Close()

	exec := func(kind string, d map[string]any) (map[string]any, error) {
		req := &ExecuteRequest{Flow: Flow{OperationID: "op"}, CallbackURL: hs.URL + "/internal/engine/node"}
		r := newRun(req, func(map[string]any) {})
		ctx := &Ctx{ID: "c0", Input: map[string]any{"dir": remote}, Vars: map[string]any{"rows": []any{map[string]any{"k": "z"}}, "sub": "up"}, dirty: map[string]bool{}, run: r}
		var out any
		var err error
		if kind == "read" {
			out, err = execFileRead(r, &Node{ID: "n", Type: "file-read", Data: d}, ctx)
		} else {
			out, err = execFileWrite(r, &Node{ID: "n", Type: "file-write", Data: d}, ctx)
		}
		if err != nil {
			return nil, err
		}
		return out.(map[string]any), nil
	}

	out, err := exec("read", map[string]any{"source": "sftp", "sftpConnectionId": "ok", "sftpRemotePath": "{{input.dir}}", "filePattern": "*.csv", "parseAs": "csv"})
	if err != nil || out["filesFound"] != 2.0 {
		t.Fatalf("dir read: %v %v", out, err)
	}
	out, err = exec("read", map[string]any{"source": "sftp", "sftpConnectionId": "ok", "sftpRemotePath": filepath.Join(remote, "c.txt"), "parseAs": "txt"})
	if err != nil || out["data"].([]any)[0] != "x" {
		t.Fatalf("file read: %v %v", out, err)
	}
	_, err = exec("read", map[string]any{"source": "sftp", "sftpConnectionId": "ok", "sftpRemotePath": filepath.Join(remote, "nope.txt")})
	if err == nil || err.Error() != "Cannot read remote file "+filepath.Join(remote, "nope.txt")+": No such file" {
		t.Fatalf("missing file: %v", err)
	}
	_, err = exec("read", map[string]any{"source": "sftp", "sftpConnectionId": "bad", "sftpRemotePath": "/x.txt"})
	if err == nil || err.Error() != "All configured authentication methods failed" {
		t.Fatalf("bad auth: %v", err)
	}
	_, err = exec("read", map[string]any{"source": "sftp", "sftpConnectionId": "zzz", "sftpRemotePath": "/x.txt"})
	if err == nil || err.Error() != "Connection not found: zzz" {
		t.Fatalf("missing conn: %v", err)
	}

	wout, err := exec("write", map[string]any{"format": "csv", "destination": "sftp", "sftpConnectionId": "ok", "sftpRemotePath": filepath.Join(remote, "{{sub}}"), "fileName": "w_fileport.csv", "dataPath": "vars.rows"})
	if err != nil {
		t.Fatalf("sftp write: %v", err)
	}
	b, _ := os.ReadFile(filepath.Join(remote, "up", "w_fileport.csv"))
	if string(b) != "k\nz\n" || wout["connection"] != "Test SFTP" || wout["size"] != 4.0 || wout["remotePath"] != filepath.Join(remote, "up", "w_fileport.csv") {
		t.Fatalf("sftp write result %v %q", wout, b)
	}
	if _, err := os.Stat("/tmp/w_fileport.csv"); err == nil {
		t.Fatalf("temp file left behind")
	}
}
