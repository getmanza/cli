package main

import (
	"fmt"
	"strconv"
	"strings"
)

var globalFlags = setOf(
	"api-key", "api-key-stdin", "base-url", "output", "api-version", "timeout-ms",
	"format", "debug", "help", "json", "pretty", "quiet", "version",
)

var booleanFlags = setOf(
	"all", "api-key-stdin", "debug", "help", "json", "pretty", "quiet", "version", "stdin",
)

// flags maps a flag name to every value it was given, in order. A value is
// a string, or true for a bare boolean flag.
type flags map[string][]any

// value is the flag as JavaScript saw it: undefined (nil), one value, or an
// array when the flag was repeated.
func (f flags) value(name string) any {
	values := f[name]
	switch len(values) {
	case 0:
		return nil
	case 1:
		return values[0]
	default:
		return append([]any(nil), values...)
	}
}

func (f flags) has(name string) bool { return len(f[name]) > 0 }

func (f flags) truthy(name string) bool { return f.has(name) && truthy(f.value(name)) }

// str is String(flags[name]); "" when the flag is absent.
func (f flags) str(name string) string {
	if !f.has(name) {
		return ""
	}
	return jsString(f.value(name))
}

type parsedArgs struct {
	globals     flags
	flags       flags
	positionals []string
}

func parseArgs(argv []string) (*parsedArgs, error) {
	parsed := &parsedArgs{globals: flags{}, flags: flags{}}

	for i := 0; i < len(argv); i++ {
		token := argv[i]

		if token == "--" {
			parsed.positionals = append(parsed.positionals, argv[i+1:]...)
			break
		}

		if !strings.HasPrefix(token, "--") {
			parsed.positionals = append(parsed.positionals, token)
			continue
		}

		raw := token[2:]
		name, inline, hasInline := strings.Cut(raw, "=")
		key := kebab(name)
		var value any = inline

		if !hasInline && booleanFlags[key] {
			value = true
		} else if !hasInline {
			if i+1 < len(argv) && !strings.HasPrefix(argv[i+1], "--") {
				value = argv[i+1]
				i++
			} else {
				return nil, cliErrorf("Missing value for --%s.", key)
			}
		}

		target := parsed.flags
		if globalFlags[key] {
			target = parsed.globals
		}
		target[key] = append(target[key], value)
	}

	return parsed, nil
}

// parseOptionalPositiveInteger returns 0 when value is absent.
func parseOptionalPositiveInteger(value any, label string) (int, error) {
	if value == nil {
		return 0, nil
	}
	if value == true {
		return 0, cliErrorf("Missing value for --%s.", label)
	}

	text := jsString(value)
	number, ok := jsToNumber(text)
	if !ok || number < 1 || number != float64(int(number)) {
		return 0, cliErrorf("Invalid --%s \"%s\". Use a positive integer.", label, text)
	}
	return int(number), nil
}

// jsToNumber mirrors Number(text) for decimal input.
func jsToNumber(text string) (float64, bool) {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return 0, true
	}
	if strings.ContainsAny(trimmed, "xXpP_") || strings.EqualFold(strings.TrimLeft(trimmed, "+-"), "inf") ||
		strings.EqualFold(strings.TrimLeft(trimmed, "+-"), "infinity") || strings.EqualFold(trimmed, "nan") {
		return 0, false
	}
	f, err := strconv.ParseFloat(trimmed, 64)
	return f, err == nil
}

func requireValue(value any, label string) error {
	if !truthy(value) {
		return cliErrorf("Missing %s.", label)
	}
	return nil
}

func requireString(value, label string) error {
	if value == "" {
		return cliErrorf("Missing %s.", label)
	}
	return nil
}

func kebab(value string) string { return strings.ReplaceAll(value, "_", "-") }

func snake(value string) string { return strings.ReplaceAll(value, "-", "_") }

func setOf(names ...string) map[string]bool {
	set := make(map[string]bool, len(names))
	for _, name := range names {
		set[name] = true
	}
	return set
}

// cliError is a user-facing failure: its message goes to stderr as is.
type cliError struct {
	message  string
	exitCode int
}

func (e *cliError) Error() string { return e.message }

func cliErrorf(format string, args ...any) error {
	return &cliError{message: fmt.Sprintf(format, args...), exitCode: 1}
}
