// Package brief parses and validates `.dub/briefs/<slug>.md`.
package brief

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// Kinds a criterion may declare.
var Kinds = []string{"visual", "behaviour", "check", "judgment"}

var idRe = regexp.MustCompile(`^[a-z][a-z0-9-]*$`)

// criterionRe matches `- [ac-1] text   {kind: visual}`.
var criterionRe = regexp.MustCompile(`^\s*[-*]\s+\[([^\]]+)\]\s+(.*?)\s*\{\s*kind\s*:\s*([a-z]+)\s*\}\s*$`)

// Criterion is one acceptance criterion.
type Criterion struct {
	ID   string `json:"id"`
	Kind string `json:"kind"`
	Text string `json:"text"`
}

// Notes is the agent's did / didn't / unsure lists from `## Notes`.
type Notes struct {
	Did    []string `json:"did"`
	Didnt  []string `json:"didnt"`
	Unsure []string `json:"unsure"`
}

// Brief is a parsed brief.
type Brief struct {
	Path     string
	ID       string
	Issue    string
	Title    string
	Why      string
	Text     string
	Criteria []Criterion
	Notes    Notes
}

// Parse parses the brief at path. The slug is the file name without `.md`.
func Parse(path string) (*Brief, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	b, err := ParseText(string(data))
	if err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	b.Path = path
	slug := strings.TrimSuffix(filepath.Base(path), ".md")
	if b.ID != slug {
		return nil, fmt.Errorf("%s: front matter id %q does not match file slug %q", path, b.ID, slug)
	}
	return b, nil
}

// ParseText parses brief text. It does not check the slug.
func ParseText(text string) (*Brief, error) {
	b := &Brief{Text: text}
	lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	i := 0
	if len(lines) > 0 && strings.TrimSpace(lines[0]) == "---" {
		i = 1
		for ; i < len(lines); i++ {
			if strings.TrimSpace(lines[i]) == "---" {
				i++
				break
			}
			k, v, ok := strings.Cut(lines[i], ":")
			if !ok {
				continue
			}
			v = strings.TrimSpace(stripComment(v))
			switch strings.TrimSpace(k) {
			case "id":
				b.ID = v
			case "issue":
				b.Issue = v
			}
		}
	}
	section := ""
	notesList := ""
	for ; i < len(lines); i++ {
		line := lines[i]
		t := strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(t, "# ") && b.Title == "":
			b.Title = strings.TrimSpace(t[2:])
			continue
		case strings.HasPrefix(t, "## "):
			section = strings.ToLower(strings.TrimSpace(t[3:]))
			notesList = ""
			continue
		}
		if strings.HasPrefix(t, "**Why:**") {
			b.Why = strings.TrimSpace(strings.TrimPrefix(t, "**Why:**"))
			continue
		}
		switch section {
		case "acceptance":
			if m := criterionRe.FindStringSubmatch(line); m != nil {
				b.Criteria = append(b.Criteria, Criterion{ID: m[1], Kind: m[3], Text: strings.TrimSpace(m[2])})
			} else if strings.HasPrefix(t, "- ") || strings.HasPrefix(t, "* ") {
				return nil, fmt.Errorf("acceptance line %d is not `- [id] text {kind: k}`: %q", i+1, t)
			}
		case "notes":
			lower := strings.ToLower(t)
			switch {
			case strings.HasPrefix(lower, "**did:**"):
				notesList = "did"
			case strings.HasPrefix(lower, "**didn't:**"), strings.HasPrefix(lower, "**didnt:**"), strings.HasPrefix(lower, "**didn’t:**"):
				notesList = "didnt"
			case strings.HasPrefix(lower, "**unsure:**"):
				notesList = "unsure"
			case strings.HasPrefix(t, "- ") || strings.HasPrefix(t, "* "):
				item := strings.TrimSpace(t[2:])
				switch notesList {
				case "did":
					b.Notes.Did = append(b.Notes.Did, item)
				case "didnt":
					b.Notes.Didnt = append(b.Notes.Didnt, item)
				case "unsure":
					b.Notes.Unsure = append(b.Notes.Unsure, item)
				}
			}
		}
	}
	if err := b.Validate(); err != nil {
		return nil, err
	}
	return b, nil
}

func stripComment(s string) string {
	if i := strings.Index(s, "#"); i >= 0 {
		return s[:i]
	}
	return s
}

// Validate checks the structural rules `dub pack` refuses on.
func (b *Brief) Validate() error {
	var errs []error
	if b.ID == "" {
		errs = append(errs, errors.New("missing front matter `id`"))
	}
	if b.Title == "" {
		errs = append(errs, errors.New("missing `# title`"))
	}
	if len(b.Criteria) == 0 {
		errs = append(errs, errors.New("no acceptance criteria under `## Acceptance`"))
	}
	seen := map[string]bool{}
	for _, c := range b.Criteria {
		if !idRe.MatchString(c.ID) {
			errs = append(errs, fmt.Errorf("criterion id %q must match ^[a-z][a-z0-9-]*$", c.ID))
		}
		if seen[c.ID] {
			errs = append(errs, fmt.Errorf("duplicate criterion id %q", c.ID))
		}
		seen[c.ID] = true
		if !validKind(c.Kind) {
			errs = append(errs, fmt.Errorf("criterion %s: unknown kind %q (want one of %s)", c.ID, c.Kind, strings.Join(Kinds, "|")))
		}
	}
	return errors.Join(errs...)
}

func validKind(k string) bool {
	for _, x := range Kinds {
		if x == k {
			return true
		}
	}
	return false
}

// Criterion returns the criterion with id, if any.
func (b *Brief) Criterion(id string) (Criterion, bool) {
	for _, c := range b.Criteria {
		if c.ID == id {
			return c, true
		}
	}
	return Criterion{}, false
}

// List returns every brief path under <repo>/.dub/briefs, sorted.
func List(repo string) ([]string, error) {
	paths, err := filepath.Glob(filepath.Join(repo, ".dub", "briefs", "*.md"))
	if err != nil {
		return nil, err
	}
	sort.Strings(paths)
	return paths, nil
}

// ChangedOnBranch returns the brief paths (relative to repo) that differ
// between the merge-base with base and HEAD.
func ChangedOnBranch(repo, base string) ([]string, error) {
	mb, err := git(repo, "merge-base", base, "HEAD")
	if err != nil {
		return nil, fmt.Errorf("merge-base with %s: %w", base, err)
	}
	out, err := git(repo, "diff", "--name-only", mb+"..HEAD", "--", ".dub/briefs")
	if err != nil {
		return nil, err
	}
	var paths []string
	sc := bufio.NewScanner(strings.NewReader(out))
	for sc.Scan() {
		p := strings.TrimSpace(sc.Text())
		if strings.HasSuffix(p, ".md") {
			paths = append(paths, p)
		}
	}
	return paths, nil
}

// Pick chooses the brief for `dub pack`: explicit path, else the one brief
// changed on the branch, else a clear refusal.
func Pick(repo, base, explicit string) (*Brief, error) {
	if explicit != "" {
		return Parse(explicit)
	}
	changed, err := ChangedOnBranch(repo, base)
	if err != nil {
		return nil, err
	}
	switch len(changed) {
	case 0:
		all, _ := List(repo)
		if len(all) == 1 {
			return Parse(all[0])
		}
		return nil, fmt.Errorf("no brief under .dub/briefs changed on this branch relative to %s; write one or pass --brief <path>", base)
	case 1:
		return Parse(filepath.Join(repo, changed[0]))
	default:
		return nil, fmt.Errorf("%d briefs changed on this branch (%s); pass --brief <path>", len(changed), strings.Join(changed, ", "))
	}
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
