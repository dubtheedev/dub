// Package bundle assembles dub.json (version 0) from the brief, the runner's
// results and git. It is self-contained: nothing here refers to Worker state.
package bundle

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/oklog/ulid/v2"
	"gopkg.in/yaml.v3"

	"github.com/dubtheedev/dub/internal/brief"
	"github.com/dubtheedev/dub/internal/inline"
	"github.com/dubtheedev/dub/internal/provenance"
	"github.com/dubtheedev/dub/internal/runner"
)

// Version of the dub.json format.
const Version = 0

type Preview struct {
	URL        string `json:"url"`
	PreviewSHA string `json:"preview_sha"`
	Moved      bool   `json:"moved"`
}

type BriefInfo struct {
	Path                 string            `json:"path"`
	Text                 string            `json:"text"`
	Criteria             []brief.Criterion `json:"criteria"`
	FirstSeenSHA         *string           `json:"first_seen_sha"`
	BeforeImplementation string            `json:"before_implementation"`
}

type Author struct {
	Kind    string `json:"kind"`
	Agent   string `json:"agent"`
	Session string `json:"session,omitempty"`
}

type Spec struct {
	Source          string        `json:"source"`
	Files           []inline.File `json:"files"`
	ExternalImports []string      `json:"external_imports"`
	Changed         bool          `json:"changed"`
}

type Evidence struct {
	Type string `json:"type"` // image|video|trace|file
	Path string `json:"path"` // relative to the bundle's evidence root
	Hash string `json:"hash"`
	Role string `json:"role,omitempty"` // "supporting" for judgment criteria
}

type Criterion struct {
	ID         string     `json:"id"`
	Kind       string     `json:"kind"`
	Status     string     `json:"status"`
	Error      string     `json:"error,omitempty"`
	Assertions []string   `json:"assertions"`
	Spec       *Spec      `json:"spec,omitempty"`
	Evidence   []Evidence `json:"evidence"`
}

type Diff struct {
	Files     int      `json:"files"`
	Additions int      `json:"additions"`
	Deletions int      `json:"deletions"`
	Areas     []string `json:"areas"`
}

// Bundle is dub.json.
type Bundle struct {
	Version  int         `json:"version"`
	BundleID string      `json:"bundle_id"`
	Repo     string      `json:"repo"`
	PR       int         `json:"pr"`
	SHA      string      `json:"sha"`
	Runner   string      `json:"runner"`
	Preview  Preview     `json:"preview"`
	Brief    BriefInfo   `json:"brief"`
	Author   Author      `json:"author"`
	Notes    brief.Notes `json:"notes"`
	Criteria []Criterion `json:"criteria"`
	Diff     Diff        `json:"diff"`
	PackedAt time.Time   `json:"packed_at"`
}

// Inputs to Assemble.
type Inputs struct {
	Repo      string // repo root
	Base      string // base branch, e.g. main
	RepoName  string // owner/name
	PR        int
	SHA       string
	Runner    string // image digest
	Preview   Preview
	Brief     *brief.Brief
	Specs     []string // the brief's spec files, repo-relative, from SpecsFor
	Outcomes  map[string]runner.Outcome
	RunnerOut string // the dir that was mounted at /out
	BundleOut string // where to write dub.json and evidence/
}

// NewID mints a ULID.
func NewID() string {
	return ulid.MustNew(ulid.Timestamp(time.Now()), rand.Reader).String()
}

// AuthorFromEnv reads DUB_AUTHOR_KIND / DUB_AUTHOR_AGENT / DUB_AUTHOR_SESSION.
func AuthorFromEnv() Author {
	a := Author{Kind: envOr("DUB_AUTHOR_KIND", "agent"), Agent: envOr("DUB_AUTHOR_AGENT", "claude-code"), Session: os.Getenv("DUB_AUTHOR_SESSION")}
	return a
}

func envOr(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

// RepoAndPRFromEnv reads GITHUB_REPOSITORY and GITHUB_REF (refs/pull/<n>/merge).
func RepoAndPRFromEnv() (string, int) {
	repo := os.Getenv("GITHUB_REPOSITORY")
	pr := 0
	ref := os.Getenv("GITHUB_REF")
	if strings.HasPrefix(ref, "refs/pull/") {
		n := strings.TrimPrefix(ref, "refs/pull/")
		n, _, _ = strings.Cut(n, "/")
		pr, _ = strconv.Atoi(n)
	}
	return repo, pr
}

// Assemble builds the bundle, copying evidence into <BundleOut>/evidence.
func Assemble(in Inputs) (*Bundle, error) {
	b := &Bundle{
		Version:  Version,
		BundleID: NewID(),
		Repo:     in.RepoName,
		PR:       in.PR,
		SHA:      in.SHA,
		Runner:   in.Runner,
		Preview:  in.Preview,
		Author:   AuthorFromEnv(),
		Notes:    in.Brief.Notes,
		PackedAt: time.Now().UTC(),
	}
	if b.Notes.Did == nil {
		b.Notes.Did = []string{}
	}
	if b.Notes.Didnt == nil {
		b.Notes.Didnt = []string{}
	}
	if b.Notes.Unsure == nil {
		b.Notes.Unsure = []string{}
	}

	relBrief, err := filepath.Rel(in.Repo, in.Brief.Path)
	if err != nil {
		relBrief = in.Brief.Path
	}
	relBrief = filepath.ToSlash(relBrief)
	prov, err := provenance.Compute(in.Repo, in.Base, relBrief)
	if err != nil {
		return nil, fmt.Errorf("provenance: %w", err)
	}
	b.Brief = BriefInfo{Path: relBrief, Text: in.Brief.Text, Criteria: in.Brief.Criteria, BeforeImplementation: prov.BeforeImplementation}
	if prov.FirstSeenSHA != "" {
		s := prov.FirstSeenSHA
		b.Brief.FirstSeenSHA = &s
	}

	changed, err := changedFiles(in.Repo, in.Base)
	if err != nil {
		return nil, err
	}
	b.Diff = diffSummary(changed, loadAreas(in.Repo))

	specs, err := specsByID(in.Repo, in.Specs)
	if err != nil {
		return nil, err
	}
	evRoot := filepath.Join(in.BundleOut, "evidence")
	if err := os.MkdirAll(evRoot, 0o755); err != nil {
		return nil, err
	}
	for _, c := range in.Brief.Criteria {
		o := in.Outcomes[c.ID]
		bc := Criterion{ID: c.ID, Kind: c.Kind, Status: o.Status, Error: o.Error, Assertions: o.Steps, Evidence: []Evidence{}}
		if bc.Status == "" {
			bc.Status = "none"
		}
		if bc.Assertions == nil {
			bc.Assertions = []string{}
		}
		if sp, ok := specs[c.ID]; ok {
			r, err := inline.Spec(in.Repo, sp)
			if err != nil {
				return nil, fmt.Errorf("inline %s: %w", sp, err)
			}
			s := &Spec{Source: r.Source, Files: r.Files, ExternalImports: r.ExternalImports}
			if s.ExternalImports == nil {
				s.ExternalImports = []string{}
			}
			for _, f := range r.Files {
				if changed[f.Path] != nil {
					s.Changed = true
				}
			}
			bc.Spec = s
		}
		for _, a := range o.Attachments {
			src := filepath.Join(in.RunnerOut, filepath.FromSlash(a.Path))
			rel := filepath.ToSlash(filepath.Join(c.ID, filepath.Base(a.Path)))
			dst := filepath.Join(evRoot, filepath.FromSlash(rel))
			hash, err := copyHash(src, dst)
			if err != nil {
				return nil, fmt.Errorf("evidence %s: %w", a.Path, err)
			}
			e := Evidence{Type: evidenceType(a.ContentType, a.Path), Path: rel, Hash: "sha256:" + hash}
			if c.Kind == "judgment" {
				e.Role = "supporting"
			}
			bc.Evidence = append(bc.Evidence, e)
		}
		b.Criteria = append(b.Criteria, bc)
	}
	return b, nil
}

// Write writes dub.json into dir.
func (b *Bundle) Write(dir string) (string, error) {
	data, err := json.MarshalIndent(b, "", "  ")
	if err != nil {
		return "", err
	}
	p := filepath.Join(dir, "dub.json")
	return p, os.WriteFile(p, append(data, '\n'), 0o644)
}

func evidenceType(ct, path string) string {
	switch {
	case strings.HasPrefix(ct, "image/"):
		return "image"
	case strings.HasPrefix(ct, "video/"), strings.HasSuffix(path, ".webm"):
		return "video"
	case strings.HasSuffix(path, ".zip") || strings.Contains(path, "trace"):
		return "trace"
	default:
		return "file"
	}
}

func copyHash(src, dst string) (string, error) {
	in, err := os.Open(src)
	if err != nil {
		return "", err
	}
	defer in.Close()
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return "", err
	}
	out, err := os.Create(dst)
	if err != nil {
		return "", err
	}
	defer out.Close()
	h := sha256.New()
	if _, err := io.Copy(io.MultiWriter(out, h), in); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// SpecsFor lists the spec files that belong to the brief `slug`:
// .dub/evidence/<slug>.spec.ts, .dub/evidence/<slug>.<anything>.spec.ts and
// every *.spec.ts under .dub/evidence/<slug>/. Other briefs' specs are left
// alone, which is what lets two briefs both call a criterion ac-1. Files that
// are not specs (helpers) are shared and never filtered. Paths come back
// repo-relative with forward slashes, sorted; never nil.
func SpecsFor(repo, slug string) ([]string, error) {
	root := filepath.Join(repo, ".dub", "evidence")
	out := []string{}
	if _, err := os.Stat(root); err != nil {
		if os.IsNotExist(err) {
			return out, nil
		}
		return nil, err
	}
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || !strings.HasSuffix(p, ".spec.ts") {
			return nil
		}
		rel, _ := filepath.Rel(root, p)
		rel = filepath.ToSlash(rel)
		if rel == slug+".spec.ts" || strings.HasPrefix(rel, slug+".") || strings.HasPrefix(rel, slug+"/") {
			r, _ := filepath.Rel(repo, p)
			out = append(out, filepath.ToSlash(r))
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Strings(out)
	return out, nil
}

// specsByID maps criterion id → spec path by scanning test('<id>' titles in
// the brief's own spec files (see SpecsFor).
func specsByID(repo string, specs []string) (map[string]string, error) {
	m := map[string]string{}
	for _, rel := range specs {
		p := filepath.Join(repo, filepath.FromSlash(rel))
		data, err := os.ReadFile(p)
		if err != nil {
			return nil, err
		}
		for _, id := range testTitles(string(data)) {
			if _, dup := m[id]; !dup {
				m[id] = p
			}
		}
	}
	return m, nil
}

// testTitles finds test('x' / test("x" / test(`x` at any nesting.
func testTitles(src string) []string {
	var out []string
	for _, marker := range []string{"test('", `test("`, "test(`"} {
		rest := src
		for {
			i := strings.Index(rest, marker)
			if i < 0 {
				break
			}
			if i > 0 {
				prev := rest[i-1]
				if prev == '.' || prev == '_' || (prev >= 'a' && prev <= 'z') || (prev >= 'A' && prev <= 'Z') {
					rest = rest[i+len(marker):]
					continue
				}
			}
			rest = rest[i+len(marker):]
			q := marker[len(marker)-1]
			j := strings.IndexByte(rest, q)
			if j < 0 {
				break
			}
			out = append(out, rest[:j])
			rest = rest[j:]
		}
	}
	return out
}

type numstat struct{ add, del int }

func changedFiles(repo, base string) (map[string]*numstat, error) {
	mb, err := git(repo, "merge-base", base, "HEAD")
	if err != nil {
		return nil, fmt.Errorf("merge-base with %s: %w", base, err)
	}
	out, err := git(repo, "diff", "--numstat", mb+"..HEAD")
	if err != nil {
		return nil, err
	}
	m := map[string]*numstat{}
	for _, line := range strings.Split(out, "\n") {
		f := strings.Fields(line)
		if len(f) < 3 {
			continue
		}
		a, _ := strconv.Atoi(f[0]) // "-" for binary → 0
		d, _ := strconv.Atoi(f[1])
		m[strings.Join(f[2:], " ")] = &numstat{a, d}
	}
	return m, nil
}

// Areas is .dub/areas.yml: area name → path globs.
type Areas map[string][]string

func loadAreas(repo string) Areas {
	data, err := os.ReadFile(filepath.Join(repo, ".dub", "areas.yml"))
	if err != nil {
		return nil
	}
	var a Areas
	if err := yaml.Unmarshal(data, &a); err != nil {
		return nil
	}
	return a
}

func diffSummary(changed map[string]*numstat, areas Areas) Diff {
	d := Diff{Areas: []string{}}
	hit := map[string]bool{}
	for path, n := range changed {
		d.Files++
		d.Additions += n.add
		d.Deletions += n.del
		for name, globs := range areas {
			for _, g := range globs {
				if matchGlob(g, path) {
					hit[name] = true
				}
			}
		}
	}
	for name := range hit {
		d.Areas = append(d.Areas, name)
	}
	sort.Strings(d.Areas)
	return d
}

// matchGlob supports `**` (any depth), `*` (within a segment) and a trailing
// `/` meaning "everything under". Enough for areas.yml.
func matchGlob(pattern, path string) bool {
	pattern = strings.TrimSuffix(pattern, "/")
	if !strings.ContainsAny(pattern, "*?[") {
		return path == pattern || strings.HasPrefix(path, pattern+"/")
	}
	return globMatch(strings.Split(pattern, "/"), strings.Split(path, "/"))
}

func globMatch(pat, segs []string) bool {
	for len(pat) > 0 {
		if pat[0] == "**" {
			if len(pat) == 1 {
				return true
			}
			for i := 0; i <= len(segs); i++ {
				if globMatch(pat[1:], segs[i:]) {
					return true
				}
			}
			return false
		}
		if len(segs) == 0 {
			return false
		}
		if ok, _ := filepath.Match(pat[0], segs[0]); !ok {
			return false
		}
		pat, segs = pat[1:], segs[1:]
	}
	return len(segs) == 0
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

// HeadSHA returns the repo's HEAD commit.
func HeadSHA(repo string) (string, error) {
	return git(repo, "rev-parse", "HEAD")
}
