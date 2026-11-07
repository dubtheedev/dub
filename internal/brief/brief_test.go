package brief

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

const sample = `---
id: invoice-reminders
issue: MIS-142            # optional
---
# Send a reminder when an invoice is 7 days overdue

**Why:** customers forget; we chase manually.

## Acceptance
- [ac-1] Overdue invoice (7d) shows "Reminder sent" badge in the invoice list   {kind: visual}
- [ac-2] Reminder email renders with invoice link and amount                     {kind: visual}
- [ac-3] No reminder sent twice for the same invoice                            {kind: behaviour}
- [ac-4] Copy tone matches existing emails                                       {kind: judgment}

## Notes
**Did:**
- Added the badge
**Didn't:**
- Timezone handling
**Unsure:**
- Timezone of the 7-day cutoff
`

func TestParseText(t *testing.T) {
	b, err := ParseText(sample)
	if err != nil {
		t.Fatal(err)
	}
	if b.ID != "invoice-reminders" || b.Issue != "MIS-142" {
		t.Errorf("front matter: %+v", b)
	}
	if b.Title != "Send a reminder when an invoice is 7 days overdue" {
		t.Errorf("title %q", b.Title)
	}
	if b.Why != "customers forget; we chase manually." {
		t.Errorf("why %q", b.Why)
	}
	if len(b.Criteria) != 4 {
		t.Fatalf("criteria %d", len(b.Criteria))
	}
	if b.Criteria[0] != (Criterion{"ac-1", "visual", `Overdue invoice (7d) shows "Reminder sent" badge in the invoice list`}) {
		t.Errorf("c1 %+v", b.Criteria[0])
	}
	if b.Criteria[3].Kind != "judgment" {
		t.Errorf("c4 %+v", b.Criteria[3])
	}
	if len(b.Notes.Did) != 1 || len(b.Notes.Didnt) != 1 || b.Notes.Unsure[0] != "Timezone of the 7-day cutoff" {
		t.Errorf("notes %+v", b.Notes)
	}
}

func TestValidation(t *testing.T) {
	cases := map[string]string{
		"no criteria": "---\nid: x\n---\n# T\n",
		"bad id":      "---\nid: x\n---\n# T\n## Acceptance\n- [AC1] t {kind: visual}\n",
		"dup id":      "---\nid: x\n---\n# T\n## Acceptance\n- [a] t {kind: visual}\n- [a] u {kind: visual}\n",
		"bad kind":    "---\nid: x\n---\n# T\n## Acceptance\n- [a] t {kind: vibes}\n",
		"malformed":   "---\nid: x\n---\n# T\n## Acceptance\n- a thing without an id\n",
		"no id":       "# T\n## Acceptance\n- [a] t {kind: visual}\n",
	}
	for name, text := range cases {
		if _, err := ParseText(text); err == nil {
			t.Errorf("%s: expected error", name)
		}
	}
}

func TestParseSlugMismatch(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "other.md")
	os.WriteFile(p, []byte(sample), 0o644)
	if _, err := Parse(p); err == nil || !strings.Contains(err.Error(), "slug") {
		t.Errorf("want slug error, got %v", err)
	}
}

func run(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

func TestPick(t *testing.T) {
	repo := t.TempDir()
	run(t, repo, "init", "-q", "-b", "main")
	os.WriteFile(filepath.Join(repo, "README"), []byte("x"), 0o644)
	run(t, repo, "add", ".")
	run(t, repo, "commit", "-qm", "init")
	run(t, repo, "checkout", "-qb", "feature")
	if _, err := Pick(repo, "main", ""); err == nil {
		t.Error("expected refusal with no brief")
	}
	os.MkdirAll(filepath.Join(repo, ".dub/briefs"), 0o755)
	os.WriteFile(filepath.Join(repo, ".dub/briefs/invoice-reminders.md"), []byte(sample), 0o644)
	run(t, repo, "add", ".")
	run(t, repo, "commit", "-qm", "brief")
	b, err := Pick(repo, "main", "")
	if err != nil {
		t.Fatal(err)
	}
	if b.ID != "invoice-reminders" {
		t.Errorf("picked %s", b.ID)
	}
	os.WriteFile(filepath.Join(repo, ".dub/briefs/second.md"), []byte(strings.Replace(sample, "id: invoice-reminders", "id: second", 1)), 0o644)
	run(t, repo, "add", ".")
	run(t, repo, "commit", "-qm", "second")
	if _, err := Pick(repo, "main", ""); err == nil || !strings.Contains(err.Error(), "2 briefs") {
		t.Errorf("want two-briefs refusal, got %v", err)
	}
	if b, err := Pick(repo, "main", filepath.Join(repo, ".dub/briefs/second.md")); err != nil || b.ID != "second" {
		t.Errorf("explicit: %v %v", b, err)
	}
}
