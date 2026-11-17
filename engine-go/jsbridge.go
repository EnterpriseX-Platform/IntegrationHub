package main

// Go values seen from JavaScript (goja) the way the Node executors see them:
// objects are live (a transform that edits vars.x.y edits the context, as in
// Node), Object.keys / for-in / JSON.stringify follow JavaScript key order,
// and values returned from JS keep their key order back in Go.

import (
	"strconv"

	"github.com/dop251/goja"
)

// jsIn wraps a Go value for use in a goja runtime.
func jsIn(vm *goja.Runtime, v any) goja.Value {
	switch t := v.(type) {
	case map[string]any:
		if t == nil {
			return goja.Null()
		}
		return vm.NewDynamicObject(&jsMapObj{vm: vm, m: t})
	case []any:
		return vm.NewDynamicArray(&jsArrObj{vm: vm, a: &t})
	case nil:
		return goja.Null()
	}
	return vm.ToValue(v)
}

type jsMapObj struct {
	vm *goja.Runtime
	m  map[string]any
}

func (o *jsMapObj) Get(k string) goja.Value {
	v, ok := o.m[k]
	if !ok {
		return nil // undefined
	}
	return jsIn(o.vm, v)
}

func (o *jsMapObj) Set(k string, v goja.Value) bool {
	_, existed := o.m[k]
	o.m[k] = jsOut(v)
	if !existed {
		jsOrder(o.m, appendKey(o.m, k))
	}
	return true
}

// appendKey: current order with k moved to the end (it was just added).
func appendKey(m map[string]any, k string) []string {
	keys := jsKeys(m)
	out := make([]string, 0, len(keys))
	for _, x := range keys {
		if x != k {
			out = append(out, x)
		}
	}
	return append(out, k)
}

func (o *jsMapObj) Has(k string) bool { _, ok := o.m[k]; return ok }

func (o *jsMapObj) Delete(k string) bool { delete(o.m, k); return true }

func (o *jsMapObj) Keys() []string { return jsKeys(o.m) }

type jsArrObj struct {
	vm *goja.Runtime
	a  *[]any
}

func (o *jsArrObj) Len() int { return len(*o.a) }

func (o *jsArrObj) Get(i int) goja.Value {
	if i < 0 || i >= len(*o.a) {
		return nil
	}
	return jsIn(o.vm, (*o.a)[i])
}

func (o *jsArrObj) Set(i int, v goja.Value) bool {
	if i < 0 {
		return false
	}
	for len(*o.a) <= i {
		*o.a = append(*o.a, nil)
	}
	(*o.a)[i] = jsOut(v)
	return true
}

func (o *jsArrObj) SetLen(n int) bool {
	if n < len(*o.a) {
		*o.a = (*o.a)[:n]
	}
	for len(*o.a) < n {
		*o.a = append(*o.a, nil)
	}
	return true
}

// jsOut converts a goja value to plain Go data (map[string]any, []any,
// float64, string, bool, nil), keeping object key order.
func jsOut(v goja.Value) any {
	if v == nil || goja.IsUndefined(v) || goja.IsNull(v) {
		return nil
	}
	o, isObj := v.(*goja.Object)
	if !isObj {
		switch x := v.Export().(type) {
		case int64:
			return float64(x)
		case float64, string, bool:
			return x
		}
		return v.Export()
	}
	// a live Go map/array handed to JS comes back as the same Go value
	switch x := o.Export().(type) {
	case *jsMapObj:
		return x.m
	case *jsArrObj:
		return *x.a
	}
	switch o.ClassName() {
	case "Array":
		return jsOutArray(o)
	case "Date":
		// JSON value of a Date, as JSON.stringify would write it
		if f, ok := o.Get("toISOString").Export().(func(goja.FunctionCall) goja.Value); ok {
			return f(goja.FunctionCall{This: o}).String()
		}
		return o.String()
	case "Function":
		return nil
	}
	keys := o.Keys()
	m := make(map[string]any, len(keys))
	for _, k := range keys {
		m[k] = jsOut(o.Get(k))
	}
	jsOrder(m, keys)
	return m
}

func jsOutArray(o *goja.Object) []any {
	n := int(o.Get("length").ToInteger())
	out := make([]any, n)
	for i := 0; i < n; i++ {
		out[i] = jsOut(o.Get(strconv.Itoa(i)))
	}
	return out
}
