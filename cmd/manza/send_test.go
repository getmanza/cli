package main

import "testing"

func TestPathWithQueryMatchesURLSearchParams(t *testing.T) {
	query := func(pairs ...string) *object {
		o := newObject()
		for i := 0; i < len(pairs); i += 2 {
			o.Set(pairs[i], pairs[i+1])
		}
		return o
	}
	cases := []struct {
		path  string
		query *object
		want  string
	}{
		{"/api/invoices", query("limit", "2"), "/api/invoices?limit=2"},
		{"/api/echo?k=v&s=a b", nil, "/api/echo?k=v&s=a%20b"},
		{"/api/echo?s=é#frag", nil, "/api/echo?s=%C3%A9"},
		{"/api/echo?already=%20ok", query(), "/api/echo?already=%20ok"},
		{"/api/echo?k=v&s=a b&k=w", query("k", "z", "x", "1"), "/api/echo?k=z&s=a+b&x=1"},
		{"/api/echo?q=a%2Bb", query("x", ""), "/api/echo?q=a%2Bb&x="},
	}
	for _, c := range cases {
		if got := pathWithQuery(c.path, c.query); got != c.want {
			t.Errorf("pathWithQuery(%q) = %q, want %q", c.path, got, c.want)
		}
	}
}
