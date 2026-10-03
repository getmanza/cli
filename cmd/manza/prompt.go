package main

import (
	"bufio"
	"fmt"
	"os"
	"strings"

	"golang.org/x/term"
)

// promptSecret reads a line without echo. Ctrl-C cancels with exit 130.
func promptSecret(label string) (string, error) {
	stdin := int(os.Stdin.Fd())
	if !term.IsTerminal(stdin) || !term.IsTerminal(int(os.Stdout.Fd())) {
		return "", cliErrorf("Cannot prompt for %s in a non-interactive shell. Use --api-key-stdin.", label)
	}

	fmt.Printf("%s: ", label)
	state, err := term.MakeRaw(stdin)
	if err != nil {
		return "", err
	}

	value, cancelled, err := readSecret(bufio.NewReader(os.Stdin))
	term.Restore(stdin, state)
	fmt.Println()

	if err != nil {
		return "", err
	}
	if cancelled {
		return "", &cliError{message: "Login cancelled.", exitCode: 130}
	}
	return strings.TrimSpace(value), nil
}

func readSecret(reader *bufio.Reader) (value string, cancelled bool, err error) {
	var runes []rune
	for {
		r, _, err := reader.ReadRune()
		if err != nil {
			return string(runes), false, err
		}
		switch r {
		case '\x03':
			return "", true, nil
		case '\r', '\n':
			return string(runes), false, nil
		case '\x7f', '\b':
			if len(runes) > 0 {
				runes = runes[:len(runes)-1]
			}
		default:
			runes = append(runes, r)
		}
	}
}
