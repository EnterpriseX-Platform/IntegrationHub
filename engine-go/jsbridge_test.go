package main

import (
	"testing"

	"github.com/dop251/goja"
)

func TestJsBridgeOrderAndLive(t *testing.T) {
	row := map[string]any{"code": "A1", "ชื่อ": "x", "amount": "10"}
	jsOrder(row, []string{"code", "ชื่อ", "amount"})
	vars := map[string]any{"r": row}
	vm := goja.New()
	fn, err := vm.RunString(`(function(input, vars){ vars.r.added = 1; return { keys: Object.keys(input), json: JSON.stringify(input), back: input, z: 1, a: 2 }; })`)
	if err != nil {
		t.Fatal(err)
	}
	call, _ := goja.AssertFunction(fn)
	ret, err := call(goja.Undefined(), jsIn(vm, row), jsIn(vm, vars))
	if err != nil {
		t.Fatal(err)
	}
	out := jsOut(ret).(map[string]any)
	if got := string(jsEncode(out["keys"])); got != `["code","ชื่อ","amount","added"]` {
		t.Fatalf("keys %s", got)
	}
	if got := out["json"]; got != `{"code":"A1","ชื่อ":"x","amount":"10","added":1}` {
		t.Fatalf("json %v", got)
	}
	if row["added"] != float64(1) && row["added"] != int64(1) {
		t.Fatalf("live edit lost: %v", row["added"])
	}
	if got := string(jsEncode(out)); got != `{"keys":["code","ชื่อ","amount","added"],"json":"{\"code\":\"A1\",\"ชื่อ\":\"x\",\"amount\":\"10\",\"added\":1}","back":{"code":"A1","ชื่อ":"x","amount":"10","added":1},"z":1,"a":2}` {
		t.Fatalf("returned order %s", got)
	}
	if got := string(jsEncode(row)); got != `{"code":"A1","ชื่อ":"x","amount":"10","added":1}` {
		t.Fatalf("row after edit %s", got)
	}
}
