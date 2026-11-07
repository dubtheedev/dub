// Package runner drives the ghcr.io/dubtheedev/runner container and maps its
// results onto criterion statuses.
package runner

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// DefaultImage is used when neither --runner nor DUB_RUNNER is set.
const DefaultImage = "ghcr.io/dubtheedev/runner:latest"

// Criterion is the subset of the brief the runner needs.
type Criterion struct {
	ID   string `json:"id"`
	Kind string `json:"kind"`
}

// Options for one run.
type Options struct {
	Repo       string // repo root; <repo>/.dub is mounted read-only
	Out        string // host dir mounted at /out
	PreviewURL string
	SHA        string
	Criteria   []Criterion
	Image      string
	Stderr     *os.File
}

// Attachment is one artifact the runner wrote under /out/<id>/.
type Attachment struct {
	Name        string `json:"name"`
	Path        string `json:"path"` // relative to /out
	ContentType string `json:"contentType"`
}

// TestResult is one test in results.json.
type TestResult struct {
	ID          string       `json:"id"`
	Status      string       `json:"status"` // passed|failed|timedOut|skipped|interrupted
	Error       string       `json:"error,omitempty"`
	Steps       []string     `json:"steps"`
	Attachments []Attachment `json:"attachments"`
}

// Results is /out/results.json.
type Results struct {
	PreviewMoved bool         `json:"preview_moved"`
	Tests        []TestResult `json:"tests"`
}

// Outcome is a criterion's mapped status.
type Outcome struct {
	Status      string // pass|fail|error|none
	Error       string
	Steps       []string
	Attachments []Attachment
}

// Exec runs a command. Injectable for tests.
type Exec func(name string, args ...string) ([]byte, error)

// Runner wraps the docker invocation.
type Runner struct {
	Exec Exec
}

func defaultExec(name string, args ...string) ([]byte, error) {
	cmd := exec.Command(name, args...)
	cmd.Stderr = os.Stderr
	return cmd.Output()
}

// Default uses the real docker.
var Default = &Runner{Exec: defaultExec}

// Digest resolves image to its repo digest; it falls back to the tag.
func (r *Runner) Digest(image string) (string, bool) {
	out, err := r.Exec("docker", "image", "inspect", "--format", "{{index .RepoDigests 0}}", image)
	d := strings.TrimSpace(string(out))
	if err != nil || d == "" || strings.Contains(d, "error calling index") {
		return image, false
	}
	return d, true
}

// Run executes the container and parses results.json.
func (r *Runner) Run(o Options) (*Results, error) {
	if o.Image == "" {
		o.Image = os.Getenv("DUB_RUNNER")
	}
	if o.Image == "" {
		o.Image = DefaultImage
	}
	repoAbs, _ := filepath.Abs(o.Repo)
	outAbs, _ := filepath.Abs(o.Out)
	if err := os.MkdirAll(outAbs, 0o755); err != nil {
		return nil, err
	}
	crit, _ := json.Marshal(o.Criteria)
	args := []string{"run", "--rm",
		"-v", filepath.Join(repoAbs, ".dub") + ":/work/.dub:ro",
		"-v", outAbs + ":/out",
		"-e", "DUB_PREVIEW_URL=" + o.PreviewURL,
		"-e", "DUB_SHA=" + o.SHA,
		"-e", "DUB_CRITERIA=" + string(crit),
		o.Image,
	}
	_, runErr := r.Exec("docker", args...)
	// Playwright exits non-zero when any test fails; results.json decides.
	data, err := os.ReadFile(filepath.Join(outAbs, "results.json"))
	if err != nil {
		if runErr != nil {
			return nil, fmt.Errorf("runner failed and wrote no results.json: %w", runErr)
		}
		return nil, fmt.Errorf("runner wrote no results.json: %w", err)
	}
	var res Results
	if err := json.Unmarshal(data, &res); err != nil {
		return nil, fmt.Errorf("results.json: %w", err)
	}
	return &res, nil
}

// Map applies the contract's status mapping for every criterion.
func Map(criteria []Criterion, res *Results) map[string]Outcome {
	byID := map[string]TestResult{}
	for _, t := range res.Tests {
		byID[t.ID] = t
	}
	out := map[string]Outcome{}
	for _, c := range criteria {
		t, ok := byID[c.ID]
		if !ok {
			out[c.ID] = Outcome{Status: "none"}
			continue
		}
		o := Outcome{Error: t.Error, Steps: t.Steps, Attachments: t.Attachments}
		switch {
		case res.PreviewMoved:
			o.Status = "error"
			if o.Error == "" {
				o.Error = "preview moved during capture"
			}
		case strings.Contains(t.Error, "DubPreviewMoved"):
			o.Status = "error"
		case t.Status == "passed":
			o.Status = "pass"
		case t.Status == "failed" && c.Kind == "judgment":
			o.Status = "error"
			o.Error = "judgment spec asserted (it must not): " + t.Error
		case t.Status == "failed":
			o.Status = "fail"
		case t.Status == "skipped":
			o.Status = "none"
		default: // timedOut, interrupted, anything new
			o.Status = "error"
			if o.Error == "" {
				o.Error = t.Status
			}
		}
		out[c.ID] = o
	}
	return out
}

// ErrNoDocker is returned when docker is not on PATH.
var ErrNoDocker = errors.New("docker not found on PATH; the runner is a container image")

// CheckDocker verifies docker is available.
func CheckDocker() error {
	if _, err := exec.LookPath("docker"); err != nil {
		return ErrNoDocker
	}
	return nil
}
