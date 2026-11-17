package main

// JSON.parse with V8's error messages (Node 23), for parseAs 'json'.

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

type fioJP struct {
	s     string
	pos   int // byte offset
	depth int
	idx0  bool     // parsing element 0 of the top-level array
	keys  []string // key order of that element, if it is an object
	got   bool
}

func fioJSONParse(s string) (any, error) {
	v, _, err := fioJSONParseOrder(s)
	return v, err
}

// fioJSONParseOrder also returns the key order of the first element when the
// document is an array whose first element is an object.
func fioJSONParseOrder(s string) (any, []string, error) {
	p := &fioJP{s: s}
	v, err := p.parse()
	if err != nil {
		return nil, nil, err
	}
	if !p.got {
		return v, nil, nil
	}
	return v, p.keys, nil
}

func (p *fioJP) parse() (any, error) {
	p.ws()
	v, err := p.value()
	if err != nil {
		return nil, err
	}
	p.ws()
	if p.pos < len(p.s) {
		return nil, p.at("Unexpected non-whitespace character after JSON")
	}
	return v, nil
}

func (p *fioJP) u16pos(b int) int { return fioLen16(p.s[:b]) }

func (p *fioJP) at(msg string) error {
	pos := p.u16pos(p.pos)
	pre := p.s[:p.pos]
	line := strings.Count(pre, "\n") + 1
	col := pos + 1
	if i := strings.LastIndex(pre, "\n"); i >= 0 {
		col = fioLen16(pre[i+1:]) + 1
	}
	return fmt.Errorf("%s in JSON at position %d (line %d column %d)", msg, pos, line, col)
}

func (p *fioJP) unexpected() error {
	if p.pos >= len(p.s) {
		return errors.New("Unexpected end of JSON input")
	}
	r, _ := utf8.DecodeRuneInString(p.s[p.pos:])
	u := utf16.Encode([]rune(p.s))
	n := len(u)
	pos := p.u16pos(p.pos)
	tok := string(r)
	if n < 21 {
		return fmt.Errorf(`Unexpected token '%s', "%s" is not valid JSON`, tok, p.s)
	}
	start, end := pos-10, pos+10
	pre, post := "...", "..."
	if start <= 0 {
		start, pre = 0, ""
	}
	if end >= n {
		end, post = n, ""
	}
	return fmt.Errorf(`Unexpected token '%s', %s"%s"%s is not valid JSON`, tok, pre, string(utf16.Decode(u[start:end])), post)
}

func (p *fioJP) ws() {
	for p.pos < len(p.s) {
		switch p.s[p.pos] {
		case ' ', '\t', '\n', '\r':
			p.pos++
		default:
			return
		}
	}
}

func (p *fioJP) value() (any, error) {
	if p.pos >= len(p.s) {
		return nil, errors.New("Unexpected end of JSON input")
	}
	switch c := p.s[p.pos]; {
	case c == '{':
		return p.object()
	case c == '[':
		return p.array()
	case c == '"':
		return p.str()
	case c == '-' || (c >= '0' && c <= '9'):
		return p.number()
	default:
		for lit, v := range map[string]any{"true": true, "false": false, "null": nil} {
			if strings.HasPrefix(p.s[p.pos:], lit) {
				p.pos += len(lit)
				return v, nil
			}
			if rest := p.s[p.pos:]; len(rest) < len(lit) && strings.HasPrefix(lit, rest) {
				p.pos = len(p.s)
				return nil, errors.New("Unexpected end of JSON input")
			}
		}
		for lit := range map[string]bool{"true": true, "false": true, "null": true} {
			if lit[0] == c {
				i := 0
				for i < len(lit) && p.pos+i < len(p.s) && p.s[p.pos+i] == lit[i] {
					i++
				}
				p.pos += i
				return nil, p.unexpected()
			}
		}
		return nil, p.unexpected()
	}
}

func (p *fioJP) object() (any, error) {
	p.pos++
	m := map[string]any{}
	var order []string
	defer func() { jsOrder(m, order) }()
	record := p.depth == 1 && p.idx0 && !p.got
	if record {
		p.got = true
	}
	p.depth++
	defer func() { p.depth-- }()
	p.ws()
	if p.pos < len(p.s) && p.s[p.pos] == '}' {
		p.pos++
		return m, nil
	}
	first := true
	for {
		p.ws()
		if p.pos >= len(p.s) {
			return nil, errors.New("Unexpected end of JSON input")
		}
		if p.s[p.pos] != '"' {
			if first {
				return nil, p.at("Expected property name or '}'")
			}
			return nil, p.at("Expected double-quoted property name")
		}
		first = false
		k, err := p.str()
		if err != nil {
			return nil, err
		}
		p.ws()
		if p.pos >= len(p.s) {
			return nil, errors.New("Unexpected end of JSON input")
		}
		if p.s[p.pos] != ':' {
			return nil, p.at("Expected ':' after property name")
		}
		p.pos++
		p.ws()
		v, err := p.value()
		if err != nil {
			return nil, err
		}
		if _, dup := m[k.(string)]; !dup {
			order = append(order, k.(string))
		}
		m[k.(string)] = v
		if record {
			p.keys = append(p.keys, k.(string))
		}
		p.ws()
		if p.pos >= len(p.s) {
			return nil, errors.New("Unexpected end of JSON input")
		}
		switch p.s[p.pos] {
		case ',':
			p.pos++
		case '}':
			p.pos++
			return m, nil
		default:
			return nil, p.at("Expected ',' or '}' after property value")
		}
	}
}

func (p *fioJP) array() (any, error) {
	p.pos++
	a := []any{}
	top := p.depth == 0
	p.depth++
	defer func() { p.depth-- }()
	p.ws()
	if p.pos < len(p.s) && p.s[p.pos] == ']' {
		p.pos++
		return a, nil
	}
	for {
		p.ws()
		p.idx0 = top && len(a) == 0
		v, err := p.value()
		p.idx0 = false
		if err != nil {
			return nil, err
		}
		a = append(a, v)
		p.ws()
		if p.pos >= len(p.s) {
			return nil, errors.New("Unexpected end of JSON input")
		}
		switch p.s[p.pos] {
		case ',':
			p.pos++
			p.ws()
			if p.pos < len(p.s) && p.s[p.pos] == ']' {
				return nil, p.unexpected()
			}
		case ']':
			p.pos++
			return a, nil
		default:
			return nil, p.at("Expected ',' or ']' after array element")
		}
	}
}

func (p *fioJP) str() (any, error) {
	p.pos++
	var b strings.Builder
	for {
		if p.pos >= len(p.s) {
			return nil, p.at("Unterminated string")
		}
		c := p.s[p.pos]
		switch {
		case c == '"':
			p.pos++
			return b.String(), nil
		case c < 0x20:
			return nil, p.at("Bad control character in string literal")
		case c == '\\':
			if p.pos+1 >= len(p.s) {
				p.pos++
				return nil, p.at("Unterminated string")
			}
			e := p.s[p.pos+1]
			simple := map[byte]string{'"': `"`, '\\': `\`, '/': "/", 'b': "\b", 'f': "\f", 'n': "\n", 'r': "\r", 't': "\t"}
			if x, ok := simple[e]; ok {
				b.WriteString(x)
				p.pos += 2
				continue
			}
			if e == 'u' {
				if p.pos+6 > len(p.s) {
					p.pos++
					return nil, p.at("Bad Unicode escape")
				}
				n, err := strconv.ParseUint(p.s[p.pos+2:p.pos+6], 16, 16)
				if err != nil {
					p.pos++
					return nil, p.at("Bad Unicode escape")
				}
				p.pos += 6
				r := rune(n)
				if utf16.IsSurrogate(r) && strings.HasPrefix(p.s[p.pos:], `\u`) && p.pos+6 <= len(p.s) {
					if n2, err := strconv.ParseUint(p.s[p.pos+2:p.pos+6], 16, 16); err == nil {
						if rr := utf16.DecodeRune(r, rune(n2)); rr != utf8.RuneError {
							b.WriteRune(rr)
							p.pos += 6
							continue
						}
					}
				}
				b.WriteRune(r)
				continue
			}
			p.pos++
			return nil, p.at("Bad escaped character")
		default:
			r, n := utf8.DecodeRuneInString(p.s[p.pos:])
			b.WriteRune(r)
			p.pos += n
		}
	}
}

func (p *fioJP) number() (any, error) {
	start := p.pos
	if p.s[p.pos] == '-' {
		p.pos++
		if p.pos >= len(p.s) || p.s[p.pos] < '0' || p.s[p.pos] > '9' {
			return nil, p.at("No number after minus sign")
		}
	}
	if p.s[p.pos] == '0' {
		p.pos++
	} else {
		for p.pos < len(p.s) && p.s[p.pos] >= '0' && p.s[p.pos] <= '9' {
			p.pos++
		}
	}
	if p.pos < len(p.s) && p.s[p.pos] == '.' {
		p.pos++
		if p.pos >= len(p.s) || p.s[p.pos] < '0' || p.s[p.pos] > '9' {
			return nil, p.at("Unterminated fractional number")
		}
		for p.pos < len(p.s) && p.s[p.pos] >= '0' && p.s[p.pos] <= '9' {
			p.pos++
		}
	}
	if p.pos < len(p.s) && (p.s[p.pos] == 'e' || p.s[p.pos] == 'E') {
		p.pos++
		if p.pos < len(p.s) && (p.s[p.pos] == '+' || p.s[p.pos] == '-') {
			p.pos++
		}
		if p.pos >= len(p.s) || p.s[p.pos] < '0' || p.s[p.pos] > '9' {
			return nil, p.at("Exponent part is missing a number")
		}
		for p.pos < len(p.s) && p.s[p.pos] >= '0' && p.s[p.pos] <= '9' {
			p.pos++
		}
	}
	f, _ := strconv.ParseFloat(p.s[start:p.pos], 64)
	return f, nil
}
