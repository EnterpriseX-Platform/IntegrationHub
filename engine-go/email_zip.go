package main

// Attachment zip for email-action. Without a password this is a plain
// deflate (level 9) zip like archiver('zip'); with one it is the traditional
// PKWARE "ZipCrypto" encryption archiver-zip-encryptable writes (every entry
// encrypted, data descriptor, check byte = high byte of the DOS time).

import (
	"archive/zip"
	"bytes"
	"compress/flate"
	"crypto/rand"
	"hash/crc32"
	"io"
	"os"
	"time"
)

func pxZip(files []pxAttachment, dest string, password string) error {
	out, err := os.Create(dest)
	if err != nil {
		return pxFsErr(err, "open", dest)
	}
	defer out.Close()
	zw := zip.NewWriter(out)
	zw.RegisterCompressor(zip.Deflate, func(w io.Writer) (io.WriteCloser, error) {
		return flate.NewWriter(w, flate.BestCompression)
	})
	for _, f := range files {
		st, err := os.Stat(f.path)
		if err != nil {
			return pxFsErr(err, "stat", f.path)
		}
		data, err := os.ReadFile(f.path)
		if err != nil {
			return pxFsErr(err, "open", f.path)
		}
		utf8Flag := uint16(0)
		if !pxIsASCII(f.filename) {
			utf8Flag = 0x800 // archiver marks only non-ASCII names as UTF-8
		}
		if password == "" {
			// archiver('zip') writes the DOS time in UTC, no extended-time extra field
			fh := &zip.FileHeader{Name: f.filename, Method: zip.Deflate, Flags: utf8Flag}
			fh.ModifiedTime, fh.ModifiedDate = pxDosTime(st.ModTime().UTC())
			fh.SetMode(st.Mode())
			w, err := zw.CreateHeader(fh)
			if err != nil {
				return err
			}
			if _, err := w.Write(data); err != nil {
				return err
			}
			continue
		}
		method := zip.Deflate
		payload := data
		if len(data) == 0 {
			method = zip.Store
		} else {
			var buf bytes.Buffer
			fw, _ := flate.NewWriter(&buf, flate.BestCompression)
			_, _ = fw.Write(data)
			_ = fw.Close()
			payload = buf.Bytes()
		}
		dosTime, dosDate := pxDosTime(st.ModTime().Local()) // forceLocalTime
		hdr := make([]byte, 12)
		_, _ = rand.Read(hdr[:10])
		hdr[10], hdr[11] = byte(dosTime), byte(dosTime>>8)
		zc := pxNewZipCrypto([]byte(password))
		enc := append(zc.encrypt(hdr), zc.encrypt(payload)...)
		fh := &zip.FileHeader{
			Name: f.filename, Method: method, ModifiedTime: dosTime, ModifiedDate: dosDate, Flags: 0x1 | 0x8 | utf8Flag,
			CRC32: crc32.ChecksumIEEE(data), CompressedSize64: uint64(len(enc)), UncompressedSize64: uint64(len(data)),
		}
		fh.SetMode(st.Mode())
		w, err := zw.CreateRaw(fh)
		if err != nil {
			return err
		}
		if _, err := w.Write(enc); err != nil {
			return err
		}
	}
	if err := zw.Close(); err != nil {
		return err
	}
	return out.Close()
}

type pxZipCrypto struct{ k0, k1, k2 uint32 }

func pxNewZipCrypto(pw []byte) *pxZipCrypto {
	z := &pxZipCrypto{0x12345678, 0x23456789, 0x34567890}
	for _, c := range pw {
		z.update(c)
	}
	return z
}

func (z *pxZipCrypto) update(c byte) {
	z.k0 = crc32.IEEETable[byte(z.k0)^c] ^ (z.k0 >> 8)
	z.k1 = (z.k1+(z.k0&0xff))*134775813 + 1
	z.k2 = crc32.IEEETable[byte(z.k2)^byte(z.k1>>24)] ^ (z.k2 >> 8)
}

func (z *pxZipCrypto) encrypt(p []byte) []byte {
	out := make([]byte, len(p))
	for i, c := range p {
		t := uint16(z.k2) | 2
		out[i] = c ^ byte((uint32(t)*uint32(t^1))>>8)
		z.update(c)
	}
	return out
}

func pxDosTime(t time.Time) (uint16, uint16) {
	return uint16(t.Second()/2 + t.Minute()<<5 + t.Hour()<<11), uint16(t.Day() + int(t.Month())<<5 + (t.Year()-1980)<<9)
}
