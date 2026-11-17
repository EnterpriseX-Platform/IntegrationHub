package main

import (
	"crypto/rand"
	"math/big"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

// cuid produces ids in the cuid v1 format Prisma uses for @default(cuid()):
// "c" + timestamp + counter + fingerprint + random, base36, 25 chars total.
var cuidCounter int64

func cuid() string {
	const base = 36
	pad := func(s string, n int) string {
		if len(s) >= n {
			return s[len(s)-n:]
		}
		return strings.Repeat("0", n-len(s)) + s
	}
	ts := strconv.FormatInt(time.Now().UnixMilli(), base)
	cnt := pad(strconv.FormatInt(atomic.AddInt64(&cuidCounter, 1)%(base*base*base*base), base), 4)
	host, _ := os.Hostname()
	sum := 0
	for _, c := range host {
		sum += int(c)
	}
	fp := pad(strconv.FormatInt(int64(os.Getpid()%(base*base)), base), 2) + pad(strconv.FormatInt(int64(sum+len(host)+base), base), 2)
	rnd := func() string {
		n, _ := rand.Int(rand.Reader, big.NewInt(base*base*base*base))
		return pad(strconv.FormatInt(n.Int64(), base), 4)
	}
	return "c" + pad(ts, 8) + cnt + fp + rnd() + rnd()
}
