package main

import (
	"io"
	"os"
	"strings"

	"golang.org/x/term"
)

func customerBody(f flags) (*object, error) {
	body := pick(f, "person-name", "company-name", "email", "phone", "tax-id", "ice-number", "customer-type")
	if f.has("billing-address") {
		text := f.str("billing-address")
		var address any
		if text != "null" {
			parsed, err := parseJSONFlag(text, "billing-address")
			if err != nil {
				return nil, err
			}
			address = parsed
		}
		body.Set("billing_address", address)
	}
	return body, nil
}

func invoiceBody(f flags) (*object, error) {
	body := pick(f, "customer-id", "currency-code", "issue-date", "due-date", "reference", "notes",
		"payment-terms", "send-to-email")
	for _, field := range [][2]string{{"item", "items"}, {"discount", "discounts"}} {
		if !f.has(field[0]) {
			continue
		}
		list := []any{}
		for _, item := range f[field[0]] {
			parsed, err := parseJSONFlag(jsString(item), field[0])
			if err != nil {
				return nil, err
			}
			list = append(list, parsed)
		}
		body.Set(field[1], list)
	}
	return body, nil
}

func webhookEndpointBody(f flags) (*object, error) {
	body := pick(f, "url", "description")

	if f.has("event") && f.has("events") {
		return nil, cliErrorf("Use only one of --event or --events.")
	}

	if f.has("event") {
		events := []any{}
		for _, event := range f["event"] {
			events = append(events, jsString(event))
		}
		body.Set("events", events)
	} else if f.has("events") {
		events := []any{}
		for _, item := range f["events"] {
			list, err := parseStringList(jsString(item), "events")
			if err != nil {
				return nil, err
			}
			events = append(events, list...)
		}
		body.Set("events", events)
	}

	return body, nil
}

func checkoutSessionBody(f flags) (*object, error) {
	body := pick(f, "account-id", "amount", "currency-code", "success-url", "cancel-url", "description", "customer-email")
	if f.has("metadata") {
		metadata, err := parseJSONFlag(f.str("metadata"), "metadata")
		if err != nil {
			return nil, err
		}
		body.Set("metadata", metadata)
	}
	return body, nil
}

// pick copies the named flags into an object under snake_case keys.
func pick(f flags, names ...string) *object {
	out := newObject()
	for _, name := range names {
		if f.has(name) {
			out.Set(snake(name), coerceValue(f.value(name)))
		}
	}
	return out
}

func coerceValue(value any) any {
	switch v := value.(type) {
	case []any:
		out := make([]any, len(v))
		for i, item := range v {
			out[i] = coerceValue(item)
		}
		return out
	case string:
		switch v {
		case "true":
			return true
		case "false":
			return false
		case "null":
			return nil
		}
	}
	return value
}

func parseStringList(text, label string) ([]any, error) {
	if strings.HasPrefix(strings.TrimSpace(text), "[") {
		parsed, err := parseJSONFlag(text, label)
		if err != nil {
			return nil, err
		}
		list, ok := parsed.([]any)
		if !ok {
			return nil, cliErrorf("Invalid JSON for %s: expected an array.", label)
		}
		out := make([]any, len(list))
		for i, item := range list {
			out[i] = jsString(item)
		}
		return out, nil
	}

	out := []any{}
	for _, item := range strings.Split(text, ",") {
		if item = strings.TrimSpace(item); item != "" {
			out = append(out, item)
		}
	}
	return out, nil
}

func parseJSONFlag(text, label string) (any, error) {
	value, err := parseJSON(text)
	if err != nil {
		return nil, cliErrorf("Invalid JSON for %s: %s", label, err)
	}
	return value, nil
}

// bodyFromFlags merges --data, --file or --stdin under the flag-built body.
// It runs at send time.
func bodyFromFlags(f flags, body *object) func() (*object, error) {
	return func() (*object, error) {
		sources := 0
		for _, name := range []string{"data", "file", "stdin"} {
			if f.has(name) {
				sources++
			}
		}
		if sources > 1 {
			return nil, cliErrorf("Use only one of --data, --file, or --stdin.")
		}

		var base any = newObject()
		var err error
		switch {
		case f.has("data"):
			base, err = parseJSONFlag(f.str("data"), "data")
		case f.has("file"):
			name := f.str("file")
			var raw []byte
			if raw, err = os.ReadFile(name); err == nil {
				base, err = parseJSONFlag(string(raw), name)
			}
		case f.has("stdin"):
			var text string
			if text, err = readStdin(false); err == nil {
				base, err = parseJSONFlag(text, "stdin")
			}
		}
		if err != nil {
			return nil, err
		}

		merged, ok := base.(*object)
		if !ok {
			return nil, cliErrorf("Request body must be a JSON object.")
		}
		merged.Merge(body)
		return merged, nil
	}
}

func readStdin(requirePipe bool) (string, error) {
	if term.IsTerminal(int(os.Stdin.Fd())) {
		if requirePipe {
			return "", cliErrorf("No stdin input detected. Pipe the API key into `manza login --api-key-stdin`.")
		}
		return "", cliErrorf("Unable to read stdin.")
	}

	data, err := io.ReadAll(os.Stdin)
	if err != nil {
		return "", cliErrorf("Unable to read stdin: %s", err)
	}
	return string(data), nil
}
