package main

// RSA key loading for file-encrypt / file-decrypt: what Node's
// crypto.createPublicKey / createPrivateKey accept for PEM input, and a port
// of lib/rsaKeys.ts loadRsaPrivateKey.

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/des"
	"crypto/pbkdf2"
	"crypto/rsa"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/sha512"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/asn1"
	"encoding/pem"
	"errors"
	"hash"
	"regexp"
)

func pxPEMBlocks(text string) []*pem.Block {
	var out []*pem.Block
	rest := []byte(text)
	for {
		var b *pem.Block
		b, rest = pem.Decode(rest)
		if b == nil {
			return out
		}
		out = append(out, b)
	}
}

func pxRSAPublicFromBlock(b *pem.Block) (*rsa.PublicKey, error) {
	var key any
	var err error
	switch b.Type {
	case "PUBLIC KEY":
		key, err = x509.ParsePKIXPublicKey(b.Bytes)
	case "RSA PUBLIC KEY":
		key, err = x509.ParsePKCS1PublicKey(b.Bytes)
	case "CERTIFICATE":
		var c *x509.Certificate
		if c, err = x509.ParseCertificate(b.Bytes); err == nil {
			key = c.PublicKey
		}
	case "PRIVATE KEY", "RSA PRIVATE KEY":
		var pk *rsa.PrivateKey
		if pk, err = pxParsePlainPrivate(b); err == nil {
			key = &pk.PublicKey
		}
	default:
		return nil, errors.New("error:1E08010C:DECODER routines::unsupported")
	}
	if err != nil {
		return nil, errors.New("error:1E08010C:DECODER routines::unsupported")
	}
	pub, ok := key.(*rsa.PublicKey)
	if !ok {
		return nil, errors.New("error:02000068:rsa routines::bad signature")
	}
	return pub, nil
}

func pxParsePlainPrivate(b *pem.Block) (*rsa.PrivateKey, error) {
	if b.Type == "RSA PRIVATE KEY" {
		return x509.ParsePKCS1PrivateKey(b.Bytes)
	}
	k, err := x509.ParsePKCS8PrivateKey(b.Bytes)
	if err != nil {
		return nil, err
	}
	pk, ok := k.(*rsa.PrivateKey)
	if !ok {
		return nil, errors.New("operation not supported for this keytype")
	}
	return pk, nil
}

var pxEncryptedRe = regexp.MustCompile(`ENCRYPTED`)

// pxLoadRSAPrivateKey ports loadRsaPrivateKey.
func pxLoadRSAPrivateKey(pemText, passphrase string) (*rsa.PrivateKey, error) {
	if pemText == "" {
		return nil, errors.New("This RSA key has no private key — import one to decrypt")
	}
	blocks := pxPEMBlocks(pemText)
	if pxEncryptedRe.MatchString(pemText) {
		if passphrase == "" {
			return nil, errors.New("RSA private key is passphrase-protected — re-import it with its passphrase in Secrets Vault")
		}
		for _, b := range blocks {
			switch {
			case b.Type == "ENCRYPTED PRIVATE KEY":
				der, err := pxDecryptPKCS8(b.Bytes, []byte(passphrase))
				if err != nil {
					return nil, err
				}
				return pxParsePlainPrivate(&pem.Block{Type: "PRIVATE KEY", Bytes: der})
			case x509.IsEncryptedPEMBlock(b): //nolint:staticcheck // legacy Proc-Type PEM, as OpenSSL reads it
				der, err := x509.DecryptPEMBlock(b, []byte(passphrase)) //nolint:staticcheck
				if err != nil {
					return nil, errors.New("error:1C800064:Provider routines::bad decrypt")
				}
				return pxParsePlainPrivate(&pem.Block{Type: b.Type, Bytes: der})
			}
		}
	}
	for _, b := range blocks {
		if b.Type == "PRIVATE KEY" || b.Type == "RSA PRIVATE KEY" {
			pk, err := pxParsePlainPrivate(b)
			if err != nil {
				return nil, errors.New("error:1E08010C:DECODER routines::unsupported")
			}
			return pk, nil
		}
	}
	return nil, errors.New("error:1E08010C:DECODER routines::unsupported")
}

// ── PKCS#8 EncryptedPrivateKeyInfo (PBES2: PBKDF2 + AES/3DES-CBC) ────────────

var (
	oidPBES2      = asn1.ObjectIdentifier{1, 2, 840, 113549, 1, 5, 13}
	oidPBKDF2     = asn1.ObjectIdentifier{1, 2, 840, 113549, 1, 5, 12}
	oidHMACSHA1   = asn1.ObjectIdentifier{1, 2, 840, 113549, 2, 7}
	oidHMACSHA224 = asn1.ObjectIdentifier{1, 2, 840, 113549, 2, 8}
	oidHMACSHA256 = asn1.ObjectIdentifier{1, 2, 840, 113549, 2, 9}
	oidHMACSHA384 = asn1.ObjectIdentifier{1, 2, 840, 113549, 2, 10}
	oidHMACSHA512 = asn1.ObjectIdentifier{1, 2, 840, 113549, 2, 11}
	oidAES128CBC  = asn1.ObjectIdentifier{2, 16, 840, 1, 101, 3, 4, 1, 2}
	oidAES192CBC  = asn1.ObjectIdentifier{2, 16, 840, 1, 101, 3, 4, 1, 22}
	oidAES256CBC  = asn1.ObjectIdentifier{2, 16, 840, 1, 101, 3, 4, 1, 42}
	oidDESEDE3CBC = asn1.ObjectIdentifier{1, 2, 840, 113549, 3, 7}
)

type pxEncPKInfo struct {
	Algo pkix.AlgorithmIdentifier
	Data []byte
}

type pxPBES2Params struct {
	KDF pkix.AlgorithmIdentifier
	Enc pkix.AlgorithmIdentifier
}

type pxPBKDF2Params struct {
	Salt   []byte
	Iter   int
	KeyLen int                      `asn1:"optional"`
	PRF    pkix.AlgorithmIdentifier `asn1:"optional"`
}

func pxDecryptPKCS8(der, pass []byte) ([]byte, error) {
	unsupported := errors.New("error:1E08010C:DECODER routines::unsupported")
	var info pxEncPKInfo
	if _, err := asn1.Unmarshal(der, &info); err != nil || !info.Algo.Algorithm.Equal(oidPBES2) {
		return nil, unsupported
	}
	var params pxPBES2Params
	if _, err := asn1.Unmarshal(info.Algo.Parameters.FullBytes, &params); err != nil || !params.KDF.Algorithm.Equal(oidPBKDF2) {
		return nil, unsupported
	}
	var kdf pxPBKDF2Params
	if _, err := asn1.Unmarshal(params.KDF.Parameters.FullBytes, &kdf); err != nil {
		return nil, unsupported
	}
	var h func() hash.Hash
	switch {
	case len(kdf.PRF.Algorithm) == 0, kdf.PRF.Algorithm.Equal(oidHMACSHA1):
		h = sha1.New
	case kdf.PRF.Algorithm.Equal(oidHMACSHA224):
		h = sha256.New224
	case kdf.PRF.Algorithm.Equal(oidHMACSHA256):
		h = sha256.New
	case kdf.PRF.Algorithm.Equal(oidHMACSHA384):
		h = sha512.New384
	case kdf.PRF.Algorithm.Equal(oidHMACSHA512):
		h = sha512.New
	default:
		return nil, unsupported
	}
	var keyLen int
	var newBlock func([]byte) (cipher.Block, error)
	switch e := params.Enc.Algorithm; {
	case e.Equal(oidAES128CBC):
		keyLen, newBlock = 16, aes.NewCipher
	case e.Equal(oidAES192CBC):
		keyLen, newBlock = 24, aes.NewCipher
	case e.Equal(oidAES256CBC):
		keyLen, newBlock = 32, aes.NewCipher
	case e.Equal(oidDESEDE3CBC):
		keyLen, newBlock = 24, des.NewTripleDESCipher
	default:
		return nil, unsupported
	}
	var iv []byte
	if _, err := asn1.Unmarshal(params.Enc.Parameters.FullBytes, &iv); err != nil {
		return nil, unsupported
	}
	key, err := pbkdf2.Key(h, string(pass), kdf.Salt, kdf.Iter, keyLen)
	if err != nil {
		return nil, unsupported
	}
	block, err := newBlock(key)
	if err != nil || len(iv) != block.BlockSize() || len(info.Data)%block.BlockSize() != 0 || len(info.Data) == 0 {
		return nil, errors.New("error:1C800064:Provider routines::bad decrypt")
	}
	out := make([]byte, len(info.Data))
	cipher.NewCBCDecrypter(block, iv).CryptBlocks(out, info.Data)
	pad := int(out[len(out)-1])
	if pad == 0 || pad > block.BlockSize() || pad > len(out) {
		return nil, errors.New("error:1C800064:Provider routines::bad decrypt")
	}
	for _, c := range out[len(out)-pad:] {
		if int(c) != pad {
			return nil, errors.New("error:1C800064:Provider routines::bad decrypt")
		}
	}
	return out[:len(out)-pad], nil
}
