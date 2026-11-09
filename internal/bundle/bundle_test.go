package bundle

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dubtheedev/dub/internal/brief"
	"github.com/dubtheedev/dub/internal/runner"
)

func run(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

func write(t *testing.T, root, rel, body string) {
	t.Helper()
	p := filepath.Join(root, rel)
	os.MkdirAll(filepath.Dir(p), 0o755)
	os.WriteFile(p, []byte(body), 0o644)
}

const briefText = "---\nid: x\n---\n# T\n\n**Why:** because.\n\n## Acceptance\n- [ac-1] badge {kind: visual}\n- [ac-2] tone {kind: judgment}\n- [ac-3] nothing {kind: check}\n\n## Notes\n**Unsure:**\n- tz\n"

func TestAssemble(t *testing.T) {
	repo := t.TempDir()
	run(t, repo, "init", "-q", "-b", "main")
	write(t, repo, "README", "x")
	write(t, repo, ".dub/areas.yml", "email:\n  - lib/email/**\ninvoices:\n  - lib/invoices/\n")
	write(t, repo, ".dub/evidence/helpers.ts", "export const a = 1\n")
	run(t, repo, "add", ".")
	run(t, repo, "commit", "-qm", "init")
	run(t, repo, "checkout", "-qb", "feature")
	write(t, repo, ".dub/briefs/x.md", briefText)
	run(t, repo, "add", ".")
	run(t, repo, "commit", "-qm", "brief")
	write(t, repo, "lib/email/a.ex", "a\nb\n")
	write(t, repo, ".dub/evidence/x.spec.ts", "import { test, expect } from '@dub/test'\nimport { a } from './helpers'\ntest('ac-1', async () => {})\ntest(\"ac-2\", async () => {})\n")
	run(t, repo, "add", ".")
	run(t, repo, "commit", "-qm", "impl")

	b, err := brief.Parse(filepath.Join(repo, ".dub/briefs/x.md"))
	if err != nil {
		t.Fatal(err)
	}
	runnerOut := t.TempDir()
	write(t, runnerOut, "ac-1/list.png", "PNG")
	write(t, runnerOut, "ac-2/email.png", "PNG2")
	out := t.TempDir()
	t.Setenv("DUB_AUTHOR_SESSION", "s1")
	bb, err := Assemble(Inputs{
		Repo: repo, Base: "main", RepoName: "o/r", PR: 7, SHA: "abc", Runner: "img@sha256:1",
		Preview: Preview{URL: "http://p", PreviewSHA: "abc"},
		Specs:   []string{".dub/evidence/x.spec.ts"},
		Brief:   b,
		Outcomes: map[string]runner.Outcome{
			"ac-1": {Status: "pass", Steps: []string{"goto /"}, Attachments: []runner.Attachment{{Name: "list", Path: "ac-1/list.png", ContentType: "image/png"}}},
			"ac-2": {Status: "none", Attachments: []runner.Attachment{{Name: "email", Path: "ac-2/email.png", ContentType: "image/png"}}},
		},
		RunnerOut: runnerOut, BundleOut: out,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(bb.BundleID) != 26 || bb.Repo != "o/r" || bb.PR != 7 || bb.Author.Session != "s1" || bb.Author.Agent != "claude-code" {
		t.Errorf("%+v", bb)
	}
	if bb.Brief.Path != ".dub/briefs/x.md" || bb.Brief.BeforeImplementation != "true" || bb.Brief.FirstSeenSHA == nil || len(bb.Brief.Criteria) != 3 {
		t.Errorf("brief %+v", bb.Brief)
	}
	if bb.Diff.Files != 3 || bb.Diff.Additions != 0 && bb.Diff.Additions < 2 || strings.Join(bb.Diff.Areas, ",") != "email" {
		t.Errorf("diff %+v", bb.Diff)
	}
	c1 := bb.Criteria[0]
	if c1.Status != "pass" || c1.Spec == nil || !c1.Spec.Changed || len(c1.Spec.Files) != 2 || c1.Spec.ExternalImports[0] != "@dub/test" {
		t.Errorf("c1 %+v", c1)
	}
	if len(c1.Evidence) != 1 || c1.Evidence[0].Path != "ac-1/list.png" || c1.Evidence[0].Type != "image" || !strings.HasPrefix(c1.Evidence[0].Hash, "sha256:") || c1.Evidence[0].Role != "" {
		t.Errorf("ev %+v", c1.Evidence)
	}
	if _, err := os.Stat(filepath.Join(out, "evidence/ac-1/list.png")); err != nil {
		t.Error(err)
	}
	c2 := bb.Criteria[1]
	if c2.Evidence[0].Role != "supporting" || c2.Status != "none" {
		t.Errorf("c2 %+v", c2)
	}
	c3 := bb.Criteria[2]
	if c3.Status != "none" || c3.Spec != nil || len(c3.Evidence) != 0 || c3.Assertions == nil {
		t.Errorf("c3 %+v", c3)
	}
	p, err := bb.Write(out)
	if err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(p)
	var m map[string]any
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"version", "bundle_id", "repo", "pr", "sha", "runner", "preview", "brief", "author", "notes", "criteria", "diff"} {
		if _, ok := m[k]; !ok {
			t.Errorf("missing %s", k)
		}
	}
	for _, k := range []string{"previous", "criteria_diff", "rubric"} {
		if _, ok := m[k]; ok {
			t.Errorf("dub.json must not carry %s", k)
		}
	}
}

func TestRepoAndPRFromEnv(t *testing.T) {
	t.Setenv("GITHUB_REPOSITORY", "o/r")
	t.Setenv("GITHUB_REF", "refs/pull/87/merge")
	r, n := RepoAndPRFromEnv()
	if r != "o/r" || n != 87 {
		t.Error(r, n)
	}
}

func TestGlob(t *testing.T) {
	cases := []struct {
		g, p string
		ok   bool
	}{
		{"lib/email/**", "lib/email/a/b.ex", true},
		{"lib/email/**", "lib/emailx/a.ex", false},
		{"lib/email/", "lib/email/a.ex", true},
		{"lib/email", "lib/email", true},
		{"**/*.ex", "lib/a.ex", true},
		{"**/*.ex", "lib/a.ts", false},
		{"lib/*/a.ex", "lib/x/a.ex", true},
		{"lib/*/a.ex", "lib/x/y/a.ex", false},
	}
	for _, c := range cases {
		if matchGlob(c.g, c.p) != c.ok {
			t.Errorf("%s vs %s: want %v", c.g, c.p, c.ok)
		}
	}
}

func TestTestTitles(t *testing.T) {
	got := testTitles("test('a', x)\n test.describe('d', () => { test(\"b\") })\n mytest('no')\n test(`c`)\n")
	if strings.Join(got, ",") != "a,b,c" {
		t.Error(got)
	}
}

func TestSpecsFor(t *testing.T) {
	repo := t.TempDir()
	for _, f := range []string{
		".dub/evidence/x.spec.ts", ".dub/evidence/x.more.spec.ts", ".dub/evidence/x/deep.spec.ts",
		".dub/evidence/xy.spec.ts", ".dub/evidence/y.spec.ts", ".dub/evidence/helpers.ts", ".dub/evidence/x.helpers.ts",
	} {
		write(t, repo, f, "")
	}
	got, err := SpecsFor(repo, "x")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{".dub/evidence/x.more.spec.ts", ".dub/evidence/x.spec.ts", ".dub/evidence/x/deep.spec.ts"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("got %v want %v", got, want)
	}
	none, err := SpecsFor(repo, "z")
	if err != nil || none == nil || len(none) != 0 {
		t.Errorf("z: %v %v", none, err)
	}
	empty, err := SpecsFor(t.TempDir(), "x")
	if err != nil || empty == nil || len(empty) != 0 {
		t.Errorf("no evidence dir: %v %v", empty, err)
	}
}
