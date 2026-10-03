package main

// JSON the way JavaScript sees it. The 1.x CLI printed JSON.parse →
// JSON.stringify round trips, so the port keeps key insertion order,
// JS number formatting and JS string escaping instead of Go's sorted,
// HTML-escaped encoding/json output.
//
// Values are nil, bool, float64, string, []any or *object.

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

// object is a JSON object that remembers key insertion order.
type object struct {
	keys []string
	vals map[string]any
}

func newObject() *object {
	return &object{vals: map[string]any{}}
}

func (o *object) Get(key string) (any, bool) {
	v, ok := o.vals[key]
	return v, ok
}

// Set replaces a value in place, or appends a new key.
func (o *object) Set(key string, value any) {
	if _, ok := o.vals[key]; !ok {
		o.keys = append(o.keys, key)
	}
	o.vals[key] = value
}

func (o *object) Delete(key string) {
	if _, ok := o.vals[key]; !ok {
		return
	}
	delete(o.vals, key)
	for i, k := range o.keys {
		if k == key {
			o.keys = append(o.keys[:i], o.keys[i+1:]...)
			break
		}
	}
}

func (o *object) Len() int { return len(o.keys) }

// Merge sets every key of other onto o, like {...o, ...other}.
func (o *object) Merge(other *object) {
	for _, k := range other.keys {
		o.Set(k, other.vals[k])
	}
}

func (o *object) Clone() *object {
	c := newObject()
	c.Merge(o)
	return c
}

// orderedKeys lists keys in JS property order: array-index keys first in
// ascending numeric order, then the rest in insertion order.
func (o *object) orderedKeys() []string {
	var indexes, rest []string
	for _, k := range o.keys {
		if isArrayIndex(k) {
			indexes = append(indexes, k)
		} else {
			rest = append(rest, k)
		}
	}
	if len(indexes) == 0 {
		return rest
	}
	sort.Slice(indexes, func(i, j int) bool {
		a, _ := strconv.ParseUint(indexes[i], 10, 64)
		b, _ := strconv.ParseUint(indexes[j], 10, 64)
		return a < b
	})
	return append(indexes, rest...)
}

func isArrayIndex(key string) bool {
	if key == "" || (len(key) > 1 && key[0] == '0') {
		return false
	}
	n, err := strconv.ParseUint(key, 10, 64)
	return err == nil && n < 4294967295
}

// MarshalJSON lets an *object be sent as a request body through the SDK.
func (o *object) MarshalJSON() ([]byte, error) {
	return []byte(stringify(o, false)), nil
}

// parseJSON mirrors JSON.parse: one value, nothing after it.
func parseJSON(text string) (any, error) {
	dec := json.NewDecoder(strings.NewReader(text))
	dec.UseNumber()
	value, err := decodeValue(dec)
	if err != nil {
		return nil, err
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, errors.New("unexpected data after JSON value")
	}
	return value, nil
}

func decodeValue(dec *json.Decoder) (any, error) {
	tok, err := dec.Token()
	if err == io.EOF {
		return nil, io.ErrUnexpectedEOF
	}
	if err != nil {
		return nil, err
	}
	switch t := tok.(type) {
	case json.Delim:
		if t == '{' {
			obj := newObject()
			for dec.More() {
				keyTok, err := dec.Token()
				if err != nil {
					return nil, err
				}
				key, _ := keyTok.(string)
				value, err := decodeValue(dec)
				if err != nil {
					return nil, err
				}
				obj.Set(key, value)
			}
			if _, err := dec.Token(); err != nil {
				return nil, err
			}
			return obj, nil
		}
		list := []any{}
		for dec.More() {
			value, err := decodeValue(dec)
			if err != nil {
				return nil, err
			}
			list = append(list, value)
		}
		if _, err := dec.Token(); err != nil {
			return nil, err
		}
		return list, nil
	case json.Number:
		f, err := strconv.ParseFloat(string(t), 64)
		if err != nil && !errors.Is(err, strconv.ErrRange) {
			return nil, err
		}
		return f, nil
	default:
		return t, nil
	}
}

// stringify mirrors JSON.stringify(value, null, pretty ? 2 : 0).
func stringify(value any, pretty bool) string {
	var buf bytes.Buffer
	writeValue(&buf, value, pretty, "")
	return buf.String()
}

func writeValue(buf *bytes.Buffer, value any, pretty bool, indent string) {
	switch v := value.(type) {
	case nil:
		buf.WriteString("null")
	case bool:
		buf.WriteString(strconv.FormatBool(v))
	case float64:
		buf.WriteString(jsNumber(v))
	case int:
		buf.WriteString(strconv.Itoa(v))
	case string:
		writeString(buf, v)
	case []any:
		if len(v) == 0 {
			buf.WriteString("[]")
			return
		}
		inner := indent + "  "
		buf.WriteByte('[')
		for i, item := range v {
			if i > 0 {
				buf.WriteByte(',')
			}
			if pretty {
				buf.WriteString("\n" + inner)
			}
			writeValue(buf, item, pretty, inner)
		}
		if pretty {
			buf.WriteString("\n" + indent)
		}
		buf.WriteByte(']')
	case *object:
		if v.Len() == 0 {
			buf.WriteString("{}")
			return
		}
		inner := indent + "  "
		buf.WriteByte('{')
		for i, k := range v.orderedKeys() {
			if i > 0 {
				buf.WriteByte(',')
			}
			if pretty {
				buf.WriteString("\n" + inner)
			}
			writeString(buf, k)
			buf.WriteByte(':')
			if pretty {
				buf.WriteByte(' ')
			}
			writeValue(buf, v.vals[k], pretty, inner)
		}
		if pretty {
			buf.WriteString("\n" + indent)
		}
		buf.WriteByte('}')
	}
}

func writeString(buf *bytes.Buffer, s string) {
	const hex = "0123456789abcdef"
	buf.WriteByte('"')
	for i := 0; i < len(s); {
		c := s[i]
		if c >= utf8.RuneSelf {
			r, size := utf8.DecodeRuneInString(s[i:])
			if r == utf8.RuneError && size == 1 {
				buf.WriteString(`�`)
			} else {
				buf.WriteString(s[i : i+size])
			}
			i += size
			continue
		}
		switch c {
		case '"':
			buf.WriteString(`\"`)
		case '\\':
			buf.WriteString(`\\`)
		case '\b':
			buf.WriteString(`\b`)
		case '\f':
			buf.WriteString(`\f`)
		case '\n':
			buf.WriteString(`\n`)
		case '\r':
			buf.WriteString(`\r`)
		case '\t':
			buf.WriteString(`\t`)
		default:
			if c < 0x20 {
				buf.WriteString(`\u00`)
				buf.WriteByte(hex[c>>4])
				buf.WriteByte(hex[c&0xf])
			} else {
				buf.WriteByte(c)
			}
		}
		i++
	}
	buf.WriteByte('"')
}

// jsNumber formats a float64 the way JavaScript's Number#toString does.
func jsNumber(f float64) string {
	if f != f || f > 1.7976931348623157e308 || f < -1.7976931348623157e308 {
		return "null" // NaN and ±Infinity stringify to null
	}
	if f == 0 {
		return "0"
	}
	sign := ""
	if f < 0 {
		sign = "-"
		f = -f
	}
	// Shortest round-trip digits, as d.ddde±x.
	e := strconv.FormatFloat(f, 'e', -1, 64)
	mantissa, expText, _ := strings.Cut(e, "e")
	digits := strings.Replace(mantissa, ".", "", 1)
	exp, _ := strconv.Atoi(expText)
	k := len(digits)
	n := exp + 1 // decimal point position relative to the digits

	switch {
	case k <= n && n <= 21:
		return sign + digits + strings.Repeat("0", n-k)
	case 0 < n && n <= 21:
		return sign + digits[:n] + "." + digits[n:]
	case -6 < n && n <= 0:
		return sign + "0." + strings.Repeat("0", -n) + digits
	}
	expSign := "+"
	if n-1 < 0 {
		expSign = "-"
	}
	out := digits[:1]
	if k > 1 {
		out += "." + digits[1:]
	}
	return sign + out + "e" + expSign + strconv.Itoa(abs(n-1))
}

func abs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}

// jsString mirrors String(value) for the values the CLI handles.
func jsString(value any) string {
	switch v := value.(type) {
	case nil:
		return "null"
	case string:
		return v
	case bool:
		return strconv.FormatBool(v)
	case float64:
		return jsNumber(v)
	case int:
		return strconv.Itoa(v)
	case []any:
		parts := make([]string, len(v))
		for i, item := range v {
			if item != nil {
				parts[i] = jsString(item)
			}
		}
		return strings.Join(parts, ",")
	default:
		return "[object Object]"
	}
}

// truthy mirrors JavaScript truthiness.
func truthy(value any) bool {
	switch v := value.(type) {
	case nil:
		return false
	case bool:
		return v
	case string:
		return v != ""
	case float64:
		return v != 0 && v == v
	case int:
		return v != 0
	default:
		return true
	}
}
