package main

import (
	"os"
	"strings"
	"testing"
)

// The README's "Debugging transfer authorization" table and refusalReasons
// are one list: every reason the CLI explains appears there in the same words.
func TestREADMEListsEveryRefusalReason(t *testing.T) {
	readme, err := os.ReadFile("../../README.md")
	if err != nil {
		t.Fatal(err)
	}
	for reason, words := range refusalReasons {
		row := "| `" + reason + "` | " + words + " |"
		if !strings.Contains(string(readme), row) {
			t.Errorf("README.md has no row %q", row)
		}
	}
}

func TestDecimalRemaining(t *testing.T) {
	cases := []struct{ limit, used, want string }{
		{"20000.0", "1500.5", "18499.5"},
		{"1000000.0", "0.0", "1000000.0"},
		{"100", "250.25", "0.00"},
		{"0.1", "0.2", "0.0"},
		{"1000.10", "0.05", "1000.05"},
	}
	for _, c := range cases {
		got, ok := decimalRemaining(c.limit, c.used)
		if !ok || got != c.want {
			t.Errorf("decimalRemaining(%q, %q) = %q, %v; want %q", c.limit, c.used, got, ok, c.want)
		}
	}
	if _, ok := decimalRemaining("n/a", "1.0"); ok {
		t.Error("decimalRemaining accepted a non-decimal limit")
	}
}
