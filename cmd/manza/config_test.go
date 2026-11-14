package main

import (
	"os"
	"path/filepath"
	"testing"
)

// 2.0 removed the ZAZU_* fallbacks: only MANZA_* is read.
func TestEnvReadsOnlyManzaNames(t *testing.T) {
	t.Setenv("ZAZU_API_KEY", "sk_live_legacy")
	t.Setenv("ZAZU_VERSION", "2026-03-27")
	t.Setenv("MANZA_API_KEY", "")
	t.Setenv("MANZA_API_VERSION", "")

	if got := env("API_KEY"); got != "" {
		t.Errorf("env(API_KEY) read ZAZU_API_KEY: %q", got)
	}
	if got := env("API_VERSION"); got != "" {
		t.Errorf("env(API_VERSION) read ZAZU_VERSION: %q", got)
	}

	t.Setenv("MANZA_API_KEY", "sk_live_manza")
	if got := env("API_KEY"); got != "sk_live_manza" {
		t.Errorf("env(API_KEY) = %q, want MANZA_API_KEY", got)
	}
}

// 2.0 removed the ~/.config/zazu/config.json fallback.
func TestLoadStoredConfigIgnoresZazuPath(t *testing.T) {
	root := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", root)
	legacy := filepath.Join(root, "zazu", "config.json")
	if err := os.MkdirAll(filepath.Dir(legacy), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(legacy, []byte(`{"api_key":"sk_live_legacy"}`), 0o600); err != nil {
		t.Fatal(err)
	}

	stored, err := loadStoredConfig(false)
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(root, "manza", "config.json"); stored.path != want {
		t.Errorf("config path = %q, want %q", stored.path, want)
	}
	if got := stored.get("api_key"); got != "" {
		t.Errorf("read the zazu config's api_key: %q", got)
	}
}
