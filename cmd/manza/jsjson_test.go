package main

import "testing"

func TestJSNumber(t *testing.T) {
	cases := map[float64]string{
		0:                     "0",
		1:                     "1",
		-1:                    "-1",
		2500:                  "2500",
		2500.5:                "2500.5",
		0.1:                   "0.1",
		0.000001:              "0.000001",
		0.0000001:             "1e-7",
		1e21:                  "1e+21",
		1e20:                  "100000000000000000000",
		123456789012345680000: "123456789012345680000",
		1.5e-10:               "1.5e-10",
		9007199254740993:      "9007199254740992",
	}
	for in, want := range cases {
		if got := jsNumber(in); got != want {
			t.Errorf("jsNumber(%v) = %q, want %q", in, got, want)
		}
	}
}

func TestStringifyKeepsInsertionOrderAndJSEscaping(t *testing.T) {
	value, err := parseJSON(`{"b":1,"a":"<é>&\u0001","2":true,"1":null,"b":2.0,"list":[],"obj":{}}`)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"1":null,"2":true,"b":2,"a":"<é>&\u0001","list":[],"obj":{}}`
	if got := stringify(value, false); got != want {
		t.Errorf("compact = %s, want %s", got, want)
	}

	pretty := stringify(mustParse(t, `{"a":[1,{"b":null}],"c":{}}`), true)
	wantPretty := "{\n  \"a\": [\n    1,\n    {\n      \"b\": null\n    }\n  ],\n  \"c\": {}\n}"
	if pretty != wantPretty {
		t.Errorf("pretty = %q, want %q", pretty, wantPretty)
	}
}

func TestParseJSONRejectsTrailingData(t *testing.T) {
	for _, in := range []string{"", "{not-json", "{} x", "[1,]"} {
		if _, err := parseJSON(in); err == nil {
			t.Errorf("parseJSON(%q) succeeded, want error", in)
		}
	}
}

func TestJSString(t *testing.T) {
	if got := jsString(mustParse(t, "1e400")); got != "Infinity" {
		t.Errorf("jsString(1e400) = %q, want Infinity", got)
	}
	if got := jsString([]any{"a", true, nil, 2.0}); got != "a,true,,2" {
		t.Errorf("jsString(array) = %q", got)
	}
}

func mustParse(t *testing.T, text string) any {
	t.Helper()
	value, err := parseJSON(text)
	if err != nil {
		t.Fatal(err)
	}
	return value
}
