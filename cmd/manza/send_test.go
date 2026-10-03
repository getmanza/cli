package main

import "testing"

func TestWithQueryEncodesARawPathQuery(t *testing.T) {
	cases := map[[2]string]string{
		{"/api/echo?k=v&s=a b", ""}:     "/api/echo?k=v&s=a%20b",
		{"/api/echo?s=é", "?x=1"}:       "/api/echo?s=%C3%A9&x=1",
		{"/api/echo?already=%20ok", ""}: "/api/echo?already=%20ok",
		{"/api/invoices", "?limit=2"}:   "/api/invoices?limit=2",
	}
	for in, want := range cases {
		if got := withQuery(in[0], in[1]); got != want {
			t.Errorf("withQuery(%q, %q) = %q, want %q", in[0], in[1], got, want)
		}
	}
}
