// Package inline copies a spec and the local modules it imports, verbatim,
// so the bundle shows exactly what was asserted.
package inline

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// File is one inlined source file.
type File struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
}

// Result is the inlined spec.
type Result struct {
	Files           []File
	ExternalImports []string
	Source          string
}

var importRe = regexp.MustCompile(
	`(?m)(?:^|[^\w$])(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]` +
		`|(?:^|[^\w$])require\(\s*['"]([^'"]+)['"]\s*\)` +
		`|(?:^|[^\w$])import\(\s*['"]([^'"]+)['"]\s*\)`)

var exts = []string{"", ".ts", ".tsx", ".js", ".mjs", ".cjs", ".jsx"}

// Spec inlines the spec at specPath. Paths in the result are relative to root.
func Spec(root, specPath string) (*Result, error) {
	root, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	specPath, err = filepath.Abs(specPath)
	if err != nil {
		return nil, err
	}
	res := &Result{}
	seen := map[string]bool{}
	ext := map[string]bool{}
	var sb strings.Builder
	var walk func(p string) error
	walk = func(p string) error {
		if seen[p] {
			return nil
		}
		seen[p] = true
		data, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(root, p)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		sum := sha256.Sum256(data)
		res.Files = append(res.Files, File{Path: rel, SHA256: hex.EncodeToString(sum[:])})
		fmt.Fprintf(&sb, "// ---- %s\n", rel)
		sb.Write(data)
		if !strings.HasSuffix(string(data), "\n") {
			sb.WriteString("\n")
		}
		for _, m := range importRe.FindAllStringSubmatch(string(data), -1) {
			spec := m[1] + m[2] + m[3]
			if spec == "" {
				continue
			}
			if !strings.HasPrefix(spec, "./") && !strings.HasPrefix(spec, "../") {
				ext[spec] = true
				continue
			}
			target, ok := resolve(filepath.Join(filepath.Dir(p), spec))
			if !ok || strings.Contains(target, string(filepath.Separator)+"node_modules"+string(filepath.Separator)) {
				ext[spec] = true
				continue
			}
			if err := walk(target); err != nil {
				return err
			}
		}
		return nil
	}
	if err := walk(specPath); err != nil {
		return nil, err
	}
	for k := range ext {
		res.ExternalImports = append(res.ExternalImports, k)
	}
	sort.Strings(res.ExternalImports)
	res.Source = sb.String()
	return res, nil
}

func resolve(base string) (string, bool) {
	for _, e := range exts {
		p := base + e
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			return p, true
		}
	}
	for _, e := range exts[1:] {
		p := filepath.Join(base, "index"+e)
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			return p, true
		}
	}
	return "", false
}
