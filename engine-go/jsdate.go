package main

// JavaScript Date semantics for time.Time values: the Node executors get Date
// objects from Prisma, so String(date) is Date.prototype.toString (local time
// with V8's long zone name) and JSON.stringify(date) is toISOString().

import (
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/dop251/goja"
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

// jsPatchDate makes Date.prototype.toString in a goja runtime print the zone
// the way V8 does ("GMT+0700 (Indochina Time)"); goja prints the zone
// abbreviation, which for many zones is just "+07".
func jsPatchDate(vm *goja.Runtime) {
	proto := vm.Get("Date").ToObject(vm).Get("prototype").ToObject(vm)
	_ = proto.Set("toString", func(c goja.FunctionCall) goja.Value {
		t, ok := c.This.Export().(time.Time)
		if !ok {
			return vm.ToValue("Invalid Date")
		}
		ms := c.This.ToObject(vm).Get("getTime")
		if fn, isFn := goja.AssertFunction(ms); isFn {
			if v, err := fn(c.This); err == nil && math.IsNaN(v.ToFloat()) {
				return vm.ToValue("Invalid Date")
			}
		}
		return vm.ToValue(jsDateString(t))
	})
	jsPatchLocale(vm, proto)
}

// jsLocale is Date.prototype.toLocale{Date,Time,}String for the locales V8
// formats without options: en-US (Node's default) and th-TH (Buddhist year).
// Anything else needs ICU, so the node is handed to Node.
func jsLocale(t time.Time, locale string, part string) (string, bool) {
	t = t.Local()
	var date, tm, sep string
	switch locale {
	case "", "en-US", "en":
		date = fmt.Sprintf("%d/%d/%d", int(t.Month()), t.Day(), t.Year())
		tm = t.Format("3:04:05 PM")
		sep = ", "
	case "th-TH", "th":
		date = fmt.Sprintf("%d/%d/%d", t.Day(), int(t.Month()), t.Year()+543)
		tm = t.Format("15:04:05")
		sep = " "
	default:
		return "", false
	}
	switch part {
	case "date":
		return date, true
	case "time":
		return tm, true
	}
	return date + sep + tm, true
}

func jsPatchLocale(vm *goja.Runtime, proto *goja.Object) {
	for name, part := range map[string]string{"toLocaleDateString": "date", "toLocaleTimeString": "time", "toLocaleString": "both"} {
		part := part
		_ = proto.Set(name, func(c goja.FunctionCall) goja.Value {
			t, ok := c.This.Export().(time.Time)
			if !ok {
				return vm.ToValue("Invalid Date")
			}
			locale := ""
			if a := c.Argument(0); !goja.IsUndefined(a) && !goja.IsNull(a) {
				locale = a.String()
			}
			if o := c.Argument(1); goja.IsUndefined(o) || goja.IsNull(o) {
				if s, ok := jsLocale(t, locale, part); ok {
					return vm.ToValue(s)
				}
			}
			panic(vm.NewTypeError("ReferenceError: Intl is not defined"))
		})
	}
}
