package main

// Secrets Vault encryption used by sftp-action: encryptFile / decryptFile
// from SFTPActionExecutor.ts, decryptIfEncrypted from lib/fileDecrypt.ts and
// loadRsaPrivateKey from lib/rsaKeys.ts.

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/sha512"
	"crypto/x509"
	"encoding/binary"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"hash"
	"io"
	"os"
	"regexp"
	"strings"

	"github.com/ProtonMail/go-crypto/openpgp"
	"github.com/ProtonMail/go-crypto/openpgp/armor"
	"github.com/ProtonMail/go-crypto/openpgp/packet"
)

type sbKey struct {
	ID, Name, Algorithm  string
	PublicKey, SecretKey *string
}

func sbLoadKey(id string) (*sbKey, error) {
	row, err := sbOne(`SELECT "id","name","algorithm","publicKey","secretKey" FROM api_keys WHERE "id"=$1`, id)
	if err != nil {
		return nil, err
	}
	if row == nil {
		return nil, nil
	}
	k := &sbKey{ID: sbS(row, "id"), Name: sbS(row, "name"), Algorithm: sbS(row, "algorithm")}
	if s, ok := row["publicKey"].(string); ok {
		k.PublicKey = &s
	}
	if s, ok := row["secretKey"].(string); ok {
		k.SecretKey = &s
	}
	return k, nil
}

func sbDeref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// Node's crypto error texts for the same failures.
var (
	errSbGCMAuth = errors.New("Unsupported state or unable to authenticate data")
	errSbOAEP    = errors.New("error:02000079:rsa routines::oaep decoding error")
	errSbKeyLen  = errors.New("Invalid key length")
)

func sbGCM(key []byte) (cipher.AEAD, error) {
	if len(key) != 32 {
		return nil, errSbKeyLen
	}
	blk, err := aes.NewCipher(key)
	if err != nil {
		return nil, errSbKeyLen
	}
	return cipher.NewGCM(blk)
}

// ── RSA keys (lib/rsaKeys.ts) ────────────────────────────────────────────────

var sbEncryptedPem = regexp.MustCompile(`ENCRYPTED`)

func sbLoadRSAPrivate(pemText *string) (*rsa.PrivateKey, error) {
	if pemText == nil || *pemText == "" {
		return nil, errors.New("This RSA key has no private key — import one to decrypt")
	}
	if sbEncryptedPem.MatchString(*pemText) {
		return nil, errors.New("RSA private key is passphrase-protected — re-import it with its passphrase in Secrets Vault")
	}
	blk, _ := pem.Decode([]byte(strings.TrimSpace(*pemText)))
	if blk == nil {
		return nil, errors.New("error:1E08010C:DECODER routines::unsupported")
	}
	if k, err := x509.ParsePKCS8PrivateKey(blk.Bytes); err == nil {
		if rk, ok := k.(*rsa.PrivateKey); ok {
			return rk, nil
		}
		return nil, errors.New("error:1C800066:Provider routines::operation not supported for this keytype")
	}
	if k, err := x509.ParsePKCS1PrivateKey(blk.Bytes); err == nil {
		return k, nil
	}
	return nil, errors.New("error:1E08010C:DECODER routines::unsupported")
}

func sbParseRSAPublic(text string) (*rsa.PublicKey, error) {
	blk, _ := pem.Decode([]byte(strings.TrimSpace(text)))
	if blk == nil {
		return nil, errors.New("error:1E08010C:DECODER routines::unsupported")
	}
	if k, err := x509.ParsePKIXPublicKey(blk.Bytes); err == nil {
		if rk, ok := k.(*rsa.PublicKey); ok {
			return rk, nil
		}
		return nil, errors.New("error:1C800066:Provider routines::operation not supported for this keytype")
	}
	if k, err := x509.ParsePKCS1PublicKey(blk.Bytes); err == nil {
		return k, nil
	}
	if c, err := x509.ParseCertificate(blk.Bytes); err == nil {
		if rk, ok := c.PublicKey.(*rsa.PublicKey); ok {
			return rk, nil
		}
	}
	// Node also accepts a private key PEM for publicEncrypt.
	s := text
	if k, err := sbLoadRSAPrivate(&s); err == nil {
		return &k.PublicKey, nil
	}
	return nil, errors.New("error:1E08010C:DECODER routines::unsupported")
}

func sbOAEPDecrypt(h hash.Hash, k *rsa.PrivateKey, data []byte) ([]byte, error) {
	out, err := rsa.DecryptOAEP(h, nil, k, data, nil)
	if err != nil {
		return nil, errSbOAEP
	}
	return out, nil
}

// ── PGP ──────────────────────────────────────────────────────────────────────

func sbPGPEncrypt(plain []byte, armoredPublic string) ([]byte, error) {
	ents, err := openpgp.ReadArmoredKeyRing(strings.NewReader(armoredPublic))
	if err != nil {
		return nil, fmt.Errorf("Misformed armored text")
	}
	var buf bytes.Buffer
	w, err := openpgp.Encrypt(&buf, ents[:1], nil, &openpgp.FileHints{IsBinary: true}, &packet.Config{DefaultCipher: packet.CipherAES256})
	if err != nil {
		return nil, err
	}
	if _, err := w.Write(plain); err != nil {
		return nil, err
	}
	if err := w.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// sbPGPUnlock unlocks a private key with an empty passphrase when it is locked
// (openpgp.decryptKey({ passphrase: ” }) in the TS; failures are ignored).
func sbPGPUnlock(ents openpgp.EntityList) {
	for _, e := range ents {
		if e.PrivateKey != nil && e.PrivateKey.Encrypted {
			_ = e.PrivateKey.Decrypt([]byte(""))
		}
		for _, sk := range e.Subkeys {
			if sk.PrivateKey != nil && sk.PrivateKey.Encrypted {
				_ = sk.PrivateKey.Decrypt([]byte(""))
			}
		}
	}
}

// sbPGPDecrypt: binary message first, armored as a fallback (SFTPActionExecutor),
// or by the "-----BEGIN PGP MESSAGE" head (fileDecrypt) when byHead is set.
func sbPGPDecrypt(enc []byte, armoredPrivate string, byHead bool) ([]byte, error) {
	ents, err := openpgp.ReadArmoredKeyRing(strings.NewReader(armoredPrivate))
	if err != nil {
		return nil, fmt.Errorf("Misformed armored text")
	}
	sbPGPUnlock(ents)
	cfg := &packet.Config{InsecureAllowDecryptionWithSigningKeys: !byHead}
	read := func(r io.Reader) (*openpgp.MessageDetails, error) {
		return openpgp.ReadMessage(r, ents, nil, cfg)
	}
	var md *openpgp.MessageDetails
	if byHead {
		if strings.HasPrefix(string(enc), "-----BEGIN PGP MESSAGE") {
			blk, err := armor.Decode(bytes.NewReader(enc))
			if err != nil {
				return nil, fmt.Errorf("Misformed armored text")
			}
			md, err = read(blk.Body)
			if err != nil {
				return nil, sbPGPErr(err)
			}
		} else if md, err = read(bytes.NewReader(enc)); err != nil {
			return nil, sbPGPErr(err)
		}
	} else {
		md, err = read(bytes.NewReader(enc))
		if err != nil {
			blk, aerr := armor.Decode(bytes.NewReader(enc))
			if aerr != nil {
				return nil, fmt.Errorf("Misformed armored text")
			}
			if md, err = read(blk.Body); err != nil {
				return nil, sbPGPErr(err)
			}
		}
	}
	out, err := io.ReadAll(md.UnverifiedBody)
	if err != nil {
		return nil, sbPGPErr(err)
	}
	return out, nil
}

func sbPGPErr(err error) error {
	if errors.Is(err, openpgpErrKeyIncorrect()) || strings.Contains(err.Error(), "incorrect key") || strings.Contains(err.Error(), "no key") {
		return errors.New("Error decrypting message: Session key decryption failed.")
	}
	return err
}

func openpgpErrKeyIncorrect() error { return errors.New("openpgp: incorrect key") }

// ── SFTPActionExecutor.encryptFile / decryptFile ─────────────────────────────

func sbEncryptFile(filePath, keyID string) (string, string, error) {
	k, err := sbLoadKey(keyID)
	if err != nil {
		return "", "", err
	}
	if k == nil {
		return "", "", fmt.Errorf("Encryption key not found: %s", keyID)
	}
	algorithm := k.Algorithm
	if algorithm == "" {
		algorithm = "pgp"
	}
	ext := ".enc"
	if algorithm == "pgp" {
		ext = ".pgp"
	}
	out := filePath + ext
	plain, err := sbReadFile(filePath)
	if err != nil {
		return "", "", err
	}
	var data []byte
	switch algorithm {
	case "pgp":
		if data, err = sbPGPEncrypt(plain, sbDeref(k.PublicKey)); err != nil {
			return "", "", err
		}
	case "rsa":
		pub, err := sbParseRSAPublic(sbDeref(k.PublicKey))
		if err != nil {
			return "", "", err
		}
		aesKey := make([]byte, 32)
		iv := make([]byte, 12)
		_, _ = rand.Read(aesKey)
		_, _ = rand.Read(iv)
		encKey, err := rsa.EncryptOAEP(sha256.New(), rand.Reader, pub, aesKey, nil)
		if err != nil {
			return "", "", err
		}
		g, _ := sbGCM(aesKey)
		sealed := g.Seal(nil, iv, plain, nil)
		kl := make([]byte, 2)
		binary.BigEndian.PutUint16(kl, uint16(len(encKey)))
		data = bytes.Join([][]byte{[]byte("RSAH"), {1}, kl, encKey, iv, sealed}, nil)
	default:
		keyBuf := sbB64(sbDeref(k.PublicKey))
		g, err := sbGCM(keyBuf)
		if err != nil {
			return "", "", err
		}
		iv := make([]byte, 12)
		_, _ = rand.Read(iv)
		data = append(iv, g.Seal(nil, iv, plain, nil)...)
	}
	if err := sbWriteFile(out, data); err != nil {
		return "", "", err
	}
	return out, algorithm, nil
}

var sbDecSuffix = regexp.MustCompile(`\.(pgp|gpg|enc)$`)

func sbDecryptFile(filePath, keyID string) (string, string, error) {
	k, err := sbLoadKey(keyID)
	if err != nil {
		return "", "", err
	}
	if k == nil {
		return "", "", fmt.Errorf("Encryption key not found: %s", keyID)
	}
	algorithm := k.Algorithm
	if algorithm == "" {
		algorithm = "pgp"
	}
	out := sbDecSuffix.ReplaceAllString(filePath, "")
	if out == "" {
		out = filePath + ".dec"
	}
	file, err := sbReadFile(filePath)
	if err != nil {
		return "", "", err
	}
	var plain []byte
	switch algorithm {
	case "pgp":
		if plain, err = sbPGPDecrypt(file, sbDeref(k.SecretKey), false); err != nil {
			return "", "", err
		}
	case "rsa":
		if len(file) < 7 {
			return "", "", fmt.Errorf("The value of \"offset\" is out of range. It must be >= 0 and <= %d. Received 5", len(file)-2)
		}
		off := 5
		kl := int(binary.BigEndian.Uint16(file[off:]))
		off += 2
		ek := sbSub(file, off, off+kl)
		off += kl
		iv := sbSub(file, off, off+12)
		off += 12
		encData := sbSub(file, off, len(file)-16)
		tag := sbSub(file, len(file)-16, len(file))
		pk, err := sbLoadRSAPrivate(k.SecretKey)
		if err != nil {
			return "", "", err
		}
		aesKey, err := sbOAEPDecrypt(sha256.New(), pk, ek)
		if err != nil {
			return "", "", err
		}
		if plain, err = sbGCMOpen(aesKey, iv, encData, tag); err != nil {
			return "", "", err
		}
	default:
		iv := sbSub(file, 0, 12)
		encData := sbSub(file, 12, len(file)-16)
		tag := sbSub(file, len(file)-16, len(file))
		var parsed map[string]any
		if err := json.Unmarshal([]byte(sbDeref(k.SecretKey)), &parsed); err != nil {
			return "", "", fmt.Errorf("Unexpected token in JSON")
		}
		if plain, err = sbGCMOpen(sbB64(sbStrOf(parsed["keyBase64"])), iv, encData, tag); err != nil {
			return "", "", err
		}
	}
	if err := sbWriteFile(out, plain); err != nil {
		return "", "", err
	}
	return out, algorithm, nil
}

// sbSub is Buffer.subarray(start, end) (clamped, never panics).
func sbSub(b []byte, start, end int) []byte {
	if start < 0 {
		start = len(b) + start
		if start < 0 {
			start = 0
		}
	}
	if end < 0 {
		end = len(b) + end
		if end < 0 {
			end = 0
		}
	}
	if start > len(b) {
		start = len(b)
	}
	if end > len(b) {
		end = len(b)
	}
	if end < start {
		end = start
	}
	return b[start:end]
}

func sbGCMOpen(key, iv, data, tag []byte) ([]byte, error) {
	if len(key) != 16 && len(key) != 24 && len(key) != 32 {
		return nil, errSbKeyLen
	}
	if len(iv) == 0 {
		return nil, errors.New("Invalid initialization vector")
	}
	blk, _ := aes.NewCipher(key)
	g, err := cipher.NewGCMWithNonceSize(blk, len(iv))
	if err != nil {
		return nil, errors.New("Invalid initialization vector")
	}
	if len(tag) != 16 {
		return nil, fmt.Errorf("Invalid authentication tag length: %d", len(tag))
	}
	out, err := g.Open(nil, iv, append(append([]byte{}, data...), tag...), nil)
	if err != nil {
		return nil, errSbGCMAuth
	}
	return out, nil
}

// ── lib/fileDecrypt.ts ───────────────────────────────────────────────────────

var sbEncryptedExt = regexp.MustCompile(`(?i)\.(enc|pgp|gpg)$`)

func sbDecryptedName(name string) string {
	if s := sbEncryptedExt.ReplaceAllString(name, ""); s != "" {
		return s
	}
	return name
}

func sbReadHead(p string, n int) ([]byte, error) {
	f, err := os.Open(p)
	if err != nil {
		return nil, sbFsErr(err, "open", p)
	}
	defer f.Close()
	buf := make([]byte, n)
	k, _ := io.ReadFull(f, buf)
	return buf[:k], nil
}

// sbJSSpace is what String.prototype.trim removes.
const sbJSSpace = " \t\n\v\f\r\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"

func sbStripBOM(s string) string { return strings.TrimPrefix(s, "\ufeff") }

var sbJSONEnvKeys = regexp.MustCompile(`"(format|key_algorithm|encrypted_key)"`)

func sbIsJSONEnvelope(head []byte) bool {
	t := strings.TrimLeft(sbStripBOM(string(head)), sbJSSpace)
	return strings.HasPrefix(t, "{") && sbJSONEnvKeys.MatchString(t)
}

var sbDotEnv = regexp.MustCompile(`^([A-Za-z0-9+/]+=*)\.([A-Za-z0-9+/]+=*)\.`)

func sbLatin1(b []byte) string {
	r := make([]rune, len(b))
	for i, c := range b {
		r[i] = rune(c)
	}
	return string(r)
}

func sbIsDotEnvelope(head []byte) bool {
	t := strings.TrimLeft(sbLatin1(head), sbJSSpace) // latin1: a UTF-8 BOM is not \ufeff here
	m := sbDotEnv.FindStringSubmatch(t)
	if m == nil {
		return false
	}
	kb := len(sbB64(m[1]))
	return (kb == 128 || kb == 256 || kb == 384 || kb == 512) && len(sbB64(m[2])) == 12
}

var sbPGPName = regexp.MustCompile(`(?i)\.(pgp|gpg)$`)

func sbIsEncryptedFor(p, name, algorithm string) (bool, error) {
	head, err := sbReadHead(p, 1100)
	if err != nil {
		return false, err
	}
	switch algorithm {
	case "rsa":
		return bytes.HasPrefix(head, []byte("RSAH")) || sbIsJSONEnvelope(head) || sbIsDotEnvelope(head), nil
	case "pgp":
		return sbPGPName.MatchString(name) || strings.HasPrefix(sbLatin1(head), "-----BEGIN PGP MESSAGE"), nil
	}
	return false, nil
}

func sbOAEPHash(name string) (hash.Hash, error) {
	switch name {
	case "sha256":
		return sha256.New(), nil
	case "sha1":
		return sha1.New(), nil
	case "sha384":
		return sha512.New384(), nil
	case "sha512":
		return sha512.New(), nil
	case "sha224":
		return sha256.New224(), nil
	}
	return nil, fmt.Errorf("Invalid digest: %s", name)
}

func sbDecryptJSONEnvelope(in, out string, k *sbKey) error {
	raw, err := sbReadFile(in)
	if err != nil {
		return err
	}
	var env map[string]any
	if err := json.Unmarshal([]byte(sbStripBOM(string(raw))), &env); err != nil {
		return fmt.Errorf("Unexpected token in JSON")
	}
	for _, f := range []string{"encrypted_key", "nonce", "ciphertext", "tag"} {
		if _, ok := env[f].(string); !ok {
			return fmt.Errorf("Envelope is missing \"%s\"", f)
		}
	}
	if ca, ok := env["content_algorithm"]; ok && truthy(ca) {
		if !regexp.MustCompile(`(?i)^AES-256-GCM$`).MatchString(sbStrOf(ca)) {
			return fmt.Errorf("Unsupported content_algorithm: %s", sbStrOf(ca))
		}
	}
	hn := "SHA-256"
	if truthy(env["oaep_hash"]) {
		hn = sbStrOf(env["oaep_hash"])
	}
	hn = strings.Replace(strings.ToLower(hn), "-", "", 1)
	pk, err := sbLoadRSAPrivate(k.SecretKey)
	if err != nil {
		return err
	}
	h, err := sbOAEPHash(hn)
	if err != nil {
		return err
	}
	aesKey, err := sbOAEPDecrypt(h, pk, sbB64(env["encrypted_key"].(string)))
	if err != nil {
		return err
	}
	if len(aesKey) != 32 {
		return errSbKeyLen
	}
	plain, err := sbGCMOpen(aesKey, sbB64(env["nonce"].(string)), sbB64(env["ciphertext"].(string)), sbB64(env["tag"].(string)))
	if err != nil {
		return err
	}
	return sbWriteFile(out, plain)
}

func sbDecryptDotEnvelope(in, out string, k *sbKey) error {
	raw, err := sbReadFile(in)
	if err != nil {
		return err
	}
	text := strings.Trim(sbLatin1(raw), sbJSSpace)
	parts := strings.Split(text, ".")
	if len(parts) != 3 {
		return fmt.Errorf("Expected 3 dot-separated parts, got %d", len(parts))
	}
	encKey, nonce, body := sbB64(parts[0]), sbB64(parts[1]), sbB64(parts[2])
	if len(body) < 16 {
		return errors.New("Ciphertext is too short")
	}
	pk, err := sbLoadRSAPrivate(k.SecretKey)
	if err != nil {
		return err
	}
	aesKey, err := sbOAEPDecrypt(sha256.New(), pk, encKey)
	if err != nil {
		return err
	}
	if len(aesKey) != 16 && len(aesKey) != 24 && len(aesKey) != 32 {
		return errors.New("Invalid cipher")
	}
	plain, err := sbGCMOpen(aesKey, nonce, body[:len(body)-16], body[len(body)-16:])
	if err != nil {
		return err
	}
	return sbWriteFile(out, plain)
}

func sbDecryptRSAHybrid(in, out string, k *sbKey) error {
	st, err := os.Stat(in)
	if err != nil {
		return sbFsErr(err, "stat", in)
	}
	size := int(st.Size())
	head, err := sbReadHead(in, 7+1024+12)
	if err != nil {
		return err
	}
	if len(head) < 7 || head[4] != 1 {
		v := "undefined"
		if len(head) > 4 {
			v = fmt.Sprint(head[4])
		}
		return fmt.Errorf("Unsupported RSA hybrid format version: %s", v)
	}
	keyLen := int(binary.BigEndian.Uint16(head[5:7]))
	if keyLen == 0 || keyLen > 1024 {
		return fmt.Errorf("Invalid encrypted key length: %d", keyLen)
	}
	encKey := sbSub(head, 7, 7+keyLen)
	iv := sbSub(head, 7+keyLen, 7+keyLen+12)
	dataStart := 7 + keyLen + 12
	if size < dataStart+16 {
		return errors.New("File is too short to be RSA-encrypted")
	}
	pk, err := sbLoadRSAPrivate(k.SecretKey)
	if err != nil {
		return err
	}
	aesKey, err := sbOAEPDecrypt(sha256.New(), pk, encKey)
	if err != nil {
		return err
	}
	if len(aesKey) != 32 {
		return errSbKeyLen
	}
	all, err := sbReadFile(in)
	if err != nil {
		return err
	}
	plain, err := sbGCMOpen(aesKey, iv, all[dataStart:size-16], all[size-16:])
	if err != nil {
		return err
	}
	return sbWriteFile(out, plain)
}

func sbDecryptPGPFile(in, out string, k *sbKey) error {
	if k.SecretKey == nil || *k.SecretKey == "" {
		return fmt.Errorf("Key \"%s\" has no private key", k.Name)
	}
	raw, err := sbReadFile(in)
	if err != nil {
		return err
	}
	plain, err := sbPGPDecrypt(raw, *k.SecretKey, true)
	if err != nil {
		return err
	}
	return sbWriteFile(out, plain)
}

// sbDecryptIfEncrypted ports decryptIfEncrypted: false (nothing written) when
// the file is plain for this key.
func sbDecryptIfEncrypted(in, out, name string, k *sbKey) (bool, error) {
	algorithm := k.Algorithm
	if algorithm == "" {
		algorithm = "pgp"
	}
	enc, err := sbIsEncryptedFor(in, name, algorithm)
	if err != nil {
		return false, err
	}
	if !enc {
		return false, nil
	}
	tmp := out + ".dec"
	h64, _ := sbReadHead(in, 64)
	h1100, _ := sbReadHead(in, 1100)
	switch {
	case algorithm == "rsa" && sbIsJSONEnvelope(h64):
		err = sbDecryptJSONEnvelope(in, tmp, k)
	case algorithm == "rsa" && sbIsDotEnvelope(h1100):
		err = sbDecryptDotEnvelope(in, tmp, k)
	case algorithm == "rsa":
		err = sbDecryptRSAHybrid(in, tmp, k)
	default:
		err = sbDecryptPGPFile(in, tmp, k)
	}
	if err == nil {
		err = sbRename(tmp, out)
	}
	if err != nil {
		_ = os.RemoveAll(tmp)
		return false, err
	}
	return true, nil
}
