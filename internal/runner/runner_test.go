package runner

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestMap(t *testing.T) {
	crit := []Criterion{{"a", "visual"}, {"b", "behaviour"}, {"c", "judgment"}, {"d", "check"}, {"e", "check"}, {"f", "check"}}
	res := &Results{Tests: []TestResult{
		{ID: "a", Status: "passed", Steps: []string{"goto /"}},
		{ID: "b", Status: "failed", Error: "expect failed"},
		{ID: "c", Status: "failed", Error: "expect failed"},
		{ID: "d", Status: "timedOut"},
		{ID: "e", Status: "failed", Error: "DubPreviewMoved: x"},
	}}
	m := Map(crit, res)
	want := map[string]string{"a": "pass", "b": "fail", "c": "error", "d": "error", "e": "error", "f": "none"}
	for id, s := range want {
		if m[id].Status != s {
			t.Errorf("%s: got %s want %s", id, m[id].Status, s)
		}
	}
	if !strings.Contains(m["c"].Error, "judgment") || m["d"].Error != "timedOut" {
		t.Errorf("errors: %+v", m)
	}
	res.PreviewMoved = true
	for id, o := range Map(crit, res) {
		if id != "f" && o.Status != "error" {
			t.Errorf("moved: %s %s", id, o.Status)
		}
	}
}

func TestRunWithStub(t *testing.T) {
	out := t.TempDir()
	var got []string
	r := &Runner{Exec: func(name string, args ...string) ([]byte, error) {
		got = append([]string{name}, args...)
		os.WriteFile(filepath.Join(out, "results.json"), []byte(`{"preview_moved":false,"tests":[{"id":"a","status":"passed","steps":[],"attachments":[]}]}`), 0o644)
		return nil, nil
	}}
	res, err := r.Run(Options{Repo: t.TempDir(), Out: out, PreviewURL: "http://p", SHA: "abc", Criteria: []Criterion{{"a", "visual"}}})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Tests) != 1 || res.Tests[0].ID != "a" {
		t.Errorf("%+v", res)
	}
	j := strings.Join(got, " ")
	for _, want := range []string{"docker run --rm", ":/work/.dub:ro", ":/out", "DUB_PREVIEW_URL=http://p", "DUB_SHA=abc", `DUB_CRITERIA=[{"id":"a","kind":"visual"}]`, DefaultImage} {
		if !strings.Contains(j, want) {
			t.Errorf("missing %q in %q", want, j)
		}
	}
}

func TestDigestFallback(t *testing.T) {
	r := &Runner{Exec: func(string, ...string) ([]byte, error) { return nil, os.ErrNotExist }}
	if d, ok := r.Digest("img:latest"); ok || d != "img:latest" {
		t.Error(d, ok)
	}
	r = &Runner{Exec: func(string, ...string) ([]byte, error) { return []byte("img@sha256:abc\n"), nil }}
	if d, ok := r.Digest("img:latest"); !ok || d != "img@sha256:abc" {
		t.Error(d, ok)
	}
}
