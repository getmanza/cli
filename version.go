// Package cli holds what the manza command shares with the npm package.
package cli

import (
	_ "embed"
	"encoding/json"
)

//go:embed package.json
var packageJSON []byte

// Version is the CLI version. package.json stays the source of truth so
// bin/release bumping it also changes --version.
var Version = func() string {
	var pkg struct {
		Version string `json:"version"`
	}
	if err := json.Unmarshal(packageJSON, &pkg); err != nil || pkg.Version == "" {
		panic("package.json has no version")
	}
	return pkg.Version
}()
