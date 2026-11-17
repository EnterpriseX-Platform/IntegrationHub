package main

import (
	"bytes"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

const pxTestDB = "postgresql://postgres@localhost:55500/postgres"

var pxServerDir = func() string { d, _ := filepath.Abs("../server"); return d }()

func pxNodeBin() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".nvm/versions/node/v23.1.0/bin/node")
}

// pxNode runs a CommonJS script with the server's node_modules.
func pxNode(t *testing.T, script string, args ...string) string {
	t.Helper()
	if os.Getenv("PXPORT_SERVER_DIR") != "" {
		pxServerDir = os.Getenv("PXPORT_SERVER_DIR")
	}
	dir := t.TempDir()
	f := filepath.Join(dir, "s.js")
	_ = os.WriteFile(f, []byte(script), 0o644)
	cmd := exec.Command(pxNodeBin(), append([]string{f}, args...)...)
	cmd.Dir = pxServerDir
	cmd.Env = append(os.Environ(), "NODE_PATH="+filepath.Join(pxServerDir, "node_modules"), "NODE_NO_WARNINGS=1")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("node: %v\n%s", err, out)
	}
	return string(out)
}

func pxTestRun(t *testing.T, input any, vars map[string]any) (*Run, *Ctx) {
	t.Helper()
	req := &ExecuteRequest{RunID: "t", Input: input, Variables: vars}
	r := newRun(req, func(map[string]any) {})
	if vars == nil {
		vars = map[string]any{}
	}
	return r, &Ctx{ID: "root", Input: input, Vars: vars, dirty: map[string]bool{}, run: r}
}

func pxSetupDB(t *testing.T) {
	t.Helper()
	os.Setenv("DATABASE_URL", pxTestDB)
	if _, err := appExec(`INSERT INTO projects (id, name, "updatedAt") VALUES ('t_pxport_proj','t_pxport_proj', now()) ON CONFLICT DO NOTHING`); err != nil {
		t.Skipf("no test DB: %v", err)
	}
	t.Cleanup(func() {
		_, _ = appExec(`DELETE FROM basket_files WHERE "basketId" LIKE 't_pxport_%'`)
		_, _ = appExec(`DELETE FROM processing_sessions WHERE "basketId" LIKE 't_pxport_%'`)
		_, _ = appExec(`DELETE FROM baskets WHERE id LIKE 't_pxport_%'`)
		_, _ = appExec(`DELETE FROM api_keys WHERE id LIKE 't_pxport_%'`)
		_, _ = appExec(`DELETE FROM projects WHERE id = 't_pxport_proj'`)
	})
}

func pxInsertKey(t *testing.T, id, alg, pub, sec string) {
	t.Helper()
	var p, s any
	if pub != "" {
		p = pub
	}
	if sec != "" {
		s = sec
	}
	if _, err := appExec(`INSERT INTO api_keys (id, "projectId", name, key, "keyCategory", algorithm, "publicKey", "secretKey") VALUES ($1,'t_pxport_proj',$1,$1,'encryption-key',$2,$3,$4)`, id, alg, p, s); err != nil {
		t.Fatal(err)
	}
}

const pxGenPGP = `
const openpgp = require('openpgp');
(async () => {
  const a = await openpgp.generateKey({ userIDs: [{ name: 't' }], passphrase: 'pw', format: 'armored' });
  const b = await openpgp.generateKey({ type: 'rsa', rsaBits: 2048, userIDs: [{ name: 'r' }], format: 'armored' });
  console.log(JSON.stringify({ eccPub: a.publicKey, eccPriv: a.privateKey, rsaPub: b.publicKey, rsaPriv: b.privateKey }));
})();`

const pxNodeEncrypt = `
const openpgp = require('openpgp'); const fs = require('fs');
(async () => {
  const [pubFile, inFile, outArm, outBin] = process.argv.slice(2);
  const key = await openpgp.readKey({ armoredKey: fs.readFileSync(pubFile, 'utf8') });
  const message = await openpgp.createMessage({ binary: fs.readFileSync(inFile) });
  fs.writeFileSync(outArm, await openpgp.encrypt({ message, encryptionKeys: key, format: 'armored' }), 'utf-8');
  const m2 = await openpgp.createMessage({ binary: fs.readFileSync(inFile) });
  fs.writeFileSync(outBin, Buffer.from(await openpgp.encrypt({ message: m2, encryptionKeys: key, format: 'binary' })));
})();`

// Same as FileDecryptExecutor.decryptPGP.
const pxNodeDecrypt = `
const openpgp = require('openpgp'); const fs = require('fs');
(async () => {
  const [privFile, pass, inFile, outFile] = process.argv.slice(2);
  let privateKey = await openpgp.readPrivateKey({ armoredKey: fs.readFileSync(privFile, 'utf8') });
  if (pass && !privateKey.isDecrypted()) privateKey = await openpgp.decryptKey({ privateKey, passphrase: pass });
  const buf = fs.readFileSync(inFile); const content = buf.toString('utf-8');
  const message = content.includes('-----BEGIN PGP MESSAGE-----') ? await openpgp.readMessage({ armoredMessage: content }) : await openpgp.readMessage({ binaryMessage: buf });
  const { data } = await openpgp.decrypt({ message, decryptionKeys: privateKey, format: 'binary' });
  fs.writeFileSync(outFile, Buffer.from(data));
})();`

func TestPxportPGPInterop(t *testing.T) {
	pxSetupDB(t)
	var keys map[string]string
	o := strings.TrimSpace(pxNode(t, pxGenPGP))
	o = o[strings.LastIndex(o, "\n")+1:]
	if err := json.Unmarshal([]byte(o), &keys); err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	plain := make([]byte, 300000)
	_, _ = rand.Read(plain)
	src := filepath.Join(dir, "report.csv")
	_ = os.WriteFile(src, plain, 0o644)

	for _, kind := range []string{"ecc", "rsa"} {
		pass := ""
		if kind == "ecc" {
			pass = "pw"
		}
		id := "t_pxport_pgp_" + kind
		pxInsertKey(t, id, "pgp", keys[kind+"Pub"], keys[kind+"Priv"])
		pubF, privF := filepath.Join(dir, kind+".pub"), filepath.Join(dir, kind+".priv")
		_ = os.WriteFile(pubF, []byte(keys[kind+"Pub"]), 0o644)
		_ = os.WriteFile(privF, []byte(keys[kind+"Priv"]), 0o644)

		for _, armored := range []bool{true, false} {
			// Go encrypts → openpgp.js decrypts
			r, ctx := pxTestRun(t, map[string]any{"path": src}, nil)
			out, err := execFileEncrypt(r, &Node{ID: "enc", Data: map[string]any{"encryptionKeyId": id, "source": "input", "armor": armored}}, ctx)
			if err != nil {
				t.Fatal(kind, err)
			}
			f := asMap(out)["files"].([]any)[0].(map[string]any)
			if f["fileName"] != "report.csv.pgp" {
				t.Fatalf("name %v", f["fileName"])
			}
			encBytes, _ := os.ReadFile(f["path"].(string))
			if armored != bytes.HasPrefix(encBytes, []byte("-----BEGIN PGP MESSAGE-----")) {
				t.Fatalf("armor=%v but output starts %q", armored, encBytes[:20])
			}
			if armored && !regexp.MustCompile(`^-----BEGIN PGP MESSAGE-----\n\n([A-Za-z0-9+/]{60}\n)*[A-Za-z0-9+/=]{1,60}\n=[A-Za-z0-9+/]{4}\n-----END PGP MESSAGE-----\n$`).Match(encBytes) {
				t.Fatalf("armor layout differs from openpgp.js: %q", encBytes[len(encBytes)-60:])
			}
			dec := filepath.Join(dir, "node.dec")
			pxNode(t, pxNodeDecrypt, privF, pass, f["path"].(string), dec)
			got, _ := os.ReadFile(dec)
			if !bytes.Equal(got, plain) {
				t.Fatalf("%s armored=%v: openpgp.js decrypted wrong bytes", kind, armored)
			}
		}

		// openpgp.js encrypts → Go decrypts (armored and binary)
		arm, bin := filepath.Join(dir, kind+"-x.csv.asc"), filepath.Join(dir, kind+"-x.csv.gpg")
		pxNode(t, pxNodeEncrypt, pubF, src, arm, bin)
		for _, in := range []string{arm, bin} {
			r, ctx := pxTestRun(t, map[string]any{"files": []any{map[string]any{"path": in}}}, nil)
			out, err := execFileDecrypt(r, &Node{ID: "dec", Data: map[string]any{"encryptionKeyId": id, "passphrase": pass}}, ctx)
			if err != nil {
				t.Fatal(kind, in, err)
			}
			f := asMap(out)["files"].([]any)[0].(map[string]any)
			want := strings.TrimSuffix(filepath.Base(in), ".gpg")
			if strings.HasSuffix(in, ".asc") {
				want = filepath.Base(in) + ".decrypted" // .asc is not in the strip list
			}
			if f["fileName"] != want {
				t.Fatalf("decrypt name %v want %v", f["fileName"], want)
			}
			got, _ := os.ReadFile(f["path"].(string))
			if !bytes.Equal(got, plain) {
				t.Fatalf("%s: Go decrypted wrong bytes from %s", kind, in)
			}
		}
	}
}

const pxNodeRSA = `
const crypto = require('crypto'); const fs = require('fs');
const [mode, keyFile, inFile, outFile, alg] = process.argv.slice(2);
const key = fs.readFileSync(keyFile, 'utf8');
const MAGIC = Buffer.from('RSAH');
if (mode === 'hybrid-dec') { // FileDecryptExecutor.decryptRSAHybrid (new format)
  const b = fs.readFileSync(inFile); let o = 7; const kl = b.readUInt16BE(5);
  const ek = b.subarray(o, o + kl); o += kl; const iv = b.subarray(o, o + 12); o += 12;
  const ak = crypto.privateDecrypt({ key, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, ek);
  const d = crypto.createDecipheriv('aes-256-gcm', ak, iv); d.setAuthTag(b.subarray(b.length - 16));
  fs.writeFileSync(outFile, Buffer.concat([d.update(b.subarray(o, b.length - 16)), d.final()]));
} else if (mode === 'hybrid-enc') { // FileEncryptExecutor.encryptRSAHybrid
  const ak = crypto.randomBytes(32), iv = crypto.randomBytes(12);
  const ek = crypto.publicEncrypt({ key, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, ak);
  const kl = Buffer.alloc(2); kl.writeUInt16BE(ek.length);
  const c = crypto.createCipheriv('aes-256-gcm', ak, iv);
  const body = Buffer.concat([c.update(fs.readFileSync(inFile)), c.final()]);
  fs.writeFileSync(outFile, Buffer.concat([MAGIC, Buffer.from([1]), kl, ek, iv, body, c.getAuthTag()]));
} else if (mode === 'legacy-enc') { // legacy [keyLen][key][iv][tag][data], OAEP sha1
  const ak = crypto.randomBytes(32), iv = crypto.randomBytes(12);
  const ek = crypto.publicEncrypt({ key, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING }, ak);
  const kl = Buffer.alloc(2); kl.writeUInt16BE(ek.length);
  const c = crypto.createCipheriv('aes-256-gcm', ak, iv);
  const body = Buffer.concat([c.update(fs.readFileSync(inFile)), c.final()]);
  fs.writeFileSync(outFile, Buffer.concat([kl, ek, iv, c.getAuthTag(), body]));
} else if (mode === 'direct-dec') {
  fs.writeFileSync(outFile, crypto.privateDecrypt({ key, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, fs.readFileSync(inFile)));
} else if (mode === 'direct-enc') {
  fs.writeFileSync(outFile, crypto.publicEncrypt({ key, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, fs.readFileSync(inFile)));
} else if (mode === 'aes-dec') { // FileDecryptExecutor.decryptAES
  const k = Buffer.from(key, 'base64'); const b = fs.readFileSync(inFile); let out;
  if (alg.endsWith('-gcm')) { const d = crypto.createDecipheriv(alg, k, b.subarray(0, 12)); d.setAuthTag(b.subarray(b.length - 16)); out = Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()]); }
  else { const d = crypto.createDecipheriv(alg, k, b.subarray(0, 16)); out = Buffer.concat([d.update(b.subarray(16)), d.final()]); }
  fs.writeFileSync(outFile, out);
} else if (mode === 'aes-enc') {
  const k = Buffer.from(key, 'base64');
  if (alg.endsWith('-gcm')) { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv(alg, k, iv); const body = Buffer.concat([c.update(fs.readFileSync(inFile)), c.final()]); fs.writeFileSync(outFile, Buffer.concat([iv, body, c.getAuthTag()])); }
  else { const iv = crypto.randomBytes(16); const c = crypto.createCipheriv(alg, k, iv); fs.writeFileSync(outFile, Buffer.concat([iv, c.update(fs.readFileSync(inFile)), c.final()])); }
} else if (mode === 'pkcs8-enc') { // passphrase-protected PKCS#8, as older vault keys
  fs.writeFileSync(outFile, crypto.createPrivateKey(key).export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'secret' }));
}`

func TestPxportRSAAndAESInterop(t *testing.T) {
	pxSetupDB(t)
	dir := t.TempDir()
	pk, _ := rsa.GenerateKey(rand.Reader, 2048)
	der, _ := x509.MarshalPKCS8PrivateKey(pk)
	privPEM := string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}))
	pubDer, _ := x509.MarshalPKIXPublicKey(&pk.PublicKey)
	pubPEM := string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: pubDer}))
	privF, pubF := filepath.Join(dir, "k.pem"), filepath.Join(dir, "p.pem")
	_ = os.WriteFile(privF, []byte(privPEM), 0o644)
	_ = os.WriteFile(pubF, []byte(pubPEM), 0o644)
	encPrivF := filepath.Join(dir, "k.enc.pem")
	pxNode(t, pxNodeRSA, "pkcs8-enc", privF, "", encPrivF)
	encPriv, _ := os.ReadFile(encPrivF)

	big := make([]byte, 100000)
	_, _ = rand.Read(big)
	small := []byte("short secret payload")
	srcBig, srcSmall := filepath.Join(dir, "big.bin"), filepath.Join(dir, "small.txt")
	_ = os.WriteFile(srcBig, big, 0o644)
	_ = os.WriteFile(srcSmall, small, 0o644)

	pxInsertKey(t, "t_pxport_rsa", "rsa", pubPEM, privPEM)
	pxInsertKey(t, "t_pxport_rsaenc", "rsa", pubPEM, string(encPriv))
	pxInsertKey(t, "t_pxport_rsad", "rsa-direct", pubPEM, privPEM)

	enc := func(id, src string) string {
		r, ctx := pxTestRun(t, map[string]any{"localPath": src}, nil)
		out, err := execFileEncrypt(r, &Node{ID: "e", Data: map[string]any{"encryptionKeyId": id}}, ctx)
		if err != nil {
			t.Fatal(id, err)
		}
		f := asMap(out)["files"].([]any)[0].(map[string]any)
		if !strings.HasSuffix(f["fileName"].(string), ".enc") {
			t.Fatalf("name %v", f["fileName"])
		}
		return f["path"].(string)
	}
	dec := func(id, src, pass string) ([]byte, error) {
		r, ctx := pxTestRun(t, map[string]any{"path": src}, nil)
		out, err := execFileDecrypt(r, &Node{ID: "d", Data: map[string]any{"encryptionKeyId": id, "passphrase": pass}}, ctx)
		if err != nil {
			return nil, err
		}
		b, _ := os.ReadFile(asMap(out)["files"].([]any)[0].(map[string]any)["path"].(string))
		return b, nil
	}
	check := func(name string, got, want []byte) {
		if !bytes.Equal(got, want) {
			t.Fatalf("%s: bytes differ", name)
		}
	}

	// Go hybrid → Node; Node hybrid / legacy → Go
	gp := enc("t_pxport_rsa", srcBig)
	pxNode(t, pxNodeRSA, "hybrid-dec", privF, gp, filepath.Join(dir, "o1"))
	o1, _ := os.ReadFile(filepath.Join(dir, "o1"))
	check("go→node hybrid", o1, big)
	for _, mode := range []string{"hybrid-enc", "legacy-enc"} {
		np := filepath.Join(dir, mode+".enc")
		pxNode(t, pxNodeRSA, mode, pubF, srcBig, np)
		got, err := dec("t_pxport_rsa", np, "")
		if err != nil {
			t.Fatal(mode, err)
		}
		check(mode, got, big)
	}
	// passphrase-protected PKCS#8 private key
	if _, err := dec("t_pxport_rsaenc", gp, ""); err == nil || err.Error() != "RSA private key is passphrase-protected — re-import it with its passphrase in Secrets Vault" {
		t.Fatalf("want passphrase error, got %v", err)
	}
	got, err := dec("t_pxport_rsaenc", gp, "secret")
	if err != nil {
		t.Fatal(err)
	}
	check("pkcs8-encrypted key", got, big)

	// RSA direct
	gd := enc("t_pxport_rsad", srcSmall)
	pxNode(t, pxNodeRSA, "direct-dec", privF, gd, filepath.Join(dir, "o2"))
	o2, _ := os.ReadFile(filepath.Join(dir, "o2"))
	check("direct go→node", o2, small)
	nd := filepath.Join(dir, "nd.enc")
	pxNode(t, pxNodeRSA, "direct-enc", pubF, srcSmall, nd)
	got, err = dec("t_pxport_rsad", nd, "")
	if err != nil {
		t.Fatal(err)
	}
	check("direct node→go", got, small)
	r, ctx := pxTestRun(t, map[string]any{"path": srcBig}, nil)
	if _, err := execFileEncrypt(r, &Node{ID: "e", Data: map[string]any{"encryptionKeyId": "t_pxport_rsad"}}, ctx); err == nil ||
		err.Error() != "File too large for RSA Direct: 100000 bytes (max 446). Use RSA (hybrid) or AES instead." {
		t.Fatalf("got %v", err)
	}

	// AES, all six algorithms, both directions
	for _, alg := range []string{"aes-128-gcm", "aes-192-gcm", "aes-256-gcm", "aes-128-cbc", "aes-192-cbc", "aes-256-cbc"} {
		k := make([]byte, pxAESBits(alg))
		_, _ = rand.Read(k)
		b64 := base64.StdEncoding.EncodeToString(k)
		id := "t_pxport_" + alg
		pxInsertKey(t, id, alg, b64, b64)
		kf := filepath.Join(dir, alg+".key")
		_ = os.WriteFile(kf, []byte(b64), 0o644)
		gpath := enc(id, srcBig)
		pxNode(t, pxNodeRSA, "aes-dec", kf, gpath, filepath.Join(dir, alg+".o"), alg)
		o, _ := os.ReadFile(filepath.Join(dir, alg+".o"))
		check(alg+" go→node", o, big)
		npath := filepath.Join(dir, alg+".enc")
		pxNode(t, pxNodeRSA, "aes-enc", kf, srcBig, npath, alg)
		got, err := dec(id, npath, "")
		if err != nil {
			t.Fatal(alg, err)
		}
		check(alg+" node→go", got, big)
	}
	// tampered GCM
	tam := filepath.Join(dir, "tam.enc")
	b, _ := os.ReadFile(enc("t_pxport_aes-256-gcm", srcSmall))
	b[14] ^= 1
	_ = os.WriteFile(tam, b, 0o644)
	if _, err := dec("t_pxport_aes-256-gcm", tam, ""); err == nil || err.Error() != "Unsupported state or unable to authenticate data" {
		t.Fatalf("got %v", err)
	}
}

func TestPxportCryptBasketAndErrors(t *testing.T) {
	pxSetupDB(t)
	dir := t.TempDir()
	k := make([]byte, 32)
	_, _ = rand.Read(k)
	b64 := base64.StdEncoding.EncodeToString(k)
	pxInsertKey(t, "t_pxport_bk", "aes-256-cbc", b64, b64)
	pxInsertKey(t, "t_pxport_nopub", "pgp", "", "")
	inDir, outDir := filepath.Join(dir, "in"), filepath.Join(dir, "out")
	_ = os.MkdirAll(inDir, 0o755)
	for _, n := range []string{"a.csv", "b.csv", "c.txt"} {
		_ = os.WriteFile(filepath.Join(inDir, n), []byte(n), 0o644)
	}
	if _, err := appExec(`INSERT INTO baskets (id, "projectId", name, path, "updatedAt") VALUES ('t_pxport_src','t_pxport_proj','src',$1,now()),('t_pxport_out','t_pxport_proj','out',$2,now())`, inDir, outDir); err != nil {
		t.Fatal(err)
	}
	if _, err := appExec(`INSERT INTO processing_sessions (id, "basketId", "batchName", status) VALUES ('t_pxport_sess','t_pxport_out','b','open')`); err != nil {
		t.Fatal(err)
	}
	for i, n := range []string{"a.csv", "b.csv", "c.txt"} {
		if _, err := appExec(`INSERT INTO basket_files (id, "basketId", "fileName", "originalName", size, "mimeType", path, status, "updatedAt") VALUES ($1,'t_pxport_src',$2,$2,5,'text/csv',$3,'uploaded',now())`,
			"t_pxport_f"+string(rune('0'+i)), n, filepath.Join(inDir, n)); err != nil {
			t.Fatal(err)
		}
	}
	r, ctx := pxTestRun(t, nil, nil)
	out, err := execFileEncrypt(r, &Node{ID: "e", Data: map[string]any{"encryptionKeyId": "t_pxport_bk", "source": "basket", "basketId": "t_pxport_src",
		"filePattern": "*.csv", "outputDestination": "basket", "outputBasketId": "t_pxport_out", "outputFileName": "{{baseName}}_x{{ext}}.aes"}}, ctx)
	if err != nil {
		t.Fatal(err)
	}
	if n := asMap(out)["filesProcessed"]; n != float64(2) {
		t.Fatalf("filesProcessed %v", n)
	}
	rows, _ := appQuery(`SELECT "fileName", "sessionId", status, metadata, "mimeType", path FROM basket_files WHERE "basketId"='t_pxport_out' ORDER BY "fileName"`)
	if len(rows) != 2 || rows[0]["fileName"] != "a_x.csv.aes" || rows[0]["sessionId"] != "t_pxport_sess" || rows[0]["status"] != "uploaded" ||
		rows[0]["metadata"] != `{"encrypted":true}` || rows[0]["mimeType"] != "application/octet-stream" || rows[0]["path"] != filepath.Join(outDir, "a_x.csv.aes") {
		t.Fatalf("rows %v", rows)
	}
	// decrypt back from the basket, default name strips .aes
	out, err = execFileDecrypt(r, &Node{ID: "d", Data: map[string]any{"encryptionKeyId": "t_pxport_bk", "source": "basket", "basketId": "t_pxport_out", "filePattern": "a_*"}}, ctx)
	if err != nil {
		t.Fatal(err)
	}
	f := asMap(out)["files"].([]any)[0].(map[string]any)
	if b, _ := os.ReadFile(f["path"].(string)); f["fileName"] != "a_x.csv" || string(b) != "a.csv" {
		t.Fatalf("got %v %q", f["fileName"], b)
	}
	if len(r.logs) < 3 || (r.logs[0].Message != "Encrypting a.csv (0.0MB) with AES-256-CBC" && r.logs[1].Message != "Encrypting a.csv (0.0MB) with AES-256-CBC") || r.logs[2].Message != "Encrypted 2 file(s) with AES-256-CBC" {
		t.Fatalf("log %v", r.logs)
	}

	for _, c := range []struct {
		data map[string]any
		fn   nativeFn
		want string
	}{
		{map[string]any{}, execFileEncrypt, "Encryption key ID is required"},
		{map[string]any{"encryptionKeyId": "t_pxport_none"}, execFileEncrypt, "Encryption key not found: t_pxport_none"},
		{map[string]any{"encryptionKeyId": "t_pxport_nopub"}, execFileEncrypt, "Public key not set for key: t_pxport_nopub"},
		{map[string]any{"encryptionKeyId": "t_pxport_nopub"}, execFileDecrypt, "Private/secret key not set for key: t_pxport_nopub. Cannot decrypt with imported public keys."},
		{map[string]any{"encryptionKeyId": "t_pxport_bk"}, execFileEncrypt, "No files found to encrypt"},
		{map[string]any{"encryptionKeyId": "t_pxport_bk", "source": "basket"}, execFileDecrypt, "Basket ID is required for basket source"},
	} {
		if _, err := c.fn(r, &Node{ID: "x", Data: c.data}, ctx); err == nil || err.Error() != c.want {
			t.Fatalf("want %q got %v", c.want, err)
		}
	}
	if got := pxToFixed(0.25, 1); got != "0.3" {
		t.Fatalf("toFixed %s", got)
	}
	if got := pxToFixed(1.005, 2); got != "1.00" {
		t.Fatalf("toFixed %s", got)
	}
}
