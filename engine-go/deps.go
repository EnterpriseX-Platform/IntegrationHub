package main

// Keeps third-party packages the executors use in go.mod while they are being
// written. Remove an import here once a real file uses the package.
import (
	_ "github.com/ProtonMail/go-crypto/openpgp"
	_ "github.com/pkg/sftp"
	_ "github.com/sijms/go-ora/v2"
	_ "github.com/xuri/excelize/v2"
	_ "golang.org/x/crypto/ssh"
	_ "golang.org/x/text/encoding/charmap"
)
