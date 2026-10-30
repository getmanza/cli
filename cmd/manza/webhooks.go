package main

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"

	manza "github.com/getmanza/manza-go"
	"golang.org/x/term"
)

// verifyWebhook checks a captured delivery (raw body from --file or stdin)
// against its X-Manza-Timestamp and X-Manza-Signature. It never calls the
// API. The reason a delivery fails is the SDK's.
func verifyWebhook(command string, f flags, config *runConfig) error {
	if command != "verify" {
		return cliErrorf("Usage: manza webhooks verify (--secret-env <VAR>|--secret <secret>) --timestamp <t> --signature <hex> [--file path] [--no-tolerance]")
	}
	secret, err := webhookSecret(f)
	if err != nil {
		return err
	}
	required := [][2]string{
		{"timestamp", "timestamp. Use --timestamp <X-Manza-Timestamp>"},
		{"signature", "signature. Use --signature <X-Manza-Signature>"},
	}
	for _, flag := range required {
		if err := requireValue(f.value(flag[0]), flag[1]); err != nil {
			return err
		}
	}
	// Hex is case-insensitive; the SDK compares the lowercase digest as is.
	timestamp, signature := f.str("timestamp"), strings.ToLower(f.str("signature"))
	if _, err := strconv.ParseInt(timestamp, 10, 64); err != nil {
		return cliErrorf("Invalid --timestamp \"%s\". Use the delivery's X-Manza-Timestamp (Unix seconds).", timestamp)
	}

	// The signature covers the bytes as delivered: never reparse or trim.
	var payload []byte
	if f.has("file") {
		payload, err = os.ReadFile(f.str("file"))
	} else if term.IsTerminal(int(os.Stdin.Fd())) {
		return cliErrorf("Missing webhook body. Use --file <path> or pipe it on stdin.")
	} else {
		payload, err = io.ReadAll(os.Stdin)
	}
	if err != nil {
		return cliErrorf("Could not read the webhook body: %s", err)
	}

	header := http.Header{}
	header.Set("X-Manza-Signature", signature)
	header.Set("X-Manza-Timestamp", timestamp)
	var opts []manza.WebhookOption
	if f.truthy("no-tolerance") {
		opts = append(opts, manza.WithoutWebhookTolerance())
	}

	if _, err := manza.ConstructWebhookEvent(payload, header, secret, opts...); err != nil {
		var argErr *manza.ArgumentError
		if !errors.As(err, &argErr) {
			return err
		}
		message := argErr.Message
		if len(opts) == 0 && manza.VerifyWebhook(payload, signature, timestamp, secret, manza.WithoutWebhookTolerance()) &&
			!manza.VerifyWebhook(payload, signature, timestamp, secret) {
			message += " (the signature matches; pass --no-tolerance to check a captured delivery)"
		}
		return cliErrorf("%s", message)
	}

	if !config.quiet {
		fmt.Println("valid")
	}
	return nil
}

// webhookSecret is the endpoint's signing secret: from the environment
// variable --secret-env names (kept out of ps and shell history), or --secret.
func webhookSecret(f flags) (string, error) {
	if f.has("secret-env") && f.has("secret") {
		return "", cliErrorf("Pass exactly one of --secret-env or --secret.")
	}
	if !f.has("secret-env") {
		if err := requireValue(f.value("secret"), "webhook signing secret. Use --secret-env <VAR> or --secret <secret>"); err != nil {
			return "", err
		}
		return f.str("secret"), nil
	}
	name := f.str("secret-env")
	secret := os.Getenv(name)
	if secret == "" {
		return "", cliErrorf("Environment variable %s is not set.", name)
	}
	return secret, nil
}
