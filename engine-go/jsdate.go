package main

// JavaScript Date semantics for time.Time values: the Node executors get Date
// objects from Prisma, so String(date) is Date.prototype.toString (local time
// with V8's long zone name) and JSON.stringify(date) is toISOString().

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// V8 (ICU) long names for common zones; others fall back to Go's abbreviation.
var zoneLongNames = map[string][2]string{ // IANA name → {standard, daylight}
	"UTC":                 {"Coordinated Universal Time", "Coordinated Universal Time"},
	"Etc/UTC":             {"Coordinated Universal Time", "Coordinated Universal Time"},
	"Asia/Bangkok":        {"Indochina Time", "Indochina Time"},
	"Asia/Ho_Chi_Minh":    {"Indochina Time", "Indochina Time"},
	"Asia/Vientiane":      {"Indochina Time", "Indochina Time"},
	"Asia/Phnom_Penh":     {"Indochina Time", "Indochina Time"},
	"Asia/Jakarta":        {"Western Indonesia Time", "Western Indonesia Time"},
	"Asia/Singapore":      {"Singapore Standard Time", "Singapore Standard Time"},
	"Asia/Kuala_Lumpur":   {"Malaysia Time", "Malaysia Time"},
	"Asia/Manila":         {"Philippine Standard Time", "Philippine Summer Time"},
	"Asia/Hong_Kong":      {"Hong Kong Standard Time", "Hong Kong Summer Time"},
	"Asia/Shanghai":       {"China Standard Time", "China Daylight Time"},
	"Asia/Tokyo":          {"Japan Standard Time", "Japan Daylight Time"},
	"Asia/Seoul":          {"Korean Standard Time", "Korean Daylight Time"},
	"Asia/Kolkata":        {"India Standard Time", "India Standard Time"},
	"Europe/London":       {"Greenwich Mean Time", "British Summer Time"},
	"Europe/Berlin":       {"Central European Standard Time", "Central European Summer Time"},
	"Europe/Paris":        {"Central European Standard Time", "Central European Summer Time"},
	"America/New_York":    {"Eastern Standard Time", "Eastern Daylight Time"},
	"America/Chicago":     {"Central Standard Time", "Central Daylight Time"},
	"America/Los_Angeles": {"Pacific Standard Time", "Pacific Daylight Time"},
	"Australia/Sydney":    {"Australian Eastern Standard Time", "Australian Eastern Daylight Time"},
}

var localZoneName = sync.OnceValue(func() string {
	if tz := os.Getenv("TZ"); tz != "" {
		return strings.TrimPrefix(tz, ":")
	}
	if p, err := filepath.EvalSymlinks("/etc/localtime"); err == nil {
		if i := strings.Index(p, "zoneinfo/"); i >= 0 {
			return p[i+len("zoneinfo/"):]
		}
	}
	return ""
})

// jsDateString is Date.prototype.toString(), e.g.
// "Thu Jan 01 2026 07:00:00 GMT+0700 (Indochina Time)".
func jsDateString(t time.Time) string {
	t = t.Local()
	abbr, off := t.Zone()
	name := abbr
	if names, ok := zoneLongNames[localZoneName()]; ok {
		if t.IsDST() {
			name = names[1]
		} else {
			name = names[0]
		}
	}
	sign := "+"
	if off < 0 {
		sign, off = "-", -off
	}
	return fmt.Sprintf("%s GMT%s%02d%02d (%s)", t.Format("Mon Jan 02 2006 15:04:05"), sign, off/3600, (off%3600)/60, name)
}

// jsISO is Date.prototype.toISOString().
func jsISO(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }
