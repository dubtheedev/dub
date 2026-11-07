// Package gh is the CLI's talk with the Worker as a signed-in human: `dub
// login`, `dub pr`, and `dub init`'s starter files.
package gh

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// Credentials is ~/.config/dub/credentials.json.
type Credentials struct {
	WorkerURL string `json:"worker_url"`
	Token     string `json:"token"`
	Login     string `json:"login,omitempty"`
}

// CredentialsPath honours XDG_CONFIG_HOME.
func CredentialsPath() (string, error) {
	base := os.Getenv("XDG_CONFIG_HOME")
	if base == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		base = filepath.Join(home, ".config")
	}
	return filepath.Join(base, "dub", "credentials.json"), nil
}

// LoadCredentials reads the stored token; DUB_TOKEN overrides it.
func LoadCredentials(workerURL string) (*Credentials, error) {
	if t := os.Getenv("DUB_TOKEN"); t != "" {
		return &Credentials{WorkerURL: workerURL, Token: t}, nil
	}
	p, err := CredentialsPath()
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(p)
	if err != nil {
		return nil, errors.New("not logged in; run `dub login`")
	}
	var c Credentials
	if err := json.Unmarshal(data, &c); err != nil {
		return nil, err
	}
	if workerURL != "" {
		c.WorkerURL = workerURL
	}
	return &c, nil
}

// SaveCredentials writes the file with mode 0600.
func SaveCredentials(c *Credentials) (string, error) {
	p, err := CredentialsPath()
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return "", err
	}
	data, _ := json.MarshalIndent(c, "", "  ")
	return p, os.WriteFile(p, append(data, '\n'), 0o600)
}

// Login prints the login URL, reads the pasted token from in, and stores it.
func Login(workerURL string, in io.Reader, out io.Writer) (string, error) {
	workerURL = strings.TrimRight(workerURL, "/")
	fmt.Fprintf(out, "Open this URL, sign in with GitHub, and paste the token it shows:\n\n  %s/auth/login?cli=1\n\nToken: ", workerURL)
	line, err := bufio.NewReader(in).ReadString('\n')
	if err != nil && line == "" {
		return "", errors.New("no token entered")
	}
	tok := strings.TrimSpace(line)
	if tok == "" {
		return "", errors.New("no token entered")
	}
	return SaveCredentials(&Credentials{WorkerURL: workerURL, Token: tok})
}

// PRRequest is POST /api/prs.
type PRRequest struct {
	Owner string `json:"owner"`
	Repo  string `json:"repo"`
	Head  string `json:"head"`
	Base  string `json:"base"`
	Title string `json:"title"`
	Body  string `json:"body"`
}

// PRResult is the Worker's answer.
type PRResult struct {
	Number int    `json:"number"`
	URL    string `json:"url"`
}

// CreatePR asks the Worker to open the PR as the App.
func CreatePR(ctx context.Context, hc *http.Client, c *Credentials, req PRRequest) (*PRResult, error) {
	if c.WorkerURL == "" {
		return nil, errors.New("DUB_WORKER_URL is not set")
	}
	body, _ := json.Marshal(req)
	r, err := http.NewRequestWithContext(ctx, "POST", strings.TrimRight(c.WorkerURL, "/")+"/api/prs", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	r.Header.Set("Authorization", "Bearer "+c.Token)
	r.Header.Set("Content-Type", "application/json")
	resp, err := hc.Do(r)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	rb, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode/100 != 2 {
		return nil, fmt.Errorf("create PR: %s: %s", resp.Status, strings.TrimSpace(string(rb)))
	}
	var res PRResult
	if err := json.Unmarshal(rb, &res); err != nil {
		return nil, err
	}
	return &res, nil
}

// Starter files for `dub init`.
var starters = map[string]string{
	".dub/config.yml": `# Dub repo config. Read from the base branch by the Worker.
reviewers: []            # GitHub logins allowed to write the dubbed status
base: main
preview_origin_allowlist: [https://dubthee.dev]
`,
	".dub/rubric.md": `# Rubric

Reusable product rules. The base branch is authoritative; edits on a PR branch
show up on the review page as proposals only.

Format: a rule, its scope (areas from .dub/areas.yml), the rationale, a source.

<!--
- **Plain tone, no exclamation marks.**  scope: email
  Why: customers read these at work. Source: #87 (rejected)
-->
`,
	".dub/areas.yml": `# Area name -> path globs. Used to scope rubric rules and to tag diffs.
# email:
#   - lib/missive/mailer/**
#   - lib/missive_web/emails/**
`,
	".dub/briefs/.keep":   "",
	".dub/evidence/.keep": "",
}

// Init writes the starter files that are absent and ignores `.dub-out/`,
// where `dub pack` writes. It returns what it created.
func Init(repo string) ([]string, error) {
	var created []string
	if added, err := ignoreOut(repo); err != nil {
		return nil, err
	} else if added {
		created = append(created, ".gitignore (+ .dub-out/)")
	}
	for rel, body := range starters {
		p := filepath.Join(repo, filepath.FromSlash(rel))
		if _, err := os.Stat(p); err == nil {
			continue
		}
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			return created, err
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			return created, err
		}
		created = append(created, rel)
	}
	return created, nil
}

func ignoreOut(repo string) (bool, error) {
	p := filepath.Join(repo, ".gitignore")
	data, _ := os.ReadFile(p)
	for _, line := range strings.Split(string(data), "\n") {
		if strings.TrimSpace(line) == ".dub-out/" || strings.TrimSpace(line) == ".dub-out" {
			return false, nil
		}
	}
	if len(data) > 0 && !strings.HasSuffix(string(data), "\n") {
		data = append(data, '\n')
	}
	data = append(data, ".dub-out/\n"...)
	return true, os.WriteFile(p, data, 0o644)
}
