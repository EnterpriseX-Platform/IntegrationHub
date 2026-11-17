package main

// SSH/SFTP connection for the file executors, configured like the ssh2
// Client in FileReadExecutor / FileWriteExecutor: host, port (default 22),
// username, privateKey or else password, readyTimeout 20 s, any host key.
// Errors are worded like ssh2's.

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

type fioSFTP struct {
	ssh    *ssh.Client
	client *sftp.Client
}

func (s *fioSFTP) Close() {
	if s.client != nil {
		s.client.Close()
	}
	if s.ssh != nil {
		s.ssh.Close()
	}
}

// fioConnection loads a stored connection (prisma.connection.findUnique) and
// its parsed config.
func fioConnection(r *Run, id string) (map[string]any, map[string]any, error) {
	conn, err := r.fallback.connection(id)
	if err != nil {
		return nil, nil, err
	}
	cfg := map[string]any{}
	switch c := conn["config"].(type) {
	case map[string]any:
		cfg = c
	case string:
		if err := json.Unmarshal([]byte(c), &cfg); err != nil {
			return nil, nil, err
		}
	}
	return conn, cfg, nil
}

func fioSFTPConnect(cfg map[string]any) (*fioSFTP, error) {
	host := fioStr(cfg["host"])
	if cfg["host"] == nil {
		host = "localhost"
	}
	port := 22
	if p, ok := num(cfg, "port"); ok && p != 0 {
		port = int(p)
	}
	user := ""
	if u, ok := cfg["username"].(string); ok {
		user = u
	}
	var auth []ssh.AuthMethod
	if pk := cfg["privateKey"]; fioTruthy(pk) {
		signer, err := ssh.ParsePrivateKey([]byte(fioStr(pk)))
		if err != nil {
			return nil, fmt.Errorf("Cannot parse privateKey: %s", fioSSHKeyErr(err))
		}
		auth = append(auth, ssh.PublicKeys(signer))
	} else if pw := cfg["password"]; fioTruthy(pw) {
		auth = append(auth, ssh.Password(fioStr(pw)))
	}
	conf := &ssh.ClientConfig{
		User:            user,
		Auth:            auth,
		HostKeyCallback: ssh.InsecureIgnoreHostKey(),
		Timeout:         20 * time.Second,
	}
	addr := net.JoinHostPort(host, strconv.Itoa(port))
	dialer := net.Dialer{Timeout: 20 * time.Second}
	nc, err := dialer.Dial("tcp", addr)
	if err != nil {
		return nil, fioNetErr(err, host, port)
	}
	_ = nc.SetDeadline(time.Now().Add(20 * time.Second))
	c, chans, reqs, err := ssh.NewClientConn(nc, addr, conf)
	if err != nil {
		nc.Close()
		var ne net.Error
		if errors.As(err, &ne) && ne.Timeout() {
			return nil, errors.New("Timed out while waiting for handshake")
		}
		if strings.Contains(err.Error(), "unable to authenticate") {
			return nil, errors.New("All configured authentication methods failed")
		}
		return nil, err
	}
	_ = nc.SetDeadline(time.Time{})
	sc := ssh.NewClient(c, chans, reqs)
	cl, err := sftp.NewClient(sc)
	if err != nil {
		sc.Close()
		return nil, err
	}
	return &fioSFTP{ssh: sc, client: cl}, nil
}

func fioSSHKeyErr(err error) string {
	if strings.Contains(err.Error(), "passphrase") {
		return "Encrypted private OpenSSH key detected, but no passphrase given"
	}
	return "Unsupported key format"
}

func fioNetErr(err error, host string, port int) error {
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) {
		return fmt.Errorf("getaddrinfo ENOTFOUND %s", host)
	}
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		return errors.New("Timed out while waiting for handshake")
	}
	ip := host
	var oe *net.OpError
	if errors.As(err, &oe) && oe.Addr != nil {
		if ta, ok := oe.Addr.(*net.TCPAddr); ok {
			ip = ta.IP.String()
		}
	}
	for errno, code := range map[syscall.Errno]string{syscall.ECONNREFUSED: "ECONNREFUSED", syscall.EHOSTUNREACH: "EHOSTUNREACH", syscall.ENETUNREACH: "ENETUNREACH", syscall.ECONNRESET: "ECONNRESET", syscall.ETIMEDOUT: "ETIMEDOUT"} {
		if errors.Is(err, errno) {
			return fmt.Errorf("connect %s %s:%d", code, ip, port)
		}
	}
	return err
}

var fioSFTPMsg = regexp.MustCompile(`^sftp: "(.*)" \(`)

// fioSFTPErr words an SFTP status error like ssh2 (the server's message, or
// ssh2's text for the status code).
func fioSFTPErr(err error) error {
	if err == nil {
		return nil
	}
	var se *sftp.StatusError
	if errors.As(err, &se) {
		if m := fioSFTPMsg.FindStringSubmatch(se.Error()); m != nil && m[1] != "" {
			return errors.New(m[1])
		}
		switch se.FxCode() {
		case sftp.ErrSSHFxEOF:
			return errors.New("End of file")
		case sftp.ErrSSHFxNoSuchFile:
			return errors.New("No such file")
		case sftp.ErrSSHFxPermissionDenied:
			return errors.New("Permission denied")
		case sftp.ErrSSHFxFailure:
			return errors.New("Failure")
		case sftp.ErrSSHFxBadMessage:
			return errors.New("Bad message")
		case sftp.ErrSSHFxNoConnection:
			return errors.New("No connection")
		case sftp.ErrSSHFxConnectionLost:
			return errors.New("Connection lost")
		case sftp.ErrSSHFxOpUnsupported:
			return errors.New("Operation unsupported")
		}
		return errors.New("Unknown status")
	}
	if errors.Is(err, os.ErrNotExist) {
		return errors.New("No such file")
	}
	if errors.Is(err, os.ErrPermission) {
		return errors.New("Permission denied")
	}
	return err
}
