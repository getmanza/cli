package main

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"

	manza "github.com/getmanza/manza-go"
)

// verifyWebhook checks a captured delivery (raw body from --file or stdin)
// against its X-Manza-Timestamp and X-Manza-Signature. It never calls the
// API. The reason a delivery fails is the SDK's.
func verifyWebhook(command string, f flags, config *runConfig) error {
	if command != "verify" {
		return cliErrorf("Usage: manza webhooks verify --secret <secret> --timestamp <t> --signature <hex> [--file path] [--no-tolerance]")
	}
	required := [][2]string{
		{"secret", "webhook signing secret. Use --secret <secret>"},
		{"timestamp", "timestamp. Use --timestamp <X-Manza-Timestamp>"},
		{"signature", "signature. Use --signature <X-Manza-Signature>"},
	}
	for _, flag := range required {
		if err := requireValue(f.value(flag[0]), flag[1]); err != nil {
			return err
		}
	}
	secret, timestamp, signature := f.str("secret"), f.str("timestamp"), f.str("signature")

	// The signature covers the bytes as delivered: never reparse or trim.
	var payload []byte
	var err error
	if f.has("file") {
		payload, err = os.ReadFile(f.str("file"))
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
