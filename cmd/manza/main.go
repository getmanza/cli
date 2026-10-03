// Command manza is the command-line interface for the Manza API.
package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	cli "github.com/getmanza/cli"
	manza "github.com/getmanza/manza-go"
)

func main() {
	// The zazu name keeps working for all of 1.x; removed in 2.0.
	if filepath.Base(os.Args[0]) == "zazu" {
		fmt.Fprintln(os.Stderr, "zazu is deprecated and will be removed in 2.0. Use manza instead.")
	}

	err := run(os.Args[1:])
	if err == nil {
		return
	}
	if errors.Is(err, errAPIPrinted) {
		os.Exit(1)
	}
	var cliErr *cliError
	if errors.As(err, &cliErr) {
		fmt.Fprintln(os.Stderr, cliErr.message)
		os.Exit(cliErr.exitCode)
	}
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}

func run(argv []string) error {
	parsed, err := parseArgs(argv)
	if err != nil {
		return err
	}

	if parsed.globals.truthy("version") {
		fmt.Println(cli.Version)
		return nil
	}

	if parsed.globals.truthy("help") {
		help, ok := commandHelp[at(parsed.positionals, 0)]
		if !ok {
			help = helpText
		}
		fmt.Println(help)
		return nil
	}

	if len(parsed.positionals) == 0 {
		fmt.Println(helpText)
		return nil
	}

	if isLocalCommand(parsed.positionals[0]) {
		// Recovery commands (login/logout/config) must work even if the
		// stored config is corrupted — that's exactly when you need them.
		stored, err := loadStoredConfig(true)
		if err != nil {
			return err
		}
		return runLocalCommand(parsed, stored)
	}

	stored, err := loadStoredConfig(false)
	if err != nil {
		return err
	}
	config, err := resolveConfig(parsed.globals, stored)
	if err != nil {
		return err
	}

	if oneOf(parsed.positionals[0], "transfers", "transfer-drafts", "transfer_drafts") && at(parsed.positionals, 1) == "sign" {
		return signTransferAuthorization(parsed.flags, config)
	}

	req, err := buildRequest(parsed.positionals, parsed.flags)
	if err != nil {
		return err
	}
	return send(config, req)
}

// resolveConfig applies flag > env > stored config > default, reading each
// env var only when the flag is absent so deprecation warnings match 1.x.
func resolveConfig(globals flags, stored *storedConfig) (*runConfig, error) {
	first := func(flag, envName, storedKey, fallback string) string {
		if globals.truthy(flag) {
			return globals.str(flag)
		}
		if value := env(envName); value != "" {
			return value
		}
		if storedKey != "" {
			if value := stored.get(storedKey); value != "" {
				return value
			}
		}
		return fallback
	}

	config := &runConfig{
		apiKey:     first("api-key", "API_KEY", "api_key", ""),
		baseURL:    stripTrailingSlash(first("base-url", "BASE_URL", "base_url", defaultBaseURL)),
		apiVersion: first("api-version", "API_VERSION", "api_version", ""),
		output:     outputFormat(globals),
		quiet:      globals.truthy("quiet"),
		debug:      globals.truthy("debug"),
	}

	timeout, err := parseOptionalPositiveInteger(
		first("timeout-ms", "TIMEOUT_MS", "", fmt.Sprint(defaultRequestTimeoutMs)), "timeout-ms")
	if err != nil {
		return nil, err
	}
	config.requestTimeoutMs = timeout

	if err := checkFormat(config.output); err != nil {
		return nil, err
	}
	return config, nil
}

func signTransferAuthorization(f flags, config *runConfig) error {
	if f.has("secret") {
		return cliErrorf("Never pass the signing secret as an argument. Put it in an environment variable and use --secret-env <VAR>.")
	}

	if err := requireValue(f.value("secret-env"), "secret env var. Use --secret-env <VAR>"); err != nil {
		return err
	}
	secretEnv := f.str("secret-env")
	secret := os.Getenv(secretEnv)
	if secret == "" {
		return cliErrorf("Environment variable %s is not set.", secretEnv)
	}

	for _, name := range []string{"payment-id", "nonce", "amount", "currency-code", "account-id"} {
		if err := requireValue(f.value(name), "--"+name); err != nil {
			return err
		}
	}

	if f.has("external-account-id") == f.has("destination-account-id") {
		return cliErrorf("Pass exactly one of --external-account-id or --destination-account-id.")
	}
	payee, err := manza.PayeeFor(f.str("external-account-id"), f.str("destination-account-id"))
	if err != nil {
		var argErr *manza.ArgumentError
		if errors.As(err, &argErr) {
			return cliErrorf("%s", argErr.Message)
		}
		return err
	}

	signatureInput := manza.SignatureInput(manza.TransferAuthorizationFields{
		PaymentID:       f.str("payment-id"),
		Nonce:           f.str("nonce"),
		Amount:          f.str("amount"),
		CurrencyCode:    f.str("currency-code"),
		AccountID:       f.str("account-id"),
		Payee:           payee,
		ClientReference: f.str("client-reference"),
	})

	result := newObject()
	result.Set("signature", manza.Sign(secret, signatureInput))
	result.Set("signature_input", signatureInput)
	printOutput(result, config)
	return nil
}
