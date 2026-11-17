package main

// SSH / SFTP connection for sftp-action, with the connect options the ssh2
// client gets in SFTPActionExecutor.ts and sftpFolderSync.ts, and error
// messages worded like ssh2's where the cause is the same.

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"math/big"
	"net"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"encoding/base64"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

type sbSFTP struct {
	conn   *ssh.Client
	client *sftp.Client
	stop   chan struct{}
}

func (s *sbSFTP) Close() {
	if s.stop != nil {
		close(s.stop)
		s.stop = nil
	}
	if s.client != nil {
		s.client.Close()
	}
	if s.conn != nil {
		s.conn.Close()
	}
}

type sbConnOpts struct {
	folderSync bool // sftpFolderSync's connect(): authType switch, passphrase, keepalive
}

// sbConnect opens an SSH connection and an SFTP session.
//
// SFTPActionExecutor: password and privateKey are both passed when present.
// sftpFolderSync: password unless authType is 'private-key', privateKey (and
// passphrase) only when it is; keepaliveInterval 15000.
func sbConnect(config map[string]any, o sbConnOpts) (*sbSFTP, error) {
	host := sbStrOf(config["host"])
	port := "22"
	if truthy(config["port"]) {
		port = sbStrOf(config["port"])
	}
	cfg := &ssh.ClientConfig{
		User:            sbStrOf(config["username"]),
		HostKeyCallback: ssh.InsecureIgnoreHostKey(),
	}
	authType := sbStrOf(config["authType"])
	usePassword := true
	useKey := true
	if o.folderSync {
		usePassword = authType != "private-key"
		useKey = authType == "private-key"
	}
	if pw, ok := config["password"].(string); ok && usePassword {
		cfg.Auth = append(cfg.Auth, ssh.Password(pw))
	}
	if useKey && truthy(config["privateKey"]) {
		keyText, err := sbNormalizePrivateKey(sbStrOf(config["privateKey"]))
		if err != nil {
			return nil, err
		}
		var signer ssh.Signer
		pass := ""
		if o.folderSync {
			pass = sbStrOf(config["passphrase"])
		}
		if pass != "" {
			signer, err = ssh.ParsePrivateKeyWithPassphrase([]byte(keyText), []byte(pass))
		} else {
			signer, err = ssh.ParsePrivateKey([]byte(keyText))
		}
		if err != nil {
			var pm *ssh.PassphraseMissingError
			if errors.As(err, &pm) {
				return nil, errors.New("Encrypted private OpenSSH key detected, but no passphrase given")
			}
			if errors.Is(err, x509IncorrectPassword) || strings.Contains(err.Error(), "decryption password incorrect") {
				return nil, errors.New("Failed to generate information to decrypt key")
			}
			return nil, errors.New("Cannot parse privateKey: Unsupported key format")
		}
		cfg.Auth = append(cfg.Auth, ssh.PublicKeys(signer))
	}

	// readyTimeout: 20000 covers TCP connect + handshake + auth in ssh2.
	deadline := time.Now().Add(20 * time.Second)
	addr := net.JoinHostPort(host, port)
	raw, err := net.DialTimeout("tcp", addr, 20*time.Second)
	if err != nil {
		return nil, sbNetErr(err, host, port)
	}
	_ = raw.SetDeadline(deadline)
	c, chans, reqs, err := ssh.NewClientConn(raw, addr, cfg)
	if err != nil {
		raw.Close()
		var ne net.Error
		if errors.As(err, &ne) && ne.Timeout() {
			return nil, errors.New("Timed out while waiting for handshake")
		}
		if strings.Contains(err.Error(), "unable to authenticate") {
			return nil, errors.New("All configured authentication methods failed")
		}
		if errors.Is(err, io.EOF) || strings.Contains(err.Error(), "connection reset") {
			return nil, sbNetErr(err, host, port)
		}
		return nil, err
	}
	_ = raw.SetDeadline(time.Time{})
	client := ssh.NewClient(c, chans, reqs)
	sc, err := sftp.NewClient(client, sftp.UseConcurrentReads(true), sftp.UseConcurrentWrites(true))
	if err != nil {
		client.Close()
		return nil, err
	}
	s := &sbSFTP{conn: client, client: sc}
	if o.folderSync {
		s.stop = make(chan struct{})
		go func(stop chan struct{}) {
			t := time.NewTicker(15 * time.Second)
			defer t.Stop()
			missed := 0
			for {
				select {
				case <-stop:
					return
				case <-t.C:
					if _, _, err := client.SendRequest("keepalive@openssh.com", true, nil); err != nil {
						missed++
						if missed >= 3 { // ssh2 keepaliveCountMax
							client.Close()
							return
						}
					} else {
						missed = 0
					}
				}
			}
		}(s.stop)
	}
	return s, nil
}

var x509IncorrectPassword = errors.New("x509: decryption password incorrect")

// sbNetErr words a dial error like Node's net module.
func sbNetErr(err error, host, port string) error {
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) {
		return fmt.Errorf("getaddrinfo ENOTFOUND %s", host)
	}
	ip := host
	if ips, e := net.LookupHost(host); e == nil && len(ips) > 0 {
		ip = ips[0]
	}
	msg := err.Error()
	switch {
	case strings.Contains(msg, "connection refused"):
		return fmt.Errorf("connect ECONNREFUSED %s:%s", ip, port)
	case strings.Contains(msg, "connection reset"):
		return errors.New("read ECONNRESET")
	case strings.Contains(msg, "timeout") || strings.Contains(msg, "timed out"):
		return errors.New("Timed out while waiting for handshake")
	case strings.Contains(msg, "no route to host"):
		return fmt.Errorf("connect EHOSTUNREACH %s:%s", ip, port)
	case strings.Contains(msg, "network is unreachable"):
		return fmt.Errorf("connect ENETUNREACH %s:%s", ip, port)
	case errors.Is(err, io.EOF):
		return errors.New("Connection lost before handshake")
	}
	return err
}

// ssh2's SFTP status texts (used when the server sends no message).
var sbSFTPStatus = map[uint32]string{
	1: "End of file", 2: "No such file", 3: "Permission denied", 4: "Failure",
	5: "Bad message", 6: "No connection", 7: "Connection lost", 8: "Operation unsupported",
}

var sbStatusRe = regexp.MustCompile(`^sftp: ("(?:[^"\\]|\\.)*") \(`)

// sbSFTPErr words an SFTP error like ssh2: the server's status message.
func sbSFTPErr(err error) error {
	if err == nil {
		return nil
	}
	var se *sftp.StatusError
	if errors.As(err, &se) {
		if m := sbStatusRe.FindStringSubmatch(se.Error()); m != nil {
			if msg, e := strconv.Unquote(m[1]); e == nil && msg != "" {
				return errors.New(msg)
			}
		}
		if t, ok := sbSFTPStatus[se.Code]; ok {
			return errors.New(t)
		}
		return errors.New("Unknown status")
	}
	// pkg/sftp turns NO_SUCH_FILE / PERMISSION_DENIED into os errors.
	if errors.Is(err, fs.ErrNotExist) {
		var pe *fs.PathError
		if errors.As(err, &pe) && !strings.HasPrefix(pe.Op, "sftp") {
			return err
		}
		return errors.New("No such file")
	}
	if errors.Is(err, fs.ErrPermission) {
		return errors.New("Permission denied")
	}
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
		return errors.New("No response from server")
	}
	return err
}

// sbFastGet ports sftp.fastGet(remote, local): the whole remote file into a
// local file (created or truncated).
func (s *sbSFTP) sbFastGet(remote, local string) error {
	rf, err := s.client.Open(remote)
	if err != nil {
		return sbSFTPErr(err)
	}
	defer rf.Close()
	lf, err := os.OpenFile(local, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o666)
	if err != nil {
		return sbFsErr(err, "open", local)
	}
	if _, err := rf.WriteTo(lf); err != nil {
		lf.Close()
		return sbSFTPErr(err)
	}
	if err := lf.Close(); err != nil {
		return sbFsErr(err, "close", local)
	}
	return nil
}

type sbRemoteEntry struct {
	Name  string
	Size  int64
	Mtime int64 // seconds, 0 = unknown
	Mode  uint32
}

func (e sbRemoteEntry) isFile() bool { return e.Mode&0o170000 == 0o100000 }
func (e sbRemoteEntry) isDir() bool  { return e.Mode&0o170000 == 0o040000 }

// sbReadDir ports sftp.readdir: entries in server order, without . and ..
func (s *sbSFTP) sbReadDir(dir string) ([]sbRemoteEntry, error) {
	list, err := s.client.ReadDir(dir)
	if err != nil {
		return nil, sbSFTPErr(err)
	}
	out := make([]sbRemoteEntry, 0, len(list))
	for _, fi := range list {
		e := sbRemoteEntry{Name: fi.Name(), Size: fi.Size()}
		if st, ok := fi.Sys().(*sftp.FileStat); ok {
			e.Mtime = int64(st.Mtime)
			e.Mode = st.Mode
		} else {
			e.Mtime = fi.ModTime().Unix()
			e.Mode = sbGoModeToUnix(fi.Mode())
		}
		out = append(out, e)
	}
	return out, nil
}

func sbGoModeToUnix(m fs.FileMode) uint32 {
	switch {
	case m.IsDir():
		return 0o040000 | uint32(m.Perm())
	case m&fs.ModeSymlink != 0:
		return 0o120000 | uint32(m.Perm())
	case m.IsRegular():
		return 0o100000 | uint32(m.Perm())
	}
	return uint32(m.Perm())
}

// ── PPK → PEM (port of server/src/lib/ppk-converter.ts) ─────────────────────

func sbNormalizePrivateKey(key string) (string, error) {
	if strings.TrimSpace(key) == "" {
		return key, nil
	}
	trimmed := strings.TrimSpace(key)
	if strings.HasPrefix(trimmed, "-----BEGIN") {
		return trimmed, nil
	}
	if strings.HasPrefix(strings.TrimLeft(trimmed, " \t\r\n"), "PuTTY-User-Key-File-") {
		pemText, err := sbConvertPPK(trimmed)
		if err != nil {
			log.Printf("[PPK Converter] Failed to convert PPK: %s", err.Error())
			return "", err
		}
		log.Printf("[PPK Converter] Successfully converted PPK v2 to PEM format")
		return pemText, nil
	}
	return trimmed, nil
}

var (
	sbPPKHeader  = regexp.MustCompile(`^PuTTY-User-Key-File-(\d+):\s*(.+)`)
	sbPPKEnc     = regexp.MustCompile(`^Encryption:\s*(.+)`)
	sbPPKComment = regexp.MustCompile(`^Comment:\s*(.*)`)
	sbPPKPub     = regexp.MustCompile(`^Public-Lines:\s*(\d+)`)
	sbPPKPriv    = regexp.MustCompile(`^Private-Lines:\s*(\d+)`)
)

func sbConvertPPK(content string) (string, error) {
	lines := regexp.MustCompile(`\r?\n`).Split(content, -1)
	line := func(i int) string {
		if i < len(lines) {
			return lines[i]
		}
		return ""
	}
	i := 0
	h := sbPPKHeader.FindStringSubmatch(line(i))
	if h == nil {
		return "", errors.New("Invalid PPK format: missing header")
	}
	version, _ := strconv.Atoi(h[1])
	keyType := strings.TrimSpace(h[2])
	i++
	if version != 2 {
		return "", fmt.Errorf("PPK version %d is not supported. Only PPK v2 is supported.", version)
	}
	e := sbPPKEnc.FindStringSubmatch(line(i))
	if e == nil {
		return "", errors.New("Invalid PPK format: missing Encryption")
	}
	encryption := strings.TrimSpace(e[1])
	i++
	if sbPPKComment.FindStringSubmatch(line(i)) == nil {
		return "", errors.New("Invalid PPK format: missing Comment")
	}
	i++
	pl := sbPPKPub.FindStringSubmatch(line(i))
	if pl == nil {
		return "", errors.New("Invalid PPK format: missing Public-Lines")
	}
	i++
	n, _ := strconv.Atoi(pl[1])
	var pub strings.Builder
	for j := 0; j < n; j++ {
		pub.WriteString(line(i))
		i++
	}
	vl := sbPPKPriv.FindStringSubmatch(line(i))
	if vl == nil {
		return "", errors.New("Invalid PPK format: missing Private-Lines")
	}
	i++
	n, _ = strconv.Atoi(vl[1])
	var priv strings.Builder
	for j := 0; j < n; j++ {
		priv.WriteString(line(i))
		i++
	}
	if encryption != "none" {
		return "", errors.New("Encrypted PPK keys are not supported. Please decrypt the key first using PuTTYgen " +
			"(load key → set empty passphrase → save private key), or export as OpenSSH format.")
	}
	if keyType != "ssh-rsa" {
		return "", fmt.Errorf("PPK key type \"%s\" conversion is not yet supported. "+
			"Please export the key to OpenSSH format using PuTTYgen (Conversions → Export OpenSSH key).", keyType)
	}
	pubB := sbB64(pub.String())
	privB := sbB64(priv.String())
	rd := func(b []byte, off int) ([]byte, int, error) {
		if off+4 > len(b) {
			return nil, off, fmt.Errorf("The value of \"offset\" is out of range. It must be >= 0 and <= %d. Received %d", len(b)-4, off)
		}
		l := int(uint32(b[off])<<24 | uint32(b[off+1])<<16 | uint32(b[off+2])<<8 | uint32(b[off+3]))
		end := off + 4 + l
		if end > len(b) {
			end = len(b)
		}
		return b[off+4 : end], off + 4 + l, nil
	}
	var err error
	off := 0
	_, off, err = rd(pubB, off)
	if err != nil {
		return "", err
	}
	eB, off, err := rd(pubB, off)
	if err != nil {
		return "", err
	}
	nB, _, err := rd(pubB, off)
	if err != nil {
		return "", err
	}
	off = 0
	dB, off, err := rd(privB, off)
	if err != nil {
		return "", err
	}
	pB, off, err := rd(privB, off)
	if err != nil {
		return "", err
	}
	qB, off, err := rd(privB, off)
	if err != nil {
		return "", err
	}
	iqmpB, _, err := rd(privB, off)
	if err != nil {
		return "", err
	}
	d := new(big.Int).SetBytes(dB)
	p := new(big.Int).SetBytes(pB)
	q := new(big.Int).SetBytes(qB)
	one := big.NewInt(1)
	dp := new(big.Int).Mod(d, new(big.Int).Sub(p, one))
	dq := new(big.Int).Mod(d, new(big.Int).Sub(q, one))
	toBuf := func(x *big.Int) []byte {
		if x.Sign() == 0 {
			return []byte{0}
		}
		b := x.Bytes()
		if b[0]&0x80 != 0 {
			b = append([]byte{0}, b...)
		}
		return b
	}
	derLen := func(l int) []byte {
		switch {
		case l < 0x80:
			return []byte{byte(l)}
		case l < 0x100:
			return []byte{0x81, byte(l)}
		case l < 0x10000:
			return []byte{0x82, byte(l >> 8), byte(l)}
		}
		return []byte{0x83, byte(l >> 16), byte(l >> 8), byte(l)}
	}
	derInt := func(v []byte) []byte {
		if len(v) > 0 && v[0]&0x80 != 0 {
			v = append([]byte{0}, v...)
		}
		out := append([]byte{0x02}, derLen(len(v))...)
		return append(out, v...)
	}
	var seq []byte
	for _, part := range [][]byte{{0}, nB, eB, dB, pB, qB, toBuf(dp), toBuf(dq), iqmpB} {
		seq = append(seq, derInt(part)...)
	}
	der := append(append([]byte{0x30}, derLen(len(seq))...), seq...)
	b64 := base64.StdEncoding.EncodeToString(der)
	out := []string{"-----BEGIN RSA PRIVATE KEY-----"}
	for k := 0; k < len(b64); k += 64 {
		end := k + 64
		if end > len(b64) {
			end = len(b64)
		}
		out = append(out, b64[k:end])
	}
	out = append(out, "-----END RSA PRIVATE KEY-----", "")
	return strings.Join(out, "\n"), nil
}

// sbB64 decodes base64 like Node's Buffer.from(s, 'base64'): it skips
// characters outside the alphabet, accepts url-safe chars and stops at '='.
func sbB64(s string) []byte {
	var clean []byte
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'A' && c <= 'Z', c >= 'a' && c <= 'z', c >= '0' && c <= '9', c == '+', c == '/':
			clean = append(clean, c)
		case c == '-':
			clean = append(clean, '+')
		case c == '_':
			clean = append(clean, '/')
		case c == '=':
			i = len(s)
		}
	}
	if len(clean)%4 == 1 {
		clean = clean[:len(clean)-1]
	}
	b, _ := base64.RawStdEncoding.DecodeString(string(clean))
	return b
}
