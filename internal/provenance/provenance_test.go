package provenance

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func run(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return string(out)
}

func commit(t *testing.T, repo, file, msg string) {
	t.Helper()
	p := filepath.Join(repo, file)
	os.MkdirAll(filepath.Dir(p), 0o755)
	os.WriteFile(p, []byte(msg), 0o644)
	run(t, repo, "add", ".")
	run(t, repo, "commit", "-qm", msg)
}

func newRepo(t *testing.T) string {
	repo := t.TempDir()
	run(t, repo, "init", "-q", "-b", "main")
	commit(t, repo, "README", "init")
	run(t, repo, "checkout", "-qb", "feature")
	return repo
}

func TestBriefFirst(t *testing.T) {
	repo := newRepo(t)
	commit(t, repo, ".dub/briefs/x.md", "brief")
	commit(t, repo, "lib/a.ex", "impl")
	r, err := Compute(repo, "main", ".dub/briefs/x.md")
	if err != nil {
		t.Fatal(err)
	}
	if r.BeforeImplementation != "true" || len(r.FirstSeenSHA) != 40 {
		t.Errorf("%+v", r)
	}
}

func TestImplFirst(t *testing.T) {
	repo := newRepo(t)
	commit(t, repo, "lib/a.ex", "impl")
	commit(t, repo, ".dub/briefs/x.md", "brief")
	r, err := Compute(repo, "main", ".dub/briefs/x.md")
	if err != nil {
		t.Fatal(err)
	}
	if r.BeforeImplementation != "false" || r.FirstSeenSHA == "" {
		t.Errorf("%+v", r)
	}
}

func TestSameCommit(t *testing.T) {
	repo := newRepo(t)
	os.MkdirAll(filepath.Join(repo, ".dub/briefs"), 0o755)
	os.WriteFile(filepath.Join(repo, ".dub/briefs/x.md"), []byte("b"), 0o644)
	commit(t, repo, "lib/a.ex", "both")
	r, _ := Compute(repo, "main", ".dub/briefs/x.md")
	// The brief's commit is the first commit; nothing precedes it.
	if r.BeforeImplementation != "true" {
		t.Errorf("%+v", r)
	}
}

func TestNeverAdded(t *testing.T) {
	repo := newRepo(t)
	commit(t, repo, "lib/a.ex", "impl")
	r, err := Compute(repo, "main", ".dub/briefs/x.md")
	if err != nil || r.BeforeImplementation != "unknown" || r.FirstSeenSHA != "" {
		t.Errorf("%+v %v", r, err)
	}
}

func TestShallow(t *testing.T) {
	src := newRepo(t)
	commit(t, src, ".dub/briefs/x.md", "brief")
	commit(t, src, "lib/a.ex", "impl")
	dst := filepath.Join(t.TempDir(), "clone")
	run(t, t.TempDir(), "clone", "-q", "--depth", "1", "--branch", "feature", "file://"+src, dst)
	r, _ := Compute(dst, "feature", ".dub/briefs/x.md")
	if r.BeforeImplementation != "unknown" {
		t.Errorf("%+v", r)
	}
}
