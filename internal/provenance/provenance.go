// Package provenance answers "was the brief committed before the
// implementation?" from git history. It is a heuristic, never proof.
package provenance

import (
	"fmt"
	"os/exec"
	"strings"
)

// Result is what goes into dub.json.
type Result struct {
	FirstSeenSHA         string // "" when never added on the branch
	BeforeImplementation string // "true" | "false" | "unknown"
}

// Compute looks at merge-base(base, HEAD)..HEAD.
func Compute(repo, base, briefPath string) (Result, error) {
	shallow, err := git(repo, "rev-parse", "--is-shallow-repository")
	if err != nil {
		return Result{}, err
	}
	if shallow == "true" {
		return Result{BeforeImplementation: "unknown"}, nil
	}
	mb, err := git(repo, "merge-base", base, "HEAD")
	if err != nil {
		return Result{BeforeImplementation: "unknown"}, fmt.Errorf("merge-base with %s: %w", base, err)
	}
	first, err := FirstSeen(repo, mb, briefPath)
	if err != nil {
		return Result{}, err
	}
	if first == "" {
		return Result{BeforeImplementation: "unknown"}, nil
	}
	// Every commit on the branch, oldest first.
	out, err := git(repo, "log", "--format=%H", "--reverse", mb+"..HEAD")
	if err != nil {
		return Result{}, err
	}
	commits := strings.Fields(out)
	for _, c := range commits {
		if c == first {
			return Result{FirstSeenSHA: first, BeforeImplementation: "true"}, nil
		}
		files, err := git(repo, "diff-tree", "--no-commit-id", "--name-only", "-r", c)
		if err != nil {
			return Result{}, err
		}
		for _, f := range strings.Split(files, "\n") {
			f = strings.TrimSpace(f)
			if f != "" && f != briefPath {
				return Result{FirstSeenSHA: first, BeforeImplementation: "false"}, nil
			}
		}
	}
	return Result{FirstSeenSHA: first, BeforeImplementation: "unknown"}, nil
}

// FirstSeen returns the oldest commit in from..HEAD that adds path, or "".
func FirstSeen(repo, from, path string) (string, error) {
	out, err := git(repo, "log", "--diff-filter=A", "--format=%H", "--reverse", from+"..HEAD", "--", path)
	if err != nil {
		return "", err
	}
	shas := strings.Fields(out)
	if len(shas) == 0 {
		return "", nil
	}
	return shas[0], nil
}

func git(repo string, args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = repo
	out, err := cmd.Output()
	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			return "", fmt.Errorf("git %s: %s", strings.Join(args, " "), strings.TrimSpace(string(ee.Stderr)))
		}
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}
