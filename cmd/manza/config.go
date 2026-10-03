package main

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

const (
	defaultBaseURL          = "https://ma.manza.finance"
	defaultRequestTimeoutMs = 30000
)

var formats = setOf("json", "pretty", "raw")

// storedConfig is ~/.config/manza/config.json, falling back to the 1.0-era
// ~/.config/zazu/config.json. Saves always go to the manza path, so the
// first write copies a legacy config over and leaves the old file alone.
type storedConfig struct {
	values *object
	// path is the file the config was read from, for `config get`.
	path string
}

func loadStoredConfig(ignoreInvalid bool) (*storedConfig, error) {
	if err := checkConfigRoot(); err != nil {
		return nil, err
	}
	for _, path := range []string{storedConfigPath(), legacyConfigPath()} {
		raw, err := os.ReadFile(path)
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, err
		}

		config := &storedConfig{values: newObject(), path: path}
		parsed, err := parseJSONFlag(string(raw), path)
		if err != nil {
			if ignoreInvalid {
				return config, nil
			}
			return nil, err
		}
		if obj, ok := parsed.(*object); ok {
			config.values = obj
		}
		return config, nil
	}

	return &storedConfig{values: newObject(), path: storedConfigPath()}, nil
}

// get is the value when truthy, else "".
func (c *storedConfig) get(key string) string {
	value, _ := c.values.Get(key)
	if !truthy(value) {
		return ""
	}
	return jsString(value)
}

func saveStoredConfig(values *object) error {
	path := storedConfigPath()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	return os.WriteFile(path, []byte(stringify(values, true)+"\n"), 0o600)
}

func storedConfigPath() string { return filepath.Join(configRoot(), "manza", "config.json") }

// checkConfigRoot refuses to fall back to a working-directory-relative
// .config (and write the API key there) when no home directory is known.
func checkConfigRoot() error {
	if os.Getenv("XDG_CONFIG_HOME") != "" {
		return nil
	}
	if _, err := os.UserHomeDir(); err != nil {
		return cliErrorf("Cannot locate the config directory: %s. Set XDG_CONFIG_HOME.", err)
	}
	return nil
}

// legacyConfigPath is read-only for all of 1.x: CLI versions before 1.0
// stored their login under zazu/.
func legacyConfigPath() string { return filepath.Join(configRoot(), "zazu", "config.json") }

func configRoot() string {
	if dir := os.Getenv("XDG_CONFIG_HOME"); dir != "" {
		return dir
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".config")
}

// env reads MANZA_<name>, else the legacy ZAZU_* name with a deprecation
// warning. The CLI-only ZAZU_VERSION maps to MANZA_API_VERSION. Empty means
// unset.
func env(name string) string {
	if value := os.Getenv("MANZA_" + name); value != "" {
		return value
	}

	legacy := "ZAZU_" + name
	if name == "API_VERSION" {
		legacy = "ZAZU_VERSION"
	}
	value := os.Getenv(legacy)
	if value != "" {
		fmt.Fprintf(os.Stderr, "[manza] %s is deprecated and will be removed in 2.0. Use MANZA_%s instead.\n", legacy, name)
	}
	return value
}

func outputFormat(globals flags) string {
	switch {
	case globals.truthy("pretty"):
		return "pretty"
	case globals.truthy("json"):
		return "json"
	case globals.truthy("output"):
		return globals.str("output")
	case globals.truthy("format"):
		return globals.str("format")
	default:
		return "json"
	}
}

func checkFormat(format string) error {
	if !formats[format] {
		return cliErrorf("Invalid output format \"%s\". Use json, pretty, or raw.", format)
	}
	return nil
}

func isLocalCommand(resource string) bool { return oneOf(resource, "login", "logout", "config") }

func runLocalCommand(parsed *parsedArgs, stored *storedConfig) error {
	config := &runConfig{output: outputFormat(parsed.globals), quiet: parsed.globals.truthy("quiet")}
	if err := checkFormat(config.output); err != nil {
		return err
	}

	switch at(parsed.positionals, 0) {
	case "login":
		return loginCommand(parsed, stored, config)
	case "logout":
		next := stored.values.Clone()
		next.Delete("api_key")
		if err := saveStoredConfig(next); err != nil {
			return err
		}
		printOutput(okResult(), config)
		return nil
	default:
		return configCommand(parsed.positionals, stored, config)
	}
}

func loginCommand(parsed *parsedArgs, stored *storedConfig, output *runConfig) error {
	apiKey, err := loginAPIKey(parsed)
	if err != nil {
		return err
	}
	if apiKey == "" {
		return cliErrorf("Usage: manza login [--api-key-stdin] [--base-url <url>]")
	}
	if !strings.HasPrefix(apiKey, "sk_live_") && !strings.HasPrefix(apiKey, "sk_test_") {
		return cliErrorf("API key must start with sk_live_ or sk_test_.")
	}

	next := stored.values.Clone()
	next.Set("api_key", apiKey)
	baseURL := parsed.globals.str("base-url")
	if !parsed.globals.truthy("base-url") {
		baseURL = env("BASE_URL")
	}
	if baseURL != "" {
		next.Set("base_url", stripTrailingSlash(baseURL))
	}
	if err := saveStoredConfig(next); err != nil {
		return err
	}

	storedBase := (&storedConfig{values: next}).get("base_url")
	if storedBase == "" {
		storedBase = defaultBaseURL
	}
	result := okResult()
	result.Set("api_key", maskSecret(apiKey))
	result.Set("base_url", storedBase)
	printOutput(result, output)
	return nil
}

func loginAPIKey(parsed *parsedArgs) (string, error) {
	if parsed.globals.truthy("api-key-stdin") || parsed.flags.truthy("api-key-stdin") {
		text, err := readStdin(true)
		return strings.TrimSpace(text), err
	}
	if parsed.globals.truthy("api-key") {
		return parsed.globals.str("api-key"), nil
	}
	if key := at(parsed.positionals, 1); key != "" {
		return key, nil
	}
	if key := env("API_KEY"); key != "" {
		return key, nil
	}
	return promptSecret("API key")
}

func configCommand(positionals []string, stored *storedConfig, output *runConfig) error {
	command, name, value := at(positionals, 1), at(positionals, 2), at(positionals, 3)

	switch command {
	case "get", "":
		result, err := readConfigValue(stored, name)
		if err != nil {
			return err
		}
		printOutput(result, output)
		return nil
	case "set":
		if err := requireString(name, "config key"); err != nil {
			return err
		}
		if err := requireString(value, "config value"); err != nil {
			return err
		}
		key, err := configKey(name)
		if err != nil {
			return err
		}
		next := stored.values.Clone()
		stored := value
		if key == "base_url" {
			stored = stripTrailingSlash(value)
		}
		next.Set(key, stored)
		if err := saveStoredConfig(next); err != nil {
			return err
		}

		result := okResult()
		switch key {
		case "api_key":
			result.Set("api_key", maskSecret(value))
		case "base_url":
			result.Set("api_base", value)
		default:
			result.Set(key, value)
		}
		printOutput(result, output)
		return nil
	case "unset":
		if err := requireString(name, "config key"); err != nil {
			return err
		}
		key, err := configKey(name)
		if err != nil {
			return err
		}
		next := stored.values.Clone()
		next.Delete(key)
		if err := saveStoredConfig(next); err != nil {
			return err
		}
		printOutput(okResult(), output)
		return nil
	default:
		return cliErrorf("Usage: manza config get|set|unset [api-key|api-base|api-version]")
	}
}

func readConfigValue(stored *storedConfig, name string) (*object, error) {
	apiKey := func() any {
		if key := stored.get("api_key"); key != "" {
			return maskSecret(key)
		}
		return nil
	}
	apiBase := func() any {
		if base := stored.get("base_url"); base != "" {
			return base
		}
		return defaultBaseURL
	}
	apiVersion := func() any {
		if version := stored.get("api_version"); version != "" {
			return version
		}
		return nil
	}

	result := newObject()
	if name == "" {
		result.Set("api_key", apiKey())
		result.Set("api_base", apiBase())
		result.Set("api_version", apiVersion())
		result.Set("config_path", stored.path)
		return result, nil
	}

	key, err := configKey(name)
	if err != nil {
		return nil, err
	}
	switch key {
	case "api_key":
		result.Set("api_key", apiKey())
	case "base_url":
		result.Set("api_base", apiBase())
	default:
		result.Set("api_version", apiVersion())
	}
	return result, nil
}

func configKey(name string) (string, error) {
	switch kebab(name) {
	case "api-key":
		return "api_key", nil
	case "api-base", "base-url":
		return "base_url", nil
	case "api-version":
		return "api_version", nil
	default:
		return "", cliErrorf("Unknown config key \"%s\". Use api-key, api-base, or api-version.", name)
	}
}

func okResult() *object {
	result := newObject()
	result.Set("ok", true)
	return result
}

func maskSecret(value string) string {
	if len(value) <= 12 {
		return "********"
	}
	return value[:8] + "..." + value[len(value)-4:]
}

func stripTrailingSlash(value string) string { return strings.TrimRight(value, "/") }
