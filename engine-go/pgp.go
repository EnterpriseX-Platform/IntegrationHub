package main

// Port of server/src/sdk/execution/executors/FileEncryptExecutor.ts and
// FileDecryptExecutor.ts (plus lib/rsaKeys.ts loadRsaPrivateKey). Keys come
// from api_keys (Secrets Vault); algorithms: pgp, rsa (hybrid RSA-OAEP +
// AES-256-GCM), rsa-direct, aes-{128,192,256}-{gcm,cbc}. File formats are
// byte-compatible with the Node implementation.

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/ProtonMail/go-crypto/openpgp"
	"github.com/ProtonMail/go-crypto/openpgp/armor"
	"github.com/ProtonMail/go-crypto/openpgp/packet"
)

func init() {
	nativeExecutors["file-encrypt"] = execFileEncrypt
	nativeExecutors["file-decrypt"] = execFileDecrypt
}

var pxRSAHybridMagic = []byte("RSAH")

const pxRSAHybridVersion = 1

type pxKeyRecord struct {
	name, algorithm, publicKey, secretKey string
	hasPublic, hasSecret                  bool
}

func pxLoadKey(id string) (*pxKeyRecord, error) {
	rows, err := appQuery(`SELECT name, algorithm, "publicKey", "secretKey" FROM api_keys WHERE id = $1`, id)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, fmt.Errorf("Encryption key not found: %s", id)
	}
	row := rows[0]
	k := &pxKeyRecord{}
	k.name, _ = row["name"].(string)
	k.algorithm, _ = row["algorithm"].(string)
	k.publicKey, _ = row["publicKey"].(string)
	k.secretKey, _ = row["secretKey"].(string)
	k.hasPublic, k.hasSecret = k.publicKey != "", k.secretKey != ""
	return k, nil
}

type pxFile struct {
	path string
	size int64
}

func execFileEncrypt(r *Run, node *Node, ctx *Ctx) (any, error) { return pxCrypt(r, node, ctx, true) }
func execFileDecrypt(r *Run, node *Node, ctx *Ctx) (any, error) { return pxCrypt(r, node, ctx, false) }

func pxCrypt(r *Run, node *Node, ctx *Ctx, encrypt bool) (any, error) {
	d := node.Data
	keyID := str(d, "encryptionKeyId")
	if keyID == "" {
		return nil, errors.New("Encryption key ID is required")
	}
	key, err := pxLoadKey(keyID)
	if err != nil {
		return nil, err
	}
	if encrypt && !key.hasPublic {
		return nil, fmt.Errorf("Public key not set for key: %s", key.name)
	}
	if !encrypt && !key.hasSecret {
		return nil, fmt.Errorf("Private/secret key not set for key: %s. Cannot decrypt with imported public keys.", key.name)
	}
	algorithm := key.algorithm
	if algorithm == "" {
		algorithm = "pgp"
	}
	armored := d["armor"] != false

	files, err := pxResolveInputFiles(d, ctx)
	if err != nil {
		return nil, err
	}
	verb, past, prefix := "Encrypting", "Encrypted", "encrypt"
	if !encrypt {
		verb, past, prefix = "Decrypting", "Decrypted", "decrypt"
	}
	if len(files) == 0 {
		return nil, fmt.Errorf("No files found to %s", prefix)
	}
	tmpDir := fmt.Sprintf("/tmp/%s-%d", prefix, time.Now().UnixMilli())
	if err := os.MkdirAll(tmpDir, 0o755); err != nil {
		return nil, err
	}

	out := []any{}
	for _, f := range files {
		fileName := filepath.Base(f.path)
		outName, err := pxOutputFileName(d, fileName, algorithm, ctx, encrypt)
		if err != nil {
			return nil, err
		}
		outPath := filepath.Join(tmpDir, outName)
		r.log("info", node.ID, fmt.Sprintf("%s %s (%sMB) with %s", verb, fileName, pxToFixed(float64(f.size)/1024/1024, 1), strings.ToUpper(algorithm)), nil)

		if encrypt {
			switch algorithm {
			case "pgp":
				err = pxEncryptPGP(f.path, outPath, key.publicKey, armored)
			case "rsa":
				err = pxEncryptRSAHybrid(f.path, outPath, key.publicKey)
			case "rsa-direct":
				err = pxEncryptRSADirect(f.path, outPath, key.publicKey)
			case "aes-128-gcm", "aes-192-gcm", "aes-256-gcm", "aes-128-cbc", "aes-192-cbc", "aes-256-cbc":
				err = pxEncryptAES(f.path, outPath, key.publicKey, algorithm)
			default:
				err = fmt.Errorf("Unsupported algorithm: %s", algorithm)
			}
		} else {
			pass := str(d, "passphrase")
			switch algorithm {
			case "pgp":
				err = pxDecryptPGP(f.path, outPath, key.secretKey, key.publicKey, pass)
			case "rsa", "rsa-direct":
				var pk *rsa.PrivateKey
				if pk, err = pxLoadRSAPrivateKey(key.secretKey, pass); err == nil {
					if algorithm == "rsa" {
						err = pxDecryptRSAHybrid(f.path, outPath, pk)
					} else {
						err = pxDecryptRSADirect(f.path, outPath, pk)
					}
				}
			case "aes-128-gcm", "aes-192-gcm", "aes-256-gcm", "aes-128-cbc", "aes-192-cbc", "aes-256-cbc":
				err = pxDecryptAES(f.path, outPath, key.secretKey, algorithm)
			default:
				err = fmt.Errorf("Unsupported algorithm: %s", algorithm)
			}
		}
		if err != nil {
			return nil, err
		}
		st, err := os.Stat(outPath)
		if err != nil {
			return nil, pxFsErr(err, "stat", outPath)
		}
		if str(d, "outputDestination") == "basket" && str(d, "outputBasketId") != "" {
			meta := `{"encrypted":true}`
			if !encrypt {
				meta = `{"decrypted":true}`
			}
			if err := pxWriteToBasket(outPath, outName, str(d, "outputBasketId"), st.Size(), meta); err != nil {
				return nil, err
			}
		}
		out = append(out, om(
			"fileName", outName, "originalFileName", fileName, "path", outPath,
			"size", float64(st.Size()), "algorithm", algorithm,
		))
	}
	r.log("info", node.ID, fmt.Sprintf("%s %d file(s) with %s", past, len(out), strings.ToUpper(algorithm)), nil)
	return om("files", out, "filesProcessed", float64(len(out)), "algorithm", algorithm, "timestamp", isoNow()), nil
}

// ── file naming ──────────────────────────────────────────────────────────────

func pxOutputFileName(d map[string]any, original, algorithm string, ctx *Ctx, encrypt bool) (string, error) {
	tmpl := str(d, "outputFileName")
	if tmpl == "" {
		if encrypt {
			if algorithm == "pgp" {
				return original + ".pgp", nil
			}
			return original + ".enc", nil
		}
		ext := strings.ToLower(pxExtname(original))
		switch ext {
		case ".pgp", ".gpg", ".enc", ".encrypted", ".aes":
			return original[:len(original)-len(ext)], nil
		}
		return original + ".decrypted", nil
	}
	ext := pxExtname(original)
	resolved := strings.ReplaceAll(tmpl, "{{input.fileName}}", original)
	resolved = strings.ReplaceAll(resolved, "{{fileName}}", original)
	resolved = strings.ReplaceAll(resolved, "{{baseName}}", pxBasename(original, ext))
	resolved = strings.ReplaceAll(resolved, "{{ext}}", ext)
	if strings.Contains(resolved, "{{") {
		v := ctx.resolveTemplate(resolved)
		s, ok := v.(string)
		if !ok {
			if v == nil {
				return "", errors.New(`The "path" argument must be of type string. Received undefined`)
			}
			return "", fmt.Errorf(`The "path" argument must be of type string. Received %s`, pxNodeReceived(v))
		}
		resolved = s
	}
	return resolved, nil
}

func pxNodeReceived(v any) string {
	switch t := v.(type) {
	case float64:
		return "type number (" + jsNumber(t) + ")"
	case bool:
		return "type boolean (" + jsString(t) + ")"
	case []any:
		return "an instance of Array"
	}
	return "an instance of Object"
}

// pxExtname is Node's path.extname.
func pxExtname(p string) string {
	base := p
	if i := strings.LastIndex(base, "/"); i >= 0 {
		base = base[i+1:]
	}
	i := strings.LastIndex(base, ".")
	if i <= 0 {
		return ""
	}
	if strings.Trim(base[:i], ".") == "" && i == len(base)-1 {
		return "" // ".." style names
	}
	return base[i:]
}

// pxBasename is Node's path.basename(p, ext).
func pxBasename(p, ext string) string {
	b := filepath.Base(p)
	if ext != "" && b != ext && strings.HasSuffix(b, ext) {
		return b[:len(b)-len(ext)]
	}
	return b
}

// pxToFixed is JavaScript's Number.prototype.toFixed (ties round up).
func pxToFixed(x float64, digits int) string {
	if math.IsNaN(x) {
		return "NaN"
	}
	s := strconv.FormatFloat(math.Abs(x), 'f', 40, 64)
	dot := strings.IndexByte(s, '.')
	keep := []byte(s[:dot] + s[dot+1:dot+1+digits])
	if s[dot+1+digits] >= '5' {
		for i := len(keep) - 1; i >= 0; i-- {
			if keep[i] == '9' {
				keep[i] = '0'
				if i == 0 {
					keep = append([]byte{'1'}, keep...)
				}
				continue
			}
			keep[i]++
			break
		}
	}
	intLen := len(keep) - digits
	res := string(keep[:intLen])
	if digits > 0 {
		res += "." + string(keep[intLen:])
	}
	if x < 0 && strings.Trim(res, "0.") != "" {
		res = "-" + res
	}
	return res
}

// ── input files ──────────────────────────────────────────────────────────────

func pxResolveInputFiles(d map[string]any, ctx *Ctx) ([]pxFile, error) {
	switch str(d, "source") {
	case "basket":
		return pxBasketFiles(d, ctx)
	case "local":
		return pxLocalFiles(d, ctx)
	}
	return pxInputFiles(ctx), nil
}

func pxExists(p string) bool {
	if p == "" {
		return false
	}
	_, err := os.Stat(p)
	return err == nil
}

func pxSize(p string) int64 {
	st, err := os.Stat(p)
	if err != nil {
		return 0
	}
	return st.Size()
}

var pxWholeVar = regexp.MustCompile(`^\{\{(.+?)\}\}$`)

func pxPatternRegex(pattern string) (*regexp.Regexp, error) {
	src := "^" + strings.ReplaceAll(strings.ReplaceAll(pattern, ".", `\.`), "*", ".*") + "$"
	re, err := regexp.Compile(src)
	if err != nil {
		return nil, fmt.Errorf("Invalid regular expression: /%s/: %s", src, err.Error())
	}
	return re, nil
}

func pxBasketFiles(d map[string]any, ctx *Ctx) ([]pxFile, error) {
	basketID := str(d, "basketId")
	if basketID == "" {
		return nil, errors.New("Basket ID is required for basket source")
	}
	pattern := str(d, "filePattern")
	if pattern == "" {
		pattern = "*.*"
	}
	if m := pxWholeVar.FindStringSubmatch(pattern); m != nil {
		if item, ok := ctx.Vars[m[1]].(map[string]any); ok && truthy(item["path"]) {
			p, isStr := item["path"].(string)
			if !isStr {
				return nil, errors.New("loopItem.path.startsWith is not a function")
			}
			if !strings.HasPrefix(p, "/") {
				p = "/" + p
			}
			if pxExists(p) {
				return []pxFile{{p, pxSize(p)}}, nil
			}
		}
	}
	re, err := pxPatternRegex(pattern)
	if err != nil {
		return nil, err
	}
	rows, err := appQuery(`SELECT "fileName", path, size FROM basket_files WHERE "basketId" = $1 AND status IN ('open','active','uploaded','published') ORDER BY "createdAt" DESC`, basketID)
	if err != nil {
		return nil, err
	}
	out := []pxFile{}
	for _, row := range rows {
		name, _ := row["fileName"].(string)
		if !re.MatchString(name) {
			continue
		}
		p, _ := row["path"].(string)
		if !strings.HasPrefix(p, "/") {
			p = "/" + p
		}
		if pxExists(p) {
			out = append(out, pxFile{p, pxInt64(row["size"])})
		}
	}
	return out, nil
}

func pxInt64(v any) int64 {
	switch t := v.(type) {
	case int32:
		return int64(t)
	case int64:
		return t
	case int:
		return int64(t)
	case float64:
		return int64(t)
	}
	return 0
}

func pxLocalFiles(d map[string]any, ctx *Ctx) ([]pxFile, error) {
	p := ""
	if lp := str(d, "localPath"); lp != "" {
		p, _ = ctx.resolveTemplate(lp).(string)
	}
	if !pxExists(p) {
		return []pxFile{}, nil
	}
	st, _ := os.Stat(p)
	if st.IsDir() {
		pattern := str(d, "filePattern")
		if pattern == "" {
			pattern = "*.*"
		}
		re, err := pxPatternRegex(pattern)
		if err != nil {
			return nil, err
		}
		entries, err := os.ReadDir(p)
		if err != nil {
			return nil, pxFsErr(err, "scandir", p)
		}
		out := []pxFile{}
		for _, e := range entries {
			if re.MatchString(e.Name()) {
				full := filepath.Join(p, e.Name())
				out = append(out, pxFile{full, pxSize(full)})
			}
		}
		return out, nil
	}
	return []pxFile{{p, st.Size()}}, nil
}

func pxInputFiles(ctx *Ctx) []pxFile {
	in, _ := ctx.Input.(map[string]any)
	out := []pxFile{}
	if in == nil {
		return out
	}
	if files, ok := in["files"].([]any); ok {
		for _, x := range files {
			f, _ := x.(map[string]any)
			p, _ := f["path"].(string)
			if f == nil || !pxExists(p) {
				continue
			}
			size := int64(0)
			if s, ok := num(f, "size"); ok && s != 0 && !math.IsNaN(s) {
				size = int64(s)
			} else {
				size = pxSize(p)
			}
			out = append(out, pxFile{p, size})
		}
		return out
	}
	if dl, ok := in["downloads"].([]any); ok {
		for _, x := range dl {
			f, _ := x.(map[string]any)
			p, _ := f["localPath"].(string)
			if f == nil || !truthy(f["success"]) || !pxExists(p) {
				continue
			}
			out = append(out, pxFile{p, pxSize(p)})
		}
		return out
	}
	if p, _ := in["path"].(string); pxExists(p) {
		return []pxFile{{p, pxSize(p)}}
	}
	if p, _ := in["localPath"].(string); pxExists(p) {
		return []pxFile{{p, pxSize(p)}}
	}
	return out
}

// pxFsErr words a file error like Node's fs module.
func pxFsErr(err error, syscallName, p string) error {
	if errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("ENOENT: no such file or directory, %s '%s'", syscallName, p)
	}
	if errors.Is(err, os.ErrPermission) {
		return fmt.Errorf("EACCES: permission denied, %s '%s'", syscallName, p)
	}
	return err
}

func pxReadFile(p string) ([]byte, error) {
	b, err := os.ReadFile(p)
	if err != nil {
		return nil, pxFsErr(err, "open", p)
	}
	return b, nil
}

func pxWriteFile(p string, b []byte) error {
	if err := os.WriteFile(p, b, 0o644); err != nil {
		return pxFsErr(err, "open", p)
	}
	return nil
}

// ── basket output ────────────────────────────────────────────────────────────

func pxWriteToBasket(filePath, fileName, basketID string, size int64, metadata string) error {
	rows, err := appQuery(`SELECT path FROM baskets WHERE id = $1`, basketID)
	if err != nil {
		return err
	}
	if len(rows) == 0 {
		return fmt.Errorf("Output basket not found: %s", basketID)
	}
	storage, _ := rows[0]["path"].(string)
	if storage == "" {
		storage = "/data/baskets/" + basketID
	}
	destDir := storage
	if !strings.HasPrefix(destDir, "/") {
		destDir = "/" + destDir
	}
	if err := os.MkdirAll(destDir, 0o755); err != nil {
		return pxFsErr(err, "mkdir", destDir)
	}
	dest := filepath.Join(destDir, fileName)
	if err := pxCopyFile(filePath, dest); err != nil {
		return err
	}
	var sessionID any
	sess, err := appQuery(`SELECT id FROM processing_sessions WHERE "basketId" = $1 AND status IN ('open','processing') ORDER BY "startedAt" DESC LIMIT 1`, basketID)
	if err != nil {
		return err
	}
	if len(sess) > 0 {
		sessionID = sess[0]["id"]
	}
	now := time.Now().UTC()
	_, err = appExec(`INSERT INTO basket_files (id, "basketId", "sessionId", "fileName", "originalName", "mimeType", path, size, status, metadata, "createdAt", "updatedAt")
		VALUES ($1,$2,$3,$4,$5,'application/octet-stream',$6,$7,'uploaded',$8,$9,$9)`,
		newCUID(), basketID, sessionID, fileName, fileName, dest, int32(size), metadata, now)
	return err
}

func pxCopyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return fmt.Errorf("ENOENT: no such file or directory, copyfile '%s' -> '%s'", src, dst)
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return pxFsErr(err, "copyfile", dst)
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// ── PGP ──────────────────────────────────────────────────────────────────────

func pxEncryptPGP(in, out, armoredPublic string, armored bool) error {
	keys, err := openpgp.ReadArmoredKeyRing(strings.NewReader(armoredPublic))
	if err != nil {
		return fmt.Errorf("Misformed armored text: %s", err.Error())
	}
	if len(keys) == 0 {
		return errors.New("No key packet found")
	}
	data, err := pxReadFile(in)
	if err != nil {
		return err
	}
	var buf bytes.Buffer
	pt, err := openpgp.Encrypt(&buf, openpgp.EntityList{keys[0]}, nil, &openpgp.FileHints{IsBinary: true, ModTime: time.Now()}, &packet.Config{DefaultCipher: packet.CipherAES256})
	if err != nil {
		return err
	}
	if _, err := pt.Write(data); err != nil {
		return err
	}
	if err := pt.Close(); err != nil {
		return err
	}
	if armored {
		return pxWriteFile(out, pxArmorMessage(buf.Bytes()))
	}
	return pxWriteFile(out, buf.Bytes())
}

func pxDecryptPGP(in, out, armoredPrivate, armoredPublic, passphrase string) error {
	keys, err := openpgp.ReadArmoredKeyRing(strings.NewReader(armoredPrivate))
	if err != nil {
		return fmt.Errorf("Misformed armored text: %s", err.Error())
	}
	if len(keys) == 0 || keys[0].PrivateKey == nil {
		return errors.New("No secret key packet found")
	}
	priv := keys[0]
	if passphrase != "" {
		locked := priv.PrivateKey.Encrypted
		for _, s := range priv.Subkeys {
			if s.PrivateKey != nil && s.PrivateKey.Encrypted {
				locked = true
			}
		}
		if locked {
			if err := priv.DecryptPrivateKeys([]byte(passphrase)); err != nil {
				return errors.New("Error decrypting private key: Incorrect key passphrase")
			}
		}
	}
	ring := openpgp.EntityList{priv}
	if armoredPublic != "" {
		if pub, err := openpgp.ReadArmoredKeyRing(strings.NewReader(armoredPublic)); err == nil && len(pub) > 0 {
			ring = append(ring, pub[0])
		}
	}
	raw, err := pxReadFile(in)
	if err != nil {
		return err
	}
	var src io.Reader = bytes.NewReader(raw)
	if strings.Contains(string(raw), "-----BEGIN PGP MESSAGE-----") {
		blk, err := armor.Decode(bytes.NewReader(raw))
		if err != nil {
			return fmt.Errorf("Misformed armored text: %s", err.Error())
		}
		src = blk.Body
	}
	md, err := openpgp.ReadMessage(src, ring, nil, &packet.Config{})
	if err != nil {
		return fmt.Errorf("Error decrypting message: %s", err.Error())
	}
	plain, err := io.ReadAll(md.UnverifiedBody)
	if err != nil {
		return fmt.Errorf("Error decrypting message: %s", err.Error())
	}
	return pxWriteFile(out, plain)
}

// ── RSA ──────────────────────────────────────────────────────────────────────

func pxParseRSAPublic(text string) (*rsa.PublicKey, error) {
	blocks := pxPEMBlocks(text)
	if len(blocks) == 0 {
		return nil, errors.New("error:1E08010C:DECODER routines::unsupported")
	}
	pub, err := pxRSAPublicFromBlock(blocks[0])
	if err != nil {
		return nil, err
	}
	return pub, nil
}

func pxEncryptRSAHybrid(in, out, publicPem string) error {
	pub, err := pxParseRSAPublic(publicPem)
	if err != nil {
		return err
	}
	aesKey := make([]byte, 32)
	iv := make([]byte, 12)
	_, _ = rand.Read(aesKey)
	_, _ = rand.Read(iv)
	encKey, err := rsa.EncryptOAEP(sha256.New(), rand.Reader, pub, aesKey, nil)
	if err != nil {
		return pxRSAErr(err)
	}
	data, err := pxReadFile(in)
	if err != nil {
		return err
	}
	block, _ := aes.NewCipher(aesKey)
	gcm, _ := cipher.NewGCM(block)
	var buf bytes.Buffer
	buf.Write(pxRSAHybridMagic)
	buf.WriteByte(pxRSAHybridVersion)
	var kl [2]byte
	binary.BigEndian.PutUint16(kl[:], uint16(len(encKey)))
	buf.Write(kl[:])
	buf.Write(encKey)
	buf.Write(iv)
	buf.Write(gcm.Seal(nil, iv, data, nil)) // ciphertext followed by the 16-byte tag
	return pxWriteFile(out, buf.Bytes())
}

func pxEncryptRSADirect(in, out, publicPem string) error {
	data, err := pxReadFile(in)
	if err != nil {
		return err
	}
	if len(data) > 446 {
		return fmt.Errorf("File too large for RSA Direct: %d bytes (max %d). Use RSA (hybrid) or AES instead.", len(data), 446)
	}
	pub, err := pxParseRSAPublic(publicPem)
	if err != nil {
		return err
	}
	enc, err := rsa.EncryptOAEP(sha256.New(), rand.Reader, pub, data, nil)
	if err != nil {
		return pxRSAErr(err)
	}
	return pxWriteFile(out, enc)
}

func pxRSAErr(err error) error {
	if errors.Is(err, rsa.ErrMessageTooLong) {
		return errors.New("error:0200006E:rsa routines::data too large for key size")
	}
	if errors.Is(err, rsa.ErrDecryption) {
		return errors.New("error:02000079:rsa routines::oaep decoding error")
	}
	return err
}

func pxDecryptRSADirect(in, out string, pk *rsa.PrivateKey) error {
	enc, err := pxReadFile(in)
	if err != nil {
		return err
	}
	plain, err := rsa.DecryptOAEP(sha256.New(), nil, pk, enc, nil)
	if err != nil {
		return pxRSAErr(err)
	}
	return pxWriteFile(out, plain)
}

func pxSub(b []byte, start, end int) []byte {
	n := len(b)
	clamp := func(i int) int {
		if i < 0 {
			i += n
			if i < 0 {
				i = 0
			}
		}
		if i > n {
			i = n
		}
		return i
	}
	s, e := clamp(start), clamp(end)
	if e < s {
		return []byte{}
	}
	return b[s:e]
}

func pxOutOfRange(offset, n int) error {
	return fmt.Errorf(`The value of "offset" is out of range. It must be >= 0 and <= %d. Received %d`, n-2, offset)
}

func pxGCMOpen(key, iv, data, tag []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, errors.New("Invalid key length")
	}
	if len(iv) == 0 {
		return nil, errors.New("Invalid initialization vector")
	}
	gcm, err := cipher.NewGCMWithNonceSize(block, len(iv))
	if err != nil {
		return nil, errors.New("Invalid initialization vector")
	}
	if len(tag) != 16 {
		return nil, fmt.Errorf("Invalid authentication tag length: %d", len(tag))
	}
	plain, err := gcm.Open(nil, iv, append(append([]byte{}, data...), tag...), nil)
	if err != nil {
		return nil, errors.New("Unsupported state or unable to authenticate data")
	}
	return plain, nil
}

func pxDecryptRSAHybrid(in, out string, pk *rsa.PrivateKey) error {
	b, err := pxReadFile(in)
	if err != nil {
		return err
	}
	off := 0
	if len(b) >= 4 && bytes.Equal(b[:4], pxRSAHybridMagic) {
		off += 4
		if len(b) <= off {
			return fmt.Errorf("Unsupported RSA hybrid format version: undefined")
		}
		version := b[off]
		off++
		if version != pxRSAHybridVersion {
			return fmt.Errorf("Unsupported RSA hybrid format version: %d", version)
		}
		if off+2 > len(b) {
			return pxOutOfRange(off, len(b))
		}
		keyLen := int(binary.BigEndian.Uint16(b[off:]))
		off += 2
		if keyLen > 1024 || keyLen == 0 {
			return fmt.Errorf("Invalid encrypted key length: %d. File may be corrupted.", keyLen)
		}
		encKey := pxSub(b, off, off+keyLen)
		off += keyLen
		iv := pxSub(b, off, off+12)
		off += 12
		data := pxSub(b, off, len(b)-16)
		tag := pxSub(b, len(b)-16, len(b))
		aesKey, err := rsa.DecryptOAEP(sha256.New(), nil, pk, encKey, nil)
		if err != nil {
			return pxRSAErr(err)
		}
		if len(aesKey) != 32 {
			return errors.New("Invalid key length")
		}
		plain, err := pxGCMOpen(aesKey, iv, data, tag)
		if err != nil {
			return err
		}
		return pxWriteFile(out, plain)
	}
	if off+2 > len(b) {
		return pxOutOfRange(off, len(b))
	}
	keyLen := int(binary.BigEndian.Uint16(b[off:]))
	off += 2
	if keyLen > 1024 || keyLen == 0 {
		return fmt.Errorf("Invalid encrypted key length: %d. File may not be RSA-encrypted.", keyLen)
	}
	encKey := pxSub(b, off, off+keyLen)
	off += keyLen
	iv := pxSub(b, off, off+12)
	off += 12
	tag := pxSub(b, off, off+16)
	off += 16
	data := pxSub(b, off, len(b))
	aesKey, err := rsa.DecryptOAEP(sha1.New(), nil, pk, encKey, nil)
	if err != nil {
		return pxRSAErr(err)
	}
	if len(aesKey) != 32 {
		return errors.New("Invalid key length")
	}
	plain, err := pxGCMOpen(aesKey, iv, data, tag)
	if err != nil {
		return err
	}
	return pxWriteFile(out, plain)
}

// ── AES ──────────────────────────────────────────────────────────────────────

func pxAESBits(algorithm string) int {
	n, _ := strconv.Atoi(strings.Split(algorithm, "-")[1])
	return n / 8
}

func pxEncryptAES(in, out, keyData, algorithm string) error {
	key, err := pxResolveAESKey(keyData)
	if err != nil {
		return err
	}
	if len(key) != pxAESBits(algorithm) {
		return errors.New("Invalid key length")
	}
	data, err := pxReadFile(in)
	if err != nil {
		return err
	}
	block, _ := aes.NewCipher(key)
	var buf bytes.Buffer
	if strings.HasSuffix(algorithm, "-gcm") {
		iv := make([]byte, 12)
		_, _ = rand.Read(iv)
		gcm, _ := cipher.NewGCM(block)
		buf.Write(iv)
		buf.Write(gcm.Seal(nil, iv, data, nil))
	} else {
		iv := make([]byte, 16)
		_, _ = rand.Read(iv)
		pad := 16 - len(data)%16
		padded := append(append([]byte{}, data...), bytes.Repeat([]byte{byte(pad)}, pad)...)
		enc := make([]byte, len(padded))
		cipher.NewCBCEncrypter(block, iv).CryptBlocks(enc, padded)
		buf.Write(iv)
		buf.Write(enc)
	}
	return pxWriteFile(out, buf.Bytes())
}

func pxDecryptAES(in, out, keyData, algorithm string) error {
	key, err := pxResolveAESKey(keyData)
	if err != nil {
		return err
	}
	b, err := pxReadFile(in)
	if err != nil {
		return err
	}
	if len(key) != pxAESBits(algorithm) {
		return errors.New("Invalid key length")
	}
	var plain []byte
	if strings.HasSuffix(algorithm, "-gcm") {
		iv := pxSub(b, 0, 12)
		data := pxSub(b, 12, len(b)-16)
		tag := pxSub(b, len(b)-16, len(b))
		if plain, err = pxGCMOpen(key, iv, data, tag); err != nil {
			return err
		}
	} else {
		iv := pxSub(b, 0, 16)
		data := pxSub(b, 16, len(b))
		if len(iv) != 16 {
			return errors.New("Invalid initialization vector")
		}
		if len(data)%16 != 0 || len(data) == 0 {
			return errors.New("error:1C80006B:Provider routines::wrong final block length")
		}
		block, _ := aes.NewCipher(key)
		dec := make([]byte, len(data))
		cipher.NewCBCDecrypter(block, iv).CryptBlocks(dec, data)
		pad := int(dec[len(dec)-1])
		if pad == 0 || pad > 16 || !bytes.Equal(dec[len(dec)-pad:], bytes.Repeat([]byte{byte(pad)}, pad)) {
			return errors.New("error:1C800064:Provider routines::bad decrypt")
		}
		plain = dec[:len(dec)-pad]
	}
	return pxWriteFile(out, plain)
}

func pxResolveAESKey(keyData string) ([]byte, error) {
	if strings.HasPrefix(keyData, "{") {
		var parsed any
		if err := json.Unmarshal([]byte(keyData), &parsed); err != nil {
			return nil, fmt.Errorf("Invalid AES key JSON: %s", err.Error())
		}
		m, ok := parsed.(map[string]any)
		if !ok {
			if parsed == nil {
				return nil, errors.New("Invalid AES key JSON: Cannot read properties of null (reading 'keyBase64')")
			}
			return nil, errors.New(`JSON key format missing "key" or "keyBase64" field`)
		}
		if truthy(m["keyBase64"]) {
			return pxNodeBase64(jsString(m["keyBase64"])), nil
		}
		if truthy(m["key"]) {
			return pxNodeHex(jsString(m["key"])), nil
		}
		return nil, errors.New(`JSON key format missing "key" or "keyBase64" field`)
	}
	buf := pxNodeBase64(keyData)
	if l := len(buf); l != 16 && l != 24 && l != 32 {
		return nil, fmt.Errorf("Invalid AES key length: expected 16/24/32 bytes, got %d", l)
	}
	return buf, nil
}

// pxNodeBase64 decodes like Buffer.from(s, 'base64'): url-safe characters
// accepted, other characters skipped, '=' ends the data.
func pxNodeBase64(s string) []byte {
	var clean []byte
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c == '=':
			i = len(s)
		case c == '-':
			clean = append(clean, '+')
		case c == '_':
			clean = append(clean, '/')
		case c >= 'A' && c <= 'Z', c >= 'a' && c <= 'z', c >= '0' && c <= '9', c == '+', c == '/':
			clean = append(clean, c)
		}
	}
	if len(clean)%4 == 1 {
		clean = clean[:len(clean)-1]
	}
	out := make([]byte, len(clean)*3/4+3)
	n := 0
	var acc uint32
	bits := 0
	const alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
	for _, c := range clean {
		acc = acc<<6 | uint32(strings.IndexByte(alpha, c))
		bits += 6
		if bits >= 8 {
			bits -= 8
			out[n] = byte(acc >> bits)
			n++
		}
	}
	return out[:n]
}

// pxNodeHex decodes like Buffer.from(s, 'hex'): stops at the first bad pair.
func pxNodeHex(s string) []byte {
	val := func(c byte) int {
		switch {
		case c >= '0' && c <= '9':
			return int(c - '0')
		case c >= 'a' && c <= 'f':
			return int(c-'a') + 10
		case c >= 'A' && c <= 'F':
			return int(c-'A') + 10
		}
		return -1
	}
	var out []byte
	for i := 0; i+1 < len(s); i += 2 {
		h, l := val(s[i]), val(s[i+1])
		if h < 0 || l < 0 {
			break
		}
		out = append(out, byte(h<<4|l))
	}
	return out
}

// pxArmorMessage armors like openpgp.js 6: 60-character lines, CRC24
// checksum line, trailing newline.
func pxArmorMessage(b []byte) []byte {
	enc := base64.StdEncoding.EncodeToString(b)
	var sb strings.Builder
	sb.WriteString("-----BEGIN PGP MESSAGE-----\n\n")
	for len(enc) > 60 {
		sb.WriteString(enc[:60] + "\n")
		enc = enc[60:]
	}
	sb.WriteString(enc + "\n")
	crc := uint32(0xb704ce)
	for _, c := range b {
		crc ^= uint32(c) << 16
		for i := 0; i < 8; i++ {
			crc <<= 1
			if crc&0x1000000 != 0 {
				crc ^= 0x1864cfb
			}
		}
	}
	crc &= 0xffffff
	sb.WriteString("=" + base64.StdEncoding.EncodeToString([]byte{byte(crc >> 16), byte(crc >> 8), byte(crc)}) + "\n")
	sb.WriteString("-----END PGP MESSAGE-----\n")
	return []byte(sb.String())
}
